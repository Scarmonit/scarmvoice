// Realtime bridge to the board's Durable Object (/api/rt/<room>).
//
// Same reason as net.js: the upgrade request is cookie-gated by the Pages
// middleware, and a renderer WebSocket from file:// would not carry the cookie.
// So the socket lives here, with the credential set explicitly, and messages are
// relayed to the renderer over IPC.
//
// LIVENESS (the important part): a WebSocket can go "half-open" — the TCP peer
// vanishes (laptop sleep, NAT/conntrack entry dropped after a long idle in the
// tray) but the OS never delivers a FIN, so `readyState` stays OPEN forever.
// Sends still succeed, `'close'` never fires, and no incoming events arrive:
// the exact "messages stop appearing after being minimized 40 min" bug. The old
// heartbeat sent an app-level ping but never checked for a reply, so it could
// not detect this. We now run the documented ws ping/pong liveness pattern:
// each interval, if the previous ping got no pong (or any traffic), the socket
// is declared dead and force-terminated, which triggers reconnect with backoff.
const WebSocket = require('ws');
const net = require('./net');
const store = require('./store');

const PING_MS = 20000;          // ping cadence; also keeps the DO's NAT path warm
const BACKOFF_START = 1000;
const BACKOFF_MAX = 15000;
const OFFLINE_AFTER = 4;        // failed reconnects before we report "disconnected"

let ws = null;
let connected = false;
let manualClose = false;
let backoff = BACKOFF_START;
let reconnectTimer = null;
let pingTimer = null;
let isAlive = true;             // set true by any inbound frame or pong
let attempts = 0;              // consecutive failed connects (for the status label)
let emit = () => {};            // set by start()
// Did the live socket present an account token when it opened? See start().
let openedWithAccount = false;

// Outstanding wake() probes. They used to share `isAlive`, so two window-focus
// events three seconds apart meant the first probe's timer read the second
// probe's "no answer yet" and terminated a socket that was perfectly healthy.
// Each probe now carries its own token, and any inbound traffic satisfies every
// token in flight at once.
const probes = new Set();

function markAlive() {
    isAlive = true;
    if (!probes.size) return;
    for (const p of probes) p.alive = true;
    probes.clear();
}

// state: 'connected' | 'reconnecting' | 'disconnected'
function emitStatus(state) {
    emit('status', { connected: state === 'connected', state });
}

function setConnected(v) {
    if (connected === v) return;
    connected = v;
    emitStatus(v ? 'connected' : (attempts >= OFFLINE_AFTER ? 'disconnected' : 'reconnecting'));
}

function wsUrl() {
    const s = store.get();
    const base = net.baseUrl().replace(/^http/, 'ws');
    const cid = encodeURIComponent(s.clientId);
    const name = encodeURIComponent(s.displayName || 'Anonymous');
    return `${base}/api/rt/${encodeURIComponent(s.room || 'lounge')}?cid=${cid}&name=${name}`;
}

function stopHeartbeat() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
}

function startHeartbeat(sock) {
    stopHeartbeat();
    isAlive = true;
    pingTimer = setInterval(() => {
        // Only the live socket gets probed: a heartbeat left over from a socket
        // that has since been replaced would be pinging (and eventually
        // terminating) the wrong connection.
        if (!ws || (sock && sock !== ws)) { stopHeartbeat(); return; }
        // No pong (and no other traffic) since the last tick → the peer is gone.
        // terminate() destroys the socket immediately; close() could hang waiting
        // on a handshake the dead peer will never complete.
        if (isAlive === false) {
            console.warn('[rt] no pong within ' + PING_MS + 'ms — socket is dead, terminating');
            try { ws.terminate(); } catch (e) {}
            return;   // 'close' will fire and drive reconnect
        }
        isAlive = false;
        // The protocol-level ping alone is enough: markAlive() fires on 'pong'
        // and on any inbound frame, so liveness is already covered. The extra
        // app-level {t:'ping'} that used to go with it added a JSON frame AND a
        // Durable Object invocation every 20s per client — ~4,300 a day each —
        // to learn nothing the pong doesn't already tell us.
        try { ws.ping(); } catch (e) {}
    }, PING_MS);
}

function scheduleReconnect() {
    if (manualClose || reconnectTimer) return;
    if (connected) return;
    emitStatus(attempts >= OFFLINE_AFTER ? 'disconnected' : 'reconnecting');
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, backoff);
    backoff = Math.min(Math.round(backoff * 1.7), BACKOFF_MAX);
}

