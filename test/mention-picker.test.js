// @vitest-environment jsdom
//
// THE @MENTION LIST: who is in it, and what their face looks like.
//
// Two things were wrong, and they had the same cause. The list was built from
// `getRoster()` — the names SEEN this session, i.e. whoever happened to be
// online or to have said something while the app was open. So:
//
//   • Somebody OFFLINE could not be mentioned at all. They were not in the
//     list, and nothing on screen said why: you typed their name and the
//     autocomplete simply had no such person.
//   • A name is a string, and a string has no account behind it — so the row
//     was drawn as initials on a gradient even for people whose picture is on
//     every other surface in the app.
//
// The account directory answers both: it is the whole membership whatever their
// status, and it carries the account id the picture is keyed by.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { bootRenderer, settle, cmEditor, $ } from './helpers/renderer.js';

const ME = { id: 1, username: 'Me', role: 'member' };
const XIAIX = { id: 2, username: 'XIAIX', role: 'member' };      // online, has a picture
const OFFLINE = { id: 3, username: 'Xander', role: 'member' };   // never seen this session
const BANNED = { id: 4, username: 'Xorn', role: 'member', banned: 1 };

// Only XIAIX is in the presence table — the others are directory-only, which is
// what "offline" means here.
const MEMBERS = [
    { client_id: 'me', user_id: 1, name: 'Me', status: 'online', custom: '' },
    { client_id: 'x', user_id: 2, name: 'XIAIX', status: 'online', custom: '' }
];

const AVATARS = { 2: 'avatars/xiaix.png' };

const board = vi.fn(async (route) => {
    const p = String(route).split('?')[0];
    if (p === 'avatars') return { success: true, avatars: AVATARS };
    if (p === 'presence') return { success: true, members: MEMBERS };
    if (p === 'list') return { success: true, posts: [], typing: [], voice: [], hasMore: false };
    if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
    if (p === 'account/users') return { success: true, users: [ME, XIAIX, OFFLINE, BANNED] };
    if (p === 'dm/threads') return { success: true, threads: [] };
    return { success: true };
});

function put(text) {
    const cm = cmEditor();
    cm.setValue('');
    cm.replaceRange(String(text), { line: 0, ch: 0 }, null, '+input');
    cm.getInputField().focus();
    return cm;
}

const rows = () => Array.from(document.querySelectorAll('.mention-pop .mention-item'));
const names = () => rows().map((r) => r.querySelector('.mention-title').textContent);
const faceOf = (name) => {
    const i = names().indexOf(name);
    return i === -1 ? null : rows()[i].querySelector('.mention-av');
};

beforeAll(async () => {
    await bootRenderer({ user: ME, board });
    await settle(10);
});

beforeEach(() => { cmEditor().setValue(''); });

describe('who the list offers', () => {
    it('includes a member who is offline and has never spoken', async () => {
        put('@X');
        await settle(2);
        expect(names()).toContain('Xander');
    });

    it('includes the ones who are here too', async () => {
        put('@X');
        await settle(2);
        expect(names()).toEqual(expect.arrayContaining(['XIAIX', 'Xander']));
    });

    it('lists everybody when nothing has been typed after the @', async () => {
        put('@');
        await settle(2);
        expect(names()).toEqual(expect.arrayContaining(['XIAIX', 'Xander']));
    });

    it('leaves out the banned and leaves out you', async () => {
        put('@');
        await settle(2);
        expect(names()).not.toContain('Xorn');
        expect(names()).not.toContain('Me');
    });

    it('puts the names that start with what was typed first', async () => {
        // Both contain "an"; only one starts with it.
        put('@Xan');
        await settle(2);
        expect(names()[0]).toBe('Xander');
    });

    it('still picks the name into the message', async () => {
        put('@Xan');
        await settle(2);
        rows()[0].dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
        await settle(2);
        expect(cmEditor().getValue()).toBe('@Xander ');
    });
});

describe('the face beside each name', () => {
    it('is the real profile picture when there is one', async () => {
        put('@XI');
        await settle(2);
        const av = faceOf('XIAIX');
        expect(av, 'XIAIX is not in the list').toBeTruthy();
        const img = av.querySelector('img.avatar-img');
        expect(img, 'the mention row drew no picture').toBeTruthy();
        expect(img.getAttribute('src')).toContain('avatars%2Fxiaix.png');
        expect(av.classList.contains('has-img')).toBe(true);
    });

    it('keeps the initials underneath, for while it loads and if it fails', async () => {
        put('@XI');
        await settle(2);
        const av = faceOf('XIAIX');
        expect(av.textContent).toBe('XI');
    });

    it('falls back to initials for somebody with no picture', async () => {
        put('@Xan');
        await settle(2);
        const av = faceOf('Xander');
        expect(av.querySelector('img.avatar-img')).toBe(null);
        expect(av.classList.contains('has-img')).toBe(false);
        expect(av.textContent).toBe('XA');
    });
});
