// @vitest-environment jsdom
//
// The conversation view's own state, as opposed to what a message in it can do
// (that is dm-actions.test.js). Both bugs pinned here come from the same root:
// renderDmHead()/renderDmMessages() run on every DM poll, and they used to
// overwrite things the reader had just decided.
//
//   • The inline editor. The main list and the thread panel both refuse to
//     repaint over an open one; this list did not, so editing your own DM and
//     having the other person reply threw away whatever you had typed.
//   • The profile column. Hiding it lasted exactly one poll — twelve seconds —
//     and then it reopened itself with the toggle still claiming it was off.
//
// Neither is reachable from a test that only ever looks at a channel, and
// neither is visible in a screenshot taken inside one poll interval.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RENDERER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');

const noop = () => {};
let onResync = null;
const unsub = () => noop;
const $ = (id) => document.getElementById(id);

const ME = { id: 1, username: 'Me', role: 'member' };
const THEM = { id: 2, username: 'Alice', role: 'member' };
const THIRD = { id: 3, username: 'Bob', role: 'member' };

const PAIR = { id: 40, title: 'Alice', isGroup: false, user: THEM, members: [ME, THEM], unread: 0 };
const GROUP = { id: 41, title: 'The Three', isGroup: true, user: null, members: [ME, THEM, THIRD], unread: 0 };

// Mutable, so a test can make a message arrive between polls.
let pairMessages = [
    { id: 501, from: THEM.id, body: 'have a look at this', created_at: 1700000000000 },
    { id: 502, from: ME.id, body: 'mine to edit', created_at: 1700000060000 }
];

// Deliberately id 501, the same number as the first DM above: a post id and a
// DM id come out of two different tables and both sequences start at 1.
const POST = {
    id: 501, body: 'look at https://example.com/thing', name: 'Alice',
    client_id: 'alice', user_id: THEM.id, created_at: 1700000000000, reactions: [], pinned: 0
};

// Held open so the unfurl lands AFTER the conversation is on screen, which is
// the only moment the two lists are both in the DOM.
let resolveUnfurl = null;

const board = vi.fn(async (p, opts) => {
    if (p === 'dm/threads') return { success: true, threads: [PAIR, GROUP] };
    if (p === 'dm/list') {
        const thread = (opts && opts.query && opts.query.thread) === GROUP.id ? GROUP : PAIR;
        return { success: true, thread, messages: thread === GROUP ? [] : pairMessages };
    }
    if (p === 'list') return { success: true, posts: [POST], typing: [], voice: [], hasMore: false, maxId: 501 };
    if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
    if (p === 'presence') return { success: true, members: [] };
    // The palette asks for the directory when it opens.
    if (p === 'account/users') return { success: true, users: [THEM, THIRD] };
    return { success: true };
});

async function settle(n = 14) {
    for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

// What the DM poll does to the view, without waiting twelve real seconds for
// it: the resync handler runs the same loadDmMessages() -> renderDmHead() /
// renderDmMessages() pass.
async function poll() {
    if (onResync) onResync();
    await settle();
}

const dmRow = (id) => $('dm-messages').querySelector(`.msg[data-id="${id}"]`);

async function openThreadRow(nth) {
    const rows = $('dm-list').querySelectorAll('.dm-row');
    rows[nth].click();
    await settle();
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
        unfurl: vi.fn(() => new Promise((r) => { resolveUnfurl = r; })),
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
            onMessage: unsub, onStatus: unsub
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
        win: {
            minimize: noop, maximize: noop, close: noop,
            isFocused: vi.fn(async () => true), onFocus: unsub, onHidden: unsub
        },
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
        startup: {
            get: vi.fn(async () => ({ openAtLogin: false, openAsHidden: false })),
            set: vi.fn(async () => ({ openAtLogin: false, openAsHidden: false }))
        },
        update: {
            getState: vi.fn(async () => ({ status: 'idle', noteBlocks: [] })),
            check: noop, download: noop, install: noop, setAuto: noop,
            postpone: noop, onState: unsub
        },
        fileUrl: (k) => 'lounge://file/' + encodeURIComponent(k)
    };

    window.hljs = { highlightElement: noop };
    window.HTMLMediaElement.prototype.play = () => Promise.resolve();
    window.matchMedia = window.matchMedia ||
        (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || noop;
    // jsdom ships no CSS global at all, and graft() escapes the preview url with
    // CSS.escape — so without this the grafting below throws into a .catch() and
    // the test sees "no preview" for the wrong reason entirely.
    window.CSS = window.CSS ||
        { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c) };
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
    await openThreadRow(0);          // the pair conversation
});

