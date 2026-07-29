// Authenticated HTTP against the scarmonit.com backend.
//
// Why this lives in the main process: the site's session cookie is HttpOnly,
// Secure and SameSite=Lax. A renderer loaded from file:// is a *different site*,
// so a browser-side fetch would never attach the cookie and every /api/board/*
// call would 401. Here we hold the cookie ourselves and set the header
// explicitly, which is both deterministic and immune to SameSite semantics.
//
// The renderer never sees the cookie — it only gets parsed JSON back over IPC.
const fs = require('fs');
const fsp = require('fs/promises');
const { Readable } = require('stream');
const store = require('./store');

const COOKIE_NAME = 'sb_auth';
const TIMEOUT_MS = 20000;

let cookie = '';          // the raw sb_auth value, not the whole header
let accountToken = '';    // board account session (x-account-token)

// ---- connection reuse -----------------------------------------------------
//
// undici (the fetch under Node, and so under the main process) destroys an idle
// socket 4 seconds after the last response — its Agent default — and Cloudflare
// sends no `Keep-Alive: timeout=` hint that would raise it. EVERY cadence in
// this app is longer than four seconds: the idle poll is 60s, the DM poll 12s,
// the thread poll 2.5s, and anything the user does by hand is minutes apart. So
// essentially nothing was ever reused, and every request re-paid TCP + TLS —
// two extra round trips in front of the one that carries the answer.
//
// Measured in the shipped runtime (Electron 33.4.11) against the real origin,
// after a >4s idle gap: 117-140ms on the default dispatcher against 36-47ms
// with the timeout widened. That is ~75ms off every channel switch, thread
// open, search, send and attachment fetch.
//
// Node builds the global dispatcher LAZILY, so this cannot live in init() —
// the symbol is still empty there and the swap would silently do nothing (it
// was written there first, and shipped no benefit at all). Attempting it on
// each request is free once it has taken, and the failure mode is exactly
// today's behaviour.
const DISPATCHER = Symbol.for('undici.globalDispatcher.1');
let keepAliveWidened = false;
function widenKeepAlive() {
    if (keepAliveWidened) return;
    try {
        const cur = globalThis[DISPATCHER];
        if (!cur || !cur.constructor) return;   // not built yet — retry next call
        keepAliveWidened = true;
        globalThis[DISPATCHER] = new cur.constructor({ keepAliveTimeout: 30000 });
    } catch (e) {
        keepAliveWidened = true;                // keep the default dispatcher
    }
}

function init() {
    cookie = store.readSession() || '';
    accountToken = store.readAccountToken() || '';
}

// store.set/load already reduce this to a bare origin. Re-normalising here means
// a settings.json written by an older build (or by hand) can't reintroduce a
// path/query/fragment for the concatenation below to splice a request onto.
function baseUrl() {
    return store.normalizeBaseUrl(store.get().baseUrl) || 'https://scarmonit.com';
}

// Both credentials are bearer-equivalent, so they only ever go to an origin we
// ship (store.isAllowedOrigin). The gate is on the RESOLVED url rather than on
// the pathname: baseUrl is settings-driven, and a path is concatenated onto it
// unparsed, so nothing about the caller's arguments can be trusted to say which
// host the request actually reaches.
function trusted(url) {
    return store.isAllowedOrigin(url);
}

function hasSession() {
    return !!cookie;
}

function authHeader() {
    return cookie ? { Cookie: `${COOKIE_NAME}=${cookie}` } : {};
}

// Expose the header to the WebSocket bridge, which needs the same credential.
function cookieHeader() {
    return trusted(baseUrl()) ? authHeader() : {};
}

