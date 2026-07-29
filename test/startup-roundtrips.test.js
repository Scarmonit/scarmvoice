// @vitest-environment jsdom
//
// What startup puts on the wire, in what order, and what it draws when.
//
// The thing pinned here is the SHAPE OF THE CHAIN, not a duration. Every call
// below is a trip to Cloudflare — measured at a ~44ms median from the machine
// this was written on, and more on a worse link — so an unnecessary one, or one
// that waits behind something it does not need, is dead time in front of the
// first message. A millisecond threshold would be a flake; a call count and a
// concurrency check are the things that actually cause the delay.
//
// Three properties, none of which is visible when it breaks (the app still
// comes up correctly, just later):
//
//   * account/me is asked ONCE. The account gate asks it and keeps the answer,
//     and enterApp() used to ask the identical question again — same endpoint,
//     same clientId, milliseconds apart — with the socket, the channel list and
//     the first page of messages all waiting behind it.
//
//   * the first `list` leaves WITH the emoji/avatar/channel burst rather than
//     after it. It depends on none of them.
//
//   * ...but it is still DRAWN after the emoji and avatar maps land, which is
//     the guarantee that makes moving the request safe. Only the request moved.
//
// ONE boot for the whole file, deliberately, as render-diff-cost.test.js does
// and for the same reason: bootRenderer leaves the previous instance's poll
// timers running, and a second live renderer draws into the same #messages —
// which reads here as a message appearing before this renderer drew it.
// (Measured: the render-order assertion below passes alone and flakes when a
// second boot precedes it.) The maps are held open instead, so every assertion
// can be made against one startup.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { bootRenderer, settle } from './helpers/renderer.js';

// The three independent calls enterApp() starts together. `list` needs none of
// them, so it belongs alongside them.
const BURST = ['emoji', 'avatars', 'channels'];

const FIRST_POST = {
    id: 1, client_id: 'c1', user_id: 2, name: 'Someone',
    body: 'the first message', created_at: 1700000000000,
    reactions: [], reply_count: 0, pinned: 0
};

const started = [];
let burstDone = 0;
let releaseMaps;
const mapsHeld = new Promise((r) => { releaseMaps = r; });

const drawn = () => document.getElementById('messages').querySelectorAll('.msg').length;

beforeAll(async () => {
    const board = vi.fn(async (p) => {
        const key = String(p).split('?')[0];
        // How many of the burst have ANSWERED when this call starts. That is
        // what separates "sent with the burst" from "sent after it": under the
        // old ordering `list` could not be issued until all three had come
        // back, so it started at 3; issued alongside them it starts at 0.
        // Counting completions rather than in-flight calls is the point —
        // unrelated traffic (presence, dm/threads) makes an in-flight count
        // true either way, which is how the first version of this passed under
        // both orderings.
        started.push({ key, burstDoneAtStart: burstDone });

        // emoji and avatars are held open, so `list` can answer first and the
        // render-order guarantee can be observed rather than assumed.
        if (key === 'emoji') { await mapsHeld; burstDone++; return { success: true, emoji: [] }; }
        if (key === 'avatars') { await mapsHeld; burstDone++; return { success: true, avatars: {} }; }

        await new Promise((r) => setTimeout(r, 0));
        if (BURST.includes(key)) burstDone++;
        if (key === 'list') {
            return { success: true, posts: [FIRST_POST], hasMore: false, typing: [], voice: [] };
        }
        if (key === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
        if (key === 'presence') return { success: true, members: [] };
        if (key === 'dm/threads') return { success: true, threads: [] };
        return { success: true };
    });

    await bootRenderer({ board });
    await settle(40);
});

describe('what a signed-in launch asks for', () => {
    it('asks the account who we are exactly once', () => {
        // accountGate() makes this call and keeps the result. A second one is a
        // whole round trip spent re-reading a row that cannot have changed —
        // and everything else in enterApp() waits behind it.
        expect(window.lounge.account.me).toHaveBeenCalledTimes(1);
    });

    it('does not fetch the first page of messages behind the rest of the burst', () => {
        const list = started.find((c) => c.key === 'list');
        expect(list, 'the first list request').toBeTruthy();
        expect(list.burstDoneAtStart,
            'burst responses already back when the first list was sent').toBe(0);
    });

    it('asks for a primary read on that first page', () => {
        // The old ordering ran `list` after the channels POST, which made the
        // read hit the primary for free. Issued alongside it that no longer
        // happens by accident, so it is asked for — otherwise the first page
        // can be served by a replica that has not caught up with the write.
        const call = window.lounge.board.mock.calls.find(
            (c) => String(c[0]).startsWith('list'));
        expect(call, 'the first list call').toBeTruthy();
        expect(call[1]).toMatchObject({ primary: true });
    });
});

describe('what a signed-in launch draws', () => {
    // Runs last, and depends on the state the boot above left: `list` has
    // answered, emoji and avatars have not.
    it('holds the first messages back until the emoji and avatar maps land', async () => {
        // The point of moving the request is that ONLY the request moved. A
        // message drawn before the emoji map shows `:shrug:` as literal text,
        // and a face drawn before the avatar map shows initials that then swap
        // to a photo — both visible, and both worse than the round trip saved.
        expect(drawn(), 'drawn while the maps were still in flight').toBe(0);

        releaseMaps();
        await settle(40);
        expect(drawn(), 'drawn once the maps landed').toBe(1);
    });
});
