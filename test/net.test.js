// net.js — authenticated HTTP against the scarmonit.com backend.
//
// `fetch` is stubbed, so nothing here touches the network. The point is to pin
// the *shape* of what we send, because two of the rules encoded here are
// non-obvious and the "tidier" version of the code is the broken one:
//
//   • uploads must be base64 (Cloudflare's WAF content-scans raw bodies and
//     403s real PDFs before they ever reach the Worker), and
//   • a string body must not be JSON-stringified, or the base64 arrives quoted.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { electronState as env } from './helpers/electron-state.js';
import { loadMain, resetMainModules } from './helpers/load.js';

let root;
let calls;
const realFetch = global.fetch;

// Records every request and replies with whatever `handler` returns.
function stubFetch(handler) {
    calls = [];
    global.fetch = vi.fn(async (url, opts) => {
        calls.push({ url, opts });
        return handler(url, opts, calls.length - 1);
    });
}

function jsonRes(obj, { status = 200, headers = {} } = {}) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { 'content-type': 'application/json', ...headers }
    });
}

// Fresh module instances: net.js holds the cookie and the D1 bookmark at module
// scope, so state must not leak between tests.
async function load({ session = 'SESSION123' } = {}) {
    resetMainModules();
    const store = loadMain('store.js');
    store.init();
    if (session) store.writeSession(session);

    const net = loadMain('net.js');   // shares the store instance above
    net.init();
    return { store, net };
}

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'scarmvoice-net-'));
    env.userDataDir = path.join(root, 'Roaming', 'ScarmVoice');
    env.encryptionAvailable = true;
    stubFetch(() => jsonRes({ success: true }));
});

afterEach(() => {
    global.fetch = realFetch;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* best effort */ }
});

describe('upload', () => {
    it('sends base64 with the WAF-bypass headers, byte-exact', async () => {
        const { net } = await load();
        // Real binary content — a minimal/ASCII-only PDF does NOT trip the WAF,
        // which is what made this bug look intermittent.
        const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x00, 0xff, 0xfe, 0x80, 0x0a]);
        stubFetch(() => jsonRes({ success: true, key: 'uploads/x' }));

        const r = await net.upload('rep ort.pdf', 'application/pdf', bytes);

        expect(r.success).toBe(true);
        const { url, opts } = calls[0];
        expect(url).toBe('https://scarmonit.com/api/board/upload');
        expect(opts.method).toBe('POST');
        expect(opts.headers['x-file-encoding']).toBe('base64');
        expect(opts.headers['Content-Type']).toBe('text/plain');
        expect(opts.headers['x-file-name']).toBe(encodeURIComponent('rep ort.pdf'));
        expect(opts.headers['x-file-type']).toBe('application/pdf');
        expect(opts.headers.Cookie).toBe('sb_auth=SESSION123');

        // The round trip is the whole point: a corrupted encoding still "uploads".
        expect(Buffer.from(opts.body, 'base64').equals(bytes)).toBe(true);
    });

    it('defaults the content type when the caller has none', async () => {
        const { net } = await load();
        await net.upload('x.bin', '', Buffer.from([1, 2, 3]));
        expect(calls[0].opts.headers['x-file-type']).toBe('application/octet-stream');
    });

    it('rejects an empty file without calling the network', async () => {
        const { net } = await load();
        const r = await net.upload('empty.txt', 'text/plain', Buffer.alloc(0));

        expect(r.success).toBe(false);
        expect(r.error).toMatch(/empty/i);
        expect(calls.length).toBe(0);
    });

    // upload() is the FALLBACK path now — base64 through the Worker — so its
    // ceiling is a Worker's memory, not the board's attachment limit. The board
    // limit is net.MAX_UPLOAD (1 GiB) and belongs to uploadAttachment below.
    const LEGACY_MAX = 25 * 1024 * 1024;

    it('rejects a file too large for the fallback path without calling the network', async () => {
        const { net } = await load();
        const r = await net.upload('big.zip', 'application/zip', Buffer.alloc(LEGACY_MAX + 1));

        expect(r.success).toBe(false);
        expect(r.error).toMatch(/too large/i);
        expect(calls.length).toBe(0);
    });

    it('allows a file exactly at the fallback limit', async () => {
        const { net } = await load();
        await net.upload('exact.zip', 'application/zip', Buffer.alloc(LEGACY_MAX));
        expect(calls.length).toBe(1);
    });

    it('the board limit is a gigabyte, and it is not the fallback limit', async () => {
        // A regression guard with teeth: if someone "tidies" these back into one
        // constant, the 1 GB path silently starts refusing at 25 MB again.
        const { net } = await load();
        expect(net.MAX_UPLOAD).toBe(1024 * 1024 * 1024);
        expect(net.MAX_UPLOAD).toBeGreaterThan(LEGACY_MAX);
    });

    it('refuses to upload with no session', async () => {
        const { net } = await load({ session: null });
        const r = await net.upload('x.txt', 'text/plain', Buffer.from('hi'));

        expect(r.needsAuth).toBe(true);
        expect(calls.length).toBe(0);
    });
});

