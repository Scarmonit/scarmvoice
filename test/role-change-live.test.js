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

// A role that changes while the app is running. It used to take effect only after
// the affected person logged out and back in, or restarted the app — because the
// role is read once, from account/me at startup, and nothing ever asked again.
describe('a role change arriving on the socket', () => {
    it('takes effect with no sign-out and no restart', async () => {
        const h = await bootRenderer(asRole('member'));
        await settle();
        expect($('btn-add-channel').hidden).toBe(true);
        expect(actsOn(1)).not.toContain('edit');

        // What the owner's promotion pushes through the Durable Object.
        h.lounge.account.me.mockImplementation(async () => ({
            success: true, user: { id: 1, username: 'Me', role: 'admin' }
        }));
        h.rt({ t: 'role', role: 'admin', by: 'Scarmonit', at: Date.now() });
        await settle();

        expect($('btn-add-channel').hidden).toBe(false);
        expect(actsOn(1)).toContain('edit');
        expect(actsOn(1)).toContain('pin');
    });

    it('tells the user what happened, with one button to dismiss it', async () => {
        const h = await bootRenderer(asRole('member'));
        await settle();
        h.lounge.account.me.mockImplementation(async () => ({
            success: true, user: { id: 1, username: 'Me', role: 'admin' }
        }));
        h.rt({ t: 'role', role: 'admin', by: 'Scarmonit', at: Date.now() });
        await settle();

        expect($('dialog').hidden).toBe(false);
        expect($('dialog-title').textContent).toMatch(/promoted to Admin/i);
        expect($('dialog-msg').textContent).toMatch(/Scarmonit/);
        // An acknowledgement, not a choice: there is nothing to decline, because
        // the change has already happened.
        expect($('dialog-cancel').hidden).toBe(true);
        expect($('dialog-ok').hidden).toBe(false);

        $('dialog-ok').click();
        await settle();
        expect($('dialog').hidden).toBe(true);
    });

    // The notice arrives unannounced, over whatever the person was already doing.
    // The next click after it appears was aimed at something underneath it — and
    // that click used to dismiss it, because the backdrop closed the dialog. So a
    // change to what somebody is allowed to do could vanish before it had been
    // read, with nothing in the app that would show it again. It has to be
    // acknowledged now: the button is the only way out.
    describe('and the notice is static', () => {
        async function noticeUp() {
            const h = await bootRenderer(asRole('member'));
            await settle();
            h.lounge.account.me.mockImplementation(async () => ({
                success: true, user: { id: 1, username: 'Me', role: 'admin' }
            }));
            h.rt({ t: 'role', role: 'admin', by: 'Scarmonit', at: Date.now() });
            await settle();
            expect($('dialog').hidden).toBe(false);
            return h;
        }

        it('survives a click on the backdrop', async () => {
            await noticeUp();
            $('dialog').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
            await settle();
            expect($('dialog').hidden).toBe(false);
            // The click is not simply swallowed: it points at the way out.
            expect(document.activeElement).toBe($('dialog-ok'));
        });

        it('survives Escape', async () => {
            await noticeUp();
            document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            await settle();
            expect($('dialog').hidden).toBe(false);
        });

        // Escape is refused, not ignored — the branch still has to swallow the key,
        // or it falls through to whatever is open behind the modal and closes that
        // instead, leaving the notice up over a panel that has just disappeared.
        it('does not let Escape reach what is behind it', async () => {
            await noticeUp();
            $('btn-pinned').click();
            await settle();
            expect($('pinned-panel').hidden).toBe(false);

            document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            await settle();
            expect($('dialog').hidden).toBe(false);
            expect($('pinned-panel').hidden).toBe(false);
        });

        it('closes on the button, and lets go of static as it goes', async () => {
            await noticeUp();
            $('dialog-ok').click();
            await settle();
            expect($('dialog').hidden).toBe(true);

            // The flag is shared with every other dialog. If it were not cleared,
            // the next ordinary prompt would be unescapable too.
            $('btn-add-channel').click();
            await settle();
            expect($('dialog').hidden).toBe(false);
            $('dialog').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
            await settle();
            expect($('dialog').hidden).toBe(true);
        });
    });

    it('says "changed to" rather than "promoted" on the way down', async () => {
        const h = await bootRenderer(asRole('admin'));
        await settle();
        h.lounge.account.me.mockImplementation(async () => ({
            success: true, user: { id: 1, username: 'Me', role: 'member' }
        }));
        h.rt({ t: 'role', role: 'member', by: 'Scarmonit', at: Date.now() });
        await settle();

        expect($('dialog-title').textContent).toMatch(/changed to Member/i);
        expect($('dialog-title').textContent).not.toMatch(/promoted/i);
    });

    it('takes a demotion away immediately too', async () => {
        const h = await bootRenderer(asRole('admin'));
        await settle();
        expect($('btn-add-channel').hidden).toBe(false);

        h.lounge.account.me.mockImplementation(async () => ({
            success: true, user: { id: 1, username: 'Me', role: 'member' }
        }));
        h.rt({ t: 'role', role: 'member', by: 'Scarmonit', at: Date.now() });
        await settle();

        expect($('btn-add-channel').hidden).toBe(true);
        expect(actsOn(1)).not.toContain('edit');
        expect(actsOn(1)).not.toContain('pin');
    });

    // The push is a TRIGGER; account/me is the authoritative answer. But a failure
    // to ask must not leave a client that has been told it was promoted still
    // acting as though it wasn't.
    it('falls back to the pushed role when account/me cannot be reached', async () => {
        const h = await bootRenderer(asRole('member'));
        await settle();
        h.lounge.account.me.mockImplementation(async () => ({ success: false, network: true }));
        h.rt({ t: 'role', role: 'admin', by: 'Scarmonit', at: Date.now() });
        await settle();
        expect($('btn-add-channel').hidden).toBe(false);
    });

    it('does nothing when the role has not actually moved', async () => {
        const h = await bootRenderer(asRole('admin'));
        await settle();
        h.rt({ t: 'role', role: 'admin', by: 'Scarmonit', at: Date.now() });
        await settle();
        expect($('dialog').hidden).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// "edited by X" — a moderator editing somebody else's message.
