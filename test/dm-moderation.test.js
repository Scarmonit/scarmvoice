// @vitest-environment jsdom
//
// A BOARD ROLE MEANS THE SAME THING IN A CONVERSATION AS IN A CHANNEL.
//
// The bug: signed in as the board's Owner, deleting somebody else's message in
// a DM was impossible. The button was not drawn, and the endpoint behind it
// would have refused anyway — functions/api/board/dm/message.js decided
// permissions itself with a hand-written `from_user === me.id` and had never
// heard of the role table /api/board/delete.js had consulted for a year.
//
// It was the last of a long line of bugs with one cause: DMs and channels were
// two implementations of the same idea, so every rule written for one had to be
// discovered missing from the other (pins, threads, search, reactions, the
// "(edited)" marker, and finally this). The server has one message system now —
// functions/api/board/_surface.js, _messages.js and _authz.js — and this file is
// the client half of the contract:
//
//   • An Owner or Admin gets "Edit (moderator)" and "Delete (moderator)" on
//     somebody else's message in a DM, exactly as in a channel.
//   • A plain member gets neither, in either place.
//   • The action still routes to the DM endpoint, because that is a routing
//     detail; both endpoints are adapters over the same core.
//
// The scope limit — moderation reaches ONLY conversations the moderator is a
// member of — is not testable from here and is not meant to be: it is enforced
// server-side ahead of any capability check, and covered by
// scarmonit-website/functions/api/board/_surface.test.mjs. A conversation this
// client can open is one the server already listed for this account.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { bootRenderer, $, settle } from './helpers/renderer.js';

const OWNER = { id: 1, username: 'Scarmonit', role: 'owner' };
const MEMBER = { id: 1, username: 'Me', role: 'member' };
const THEM = { id: 2, username: 'Alice', role: 'member' };

const THREAD = { id: 40, title: 'Alice', isGroup: false, user: THEM, members: [], unread: 0 };

// One message from them (the one a moderator acts on) and one of mine (the
// control: my own actions must not grow a "(moderator)" label).
const MESSAGES = [
    { id: 501, from: THEM.id, body: 'have a look at this', created_at: 1700000000000, pinned: 0, reactions: [] },
    { id: 502, from: 1, body: 'mine', created_at: 1700000060000, pinned: 0, reactions: [] }
];

// A channel message from the same person, as the control the whole file turns
// on: whatever the menu offers on one, it must offer on the other.
const POST = {
    id: 7, body: 'hello', name: 'Alice', client_id: 'alice', user_id: THEM.id,
    created_at: 1700000000000, reactions: [], pinned: 0
};

function router(me) {
    const members = [me, THEM];
    return vi.fn(async (p) => {
        if (p === 'dm/threads') return { success: true, threads: [{ ...THREAD, members }] };
        if (p === 'dm/list') return { success: true, thread: { ...THREAD, members }, messages: MESSAGES };
        if (p === 'dm/pins') return { success: true, thread: THREAD.id, pins: [] };
        if (p === 'dm/reply-threads') return { success: true, thread: THREAD.id, threads: [] };
        if (p === 'list') return { success: true, posts: [POST], typing: [], voice: [], hasMore: false, maxId: 7 };
        if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
        if (p === 'presence') {
            return { success: true, members: [{ client_id: 'alice', user_id: THEM.id, name: 'Alice', status: 'online' }] };
        }
        return { success: true };
    });
}

const rowFor = (box, id) => box.querySelector(`.msg[data-id="${id}"]`);
const menuLabels = () =>
    Array.from($('ctx-menu').querySelectorAll('.ctx-label')).map((s) => s.textContent);
const rightClick = (el) =>
    el.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));

async function openTheDm() {
    const row = $('dm-list').querySelector('.dm-row');
    expect(row).toBeTruthy();
    row.click();
    await settle();
}

describe('the Owner, inside a conversation', () => {
    let board;

    beforeAll(async () => {
        board = router(OWNER);
        await bootRenderer({ user: OWNER, board });
        await openTheDm();
    });

    // THE REPORTED BUG, from the affordance side.
    it('is offered moderator edit and delete on somebody else\'s message', () => {
        rightClick(rowFor($('dm-messages'), 501));
        const labels = menuLabels();
        expect(labels).toContain('Delete (moderator)');
        expect(labels).toContain('Edit (moderator)');
    });

    it('gets the plain labels on their OWN message, not the moderator ones', () => {
        // The distinction is the point of the label. Rewriting what somebody
        // else said in their name is a different act from fixing your own typo,
        // and the server records which (edited_by) on the message itself.
        rightClick(rowFor($('dm-messages'), 502));
        const labels = menuLabels();
        expect(labels).toContain('Delete message');
        expect(labels).toContain('Edit message');
        expect(labels).not.toContain('Delete (moderator)');
    });

    it('offers the same thing on a channel message — that identity IS the fix', async () => {
        $('dm-close').click();
        $('rail-home').click();
        await settle();
        rightClick(rowFor($('messages'), 7));
        const labels = menuLabels();
        expect(labels).toContain('Delete (moderator)');
        expect(labels).toContain('Edit (moderator)');
    });

    it('sends a moderated DM delete to the DM endpoint', async () => {
        // The two routes are a routing detail — /delete reads the posts table
        // and a DM id is a different id space — not two permission models.
        $('rail-dms').click();
        await settle();
        await openTheDm();
        board.mockClear();

        rightClick(rowFor($('dm-messages'), 501));
        const item = Array.from($('ctx-menu').querySelectorAll('.ctx-item'))
            .find((el) => el.textContent.includes('Delete (moderator)'));
        expect(item).toBeTruthy();
        item.click();
        await settle();

        // deletePost confirms first — the destructive path must stay behind a
        // dialog for a moderator too.
        expect($('dialog').hidden).toBe(false);
        $('dialog-ok').click();
        await settle();

        const call = board.mock.calls.find((c) => c[0] === 'dm/message');
        expect(call).toBeTruthy();
        expect(call[1].body).toMatchObject({ id: 501, action: 'delete' });
        expect(board.mock.calls.some((c) => c[0] === 'delete')).toBe(false);
    });
});

describe('a plain member, inside the same conversation', () => {
    beforeAll(async () => {
        await bootRenderer({ user: MEMBER, board: router(MEMBER) });
        await openTheDm();
    });

    // The other half of the contract, and the one that keeps the change honest:
    // unifying the rule must not hand moderation to everybody. A member gets
    // nothing on somebody else's message in either place.
    it('is offered no moderator action on somebody else\'s message', () => {
        rightClick(rowFor($('dm-messages'), 501));
        const labels = menuLabels();
        expect(labels).not.toContain('Delete (moderator)');
        expect(labels).not.toContain('Edit (moderator)');
        expect(labels).not.toContain('Delete message');
        expect(rowFor($('dm-messages'), 501).querySelector('[data-act="edit"]')).toBeNull();
    });

    it('keeps its own message editable and deletable', () => {
        rightClick(rowFor($('dm-messages'), 502));
        const labels = menuLabels();
        expect(labels).toContain('Edit message');
        expect(labels).toContain('Delete message');
    });

    it('gets the same nothing on a channel message', async () => {
        $('dm-close').click();
        $('rail-home').click();
        await settle();
        rightClick(rowFor($('messages'), 7));
        const labels = menuLabels();
        expect(labels).not.toContain('Delete (moderator)');
        expect(labels).not.toContain('Delete message');
    });
});
