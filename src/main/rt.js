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

function startHeartbeat() {
    stopHeartbeat();
    isAlive = true;
    pingTimer = setInterval(() => {
        if (!ws) { stopHeartbeat(); return; }
        // No pong (and no other traffic) since the last tick → the peer is gone.
        // terminate() destroys the socket immediately; close() could hang waiting
        // on a handshake the dead peer will never complete.
        if (isAlive === false) {
            console.warn('[rt] no pong within ' + PING_MS + 'ms — socket is dead, terminating');
            try { ws.terminate(); } catch (e) {}
            return;   // 'close' will fire and drive reconnect
        }
        isAlive = false;
        try { ws.ping(); } catch (e) {}     // protocol-level ping
        send({ t: 'ping' });                 // app-level ping (DO replies + keeps warm)
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
    if (!net.hasSession()) return;   // no credential yet — start() is called again after login

    attempts++;
    emitStatus(attempts >= OFFLINE_AFTER ? 'disconnected' : 'reconnecting');

    try {
        // handshakeTimeout matters: without it, a peer that accepts the TCP
        // connection but never answers the HTTP upgrade leaves the socket in
        // CONNECTING forever — no 'open', no 'error', no 'close' — and every
        // reconnect attempt no-ops on the `ws` guard above. With it, ws aborts
        // the handshake, emits 'error' + 'close', and reconnect proceeds.
        ws = new WebSocket(wsUrl(), { headers: net.cookieHeader(), handshakeTimeout: 15000 });
    } catch (e) {
        ws = null;
        scheduleReconnect();
        return;
    }

    ws.on('open', () => {
        console.info('[rt] connected');
        backoff = BACKOFF_START;
        attempts = 0;
        setConnected(true);
        const s = store.get();
        send({ t: 'hello', cid: s.clientId, name: s.displayName || 'Anonymous' });
        startHeartbeat();
    });

    // Any inbound frame proves the socket is alive.
    ws.on('message', (raw) => {
        isAlive = true;
        let m;
        try { m = JSON.parse(raw.toString()); } catch (e) { return; }
        if (!m || !m.t) return;
        emit('message', m);
    });

    ws.on('pong', () => { isAlive = true; });

    ws.on('close', () => {
        console.info('[rt] closed (attempt ' + attempts + ')');
        ws = null;
        stopHeartbeat();
        setConnected(false);
        scheduleReconnect();
    });

    // 'error' always precedes 'close'; swallow it so it can't crash the process.
    ws.on('error', () => { try { ws && ws.terminate(); } catch (e) {} });
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
    if (!ws) connect();
}

function stop() {
    manualClose = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    stopHeartbeat();
    try { if (ws) ws.terminate(); } catch (e) {}
    ws = null;
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
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        backoff = BACKOFF_START;
        attempts = 0;
        if (!ws) {
            connect();
        } else {
            // A socket stuck in CONNECTING/CLOSING blocks connect() via the
            // `ws` guard, so scheduling a reconnect around it would spin
            // forever. Kill it; 'close' fires and drives the reconnect.
            try { ws.terminate(); } catch (e) {}
            scheduleReconnect();
        }
        return;
    }
    // Verify the "open" socket is genuinely alive.
    isAlive = false;
    try { ws.ping(); } catch (e) {}
    send({ t: 'ping' });
    setTimeout(() => {
        if (!ws) return;
        if (isAlive === false) {
            try { ws.terminate(); } catch (e) {}   // zombie → 'close' → reconnect
        }
    }, 3000);
}

module.exports = {
    start, stop, send, reconnectNow, wake,
    isConnected: () => connected,
    // Convenience wrappers matching the website's boardRT surface.
    notifyPosted: (channel) => send({ t: 'posted', channel: channel || 'general' }),
    sendTyping: (channel, stop_) => send({
        t: 'typing', channel: channel || 'general',
        name: store.get().displayName || 'Anonymous', stop: !!stop_
    }),
    sendVoice: (inVoice, muted) => send({
        t: 'voice', inVoice: !!inVoice, muted: !!muted,
        name: store.get().displayName || 'Anonymous'
    }),
    sendPresence: (status) => send({
        t: 'presence', name: store.get().displayName || 'Anonymous', status: status || 'online'
    })
};
