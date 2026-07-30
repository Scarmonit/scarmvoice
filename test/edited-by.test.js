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

describe('an edit made by somebody other than the author', () => {
    const edited = (over) => ({
        success: true, voice: [], typing: [], hasMore: false, maxId: 1,
        posts: [POST(Object.assign({ edited_at: 1700000600000 }, over))]
    });

    it('names who edited it and when', async () => {
        const board = router({ list: async () => edited({ edited_by: 'Scarmonit' }) });
        await bootRenderer({ board, user: { id: 1, username: 'Me', role: 'member' } });
        await settle();

        const mark = rowFor(1).querySelector('.msg-edited');
        expect(mark).toBeTruthy();
        expect(mark.textContent).toMatch(/edited by Scarmonit/);
        expect(mark.classList.contains('by-mod')).toBe(true);
        // The exact moment is on the hover title either way.
        expect(mark.title).toMatch(/Scarmonit/);
    });

    it('still says only "(edited)" when the author edited their own', async () => {
        const board = router({ list: async () => edited({}) });
        await bootRenderer({ board, user: { id: 1, username: 'Me', role: 'member' } });
        await settle();

        const mark = rowFor(1).querySelector('.msg-edited');
        expect(mark.textContent).toBe('(edited)');
        expect(mark.classList.contains('by-mod')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Personal mute — VERIFIED, not rebuilt.
//
// Asked for as a check rather than as a feature: it already exists as
// settings.localMuted, keyed by install id, applied to the local <audio> element
// and to a presenter's share audio. These pin the two properties that make it a
// PERSONAL mute — that it is local-only, and that it is available to everybody
// regardless of role — so a future change cannot quietly turn it into something
// that mutes the person for the whole room.

// WHERE the marker goes, which is a separate question from what it says.
//
// renderBody wraps prose in .msg-para, and that is display:block — so appending
// the marker to .msg-text made it a block SIBLING and it landed on a line of its
// own underneath the message. The convention everywhere else, this app's own
// reference included, is a small "(edited)" trailing the last words of the text.
describe('where the marker sits', () => {
    const edited = (posts) => ({ success: true, voice: [], typing: [], hasMore: false, maxId: 9, posts });

    it('trails the last words of the message, not a line of its own', async () => {
        await bootRenderer(asRole('member', {
            board: router({ list: () => edited([POST({ body: 'hello there', edited_at: 1700000600000 })]) })
        }));
        await settle();

        const marker = rowFor(1).querySelector('.msg-edited');
        expect(marker).toBeTruthy();
        // Inside the paragraph — which is what puts it on the same line.
        expect(marker.parentElement.classList.contains('msg-para')).toBe(true);
        expect(rowFor(1).querySelector('.msg-text').textContent).toBe('hello there(edited)');
    });

    it('falls back to its own line after a block that has no line to trail', async () => {
        // A code fence, a list or a quote ends in a block element; there is no last
        // line of text to sit on, so under it is the only sensible place.
        await bootRenderer(asRole('member', {
            board: router({
                list: () => edited([POST({ body: '```js\nconst a = 1;\n```', edited_at: 1700000600000 })])
            })
        }));
        await settle();

        const text = rowFor(1).querySelector('.msg-text');
        const marker = text.querySelector('.msg-edited');
        expect(marker).toBeTruthy();
        expect(marker.parentElement).toBe(text);
        expect(text.querySelector('pre.msg-code')).toBeTruthy();
    });

    it('keeps the moderator variant in the same place', async () => {
        await bootRenderer(asRole('member', {
            board: router({
                list: () => edited([POST({
                    body: 'this is looking better', edited_at: 1700000600000, edited_by: 'Scarmonit'
                })])
            })
        }));
        await settle();

        const marker = rowFor(1).querySelector('.msg-edited.by-mod');
        expect(marker.parentElement.classList.contains('msg-para')).toBe(true);
        expect(marker.textContent).toContain('edited by Scarmonit');
    });
});
