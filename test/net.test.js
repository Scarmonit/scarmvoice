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

    it('rejects a file over 25 MB without calling the network', async () => {
        const { net } = await load();
        const r = await net.upload('big.zip', 'application/zip', Buffer.alloc(net.MAX_UPLOAD + 1));

        expect(r.success).toBe(false);
        expect(r.error).toMatch(/25 MB/);
        expect(calls.length).toBe(0);
    });

    it('allows a file exactly at the limit', async () => {
        const { net } = await load();
        await net.upload('exact.zip', 'application/zip', Buffer.alloc(net.MAX_UPLOAD));
        expect(calls.length).toBe(1);
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
        store.set({ baseUrl: 'https://example.test///' });
        expect(net.baseUrl()).toBe('https://example.test');
    });
});

describe('board', () => {
    it('clears the session on 401 and reports needsAuth', async () => {
        const { store, net } = await load();
        stubFetch(() => new Response('unauthorized', { status: 401 }));

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
