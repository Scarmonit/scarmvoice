// @vitest-environment jsdom
//
// CLEAR CHANNEL — every message in a channel, deleted for everybody, forever.
//
// Three things have to hold for a destructive action, and all three are pinned
// here because each of them is a different kind of accident:
//
//   • It is OFFERED to the owner and to nobody else. The menu check is not what
//     makes it safe — the server rejects a clear from anyone without the
//     `channel.clear` capability (functions/api/board/_accounts.js, and
//     _roles.test.mjs over there pins the table) — but an admin who is shown a
//     button that 403s has been told something untrue about their own board.
//   • NOTHING IS SENT until the confirmation is accepted. A destructive action
//     that fires on the click and asks afterwards is not confirmed at all.
//   • Cancelling sends nothing, ever.
//
// #general is deliberately allowed, unlike Delete channel: it is the one that
// cannot be deleted and the one that fills up with junk, so it is the whole
// reason this exists.
import { describe, it, expect, vi } from 'vitest';
import { bootRenderer, settle, $ } from './helpers/renderer.js';

const OWNER = { id: 1, username: 'Me', role: 'owner' };
const ADMIN = { id: 1, username: 'Me', role: 'admin' };
const MEMBER = { id: 1, username: 'Me', role: 'member' };

const POSTS = [
    { id: 11, body: 'junk', name: 'Alice', client_id: 'alice', user_id: 2, created_at: 1, reactions: [], pinned: 0 },
    { id: 12, body: 'more junk', name: 'Bob', client_id: 'bob', user_id: 3, created_at: 2, reactions: [], pinned: 0 }
];

const router = () => vi.fn(async (route, opts) => {
    const p = String(route).split('?')[0];
    if (p === 'list') return { success: true, posts: POSTS, typing: [], voice: [], hasMore: false, maxId: 12 };
    if (p === 'channels') {
        // The clear comes back through the same endpoint the listing does.
        if (opts && opts.body && opts.body.clear) {
            return {
                success: true,
                channels: [{ name: 'general', unread: 0 }, { name: 'random', unread: 0 }],
                cleared: { channel: opts.body.clear, deleted: 2 }
            };
        }
        return { success: true, channels: [{ name: 'general', unread: 0 }, { name: 'random', unread: 0 }] };
    }
    if (p === 'presence') return { success: true, members: [] };
    if (p === 'dm/threads') return { success: true, threads: [] };
    return { success: true };
});

const menuLabels = () =>
    Array.from($('ctx-menu').querySelectorAll('.ctx-label')).map((s) => s.textContent);

// Right-click the channel row, which is what opens the channel's options.
async function openChannelMenu(name) {
    const row = Array.from(document.querySelectorAll('#channel-list .chan'))
        .find((b) => b.dataset.channel === name);
    expect(row, 'no channel row for ' + name).toBeTruthy();
    row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
    await settle(2);
}

function clickMenuItem(label) {
    const item = Array.from($('ctx-menu').querySelectorAll('.ctx-item'))
        .find((el) => el.textContent.trim() === label);
    expect(item, 'no menu item labelled ' + label).toBeTruthy();
    item.click();
}

const clearCalls = (board) =>
    board.mock.calls.filter((c) => c[0] === 'channels' && c[1] && c[1].body && c[1].body.clear);

describe('who is offered Clear all messages', () => {
    it('the owner is', async () => {
        await bootRenderer({ user: OWNER, board: router() });
        await openChannelMenu('general');
        expect(menuLabels()).toContain('Clear all messages');
    });

    it('an admin is not — clearing a whole channel is the owner\'s', async () => {
        await bootRenderer({ user: ADMIN, board: router() });
        await openChannelMenu('general');
        const labels = menuLabels();
        expect(labels).not.toContain('Clear all messages');
        // …while the admin powers they DO have are still there.
        expect(labels).toContain('Rename channel');
    });

    it('a member is not', async () => {
        await bootRenderer({ user: MEMBER, board: router() });
        await openChannelMenu('general');
        expect(menuLabels()).not.toContain('Clear all messages');
    });

    it('is offered on #general, which cannot be deleted', async () => {
        // Delete channel is disabled there; clearing it is the point.
        await bootRenderer({ user: OWNER, board: router() });
        await openChannelMenu('general');
        const items = Array.from($('ctx-menu').querySelectorAll('.ctx-item'));
        const clear = items.find((el) => el.textContent.trim() === 'Clear all messages');
        const del = items.find((el) => el.textContent.trim() === 'Delete channel');
        expect(clear.hasAttribute('disabled') || clear.classList.contains('disabled')).toBe(false);
        expect(del.hasAttribute('disabled') || del.classList.contains('disabled')).toBe(true);
    });
});

describe('clearing a channel', () => {
    it('sends nothing until the confirmation is accepted', async () => {
        const board = router();
        await bootRenderer({ user: OWNER, board });
        await openChannelMenu('general');

        board.mockClear();
        clickMenuItem('Clear all messages');
        await settle(4);

        // The dialog is up and NOTHING has been asked of the server yet.
        expect($('dialog').hidden).toBe(false);
        expect(clearCalls(board)).toHaveLength(0);
    });

    it('says what it will do, to whom, and that it cannot be undone', async () => {
        await bootRenderer({ user: OWNER, board: router() });
        await openChannelMenu('general');
        clickMenuItem('Clear all messages');
        await settle(4);

        const text = $('dialog').textContent;
        expect(text).toContain('#general');
        expect(text).toMatch(/EVERYONE/);
        expect(text).toMatch(/cannot be undone/i);
    });

    it('clears on confirm, naming the channel it was asked about', async () => {
        const board = router();
        await bootRenderer({ user: OWNER, board });
        await openChannelMenu('general');
        clickMenuItem('Clear all messages');
        await settle(4);

        board.mockClear();
        $('dialog-ok').click();
        await settle(6);

        const calls = clearCalls(board);
        expect(calls).toHaveLength(1);
        expect(calls[0][1].body.clear).toBe('general');
        expect(calls[0][1].method).toBe('POST');
    });

    it('sends nothing at all when the confirmation is cancelled', async () => {
        const board = router();
        await bootRenderer({ user: OWNER, board });
        await openChannelMenu('general');
        clickMenuItem('Clear all messages');
        await settle(4);

        board.mockClear();
        $('dialog-cancel').click();
        await settle(6);

        expect(clearCalls(board)).toHaveLength(0);
    });

    it('stops painting the messages it just deleted', async () => {
        const board = router();
        await bootRenderer({ user: OWNER, board });
        expect($('messages').querySelectorAll('.msg').length).toBeGreaterThan(0);

        await openChannelMenu('general');
        clickMenuItem('Clear all messages');
        await settle(4);
        // The channel is empty from here on.
        board.mockImplementation(async (route) => {
            const p = String(route).split('?')[0];
            if (p === 'list') return { success: true, posts: [], typing: [], voice: [], hasMore: false, maxId: 0 };
            if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
            if (p === 'presence') return { success: true, members: [] };
            if (p === 'dm/threads') return { success: true, threads: [] };
            return { success: true };
        });
        $('dialog-ok').click();
        await settle(8);

        expect($('messages').querySelectorAll('.msg').length).toBe(0);
    });
});
