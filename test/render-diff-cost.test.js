// @vitest-environment jsdom
//
// The message list is diffed against the DOM by key, and the point of that is
// that a render costs work proportional to what CHANGED, not to what is on
// screen. This pins that property, because it is invisible when it breaks: the
// list still ends up correct, it just gets there by re-seating every row.
//
// It broke exactly once, and silently. The walk holds a cursor into the existing
// children and only advances it when it lands on the node it wanted — so one
// node left in its path that is NOT in the new list (a deleted message, a row
// trimmed off the front of a channel you had scrolled back through) stopped it
// advancing at all, and every row after it was `insertBefore`d past the
// obstruction. Measured in Chromium: 400 moves and 26ms of forced layout, where
// the change itself was a single removal. A dropped frame, every time, for
// nothing.
//
// The assertion is on DOM MUTATIONS rather than wall-clock: a timing threshold
// is a flake on a busy machine, and the mutation count is the thing that
// actually causes the jank.
//
// ONE boot for the whole file, deliberately. bootRenderer leaves the previous
// instance's poll timers running, and they re-render into the same #messages —
// which shows up here as phantom mutations that belong to nobody.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { bootRenderer, $, settle } from './helpers/renderer.js';

const NAMES = ['alice', 'bob', 'carla', 'dev', 'erin'];
const N = 60;

function makePosts(n) {
    const base = Date.now() - n * 45_000;
    return Array.from({ length: n }, (_, i) => ({
        id: i + 1,
        client_id: 'c' + (i % 5),
        user_id: (i % 5) + 1,
        // Consecutive posts are always different people, so nothing groups and
        // removing one cannot change how its neighbour draws.
        name: NAMES[i % 5],
        body: 'message number ' + (i + 1),
        created_at: base + i * 45_000,
        pinned: 0, reply_count: 0, reactions: [],
        att_key: '', att_name: '', att_type: '', att_size: 0
    }));
}

const state = { posts: makePosts(N) };
let rt;

beforeAll(async () => {
    const board = vi.fn(async (path) => {
        if (path === 'list') {
            return { success: true, posts: state.posts, hasMore: false, maxId: 9999, typing: [], voice: [] };
        }
        if (path === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
        if (path === 'presence') return { success: true, members: [] };
        return { success: true };
    });
    const app = await bootRenderer({ board });
    rt = app.rt;
    await settle(30);
});

const shown = () => $('messages').querySelectorAll('.msg').length;

// Count what the renderer does to the DOM — that is what costs. Started BEFORE
// the change so that whichever render applies it (the nudge, or a background
// poll that beat it) is the one being measured.
function counting() {
    const NodeProto = window.Node.prototype;
    const ElProto = window.Element.prototype;
    const realInsert = NodeProto.insertBefore;
    const realReplace = NodeProto.replaceChild;
    const realRemove = ElProto.remove;
    const c = { insert: 0, replace: 0, remove: 0 };
    NodeProto.insertBefore = function (...a) { c.insert++; return realInsert.apply(this, a); };
    NodeProto.replaceChild = function (...a) { c.replace++; return realReplace.apply(this, a); };
    ElProto.remove = function (...a) { c.remove++; return realRemove.apply(this, a); };
    c.stop = () => {
        NodeProto.insertBefore = realInsert;
        NodeProto.replaceChild = realReplace;
        ElProto.remove = realRemove;
        return c;
    };
    return c;
}

// The realtime nudge is the path a refresh really arrives down; it coalesces
// behind a 250ms timer, so give it room.
async function refresh() {
    rt({ t: 'posted', channel: 'general', cid: 'someone-else', name: 'bob' });
    await new Promise((r) => setTimeout(r, 400));
    await settle(20);
}

describe('a render costs what changed, not what is on screen', () => {
    it('touches nothing at all when the poll brings back the same messages', async () => {
        expect(shown()).toBe(N);
        const c = counting();
        await refresh();
        c.stop();
        expect(c.insert + c.replace + c.remove,
            'an unchanged list must not touch the DOM').toBe(0);
    });

    it('adds one node when one message arrives', async () => {
        const c = counting();
        const last = state.posts[state.posts.length - 1];
        state.posts = state.posts.concat([{
            ...last, id: last.id + 1, name: 'zoe', client_id: 'c9', user_id: 9,
            body: 'a brand new message', created_at: last.created_at + 45_000
        }]);
        await refresh();
        c.stop();

        expect(shown()).toBe(N + 1);
        expect(c.insert, 'one new row is one insertion').toBeLessThanOrEqual(2);
        expect(c.remove, 'nothing was deleted').toBe(0);
    });

    it('moves nothing when a message is deleted from the middle', async () => {
        const before = shown();
        const c = counting();
        // Deleted near the top — the case that used to re-seat every row below.
        state.posts = state.posts.filter((p) => p.id !== 5);
        await refresh();
        c.stop();

        expect(shown()).toBe(before - 1);
        expect(c.remove, 'the deleted row is taken out').toBeGreaterThanOrEqual(1);
        // The regression put this at ~N. Two is slack for the day separator and
        // the load-more row, not room for a per-row walk.
        expect(c.insert, 'surviving rows must not be re-seated').toBeLessThanOrEqual(2);
    });

    it('moves nothing when several messages go at once', async () => {
        // A moderation sweep, or a run of messages deleted together. Three
        // separate gaps, each of which the old walk got stuck behind — so the
        // rows after the FIRST one were all re-seated regardless of the rest.
        //
        // (Note what is NOT tested here: a post falling off the FRONT of the
        // server page. The merge in loadMessagesOnce deliberately keeps history
        // older than the newest page, so such a post is put straight back —
        // it is retained scrollback, not a deletion.)
        const before = shown();
        const gone = [10, 20, 30];
        const c = counting();
        state.posts = state.posts.filter((p) => !gone.includes(p.id));
        await refresh();
        c.stop();

        expect(shown()).toBe(before - gone.length);
        expect(c.remove, 'each deleted row is taken out').toBeGreaterThanOrEqual(gone.length);
        expect(c.insert, 'surviving rows must not be re-seated').toBeLessThanOrEqual(2);
    });
});