describe('request', () => {
    it('passes a string body through untouched', async () => {
        const { net } = await load();
        await net.request('/x', { method: 'POST', body: 'AAECAwQ=' });

        expect(calls[0].opts.body).toBe('AAECAwQ=');
        expect(calls[0].opts.headers['Content-Type']).toBe('text/plain');
    });

    it('JSON-encodes an object body', async () => {
        const { net } = await load();
        await net.request('/x', { method: 'POST', body: { a: 1 } });

        expect(calls[0].opts.body).toBe('{"a":1}');
        expect(calls[0].opts.headers['Content-Type']).toBe('application/json');
    });

    it('builds a query string and drops empty values', async () => {
        const { net } = await load();
        await net.request('/x', { query: { a: '1', b: null, c: '', d: undefined, e: 'x y' } });

        expect(calls[0].url).toBe('https://scarmonit.com/x?a=1&e=x%20y');
    });

    it('attaches the session cookie', async () => {
        const { net } = await load();
        await net.request('/x');
        expect(calls[0].opts.headers.Cookie).toBe('sb_auth=SESSION123');
    });

    it('sends no cookie header when signed out', async () => {
        const { net } = await load({ session: null });
        await net.request('/x');
        expect(calls[0].opts.headers.Cookie).toBeUndefined();
    });

    it('picks up a rotated cookie and persists it', async () => {
        const { store, net } = await load();
        stubFetch((url, opts, i) => (i === 0
            ? jsonRes({ ok: true }, { headers: { 'set-cookie': 'sb_auth=ROTATED; Path=/; HttpOnly' } })
            : jsonRes({ ok: true })));

        await net.request('/auth/status');
        expect(store.readSession()).toBe('ROTATED');

        await net.request('/x');
        expect(calls[1].opts.headers.Cookie).toBe('sb_auth=ROTATED');
    });

    it('falls back to a single set-cookie header when getSetCookie is absent', async () => {
        const { store, net } = await load();
        stubFetch(() => ({
            status: 200,
            headers: { get: (k) => (k.toLowerCase() === 'set-cookie' ? 'sb_auth=FALLBACK; Path=/' : null) },
            json: async () => ({ ok: true })
        }));

        await net.request('/x');
        expect(store.readSession()).toBe('FALLBACK');
    });
});

describe('baseUrl', () => {
    it('strips trailing slashes', async () => {
        const { store, net } = await load();
        store.set({ baseUrl: 'https://scarmonit.com///' });
        expect(net.baseUrl()).toBe('https://scarmonit.com');
    });

    it('allows a loopback dev server', async () => {
        const { store, net } = await load();
        store.set({ baseUrl: 'http://localhost:8788' });
        expect(net.baseUrl()).toBe('http://localhost:8788');
    });

    it('refuses an origin we do not ship', async () => {
        // baseUrl decides who receives the session cookie AND the account token,
        // so a free-text value is a one-field credential handover.
        const { store, net } = await load();
        store.set({ baseUrl: 'https://evil.test' });
        expect(net.baseUrl()).toBe('https://scarmonit.com');
    });

});

