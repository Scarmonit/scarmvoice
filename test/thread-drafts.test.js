// @vitest-environment jsdom
//
// The thread panel has its OWN composer. It is a second textarea rather than
// the moved one, so it was never covered by the per-surface drafts in
// composer-drafts.test.js — and nothing cleared it: not closeThread(), not
// openThread(), not switchChannel(), not teardownSession().
//
// Two consequences, one worse than the other:
//
//   • Type a reply in thread A, close the panel, open thread B — B's box is
//     already holding A's text, focused, one Enter from posting under the wrong
//     root.
//   • Sign out and hand the machine over. teardownSession() deliberately clears
//     drafts, the channel cache and the DM list so the next person cannot read
//     the last one's unsent text; the thread composer sat there holding it.
//
// The fix is the same shape as the main composer's: keep it, keyed to the root
// it was written for.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { bootRenderer, settle, $ } from './helpers/renderer.js';

const ME = { id: 1, username: 'Me', role: 'member' };

// Set true to make every board call answer "signed out", which is how the app
// reaches teardownSession() for real rather than through a back door.
const state = { dead: false };

const ROOT_A = {
    id: 11, body: 'first root', name: 'Alice', client_id: 'alice', user_id: 2,
    created_at: 1700000000000, reactions: [], pinned: 0, reply_count: 1
};
const ROOT_B = {
    id: 12, body: 'second root', name: 'Bob', client_id: 'bob', user_id: 3,
    created_at: 1700000001000, reactions: [], pinned: 0, reply_count: 1
};

const board = vi.fn(async (p, opts) => {
    if (state.dead) return { success: false, error: 'unauthorized', needsAuth: true };
    if (p === 'list') {
        return { success: true, posts: [ROOT_A, ROOT_B], typing: [], voice: [], hasMore: false, maxId: 12 };
    }
    if (p === 'thread') {
        const root = (opts && opts.query && opts.query.root) || ROOT_A.id;
        const r = root === ROOT_B.id ? ROOT_B : ROOT_A;
        return { success: true, posts: [r] };
    }
    if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
    if (p === 'presence') return { success: true, members: [] };
    if (p === 'dm/threads') return { success: true, threads: [] };
    return { success: true };
});

// The reply-count chip under a message is the affordance that opens its thread.
const threadChip = (postId) =>
    document.querySelector(`.msg[data-id="${postId}"] .msg-thread`);

async function openThread(postId) {
    threadChip(postId).click();
    await settle();
}

const box = () => $('thread-input');

let app;
beforeAll(async () => {
    app = await bootRenderer({ board, user: ME });
});

describe('an unsent thread reply', () => {
    it('does not follow you into a different thread', async () => {
        await openThread(ROOT_A.id);
        box().value = 'no, that was last Tuesday';

        $('thread-close').click();
        await settle();

        await openThread(ROOT_B.id);
        // This box belongs to root B. Anything in it is one Enter from being
        // posted as a public reply to the wrong message.
        expect(box().value).toBe('');
    });

    it('is handed back when you return to the thread it was written for', async () => {
        $('thread-close').click();
        await settle();

        await openThread(ROOT_A.id);
        expect(box().value).toBe('no, that was last Tuesday');
    });

    it('is gone after the session ends, like every other draft', async () => {
        // Still open, with text in it — the case that matters, since the panel
        // being closed is the one teardown could have got right by accident.
        box().value = 'still typing this';
        await settle();

        // The real route: every board call starts answering "signed out", and a
        // resync is the cheapest way to make one happen on demand.
        state.dead = true;
        app.resync();
        await settle(20);

        expect(box().value).toBe('');
    });
});
