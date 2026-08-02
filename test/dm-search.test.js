// @vitest-environment jsdom
//
// Search in a conversation is the CHANNEL'S search, not a second one.
//
// It used to be a second one: #dm-search-input, 60 characters, a substring
// match on the bodies that happened to be loaded. No operators, no dropdown, no
// More filters, no archive — and no way for any of that to arrive, because
// every feature added to the real search was added to the other box.
//
// The fix is not a better second box. #search-box, #search-pop and
// #search-panel are MOVED into the conversation header, the one `filter` object
// narrows whichever list is on screen through the one matcher in lib.js, and
// the archive half asks /api/board/dm/search instead of /api/board/search.
// These tests assert the sharing, because a copy is what would drift.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RENDERER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');

const noop = () => {};
const unsub = () => noop;
const $ = (id) => document.getElementById(id);

const ME = { id: 1, username: 'Me', role: 'member' };
const THEM = { id: 2, username: 'alice', role: 'member' };
// A SECOND conversation, because "All conversations" is a scope this box
// offers and a result set that can only ever come from one conversation cannot
// exercise it.
const THIRD = { id: 3, username: 'bob', role: 'member' };
const THREAD = { id: 40, title: 'alice', isGroup: false, user: THEM, members: [ME, THEM], unread: 0 };
const OTHER = { id: 41, title: 'bob', isGroup: false, user: THIRD, members: [ME, THIRD], unread: 0 };

const DM_MESSAGES = [
    { id: 501, from: THEM.id, body: 'the logo is attached', created_at: 1700000000000, pinned: 0, reactions: [] },
    {
        id: 502, from: THEM.id, body: '', created_at: 1700000060000,
        att_key: 'board/pic.png', att_name: 'logo.png', att_type: 'image/png', att_size: 2048,
        pinned: 1, reactions: []
    },
    { id: 503, from: ME.id, body: 'thanks, got it', created_at: 1700000120000, pinned: 0, reactions: [] }
];

// Both hits carry `thread` — the conversation they came from — which is the
// field dm/search answers with and the one dmResultTitle already reads to put
// a name on the row. The second one belongs to the OTHER conversation, which
// is what an All Conversations search returns and what clicking one has to be
// able to reach.
const ARCHIVE = [{
    id: 480, name: 'alice', user_id: 2, client_id: 'dm-user-2',
    body: 'an older mention of the logo', att_name: '', created_at: 1699990000000,
    thread_root_id: 0, isDm: true, thread: 40, isGroup: false, title: ''
}, {
    id: 481, name: 'bob', user_id: 3, client_id: 'dm-user-3',
    body: 'the logo bob sent, in another conversation', att_name: '', created_at: 1699980000000,
    thread_root_id: 0, isDm: true, thread: 41, isGroup: false, title: ''
}];

const board = vi.fn(async (p, opts) => {
    if (p === 'dm/threads') return { success: true, threads: [THREAD, OTHER] };
    if (p === 'dm/list') {
        // Answer for the thread that was actually asked for, so a test can tell
        // "it switched conversations" from "it stayed where it was".
        const want = (opts && opts.query && opts.query.thread) === OTHER.id ? OTHER : THREAD;
        return { success: true, thread: want, messages: want === THREAD ? DM_MESSAGES : [] };
    }
    if (p === 'dm/search') return { success: true, results: ARCHIVE, scope: 'conversation', thread: 40 };
    if (p === 'dm/pins') return { success: true, thread: 40, pins: [] };
    if (p === 'dm/reply-threads') return { success: true, thread: 40, threads: [] };
    if (p === 'search') return { success: true, results: [] };
    if (p === 'list') return { success: true, posts: [], typing: [], voice: [], hasMore: false, maxId: 0 };
    if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
    if (p === 'presence') return { success: true, members: [] };
    if (p === 'account/users') return { success: true, users: [ME, THEM, THIRD] };
    return { success: true };
});

const shownIds = () =>
    Array.from($('dm-messages').querySelectorAll('.msg')).map((el) => parseInt(el.dataset.id, 10));

// The realtime relay, captured below. A `posted` nudge for the channel behind
// the conversation is the shortest honest route to "the channel column
// repainted while a conversation is on screen" — the same thing its own poll
// does every minute. (onResync is no good for it: that callback reloads the
// CONVERSATION too, so it hides exactly the interleaving being tested.)
let rtMessage = null;

