// rt.js — the realtime bridge to the board's Durable Object.
//
// The bug this file exists to prevent: after a long idle in the tray (or a
// laptop sleep), the TCP peer disappears without ever sending a FIN. The socket
// stays readyState OPEN, send() keeps succeeding, 'close' never fires — and no
// messages arrive. "The board stopped updating" with nothing in the logs.
//
// The socket is stubbed (see test/stubs/ws.cjs) because that state cannot be
// produced by a real server: the ws protocol layer answers pings automatically.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { electronState as env } from './helpers/electron-state.js';
import { loadMain, resetMainModules } from './helpers/load.js';

const PING_MS = 20000;      // rt.js heartbeat cadence
const wsState = (globalThis.__WS_STUB__ ||= { instances: [] });

let root;
let rt;
let events;

const sockets = () => wsState.instances;
const socket = (i = -1) => sockets().at(i);
const statuses = () => events.filter((e) => e.type === 'status').map((e) => e.payload.state);

function boot({ session = 'SESSION123', settings = {} } = {}) {
    resetMainModules();

    const store = loadMain('store.js');
    store.init();
    store.set({
        // Only allow-listed origins are settable — baseUrl decides which host
        // receives the session cookie the socket carries.
        baseUrl: 'https://scarmonit.com',
        room: 'lounge',
        displayName: 'Scarm',
        clientId: 'c123',
        ...settings
    });
    if (session) store.writeSession(session);

    const net = loadMain('net.js');
    net.init();

    rt = loadMain('rt.js');
    events = [];
    rt.start((type, payload) => events.push({ type, payload }));
    return { store, net };
}

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'scarmvoice-rt-'));
    env.userDataDir = path.join(root, 'Roaming', 'ScarmVoice');
    env.encryptionAvailable = true;
    wsState.instances = [];
    vi.useFakeTimers();
});

afterEach(() => {
    try { if (rt) rt.stop(); } catch (e) { /* already down */ }
    vi.clearAllTimers();
    vi.useRealTimers();
    rt = undefined;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* best effort */ }
});

describe('connecting', () => {
    it('opens the room socket with the session cookie attached', () => {
        boot();

        expect(sockets().length).toBe(1);
        // A renderer socket from file:// could never carry this cookie — that's
        // the whole reason the socket lives in the main process.
        expect(socket().options.headers.Cookie).toBe('sb_auth=SESSION123');
        expect(socket().url).toBe('wss://scarmonit.com/api/rt/lounge?cid=c123&name=Scarm');
    });

    it('maps http to ws and encodes room, name and client id', () => {
        boot({
            settings: {
                baseUrl: 'http://localhost:8788',
                room: 'the lounge',
                displayName: 'Scarm & Co',
                clientId: 'c/1'
            }
        });

        expect(socket().url).toBe(
            'ws://localhost:8788/api/rt/the%20lounge?cid=c%2F1&name=Scarm%20%26%20Co'
        );
    });

    it('does not connect without a session', () => {
        boot({ session: null });
        expect(sockets().length).toBe(0);
    });

    it('announces itself and reports connected once open', () => {
        boot();
        socket().acceptConnection();

        expect(socket().lastSent()).toEqual({ t: 'hello', cid: 'c123', name: 'Scarm' });
        expect(statuses().at(-1)).toBe('connected');
        expect(rt.isConnected()).toBe(true);
    });
});

