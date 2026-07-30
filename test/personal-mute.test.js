// @vitest-environment jsdom
//
// Two features that share a release: the three-tier permission model on the client
// side, and the resizable side panels.
//
// The permission half is a MIRROR of the server's table — every one of these is
// enforced again in functions/api/board/_accounts.js, and functions/api/board/
// _roles.test.mjs is the copy that matters. What is tested here is only what the
// client DRAWS, because hiding a button is not a permission check and the two
// disagreeing is its own bug: an affordance the server refuses, or an ability the
// user has and cannot reach.
//
// The bug this exists for: role checks were bare `role === 'admin'` comparisons
// spread across a 12,000-line file, and the list was incomplete. Channel creation
// had no check at all, ALL member management was open to any admin — which is how
// an admin could demote the owner — and a moderator could delete somebody else's
// message but had no way to edit one.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { bootRenderer, $, settle } from './helpers/renderer.js';

const POST = (over = {}) => Object.assign({
    id: 1, body: 'hello', name: 'Alice', client_id: 'alice', user_id: 2,
    created_at: 1700000000000, reactions: [], pinned: 0
}, over);

const MY_POST = (over = {}) => POST(Object.assign({
    id: 2, body: 'mine', name: 'Me', client_id: 'me', user_id: 1
}, over));

function router(over = {}) {
    return vi.fn(async (p, opts) => {
        if (over[p]) return over[p](opts);
        if (p === 'list') {
            return {
                success: true, posts: [POST(), MY_POST()], typing: [], voice: [],
                hasMore: false, maxId: 2
            };
        }
        if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }, { name: 'random', unread: 0 }] };
        if (p === 'presence') return { success: true, members: [] };
        if (p === 'account/users') {
            return {
                success: true, users: [
                    { id: 1, username: 'Me', role: 'owner' },
                    { id: 2, username: 'Alice', role: 'admin' },
                    { id: 3, username: 'Bob', role: 'member' }
                ]
            };
        }
        if (p === 'dm/threads') return { success: true, threads: [] };
        return { success: true };
    });
}

const asRole = (role, over = {}) => Object.assign(
    { board: router(), user: { id: 1, username: 'Me', role } }, over);

const rowFor = (id) => $('messages').querySelector(`.msg[data-id="${id}"]`);
const actsOn = (id) => Array.from(rowFor(id).querySelectorAll('.msg-act')).map((b) => b.dataset.act);
const menuLabels = () => Array.from($('ctx-menu').querySelectorAll('.ctx-label')).map((s) => s.textContent);
function rightClick(el) {
    el.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
}

beforeEach(() => { localStorage.clear(); });

describe('personal mute (existing feature, pinned)', () => {
    // Alice is present AND in the call, which is what makes the local-audio half of
    // the popover apply — it is gated on there being audio to act on, never on a
    // role. `Me` is a plain MEMBER throughout.
    const inCallBoard = () => router({
        presence: async () => ({
            success: true,
            members: [{ client_id: 'alice', name: 'Alice', user_id: 2, status: 'online' }]
        }),
        // `voice` is the voice-presence table, which is what renderVoiceRoster
        // merges the SFU roster against — a participant missing from it is drawn as
        // present but not reachable, and the local-audio controls stay hidden.
        list: async () => ({
            success: true, posts: [], typing: [], hasMore: false, maxId: 0,
            voice: [{ client_id: 'alice', name: 'Alice', user_id: 2, muted: 0, deafened: 0 }]
        })
    });

    function voiceDouble(calls) {
        return {
            isJoined: () => true,
            roster: () => [{ id: 'alice', name: 'Alice', uid: 2, muted: false, speaking: false }],
            setLocalMuted: (cid, v) => calls.push([cid, v]),
            setLocalVolume: () => {},
            state: () => ({ joined: true, shareQuality: '1080p', shareMotion: 'sharp', sharers: [] })
        };
    }

    async function openAliceCard(calls) {
        const h = await bootRenderer({
            board: inCallBoard(),
            user: { id: 1, username: 'Me', role: 'member' },
            voice: voiceDouble(calls)
        });
        await settle(20);
        const li = $('members-list').querySelector('.vp');
        expect(li, 'Alice should be in the member list').toBeTruthy();
        li.click();
        await settle();
        return h;
    }

    it('is offered to a plain member, in a call, with no role of any kind', async () => {
        const calls = [];
        await openAliceCard(calls);
        expect($('popover').hidden).toBe(false);
        // The mute row and the volume slider are the personal-audio controls, and
        // they are shown because there is a live call — not because of a role.
        expect($('pop-mute-row').hidden).toBe(false);
        expect($('pop-vol').hidden).toBe(false);
    });

    it('is LOCAL: it tells the audio engine and sends the board nothing', async () => {
        const calls = [];
        const h = await openAliceCard(calls);
        h.board.mockClear();

        $('pop-mute').checked = true;
        $('pop-mute').dispatchEvent(new window.Event('change', { bubbles: true }));
        await settle();

        // The engine was told, so only THIS listener stops hearing them.
        expect(calls).toEqual([['alice', true]]);
        // …and nothing went to the server. A "personal" mute that reached the board
        // would be muting the person for the whole room, which is the second mute
        // system this was checked for rather than rebuilt.
        expect(h.board.mock.calls).toEqual([]);
    });

    it('is remembered per person, in the local settings', async () => {
        const calls = [];
        const h = await openAliceCard(calls);
        h.lounge.settings.set.mockClear();

        $('pop-mute').checked = true;
        $('pop-mute').dispatchEvent(new window.Event('change', { bubbles: true }));
        await settle();

        const patches = h.lounge.settings.set.mock.calls.map((c) => c[0]).filter((x) => x && x.localMuted);
        expect(patches.length).toBeGreaterThan(0);
        expect(patches[patches.length - 1].localMuted.alice).toBe(true);
    });

    it('un-mutes again', async () => {
        const calls = [];
        await openAliceCard(calls);
        $('pop-mute').checked = true;
        $('pop-mute').dispatchEvent(new window.Event('change', { bubbles: true }));
        await settle();
        $('pop-mute').checked = false;
        $('pop-mute').dispatchEvent(new window.Event('change', { bubbles: true }));
        await settle();
        expect(calls).toEqual([['alice', true], ['alice', false]]);
    });
});