describe('board', () => {
    it('clears the session on 401 and reports needsAuth', async () => {
        const { store, net } = await load();
        // /auth/status answers 200 {authed:boolean} — it never 401s (see
        // _middleware.js). Stubbing it as a 401 modelled something the server
        // cannot do, and a board 401 is only believed once the gate confirms it.
        stubFetch((url) => (String(url).includes('/auth/status')
            ? jsonRes({ authed: false })
            : new Response('unauthorized', { status: 401 })));

        const r = await net.board('list');

        expect(r.needsAuth).toBe(true);
        expect(net.hasSession()).toBe(false);
        expect(store.readSession()).toBe('');
    });

    it('reports a needsAuth failure with no session instead of calling out', async () => {
        const { net } = await load({ session: null });
        const r = await net.board('list');

        expect(r.needsAuth).toBe(true);
        expect(calls.length).toBe(0);
    });

    it('surfaces a non-JSON response as an error rather than throwing', async () => {
        const { net } = await load();
        stubFetch(() => new Response('<!doctype html><h1>502</h1>', { status: 502 }));

        const r = await net.board('list');

        expect(r.success).toBe(false);
        expect(r.error).toMatch(/502/);
    });

    it('sequences D1 bookmarks and forces a primary read after a write', async () => {
        const { net } = await load();
        let n = 0;
        stubFetch(() => {
            n += 1;
            return jsonRes({ success: true, messages: [] }, { headers: { 'x-d1-bookmark': 'bm' + n } });
        });

        await net.board('list');
        expect(calls[0].opts.headers['x-d1-bookmark']).toBe('first-unconstrained');

        await net.board('list');
        expect(calls[1].opts.headers['x-d1-bookmark']).toBe('bm1');

        // A successful write must make the NEXT read hit the primary, or your own
        // message can be missing from the list you immediately fetch.
        await net.board('post', { method: 'POST', body: { text: 'hi' } });
        await net.board('list');
        expect(calls[3].opts.headers['x-d1-bookmark']).toBe('first-primary');

        // ...and then it goes back to following the bookmark.
        await net.board('list');
        expect(calls[4].opts.headers['x-d1-bookmark']).toBe('bm4');
    });

    it('does not send a bookmark header on non-read endpoints', async () => {
        const { net } = await load();
        await net.board('post', { method: 'POST', body: { text: 'hi' } });
        expect(calls[0].opts.headers['x-d1-bookmark']).toBeUndefined();
    });
});

describe('login', () => {
    it('fails when the server says success but no cookie came back', async () => {
        // Authed-but-useless: every later call would 401 with no way to recover.
        const { net } = await load({ session: null });
        stubFetch(() => jsonRes({ success: true }));

        const r = await net.login('hunter2');

        expect(r.success).toBe(false);
        expect(r.error).toMatch(/cookie/i);
    });

    it('succeeds when a cookie is returned', async () => {
        const { store, net } = await load({ session: null });
        stubFetch(() => jsonRes({ success: true }, { headers: { 'set-cookie': 'sb_auth=FRESH; Path=/' } }));

        const r = await net.login('hunter2');

        expect(r.success).toBe(true);
        expect(store.readSession()).toBe('FRESH');
    });

    it('reports rate limiting distinctly', async () => {
        const { net } = await load({ session: null });
        stubFetch(() => jsonRes({ success: false }, { status: 429, headers: { 'retry-after': '42' } }));

        const r = await net.login('wrong');

        expect(r.rateLimited).toBe(true);
        expect(r.error).toMatch(/42/);
    });
});