describe('liveness', () => {
    it('terminates a socket that stops answering pings', () => {
        boot();
        socket().acceptConnection();

        // First tick: probe. The protocol-level ping is the whole probe — the
        // app-level {t:'ping'} frame that used to accompany it was redundant
        // (markAlive fires on 'pong' and on any inbound frame) and cost a
        // Durable Object invocation every 20s per client.
        vi.advanceTimersByTime(PING_MS);
        expect(socket().pings).toBe(1);
        expect(socket().lastSent()).not.toEqual({ t: 'ping' });
        expect(socket().terminated).toBe(false);

        // Second tick with no reply: the peer is gone.
        vi.advanceTimersByTime(PING_MS);
        expect(socket().terminated).toBe(true);
    });

    it('uses terminate(), never close(), on a dead peer', () => {
        // close() waits for a closing handshake the dead peer will never send,
        // so the socket would hang open forever and never reconnect.
        boot();
        socket().acceptConnection();
        vi.advanceTimersByTime(PING_MS * 2);

        expect(socket().terminated).toBe(true);
        expect(socket().closedGracefully).toBe(false);
    });

    it('keeps a socket that pongs', () => {
        boot();
        socket().acceptConnection();

        vi.advanceTimersByTime(PING_MS);
        socket().replyPong();
        vi.advanceTimersByTime(PING_MS);

        expect(socket().terminated).toBe(false);
        expect(socket().pings).toBe(2);
    });

    it('treats any inbound frame as proof of life', () => {
        boot();
        socket().acceptConnection();

        vi.advanceTimersByTime(PING_MS);
        socket().deliver({ t: 'posted', channel: 'general' });
        vi.advanceTimersByTime(PING_MS);

        expect(socket().terminated).toBe(false);
    });

    it('stops the heartbeat once the socket is gone', () => {
        boot();
        socket().acceptConnection();
        const dead = socket();
        dead.terminate();

        const pingsAtDeath = dead.pings;
        vi.advanceTimersByTime(PING_MS * 3);

        expect(dead.pings).toBe(pingsAtDeath);
    });
});

describe('reconnecting', () => {
    it('reconnects after a backoff and grows it each failure', () => {
        boot();
        socket().acceptConnection();     // resets backoff to 1s
        socket().terminate();

        vi.advanceTimersByTime(999);
        expect(sockets().length).toBe(1);
        vi.advanceTimersByTime(1);
        expect(sockets().length).toBe(2);

        // Second failure waits 1.7x as long.
        socket().terminate();
        vi.advanceTimersByTime(1699);
        expect(sockets().length).toBe(2);
        vi.advanceTimersByTime(1);
        expect(sockets().length).toBe(3);
    });

    it('clamps the backoff at 15s', () => {
        boot();
        for (let i = 0; i < 10; i += 1) {
            socket().terminate();
            vi.advanceTimersByTime(20000);
        }

        const before = sockets().length;
        socket().terminate();
        vi.advanceTimersByTime(14999);
        expect(sockets().length).toBe(before);
        vi.advanceTimersByTime(1);
        expect(sockets().length).toBe(before + 1);
    });

    it('resets the backoff after a successful connect', () => {
        boot();
        socket().terminate();
        vi.advanceTimersByTime(20000);   // reconnect #2, backoff now 1.7s
        socket().terminate();
        vi.advanceTimersByTime(20000);   // reconnect #3

        socket().acceptConnection();     // success — back to 1s
        socket().terminate();

        const before = sockets().length;
        vi.advanceTimersByTime(1000);
        expect(sockets().length).toBe(before + 1);
    });

    it('reports reconnecting first and disconnected only after repeated failures', () => {
        boot();
        expect(statuses().at(-1)).toBe('reconnecting');

        for (let i = 0; i < 5; i += 1) {
            socket().terminate();
            vi.advanceTimersByTime(20000);
        }

        expect(statuses().at(-1)).toBe('disconnected');
    });
});

describe('wake', () => {
    it('tears down a zombie that still claims to be OPEN', () => {
        // The window was restored or the machine woke. The socket looks fine —
        // that's exactly the failure mode, so `connected` must not be trusted.
        boot();
        socket().acceptConnection();
        expect(rt.isConnected()).toBe(true);

        rt.wake();
        expect(socket().pings).toBe(1);

        vi.advanceTimersByTime(3000);
        expect(socket().terminated).toBe(true);
    });

    it('leaves a genuinely healthy socket alone', () => {
        boot();
        socket().acceptConnection();

        rt.wake();
        socket().replyPong();
        vi.advanceTimersByTime(3000);

        expect(socket().terminated).toBe(false);
    });

    it('does not let an earlier probe kill a socket a later one proved healthy', () => {
        // Two focus events inside the 3s probe window shared one liveness flag,
        // so the first probe's timer read the second's "no answer yet" and
        // terminated a socket that had just ponged.
        boot();
        socket().acceptConnection();

        rt.wake();
        vi.advanceTimersByTime(1000);
        rt.wake();
        socket().replyPong();
        vi.advanceTimersByTime(3000);

        expect(socket().terminated).toBe(false);
    });

    it('connects instead of probing when there is no socket', () => {
        boot();
        socket().acceptConnection();
        rt.stop();
        wsState.instances = [];

        rt.start((type, payload) => events.push({ type, payload }));
        expect(sockets().length).toBe(1);
    });
});

