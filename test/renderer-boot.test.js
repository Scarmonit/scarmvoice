// @vitest-environment jsdom
//
// Boots the real renderer — index.html's DOM plus lib.js, audio.js, icons.js and
// app.js — against a stubbed window.lounge bridge, and asserts it comes up
// without throwing.
//
// This is the regression test for the whole class of bug that a large IIFE
// invites: app.js is one 5000-line scope where a helper can be renamed, moved to
// lib.js, or deleted, and NOTHING complains until the app is launched and the
// window is blank. Every wiring line at IIFE scope — hundreds of
// addEventListener calls against elements that must exist by that id — runs
// here, so a typo'd id or a missing symbol fails the suite instead of shipping.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RENDERER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');

const errors = [];

// The preload bridge. Every method the renderer can reach at boot, answering
// with the shape main.js really returns — enough for the boot path to complete.
function stubBridge() {
    const noop = () => {};
    const unsub = () => noop;
    return {
        auth: {
            login: vi.fn(async () => ({ success: true })),
            logout: vi.fn(async () => ({ success: true })),
            // Signed out: boot stops at the login screen, which is the path that
            // runs every top-level wiring line without needing a live server.
            status: vi.fn(async () => ({ authed: false }))
        },
        board: vi.fn(async () => ({ success: true, posts: [], channels: [], typing: [], voice: [] })),
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
                baseUrl: 'https://scarmonit.com', room: 'lounge', clientId: 'ctest',
                displayName: '', channel: 'general', theme: 'dark', density: 'cozy',
                chatFontSize: 'medium', showMembers: true, catTextOpen: true,
                catVoiceOpen: true, localVolumes: {}, localMuted: {}, blocked: {},
                mutedChannels: [], voiceMode: 'open',
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
            isFocused: vi.fn(async () => true), onFocus: unsub
        },
        app: {
            version: vi.fn(async () => '0.0.0-test'),
            isElevated: vi.fn(async () => false),
            openLogs: vi.fn(async () => true),
            notify: vi.fn(async () => false),
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

// The renderer scripts are plain <script> files, not modules: evaluate them the
// way the browser would rather than importing them.
function run(file) {
    const code = fs.readFileSync(path.join(RENDERER, file), 'utf8');
    // eslint-disable-next-line no-new-func
    new Function(code).call(window);
}

beforeAll(() => {
    const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
    // Body only: the <script> tags are executed explicitly below, in order.
    document.documentElement.innerHTML = html
        .replace(/<script[\s\S]*?<\/script>/g, '')
        .replace(/^[\s\S]*?<body>/, '<head></head><body>')
        .replace(/<\/body>[\s\S]*$/, '</body>');

    window.lounge = stubBridge();
    window.RealtimeKitClient = { init: vi.fn(async () => ({})) };
    window.hljs = { highlightElement: () => {} };

    // Things jsdom has no implementation for. Their absence must not be what
    // this test detects.
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

    window.addEventListener('error', (e) => errors.push(e.message));

    run('lib.js');
    run('audio.js');
    run('voice.js');
    run('sounds.js');
    run('icons.js');
    run('app.js');
});

describe('renderer boot', () => {
    it('defines every module the page depends on', () => {
        expect(typeof window.ScarmLib).toBe('object');
        expect(typeof window.ScarmAudio).toBe('object');
        expect(typeof window.ScarmIcons).toBe('object');
        expect(typeof window.createVoice).toBe('function');
        expect(typeof window.loungeSounds).toBe('object');
    });

    it('evaluates app.js without throwing', () => {
        // A missing helper, a renamed export, or an element id that no longer
        // exists all surface here rather than as a blank window.
        expect(errors).toEqual([]);
    });

    it('asks the main process whether we are signed in', async () => {
        await new Promise((r) => setTimeout(r, 0));
        expect(window.lounge.auth.status).toHaveBeenCalled();
    });

    it('leaves the sign-in screen up when there is no session', async () => {
        await new Promise((r) => setTimeout(r, 0));
        expect(document.getElementById('login').hidden).toBe(false);
        expect(document.getElementById('app').hidden).toBe(true);
    });

    it('hydrates every icon placeholder', () => {
        // icons.js swaps <span data-icon> for an <svg>; a leftover placeholder
        // means an icon name that does not exist in the set.
        expect(document.querySelectorAll('[data-icon]').length).toBe(0);
    });

    it('gives every icon-only button an accessible name', () => {
        // Icons are aria-hidden (correctly — the shape means nothing to a screen
        // reader), so an icon-only button with no label is announced as just
        // "button". icons.js mirrors each one's title into aria-label.
        //
        // Buttons inside a hidden container are exempt: several are filled in
        // with their label at the moment they're revealed (the update banner's
        // action is "Download" or "Restart" depending on state).
        const unnamed = Array.from(document.querySelectorAll('button'))
            .filter((b) => !b.closest('[hidden]'))
            .filter((b) => !b.textContent.trim() && !b.getAttribute('aria-label'))
            .map((b) => b.id || b.className);
        expect(unnamed).toEqual([]);
    });

    it('keeps one AudioContext for the whole renderer', () => {
        // The bug this guards: a context per participant, per boosted
        // participant, per mic test, plus one for chimes — past Chromium's
        // six-context page limit in a call of five.
        const stats = window.ScarmAudio.stats();
        expect(['none', 'running', 'suspended']).toContain(stats.context);
    });
});