function connect() {
    if (manualClose || ws) return;
    // No credential yet — start() is called again after login. Say so rather
    // than returning silently: a 401 can call clearCredentials() while the
    // socket is up, and the resulting close -> scheduleReconnect -> connect()
    // would land here with reconnectTimer already nulled, so nothing retries
    // and the titlebar sits on "Reconnecting…" forever.
    if (!net.hasSession()) { emitStatus('disconnected'); return; }

    attempts++;
    emitStatus(attempts >= OFFLINE_AFTER ? 'disconnected' : 'reconnecting');

    // Every handler below closes over THIS socket, not the module-level `ws`,
    // and refuses to act unless it is still the current one. stop()+start()
    // (what rebindRealtime does) can leave a socket whose handshake is still
    // running — handshakeTimeout is 15s, so the window is long — and its late
    // 'close' would otherwise null out the socket that replaced it, or its
    // 'error' terminate whichever connection happened to be live.
    let sock;
    try {
        // handshakeTimeout matters: without it, a peer that accepts the TCP
        // connection but never answers the HTTP upgrade leaves the socket in
        // CONNECTING forever — no 'open', no 'error', no 'close' — and every
        // reconnect attempt no-ops on the `ws` guard above. With it, ws aborts
        // the handshake, emits 'error' + 'close', and reconnect proceeds.
        sock = new WebSocket(wsUrl(), { headers: net.socketHeaders(), handshakeTimeout: 15000 });
        ws = sock;
        // Recorded at the moment the headers are built, because that is the only
        // point at which this socket's identity is decided. See start().
        openedWithAccount = net.hasAccount();
    } catch (e) {
        ws = null;
        scheduleReconnect();
        return;
    }

    sock.on('open', () => {
        if (sock !== ws) return;
        console.info('[rt] connected');
        backoff = BACKOFF_START;
        attempts = 0;
        setConnected(true);
        const s = store.get();
        send({ t: 'hello', cid: s.clientId, name: s.displayName || 'Anonymous' });
        startHeartbeat(sock);
    });

    // Any inbound frame proves the socket is alive.
    sock.on('message', (raw) => {
        if (sock !== ws) return;
        markAlive();
        let m;
        try { m = JSON.parse(raw.toString()); } catch (e) { return; }
        if (!m || !m.t) return;
        emit('message', m);
    });

    sock.on('pong', () => { if (sock === ws) markAlive(); });

    sock.on('close', () => {
        if (sock !== ws) return;
        console.info('[rt] closed (attempt ' + attempts + ')');
        ws = null;
        stopHeartbeat();
        setConnected(false);
        scheduleReconnect();
    });

    // 'error' always precedes 'close'; swallow it so it can't crash the process.
    // It kills its OWN socket — `ws` may by now be a different, healthy one.
    sock.on('error', () => { try { sock.terminate(); } catch (e) {} });
}

function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
    }
    return false;
}

function start(emitter) {
    if (emitter) emit = emitter;
    manualClose = false;
    backoff = BACKOFF_START;
    if (!ws) { connect(); return; }
    // A socket that opened WITHOUT the account token has no identity, and this
    // is the one call that can notice.
    //
    // socketHeaders() sends `x-account-token` because the server resolves who a
    // socket belongs to from a real credential — there is no other way for a
    // native client to say. connect() only ever gated on net.hasSession(), i.e.
    // the shared BOARD cookie, so any path that connects while the account step
    // is still on screen opens an anonymous socket: the window's own
    // 'show'/'focus' handler calls wake() -> connect(), and it fires before the
    // renderer has signed in. That happens on any launch that still holds the
    // board cookie but no account token — after Settings -> Sign out, after the
    // 90-day token expiry, after an admin resets a password, or simply when
    // somebody alt-tabs to their password manager during the account step.
    //
    // enterApp() then calls start(), which used to no-op on the `ws` guard
    // above, so the identity-less socket stayed for the whole session. Every
    // server-side unicast is addressed by ACCOUNT — DM delivery, DM thread
    // events, and an admin's "end this person's call" all go through
    // realtime/index.js's uid routing — so all three silently went nowhere, and
    // voice takeover could no longer evict this device from a call. DMs only
    // appeared on the 12s poll, with no chime and no notification.
    //
    // Replacing it here rather than at the call sites keeps the invariant where
    // it belongs: whoever connects, a socket that could not identify itself is
    // reopened as soon as the credential it was missing exists.
    if (!openedWithAccount && net.hasAccount()) {
        console.info('[rt] reopening — the socket was opened before the account existed');
        stop();
        manualClose = false;
        connect();
        return;
    }
    // A socket can already exist because the window's own 'show' handler calls
    // wake() — which connects — before the renderer has ever asked for one, and
    // at that point `emit` is still the module's no-op. That socket fires
    // setConnected(true) exactly once and every later call short-circuits on
    // equality, so whoever subscribes afterwards hears nothing at all: the app
    // keeps polling at the ACTIVE cadence and the titlebar dot never lights,
    // over a connection that is perfectly healthy. Usually the renderer wins
    // that race by a wide margin; it loses it reliably when the board cookie
    // outlives the account token, because then the account step is on screen
    // for as long as it takes somebody to type a password. Replaying the
    // current state to a new subscriber costs one event and removes the race.
    emitStatus(connected ? 'connected'
        : (attempts >= OFFLINE_AFTER ? 'disconnected' : 'reconnecting'));
}

