// @vitest-environment jsdom
//
// A profile picture is drawn OVER the generated initials, and `.has-img` makes
// those initials transparent so they don't show through it. That is the whole
// reason wireAvatarFallback() exists: a picture that fails to load takes itself
// back off and drops the class, which puts the letters back.
//
// Every surface that draws a face wires it — messages, both member lists, the
// voice roster, the popover, the me-bar, the settings card. The four DM ones
// were built without it, so a picture that failed to arrive there left an
// EMPTY circle: no image, and initials the stylesheet had already turned
// transparent for it.
//
// The bytes come through lounge://, which is a proxy to a cookie-gated endpoint
// in the main process, so "failed to arrive" is an ordinary outcome — a dropped
// connection, an avatar deleted between the map being fetched and the row being
// drawn — not a hypothetical.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { bootRenderer, settle, $ } from './helpers/renderer.js';

const ME = { id: 1, username: 'Me', role: 'member' };
const ALICE = { id: 2, username: 'Alice', role: 'member' };

const THREAD = {
    id: 40, title: 'Alice', isGroup: false,
    user: ALICE, members: [ME, ALICE], unread: 0
};

const board = vi.fn(async (p) => {
    // Both people have a picture, so every face below is drawn as an image.
    if (p === 'avatars') return { success: true, avatars: { 1: 'r2/me.png', 2: 'r2/alice.png' } };
    if (p === 'dm/threads') return { success: true, threads: [THREAD] };
    if (p === 'dm/list') return { success: true, thread: THREAD, messages: [] };
    if (p === 'list') return { success: true, posts: [], typing: [], voice: [], hasMore: false };
    if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
    if (p === 'presence') return { success: true, members: [] };
    return { success: true };
});

// The failure the fallback is for: the <img> never loads and fires 'error'.
function failTheImage(root) {
    const img = root.querySelector('img.avatar-img');
    expect(img, 'expected a picture to be drawn here').toBeTruthy();
    const holder = img.parentElement;
    expect(holder.classList.contains('has-img')).toBe(true);
    img.dispatchEvent(new window.Event('error'));
    return holder;
}

// After the fallback runs there must be no image AND no .has-img, because the
// class alone is enough to keep the letters invisible.
function expectLettersBack(holder, initials) {
    expect(holder.querySelector('img.avatar-img')).toBeNull();
    expect(holder.classList.contains('has-img')).toBe(false);
    expect(holder.textContent).toContain(initials);
}

beforeAll(async () => {
    await bootRenderer({ board, user: ME });
    $('dm-list').querySelector('.dm-row').click();
    await settle();
});

describe('a DM avatar that cannot be loaded', () => {
    it('falls back to initials in the conversation list', () => {
        // Re-rendered by openDm(), so re-read the row rather than caching it.
        const row = $('dm-list').querySelector('.dm-row');
        expectLettersBack(failTheImage(row), 'A');
    });

    it('falls back to initials in the conversation header', () => {
        expectLettersBack(failTheImage($('dm-head-face')), 'A');
    });

    it('falls back to initials in the profile column', () => {
        expectLettersBack(failTheImage($('dm-prof-face')), 'A');
    });

    it('falls back to initials in the start-of-conversation block', () => {
        const intro = $('dm-messages').querySelector('.dm-intro');
        expect(intro).toBeTruthy();
        expectLettersBack(failTheImage(intro), 'A');
    });
});
