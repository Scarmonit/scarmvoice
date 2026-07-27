// Which /api/board/* paths the generic renderer proxy (`board:call`) is allowed
// to reach, and what the caller's path actually resolves to.
//
// This lives in its own module because it is the boundary that keeps the board
// ACCOUNT TOKEN out of the renderer. Every account endpoint that mints or
// returns that token has a dedicated handler in main.js which strips it before
// replying; the generic proxy returns the server's JSON verbatim, so it must
// never be able to reach one of those endpoints.
//
// The subtlety that made the original guard useless: it normalised the raw
// string, but net.js concatenates the path onto the base URL unparsed and the
// URL parser collapses dot segments. So '../../api/board/account/login' and
// 'x/../account/login' read as innocuous relative paths to a string check while
// resolving to exactly the endpoint being denied. Deciding on the RESOLVED path
// — and handing that resolved path back so net.board can't rebuild a different
// one — is what closes it.

const BOARD_PREFIX = '/api/board/';

// Every real endpoint is lowercase words and slashes. Anything else — a dot
// segment, a percent escape, a scheme, an uppercase letter — is rejected
// outright rather than reasoned about.
const SAFE_BOARD_PATH = /^[a-z0-9][a-z0-9/_-]*$/;

// The read-only corner of the account namespace the UI genuinely needs.
const ACCOUNT_PROXYABLE = new Set([
    'account/me', 'account/users', 'account/manage',
    'account/twofactor', 'account/logout', 'account/resend'
]);

// -> { key, path } for a path that is safe to request, or null.
//   key  the allowlist key (the path relative to /api/board/)
//   path what to hand net.board — resolved, so no traversal survives
function resolveBoardPath(p, baseUrl) {
    let u;
    let origin;
    try {
        origin = new URL(baseUrl).origin;
        u = new URL(BOARD_PREFIX + String(p || '').replace(/^\/+/, ''), baseUrl);
    } catch (e) {
        return null;
    }
    if (u.origin !== origin) return null;
    if (!u.pathname.startsWith(BOARD_PREFIX)) return null;
    const rel = u.pathname.slice(BOARD_PREFIX.length);
    if (!SAFE_BOARD_PATH.test(rel)) return null;
    return { key: rel, path: rel + u.search };
}

// True when this path must go through a dedicated account handler instead.
function needsAccountBridge(key) {
    return String(key || '').startsWith('account/') && !ACCOUNT_PROXYABLE.has(key);
}

module.exports = { resolveBoardPath, needsAccountBridge, ACCOUNT_PROXYABLE, BOARD_PREFIX };