function stop() {
    manualClose = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    stopHeartbeat();
    probes.clear();
    const sock = ws;
    ws = null;
    if (sock) {
        // Listeners go first: this socket is being killed deliberately, so its
        // 'close'/'error' must not run at all — not against it, and certainly
        // not against whatever start() puts in its place a moment later.
        try { sock.removeAllListeners(); } catch (e) {}
        // …but 'error' needs a floor under it. terminate() on a socket still in
        // CONNECTING does not destroy anything: ws aborts the handshake and
        // emits 'error' on the NEXT TICK, and an 'error' with no listener is
        // the one EventEmitter event that THROWS. With every handler just
        // removed, that lands as an uncaught exception in the main process —
        // i.e. rebindRealtime() (stop() + start()) firing while a connect is
        // mid-handshake could take the whole app down. The handshake window is
        // 15s, so it is not a narrow one.
        try { sock.on('error', () => {}); } catch (e) {}
        try { sock.terminate(); } catch (e) {}
    }
    attempts = 0;
    setConnected(false);
    emitStatus('disconnected');
}

// Gentle nudge: reconnect only if we already know we're down.
function reconnectNow() {
    if (manualClose || reconnectTimer) return;
    if (connected) return;
    backoff = BACKOFF_START;
    attempts = 0;
    connect();
}

// Strong nudge used when the window is restored / the machine wakes. The socket
// may LOOK connected but actually be a zombie, so we don't trust `connected`:
// force a ping and, if no reply lands quickly, tear it down and reconnect. If
// there's no socket at all, just connect.
function wake() {
    if (manualClose) return;
    console.info('[rt] wake (connected=' + connected + ')');
    const sock = ws;
    if (!sock || sock.readyState !== WebSocket.OPEN) {
        backoff = BACKOFF_START;
        attempts = 0;
        if (!sock) {
            connect();
        } else {
            // A socket stuck in CONNECTING/CLOSING blocks connect() via the
            // `ws` guard, so scheduling a reconnect around it would spin
            // forever. Kill it; 'close' fires and drives the reconnect.
            try { sock.terminate(); } catch (e) {}
            scheduleReconnect();
        }
        return;
    }
    // Verify the "open" socket is genuinely alive. The probe's verdict lives in
    // its own token so a second wake() cannot invalidate this one's answer.
    const probe = { alive: false };
    probes.add(probe);
    try { sock.ping(); } catch (e) {}
    send({ t: 'ping' });
    setTimeout(() => {
        probes.delete(probe);
        if (probe.alive) return;
        if (sock !== ws) return;                   // already replaced — not ours to kill
        try { sock.terminate(); } catch (e) {}     // zombie → 'close' → reconnect
    }, 3000);
}

module.exports = {
    start, stop, send, reconnectNow, wake,
    isConnected: () => connected,
    // Convenience wrappers matching the website's boardRT surface.
    notifyPosted: (channel, mentions, kind) => send({
        t: 'posted', channel: channel || 'general',
        // Names this message @-mentions, so a reader with the channel on
        // mentions-only can tell an @you from ordinary chatter without the
        // body ever going over the wire. Omitted when there are none.
        mentions: Array.isArray(mentions) && mentions.length ? mentions.slice(0, 16) : undefined,
        // 'refresh' when this nudge is only asking peers to refetch (an edit, a
        // delete, a reaction, a pin). Without it a peer reading another channel
        // treated every one of those as a new message: an unread badge, and a
        // desktop notification saying "New message" for a message nobody wrote.
        kind: kind === 'refresh' ? 'refresh' : undefined
    }),
    sendTyping: (channel, stop_) => send({
        t: 'typing', channel: channel || 'general',
        name: store.get().displayName || 'Anonymous', stop: !!stop_
    }),
    // greet/farewell ride the voice state so every peer's client can SPEAK who
    // arrived — the announcement text has to reach the people who hear it, and
    // the roster is the one channel that already fans out to exactly them.
    // Read from the store here rather than passed over IPC: the renderer saves
    // the setting and this picks it up on the next send, so the two can never
    // disagree. Sanitized to match what the settings field enforces — letters
    // and spaces, 20 characters — because this is the last hop we control.
    sendVoice: (inVoice, muted, deafened) => {
        const clean = (v) => String(v || '')
            .replace(/[^A-Za-z ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
        return send({
            t: 'voice', inVoice: !!inVoice, muted: !!muted, deafened: !!deafened,
            name: store.get().displayName || 'Anonymous',
            greet: clean(store.get().greetText),
            farewell: clean(store.get().farewellText),
            // The VOICE the announcement about me should be spoken in — my
            // choice, carried to the people who will actually hear it. An
            // announcement about a person plays in that person's voice, so the
            // speaker travels with the texts rather than being whatever the
            // listener picked for themselves.
            speaker: String(store.get().announceSpeaker || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 20),
            vgender: store.get().announceVoice === 'male' ? 'male' : 'female'
        });
    },
    sendPresence: (status) => send({
        t: 'presence', name: store.get().displayName || 'Anonymous', status: status || 'online'
    })
};