async function settle(n = 14) {
    for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

async function type(value) {
    const box = $('search-input');
    box.value = value;
    box.dispatchEvent(new window.Event('input', { bubbles: true }));
    await settle();
}

// The ARCHIVE half is behind a real 220 ms debounce (app.js: the search input's
// `input` listener arms `setTimeout(runSearch, 220)`). Counting zero-delay ticks
// does not clear a wall-clock timer — it only clears it if the ticks happen to
// take long enough, which is a property of how loaded the machine is and not of
// the code under test.
//
// That is what made "jumps into the conversation a hit actually came from" fail
// roughly one full run in two while passing every time the file ran alone:
// measured, its `type()` + `settle(20)` came to ~256 ms against a 220 ms timer,
// so ~36 ms of margin decided it. Every other archive test in this file happens
// to have accumulated 400-500 ms by the time it asks, which is why only that one
// ever went red. Waiting the timer out is the fix; the tick loop after it is
// still needed for the fetch-and-render chain the timer starts.
async function settleSearch() {
    await new Promise((r) => setTimeout(r, 300));
    await settle(20);
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
            onMessage: (cb) => { rtMessage = cb; return noop; },
            onStatus: unsub
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
            set: vi.fn(async (x) => x)
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

    $('dm-list').querySelector('.dm-row').click();
    await settle();
});

describe('the search box in a conversation', () => {
    it('is the channel’s box, moved — not a second one', () => {
        // The old #dm-search-input is gone from the markup entirely. A lookalike
        // is what can be missing a feature; the same element cannot.
        expect($('dm-search-input')).toBeNull();
        expect($('search-box').closest('#dm-head')).not.toBeNull();
        expect(document.querySelectorAll('#search-input').length).toBe(1);
    });

    it('brings its dropdown and its results strip with it', () => {
        // All three are one control: the dropdown hangs off the header that
        // holds the box, and the results strip is the row under it. Left in
        // #chan-head they paint under #dm-panel.
        expect($('search-pop').closest('#dm-head')).not.toBeNull();
        expect($('search-panel').closest('#dm-main')).not.toBeNull();
    });

    it('offers the same filters menu it offers in a channel', async () => {
        $('search-input').dispatchEvent(new window.Event('focus', { bubbles: true }));
        await settle();
        expect($('search-pop').hidden).toBe(false);
        const titles = Array.from($('search-pop').querySelectorAll('.sp-title'))
            .map((el) => el.textContent);
        expect(titles).toContain('From a specific user');
        expect(titles).toContain('Includes a specific type of data');
        expect(titles).toContain('Mentions a specific user');
        expect(titles).toContain('More filters');
    });

    it('narrows the conversation by plain text', async () => {
        await type('thanks');
        expect(shownIds()).toEqual([503]);
        expect($('dm-messages').classList.contains('filtering')).toBe(true);
        expect($('search-box').dataset.count).toBe('1 match');
    });

    it('narrows it by has:, which the old box could not do at all', async () => {
        await type('has:image');
        expect(shownIds()).toEqual([502]);
    });

    it('narrows it by from:, over the people in THIS conversation', async () => {
        await type('from:alice');
        expect(shownIds()).toEqual([501, 502]);
    });

    it('narrows it by pinned:, which DMs only gained a column for recently', async () => {
        await type('pinned:true');
        expect(shownIds()).toEqual([502]);
    });

    it('combines operators with free text, the way a channel does', async () => {
        await type('from:alice logo');
        // 501 has the word; 502 is alice's too but its body is empty and its
        // filename is what matches — attachment names are searched, as in a
        // channel.
        expect(shownIds().sort()).toEqual([501, 502]);
    });

    it('says nothing matched in the same words the channel uses', async () => {
        await type('from:alice zzzznope');
        expect(shownIds()).toEqual([]);
        expect($('dm-messages').querySelector('.empty-state').textContent)
            .toContain('No loaded messages match these filters.');
        // …and drops the "this is the beginning of your history" block, because
        // a filtered list is a result and not a beginning.
        expect($('dm-messages').querySelector('.dm-intro')).toBeNull();
    });

    // `in:` NAMES A CONVERSATION in here, and the dropdown and More filters
    // both offer the conversations you are in — the one on screen included. The
    // shared matcher answers the operator by comparing it against a post's
    // `channel`, which a DM row does not have, so it rejected every message:
    // picking this very conversation emptied the column while the archive panel
    // underneath went on returning hits from it.
    it('answers in: with the conversation it names', async () => {
        await type('in:alice');
        expect(shownIds()).toEqual([501, 502, 503]);
        expect($('dm-messages').querySelector('.empty-state')).toBeNull();
    });

    it('…and matches nothing when in: names a different one', async () => {
        // Which is what `in:` means in a channel too: the loaded messages are
        // this conversation's, so naming another narrows to nothing rather than
        // quietly searching the wrong place.
        await type('in:bob');
        expect(shownIds()).toEqual([]);
        expect($('dm-messages').querySelector('.empty-state')).not.toBeNull();
    });

    // ONE search box, two lists that can both repaint it. The conversation is on
    // screen, but the channel column behind it keeps polling — and it used to
    // write its own match count over the conversation's a few seconds later,
    // about a list nobody could see.
    it('keeps its match count when the channel behind it repaints', async () => {
        await type('thanks');
        expect($('search-box').dataset.count).toBe('1 match');
        // Somebody posts in the channel this panel is drawn over. The renderer
        // refetches that column and repaints it — out of sight — and used to
        // stamp its own match count onto the box the conversation is using.
        if (rtMessage) rtMessage({ t: 'posted', channel: 'general', cid: 'someone', name: 'Someone' });
        // Past the refresh coalescing window, which is a real timer.
        await new Promise((r) => setTimeout(r, 400));
        await settle(20);
        expect($('search-box').dataset.count).toBe('1 match');
        expect(shownIds()).toEqual([503]);
    });

    it('clears back to the whole conversation', async () => {
        $('search-clear').click();
        await settle();
        expect(shownIds()).toEqual([501, 502, 503]);
        expect($('dm-messages').classList.contains('filtering')).toBe(false);
        expect($('search-box').dataset.count).toBe('');
    });
});

