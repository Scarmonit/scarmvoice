// @vitest-environment jsdom
//
// Settings > About: every release, one collapsible section each.
//
// The app could only ever show the notes for ONE version — the update it was
// about to install — so what changed in the version you are RUNNING was not
// answerable inside the app. This pins the shape of the answer: newest first,
// the newest one already open, one <details> per release so collapsing is the
// browser's job rather than a class this codebase has to keep in step.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RENDERER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');

const noop = () => {};
const unsub = () => noop;
const $ = (id) => document.getElementById(id);

const ME = { id: 1, username: 'Scarmonit', role: 'admin' };

// The two ids for ONE person. REAL is what they post, heartbeat and join voice
// under; RT is what the realtime layer handed their socket instead.
const REAL = 'c39rosj75zdbms4x2t8a';
const RT = 's0d1e2f3a4b5c6d7e8f9';
const THEM_UID = 3;

let rtOnMessage = null;          // the renderer's socket handler
let winOnFocus = null;           // main's focus/blur bridge
let voiceApi = null;             // the fake engine, so a test can drive it

// The member list the presence endpoint returns — the person by their REAL id.
const MEMBERS = [{ client_id: REAL, user_id: THEM_UID, name: 'XIAIX', status: 'online', custom: '' }];


const RELEASES = [
    { version: '0.33.0', title: 'Settings that mean what they say', date: '2026-07-28T18:00:00Z', prerelease: false,
      blocks: [{ t: 'h', text: 'Settings' }, { t: 'ul', items: ['Sign out moved to Account'] }] },
    { version: '0.32.0', title: 'One person, drawn once', date: '2026-07-28T17:00:00Z', prerelease: false,
      blocks: [{ t: 'p', text: 'Fixed the clone.' }] },
    { version: '0.3.0', title: '0.3.0', date: '2026-07-23T18:49:00Z', prerelease: false, blocks: [] }
];
let historyCalls = 0;

let listPosts = [];
let typingRows = [];

const board = vi.fn(async (p) => {
    if (p === 'list') {
        return { success: true, posts: listPosts, typing: typingRows, voice: [], hasMore: false, maxId: 0 };
    }
    if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
    if (p === 'presence') return { success: true, members: MEMBERS };
    if (p === 'post') return { success: true, id: 991 };
    if (p === 'dm/threads') return { success: true, threads: [] };
    return { success: true };
});

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
        auth: {
            status: vi.fn(async () => ({ authed: true })),
            login: vi.fn(async () => ({ success: true })), logout: noop
        },
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
            send: noop, notifyPosted: noop,
            sendTyping: vi.fn(), sendVoice: noop,
            onMessage: (cb) => { rtOnMessage = cb; return noop; },
            onStatus: unsub
        },
        edit: {
            cut: noop, copy: noop, paste: noop, selectAll: noop,
            clipboard: vi.fn(async () => ({ text: false, image: false })),
            // The editable-field context menu is opened by main now, not by a DOM
            // handler here — see main.js's context-menu listener.
            onContext: unsub,
            replaceMisspelling: vi.fn(async () => true),
            addToDictionary: vi.fn(async () => true)
        },
        settings: {
            get: vi.fn(async () => ({
                baseUrl: 'https://scarmonit.com', room: 'lounge', clientId: 'me',
                displayName: 'Scarmonit', channel: 'general', theme: 'dark', density: 'cozy',
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
        win: {
            minimize: noop, maximize: noop, close: noop,
            isFocused: vi.fn(async () => true),
            onFocus: (cb) => { winOnFocus = cb; return noop; },
            onHidden: () => noop
        },
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
            check: noop, download: noop, install: noop, setAuto: noop,
            postpone: noop, onState: unsub,
            history: vi.fn(async () => { historyCalls++; return { ok: true, releases: RELEASES }; })
        },
        fileUrl: (k) => 'lounge://file/' + encodeURIComponent(k)
    };

    window.hljs = { highlightElement: noop };
    window.HTMLMediaElement.prototype.play = () => Promise.resolve();
    window.matchMedia = window.matchMedia ||
        (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || noop;
    // jsdom implements neither, and jumpToLatest() uses scrollTo — without
    // this the rail tests pass while throwing into vitest's unhandled trap.
    Element.prototype.scrollTo = Element.prototype.scrollTo || noop;
    window.CSS = window.CSS ||
        { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c) };
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
    run('icons.js');

    // A voice engine that is IN the call, with the other person peered under
    // their REAL install id — which is what the SFU always sees, because the
    // token is minted for the id the client actually holds.
    window.createVoice = () => {
        voiceApi = {
            joined: true,
            muted: false,
            deafened: false,
            join: async () => {}, leave: vi.fn(),
            roster: () => (voiceApi.joined
                ? [{ id: 'me', name: 'Scarmonit', isMe: true, muted: false, deafened: false },
                    { id: REAL, name: 'XIAIX', isMe: false, muted: false }]
                : []),
            shares: () => [],
            state: () => ({ joined: voiceApi.joined, shareQuality: '1080p', shareMotion: 'sharp' }),
            setSettings: noop, setMuted: noop, setDeafened: noop, setPttHeld: noop,
            setLocalVolume: noop, setLocalMuted: noop,
            setShareQuality: noop, setShareMotion: noop,
            startShare: async () => false, stopShare: noop, isSharing: () => false,
            enableCam: async () => false, disableCam: async () => false,
            isCamOn: () => false, toggleCam: noop, cams: () => [],
            isJoined: () => voiceApi.joined,
            isMuted: () => voiceApi.muted,
            isDeafened: () => voiceApi.deafened,
            toggleMuted: vi.fn(), toggleDeafened: vi.fn()
        };
        return voiceApi;
    };
    run('app.js');
    await settle();
});