// Headers for the realtime WebSocket. The account token rides along because the
// server resolves WHO a socket belongs to from a real credential — a browser
// can't set headers so it uses a signed ticket instead, but a native client
// can, and without it this socket has no identity: device merging, voice
// takeover and (since DM pushes are addressed by account) DM delivery all stop.
function socketHeaders() {
    if (!trusted(baseUrl())) return {};
    const h = authHeader();
    if (accountToken) h['x-account-token'] = accountToken;
    return h;
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

const MAX_REDIRECTS = 3;

// Redirects are followed BY HAND rather than with redirect:'follow'.
//
// Two things go wrong when the fetch layer follows them for us. First, it
// strips Cookie and Authorization across an origin change but not a *custom*
// header, so `x-account-token` — which is bearer-equivalent — would be replayed
// verbatim to whatever host the chain ended on. Second, `trusted()` was only
// ever evaluated against the URL we started with, so the cookie-rotation
// capture below would happily persist a Set-Cookie from the final response of a
// chain that had wandered off-origin (session fixation).
//
// Following by hand means every hop is re-checked against the allow-list, and
// both credential decisions key off the origin that is actually being talked to.
async function request(pathname, { method = 'GET', body, headers = {}, query, timeout } = {}) {
    widenKeepAlive();
    const base = baseUrl();
    let url = base + pathname;
    // baseUrl() is a bare origin, so the concatenation above can only produce a
    // url on that origin — but this is the single place every credentialled
    // request funnels through, so the invariant is asserted rather than assumed.
    // A mismatch means the path argument carried a scheme or an authority.
    try {
        if (new URL(url).origin !== new URL(base).origin) throw new Error('origin');
    } catch (e) {
        throw new Error('Refusing to build a request outside ' + base);
    }
    if (query) {
        const qs = Object.keys(query)
            .filter((k) => query[k] !== null && query[k] !== undefined && query[k] !== '')
            .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(query[k]))
            .join('&');
        if (qs) url += (url.includes('?') ? '&' : '?') + qs;
    }

    // One deadline for the whole chain rather than a fresh one per hop, so a
    // redirect loop can't multiply the timeout the caller asked for.
    const signal = AbortSignal.timeout(timeout || TIMEOUT_MS);
    const streamed = typeof ReadableStream !== 'undefined' && body instanceof ReadableStream;

    let verb = method;
    let payload = body;
    let hdrs = Object.assign({}, headers);

    for (let hop = 0; ; hop++) {
        const authed = trusted(url);
        if (!authed) console.warn('[net] withholding credentials from untrusted origin: ' + url);

        const opts = {
            method: verb,
            headers: Object.assign({ Accept: 'application/json' }, authed ? authHeader() : {}, hdrs),
            // We manage the cookie by hand; never let a jar interfere.
            redirect: 'manual',
            signal
        };
        // Board accounts are mandatory server-side. Attach the token at THIS
        // level so every board call carries it — including uploads and the
        // lounge:// attachment proxy, which don't go through board().
        let onBoardPath = false;
        try { onBoardPath = new URL(url).pathname.startsWith('/api/board/'); } catch (e) { /* keep false */ }
        if (authed && accountToken && onBoardPath) {
            opts.headers['x-account-token'] = accountToken;
        }
        if (payload !== undefined && payload !== null) {
            if (typeof ReadableStream !== 'undefined' && payload instanceof ReadableStream) {
                // A streamed request body (the upload progress path). duplex:'half'
                // is mandatory in undici/fetch for any non-buffered body.
                opts.body = payload;
                opts.duplex = 'half';
            } else if (payload instanceof Uint8Array || Buffer.isBuffer(payload)) {
                opts.body = payload;
            } else if (typeof payload === 'string') {
                // Raw string body (e.g. a base64 upload). Trust the caller's
                // Content-Type; don't JSON-encode it.
                opts.body = payload;
                if (!opts.headers['Content-Type']) opts.headers['Content-Type'] = 'text/plain';
            } else {
                opts.headers['Content-Type'] = 'application/json';
                opts.body = JSON.stringify(payload);
            }
        }

        const res = await fetch(url, opts);

        // The middleware refreshes the cookie on login; pick up any rotation
        // too — but only from an allow-listed origin, otherwise an untrusted
        // host could hand us an sb_auth value of its choosing and have it
        // persisted as our session.
        if (authed) {
            const fresh = captureCookie(res);
            if (fresh !== null && fresh !== cookie) {
                cookie = fresh;
                store.writeSession(cookie);
            }
        }

        const location = (res.status >= 300 && res.status <= 399)
            ? res.headers.get('location') : null;
        if (!location) return res;

        // Everything past here abandons this response; an unconsumed body pins
        // its keep-alive connection until GC.
        if (hop >= MAX_REDIRECTS) {
            try { await res.body?.cancel(); } catch (e) { /* already gone */ }
            throw new Error('Too many redirects');
        }
        const next = new URL(location, url).href;
        try { await res.body?.cancel(); } catch (e) { /* already gone */ }

        // Withholding the credentials from an off-allow-list hop is necessary
        // but not sufficient: a 307/308 preserves the request BODY, and the body
        // of /api/board/account/login is the user's password in cleartext. So a
        // redirect that leaves the allow-list is refused outright rather than
        // followed with the credentials stripped. Nothing we ship redirects off
        // its own origin, so this can only ever fire on a hostile or hijacked
        // response.
        if (!trusted(next)) {
            throw new Error('Refusing to follow a redirect to an untrusted origin');
        }

        // 303 always, and 301/302 by universal practice, turn the follow-up
        // into a bodiless GET.
        if (res.status === 303 || (payload != null && (res.status === 301 || res.status === 302))) {
            verb = 'GET';
            payload = undefined;
            delete hdrs['Content-Type'];
            delete hdrs['content-type'];
        } else if (streamed) {
            // 307/308 preserve the body, and a stream has already been consumed
            // by the hop that just failed — it cannot be replayed.
            throw new Error('Cannot follow a redirect for a streamed upload');
        }
        url = next;
    }
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

// The gate cookie and the account token are two halves of one identity, so they
// are dropped together. Clearing only the cookie used to leave a live bearer
// token in account.bin that the next launch would happily send.
function clearCredentials() {
    cookie = '';
    store.clearSession();
    accountToken = '';
    store.clearAccountToken();
}

async function logout() {
    try { await request('/auth/logout', { method: 'POST' }); } catch (e) { /* best effort */ }
    clearCredentials();
    return { success: true };
}

// Verify the stored cookie is still valid (30-day TTL server-side).
async function status() {
    if (!cookie) { console.log('[auth] no session cookie held'); return { authed: false }; }

    let res;
    try {
        res = await request('/auth/status');
    } catch (e) {
        // Offline: keep the cookie, report unknown rather than logging the user out.
        return { authed: false, offline: true, error: e.message };
    }

    let data = null;
    try { data = await res.json(); } catch (e) { /* an error page, not JSON */ }
    if (!data || typeof data.authed !== 'boolean') {
        // A 500 (or an HTML error page from in front of the Worker) says the
        // SERVER is unwell, not that we are signed out — reporting it as a
        // definite "not authed" would throw away a session that is probably
        // still good, so it is treated like being offline.
        console.warn('[auth] /auth/status -> ' + res.status + ' with an unreadable body');
        return { authed: false, offline: true, error: `Bad response (${res.status})` };
    }

    const authed = data.authed;
    console.log('[auth] /auth/status -> ' + res.status + ' authed=' + authed);
    if (!authed) clearCredentials();
    return { authed };
}

// Does the gate itself agree that we are signed out?
//
// Deliberately NOT status(): that one calls clearCredentials() on a negative
// answer, and this runs inside the decision about whether to clear at all. It
// also has to fail safe — "I could not ask" is not "you are signed out".
async function confirmSignedOut() {
    if (!cookie) return { signedOut: true, why: 'no cookie held' };
    let res;
    try {
        res = await request('/auth/status');
    } catch (e) {
        return { signedOut: false, why: 'unreachable: ' + (e && e.message) };
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* an error page, not JSON */ }
    if (!data || typeof data.authed !== 'boolean') {
        return { signedOut: false, why: 'unreadable ' + res.status };
    }
    return data.authed
        ? { signedOut: false, why: 'still authed' }
        : { signedOut: true, why: 'gate says signed out' };
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

async function board(pathname, { method = 'GET', body, query, primary } = {}) {
    if (!cookie) return { success: false, error: 'unauthorized', needsAuth: true };

    const headers = {};
    // (The account token is attached in request() for every /api/board/ call.)
    if (pathname === 'list' || pathname === 'thread') {
        // `primary` is an explicit ask for a primary read, for a caller that
        // knows it is racing a write it cannot see. Startup uses it: the first
        // `list` now leaves alongside the channels POST rather than behind it,
        // and without this it could be answered by a replica that had not yet
        // caught up with that POST — freshness today's ordering gets by
        // accident, spent deliberately instead.
        headers['x-d1-bookmark'] = (primary || forcePrimary) ? 'first-primary' : (bookmark || 'first-unconstrained');
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
        let msg = 'unauthorized';
        let body = null;
        try {
            body = await res.json();
            if (body && body.error) msg = body.error;
        } catch (e) { /* no readable body — keep the generic message */ }

        // THE SERVER SAYS WHICH CREDENTIAL IS MISSING; believe it.
        //
        // _middleware.js answers every /api/board/* call that has no account
        // with `{ needsAccount: true }` and a 401 — on `list`, `presence`,
        // `channels`, anything. Only the /account/ prefix was treated as an
        // account problem, so those 401s fell through to clearCredentials()
        // below and threw away a THIRTY-DAY board session that was perfectly
        // healthy. The renderer reads needsAuth as "session expired", so the
        // visible symptom was the board password screen announcing an
        // expiry that had not happened — most cruelly in the middle of
        // creating an account, where the poll timers of a previous session
        // were still running and one tick was enough to wipe the flow.
        if (body && body.needsAccount) {
            return { success: false, error: msg, needsAccount: true };
        }

        // A 401 from the account namespace is about the ACCOUNT credential, not
        // the board gate. Clearing both (and returning needsAuth, which the
        // renderer reads as "session expired") meant a mistyped account
        // password threw away a perfectly good gate session and bounced the
        // user all the way back to the site password screen.
        const key = String(pathname).split('?')[0].toLowerCase();
        if (key.startsWith('account/')) {
            // Only the endpoints that authenticate WITH the token say anything
            // about whether it is still alive; login/register/verify/resend are
            // establishing one, so a 401 there is a bad password or code.
            if (ACCOUNT_TOKEN_AUTHED.has(key)) {
                accountToken = '';
                store.clearAccountToken();
            }
            return { success: false, error: msg, needsAccount: true };
        }

        // A 401 that claims the BOARD session is dead has to be confirmed before
        // it is believed, because believing it is destructive: clearCredentials()
        // throws away a thirty-day cookie, and the renderer turns that into
        // "Your session expired. Sign in again."
        //
        // enterApp() fires half a dozen board calls at once, so a single
        // unconfirmed 401 anywhere in that burst — a D1 blip inside the
        // middleware's own account lookup, an edge hiccup, a request that raced
        // a cookie rotation — signs the user out of a session that is provably
        // fine. From the outside that is the app announcing an expiry the moment
        // it opens, having been given no chance to be wrong.
        //
        // So: ask the gate directly. Only a gate that agrees we are signed out
        // may end the session. Anything else (still authed, or unreachable) is
        // reported as transient and the credential is kept — an unconfirmable
        // 401 must never be the thing that logs someone out.
        const verdict = await confirmSignedOut();
        if (!verdict.signedOut) {
            console.warn('[net] 401 on ' + pathname + ' NOT confirmed by /auth/status (' +
                verdict.why + ') — keeping the session');
            return { success: false, error: msg, transient: true };
        }
        console.warn('[net] 401 on ' + pathname + ' confirmed signed out — clearing credentials');
        clearCredentials();
        return { success: false, error: msg, needsAuth: true };
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

// Account endpoints that authenticate WITH the token, so a 401 from one means
// the token itself is dead. Everything else in the namespace (login, register,
// verify, resend) is establishing a token rather than presenting one.
const ACCOUNT_TOKEN_AUTHED = new Set([
    'account/me', 'account/manage', 'account/logout',
    'account/twofactor', 'account/users'
]);

// An install belongs to ONE account, so the server will not hand this one's
// client id to a different account — that reassignment was a seizure bug. What
// it does instead, when the id we asked for is already someone else's, is mint
// this account an id of its own and return it here. Storing it is the whole
// unbind path: without it the second account on a shared machine is 403'd out
// of presence, typing and voice permanently, with nothing in the UI to fix it.
//
// Handled main-side because that is where the store lives, which also means
// login, verify and me are all covered without the renderer knowing.
function adoptRotatedClient(res) {
    if (!res || !res.clientId || res.clientId === store.get().clientId) return;
    store.set({ clientId: res.clientId });
    console.info('[net] this account was issued its own install id for this device');
}

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
        adoptRotatedClient(res);
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
        adoptRotatedClient(res);
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

// Disable or close the signed-in account. Both end the session on the server,
// so the local token is dropped either way — including when the call fails
// mid-flight, because a token we are no longer sure about is worse than none.
async function accountRemoval(action, password, code) {
    const res = await board('account/removal', {
        method: 'POST',
        body: { action, password, code: code || '' }
    });
    if (res && res.success) {
        accountToken = '';
        store.clearAccountToken();
    }
    return res;
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
    if (res && res.success && res.user) adoptRotatedClient(res);
    return res;
}

function hasAccount() {
    return !!accountToken;
}

// ---- startup preflight ----------------------------------------------------
//
// The renderer cannot ask us anything for ~280ms after the window is created:
// process spawn, Blink and CSS bring-up, and first paint. (Not script parse —
// that measured at 8ms.) Nothing was on the wire for any of it, and then boot()
// made two round trips in a row before the app could show a single message.
//
// So the two calls it is *going* to make are started here instead, while that
// warm-up happens. Both are exactly the calls boot() makes, run through the
// same functions with the same side effects — the credential clearing, the
// clientId adoption, the token drop on a dead token — so nothing about the
// session's behaviour changes. Only when it happens does.
//
// Strictly ONE shot, consumed by the first asker: signing in again, or any
// later refresh, must always reach the server rather than replay a stale
// snapshot. Anything older than the guard below is dropped for the same reason.
const PREFLIGHT_MAX_AGE_MS = 30000;
let preflight = null;

function prefetchSession() {
    // No cookie means status() answers `{authed:false}` without a request, so
    // there is nothing to warm and no bearer token to put on the wire.
    if (!cookie) return;
    const at = Date.now();

    // TWO promises, not one. `me` is chained on the status ANSWER — it needs to
    // know we are authed before sending a bearer token — but it is held
    // SEPARATELY, because the renderer asks these two questions separately and
    // must not be made to wait for the slow one to hear the fast one.
    //
    // They were one combined promise, and it cost exactly what you would
    // expect: `auth:status` did not resolve until account/me had, and
    // account/me is the slowest call this app makes — 750ms to 1700ms here on
    // an ordinary day, and long enough to trip the 20s timeout on a bad one.
    // The startup measurement that missed this timed when each request LEFT
    // rather than when the renderer got its answer.
    const st = status();
    const me = st
        .then((s) => (s && s.authed ? accountMe() : null))
        .catch(() => null);

    // Held rather than awaited; nothing here may reject into the app's startup.
    st.catch(() => {});
    me.catch(() => {});
    preflight = { at, st, me };
}

// Returns { st, me } — two promises, each awaited by the handler that wants it.
async function takePreflight() {
    const pre = preflight;
    preflight = null;
    if (!pre || Date.now() - pre.at > PREFLIGHT_MAX_AGE_MS) return null;
    return pre;
}

// Attachment bytes, proxied so the renderer can display them without the cookie.
async function fileStream(key) {
    return request('/api/board/file', { query: { key } });
}

// Store an attachment in R2. Deliberately identical to what the website's
// board.js does, so a file uploaded from the desktop app is indistinguishable
// from a browser upload and renders the same for everyone: a presigned PUT
// straight to R2, with the old base64-through-the-Worker endpoint kept as the
// fallback for when presigning is unavailable.
const MAX_UPLOAD = 1024 * 1024 * 1024;

// The ceiling on the fallback path. It is not a policy — it is how much a
// Worker can hold in memory, which is why the fast path exists at all.
const LEGACY_MAX_UPLOAD = 25 * 1024 * 1024;

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
    if (buf.length > LEGACY_MAX_UPLOAD) {
        return { success: false, error: `"${name}" is ${(buf.length / 1048576).toFixed(1)} MB — too large for the fallback upload path` };
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
        // Same rule as board(): /api/board/upload is account-gated, so a 401
        // here is usually "no account", not "dead board session". Clearing the
        // cookie for it would sign the user out of a session that is fine.
        let body = null;
        try { body = await res.json(); } catch (e) { /* no readable body */ }
        if (body && body.needsAccount) {
            return { success: false, error: body.error || 'account required', needsAccount: true };
        }
        // Confirmed before believed, exactly as in board() above.
        const verdict = await confirmSignedOut();
        if (!verdict.signedOut) {
            console.warn('[net] 401 on upload NOT confirmed (' + verdict.why + ') — keeping the session');
            return { success: false, error: (body && body.error) || 'Upload failed', transient: true };
        }
        clearCredentials();
        return { success: false, error: (body && body.error) || 'unauthorized', needsAuth: true };
    }
    try {
        return await res.json();
    } catch (e) {
        return { success: false, error: `Upload failed (${res.status})` };
    }
}

// ---- large attachments: presigned PUT straight to R2 -----------------------
//
// The bytes must not pass through a Worker. A Worker request body is capped far
// below a gigabyte and has ~128 MB of memory to buffer it in, and `upload()`
// above base64-encodes precisely because Cloudflare's managed WAF content-scans
// raw upload bodies — three separate reasons the old path could never carry a
// large file, none of them fixable by raising a number.
//
// So the board hands out a presigned PUT (one key, PUT only, two hours) and we
// stream the file from DISK into it. Nothing is ever fully in memory: not in the
// renderer, not over IPC, not here.

// The presigned URL comes from our own server, so it is trusted — but it is also
// the one place this process is told "send these bytes over there", and a
// tampered response should not be able to aim a user's file at an arbitrary
// host. No credential of ours is attached to this request either way.
function presignHostOk(url) {
    try {
        const u = new URL(url);
        return u.protocol === 'https:' && /(^|\.)r2\.cloudflarestorage\.com$/.test(u.hostname);
    } catch (e) {
        return false;
    }
}

// A web ReadableStream over a file on disk that reports how much has been handed
// to the socket. Same "sent, not acknowledged" caveat as progressStream above.
function fileProgressStream(filePath, total, onProgress) {
    const nodeStream = fs.createReadStream(filePath, { highWaterMark: 256 * 1024 });
    const reader = Readable.toWeb(nodeStream).getReader();
    let sent = 0;
    return new ReadableStream({
        async pull(controller) {
            const { done, value } = await reader.read();
            if (done) { controller.close(); return; }
            controller.enqueue(value);
            sent += value.byteLength;
            if (onProgress) { try { onProgress(sent, total); } catch (e) { /* never break the upload */ } }
        },
        cancel(reason) { try { reader.cancel(reason); } catch (e) {} }
    });
}

// item: { name, type, size, path? , bytes? }
// `path` is the streaming case (the file picker and drag-and-drop, via
// webUtils.getPathForFile in the renderer). `bytes` is what is left: a pasted
// screenshot, a finished voice recording, an image dragged out of a browser —
// all things that were already in memory and are small.
async function uploadAttachment(item, onProgress) {
    if (!cookie) return { success: false, error: 'unauthorized', needsAuth: true };

    const name = item.name || 'file';
    const type = item.type || 'application/octet-stream';
    let size = Number(item.size) || 0;
    let buf = null;

    if (item.path) {
        try {
            const st = await fsp.stat(item.path);
            size = st.size;                       // the file on disk is the truth
        } catch (e) {
            return { success: false, error: `Could not read ${name}` };
        }
    } else {
        buf = Buffer.from(item.bytes || []);
        size = buf.length;
    }

    if (!size) return { success: false, error: 'That file is empty' };
    if (size > MAX_UPLOAD) {
        return { success: false, error: `"${name}" is ${(size / 1073741824).toFixed(2)} GB — the limit is 1 GB` };
    }

    const ticket = await board('upload-url', { method: 'POST', body: { name, type, size } });
    if (ticket && (ticket.needsAuth || ticket.needsAccount)) return ticket;

    if (!ticket || !ticket.success || !ticket.url) {
        // A refusal with a reason (too large, demo session) is the answer.
        if (ticket && ticket.error && !ticket.presignUnavailable) {
            return { success: false, error: ticket.error };
        }
        // Presigning genuinely unavailable — the old endpoint still works for
        // anything that fits inside a Worker.
        if (size > LEGACY_MAX_UPLOAD) {
            return { success: false, error: 'Large uploads are unavailable right now — try again later' };
        }
        if (!buf) {
            try { buf = await fsp.readFile(item.path); }
            catch (e) { return { success: false, error: `Could not read ${name}` }; }
        }
        return upload(name, type, buf, onProgress ? (sent, total) => onProgress(sent, total) : null);
    }

    if (!presignHostOk(ticket.url)) {
        return { success: false, error: 'Refused an upload URL that does not point at storage' };
    }

    try {
        const body = item.path
            ? fileProgressStream(item.path, size, onProgress)
            : buf;
        const opts = {
            method: 'PUT',
            body,
            headers: {
                'Content-Type': type,
                // Explicit, so a streamed body goes out with a known length
                // rather than chunked transfer-encoding, which S3-compatible
                // endpoints do not accept for a presigned PUT.
                'Content-Length': String(size)
            }
        };
        // Required by undici before it will send a stream as a request body.
        if (item.path) opts.duplex = 'half';
        // Deliberately NO timeout: a gigabyte on a domestic uplink is a long,
        // healthy upload, and a deadline would kill it at the worst moment. A
        // genuinely dead socket still rejects.
        const res = await fetch(ticket.url, opts);
        if (!res.ok) {
            return { success: false, error: `Storage rejected the upload (${res.status})` };
        }
    } catch (e) {
        return { success: false, error: e.message || 'Upload failed', network: true };
    }

    if (onProgress) { try { onProgress(size, size); } catch (e) {} }
    return { success: true, key: ticket.key, name, type, size };
}

module.exports = {
    init, login, logout, status, board, request, fileStream, upload, uploadAttachment,
    accountRegister, accountLogin, accountLogout, accountMe, accountRemoval, hasAccount,
    accountVerify, accountResend, prefetchSession, takePreflight,
    hasSession, cookieHeader, socketHeaders, baseUrl, MAX_UPLOAD
};
