// @vitest-environment jsdom
//
// An unsent thread reply must not cross between a channel and a conversation.
//
// thread-drafts.test.js established the rule: text left in the thread composer
// is kept, keyed to the root it was written for, and handed back only there.
// The key was the root's ID — and a thread root is a row in one of TWO tables.
// A channel thread's root comes from `posts`, a conversation's from
// `dm_messages`, and those are independent sequences that both start at 1. (The
// app already knows this: graft() keys its lookup by isDm for exactly this
// reason, and dm-view.test.js deliberately fixtures a DM and a post that share
// id 501.)
//
// So with the bare id as the key, a reply typed in channel thread #501 was
// restored into the composer of DM thread #501: somebody else's private
// conversation, pre-filled with words written for a public channel, focused, one
// Enter from sending them there. The reverse leaks the other way — a private
// draft into a channel.
//
// The fix is to key drafts by the surface, which is the conversation AND the
// root, never the root alone.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { bootRenderer, settle, $ } from './helpers/renderer.js';

const ME = { id: 1, username: 'Me', role: 'member' };
const THEM = { id: 2, username: 'Alice', role: 'member' };

const PAIR = { id: 40, title: 'Alice', isGroup: false, user: THEM, members: [ME, THEM], unread: 0 };

// THE COLLISION, on purpose: a post and a DM that share an id. Both carry a
// reply, so both render the chip that opens their thread.
const COLLIDING_ID = 501;

const POST = {
    id: COLLIDING_ID, body: 'the channel root', name: 'Alice', client_id: 'alice',
    user_id: THEM.id, created_at: 1700000000000, reactions: [], pinned: 0, reply_count: 1
};

const DM = {
    id: COLLIDING_ID, from: THEM.id, body: 'the private root',
    created_at: 1700000000000, reply_count: 1
};

const board = vi.fn(async (p, opts) => {
    if (p === 'list') {
        return { success: true, posts: [POST], typing: [], voice: [], hasMore: false, maxId: COLLIDING_ID };
    }
    if (p === 'thread') return { success: true, posts: [POST] };
    if (p === 'dm/threads') return { success: true, threads: [PAIR] };
    if (p === 'dm/list') return { success: true, thread: PAIR, messages: [DM] };
    // A conversation's thread is dm/replies, not dm/thread — see the note on
    // loadThread(). Answering the wrong name returns no posts, which openThread
    // reads as "the root was deleted" and closes the drawer again, so a spec
    // wired to the wrong endpoint asserts against a panel that never opened.
    if (p === 'dm/replies') return { success: true, posts: [DM] };
    if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
    if (p === 'presence') return { success: true, members: [] };
    return { success: true };
});

const box = () => $('thread-input');
const chipIn = (listId) =>
    $(listId).querySelector(`.msg[data-id="${COLLIDING_ID}"] .msg-thread`);

async function closePanel() {
    $('thread-close').click();
    await settle();
}

// Open the CHANNEL thread rooted at the colliding id.
async function openChannelThread() {
    if (!$('dm-panel').hidden) { $('dm-close').click(); await settle(); }
    const chip = chipIn('messages');
    expect(chip, 'the channel root did not render a thread chip').toBeTruthy();
    chip.click();
    await settle();
    // Asserted, not assumed: a drawer that failed to open has an empty composer
    // for reasons that have nothing to do with drafts, and every expectation
    // below would pass without testing anything.
    expect($('thread-panel').hidden, 'the channel thread did not open').toBe(false);
}

// Open the CONVERSATION thread rooted at the same id.
async function openDmThread() {
    // Keyed off the ROW being on screen, not #dm-panel's hidden flag. Opening a
    // channel thread calls closeDm(), which empties the conversation column but
    // can leave the panel itself flagged open — so `hidden` says the
    // conversation is up while the message it is asked about is gone.
    if (!chipIn('dm-messages')) {
        const row = $('dm-list').querySelector('.dm-row');
        expect(row, 'no conversation to open').toBeTruthy();
        row.click();
        // Longer than the default: opening a conversation is a dm/threads and a
        // dm/list round trip before anything renders.
        await settle(30);
    }
    const chip = chipIn('dm-messages');
    expect(chip, 'the DM root did not render a thread chip').toBeTruthy();
    chip.click();
    await settle();
    expect($('thread-panel').hidden, 'the conversation thread did not open').toBe(false);
}

beforeAll(async () => {
    await bootRenderer({ board, user: ME });
});

describe('a draft in a thread whose id exists in both tables', () => {
    it('does not surface in the conversation that shares its number', async () => {
        await openChannelThread();
        box().value = 'this was meant for the channel';
        await closePanel();

        await openDmThread();
        // Whatever is in this box is one Enter from being sent to Alice.
        expect(box().value).toBe('');
    });

    it('is still handed back to the thread it was written for', async () => {
        // The other half of the contract — a key that never collides would also
        // be satisfied by throwing every draft away.
        await closePanel();
        await openChannelThread();
        expect(box().value).toBe('this was meant for the channel');
    });

    it('does not leak the other way either', async () => {
        await closePanel();
        await openDmThread();
        box().value = 'this was private';
        await closePanel();

        await openChannelThread();
        expect(box().value).toBe('this was meant for the channel');

        await closePanel();
        await openDmThread();
        expect(box().value).toBe('this was private');
    });
});
