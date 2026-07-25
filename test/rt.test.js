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
        baseUrl: 'https://board.test',
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
        expect(socket().url).toBe('wss://board.test/api/rt/lounge?cid=c123&name=Scarm');
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

        // First tick: probe.
        vi.advanceTimersByTime(PING_MS);
        expect(socket().pings).toBe(1);
        expect(socket().lastSent()).toEqual({ t: 'ping' });
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

    it('connects instead of probing when there is no socket', () => {
        boot();
        socket().acceptConnection();
        rt.stop();
        wsState.instances = [];

        rt.start((type, payload) => events.push({ type, payload }));
        expect(sockets().length).toBe(1);
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

        rt.sendVoice(true, false);
        expect(socket().lastSent()).toEqual({ t: 'voice', inVoice: true, muted: false, name: 'Scarm' });

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
