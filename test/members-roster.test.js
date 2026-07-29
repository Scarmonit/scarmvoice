// @vitest-environment jsdom
//
// The members sidebar, driven the way the two presence sources actually drive
// it. Boots the real renderer signed in, then feeds it the shapes the server
// returns: text presence rows that carry a user_id, and /api/board/list voice
// rows that historically did not.
//
// What it protects: the roster joins those two sources by account id, falling
// back to install id. When one side loses its user_id the same person is keyed
// two different ways and rendered TWICE — once from text presence with their
// real status, once from the voice list forced to "online" — so a two-person
// room reports four members, with the same person under both Online and Away.
// It surfaced on window focus, because focus resyncs messages and that is the
// call that overwrote the voice list with the uid-less rows.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RENDERER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');

const noop = () => {};
let onResync = null;
const unsub = () => noop;

// Two people in the voice list. Text presence knows their accounts; the voice
// rows deliberately DO NOT carry user_id — the old server shape, and the exact
// payload that used to double the list.
//
// Note the fake engine below reports isJoined() === false, so THIS install is
// not in a call. Its own row in the list is therefore a leftover — the server
// holds one for twelve seconds past the last heartbeat — and must not be drawn.
// See the "in voice" test at the bottom.
const MEMBERS = [
    { client_id: 'me', user_id: 1, name: 'Me', status: 'away', custom: '' },
    { client_id: 'other', user_id: 2, name: 'Alice', status: 'online', custom: '' }
];
const VOICE_NO_UID = [
    { client_id: 'me', name: 'Me', muted: 0 },
    { client_id: 'other', name: 'Alice', muted: 0 }
];

const $ = (id) => document.getElementById(id);
const rows = () => Array.from(document.querySelectorAll('#members-list li.vp'));
// .vp-name holds the name plus a nested .vp-sub status; take just the name.
const names = () => rows().map((li) => li.querySelector('.vp-name').firstChild.textContent.trim());
const groups = () => Array.from(document.querySelectorAll('#members-list li.mp-group')).map((li) => li.textContent);
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)); };

beforeAll(async () => {
    const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
    document.documentElement.innerHTML = html
        .replace(/<script[\s\S]*?<\/script>/g, '')
        .replace(/^[\s\S]*?<body>/, '<head></head><body>')
        .replace(/<\/body>[\s\S]*$/, '</body>');

    const board = vi.fn(async (route) => {
        const p = String(route).split('?')[0];
        if (p === 'presence') return { success: true, members: MEMBERS };
        if (p === 'list') return { success: true, posts: [], typing: [], voice: VOICE_NO_UID };
        if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
        return { success: true };
    });

    window.lounge = {
        auth: { status: vi.fn(async () => ({ authed: true })), login: vi.fn(async () => ({ success: true })), logout: noop },
        account: {
            register: vi.fn(async () => ({ success: false })), login: vi.fn(async () => ({ success: false })),
            logout: vi.fn(async () => ({ success: true })),
            me: vi.fn(async () => ({ success: true, user: { id: 1, username: 'Me', role: 'member', client_id: 'me' } }))
        },
        board,
        uploadFile: vi.fn(async () => ({ success: true })),
        onUploadProgress: unsub,
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
            start: vi.fn(async () => ({ connected: false })), stop: vi.fn(async () => ({ connected: false })),
            wake: vi.fn(async () => ({ connected: false })),
            send: noop, notifyPosted: noop, sendTyping: noop, sendVoice: noop,
            onMessage: unsub, onStatus: unsub
        },
        edit: { cut: noop, copy: noop, paste: noop, selectAll: noop, clipboard: vi.fn(async () => ({ text: false, image: false })) },
        settings: {
            get: vi.fn(async () => ({
                baseUrl: 'https://scarmonit.com', room: 'lounge', clientId: 'me', displayName: 'Me',
                channel: 'general', theme: 'dark', density: 'cozy', chatFontSize: 'medium',
                showMembers: true, catTextOpen: true, catVoiceOpen: true,
                localVolumes: {}, localMuted: {}, blocked: {}, mutedChannels: [],
                voiceMode: 'open', pttBinding: { type: 'key', code: 'Backquote' }
            })),
            set: vi.fn(async (p) => p)
        },
        ptt: { apply: vi.fn(async () => ({ mode: 'native' })), available: vi.fn(async () => true), describe: vi.fn(async () => 'Backquote'), onChange: unsub },
        win: { minimize: noop, maximize: noop, close: noop, isFocused: vi.fn(async () => true), onFocus: unsub, onHidden: unsub },
        app: {
            version: vi.fn(async () => '0.0.0-test'), isElevated: vi.fn(async () => false),
            openLogs: vi.fn(async () => true), notify: vi.fn(async () => false),
            setVoiceState: vi.fn(async () => ({})), setBadge: vi.fn(async () => true),
            openExternal: vi.fn(async () => true), systemTheme: vi.fn(async () => ({ dark: true })),
            setTheme: vi.fn(async () => true), onThemeChange: unsub, onCommand: unsub,
            // Held: app:resync is what main.js fires on restore-from-tray, and
            // it is the event that now drives a background refresh. The
            // synthetic visibilitychange this spec used to dispatch never
            // reaches the app — backgroundThrottling is off, so Chromium
            // freezes document.hidden at false and never fires it.
            onResync: (cb) => { onResync = cb; return noop; }
        },
        startup: { get: vi.fn(async () => ({ openAtLogin: false, openAsHidden: false })), set: vi.fn(async () => ({ openAtLogin: false, openAsHidden: false })) },
        update: { getState: vi.fn(async () => ({ status: 'idle', noteBlocks: [] })), check: noop, download: noop, install: noop, setAuto: noop, onState: unsub },
        fileUrl: (k) => 'lounge://file/' + encodeURIComponent(k)
    };

    window.hljs = { highlightElement: noop };
    window.HTMLMediaElement.prototype.play = () => Promise.resolve();
    window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || noop;
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 404 }));
    globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((f) => setTimeout(f, 0));

    const run = (f) => new Function(fs.readFileSync(path.join(RENDERER, f), 'utf8')).call(window);
    run('lib.js');
    run('audio.js');
    run('noise.js');
    run('sounds.js');
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