describe('stale sockets', () => {
    it('ignores a late close from a socket that has already been replaced', () => {
        // A socket whose handshake is still running lingers for up to 15s
        // (handshakeTimeout), so it can outlive the connection that replaced
        // it. Its eventual 'close' used to null out the live socket and report
        // the app as disconnected while it was in fact connected.
        boot();
        const first = socket();
        first.terminate();               // 'close' → reconnect
        vi.advanceTimersByTime(1000);

        const second = socket();
        expect(second).not.toBe(first);
        second.acceptConnection();
        expect(rt.isConnected()).toBe(true);

        first._fire('close');            // the stale socket, arriving late

        expect(rt.isConnected()).toBe(true);
        expect(second.terminated).toBe(false);
    });

    it('an error on a stale socket kills only itself', () => {
        boot();
        const first = socket();
        first.terminate();
        vi.advanceTimersByTime(1000);

        const second = socket();
        second.acceptConnection();

        first._fire('error', new Error('handshake timed out'));

        expect(second.terminated).toBe(false);
        expect(rt.isConnected()).toBe(true);
    });
});

// The window's own 'show' handler calls rt.wake(), which connects — and that
// happens before the renderer has finished booting and asked for a socket, so
// the one setConnected(true) fires while `emit` is still rt.js's no-op default.
// setConnected short-circuits on equality afterwards, so the subscriber that
// arrives second used to hear nothing at all: the app polled at the ACTIVE
// cadence for the rest of the session over a healthy connection, and the
// titlebar dot never lit. Reliably reachable whenever the board cookie outlives
// the account token, because the account step then sits on screen for as long as
// it takes somebody to type a password.
describe('a subscriber that arrives after the socket', () => {
    it('is told the current state instead of nothing', () => {
        boot();
        socket().acceptConnection();
        expect(statuses().at(-1)).toBe('connected');

        // A second start(), as enterApp() makes — the socket already exists, so
        // connect() is a no-op and this is the only chance to say anything.
        const late = [];
        rt.start((type, payload) => late.push({ type, payload }));

        expect(late).toEqual([{ type: 'status', payload: { connected: true, state: 'connected' } }]);
        expect(sockets().length).toBe(1);        // and it did NOT open a second one
    });

    it('reports reconnecting rather than connected while the socket is still opening', () => {
        boot();                                   // socket exists, never accepted

        const late = [];
        rt.start((type, payload) => late.push({ type, payload }));

        expect(late.at(-1).payload.connected).toBe(false);
        expect(late.at(-1).payload.state).toBe('reconnecting');
    });
});

describe('stop', () => {
    it('terminates the socket and schedules no reconnect', () => {
        boot();
        socket().acceptConnection();
        const s = socket();

        rt.stop();

        expect(s.terminated).toBe(true);
        vi.advanceTimersByTime(120000);
        expect(sockets().length).toBe(1);
        expect(statuses().at(-1)).toBe('disconnected');
    });
});

