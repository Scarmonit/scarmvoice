// @vitest-environment jsdom
//
// "Message this person", from the two places you actually look at somebody: a
// message they wrote, and their row in the members list.
//
// The rule that matters in both is that a DM is addressed to an ACCOUNT. A
// client_id is published with every message, so acting on one would let anybody
// name anybody — and a message written before accounts existed carries no
// author at all. Neither surface may offer the action when it cannot resolve a
// user id, because the server would (correctly) refuse it and the user would
// have clicked something that did nothing.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { bootRenderer, settle, $ } from './helpers/renderer.js';

const ME = { id: 1, username: 'Me', role: 'member' };
const ALICE = { id: 2, username: 'Alice', role: 'member' };

// Hers, mine, and one from before accounts existed (no user_id at all).
const HERS = {
    id: 7, body: 'hello', name: 'Alice', client_id: 'alice', user_id: ALICE.id,
    created_at: 1700000000000, reactions: [], pinned: 0
};
const MINE = {
    id: 8, body: 'hi back', name: 'Me', client_id: 'me', user_id: ME.id,
    created_at: 1700000060000, reactions: [], pinned: 0
};
const LEGACY = {
    id: 9, body: 'from before accounts', name: 'Ghost', client_id: 'ghost', user_id: null,
    created_at: 1700000120000, reactions: [], pinned: 0
};

const THREAD = { id: 40, title: 'Alice', isGroup: false, user: ALICE, members: [ME, ALICE], unread: 0 };

function router(extra) {
    return vi.fn(async (p, opts) => {
        if (p === 'list') {
            return {
                success: true, posts: [HERS, MINE, LEGACY],
                typing: [], voice: [], hasMore: false, maxId: 9
            };
        }
        if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
        if (p === 'presence') {
            return {
                success: true,
                members: [{ client_id: 'alice', user_id: ALICE.id, name: 'Alice', status: 'online', custom: '' }]
            };
        }
        if (p === 'dm/threads') return { success: true, threads: [] };
        if (p === 'dm/list') return { success: true, thread: THREAD, messages: [] };
        if (p === 'dm/create') return { success: true, thread: THREAD };
        if (p === 'account/users') return { success: true, users: [ME, ALICE] };
        return (extra && extra(p, opts)) || { success: true };
    });
}

const rightClick = (el) =>
    el.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));

const menuLabels = () =>
    Array.from($('ctx-menu').querySelectorAll('.ctx-label')).map((s) => s.textContent);

const rowFor = (id) => document.querySelector(`#messages .msg[data-id="${id}"]`);

const clickMenuItem = (label) => {
    const btn = Array.from($('ctx-menu').querySelectorAll('button'))
        .find((b) => b.textContent.includes(label));
    if (!btn) throw new Error('no menu item matching ' + JSON.stringify(label));
    btn.click();
};

beforeEach(() => { document.documentElement.innerHTML = ''; });

describe('the message right-click menu', () => {
    it('offers to message the person who wrote it', async () => {
        await bootRenderer({ board: router(), user: ME });
        rightClick(rowFor(HERS.id));
        expect(menuLabels()).toContain('Message Alice');
    });

    it('does not offer it on your own message', async () => {
        await bootRenderer({ board: router(), user: ME });
        rightClick(rowFor(MINE.id));
        // …and still offers the things that ARE about your own message, so this
        // is a targeted absence rather than an empty menu.
        expect(menuLabels()).toContain('Edit message');
        expect(menuLabels().some((l) => l.startsWith('Message '))).toBe(false);
    });

    it('does not offer it on a message with no account behind it', async () => {
        await bootRenderer({ board: router(), user: ME });
        rightClick(rowFor(LEGACY.id));
        expect(menuLabels().some((l) => l.startsWith('Message '))).toBe(false);
        // Block is keyed by install id, which this row DOES have — so the two
        // person actions are gated separately, not together.
        expect(menuLabels()).toContain('Block Ghost');
    });

    it('opens the conversation with that account, and no other', async () => {
        const app = await bootRenderer({ board: router(), user: ME });
        rightClick(rowFor(HERS.id));
        clickMenuItem('Message Alice');
        await settle(20);

        const create = app.board.mock.calls.find((c) => c[0] === 'dm/create');
        expect(create).toBeTruthy();
        // By account id. Never the client_id, which the listing publishes.
        expect(create[1].body).toEqual({ users: [ALICE.id] });
        // And it actually lands in the conversation rather than merely creating it.
        expect($('dm-panel').hidden).toBe(false);
        expect($('dm-title').textContent).toBe('Alice');
    });

    it('does not open a second conversation when the item is double-clicked', async () => {
        const app = await bootRenderer({ board: router(), user: ME });
        rightClick(rowFor(HERS.id));
        const btn = Array.from($('ctx-menu').querySelectorAll('button'))
            .find((b) => b.textContent.includes('Message Alice'));
        btn.click();
        btn.click();
        await settle(20);

        const creates = app.board.mock.calls.filter((c) => c[0] === 'dm/create');
        expect(creates).toHaveLength(1);
    });
});

describe('the member popover', () => {
    // The row under "Online" in the members sidebar.
    const memberRow = (name) =>
        Array.from(document.querySelectorAll('#members-list .vp'))
            .find((li) => li.textContent.includes(name));

    it('offers to message someone else', async () => {
        await bootRenderer({ board: router(), user: ME });
        await settle();
        memberRow('Alice').click();
        await settle();

        expect($('pop-dm').hidden).toBe(false);
        expect($('pop-dm-label').textContent).toBe('Message Alice');
    });

    it('starts the conversation with the account the row resolves to', async () => {
        const app = await bootRenderer({ board: router(), user: ME });
        await settle();
        memberRow('Alice').click();
        await settle();
        $('pop-dm').click();
        await settle(20);

        const create = app.board.mock.calls.find((c) => c[0] === 'dm/create');
        expect(create[1].body).toEqual({ users: [ALICE.id] });
        expect($('popover').hidden).toBe(true);
        expect($('dm-title').textContent).toBe('Alice');
    });
});