describe('members sidebar', () => {
    it('lists each person once when the voice rows carry no account id', () => {
        // The bug rendered four rows here: Me + Alice from text presence, and
        // Me + Alice again from the voice list under a different key.
        expect(names()).toEqual(['Alice', 'Me']);
        expect(rows()).toHaveLength(2);
    });

    it('keeps each person in one group, with their real status', () => {
        // The duplicate was forced to "online", so the same person appeared
        // under Online AND Away at the same time.
        expect(groups()).toEqual(['Online — 1', 'Away — 1']);
        const me = rows().find((li) => li.dataset.cid === 'me');
        expect(me.classList.contains('away')).toBe(true);
    });

    it('still marks a peer as in voice despite the missing account id', () => {
        // Same root cause as above: the key mismatch also made the roster lose
        // the "in voice" state on the real member row. It is the second line
        // now, not an icon at the far edge.
        const alice = rows().find((li) => li.dataset.cid === 'other');
        expect(alice.querySelector('.vp-sub.in-voice')).toBeTruthy();
        expect(alice.querySelector('.vp-sub').textContent.trim()).toBe('In voice');
    });

    it('does not draw ITSELF into a call it is not in', () => {
        // isJoined() is false here, so the row for our own install id is a
        // twelve-second leftover — which is what an app restarted mid-call by
        // an update comes back up and finds. It used to believe it, and showed
        // the user sitting in a call they had just been restarted out of.
        // Nobody else can tell this process about its own microphone.
        const me = rows().find((li) => li.dataset.cid === 'me');
        expect(me.querySelector('.vp-sub.in-voice')).toBeNull();
        expect(me.querySelector('.vp-sub').textContent.trim()).toBe('Away');
    });

    it('does not duplicate when a resync re-delivers uid-less voice rows', async () => {
        // The restore-from-tray resync is what re-fetched `list` and overwrote
        // the voice roster with the uid-less shape.
        onResync();
        await settle();
        expect(rows()).toHaveLength(2);
        expect(groups()).toEqual(['Online — 1', 'Away — 1']);
    });
});
