// @vitest-environment jsdom
//
// WHAT THE MEMBER POPOUT OFFERS, and why it used to offer different things to
// different people in the same list.
//
// Reported: one person's popout has Message / Mention / Block, the next has
// only Message / Mention. Nothing on screen explained the difference, and there
// was no route from here to the full profile card at all.
//
// The cause was identity, resolved late and in pieces. Every action turns on
// one of two ids — the ACCOUNT (Message, the admin actions, the profile card)
// or the INSTALL (Block, which is what settings.blocked is keyed by) — and the
// rows arriving at openPopover carry different halves of that pair. A row for
// somebody OFFLINE is built from the account directory with `id: null`, so the
// old `hidden = !p.id` hid Block from every offline member. Each action reached
// for its own half off the row and hid itself when it was missing.
//
// It is resolved once now, up front, from every source that knows — including
// the messages on screen, which carry both ids for their author and are the
// only source that still answers for somebody who has gone offline.
import { describe, it, expect, vi } from 'vitest';
import { bootRenderer, settle, $ } from './helpers/renderer.js';

const ME = { id: 1, username: 'Me', role: 'member' };
const ALICE = { id: 2, username: 'Alice', role: 'member' };   // online, in presence
const BOB = { id: 3, username: 'Bob', role: 'member' };       // offline, but has posted
const CAROL = { id: 4, username: 'Carol', role: 'member' };   // offline, never posted

// Alice is the only one in the presence table. Bob and Carol are therefore both
// drawn from the account directory, with no install id on the row.
const MEMBERS = [
    { client_id: 'me', user_id: 1, name: 'Me', status: 'online', custom: '' },
    { client_id: 'alice', user_id: 2, name: 'Alice', status: 'online', custom: '' }
];

// Bob's message. It carries his account AND the install that wrote it, which is
// what lets Block reach him after he has gone.
const POSTS = [{
    id: 900, body: 'back later', name: 'Bob', client_id: 'bob-desktop', user_id: BOB.id,
    created_at: 1700000000000, reactions: [], pinned: 0
}];

const router = (over = {}) => vi.fn(async (route) => {
    const p = String(route).split('?')[0];
    if (p === 'presence') return { success: true, members: MEMBERS };
    if (p === 'list') return { success: true, posts: POSTS, typing: [], voice: [], hasMore: false, maxId: 900 };
    if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
    if (p === 'account/users') return { success: true, users: [ME, ALICE, BOB, CAROL] };
    if (p === 'avatars') return { success: true, avatars: over.avatars || {} };
    if (p === 'dm/threads') return { success: true, threads: [] };
    return { success: true };
});

function memberRow(name) {
    return Array.from(document.querySelectorAll('#members-list li.vp'))
        .find((li) => li.textContent.indexOf(name) !== -1);
}

// Open the popout about somebody in the member list.
async function popoutFor(name) {
    const row = memberRow(name);
    expect(row, 'no member row for ' + name).toBeTruthy();
    row.click();
    await settle(2);
    expect($('popover').hidden, 'the popout did not open for ' + name).toBe(false);
}

// The actions actually on offer, in the order they are drawn.
const actions = () => Array.from(document.querySelectorAll('#popover .pop-action'))
    .filter((b) => !b.hidden)
    .map((b) => b.textContent.trim());

describe('the member popout', () => {
    it('offers the same actions for somebody offline as for somebody online', async () => {
        await bootRenderer({ user: ME, board: router() });

        await popoutFor('Alice');
        const online = actions();

        await popoutFor('Bob');
        const offline = actions();

        expect(online).toEqual(['Message Alice', 'Mention in chat', 'View Full Profile', 'Block']);
        expect(offline).toEqual(['Message Bob', 'Mention in chat', 'View Full Profile', 'Block']);
    });

    it('offers Block for an offline member, resolved from what they posted', async () => {
        // The regression, exactly: Bob's row is built from the account directory
        // and carries no install id, so Block used to be hidden for him alone.
        await bootRenderer({ user: ME, board: router() });

        await popoutFor('Bob');
        expect($('pop-block').hidden).toBe(false);
    });

    it('blocks the install that person actually wrote from', async () => {
        const { lounge } = await bootRenderer({ user: ME, board: router() });

        await popoutFor('Bob');
        $('pop-block').click();
        await settle(2);
        // The confirm dialog stands between the click and the write.
        $('dialog-ok').click();
        await settle(4);

        const saved = lounge.settings.set.mock.calls.map((c) => c[0]).filter((s) => s.blocked);
        expect(saved.length, 'nothing was blocked').toBeGreaterThan(0);
        expect(saved[saved.length - 1].blocked).toEqual({ 'bob-desktop': 'Bob' });
    });

    it('still hides Block when this computer has never seen an install for them', async () => {
        // Carol has an account and nothing else — no presence row, no voice row,
        // nothing posted. A block is keyed by install, so there is genuinely
        // nothing to key it on, and a button that cannot act is worse than none.
        await bootRenderer({ user: ME, board: router() });

        await popoutFor('Carol');
        expect($('pop-block').hidden).toBe(true);
        // Everything that does not need an install is still there.
        expect(actions()).toEqual(['Message Carol', 'Mention in chat', 'View Full Profile']);
    });

    it('opens the full profile card, for online and offline alike', async () => {
        await bootRenderer({ user: ME, board: router() });

        await popoutFor('Bob');
        $('pop-profile').click();
        await settle(3);

        expect($('profile-card').hidden).toBe(false);
        expect($('pc-name').textContent).toBe('Bob');
        // The popout it came from gets out of the way, like every other action.
        expect($('popover').hidden).toBe(true);
    });

    it('keeps the admin actions role-appropriate', async () => {
        // A member sees neither. They are not hidden by accident — they are the
        // one thing in this popout that SHOULD depend on who is looking.
        await bootRenderer({ user: ME, board: router() });
        await popoutFor('Alice');
        expect($('pop-ban').hidden).toBe(true);
        expect($('pop-kick').hidden).toBe(true);
    });

    it('offers Ban to the owner', async () => {
        await bootRenderer({ user: { id: 1, username: 'Me', role: 'owner' }, board: router() });
        await popoutFor('Alice');
        expect($('pop-ban').hidden).toBe(false);
        // …and still not for a call nobody is in.
        expect($('pop-kick').hidden).toBe(true);
    });
});

describe('the full profile card', () => {
    const AVATARS = { 3: 'avatars/bob.png' };

    it('opens the picture full size when its big face is clicked', async () => {
        await bootRenderer({ user: ME, board: router({ avatars: AVATARS }) });

        await popoutFor('Bob');
        $('pop-profile').click();
        await settle(3);

        const face = $('pc-face').querySelector('.av');
        expect(face.classList.contains('av-zoomable')).toBe(true);
        face.click();
        await settle(2);

        expect($('lightbox').hidden).toBe(false);
        expect($('lb-image').getAttribute('src')).toContain('avatars%2Fbob.png');
        // The card stays up underneath — Escape takes the picture off first.
        expect($('profile-card').hidden).toBe(false);

        document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await settle(2);
        expect($('lightbox').hidden).toBe(true);
        expect($('profile-card').hidden).toBe(false);
    });

    it('leaves the face inert for somebody with no picture', async () => {
        await bootRenderer({ user: ME, board: router({ avatars: AVATARS }) });

        await popoutFor('Alice');          // no avatar in the map
        $('pop-profile').click();
        await settle(3);

        const face = $('pc-face').querySelector('.av');
        expect(face.classList.contains('av-zoomable')).toBe(false);
        face.click();
        await settle(2);
        expect($('lightbox').hidden).toBe(true);
    });
});
