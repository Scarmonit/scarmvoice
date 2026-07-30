// @vitest-environment jsdom
//
// The new-messages bar: "12 new messages since 12:38 AM on March 21, 2026",
// with Mark As Read on the right.
//
// The tracking it runs on already existed — `reads`, the per-channel map of
// "newest post id I have seen", kept per account in localStorage and posted to
// /api/board/channels to compute the sidebar's unread badges. What did not exist
// was that value at a moment when it is still useful: loadMessagesOnce stamps
// `reads[channel] = maxId` on every load of the channel on screen, which is
// right for the badge and destroys the record of where the reader had got to.
//
// So the watermark is captured on the way IN — at launch after the channel list
// lands, and on every channel switch — and held for the visit. That capture is
// what these cases are really about, because it is invisible when it breaks: the
// badge still clears, and the bar simply never appears.
//
// ONE boot per describe, not per case: bootRenderer leaves poll timers running.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { bootRenderer, $, settle, type } from './helpers/renderer.js';

// 2026-03-21T00:38 local, so the label's own date arithmetic is exercised rather
// than asserted against a hard-coded string in another timezone.
const SINCE = new Date(2026, 2, 21, 0, 38).getTime();

function post(id, over) {
    return Object.assign({
        id, body: 'message ' + id, name: 'Alice', client_id: 'alice', user_id: 2,
        created_at: SINCE + (id - 10) * 60000, channel: 'general', pinned: 0, reactions: []
    }, over || {});
}

// Twelve from Alice, ids 10..21 — the shape of the reference screenshot.
const FRESH = Array.from({ length: 12 }, (_, i) => post(10 + i));

function router(opts) {
    const o = opts || {};
    return vi.fn(async (p, req) => {
        if (p === 'list') {
            return {
                success: true, posts: o.posts || FRESH, typing: [], voice: [],
                hasMore: false, maxId: 21
            };
        }
        if (p === 'channels') {
            return {
                success: true,
                channels: [
                    { name: 'general', unread: o.unread === undefined ? 12 : o.unread, maxId: 21 },
                    { name: 'random', unread: 0, maxId: 0 }
                ]
            };
        }
        if (p === 'presence') return { success: true, members: [] };
        if (p === 'dm/threads') return { success: true, threads: [] };
        if (p === 'pins') return { success: true, pins: [] };
        return { success: true };
    });
}

const bar = () => $('unread-bar');
const label = () => $('unread-text').textContent;

// The watermark a previous session left behind: caught up to id 9, so 10..21 are
// new. Written under the account id the renderer signs in as.
function seedReads(value) {
    localStorage.clear();
    localStorage.setItem('lounge_reads:1', JSON.stringify(value));
}

const USER = { id: 1, username: 'Me', role: 'member' };

describe('coming back to a channel with unread messages', () => {
    let h;
    beforeAll(async () => {
        seedReads({ general: 9 });
        h = await bootRenderer({ board: router(), user: USER });
        await settle();
    });

    it('raises the bar', () => {
        expect(bar().hidden).toBe(false);
    });

    it('says how many, and when the reader left off', () => {
        // The reference's exact wording, and the timestamp of the FIRST message
        // they have not read.
        expect(label()).toMatch(/^12 new messages since /);
        expect(label()).toContain(' on ');
        expect(label()).toContain('March 21, 2026');
        expect(label()).toMatch(/\d{1,2}:\d\d/);
    });

    it('offers Mark As Read', () => {
        expect($('unread-read')).toBeTruthy();
        expect($('unread-read').textContent).toContain('Mark As Read');
    });

    it('sits over the top of the conversation rather than in it', () => {
        // Inside the message column, so it spans exactly that column — and before
        // #messages, which is what puts it at the top.
        expect(bar().parentElement.id).toBe('messages-wrap');
        expect(bar().nextElementSibling.id).toBe('messages');
    });
});

describe('Mark As Read', () => {
    let h;
    beforeAll(async () => {
        seedReads({ general: 9 });
        h = await bootRenderer({ board: router(), user: USER });
        await settle();
    });

    it('takes the bar down and stamps the watermark at the newest message', async () => {
        expect(bar().hidden).toBe(false);
        $('unread-read').click();
        await settle();

        expect(bar().hidden).toBe(true);
        expect(JSON.parse(localStorage.getItem('lounge_reads:1')).general).toBe(21);
    });

    it('clears the channel badge with it', async () => {
        const badge = document.querySelector('.chan[data-channel="general"] .unread');
        expect(badge).toBeNull();
    });
});

describe('a channel that was already read', () => {
    let h;
    beforeAll(async () => {
        // Caught up to the newest message, and the server agrees.
        seedReads({ general: 21 });
        h = await bootRenderer({ board: router({ unread: 0 }), user: USER });
        await settle();
    });

    it('shows no bar', () => {
        expect(bar().hidden).toBe(true);
    });
});

describe('what does not count as unread', () => {
    it('ignores the reader\'s own messages', async () => {
        seedReads({ general: 9 });
        // Everything after the watermark is mine, so there is nothing new to read.
        const mine = FRESH.map((p) => Object.assign({}, p, {
            name: 'Me', client_id: 'me', user_id: 1
        }));
        await bootRenderer({ board: router({ posts: mine, unread: 0 }), user: USER });
        await settle();
        expect(bar().hidden).toBe(true);
    });

    it('comes down when the reader posts into the channel', async () => {
        seedReads({ general: 9 });
        const h = await bootRenderer({ board: router(), user: USER });
        await settle();
        expect(bar().hidden).toBe(false);

        // Writing into a channel is as clear a statement of "I have read this" as
        // pressing the button.
        h.board.mockImplementation(async (p) => {
            if (p === 'post') return { success: true, id: 22 };
            if (p === 'list') return { success: true, posts: FRESH, typing: [], voice: [], hasMore: false, maxId: 21 };
            if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
            return { success: true };
        });
        type('caught up');
        $('composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
        await settle(20);

        expect(bar().hidden).toBe(true);
    });
});

describe('the count', () => {
    it('prefers the server\'s number when the loaded page cannot see them all', async () => {
        // One page holds 12; the channel really has 40 unread behind it. The bar
        // has to say 40 — the loaded page is a window, not the total.
        seedReads({ general: 9 });
        await bootRenderer({ board: router({ unread: 40 }), user: USER });
        await settle();
        expect(label()).toMatch(/^40 new messages since /);
    });

    it('says "1 new message", singular', async () => {
        seedReads({ general: 20 });
        await bootRenderer({ board: router({ unread: 1 }), user: USER });
        await settle();
        expect(label()).toMatch(/^1 new message since /);
    });
});
