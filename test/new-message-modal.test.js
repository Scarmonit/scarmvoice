// @vitest-environment jsdom
//
// The New Message modal — the + beside Direct Messages — and the one thing this
// file is really guarding: that it did not become a SECOND group-DM
// implementation.
//
// Group conversations already existed end to end before this modal did:
// `dm_threads.is_group` and `dm_members` on the server, `dm/create` with a list
// of users and `dm/manage` for add/rename/leave, the group header with its Add
// People and Leave Group menu, `.dm-group` rows with a stack of faces in the
// sidebar, and a ten-person cap enforced by dm/create.js AND dm/manage.js.
// What was missing was a way to START one that looked like anything.
//
// So the modal is a LAYOUT of the picker that was already there, sharing its
// selection state, its member directory, its cap and its create path — and
// these tests assert exactly that, because the tempting version of this feature
// is a new modal with its own `POST dm/create` and its own idea of the cap.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RENDERER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');

const noop = () => {};
const unsub = () => noop;
const $ = (id) => document.getElementById(id);

const ME = { id: 1, username: 'Me', role: 'member' };
const USERS = [
    ME,
    { id: 2, username: 'alice', role: 'admin' },
    { id: 3, username: 'bob', role: 'member' },
    { id: 4, username: 'carol', role: 'member' }
];

// alice is signed in on an install whose display name differs from her account,
// which is what the modal's two identity lines are for.
const PRESENCE = [{ client_id: 'c-alice', user_id: 2, name: 'Alice Liddell', status: 'online' }];

const board = vi.fn(async (p) => {
    if (p === 'account/users') return { success: true, users: USERS };
    if (p === 'dm/threads') return { success: true, threads: [] };
    if (p === 'dm/create') {
        return { success: true, thread: { id: 90, isGroup: true, title: 'alice, bob', members: [] } };
    }
    if (p === 'list') return { success: true, posts: [], typing: [], voice: [], hasMore: false, maxId: 0 };
    if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
    if (p === 'presence') return { success: true, members: PRESENCE };
    return { success: true };
});

const rows = () => Array.from($('dm-picker-list').querySelectorAll('.dm-pick-person'));
const rowFor = (name) => rows().find((r) => r.querySelector('.dm-pick-handle').textContent === name);

