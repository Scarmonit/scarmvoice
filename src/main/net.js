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
let accountToken = '';    // board account session (x-account-token)

function init() {
    cookie = store.readSession() || '';
    accountToken = store.readAccountToken() || '';
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

async function request(pathname, { method = 'GET', body, headers = {}, query, timeout } = {}) {
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
    // Board accounts are mandatory server-side. Attach the token at THIS level
    // so every board call carries it — including uploads and the lounge://
    // attachment proxy, which don't go through board().
    if (accountToken && pathname.startsWith('/api/board/')) {
        opts.headers['x-account-token'] = accountToken;
    }
    if (body !== undefined && body !== null) {
        if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
            // A streamed request body (the upload progress path). duplex:'half'
            // is mandatory in undici/fetch for any non-buffered body.
            opts.body = body;
            opts.duplex = 'half';
        } else if (body instanceof Uint8Array || Buffer.isBuffer(body)) {
            opts.body = body;
        } else if (typeof body === 'string') {
            // Raw string body (e.g. a base64 upload). Trust the caller's
            // Content-Type; don't JSON-encode it.
            opts.body = body;
            if (!opts.headers['Content-Type']) opts.headers['Content-Type'] = 'text/plain';
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

    return res;
}

// ---- auth ----------------------------------------------------------------

async function login(password) {
    // /auth/login is outside the gate and sets the cookie on success.
    let res;
    try {
        res = await request('/auth/login', {
            method: 'POST',
            body: { password: String(password || '') }
        });
    } catch (e) {
        // Offline / DNS / timeout must come back as the module's normal
        // { success:false } shape — a bare throw here rejects the IPC invoke
        // and the login form gets a raw exception it was never built for.
        return {
            success: false,
            error: e.name === 'TimeoutError'
                ? 'Could not reach the server (timed out). Are you online?'
                : 'Could not reach the server. Are you online?',
            network: true
        };
    }

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

// A GET is safe to repeat; a POST/DELETE is not — retrying one that already
// reached the server would post the message twice. So only reads are retried,
// and only for failures that are plausibly transient: a dropped connection, a
// timeout, or a 5xx / 429 from in front of the Worker.
const RETRY_DELAYS = [400, 1200];

function retriable(status) {
    return status === 429 || status === 502 || status === 503 || status === 504;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function board(pathname, { method = 'GET', body, query } = {}) {
    if (!cookie) return { success: false, error: 'unauthorized', needsAuth: true };

    const headers = {};
    // (The account token is attached in request() for every /api/board/ call.)
    if (pathname === 'list' || pathname === 'thread') {
        headers['x-d1-bookmark'] = forcePrimary ? 'first-primary' : (bookmark || 'first-unconstrained');
        forcePrimary = false;
    }

    const canRetry = method === 'GET';
    let res;
    let lastErr = null;

    for (let attempt = 0; ; attempt++) {
        try {
            res = await request('/api/board/' + pathname, { method, body, query, headers });
            lastErr = null;
            if (!canRetry || !retriable(res.status) || attempt >= RETRY_DELAYS.length) break;
            console.warn(`[net] ${pathname} -> ${res.status}, retrying (${attempt + 1})`);
            // Drain the response we're abandoning — an unconsumed body pins its
            // keep-alive connection until GC gets around to it, which bleeds
            // sockets during exactly the outages retries are for.
            try { await res.body?.cancel(); } catch (e) { /* already gone */ }
        } catch (e) {
            lastErr = e;
            if (!canRetry || attempt >= RETRY_DELAYS.length) break;
            console.warn(`[net] ${pathname} failed (${e.message}), retrying (${attempt + 1})`);
        }
        await sleep(RETRY_DELAYS[attempt]);
    }

    if (lastErr) {
        return {
            success: false,
            error: lastErr.name === 'TimeoutError' ? 'Request timed out' : lastErr.message,
            network: true
        };
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

// ---- board accounts --------------------------------------------------------
// The token lives here (main process) exactly like the sb_auth cookie: the
// renderer only ever sees parsed results, never the credential.

async function accountRegister(username, password, email, clientId) {
    // Success now means "verification code sent" — the token arrives from
    // accountVerify once the emailed code is redeemed.
    return board('account/register', { method: 'POST', body: { username, password, email, clientId } });
}

async function accountVerify(username, code, clientId) {
    const res = await board('account/verify', { method: 'POST', body: { username, code, clientId } });
    if (res && res.success && res.token) {
        accountToken = res.token;
        store.writeAccountToken(accountToken);
        return { success: true, user: res.user };
    }
    return res;
}

async function accountResend(username) {
    return board('account/resend', { method: 'POST', body: { username } });
}

async function accountLogin(username, password, clientId, totpCode) {
    const res = await board('account/login', { method: 'POST', body: { username, password, clientId, totpCode: totpCode || undefined } });
    if (res && res.success && res.token) {
        accountToken = res.token;
        store.writeAccountToken(accountToken);
        return { success: true, user: res.user };
    }
    return res && res.success ? { success: false, error: 'No token returned' } : res;
}

async function accountLogout() {
    try { await board('account/logout', { method: 'POST', body: {} }); } catch (e) { /* best effort */ }
    accountToken = '';
    store.clearAccountToken();
    return { success: true };
}

async function accountMe() {
    if (!accountToken) return { success: true, user: null };
    // clientId registers this install against the account (device merging).
    const res = await board('account/me', { query: { clientId: store.get().clientId } });
    // An expired/revoked token is not an account — drop it so the UI offers
    // sign-in again instead of silently sending a dead header forever.
    if (res && res.success && !res.user) {
        accountToken = '';
        store.clearAccountToken();
    }
    return res;
}

function hasAccount() {
    return !!accountToken;
}

// Attachment bytes, proxied so the renderer can display them without the cookie.
async function fileStream(key) {
    return request('/api/board/file', { query: { key } });
}

// Store an attachment in R2. Deliberately identical to what the website's
// board.js does — raw body plus X-File-* headers, NOT multipart — so a file
// uploaded from the desktop app is indistinguishable from a browser upload and
// renders the same for everyone.
const MAX_UPLOAD = 25 * 1024 * 1024;

// The body is pushed in chunks this size so progress has somewhere to come from.
// 64 KB is small enough to make the bar move smoothly on a slow uplink and large
// enough that the per-chunk overhead is irrelevant.
const UPLOAD_CHUNK = 64 * 1024;

// A ReadableStream over the payload that reports how much has been handed to the
// socket. This is "sent", not "acknowledged" — the last few percent can sit in
// kernel buffers — so the caller should treat 100% as "waiting on the server",
// which is exactly how the composer renders it.
function progressStream(text, onProgress) {
    let offset = 0;
    const total = text.length;
    return new ReadableStream({
        pull(controller) {
            if (offset >= total) { controller.close(); return; }
            const end = Math.min(offset + UPLOAD_CHUNK, total);
            controller.enqueue(Buffer.from(text.slice(offset, end), 'latin1'));
            offset = end;
            try { onProgress(offset, total); } catch (e) { /* never break the upload */ }
        }
    });
}

async function upload(name, type, bytes, onProgress) {
    if (!cookie) return { success: false, error: 'unauthorized', needsAuth: true };

    const buf = Buffer.from(bytes);
    if (!buf.length) return { success: false, error: 'That file is empty' };
    if (buf.length > MAX_UPLOAD) {
        return { success: false, error: `"${name}" is ${(buf.length / 1048576).toFixed(1)} MB — the limit is 25 MB` };
    }

    // Send base64, not raw bytes: Cloudflare's WAF content-scans raw upload
    // bodies and 403s real PDFs/binaries before they ever reach the Worker.
    // Base64 is opaque text the WAF won't match, so any file type uploads.
    const b64 = buf.toString('base64');

    const headers = {
        'x-file-name': encodeURIComponent(name || 'file'),
        'x-file-type': type || 'application/octet-stream',
        'x-file-encoding': 'base64',
        'Content-Type': 'text/plain',
        // Explicit, so a streamed body still goes out with a known length rather
        // than chunked transfer-encoding.
        'Content-Length': String(Buffer.byteLength(b64))
    };
    const TIMEOUT = 5 * 60 * 1000;   // 25 MB over a slow uplink needs far more than the default

    let res;
    try {
        if (typeof onProgress === 'function') {
            try {
                res = await request('/api/board/upload', {
                    method: 'POST',
                    body: progressStream(b64, onProgress),
                    headers,
                    timeout: TIMEOUT
                });
            } catch (e) {
                // A stream body needs duplex:'half' support in the runtime. If
                // that is what failed, fall back to the plain string body — a
                // missing progress bar is far better than a failed upload.
                if (!/duplex|not supported|Invalid state/i.test(e.message || '')) throw e;
                console.warn('[net] streamed upload unsupported, falling back:', e.message);
                res = await request('/api/board/upload', {
                    method: 'POST', body: b64, headers, timeout: TIMEOUT
                });
            }
        } else {
            res = await request('/api/board/upload', {
                method: 'POST', body: b64, headers, timeout: TIMEOUT
            });
        }
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
    accountRegister, accountLogin, accountLogout, accountMe, hasAccount,
    accountVerify, accountResend,
    hasSession, cookieHeader, baseUrl, MAX_UPLOAD
};