describe('transient retry', () => {
    it('retries a read that fails with a network error, then succeeds', async () => {
        const { net } = await load();
        stubFetch((_u, _o, i) => {
            if (i === 0) throw new Error('socket hang up');
            return jsonRes({ success: true, posts: [] });
        });

        const r = await net.board('list');

        expect(r.success).toBe(true);
        expect(calls).toHaveLength(2);
    });

    it('retries a read on a gateway error from in front of the Worker', async () => {
        const { net } = await load();
        stubFetch((_u, _o, i) => (i === 0
            ? jsonRes({}, { status: 502 })
            : jsonRes({ success: true })));

        const r = await net.board('list');

        expect(r.success).toBe(true);
        expect(calls).toHaveLength(2);
    });

    it('gives up after the configured attempts rather than retrying forever', async () => {
        const { net } = await load();
        stubFetch(() => { throw new Error('offline'); });

        const r = await net.board('list');

        expect(r.success).toBe(false);
        expect(r.network).toBe(true);
        expect(calls).toHaveLength(3);      // the first try plus two retries
    });

    it('NEVER retries a write, which would post the message twice', async () => {
        // The failure can happen after the server already accepted it, so a
        // retry is not safe no matter how transient the error looks.
        const { net } = await load();
        stubFetch(() => { throw new Error('socket hang up'); });

        const r = await net.board('post', { method: 'POST', body: { body: 'hi' } });

        expect(r.success).toBe(false);
        expect(r.network).toBe(true);
        expect(calls).toHaveLength(1);
    });

    it('does not retry a 4xx, which will not resolve itself', async () => {
        const { net } = await load();
        stubFetch(() => jsonRes({ success: false, error: 'nope' }, { status: 400 }));

        await net.board('list');

        expect(calls).toHaveLength(1);
    });
});

describe('upload progress', () => {
    it('reports bytes handed to the socket, ending at the total', async () => {
        const { net } = await load();
        stubFetch(async (_u, opts) => {
            // Drain the streamed body the way the real transport would.
            if (opts.body && typeof opts.body.getReader === 'function') {
                const reader = opts.body.getReader();
                // eslint-disable-next-line no-constant-condition
                while (true) { const { done } = await reader.read(); if (done) break; }
            }
            return jsonRes({ success: true, key: 'uploads/x' });
        });

        const seen = [];
        const bytes = Buffer.alloc(200 * 1024, 7);      // big enough for several chunks
        const r = await net.upload('big.bin', 'application/octet-stream', bytes,
            (sent, total) => seen.push([sent, total]));

        expect(r.success).toBe(true);
        expect(seen.length).toBeGreaterThan(1);
        // Monotonic, and finishing exactly at the total.
        seen.forEach(([sent, total], i) => {
            expect(sent).toBeLessThanOrEqual(total);
            if (i) expect(sent).toBeGreaterThan(seen[i - 1][0]);
        });
        expect(seen[seen.length - 1][0]).toBe(seen[seen.length - 1][1]);
    });

    it('sends a plain body when no progress callback is given', async () => {
        const { net } = await load();
        stubFetch(() => jsonRes({ success: true }));

        await net.upload('x.txt', 'text/plain', Buffer.from('hello'));

        expect(typeof calls[0].opts.body).toBe('string');
        expect(calls[0].opts.duplex).toBeUndefined();
    });

    it('declares the body length so the request is not sent chunked', async () => {
        const { net } = await load();
        stubFetch(async (_u, opts) => {
            if (opts.body && typeof opts.body.getReader === 'function') {
                const reader = opts.body.getReader();
                // eslint-disable-next-line no-constant-condition
                while (true) { const { done } = await reader.read(); if (done) break; }
            }
            return jsonRes({ success: true });
        });

        const bytes = Buffer.from('hello world');
        await net.upload('x.txt', 'text/plain', bytes, () => {});

        const { opts } = calls[0];
        expect(opts.duplex).toBe('half');
        // base64 of the payload, which is what actually goes on the wire
        expect(opts.headers['Content-Length']).toBe(String(bytes.toString('base64').length));
    });
});

