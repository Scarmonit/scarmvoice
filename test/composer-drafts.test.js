// @vitest-environment jsdom
//
// There is ONE composer. It is moved between #main and the conversation drawer
// rather than duplicated, which is what keeps every listener, sub-control and
// pixel of it identical in both places — and is also what made it dangerous:
// the element carries its value, its staged files and its reply chip with it.
//
// So a half-typed message written for #general was still sitting in the box
// after clicking through to a conversation, and the next Enter sent it to
// whoever was on the other end. A file attached but not yet sent went the same
// way, into a private conversation it was never meant for. moveComposer()'s own
// comment said it prevented exactly this; the only thing it actually cleared
// was the reply chip, which is the one of the three that cannot misdeliver
// anything (a DM send carries no quote).
//
// The fix is not to throw the draft away — this file loses typed text nowhere
// else, and it should not start here. Each surface keeps its own and gets it
// back on return.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { bootRenderer, settle, type, $, composerInput } from './helpers/renderer.js';

const ME = { id: 1, username: 'Me', role: 'member' };
const ALICE = { id: 2, username: 'Alice', role: 'member' };
const BOB = { id: 3, username: 'Bob', role: 'member' };

const T_ALICE = { id: 40, title: 'Alice', isGroup: false, user: ALICE, members: [ME, ALICE], unread: 0 };
const T_BOB = { id: 41, title: 'Bob', isGroup: false, user: BOB, members: [ME, BOB], unread: 0 };

const POST = {
    id: 7, body: 'hello', name: 'Alice', client_id: 'alice', user_id: ALICE.id,
    created_at: 1700000000000, reactions: [], pinned: 0
};

const board = vi.fn(async (p) => {
    if (p === 'dm/threads') return { success: true, threads: [T_ALICE, T_BOB] };
    if (p === 'dm/list') return { success: true, thread: T_ALICE, messages: [] };
    if (p === 'list') {
        return { success: true, posts: [POST], typing: [], voice: [], hasMore: false, maxId: 7 };
    }
    if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
    if (p === 'presence') return { success: true, members: [] };
    return { success: true };
});

const rowFor = (username) =>
    Array.from($('dm-list').querySelectorAll('.dm-row'))
        .find((b) => b.textContent.includes(username));

async function openConversation(username) {
    rowFor(username).click();
    await settle();
}

async function backToChannel() {
    // The SERVER MARK is the way out of the DM place. The DM button used to
    // double as one, which is the toggle behaviour that was removed: a
    // destination that throws you somewhere else when pressed twice.
    $('rail-home').click();
    await settle();
}

beforeAll(async () => {
    await bootRenderer({ board, user: ME });
});

describe('a draft written for a channel', () => {
    it('does not follow the composer into a conversation', async () => {
        type('private note for #general');
        await settle();

        await openConversation('Alice');

        // The box the user is now looking at belongs to Alice. Anything left in
        // it is one keystroke away from being sent to her.
        expect(composerInput().value).toBe('');
        expect(composerInput().placeholder).toBe('Message @Alice');
    });

    it('is handed back on the way out, rather than thrown away', async () => {
        await backToChannel();
        expect(composerInput().value).toBe('private note for #general');
        expect(composerInput().placeholder).toBe('Message #general');
    });
});

describe('a draft written for a conversation', () => {
    it('stays with that conversation and does not reach the channel', async () => {
        await openConversation('Alice');
        expect(composerInput().value).toBe('');
        type('for alice only');
        await settle();

        await backToChannel();
        // The channel's own draft is what comes back — not Alice's.
        expect(composerInput().value).toBe('private note for #general');

        await openConversation('Alice');
        expect(composerInput().value).toBe('for alice only');
    });

    it('does not reach a DIFFERENT conversation either', async () => {
        // Keyed per thread, not per surface-kind: typing to Alice and then
        // clicking Bob is the same misdelivery, one row apart in the sidebar.
        await openConversation('Bob');
        expect(composerInput().value).toBe('');

        await openConversation('Alice');
        expect(composerInput().value).toBe('for alice only');
    });
});

describe('a staged attachment', () => {
    it('does not follow the composer into a conversation', async () => {
        await backToChannel();
        // Every staging entry point (button, drop, paste) funnels through the
        // same array; the picker is the one that can be driven from here.
        const input = $('file-input');
        Object.defineProperty(input, 'files', {
            configurable: true,
            value: [{ name: 'budget.pdf', type: 'application/pdf', size: 1234 }]
        });
        input.dispatchEvent(new window.Event('change', { bubbles: true }));
        await settle();
        expect($('upload-list').querySelectorAll('.stage-card').length).toBe(1);

        await openConversation('Bob');
        // Bob's composer must not be holding a file picked for #general.
        expect($('upload-list').querySelectorAll('.stage-card').length).toBe(0);
        expect($('btn-send').disabled).toBe(true);

        await backToChannel();
        expect($('upload-list').querySelectorAll('.stage-card').length).toBe(1);
    });
});

describe('signing out', () => {
    it('does not leave stashed drafts behind for the next account', async () => {
        // Thread ids are global rather than per-account, so a draft stashed
        // under `dm:40` would be waiting inside whatever conversation happened
        // to carry that number for whoever signs in next.
        //
        // Deliberately NOT re-booting the renderer between the two sessions:
        // a fresh boot builds a fresh stash whatever teardown did, so it would
        // pass with the clearing removed and prove nothing. This signs out and
        // back in through the login card, inside the one closure — which is
        // what actually happens on the machine.
        await openConversation('Alice');
        type('still unsent');
        await settle();

        $('btn-logout').click();
        await settle();
        expect($('login').hidden).toBe(false);

        $('login-pw').value = 'hunter2';
        $('login-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
        await settle(20);
        expect($('app').hidden).toBe(false);

        await openConversation('Alice');
        expect(composerInput().value).toBe('');
    });
});
