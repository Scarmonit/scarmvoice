// @vitest-environment jsdom
//
// The window must not open on a sign-in screen it is about to throw away.
//
// The card used to be the first thing painted on EVERY launch — a blurred
// scrim and a caret in a password field — because it was visible in markup and
// only hidden once boot() had been to the server and back to find out we were
// already signed in. On a normal launch that is a couple of hundred
// milliseconds of the wrong screen, every single time.
//
// It is hidden in markup now, and every path that wants it unhides it by hand.
// The half that makes that safe is the deadline: withholding the card is only
// acceptable for as long as an answer is plausibly coming. net.js waits twenty
// seconds before giving up on a request, and a captive portal or a
// half-connected VPN would otherwise leave a blank window for all of it.
//
// The two cases boot separate renderers, so they are one per file-order slot
// and the HANGING one goes first: a renderer left running by a previous test
// reaches enterApp() and hides the card, which is the exact state the hanging
// case asserts against.
import { describe, it, expect, vi } from 'vitest';
import { bootRenderer, settle } from './helpers/renderer.js';

const ANSWER = async (p) => {
    const key = String(p).split('?')[0];
    if (key === 'list') return { success: true, posts: [], hasMore: false, typing: [], voice: [] };
    if (key === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
    if (key === 'presence') return { success: true, members: [] };
    if (key === 'dm/threads') return { success: true, threads: [] };
    return { success: true };
};

const card = () => document.getElementById('login');

describe('a launch that cannot reach the server', () => {
    it('shows the sign-in card once the deadline passes', async () => {
        vi.useFakeTimers();
        try {
            document.documentElement.innerHTML = '';
            const booted = bootRenderer({
                board: vi.fn(ANSWER),
                authStatus: () => new Promise(() => {})   // never settles
            });
            await vi.advanceTimersByTimeAsync(1000);
            expect(card().hidden, 'card after the deadline passed').toBe(false);
            await booted.catch(() => {});
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('a launch that is already signed in', () => {
    it('never paints the sign-in card at all', async () => {
        document.documentElement.innerHTML = '';
        // Sampled INSIDE auth.status — the round trip during which the card
        // used to be the only thing on screen. Sampling any later passes either
        // way, because enterApp() hides the card before it makes a single board
        // call, and by then the flash is over.
        let hiddenDuringStatus = null;
        await bootRenderer({
            board: vi.fn(ANSWER),
            authStatus: async () => {
                hiddenDuringStatus = card().hidden;
                return { authed: true };
            }
        });
        await settle(40);

        expect(hiddenDuringStatus, 'card while the session check was in flight').toBe(true);
        expect(card().hidden, 'card once the app is up').toBe(true);
    });
});