// The account token and the session cookie are both bearer-equivalent, and the
// only thing deciding which host and which PATH they reach is the stored base
// url. These pin that boundary end to end, because the guard in boardpath.js
// cannot see past it: it resolves the caller's path against the origin, so a
// base url carrying a path/fragment splices a different endpoint underneath an
// already-issued verdict.
describe('the base url cannot be used to re-aim a credentialled request', () => {
    const SPLICES = [
        'https://scarmonit.com/api/board/account/login#',
        'https://scarmonit.com/api/board/account/login?',
        'https://scarmonit.com/api/board/account/login',
        'https://scarmonit.com/#',
        'https://user:pw@scarmonit.com'
    ];

    it('refuses to store anything but a bare allowed origin', async () => {
        const { store } = await load();
        for (const bad of SPLICES) {
            expect(store.set({ baseUrl: bad }).baseUrl, bad).toBe('https://scarmonit.com');
        }
        // …while the origins we actually ship still round-trip, port included.
        expect(store.set({ baseUrl: 'http://localhost:8788' }).baseUrl).toBe('http://localhost:8788');
        expect(store.set({ baseUrl: 'https://scarmonit.com/' }).baseUrl).toBe('https://scarmonit.com');
    });

    it('requests the endpoint the guard approved, not one spliced in behind it', async () => {
        const { store, net } = await load();
        store.set({ baseUrl: SPLICES[0] });
        await net.board('list', { method: 'POST', body: { username: 'u', password: 'p' } });
        expect(new URL(calls[0].url).pathname).toBe('/api/board/list');
    });

    it('ignores a spliced base url already sitting in settings.json', async () => {
        // A value written by an older build, or by hand, must not survive the read.
        fs.mkdirSync(env.userDataDir, { recursive: true });
        fs.writeFileSync(
            path.join(env.userDataDir, 'settings.json'),
            JSON.stringify({ baseUrl: SPLICES[0], clientId: 'c1' })
        );
        const { store, net } = await load();
        expect(store.get().baseUrl).toBe('https://scarmonit.com');
        await net.board('list');
        expect(new URL(calls[0].url).pathname).toBe('/api/board/list');
    });
});

describe('redirects', () => {
    function redirectTo(location, status) {
        let hop = 0;
        stubFetch(() => (hop++ === 0
            ? new Response(null, { status, headers: { location } })
            : jsonRes({ success: true })));
    }

    // A 307/308 preserves the request body, and the body of account/login is the
    // password in cleartext. Dropping the credentials is not enough — the hop
    // must not happen at all.
    it('refuses to follow one off the allow-list, so the body never leaves', async () => {
        for (const status of [301, 302, 303, 307, 308]) {
            const { net } = await load();
            redirectTo('https://evil.example/collect', status);
            const r = await net.board('account/login', {
                method: 'POST', body: { username: 'u', password: 'S3cret' }
            });
            expect(r.success, String(status)).toBe(false);
            expect(calls.length, String(status)).toBe(1);
            expect(calls.every((c) => new URL(c.url).hostname === 'scarmonit.com')).toBe(true);
        }
    });

    it('still follows one that stays on the allow-list', async () => {
        const { net } = await load();
        redirectTo('https://scarmonit.com/api/board/list', 302);
        const r = await net.board('list');
        expect(r.success).toBe(true);
        expect(calls.length).toBe(2);
    });
});