describe('the archive half', () => {
    it('asks the DM archive, never the channel one', async () => {
        board.mockClear();
        await type('logo');
        await settleSearch();
        const call = board.mock.calls.find((c) => c[0] === 'dm/search');
        expect(call).toBeTruthy();
        expect(call[1].query).toMatchObject({ q: 'logo', thread: 40, scope: 'conversation' });
        // /api/board/search reads the posts table. Asking it from a conversation
        // returned hits nobody in that conversation had written.
        expect(board.mock.calls.some((c) => c[0] === 'search')).toBe(false);
    });

    it('shows the results with the conversation they came from', () => {
        expect($('search-panel').hidden).toBe(false);
        const row = $('search-results').querySelector('.search-result');
        expect(row).toBeTruthy();
        // A channel hit says "#general"; a DM hit says who the conversation is
        // with, resolved from the list this client already holds.
        expect(row.querySelector('.sr-ch').textContent).toBe('alice');
    });

    it('scopes by conversation, in the conversation’s own words', () => {
        expect($('search-scope').textContent).toBe('This conversation');
        $('search-scope').click();
        expect($('search-scope').textContent).toBe('All conversations');
        $('search-scope').click();
        expect($('search-scope').textContent).toBe('This conversation');
    });

    it('sends only free text to the archive, keeping operators local', async () => {
        board.mockClear();
        await type('from:alice logo');
        await settleSearch();
        const call = board.mock.calls.find((c) => c[0] === 'dm/search');
        // The server has no idea who alice is; the operator is answerable here
        // without a round trip. Same split the channel search makes.
        expect(call[1].query.q).toBe('logo');
        $('search-clear').click();
        await settle();
    });

    // The scope toggle offers All Conversations, so a hit can belong to a
    // conversation other than the one on screen — and the row already names it.
    // Clicking it has to GO there. It did not: the hit's own `thread` was never
    // read, so every result resolved to whichever conversation happened to be
    // open. A row saying "bob" left you in the alice conversation, paged back
    // through the wrong history, and ended on "that message is further back
    // than we can jump". The channel half has switched channel for this all
    // along (jumpToPost); this is its other side.
    it('jumps into the conversation a hit actually came from', async () => {
        await type('logo');
        await settleSearch();
        const hits = $('search-results').querySelectorAll('.search-result');
        expect(hits.length).toBe(2);
        expect(hits[0].querySelector('.sr-ch').textContent).toBe('alice');
        expect(hits[1].querySelector('.sr-ch').textContent).toBe('bob');

        board.mockClear();
        hits[1].click();
        await settle(30);

        // It asked for the OTHER conversation, and the whole view followed.
        const call = board.mock.calls.find((c) =>
            c[0] === 'dm/list' && c[1] && c[1].query && c[1].query.thread === OTHER.id);
        expect(call).toBeTruthy();
        expect($('dm-title').textContent).toBe('bob');
        const active = $('dm-list').querySelector('.dm-row.active');
        expect(active).toBeTruthy();
        expect(active.textContent).toContain('bob');
    });
});

describe('back in a channel', () => {
    beforeAll(async () => {
        $('rail-home').click();
        await settle();
    });

    it('takes the box, the dropdown and the panel back with it', () => {
        expect($('search-box').closest('#chan-head')).not.toBeNull();
        expect($('search-pop').closest('#chan-head')).not.toBeNull();
        expect($('search-panel').closest('#main')).not.toBeNull();
        expect($('search-box').closest('#dm-head')).toBeNull();
    });

    it('scopes by channel again', () => {
        expect($('search-scope').textContent).toBe('This channel');
    });
});
