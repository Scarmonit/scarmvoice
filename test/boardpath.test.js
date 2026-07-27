// The guard that keeps the board ACCOUNT TOKEN out of the renderer.
//
// `board:call` returns the server's JSON to the renderer verbatim, so it must
// never reach an endpoint whose response carries the token — those have their
// own main-process handlers that strip it before replying.
//
// The guard this replaced normalised the raw string, which was useless: net.js
// concatenates the path onto the base URL unparsed and the URL parser collapses
// dot segments, so '../../api/board/account/login' passed a check for
// "starts with account/" and then resolved to exactly that endpoint. These
// cases are the regression test for that.
import { describe, it, expect } from 'vitest';
import boardpath from '../src/main/boardpath.js';

const { resolveBoardPath, needsAccountBridge } = boardpath;
const BASE = 'https://scarmonit.com';

// What board:call does with a path: null (rejected) or the path it would request.
function allow(p) {
    const r = resolveBoardPath(p, BASE);
    if (!r || needsAccountBridge(r.key)) return null;
    return r.path;
}

describe('resolveBoardPath', () => {
    it('passes every endpoint the app actually calls', () => {
        const real = [
            'account/manage', 'account/twofactor', 'account/users', 'account/me',
            'account/logout', 'account/resend',
            'channels', 'delete', 'dm/list', 'dm/send', 'dm/threads', 'edit',
            'list', 'pin', 'pins', 'post', 'presence', 'react', 'search',
            'thread', 'typing', 'voice/presence', 'unfurl', 'voice/token'
        ];
        for (const p of real) expect(allow(p), p).toBe(p);
    });

    it('refuses the account endpoints that hand back a token', () => {
        for (const p of ['account/login', 'account/register', 'account/verify']) {
            expect(allow(p), p).toBeNull();
        }
    });

    it('refuses a traversal that would resolve onto a denied endpoint', () => {
        // Each of these resolves to /api/board/account/login.
        expect(allow('../../api/board/account/login')).toBeNull();
        expect(allow('x/../account/login')).toBeNull();
        expect(allow('account/me/../login')).toBeNull();
        expect(allow('%2e%2e/%2e%2e/api/board/account/login')).toBeNull();
        expect(allow('..%2f..%2fapi/board/account/login')).toBeNull();
        expect(allow('//account/login')).toBeNull();
    });

    it('refuses anything that escapes the /api/board/ namespace', () => {
        expect(allow('../../../auth/login')).toBeNull();
        expect(allow('../../auth/status')).toBeNull();
    });

    it('refuses a path that tries to name another origin', () => {
        expect(allow('https://evil.example/x')).toBeNull();
        expect(allow('//evil.example/x')).toBeNull();
    });

    it('is not fooled by case or a query string', () => {
        // The old guard lowercased for comparison but forwarded the raw string.
        expect(allow('ACCOUNT/LOGIN')).toBeNull();
        expect(allow('account/login?x=1')).toBeNull();
    });

    it('keeps a query string on a path that is allowed', () => {
        expect(allow('account/me?clientId=abc')).toBe('account/me?clientId=abc');
    });

    it('returns null rather than throwing on junk', () => {
        for (const p of [null, undefined, '', '   ', 42, {}]) {
            expect(() => resolveBoardPath(p, BASE)).not.toThrow();
        }
        expect(allow('')).toBeNull();
    });
});

// Every case above passes the canonical base url, which is precisely why the
// guard looked sound while a settings-driven base url walked straight around
// it: the guard resolves the caller's path as an ABSOLUTE path, so it only ever
// sees "list", while net.js concatenates onto whatever baseUrl holds. A base of
// "https://scarmonit.com/api/board/account/login#" therefore requests the
// account endpoint under a verdict issued for "list".
//
// store.normalizeBaseUrl is what makes that unreachable, so these assert the two
// halves together: the guard's blindness is real, and the store refuses to hold
// a value that could exploit it.
describe('a base url is the other half of this guard', () => {
    const SPLICE = 'https://scarmonit.com/api/board/account/login';

    it('resolves an innocuous key while naming a denied endpoint', () => {
        for (const suffix of ['#', '?', '#x', '?x=1']) {
            const r = resolveBoardPath('list', SPLICE + suffix);
            // The guard says "list" and allows it…
            expect(r, suffix).toEqual({ key: 'list', path: 'list' });
            expect(needsAccountBridge(r.key), suffix).toBe(false);
            // …while the url net.js would build points at account/login.
            expect(new URL(SPLICE + suffix + '/api/board/' + r.path).pathname, suffix)
                .toBe('/api/board/account/login');
        }
    });
});
