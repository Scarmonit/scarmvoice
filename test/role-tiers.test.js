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

describe('what a member is offered', () => {
    it('cannot create a channel', async () => {
        await bootRenderer(asRole('member'));
        await settle();
        // Open to EVERY signed-in member before this release, here and on the server.
        expect($('btn-add-channel').hidden).toBe(true);
    });

    it('gets no channel gear, and no rename or delete on the channel menu', async () => {
        await bootRenderer(asRole('member'));
        await settle();
        expect(document.querySelector('.chan [data-act="edit"]')).toBeNull();

        rightClick(document.querySelector('.chan[data-channel="random"]'));
        expect(menuLabels()).not.toContain('Rename channel');
        expect(menuLabels()).not.toContain('Delete channel');
    });

    it('can edit and delete its OWN message', async () => {
        await bootRenderer(asRole('member'));
        await settle();
        expect(actsOn(2)).toContain('edit');
        expect(actsOn(2)).toContain('delete');
    });

    it('cannot touch anybody else\'s message', async () => {
        await bootRenderer(asRole('member'));
        await settle();
        expect(actsOn(1)).not.toContain('edit');
        expect(actsOn(1)).not.toContain('delete');
        expect(actsOn(1)).not.toContain('pin');

        rightClick(rowFor(1));
        expect(menuLabels()).not.toContain('Edit (moderator)');
        expect(menuLabels()).not.toContain('Delete (moderator)');
    });

});

describe('what an admin is offered', () => {
    it('can create and rename a channel, but not delete one', async () => {
        await bootRenderer(asRole('admin'));
        await settle();
        expect($('btn-add-channel').hidden).toBe(false);

        rightClick(document.querySelector('.chan[data-channel="random"]'));
        expect(menuLabels()).toContain('Rename channel');
        // Deleting drops every message in the channel, irreversibly — owner only.
        expect(menuLabels()).not.toContain('Delete channel');
    });

    it('can EDIT as well as delete somebody else\'s message', async () => {
        await bootRenderer(asRole('admin'));
        await settle();
        // The ability the server always allowed and the UI never offered: the
        // hover bar and the menu both gated edit on ownership, so a moderator
        // could delete another person's message but not correct it.
        expect(actsOn(1)).toContain('edit');
        expect(rowFor(1).querySelector('[data-act="edit"]').title).toMatch(/moderator/i);

        rightClick(rowFor(1));
        expect(menuLabels()).toContain('Edit (moderator)');
        expect(menuLabels()).toContain('Delete (moderator)');
    });

    it('can pin somebody else\'s message', async () => {
        await bootRenderer(asRole('admin'));
        await settle();
        expect(actsOn(1)).toContain('pin');
    });

    // The escalation this release closes. An admin used to see this entire panel,
    // which is how one could ban, reset the password of, or demote anybody — the
    // owner included.
});

describe('what the owner is offered', () => {
    it('keeps every ability an admin has', async () => {
        await bootRenderer(asRole('owner'));
        await settle();
        expect($('btn-add-channel').hidden).toBe(false);
        expect(actsOn(1)).toContain('edit');
        expect(actsOn(1)).toContain('pin');
        rightClick(document.querySelector('.chan[data-channel="random"]'));
        expect(menuLabels()).toContain('Rename channel');
    });

    it('can delete a channel', async () => {
        await bootRenderer(asRole('owner'));
        await settle();
        rightClick(document.querySelector('.chan[data-channel="random"]'));
        expect(menuLabels()).toContain('Delete channel');
    });


    it('is shown as the owner, not merely as an admin', async () => {
        await bootRenderer(asRole('owner'));
        await settle();
        expect($('acct-role').textContent).toContain('owner');
    });
});

// ---------------------------------------------------------------------------
// Everything that OPENS THE SETTINGS SHEET lives at the end of this file.
//
// The member-management panel's visibility is decided when the sheet opens, so
// these cases have to open it — and a sheet left open survives into the next
// bootRenderer in the same jsdom document, where the previous app.js instance's
// document-level listeners then render against the new DOM. Keeping them last
// means nothing runs after them.

describe('who is offered member management', () => {
    // The escalation this release closes. An ADMIN used to see this entire panel,
    // which is how one could ban, reset the password of, or demote anybody — the
    // owner included.
    it('not a member', async () => {
        await bootRenderer(asRole('member'));
        await settle();
        $('btn-settings').click();
        await settle();
        expect($('acct-members').hidden).toBe(true);
    });

    it('not an admin either', async () => {
        await bootRenderer(asRole('admin'));
        await settle();
        $('btn-settings').click();
        await settle();
        expect($('acct-members').hidden).toBe(true);
    });

    it('only the owner', async () => {
        await bootRenderer(asRole('owner'));
        await settle();
        $('btn-settings').click();
        await settle();
        expect($('acct-members').hidden).toBe(false);
    });
});

describe('the member list an owner manages', () => {
    it('offers no action against another owner', async () => {
        const board = router({
            'account/users': async () => ({
                success: true, users: [
                    { id: 1, username: 'Me', role: 'owner' },
                    { id: 9, username: 'Founder', role: 'owner' }
                ]
            })
        });
        await bootRenderer({ board, user: { id: 1, username: 'Me', role: 'owner' } });
        await settle();
        $('btn-settings').click();
        await settle();

        const row = Array.from($('member-admin-list').querySelectorAll('.ma-row'))
            .find((r) => r.textContent.includes('Founder'));
        expect(row).toBeTruthy();
        expect(row.querySelectorAll('button')).toHaveLength(0);
        expect(row.textContent).toMatch(/cannot be changed or removed/i);
    });

    it('still offers the full set against an admin', async () => {
        await bootRenderer(asRole('owner'));
        await settle();
        $('btn-settings').click();
        await settle();
        const row = Array.from($('member-admin-list').querySelectorAll('.ma-row'))
            .find((r) => r.textContent.includes('Alice'));
        const labels = Array.from(row.querySelectorAll('button')).map((b) => b.textContent);
        expect(labels).toContain('Make member');
        expect(labels).toContain('Ban');
        expect(labels).toContain('Reset password');
        expect(labels).toContain('Delete');
    });
});

// ---------------------------------------------------------------------------
// A role that changes while the app is running.
//
// It used to take effect only after the affected person logged out and back in, or
// restarted — because the role is read once, from account/me at startup, and
// nothing ever asked again.