// An install belongs to ONE account. When two people share a computer the
// second one asks for a client id the first already owns, and the server refuses
// to reassign it — reassignment was how you seized someone else's install. What
// it does instead is mint the second account an id of its own and return it, and
// storing that is the only thing standing between them and a permanent 403 from
// presence, typing and voice.
describe('client id rotation', () => {
    it('adopts the id the server issues on login', async () => {
        const { store, net } = await load();
        const before = store.get().clientId;
        expect(before).toBeTruthy();

        stubFetch(() => jsonRes({
            success: true, token: 'T', clientId: 'cFRESH', clientRotated: true,
            user: { id: 2, username: 'bob', role: 'member' }
        }));
        const r = await net.accountLogin('bob', 'pw', before);

        expect(r.success).toBe(true);
        expect(store.get().clientId).toBe('cFRESH');
        expect(store.get().clientId).not.toBe(before);
    });

    it('adopts it on the startup me() probe too', async () => {
        const { store, net } = await load();
        stubFetch(() => jsonRes({ success: true, token: 'T', clientId: 'cA', user: { id: 1, username: 'a', role: 'admin' } }));
        await net.accountLogin('a', 'pw', store.get().clientId);

        stubFetch(() => jsonRes({
            success: true, clientId: 'cROTATED', clientRotated: true,
            user: { id: 1, username: 'a', role: 'admin' }
        }));
        await net.accountMe();
        expect(store.get().clientId).toBe('cROTATED');
    });

    it('leaves the stored id alone when the server keeps it', async () => {
        const { store, net } = await load();
        const before = store.get().clientId;
        stubFetch(() => jsonRes({
            success: true, token: 'T', clientId: before, clientRotated: false,
            user: { id: 1, username: 'a', role: 'member' }
        }));
        await net.accountLogin('a', 'pw', before);
        expect(store.get().clientId).toBe(before);
    });

    // Older servers don't send the field at all; the client must not wipe its
    // own id because a response happened not to mention it.
    it('keeps the stored id when the response omits one', async () => {
        const { store, net } = await load();
        const before = store.get().clientId;
        stubFetch(() => jsonRes({ success: true, token: 'T', user: { id: 1, username: 'a', role: 'member' } }));
        await net.accountLogin('a', 'pw', before);
        expect(store.get().clientId).toBe(before);
    });
});

// The two credentials fail INDEPENDENTLY, and conflating them is what produced
// "Your session expired." on a session that had thirty days left on it.
//
// _middleware.js answers any /api/board/* call that has no account with a 401
// and `needsAccount: true` — on `list`, on `presence`, on anything. Only the
// /account/ prefix was treated as an account problem, so those 401s reached the
// clearCredentials() path and destroyed the board cookie. The renderer reads
// needsAuth as "session expired", so an expired ACCOUNT token silently logged
// you out of the BOARD, mid-flow, including while creating an account.
describe('a 401 that means "no account" must not destroy the board session', () => {
    function accountRequired() {
        stubFetch(() => jsonRes(
            { success: false, error: 'account required', needsAccount: true },
            { status: 401 }
        ));
    }

    it('keeps the board cookie and reports needsAccount, not needsAuth', async () => {
        const { store, net } = await load();
        accountRequired();

        const r = await net.board('list');

        expect(r.needsAccount).toBe(true);
        expect(r.needsAuth).toBeUndefined();
        expect(net.hasSession()).toBe(true);
        expect(store.readSession()).toBe('SESSION123');
    });

    it('holds for every board path, not just the account namespace', async () => {
        for (const path of ['list', 'presence', 'channels', 'typing', 'voice/token']) {
            const { net } = await load();
            accountRequired();
            const r = await net.board(path);
            expect(r.needsAccount, path).toBe(true);
            expect(net.hasSession(), path).toBe(true);
        }
    });

    it('applies to uploads too', async () => {
        const { store, net } = await load();
        accountRequired();

        const r = await net.upload('a.txt', 'text/plain', Buffer.from('hi'));

        expect(r.needsAccount).toBe(true);
        expect(net.hasSession()).toBe(true);
        expect(store.readSession()).toBe('SESSION123');
    });

    // A board-gate 401 has no needsAccount flag, and that one really does mean
    // the session is gone — the behaviour above must not swallow it.
    it('still clears the session for a real board-gate 401', async () => {
        const { store, net } = await load();
        stubFetch((url) => (String(url).includes('/auth/status')
            ? jsonRes({ authed: false })
            : jsonRes({ success: false, error: 'unauthorized' }, { status: 401 })));

        const r = await net.board('list');

        expect(r.needsAuth).toBe(true);
        expect(net.hasSession()).toBe(false);
        expect(store.readSession()).toBe('');
    });
});

