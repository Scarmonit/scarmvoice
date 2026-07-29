// The startup preflight: the two calls the renderer opens with, put on the
// wire while the window is still being built.
//
// It shipped with a real latency bug, and the bug is the reason this file
// exists. The two answers were held as ONE promise, so `auth:status` did not
// resolve until `account/me` had — and account/me is the slowest call this app
// makes (750ms to 1700ms on an ordinary day here, long enough to trip the 20s
// timeout on a bad one). The renderer therefore sat waiting for an answer it
// already had, behind one it had not asked for yet.
//
// It went unnoticed because the measurement that justified the prefetch timed
// when each request LEFT, not when the renderer got its answer. So the
// assertion below is specifically about the second of those: `auth:status`
// resolves while account/me is STILL IN FLIGHT.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { electronState as env } from './helpers/electron-state.js';
import { loadMain, resetMainModules } from './helpers/load.js';

let root;
const realFetch = global.fetch;

function jsonRes(obj) {
    return new Response(JSON.stringify(obj), {
        status: 200, headers: { 'content-type': 'application/json' }
    });
}

async function load() {
    resetMainModules();
    const store = loadMain('store.js');
    store.init();
    store.writeSession('SESSION123');
    store.writeAccountToken('TOKEN456');
    const net = loadMain('net.js');
    net.init();
    return net;
}

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'scarmvoice-pre-'));
    env.userDataDir = path.join(root, 'Roaming', 'ScarmVoice');
    env.encryptionAvailable = true;
});

afterEach(() => {
    global.fetch = realFetch;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* best effort */ }
});

describe('the startup preflight', () => {
    it('answers the session check without waiting for the account call', async () => {
        // account/me is held open for the whole test. If the two are one
        // promise, the await below never returns and this times out.
        let releaseMe;
        const meHeld = new Promise((r) => { releaseMe = r; });
        let meStarted = false;

        global.fetch = vi.fn(async (url) => {
            if (String(url).includes('/auth/status')) return jsonRes({ authed: true });
            if (String(url).includes('account/me')) {
                meStarted = true;
                await meHeld;
                return jsonRes({ success: true, user: { id: 1, username: 'Me' } });
            }
            return jsonRes({ success: true });
        });

        const net = await load();
        net.prefetchSession();

        const pre = await net.takePreflight();
        expect(pre, 'a preflight was armed').toBeTruthy();

        // THE assertion. The status answer must arrive on its own.
        const st = await pre.st;
        expect(st).toEqual({ authed: true });
        expect(meStarted, 'and account/me really is still in flight').toBe(true);

        releaseMe();
        const me = await pre.me;
        expect(me).toMatchObject({ success: true });
    });

    it('does not send a bearer token when the session is dead', async () => {
        // account/me authenticates WITH the account token. Firing it at a
        // server that has just said "not signed in" spends a credential to
        // learn nothing.
        const seen = [];
        global.fetch = vi.fn(async (url) => {
            seen.push(String(url));
            if (String(url).includes('/auth/status')) return jsonRes({ authed: false });
            return jsonRes({ success: true });
        });

        const net = await load();
        net.prefetchSession();
        const pre = await net.takePreflight();
        expect(await pre.st).toMatchObject({ authed: false });
        expect(await pre.me).toBeNull();
        expect(seen.some((u) => u.includes('account/me'))).toBe(false);
    });

    it('arms nothing at all when there is no session to warm', async () => {
        global.fetch = vi.fn(async () => jsonRes({ success: true }));
        resetMainModules();
        const store = loadMain('store.js');
        store.init();                       // no session written
        const net = loadMain('net.js');
        net.init();

        net.prefetchSession();
        expect(await net.takePreflight()).toBeNull();
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('is one shot, so a later sign-in always reaches the server', async () => {
        global.fetch = vi.fn(async (url) =>
            (String(url).includes('/auth/status') ? jsonRes({ authed: true }) : jsonRes({ success: true })));

        const net = await load();
        net.prefetchSession();
        expect(await net.takePreflight()).toBeTruthy();
        // The slot is emptied on read; nothing may replay a stale snapshot.
        expect(await net.takePreflight()).toBeNull();
    });

    it('is dropped once it is stale rather than answering with old news', async () => {
        global.fetch = vi.fn(async (url) =>
            (String(url).includes('/auth/status') ? jsonRes({ authed: true }) : jsonRes({ success: true })));

        const net = await load();
        net.prefetchSession();

        const realNow = Date.now;
        Date.now = () => realNow() + 60_000;     // past PREFLIGHT_MAX_AGE_MS
        try {
            expect(await net.takePreflight()).toBeNull();
        } finally {
            Date.now = realNow;
        }
    });
});