describe('messages', () => {
    it('relays parsed frames to the renderer', () => {
        boot();
        socket().acceptConnection();
        socket().deliver({ t: 'posted', channel: 'general' });

        const relayed = events.filter((e) => e.type === 'message');
        expect(relayed).toEqual([{ type: 'message', payload: { t: 'posted', channel: 'general' } }]);
    });

    it('ignores malformed or untyped frames instead of crashing', () => {
        boot();
        socket().acceptConnection();
        socket().deliver('<html>not json</html>');
        socket().deliver({ missing: 'the t field' });

        expect(events.filter((e) => e.type === 'message')).toEqual([]);
    });

    it('sends the board helper frames in the shape the DO expects', () => {
        boot();
        socket().acceptConnection();

        rt.notifyPosted('general');
        expect(socket().lastSent()).toEqual({ t: 'posted', channel: 'general' });

        rt.sendTyping('random', false);
        expect(socket().lastSent()).toEqual({ t: 'typing', channel: 'random', name: 'Scarm', stop: false });

        // greet/farewell ride the voice frame — the peers' clients SPEAK them
        // when this person joins or leaves — and speaker/vgender say WHOSE
        // voice to speak them in: this person's own choice, not whatever the
        // listener picked. Empty/default when unset, never absent.
        rt.sendVoice(true, false, true);
        expect(socket().lastSent())
            .toEqual({
                t: 'voice', inVoice: true, muted: false, deafened: true, name: 'Scarm',
                greet: '', farewell: '', speaker: '', vgender: 'female'
            });

        rt.sendPresence('away');
        expect(socket().lastSent()).toEqual({ t: 'presence', name: 'Scarm', status: 'away' });
    });

    it('defaults the channel when one is not given', () => {
        boot();
        socket().acceptConnection();
        rt.notifyPosted();
        expect(socket().lastSent()).toEqual({ t: 'posted', channel: 'general' });
    });

    it('reports failure rather than throwing when the socket is not open', () => {
        boot();                       // created but never opened
        expect(rt.send({ t: 'ping' })).toBe(false);
    });
});

// The socket's identity is decided ONCE, by the headers it opens with.
//
// socketHeaders() sends x-account-token because the server has no other way to
// learn which ACCOUNT a native socket belongs to, and every unicast it sends —
// DM delivery, DM thread events, an admin's "end this person's call" — is
// addressed by account. connect() only ever gated on hasSession(), i.e. the
// shared board cookie, so any path that connected while the account step was
// still on screen opened an anonymous socket: the window's own 'show'/'focus'
// handler calls wake(), and that fires before the renderer has signed in.
// enterApp()'s rt.start() then no-op'd on the existing socket, so it stayed
// identity-less for the whole session and all three features silently did
// nothing — with DMs only appearing on the 12-second poll, no chime, no
// notification.
describe('a socket opened before the account existed', () => {
    it('is reopened with the credential once start() has one', () => {
        const { store, net } = boot();                 // board cookie, no account token
        const first = socket();
        first.acceptConnection();
        expect(first.options.headers['x-account-token']).toBeUndefined();

        // What enterApp() does after refreshAccount(): the token now exists.
        store.writeAccountToken('ACCT456');
        net.init();
        rt.start();

        expect(sockets().length).toBe(2);
        const second = socket();
        expect(second).not.toBe(first);
        expect(second.options.headers['x-account-token']).toBe('ACCT456');
        // …and the anonymous one is gone rather than left running beside it.
        expect(first.terminated).toBe(true);
    });

    it('leaves a socket that already carried the account alone', () => {
        resetMainModules();
        const store = loadMain('store.js');
        store.init();
        store.set({ baseUrl: 'https://scarmonit.com', room: 'lounge', displayName: 'Scarm', clientId: 'c123' });
        store.writeSession('SESSION123');
        store.writeAccountToken('ACCT456');
        const net = loadMain('net.js');
        net.init();
        rt = loadMain('rt.js');
        events = [];
        rt.start((type, payload) => events.push({ type, payload }));

        const first = socket();
        first.acceptConnection();
        expect(first.options.headers['x-account-token']).toBe('ACCT456');

        rt.start();                                    // a second start(), as enterApp() makes
        expect(sockets().length).toBe(1);               // nothing to fix, nothing reopened
        expect(first.terminated).toBe(false);
    });

    it('does not reopen when there is still no account', () => {
        boot();
        const first = socket();
        first.acceptConnection();

        rt.start();
        expect(sockets().length).toBe(1);
        expect(first.terminated).toBe(false);
    });
});