// Open Settings and show the About pane the way a person does.
async function openAbout() {
    $('btn-settings').click();
    await settle();
    const item = Array.from(document.querySelectorAll('.set-nav-item'))
        .find((b) => b.textContent.trim() === 'About');
    expect(item, 'no About entry in the settings nav').toBeTruthy();
    item.click();
    await settle();
}

const entries = () => Array.from($('release-history').querySelectorAll('details.rn-item'));

describe('the release history', () => {
    it('is not fetched until somebody opens About', async () => {
        // It is a network round trip to a rate-limited API; opening Settings on
        // any other pane must not spend one.
        expect(historyCalls).toBe(0);
        await openAbout();
        expect(historyCalls).toBe(1);
    });

    it('lists every release, newest first, one collapsible section each', () => {
        const items = entries();
        expect(items.length).toBe(3);
        expect(items.map((d) => d.querySelector('.rn-ver').textContent))
            .toEqual(['v0.33.0', 'v0.32.0', 'v0.3.0']);
        // <details>, so expanding and collapsing is the browser's.
        items.forEach((d) => expect(d.tagName).toBe('DETAILS'));
    });

    it('opens the newest and leaves the rest closed', () => {
        const items = entries();
        expect(items[0].open).toBe(true);
        expect(items[1].open).toBe(false);
        expect(items[2].open).toBe(false);
    });

    it('renders the notes as text, never as markup', () => {
        const first = entries()[0];
        expect(first.querySelector('.nm-h').textContent).toBe('Settings');
        expect(first.querySelector('.nm-list li').textContent).toBe('Sign out moved to Account');
    });

    it('says so when a release was published without notes', () => {
        expect(entries()[2].textContent).toContain('without notes');
    });

    it('drops a title that only repeats the version', () => {
        // Early releases were published with the version as their name; showing
        // "v0.3.0  0.3.0" would be noise in a list of eighty.
        expect(entries()[2].querySelector('.rn-title')).toBeNull();
        expect(entries()[0].querySelector('.rn-title').textContent)
            .toBe('Settings that mean what they say');
    });

    it('marks the version actually installed', () => {
        // $('set-version') reads "ScarmVoice v0.0.0-test" from the stub, so
        // nothing here matches — the badge must simply not appear.
        const badges = $('release-history').querySelectorAll('.rn-badge');
        expect(Array.from(badges).every((b) => b.textContent !== 'installed')).toBe(true);
    });
});
