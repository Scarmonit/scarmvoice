// @vitest-environment jsdom
//
// A profile picture, opened full size.
//
// Two entry points, and ONLY two: the big face on the profile panel beside a
// conversation, and the face at the top of the member-list popout. Everywhere
// else an avatar click already means something — a face in the member list or
// on a message opens the profile — and this feature must not take any of those
// over. The last spec here is the one that pins that.
//
// The overlay is the image lightbox the app already has, so Escape, the
// backdrop click, the close button and the focus trap come with it rather than
// being reimplemented and drifting.
import { describe, it, expect, vi } from 'vitest';
import { bootRenderer, settle, $ } from './helpers/renderer.js';

const ME = { id: 1, username: 'Me', role: 'member' };
const ALICE = { id: 2, username: 'Alice', role: 'member' };
// Bob has no picture: letters on a coloured disc, and nothing to enlarge.
const BOB = { id: 3, username: 'Bob', role: 'member' };

const PAIR = { id: 40, title: 'Alice', isGroup: false, user: ALICE, members: [ME, ALICE], unread: 0 };

const MEMBERS = [
    { client_id: 'me', user_id: 1, name: 'Me', status: 'online', custom: '' },
    { client_id: 'alice', user_id: 2, name: 'Alice', status: 'online', custom: '' },
    { client_id: 'bob', user_id: 3, name: 'Bob', status: 'online', custom: '' }
];

// The avatar map the board serves: account id -> R2 key.
const AVATARS = { 2: 'avatars/alice.png' };

const router = () => vi.fn(async (route) => {
    const p = String(route).split('?')[0];
    if (p === 'avatars') return { success: true, avatars: AVATARS };
    if (p === 'presence') return { success: true, members: MEMBERS };
    if (p === 'list') return { success: true, posts: [], typing: [], voice: [], hasMore: false };
    if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
    if (p === 'dm/threads') return { success: true, threads: [PAIR] };
    if (p === 'dm/list') return { success: true, thread: PAIR, messages: [] };
    if (p === 'account/users') return { success: true, users: [ALICE, BOB] };
    return { success: true };
});

const lightboxOpen = () => !$('lightbox').hidden;
const lightboxSrc = () => $('lb-image').getAttribute('src') || '';

async function openPair() {
    const row = $('dm-list').querySelector('.dm-row');
    row.click();
    await settle();
}

function memberRow(name) {
    return Array.from(document.querySelectorAll('#members-list li.vp'))
        .find((li) => li.textContent.indexOf(name) !== -1);
}

describe('the profile panel beside a conversation', () => {
    it('opens the picture full size when the face is clicked', async () => {
        await bootRenderer({ user: ME, board: router() });
        await openPair();

        const face = $('dm-prof-face').querySelector('.av');
        expect(face, 'the profile panel drew no face').toBeTruthy();
        expect(face.classList.contains('av-zoomable')).toBe(true);

        face.click();
        await settle(2);

        expect(lightboxOpen()).toBe(true);
        expect(lightboxSrc()).toContain('avatars%2Falice.png');
    });

    it('closes again on Escape, the way every other overlay does', async () => {
        await bootRenderer({ user: ME, board: router() });
        await openPair();

        $('dm-prof-face').querySelector('.av').click();
        await settle(2);
        expect(lightboxOpen()).toBe(true);

        document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await settle(2);
        expect(lightboxOpen()).toBe(false);
    });
});

describe('the member-list popout', () => {
    it('opens the picture full size when the face at the top is clicked', async () => {
        await bootRenderer({ user: ME, board: router() });

        memberRow('Alice').click();
        await settle(2);
        expect($('popover').hidden, 'clicking a member should still open the popout').toBe(false);

        const face = $('pop-avatar');
        expect(face.classList.contains('av-zoomable')).toBe(true);
        face.click();
        await settle(2);

        expect(lightboxOpen()).toBe(true);
        expect(lightboxSrc()).toContain('avatars%2Falice.png');
        // The popout it was opened from is still there underneath — Escape
        // takes the picture off first (the lightbox outranks it), which is what
        // the spec above proves.
        expect($('popover').hidden).toBe(false);
    });

    it('does nothing for somebody with no picture', async () => {
        await bootRenderer({ user: ME, board: router() });

        memberRow('Bob').click();
        await settle(2);

        const face = $('pop-avatar');
        expect(face.classList.contains('av-zoomable')).toBe(false);
        // No tab stop and no button role either: there is nothing to press.
        expect(face.getAttribute('role')).toBe(null);
        expect(face.getAttribute('tabindex')).toBe(null);

        face.click();
        await settle(2);
        expect(lightboxOpen()).toBe(false);
    });

    it('drops the affordance when the popout is reused for somebody else', async () => {
        // The popout is one element repainted per person. Left set, Bob would
        // inherit Alice's cursor, tab stop and click.
        await bootRenderer({ user: ME, board: router() });

        memberRow('Alice').click();
        await settle(2);
        expect($('pop-avatar').classList.contains('av-zoomable')).toBe(true);

        memberRow('Bob').click();
        await settle(2);
        expect($('pop-avatar').classList.contains('av-zoomable')).toBe(false);

        $('pop-avatar').click();
        await settle(2);
        expect(lightboxOpen()).toBe(false);
    });
});

describe('every other avatar in the app', () => {
    it('still opens the profile popout rather than the picture', async () => {
        await bootRenderer({ user: ME, board: router() });

        // The member list row's own face — the click that has always opened the
        // popout, on a person who DOES have a picture, so nothing but the
        // wiring can be what decides the outcome.
        const av = memberRow('Alice').querySelector('.av, .vp-av');
        expect(av, 'the member row drew no avatar').toBeTruthy();
        expect(av.classList.contains('av-zoomable')).toBe(false);

        av.click();
        await settle(2);

        expect($('popover').hidden).toBe(false);
        expect(lightboxOpen()).toBe(false);
    });
});