async function settle(n = 14) {
    for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeAll(async () => {
    const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
    document.documentElement.innerHTML = html
        .replace(/<script[\s\S]*?<\/script>/g, '')
        .replace(/^[\s\S]*?<body>/, '<head></head><body>')
        .replace(/<\/body>[\s\S]*$/, '</body>');

    window.lounge = {
        auth: { status: vi.fn(async () => ({ authed: true })), login: vi.fn(async () => ({ success: true })), logout: noop },
        account: {
            register: vi.fn(async () => ({ success: false })),
            login: vi.fn(async () => ({ success: false })),
            logout: vi.fn(async () => ({ success: true })),
            verify: vi.fn(async () => ({ success: false })),
            resend: vi.fn(async () => ({ success: false })),
            removal: vi.fn(async () => ({ success: false })),
            me: vi.fn(async () => ({ success: true, user: ME }))
        },
        board,
        uploadFile: vi.fn(async () => ({ success: true })),
        uploadAttachment: vi.fn(async () => ({ success: true })),
        onUploadProgress: unsub,
        pathForFile: () => '',
        saveAttachment: vi.fn(async () => ({ success: true })),
        downloadAttachment: vi.fn(async () => ({ success: true })),
        copyImage: vi.fn(async () => ({ success: true })),
        revealFile: noop,
        unfurl: vi.fn(async () => null),
        youtube: vi.fn(async () => null),
        fetchImage: vi.fn(async () => ({ success: false })),
        share: { sources: vi.fn(async () => []), select: noop, cancel: noop },
        voiceToken: vi.fn(async () => ({ success: false })),
        rt: {
            start: vi.fn(async () => ({ connected: false })),
            stop: vi.fn(async () => ({ connected: false })),
            wake: vi.fn(async () => ({ connected: false })),
            send: noop, notifyPosted: noop, sendTyping: vi.fn(), sendVoice: noop,
            onMessage: unsub, onStatus: unsub
        },
        edit: {
            cut: noop, copy: noop, paste: noop, selectAll: noop,
            clipboard: vi.fn(async () => ({ text: false, image: false })),
            onContext: unsub,
            replaceMisspelling: vi.fn(async () => true),
            addToDictionary: vi.fn(async () => true)
        },
        settings: {
            get: vi.fn(async () => ({
                baseUrl: 'https://scarmonit.com', room: 'lounge', clientId: 'me',
                displayName: 'Me', channel: 'general', theme: 'dark', density: 'cozy',
                chatFontSize: 'medium', showMembers: true, catTextOpen: true,
                catDmsOpen: true, catVoiceOpen: true,
                localVolumes: {}, localMuted: {}, blocked: {}, mutedChannels: [],
                voiceMode: 'open', pttBinding: { type: 'key', code: 'Backquote' }
            })),
            set: vi.fn(async (p) => p)
        },
        ptt: {
            apply: vi.fn(async () => ({ mode: 'native' })),
            available: vi.fn(async () => true),
            describe: vi.fn(async () => 'Backquote'), onChange: unsub
        },
        win: { minimize: noop, maximize: noop, close: noop, isFocused: vi.fn(async () => true), onFocus: unsub, onHidden: unsub },
        app: {
            version: vi.fn(async () => '0.0.0-test'), isElevated: vi.fn(async () => false),
            openLogs: vi.fn(async () => true), notify: vi.fn(async () => false),
            setVoiceState: vi.fn(async () => ({})), setBadge: vi.fn(async () => true),
            openExternal: vi.fn(async () => true), systemTheme: vi.fn(async () => ({ dark: true })),
            setTheme: vi.fn(async () => true), onThemeChange: unsub, onCommand: unsub, onResync: unsub
        },
        startup: {
            get: vi.fn(async () => ({ openAtLogin: false, openAsHidden: false })),
            set: vi.fn(async () => ({ openAtLogin: false, openAsHidden: false }))
        },
        update: {
            getState: vi.fn(async () => ({ status: 'idle', noteBlocks: [] })),
            check: noop, download: noop, install: noop, setAuto: noop, postpone: noop, onState: unsub
        },
        fileUrl: (k) => 'lounge://file/' + encodeURIComponent(k)
    };

    window.hljs = { highlightElement: noop };
    window.HTMLMediaElement.prototype.play = () => Promise.resolve();
    window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || noop;
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 404 }));
    globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((f) => setTimeout(f, 0));

    const run = (f) => new Function(fs.readFileSync(path.join(RENDERER, f), 'utf8')).call(window);
    // The composer IS a CodeMirror instance now, so the editor has to be on
    // window before app.js runs.
    run('vendor/codemirror.js');
    run('lib.js');
    run('audio.js');
    run('noise.js');
    run('sounds.js');
    run('theme.js');
    run('icons.js');
    window.createVoice = () => ({
        join: async () => {}, leave: noop, roster: () => [], shares: () => [],
        state: () => ({ joined: false, shareQuality: '1080p', shareMotion: 'sharp' }),
        setSettings: noop, setMuted: noop, setDeafened: noop, setPttHeld: noop,
        setLocalVolume: noop, setLocalMuted: noop,
        setShareQuality: noop, setShareMotion: noop,
        startShare: async () => false, stopShare: noop, isSharing: () => false,
        enableCam: async () => false, disableCam: async () => false,
        isCamOn: () => false, toggleCam: noop, cams: () => [],
        isJoined: () => false, isMuted: () => false, isDeafened: () => false
    });
    run('app.js');
    await settle();
});

