// The board connection has to survive between requests.
//
// undici destroys an idle socket four seconds after the last response — its
// Agent default — and Cloudflare sends no `Keep-Alive: timeout=` hint that
// would raise it. Every cadence in this app is longer than that: the idle poll
// is 60s, the DM poll 12s, the thread poll 2.5s, and anything a person does by
// hand is minutes apart. So nothing was ever reused and every request re-paid
// TCP and TLS.
//
// Measured in the shipped runtime (Electron 33.4.11) against the real origin,
// four requests at a six-second cadence:
//
//     default dispatcher   224, 114, 119, 125 ms   — 4 connections
//     keepAliveTimeout 30s 123,  40,  43,  43 ms   — 1 connection
//
// The connection COUNT is the causal evidence; the timings are the consequence.
//
// Two things are pinned here, and the second is the one that has already been
// got wrong once: the swap cannot happen at init(), because Node builds the
// global dispatcher lazily and the symbol is still empty at that point — code
// placed there silently does nothing and ships no benefit at all.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { electronState as env } from './helpers/electron-state.js';
import { loadMain, resetMainModules } from './helpers/load.js';

const DISPATCHER = Symbol.for('undici.globalDispatcher.1');

let root;
const realFetch = global.fetch;
const realDispatcher = Object.getOwnPropertyDescriptor(globalThis, DISPATCHER);

// A stand-in for undici's Agent: records the options every replacement is
// constructed with, so the test can see what net.js asked for.
class FakeDispatcher {
    constructor(opts) {
        this.opts = opts || {};
        FakeDispatcher.built.push(this.opts);
    }
}
FakeDispatcher.built = [];

async function load() {
    resetMainModules();
    const store = loadMain('store.js');
    store.init();
    store.writeSession('SESSION123');
    const net = loadMain('net.js');
    net.init();
    return { store, net };
}

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'scarmvoice-ka-'));
    env.userDataDir = path.join(root, 'Roaming', 'ScarmVoice');
    env.encryptionAvailable = true;
    FakeDispatcher.built = [];
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ success: true }),
        { status: 200, headers: { 'content-type': 'application/json' } }));
});

afterEach(() => {
    global.fetch = realFetch;
    if (realDispatcher) Object.defineProperty(globalThis, DISPATCHER, realDispatcher);
    else delete globalThis[DISPATCHER];
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* best effort */ }
});

describe('connection reuse', () => {
    it('does not touch the dispatcher at init — it does not exist yet', async () => {
        delete globalThis[DISPATCHER];
        await load();
        // The failure this guards against is silent: put the swap in init() and
        // it reads `undefined`, does nothing, and every request keeps paying a
        // fresh handshake while the code looks correct.
        expect(FakeDispatcher.built).toEqual([]);
        expect(globalThis[DISPATCHER]).toBeUndefined();
    });

    it('widens the idle timeout on the first request that finds a dispatcher', async () => {
        const { net } = await load();
        globalThis[DISPATCHER] = new FakeDispatcher({ keepAliveTimeout: 4000 });
        FakeDispatcher.built = [];

        await net.board('list', { query: { channel: 'general' } });

        expect(FakeDispatcher.built).toHaveLength(1);
        // 30s clears every request cadence in the app, and was the value
        // stress-tested against the real origin (four 29s-idle reuses, zero new
        // connections). `connections` is deliberately NOT set — capping the
        // pool would serialise the startup burst.
        expect(FakeDispatcher.built[0].keepAliveTimeout).toBe(30000);
        expect(FakeDispatcher.built[0].connections).toBeUndefined();
    });

    it('swaps once, not on every request', async () => {
        const { net } = await load();
        globalThis[DISPATCHER] = new FakeDispatcher({ keepAliveTimeout: 4000 });
        FakeDispatcher.built = [];

        await net.board('list', { query: { channel: 'general' } });
        await net.board('channels', { method: 'POST', body: {} });
        await net.board('presence', { method: 'POST', body: {} });

        // Rebuilding the dispatcher per request would throw the pool away each
        // time — worse than the default it replaces.
        expect(FakeDispatcher.built).toHaveLength(1);
    });

    it('still makes the request when the dispatcher cannot be replaced', async () => {
        const { net } = await load();
        // A future undici whose constructor rejects these options, or a frozen
        // global: the request must go out regardless. Worst case is the
        // behaviour we already had.
        globalThis[DISPATCHER] = { constructor: function () { throw new Error('nope'); } };

        const res = await net.board('list', { query: { channel: 'general' } });
        expect(res).toEqual({ success: true });
        expect(global.fetch).toHaveBeenCalled();
    });
});
