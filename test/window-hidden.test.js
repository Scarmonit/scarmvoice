// @vitest-environment jsdom
//
// "Stop working while nobody is looking" — and the reason it never worked.
//
// The window is created with `backgroundThrottling: false` on purpose: it keeps
// the presence heartbeat and the fallback poll alive while the app sits in the
// tray, which is what fixed the "messages stop after an hour minimised" bug.
// The price, which nothing in the code accounted for, is that Chromium then
// stops maintaining the visibility API as well. Verified in this Electron
// build: `document.hidden` reads `false` through both a hide to the tray AND a
// minimize, and `visibilitychange` never fires at all.
//
// Every "skip this while hidden" guard in the renderer was written against that
// flag, so not one of them had ever run — the thread poll kept asking the
// server every 2.5 seconds, the DM poll every 12, and the shared 20Hz meter
// tick kept running an RMS loop per call participant, all for a window in the
// tray. main.js now watches the real window events and says so; these pin that
// the renderer listens, acts on it, and — the part that matters more — catches
// up when the window comes back.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { bootRenderer, $, settle } from './helpers/renderer.js';

function router(seen) {
    return vi.fn(async (p) => {
        const key = String(p).split('?')[0];
        seen.push(key);
        if (key === 'list') return { success: true, posts: [], hasMore: false, typing: [], voice: [] };
        if (key === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
        if (key === 'presence') return { success: true, members: [] };
        if (key === 'dm/threads') return { success: true, threads: [] };
        return { success: true };
    });
}

let seen;
let app;

beforeEach(async () => {
    document.documentElement.innerHTML = '';
    seen = [];
    app = await bootRenderer({ board: router(seen) });
    await settle(30);
});

describe('a window put away in the tray', () => {
    it('is something the renderer is told about, because it cannot see it', async () => {
        // document.hidden is frozen at false here exactly as it is in the real
        // app, so this listener is the ONLY source of truth. If the bridge ever
        // stops delivering it, every guard below silently reverts to running
        // all the time — which is the state this whole file exists to end.
        expect(document.hidden).toBe(false);
        expect(typeof app.lounge.win.onHidden).toBe('function');
    });

    it('pauses the decorative animations, and resumes them on the way back', async () => {
        app.hidden(true);
        await settle(2);
        // An explicit list of selectors in styles.css keys off this class. Not
        // a universal selector: that would recalc the whole document on every
        // restore, spending a felt interaction to save background work.
        expect(document.documentElement.classList.contains('win-hidden')).toBe(true);

        app.hidden(false);
        await settle(2);
        expect(document.documentElement.classList.contains('win-hidden')).toBe(false);
    });

    it('stops the shared meter tick while away and starts it again on return', async () => {
        // The tick drives speaking dots and the mic-test bar — both of which
        // are drawn on a window that is not on screen. audio.js already had
        // this logic; it was keyed to a flag that never changed.
        const audio = window.ScarmAudio;
        expect(typeof audio.setHidden).toBe('function');

        const spy = vi.spyOn(audio, 'setHidden');
        app.hidden(true);
        await settle(2);
        expect(spy).toHaveBeenCalledWith(true);

        app.hidden(false);
        await settle(2);
        expect(spy).toHaveBeenCalledWith(false);
        spy.mockRestore();
    });
});

describe('coming back from the tray', () => {
    it('refreshes the panels whose polls were skipped', async () => {
        // This is the half that makes skipping safe. The refreshes used to sit
        // on the visibilitychange listener — which never fired — so they have
        // been moved onto app:resync, which main.js really does send on
        // restore/show/focus.
        seen.length = 0;
        app.resync();
        await settle(20);

        // A resync re-reads the channel the user is looking at and their
        // conversation list; anything skipped while away lands here.
        expect(seen).toContain('list');
        expect(seen).toContain('dm/threads');
    });
});
