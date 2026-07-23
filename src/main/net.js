// Authenticated HTTP against the scarmonit.com backend.
//
// Why this lives in the main process: the site's session cookie is HttpOnly,
// Secure and SameSite=Lax. A renderer loaded from file:// is a *different site*,
// so a browser-side fetch would never attach the cookie and every /api/board/*
// call would 401. Here we hold the cookie ourselves and set the header
// explicitly, which is both deterministic and immune to SameSite semantics.
//
// The renderer never sees the cookie — it only gets parsed JSON back over IPC.
const store = require('./store');

const COOKIE_NAME = 'sb_auth';
const TIMEOUT_MS = 20000;

let cookie = '';          // the raw sb_auth value, not the whole header

function init() {
    cookie = store.readSession() || '';
}

function baseUrl() {
    return (store.get().baseUrl || 'https://scarmonit.com').replace(/\/+$/, '');
}

function hasSession() {
    return !!cookie;
}

function authHeader() {
    return cookie ? { Cookie: `${COOKIE_NAME}=${cookie}` } : {};
}

// Expose the header to the WebSocket bridge, which needs the same credential.
function cookieHeader() {
    return authHeader();
}

// Pull sb_auth out of a response's Set-Cookie header(s).
function captureCookie(res) {
    let all = [];
    try {
        if (typeof res.headers.getSetCookie === 'function') all = res.headers.getSetCookie();
    } catch (e) { /* fall through */ }
    if (!all.length) {
        const single = res.headers.get('set-cookie');
        if (single) all = [single];
    }
    for (const line of all) {
        const m = /(?:^|;\s*)sb_auth=([^;]*)/.exec(line);
        if (m) return m[1];
    }
    return null;
}

async function request(pathname, { method = 'GET', body, headers = {}, query, raw = false, timeout } = {}) {
    let url = baseUrl() + pathname;
    if (query) {
        const qs = Object.keys(query)
            .filter((k) => query[k] !== null && query[k] !== undefined && query[k] !== '')
            .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(query[k]))
            .join('&');
        if (qs) url += (url.includes('?') ? '&' : '?') + qs;
    }

    const opts = {
        method,
        headers: Object.assign({ Accept: 'application/json' }, authHeader(), headers),
        // We manage the cookie by hand; never let a jar interfere.
        redirect: 'follow',
        signal: AbortSignal.timeout(timeout || TIMEOUT_MS)
    };
    if (body !== undefined && body !== null) {
        if (body instanceof Uint8Array || Buffer.isBuffer(body)) {
            opts.body = body;
        } else {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
    }

    const res = await fetch(url, opts);

    // The middleware refreshes the cookie on login; pick up any rotation too.
    const fresh = captureCookie(res);
    if (fresh !== null && fresh !== cookie) {
        cookie = fresh;
        store.writeSession(cookie);
    }

    if (raw) return res;
    return res;
}

// ---- auth ----------------------------------------------------------------

async function login(password) {
    // /auth/login is outside the gate and sets the cookie on success.
    const res = await request('/auth/login', {
        method: 'POST',
        body: { password: String(password || '') }
    });

    let data = {};
    try { data = await res.json(); } catch (e) { /* non-JSON error page */ }

    if (res.ok && data && data.success) {
        if (!cookie) {
            // Success without a readable cookie means we'd be authed-but-useless.
            return { success: false, error: 'Signed in but no session cookie was returned.' };
        }
        return { success: true };
    }
    if (res.status === 429) {
        const retry = res.headers.get('retry-after');
        return { success: false, error: `Too many attempts. Try again in ${retry || 60}s.`, rateLimited: true };
    }
    return { success: false, error: 'Incorrect password.' };
}

async function logout() {
    try { await request('/auth/logout', { method: 'POST' }); } catch (e) { /* best effort */ }
    cookie = '';
    store.clearSession();
    return { success: true };
}

// Verify the stored cookie is still valid (30-day TTL server-side).
async function status() {
    if (!cookie) { console.log('[auth] no session cookie held'); return { authed: false }; }
    try {
        const res = await request('/auth/status');
        const data = await res.json();
        const authed = !!(data && data.authed);
        console.log('[auth] /auth/status -> ' + res.status + ' authed=' + authed);
        if (!authed) { cookie = ''; store.clearSession(); }
        return { authed };
    } catch (e) {
        // Offline: keep the cookie, report unknown rather than logging the user out.
        return { authed: false, offline: true, error: e.message };
    }
}

// ---- board API -----------------------------------------------------------

// D1 read replication: carry the bookmark so reads stay sequentially consistent,
// and force one primary read right after our own write (read-your-writes) —
// mirrors what the website's board.js does.
let bookmark = null;
let forcePrimary = false;

async function board(pathname, { method = 'GET', body, query } = {}) {
    if (!cookie) return { success: false, error: 'unauthorized', needsAuth: true };

    const headers = {};
    if (pathname === 'list' || pathname === 'thread') {
        headers['x-d1-bookmark'] = forcePrimary ? 'first-primary' : (bookmark || 'first-unconstrained');
        forcePrimary = false;
    }

    let res;
    try {
        res = await request('/api/board/' + pathname, { method, body, query, headers });
    } catch (e) {
        return { success: false, error: e.name === 'TimeoutError' ? 'Request timed out' : e.message, network: true };
    }

    const bm = res.headers.get('x-d1-bookmark');
    if (bm) bookmark = bm;

    if (res.status === 401) {
        cookie = '';
        store.clearSession();
        return { success: false, error: 'unauthorized', needsAuth: true };
    }

    let data;
    try {
        data = await res.json();
    } catch (e) {
        return { success: false, error: `Bad response (${res.status})` };
    }
    if (method !== 'GET' && data && data.success) forcePrimary = true;
    return data;
}

// Attachment bytes, proxied so the renderer can display them without the cookie.
async function fileStream(key) {
    return request('/api/board/file', { query: { key }, raw: true });
}

// Store an attachment in R2. Deliberately identical to what the website's
// board.js does — raw body plus X-File-* headers, NOT multipart — so a file
// uploaded from the desktop app is indistinguishable from a browser upload and
// renders the same for everyone.
const MAX_UPLOAD = 25 * 1024 * 1024;

async function upload(name, type, bytes) {
    if (!cookie) return { success: false, error: 'unauthorized', needsAuth: true };

    const buf = Buffer.from(bytes);
    if (!buf.length) return { success: false, error: 'That file is empty' };
    if (buf.length > MAX_UPLOAD) {
        return { success: false, error: `"${name}" is ${(buf.length / 1048576).toFixed(1)} MB — the limit is 25 MB` };
    }

    let res;
    try {
        res = await request('/api/board/upload', {
            method: 'POST',
            body: buf,
            headers: {
                'x-file-name': encodeURIComponent(name || 'file'),
                'x-file-type': type || 'application/octet-stream'
            },
            timeout: 5 * 60 * 1000   // 25 MB over a slow uplink needs far more than the default
        });
    } catch (e) {
        return { success: false, error: e.name === 'TimeoutError' ? 'Upload timed out' : e.message, network: true };
    }

    if (res.status === 401) {
        cookie = '';
        store.clearSession();
        return { success: false, error: 'unauthorized', needsAuth: true };
    }
    try {
        return await res.json();
    } catch (e) {
        return { success: false, error: `Upload failed (${res.status})` };
    }
}

module.exports = {
    init, login, logout, status, board, request, fileStream, upload,
    hasSession, cookieHeader, baseUrl, MAX_UPLOAD
};
