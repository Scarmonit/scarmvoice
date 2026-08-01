// @vitest-environment jsdom
//
// Three things the renderer decides once, at the edges of a session, where
// nothing polls afterwards to correct them:
//
//   • The microphone gain. It is applied before the track is published, so it
//     is how loud the ROOM hears you — and only saveSettings ever pushed it, so
//     a launch in which nothing happened to be saved ran the whole session at
//     100% however the slider was set.
//   • Entering direct messages with no conversation to open. Neither openDm()
//     nor closeDm() runs on that path, and they were the only two things that
//     ever painted the column, so it came up blank.
//   • Leaving. closeDm() ends the conversation but not the PLACE, so a sign-out
//     from inside DMs left dmMode set and the next sign-in came up with the
//     channel sidebar hidden behind a torn-down conversation.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { bootRenderer, $, settle } from './helpers/renderer.js';

const ME = { id: 1, username: 'Me', role: 'member' };
const THEM = { id: 2, username: 'Alice', role: 'member' };
const PAIR = { id: 40, title: 'Alice', isGroup: false, user: THEM, members: [ME, THEM], unread: 0 };

function router(threads) {
    return vi.fn(async (p, opts) => {
        if (p === 'dm/threads') return { success: true, threads };
        if (p === 'dm/list') {
            return { success: true, thread: PAIR, messages: [] };
        }
        if (p === 'list') return { success: true, posts: [], typing: [], voice: [], hasMore: false };
        if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
        if (p === 'presence') return { success: true, members: [] };
        return { success: true };
    });
}

describe('the saved microphone gain', () => {
    it('reaches the mic graph on boot, not only when a setting is next written', async () => {
        await bootRenderer({ board: router([]), settings: { micVolume: 0.4 } });
        // 0.4, not 1: this is the level everyone else hears, and until it is
        // pushed the graph multiplies by one whatever the stored value says.
        expect(window.ScarmMic.getGain()).toBeCloseTo(0.4, 5);
    });

    it('still follows the slider afterwards', async () => {
        await bootRenderer({ board: router([]), settings: { micVolume: 0.4 } });
        const slider = $('set-invol');
        slider.value = '150';
        slider.dispatchEvent(new window.Event('input', { bubbles: true }));
        await settle(4);
        expect(window.ScarmMic.getGain()).toBeCloseTo(1.5, 5);
    });
});

describe('the direct-messages place', () => {
    beforeEach(() => { document.documentElement.innerHTML = ''; });

    it('says so when there is nothing to open', async () => {
        await bootRenderer({ board: router([]) });
        $('rail-dms').click();
        await settle();

        expect($('dm-panel').hidden).toBe(false);
        // The empty state the app already has, on the one path that never
        // reached it. A blank column is what shipped instead.
        const empty = $('dm-messages').querySelector('.dm-nothing');
        expect(empty).not.toBeNull();
        expect(empty.textContent).toMatch(/No conversations yet/i);
        expect($('dm-title').textContent).toBe('Direct Messages');
    });

    it('drops the empty state again once a conversation is opened', async () => {
        await bootRenderer({ board: router([PAIR]) });
        $('rail-dms').click();
        await settle();
        expect($('dm-panel').classList.contains('empty')).toBe(false);
        expect($('dm-messages').querySelector('.dm-nothing')).toBeNull();
    });

    it('is left behind by a sign-out, so the next session starts in the server', async () => {
        await bootRenderer({ board: router([PAIR]) });
        $('rail-dms').click();
        await settle();
        expect($('sidebar').hidden).toBe(true);          // in DMs

        // The account-only sign-out, from the panel over your own name — Settings'
        // copy of it is gone, and this is where it reads as what it is.
        $('mep-switch').click();
        await settle();

        // The channel sidebar is reachable again without hunting for the way
        // back, and the DM column is not sitting over a signed-out app.
        expect($('sidebar').hidden).toBe(false);
        expect($('dm-sidebar').hidden).toBe(true);
        expect($('dm-panel').hidden).toBe(true);
        expect($('rail-home').classList.contains('active')).toBe(true);
        expect($('rail-dms').classList.contains('active')).toBe(false);
    });
});
