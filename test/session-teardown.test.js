// @vitest-environment jsdom
//
// What a session leaves behind when it ends without anybody clicking anything.
//
// teardownSession() is the one path every exit shares — an expired board
// session, a dead account token, a deliberate sign-out — and it already goes to
// some trouble over the microphone: the call's, the voice recorder's and the
// Settings mic test's are all released explicitly, because a capture that
// outlives the session leaves the OS microphone indicator lit behind the login
// card.
//
// There is a THIRD microphone in the renderer — the level meter inside the
// input panel behind the me-bar's caret — and it was never given the same
// treatment. Nor were the overlays that are SIBLINGS of #app rather than
// children: hiding #app does nothing to them, which is the exact reason
// closeSettings() is called in teardown, and #settings was the only one of the
// set ever added.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { bootRenderer, $, settle } from './helpers/renderer.js';

const ME = { id: 1, username: 'Me', role: 'member' };
const THEM = { id: 2, username: 'Alice', role: 'member' };
const PAIR = { id: 40, title: 'Alice', isGroup: false, user: THEM, members: [ME, THEM], unread: 0 };

// A board that answers normally until `dead` is set, after which every read
// reports the session gone — which is how a 401 reaches the renderer.
function router(state, threads) {
    return vi.fn(async (p) => {
        if (state.dead && (p === 'list' || p === 'channels')) {
            return { success: false, error: 'unauthorized', needsAuth: true };
        }
        if (p === 'dm/threads') return { success: true, threads: threads || [] };
        if (p === 'dm/list') return { success: true, thread: PAIR, messages: [] };
        if (p === 'list') return { success: true, posts: [], typing: [], voice: [], hasMore: false };
        if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
        if (p === 'presence') return { success: true, members: [] };
        return { success: true };
    });
}

// The renderer resyncs when the window comes back from the tray, which is the
// cheapest deterministic way to make a background board call happen on demand.
// Driven through app:resync — the event main.js actually sends. It used to be a
// synthetic visibilitychange, which no longer reaches anything: the app runs
// with backgroundThrottling off, so Chromium freezes document.hidden at false
// and never fires that event at all.
async function expireSession(state, app) {
    state.dead = true;
    app.resync();
    await settle(20);
}

// jsdom has no media stack. These are the two pieces startApMeter() touches.
function fakeMedia() {
    const tracks = [{ stopped: false, stop() { this.stopped = true; }, kind: 'audio' }];
    let resolveCapture = null;
    const stream = { getTracks: () => tracks };
    Object.defineProperty(window.navigator, 'mediaDevices', {
        configurable: true,
        value: {
            enumerateDevices: async () => [],
            getUserMedia: () => new Promise((res) => { resolveCapture = () => res(stream); })
        }
    });
    window.ScarmAudio = Object.assign({}, window.ScarmAudio, {
        createMeter: () => ({ rms: () => 0, stop() {} }),
        onTick: () => () => {}
    });
    return { tracks, grant: () => resolveCapture && resolveCapture() };
}

describe('a session that ends while the input panel is open', () => {
    beforeEach(() => { document.documentElement.innerHTML = ''; });

    it('releases the level meter’s microphone', async () => {
        const state = { dead: false };
        const app = await bootRenderer({ board: router(state) });
        const media = fakeMedia();

        $('btn-mic-menu').click();
        media.grant();
        await settle(6);
        expect($('mic-pop').hidden).toBe(false);

        await expireSession(state, app);

        // The panel is gone AND so is the capture — the OS microphone indicator
        // must not stay lit behind the login card.
        expect($('mic-pop').hidden).toBe(true);
        expect(media.tracks[0].stopped).toBe(true);
    });

    it('releases it even when the panel is closed mid-capture', async () => {
        await bootRenderer({ board: router({ dead: false }) });
        const media = fakeMedia();

        $('btn-mic-menu').click();      // getUserMedia is now pending
        $('btn-mic-menu').click();      // …and the panel is closed again
        expect($('mic-pop').hidden).toBe(true);

        media.grant();                  // the capture lands with nowhere to go
        await settle(6);

        // stopApMeter() is a no-op while apMeter is still null, so without a
        // guard after the await this stream is held with no handle to release it.
        expect(media.tracks[0].stopped).toBe(true);
    });
});

describe('a session that ends with something floating over the app', () => {
    beforeEach(() => { document.documentElement.innerHTML = ''; });

    it('takes the context menu with it', async () => {
        const state = { dead: false };
        const app = await bootRenderer({ board: router(state) });

        $('server-menu').click();
        expect($('ctx-menu').hidden).toBe(false);

        await expireSession(state, app);

        // #ctx-menu is a SIBLING of #app, so hiding #app leaves it drawn over
        // the sign-in form.
        expect($('ctx-menu').hidden).toBe(true);
    });

    it('does not leave the previous account’s conversations in the sidebar', async () => {
        const state = { dead: false };
        const app = await bootRenderer({ board: router(state, [PAIR]) });
        expect($('dm-list').querySelectorAll('.dm-row').length).toBe(1);

        await expireSession(state, app);

        // dmThreads is per-ACCOUNT. Every deliberate sign-out clears it by hand;
        // the two paths that end a session on their own never did, so the next
        // person to sign in on this machine saw a stranger's conversation list
        // until the first fetch replaced it.
        expect($('dm-list').querySelectorAll('.dm-row').length).toBe(0);
    });
});