// Destroying a thirty-day credential requires PROOF, not a single 401.
//
// enterApp() fires half a dozen board calls at once. Any one of them coming
// back 401 for a transient reason used to call clearCredentials(), which the
// renderer turns into "Your session expired. Sign in again." — so the app could
// announce an expiry the moment it opened, on a session that was fine. A 401
// that claims the board session is dead is now checked against /auth/status
// first, and only a gate that agrees may end the session.
describe('an unconfirmed 401 must not end the session', () => {
    // 401 on the board call; /auth/status still says we are signed in.
    function contradictory(status = { authed: true }) {
        stubFetch((url) => (String(url).includes('/auth/status')
            ? jsonRes(status)
            : jsonRes({ success: false, error: 'unauthorized' }, { status: 401 })));
    }

    it('keeps the credential when the gate says we are still authed', async () => {
        const { store, net } = await load();
        contradictory();

        const r = await net.board('list');

        expect(r.transient).toBe(true);
        expect(r.needsAuth).toBeUndefined();
        expect(net.hasSession()).toBe(true);
        expect(store.readSession()).toBe('SESSION123');
    });

    it('keeps it when the gate cannot be reached — "cannot confirm" is not "signed out"', async () => {
        const { store, net } = await load();
        stubFetch((url) => (String(url).includes('/auth/status')
            ? Promise.reject(new Error('network down'))
            : jsonRes({ success: false, error: 'unauthorized' }, { status: 401 })));

        const r = await net.board('list');

        expect(r.transient).toBe(true);
        expect(net.hasSession()).toBe(true);
        expect(store.readSession()).toBe('SESSION123');
    });

    it('keeps it when the gate answers with something unreadable', async () => {
        const { net } = await load();
        stubFetch((url) => (String(url).includes('/auth/status')
            ? new Response('<html>502</html>', { status: 502 })
            : jsonRes({ success: false, error: 'unauthorized' }, { status: 401 })));

        const r = await net.board('list');
        expect(r.transient).toBe(true);
        expect(net.hasSession()).toBe(true);
    });

    // …but a session that really is dead must still end, or the app would sit
    // there retrying forever with a credential the server has forgotten.
    it('DOES clear when the gate confirms we are signed out', async () => {
        const { store, net } = await load();
        contradictory({ authed: false });

        const r = await net.board('list');

        expect(r.needsAuth).toBe(true);
        expect(net.hasSession()).toBe(false);
        expect(store.readSession()).toBe('');
    });

    it('applies to uploads too', async () => {
        const { net } = await load();
        contradictory();
        const r = await net.upload('a.txt', 'text/plain', Buffer.from('hi'));
        expect(r.transient).toBe(true);
        expect(net.hasSession()).toBe(true);
    });
});

