// @vitest-environment jsdom
//
// The pinned-messages panel.
//
// It used to be an inline banner between the header and the conversation: one
// truncated, escaped line per pin, the messages pushed down while it was open,
// and no way to close it but the X. The reference opens a POPOVER off the pin
// button — a titled panel of cards, each with the avatar, the name, the
// timestamp and the whole message, and a Jump button that appears on hover.
//
// What this file pins down is the behaviour that is easy to lose in that move:
// the panel closes the way a popover must, the body goes through the real
// markdown renderer rather than being truncated, and Unpin is still there and
// still gated on who is allowed to use it.
//
// TWO boots for the whole file — one member, one admin — rather than one per
// case. bootRenderer leaves the previous instance's poll timers running, and a
// pile of them re-rendering into one jsdom document is both slow and a source of
// cross-file flakiness; resetting `pins` and the board spy gives each case a
// clean slate without a fresh renderer.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { bootRenderer, $, settle } from './helpers/renderer.js';

const MINE = {
    id: 7, body: 'read this **first**', name: 'Me', client_id: 'me', user_id: 1,
    created_at: 1678068540000, channel: 'general', pinned: 1, reactions: []
};
const THEIRS = {
    id: 8, body: '1. one\n\n2. two\n\n3. three', name: 'Alice', client_id: 'alice', user_id: 2,
    created_at: 1678068600000, channel: 'general', pinned: 1, reactions: []
};

// What /api/board/pins answers with. A case sets this before opening the panel.
let pins = [THEIRS, MINE];

function router() {
    return vi.fn(async (p) => {
        if (p === 'list') {
            return { success: true, posts: [MINE, THEIRS], typing: [], voice: [], hasMore: false, maxId: 8 };
        }
        if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
        if (p === 'presence') return { success: true, members: [] };
        if (p === 'dm/threads') return { success: true, threads: [] };
        if (p === 'pins') return { success: true, channel: 'general', pins };
        return { success: true };
    });
}

const panel = () => $('pinned-panel');
const cards = () => Array.from($('pinned-list').querySelectorAll('.pinned-item'));
const cardFor = (name) => cards().find((c) => c.querySelector('.pinned-name').textContent === name);

async function open() {
    $('btn-pinned').click();
    await settle();
}
// Escape, because there is no close button — see "the shape of it" below.
async function close() {
    while (!panel().hidden) {
        document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await settle();
    }
}

let h;