describe('editing a message inside a conversation', () => {
    it('survives a message arriving while the editor is open', async () => {
        dmRow(502).querySelector('[data-act="edit"]').click();
        const ta = dmRow(502).querySelector('.msg-edit textarea');
        expect(ta).toBeTruthy();
        ta.value = 'half a sentence';

        // Alice replies. The poll's payload changes, and the list would have
        // been rebuilt out from under the textarea.
        pairMessages = pairMessages.concat(
            [{ id: 503, from: THEM.id, body: 'and another thing', created_at: 1700000120000 }]);
        await poll();

        const still = $('dm-messages').querySelector('.msg-edit textarea');
        expect(still).toBeTruthy();
        expect(still.value).toBe('half a sentence');
        // Held back, not lost.
        expect(dmRow(503)).toBeNull();
    });

    it('paints what it held back as soon as the editor closes', async () => {
        $('dm-messages').querySelector('.msg-edit textarea')
            .dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await settle();

        expect($('dm-messages').querySelector('.msg-edit')).toBeNull();
        // Without the repaint on close this waited for a poll whose payload had
        // already been recorded as rendered — so it waited indefinitely.
        expect(dmRow(503)).toBeTruthy();
    });
});

describe('the profile column', () => {
    it('opens with the conversation', () => {
        expect($('dm-profile').hidden).toBe(false);
        expect($('dm-prof-toggle').hidden).toBe(false);
    });

    it('stays closed once it is closed', async () => {
        $('dm-prof-toggle').click();
        expect($('dm-profile').hidden).toBe(true);
        expect($('dm-prof-toggle').getAttribute('aria-pressed')).toBe('false');

        // The bug: renderDmProfile() ran on every poll and set hidden from the
        // conversation alone, so this reopened within twelve seconds.
        await poll();
        expect($('dm-profile').hidden).toBe(true);
        expect($('dm-prof-toggle').getAttribute('aria-pressed')).toBe('false');

        $('dm-prof-toggle').click();
        expect($('dm-profile').hidden).toBe(false);
    });

    it('goes away entirely in a group, button and all', async () => {
        await openThreadRow(1);
        expect($('dm-panel').classList.contains('is-group')).toBe(true);
        expect($('dm-profile').hidden).toBe(true);
        // Left up, this opened the aside still holding the LAST pair
        // conversation's profile — Alice's name and face over a group chat.
        expect($('dm-prof-toggle').hidden).toBe(true);
    });
});

// The palette behind "Find or start a conversation". It has to be drivable from
// the keyboard alone — a palette you have to reach for the mouse in is not one —
// and it carries two kinds of row that Enter must treat differently: a place to
// GO, and a person to START a conversation with.
describe('the find-or-start palette', () => {
    const rows = () => [...document.querySelectorAll('#dm-picker-list .dm-pick-row')];
    const key = (k) => {
        $('dm-picker-search').dispatchEvent(
            new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    };
    const open = async () => { $('dm-find').click(); await settle(30); };

    it('pre-selects the first row, so Enter always has an answer', async () => {
        await open();
        const r = rows();
        expect(r.length).toBeGreaterThan(1);
        expect(r[0].classList.contains('cursor')).toBe(true);
        expect(r.filter((x) => x.classList.contains('cursor'))).toHaveLength(1);
    });

    it('moves the cursor with the arrows, and clamps at both ends', async () => {
        await open();
        key('ArrowDown');
        expect(rows()[1].classList.contains('cursor')).toBe(true);
        key('ArrowUp');
        expect(rows()[0].classList.contains('cursor')).toBe(true);
        key('ArrowUp');                                   // already at the top
        expect(rows()[0].classList.contains('cursor')).toBe(true);
        key('End');
        expect(rows()[rows().length - 1].classList.contains('cursor')).toBe(true);
        key('ArrowDown');                                 // already at the bottom
        expect(rows()[rows().length - 1].classList.contains('cursor')).toBe(true);
        key('Home');
        expect(rows()[0].classList.contains('cursor')).toBe(true);
    });

    it('goes where the cursor is when you press Enter', async () => {
        await open();
        // The first section is "Jump to", and its first row is a channel.
        expect(rows()[0].textContent).toContain('general');
        key('Enter');
        await settle(30);
        // It closed and left the conversation for the channel.
        expect($('dm-picker').hidden).toBe(true);
    });

    it('shows the confirm pair only while somebody is picked', async () => {
        await open();
        expect($('dm-picker-actions').hidden).toBe(true);
        // …and the hint teaches the keys rather than describing a button.
        expect($('dm-picker-hint').textContent).toContain('Enter');
        // Picked through the list rather than through Enter, which on a FIRST
        // pick opens that conversation outright instead of composing a group.
        rows()[rows().length - 1].click();
        await settle(30);
        expect($('dm-picker-actions').hidden).toBe(false);
        expect($('dm-picker-hint').textContent).toContain('group');
    });
});

// A link preview is fetched asynchronously and grafted into the live row when it
// lands, by id. Post ids and DM ids come from different tables and collide, so
// the id alone was never enough to say which row it belonged to.
describe('a late link preview', () => {
    it('lands on the channel message and not on the DM that shares its id', async () => {
        await openThreadRow(0);                    // the pair, which holds DM 501
        expect(dmRow(501)).toBeTruthy();
        expect(resolveUnfurl).toBeTruthy();

        resolveUnfurl({
            success: true,
            preview: { url: 'https://example.com/thing', title: 'A thing', site: 'example.com' }
        });
        await settle();

        const inChannel = $('messages').querySelector('.msg[data-id="501"] .link-card');
        const inDm = dmRow(501).querySelector('.link-card');
        expect(inChannel).toBeTruthy();
        expect(inDm).toBeNull();
    });
});