// The path a real file takes: a presigned PUT straight to R2, streamed from
// disk. Nothing here may buffer the file — that is the entire reason it exists —
// so the tests pin the wire shape rather than the outcome alone.
describe('uploadAttachment (presigned, streamed)', () => {
    // Drains whatever was passed as a request body, stream or buffer.
    async function readBody(body) {
        if (!body) return Buffer.alloc(0);
        if (Buffer.isBuffer(body)) return body;
        if (body instanceof Uint8Array) return Buffer.from(body);
        const chunks = [];
        const reader = body.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(Buffer.from(value));
        }
        return Buffer.concat(chunks);
    }

    function writeTemp(name, bytes) {
        const p = path.join(root, name);
        fs.writeFileSync(p, bytes);
        return p;
    }

    it('streams the file from disk to the presigned URL with an explicit length', async () => {
        const bytes = Buffer.from('a real file on disk, byte for byte');
        const file = writeTemp('note.txt', bytes);

        stubFetch((url) => {
            if (String(url).includes('/api/board/upload-url')) {
                return jsonRes({ success: true, key: 'board/123-abc-note.txt', url: 'https://acct.r2.cloudflarestorage.com/bucket/board/123-abc-note.txt?sig' });
            }
            return new Response('', { status: 200 });
        });

        const { net } = await load();
        const seen = [];
        const r = await net.uploadAttachment(
            { name: 'note.txt', type: 'text/plain', size: bytes.length, path: file },
            (sent, total) => seen.push([sent, total])
        );

        expect(r.success).toBe(true);
        expect(r.key).toBe('board/123-abc-note.txt');

        const put = calls.find((c) => String(c.url).includes('r2.cloudflarestorage.com'));
        expect(put).toBeTruthy();
        expect(put.opts.method).toBe('PUT');
        // Chunked transfer-encoding is refused by S3-compatible presigned PUTs,
        // so the length has to be stated up front for a streamed body.
        expect(put.opts.headers['Content-Length']).toBe(String(bytes.length));
        expect(put.opts.duplex).toBe('half');
        // The board's credentials must never travel to storage.
        expect(put.opts.headers.Cookie).toBeUndefined();
        expect((await readBody(put.opts.body)).equals(bytes)).toBe(true);
        expect(seen.length).toBeGreaterThan(0);
    });

    it('refuses an upload URL that does not point at storage', async () => {
        const file = writeTemp('x.bin', Buffer.from([1, 2, 3]));
        stubFetch((url) => {
            if (String(url).includes('/api/board/upload-url')) {
                return jsonRes({ success: true, key: 'board/x', url: 'https://evil.example.com/anything' });
            }
            return new Response('', { status: 200 });
        });

        const { net } = await load();
        const r = await net.uploadAttachment({ name: 'x.bin', type: '', size: 3, path: file });

        expect(r.success).toBe(false);
        expect(r.error).toMatch(/storage/i);
        // The decisive part: the bytes never left.
        expect(calls.some((c) => String(c.url).includes('evil.example.com'))).toBe(false);
    });

    it('falls back to the base64 endpoint when presigning is unavailable', async () => {
        const bytes = Buffer.from('small enough for a Worker');
        const file = writeTemp('small.txt', bytes);
        stubFetch((url) => {
            if (String(url).includes('/api/board/upload-url')) {
                return jsonRes({ success: false, error: 'R2 credentials not configured', presignUnavailable: true }, { status: 503 });
            }
            return jsonRes({ success: true, key: 'board/fallback', name: 'small.txt', type: 'text/plain', size: bytes.length });
        });

        const { net } = await load();
        const r = await net.uploadAttachment({ name: 'small.txt', type: 'text/plain', size: bytes.length, path: file });

        expect(r.success).toBe(true);
        const legacy = calls.find((c) => String(c.url).endsWith('/api/board/upload'));
        expect(legacy).toBeTruthy();
        expect(legacy.opts.headers['x-file-encoding']).toBe('base64');
        expect(Buffer.from(legacy.opts.body, 'base64').equals(bytes)).toBe(true);
    });

    it('will not fall back for a file the fallback cannot carry', async () => {
        // 26 MB of zeros on disk, never read into memory by the code under test.
        const file = writeTemp('big.bin', Buffer.alloc(26 * 1024 * 1024));
        stubFetch((url) => {
            if (String(url).includes('/api/board/upload-url')) {
                return jsonRes({ success: false, error: 'nope', presignUnavailable: true }, { status: 503 });
            }
            return jsonRes({ success: true });
        });

        const { net } = await load();
        const r = await net.uploadAttachment({ name: 'big.bin', type: '', size: 26 * 1024 * 1024, path: file });

        expect(r.success).toBe(false);
        expect(r.error).toMatch(/unavailable/i);
        expect(calls.some((c) => String(c.url).endsWith('/api/board/upload'))).toBe(false);
    });

    it('takes the size from the file on disk, not from the caller', async () => {
        const bytes = Buffer.from('twelve bytes');
        const file = writeTemp('lied.txt', bytes);
        stubFetch((url) => {
            if (String(url).includes('/api/board/upload-url')) {
                return jsonRes({ success: true, key: 'board/k', url: 'https://acct.r2.cloudflarestorage.com/b/k?sig' });
            }
            return new Response('', { status: 200 });
        });

        const { net } = await load();
        await net.uploadAttachment({ name: 'lied.txt', type: 'text/plain', size: 999999, path: file });

        const ticket = calls.find((c) => String(c.url).includes('/api/board/upload-url'));
        expect(JSON.parse(ticket.opts.body).size).toBe(bytes.length);
    });
});