describe('as a member', () => {
    beforeAll(async () => {
        localStorage.clear();
        h = await bootRenderer({ board: router(), user: { id: 1, username: 'Me', role: 'member' } });
        await settle();
    });

    beforeEach(async () => {
        pins = [THEIRS, MINE];
        h.board.mockClear();
        await close();
    });

    describe('opening and closing', () => {
        it('starts closed and opens from the header pin button', async () => {
            expect(panel().hidden).toBe(true);
            await open();
            expect(panel().hidden).toBe(false);
            expect($('btn-pinned').getAttribute('aria-expanded')).toBe('true');
        });

        it('is titled Pinned Messages, not the channel it was opened over', async () => {
            // The banner's heading was "PINNED IN #GENERAL", which is also why it
            // went stale on a channel switch.
            await open();
            expect($('pinned-title').textContent.replace(/\s+/g, ' ').trim()).toBe('Pinned Messages');
        });

        it('is a floating panel, positioned under the button', async () => {
            await open();
            // jsdom reports no layout, so the anchor arithmetic lands on the
            // clamp. What matters here is that it was POSITIONED at all: an inline
            // banner has no left/top of its own.
            expect(panel().style.top).not.toBe('');
            expect(panel().style.left).not.toBe('');
        });

        it('closes on Escape', async () => {
            await open();
            document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            await settle();
            expect(panel().hidden).toBe(true);
        });

        it('closes on a click outside it', async () => {
            await open();
            $('messages').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
            await settle();
            expect(panel().hidden).toBe(true);
        });

        it('does not close when the click landed inside it', async () => {
            await open();
            cards()[0].dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
            await settle();
            expect(panel().hidden).toBe(false);
        });

        it('toggles shut when the pin button is pressed again', async () => {
            await open();
            await open();
            expect(panel().hidden).toBe(true);
        });
    });

    describe('the shape of it', () => {
        it('has no close button in the header', async () => {
            // The reference has none, and it does not need one: Escape, an outside
            // click, the pin button and a channel switch all close it. An X up here
            // was also the only X in the panel, which made the one on a card read
            // as "close" rather than "unpin".
            await open();
            expect(panel().querySelector('.pinned-head button')).toBe(null);
        });
    });

    describe('the cards', () => {
        it('draws one card per pin, with a face, a name and a stamp', async () => {
            await open();
            expect(cards().length).toBe(2);
            const first = cards()[0];
            expect(first.querySelector('.pinned-name').textContent).toBe('Alice');
            expect(first.querySelector('.pinned-avatar')).toBeTruthy();
            // Date AND time. A pin sits outside any day divider, so a bare clock
            // reading would not say which day it belongs to.
            const stamp = first.querySelector('.pinned-time').textContent;
            expect(stamp).toMatch(/\d{4}/);
            expect(stamp).toMatch(/\d:\d\d/);
        });

        it('renders the full message through the markdown renderer', async () => {
            await open();
            // The banner escaped the body and cut it at 240 characters, so this
            // list would have arrived as literal "1. one 2. two 3. three" text.
            const ol = cardFor('Alice').querySelector('ol.msg-list');
            expect(ol).toBeTruthy();
            expect(ol.children.length).toBe(3);
            expect(cardFor('Me').querySelector('strong').textContent).toBe('first');
        });

        it('offers Jump on every card, ahead of Unpin', async () => {
            await open();
            cards().forEach((c) => expect(c.querySelector('.pinned-jump')).toBeTruthy());
            // Jump first — it is what the panel was opened for. Unpin is the small
            // destructive one, on the outside edge, and it is an X rather than the
            // word: "Unpin" was the widest thing on the card and made Jump look
            // secondary. The label lives in the title and aria-label instead.
            const mine = cardFor('Me');
            const acts = Array.from(mine.querySelectorAll('.pinned-acts > button'))
                .map((b) => b.className);
            expect(acts).toEqual(['pinned-jump', 'pinned-unpin']);
            const unpin = mine.querySelector('.pinned-unpin');
            expect(unpin.textContent.trim()).toBe('');
            expect(unpin.getAttribute('aria-label')).toBe('Unpin this message');
        });

        it('jumps to the message and closes the panel', async () => {
            await open();
            cardFor('Alice').querySelector('.pinned-jump').click();
            await settle();
            expect(panel().hidden).toBe(true);
            expect($('messages').querySelector('.msg[data-id="8"]')).toBeTruthy();
        });

        it('says so when the channel has no pins', async () => {
            pins = [];
            await open();
            expect(cards().length).toBe(0);
            expect($('pinned-list').querySelector('.pinned-empty').textContent)
                .toContain('No pinned messages');
        });
    });

    describe('unpinning', () => {
        it('offers Unpin on your own pin and calls the endpoint', async () => {
            await open();
            const btn = cardFor('Me').querySelector('.pinned-unpin');
            expect(btn, 'a member must still be able to unpin their own message').toBeTruthy();

            btn.click();
            await settle();
            expect(h.board).toHaveBeenCalledWith('pin', expect.objectContaining({
                method: 'POST',
                body: expect.objectContaining({ id: 7, pinned: false })
            }));
        });

        it('does not offer Unpin on somebody else\'s pin to a member', async () => {
            // Pinning and unpinning somebody else's message is admin-and-above,
            // enforced server-side; offering the button only produced a 403.
            await open();
            expect(cardFor('Alice').querySelector('.pinned-unpin')).toBe(null);
        });
    });
});

describe('as an admin', () => {
    it('may unpin anybody', async () => {
        pins = [THEIRS, MINE];
        h = await bootRenderer({ board: router(), user: { id: 1, username: 'Me', role: 'admin' } });
        await settle();
        await open();
        cards().forEach((c) => expect(
            c.querySelector('.pinned-unpin'),
            c.querySelector('.pinned-name').textContent
        ).toBeTruthy());
    });
});
