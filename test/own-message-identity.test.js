// @vitest-environment jsdom
//
// A message YOU wrote must never announce itself to you.
//
// The renderer decided "is this mine?" with `p.client_id === settings.clientId`.
// A client_id is per-INSTALL, so that answers no for anything you sent from the
// web board or a second machine — and, since the server hands out a fresh
// install id whenever the one a device asks for already belongs to another
// account (bindOrRotateClient), it can answer no for this machine's own older
// messages too. The result was your own message arriving with a chime, a
// desktop notification, and a place in the unread count.
//
// posts.user_id is the account that wrote it and the server publishes it on
// every row, so that is what the question is asked of now (wroteByMe). The
// assertion here is the invariant, not the plumbing: a post carrying MY user_id
// is silent no matter which install id is stamped on it.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RENDERER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');

const ME = { id: 7, username: 'Me', role: 'member' };
const MY_INSTALL = 'c-this-machine';
const MY_OTHER_INSTALL = 'c-my-phone';       // same account, different device
const SOMEONE_ELSE = 'c-someone-else';

// The list endpoint's answer, swapped between assertions.
let listPosts = [];
let notify = null;

function post(id, userId, clientId, name) {
    return {
        id, user_id: userId, client_id: clientId, name,
        body: 'message ' + id, created_at: 1700000000000 + id * 1000,
        channel: 'general', reactions: [], reply_count: 0
    };
}

function stubBridge() {
    const noop = () => {};
    const unsub = () => noop;
    notify = vi.fn(async () => true);
    return {
        auth: {
            login: vi.fn(async () => ({ success: true })),
            logout: vi.fn(async () => ({ success: true })),
            status: vi.fn(async () => ({ authed: true }))
        },
        account: {
            register: vi.fn(async () => ({ success: false })),
            login: vi.fn(async () => ({ success: false })),
            verify: vi.fn(async () => ({ success: false })),
            resend: vi.fn(async () => ({ success: false })),
            logout: vi.fn(async () => ({ success: true })),
            me: vi.fn(async () => ({ success: true, user: ME }))
        },
        board: vi.fn(async (p) => {
            if (p === 'list') {
                return {
                    success: true, posts: listPosts, hasMore: false,
                    channel: 'general', maxId: listPosts.length ? listPosts[listPosts.length - 1].id : 0,
                    typing: [], voice: []
                };
            }
            if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0, maxId: 0 }] };
            if (p === 'presence') return { success: true, members: [] };
            if (p === 'voice/presence') return { success: true, participants: [] };
            if (p === 'dm/threads') return { success: true, threads: [] };
            return { success: true };
        }),
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
            start: vi.fn(async () => ({ connected: false })),
            stop: vi.fn(async () => ({ connected: false })),
            wake: vi.fn(async () => ({ connected: false })),
            send: noop, notifyPosted: noop, sendTyping: noop, sendVoice: noop,
            onMessage: unsub, onStatus: unsub
        },
        edit: {
            cut: noop, copy: noop, paste: noop, selectAll: noop,
            clipboard: vi.fn(async () => ({ text: false, image: false }))
        },
        settings: {
            get: vi.fn(async () => ({
                baseUrl: 'https://scarmonit.com', room: 'lounge', clientId: MY_INSTALL,
                displayName: 'Me', channel: 'general', theme: 'dark', density: 'cozy',
                chatFontSize: 'medium', showMembers: true, catTextOpen: true,
                catVoiceOpen: true, localVolumes: {}, localMuted: {}, blocked: {},
                mutedChannels: [], voiceMode: 'open', notifications: true, dnd: false,
                pttBinding: { type: 'key', code: 'Backquote' }
            })),
            set: vi.fn(async (p) => p)
        },
        ptt: {
            apply: vi.fn(async () => ({ mode: 'native' })),
            available: vi.fn(async () => true),
            describe: vi.fn(async () => 'Backquote'),
            onChange: unsub
        },
        win: {
            minimize: noop, maximize: noop, close: noop,
            isFocused: vi.fn(async () => false), onFocus: unsub
        },
        app: {
            version: vi.fn(async () => '0.0.0-test'),
            isElevated: vi.fn(async () => false),
            openLogs: vi.fn(async () => true),
            notify,
            setVoiceState: vi.fn(async () => ({})),
            setBadge: vi.fn(async () => true),
            openExternal: vi.fn(async () => true),
            systemTheme: vi.fn(async () => ({ dark: true })),
            setTheme: vi.fn(async () => true),
            onThemeChange: unsub, onCommand: unsub, onResync: unsub
        },
        startup: {
            get: vi.fn(async () => ({ openAtLogin: false, openAsHidden: false })),
            set: vi.fn(async () => ({ openAtLogin: false, openAsHidden: false }))
        },
        update: {
            getState: vi.fn(async () => ({ status: 'idle', noteBlocks: [] })),
            check: noop, download: noop, install: noop, setAuto: noop, onState: unsub
        },
        fileUrl: (k) => 'lounge://file/' + encodeURIComponent(k)
    };
}

