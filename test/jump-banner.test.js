// @vitest-environment jsdom
//
// "You're Viewing Older Messages" — the banner that appears when you have
// scrolled away from the live edge.
//
// It replaced a lone right-hand button. The button said what it would DO but
// never what state you were IN, so a channel you had simply scrolled up in
// looked identical to one with nothing new in it. The banner says the state and
// carries the way out of it.
//
// jsdom does no layout, so scrollHeight/clientHeight are 0 and the app would
// always believe it is at the bottom. The three metrics the decision reads are
// defined directly, which is the honest way to drive it: the assertion is about
// what the app does with those numbers, not about jsdom's layout engine.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { bootRenderer, $, settle } from './helpers/renderer.js';

const NAMES = ['alice', 'bob', 'carla'];

function makePosts(n, fromMe) {
    const base = 1700000000000;
    return Array.from({ length: n }, (_, i) => ({
        id: i + 1,
        client_id: fromMe ? 'me' : 'c' + (i % 3),
        user_id: fromMe ? 1 : (i % 3) + 2,
        name: fromMe ? 'Me' : NAMES[i % 3],
        body: 'message number ' + (i + 1),
        created_at: base + i * 45000,
        pinned: 0, reply_count: 0, reactions: [],
        att_key: '', att_name: '', att_type: '', att_size: 0
    }));
}

const state = { posts: makePosts(30) };

// Pretend the list is taller than its viewport by `away` pixels, then let the
// app react the way it does for a real scroll.
async function scrollAway(away) {
    const box = $('messages');
    Object.defineProperty(box, 'clientHeight', { value: 600, configurable: true });
    Object.defineProperty(box, 'scrollHeight', { value: 600 + away, configurable: true });
    Object.defineProperty(box, 'scrollTop', { value: 0, writable: true, configurable: true });
    box.dispatchEvent(new window.Event('scroll'));
    await settle(4);
}

let app;
const banner = () => $('jump-latest');
const shown = () => banner().classList.contains('show');

beforeAll(async () => {
    const board = vi.fn(async (p) => {
        const key = String(p).split('?')[0];
        if (key === 'list') {
            return { success: true, posts: state.posts, hasMore: false, typing: [], voice: [] };
        }
        if (key === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
        if (key === 'presence') return { success: true, members: [] };
        if (key === 'dm/threads') return { success: true, threads: [] };
        return { success: true };
    });
    app = await bootRenderer({ board });
    await settle(30);
});

describe('the older-messages banner', () => {
    it('says what state you are in, not just what the button does', () => {
        // The copy is the entire reason this replaced a bare button, so it is
        // asserted rather than left to the stylesheet.
        expect(document.querySelector('.jump-label').textContent)
            .toBe("You're Viewing Older Messages");
        expect($('jump-btn').textContent).toBe('Jump To Present');
    });

    it('stays out of the way, and out of the tab order, at the live edge', async () => {
        await scrollAway(0);
        expect(shown()).toBe(false);
        // Hidden from assistive tech too — a banner announcing a state you are
        // not in is worse than no banner.
        expect(banner().getAttribute('aria-hidden')).toBe('true');
    });

    it('appears once you are properly away from the bottom', async () => {
        await scrollAway(1200);
        expect(shown()).toBe(true);
        expect(banner().getAttribute('aria-hidden')).toBe('false');
    });

    it('is not itself clickable — only the button is', async () => {
        await scrollAway(1200);
        expect(shown()).toBe(true);

        // Watch the jump itself, not whether the banner is still up: jsdom's
        // scrollTo is a no-op, so a stray jump leaves the metrics — and so the
        // banner — exactly as they were. Asserting on the banner passes with
        // the listener bound to the whole pill, which is the thing this is
        // supposed to catch.
        const box = $('messages');
        const jumped = vi.fn();
        box.scrollTo = jumped;

        // Clicking the label must do nothing. The banner is a label now, and
        // making the whole pill clickable would mean a stray click while
        // selecting its text threw the reader back to the live edge.
        document.querySelector('.jump-label').click();
        await settle(4);
        expect(jumped, 'clicking the label must not jump').not.toHaveBeenCalled();

        $('jump-btn').click();
        await settle(4);
        expect(jumped, 'the button scrolls to the bottom').toHaveBeenCalled();
    });

    it('counts what you missed, and says what the number means', async () => {
        // The count is "since you were last caught up", so it only means
        // anything for messages that land AFTER you scrolled away. Arriving
        // first, then scrolling, is the case that must read zero — and does,
        // which is why the earlier tests show no badge.
        await scrollAway(1200);
        expect($('jump-count').hidden, 'nothing new yet').toBe(true);

        state.posts = state.posts.concat([
            { id: 101, client_id: 'c1', user_id: 3, name: 'bob', body: 'while you were up there',
              created_at: 1700009000000, pinned: 0, reply_count: 0, reactions: [],
              att_key: '', att_name: '', att_type: '', att_size: 0 },
            { id: 102, client_id: 'c2', user_id: 4, name: 'carla', body: 'and again',
              created_at: 1700009045000, pinned: 0, reply_count: 0, reactions: [],
              att_key: '', att_name: '', att_type: '', att_size: 0 }
        ]);
        app.rt({ t: 'posted', channel: 'general' });
        await settle(30);
        await scrollAway(1200);

        const badge = $('jump-count');
        expect(badge.hidden).toBe(false);
        expect(badge.textContent).toBe('2');
        // Read aloud beside "You're Viewing Older Messages", a bare number is
        // meaningless.
        expect(badge.getAttribute('aria-label')).toBe('2 new messages');
    });
});