describe('the + beside Direct Messages', () => {
    it('says what it does on hover, in this app’s own tooltip', () => {
        // data-tip, not title: the app draws its own tooltips, and a native one
        // would arrive a second later saying the same thing twice.
        for (const id of ['btn-new-dm', 'btn-new-dm-2']) {
            expect($(id).getAttribute('data-tip')).toBe('Create Message');
            expect($(id).getAttribute('title')).toBeNull();
        }
    });

    it('opens the New Message modal, not the palette', async () => {
        $('btn-new-dm').click();
        await settle();
        expect($('dm-picker').hidden).toBe(false);
        expect($('dm-picker-wrap').classList.contains('dm-picker--roster')).toBe(true);
        expect($('dm-picker-title').textContent).toBe('New Message');
        expect($('dm-picker-sub').textContent).toBe('Group DMs can have up to 10 members.');
        expect($('dm-picker-sub').hidden).toBe(false);
        expect($('dm-picker-search').placeholder).toBe('Search');
    });

    it('puts the head inside the card, as ONE element rather than a copy', () => {
        // Moved, not duplicated — there is exactly one #dm-picker-title in the
        // document, and in this layout it lives in the card.
        expect(document.querySelectorAll('#dm-picker-title').length).toBe(1);
        expect($('dm-picker-head').closest('.dm-picker-card')).not.toBeNull();
    });

    it('lists board members with a face, both names and a checkbox', () => {
        expect(rows().length).toBe(3);              // everyone but me
        const alice = rowFor('alice');
        expect(alice).toBeTruthy();
        // The display name this install is posting under, over the account it
        // belongs to — the reference's two lines, sourced honestly.
        expect(alice.querySelector('.dm-pick-name').textContent).toBe('Alice Liddell');
        expect(alice.querySelector('.dm-pick-handle').textContent).toBe('alice');
        expect(alice.querySelector('.dm-pick-av')).not.toBeNull();
        expect(alice.querySelector('.dm-pick-box')).not.toBeNull();
        // Somebody the roster has never seen shows the account on both lines,
        // which is what the reference does for a person with no display name.
        expect(rowFor('bob').querySelector('.dm-pick-name').textContent).toBe('bob');
    });

    it('offers no jump rows — this asks who, not where', () => {
        expect($('dm-picker-list').querySelector('.dm-pick-hash')).toBeNull();
        expect($('dm-picker-list').querySelector('.dm-pick-head')).toBeNull();
    });

    it('has Cancel and Create Message from the first frame', () => {
        expect($('dm-picker-actions').hidden).toBe(false);
        expect($('dm-picker-ok').textContent).toBe('Create Message');
        expect($('dm-picker-ok').disabled).toBe(true);   // nothing picked yet
        expect($('dm-picker-cancel')).not.toBeNull();
        expect($('dm-picker-close').hidden).toBe(false);
    });

    it('searches both the display name and the account', () => {
        const search = $('dm-picker-search');
        search.value = 'liddell';                 // display name only
        search.dispatchEvent(new window.Event('input', { bubbles: true }));
        expect(rows().length).toBe(1);
        search.value = 'alice';                   // account only
        search.dispatchEvent(new window.Event('input', { bubbles: true }));
        expect(rows().length).toBe(1);
        search.value = '';
        search.dispatchEvent(new window.Event('input', { bubbles: true }));
        expect(rows().length).toBe(3);
    });

    it('multi-selects, and says so on the row and to a screen reader', () => {
        rowFor('alice').click();
        expect(rowFor('alice').classList.contains('on')).toBe(true);
        expect(rowFor('alice').getAttribute('aria-checked')).toBe('true');
        expect($('dm-picker-ok').disabled).toBe(false);

        rowFor('bob').click();
        expect(rowFor('bob').classList.contains('on')).toBe(true);
        // The label does NOT change with the count: the ticks are the count.
        expect($('dm-picker-ok').textContent).toBe('Create Message');

        rowFor('bob').click();                    // and off again
        expect(rowFor('bob').classList.contains('on')).toBe(false);
        expect(rowFor('bob').getAttribute('aria-checked')).toBe('false');
    });

    it('creates through the group-DM path that already existed', async () => {
        rowFor('bob').click();                    // alice + bob = a group
        board.mockClear();
        $('dm-picker-ok').click();
        await settle();
        const call = board.mock.calls.find((c) => c[0] === 'dm/create');
        expect(call).toBeTruthy();
        expect(call[1].body.users.sort()).toEqual([2, 3]);
        // ONE create path. A modal with its own endpoint is the failure this
        // test exists to catch.
        expect(board.mock.calls.filter((c) => c[0] === 'dm/create').length).toBe(1);
        expect($('dm-picker').hidden).toBe(true);
    });

    it('goes back to the palette shape once it is closed', async () => {
        // The palette is still there behind "Find or start a conversation" and
        // answers a different question; closing the modal must not leave it
        // wearing the modal's layout.
        $('dm-find').click();
        await settle();
        expect($('dm-picker-wrap').classList.contains('dm-picker--roster')).toBe(false);
        expect($('dm-picker-title').textContent).toBe('Search for channels, conversations or people');
        expect($('dm-picker-head').closest('.dm-picker-card')).toBeNull();
        expect($('dm-picker-close').hidden).toBe(true);
        // …and it offers jumps again, which the modal does not.
        expect($('dm-picker-list').querySelector('.dm-pick-hash')).not.toBeNull();
        $('dm-picker-cancel').click();
    });
});

describe('the ten-person cap', () => {
    it('is the server’s number, counted the same way on both sides', () => {
        const app = fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');
        expect(app).toMatch(/const DM_GROUP_MAX = 10;/);
        // Counted as "already in it, plus the ticks" — not "me plus the ticks",
        // which let you tick five more people into a group of eight and find out
        // from the server.
        expect(app).toMatch(/dmPick\.chosen\.size \+ dmPick\.have >= DM_GROUP_MAX/);
        // The subtitle says the number rather than hard-coding a second copy.
        expect(app).toMatch(/Group DMs can have up to ' \+ DM_GROUP_MAX \+ ' members\./);
    });
});