function run(file) {
    const code = fs.readFileSync(path.join(RENDERER, file), 'utf8');
    // eslint-disable-next-line no-new-func
    new Function(code).call(window);
}

const settle = () => new Promise((r) => setTimeout(r, 0));

// Re-poll the list with whatever `listPosts` now holds, the way the poll does.
async function deliver(posts) {
    listPosts = posts;
    document.getElementById('messages').dispatchEvent(new Event('scroll'));
    window.lounge.board.mockClear();
    // The visibility handler is what the app itself uses to force a refresh.
    document.dispatchEvent(new Event('visibilitychange'));
    for (let i = 0; i < 12; i++) await settle();
}

beforeAll(async () => {
    const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
    document.documentElement.innerHTML = html
        .replace(/<script[\s\S]*?<\/script>/g, '')
        .replace(/^[\s\S]*?<body>/, '<head></head><body>')
        .replace(/<\/body>[\s\S]*$/, '</body>');

    window.lounge = stubBridge();
    window.RealtimeKitClient = { init: vi.fn(async () => ({})) };
    window.hljs = { highlightElement: () => {} };
    window.AudioContext = class {
        constructor() { this.state = 'running'; this.destination = {}; }
        createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
        createAnalyser() {
            return { fftSize: 512, smoothingTimeConstant: 0, connect() {}, disconnect() {}, getByteTimeDomainData() {} };
        }
        createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
        createBufferSource() { return { buffer: null, connect() {}, start() {} }; }
        decodeAudioData(_r, res) { res({}); }
        resume() { return Promise.resolve(); }
        setSinkId() { return Promise.resolve(); }
    };
    window.matchMedia = window.matchMedia || (() => ({
        matches: false, addEventListener() {}, removeEventListener() {}
    }));
    Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || function () {};
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 404 }));
    globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((cb) => setTimeout(cb, 0));

    // The very first page establishes the watermark; nothing chimes for it.
    listPosts = [post(1, 99, SOMEONE_ELSE, 'Someone')];

    run('lib.js');
    run('audio.js');
    run('lazy.js');
    run('noise.js');
    run('voice.js');
    run('sounds.js');
    run('icons.js');
    run('app.js');

    for (let i = 0; i < 20; i++) await settle();
});

describe('a message I wrote does not announce itself to me', () => {
    it('enters the board with an account', () => {
        expect(document.getElementById('app').hidden).toBe(false);
        expect(document.getElementById('login').hidden).toBe(true);
    });

    it('stays silent for my own message sent from another device', async () => {
        const play = vi.spyOn(window.loungeSounds, 'playMessage');

        await deliver([
            post(1, 99, SOMEONE_ELSE, 'Someone'),
            // Mine — my account, a DIFFERENT install id. This is the row the old
            // client_id comparison called "someone else's".
            post(2, ME.id, MY_OTHER_INSTALL, 'Me')
        ]);

        expect(play).not.toHaveBeenCalled();
        play.mockRestore();
    });

    it('still chimes for a message from somebody else', async () => {
        const play = vi.spyOn(window.loungeSounds, 'playMessage');

        await deliver([
            post(1, 99, SOMEONE_ELSE, 'Someone'),
            post(2, ME.id, MY_OTHER_INSTALL, 'Me'),
            post(3, 99, SOMEONE_ELSE, 'Someone')
        ]);

        expect(play).toHaveBeenCalled();
        play.mockRestore();
    });

    it('leaves my own messages out of the unread jump count', async () => {
        await deliver([
            post(1, 99, SOMEONE_ELSE, 'Someone'),
            post(2, ME.id, MY_OTHER_INSTALL, 'Me'),
            post(3, ME.id, MY_OTHER_INSTALL, 'Me')
        ]);
        // Nothing from anyone else since the watermark, so the badge is empty.
        expect(document.getElementById('jump-count').hidden).toBe(true);
    });
});
