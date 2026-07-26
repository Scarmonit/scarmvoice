// @vitest-environment jsdom
//
// The viewing stage, driven the way the voice engine drives it. Boots the real
// renderer signed in, with window.createVoice replaced by a capture of the
// callbacks app.js registers — so onShares/onCams can be fired by hand and the
// resulting DOM asserted.
//
// What it protects: with several presenters live, the user's pick of what to
// watch is the whole feature. Silently following the newest share, or losing the
// switcher when a camera joins, would be invisible to every other test.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RENDERER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');

const noop = () => {};
const unsub = () => noop;

// Only the callbacks matter here; every method app.js calls on the engine is a
// no-op that reports "not in a call".
const cb = {};
function fakeVoice(opts) {
    Object.assign(cb, opts);
    return {
        join: async () => {}, leave: noop, roster: () => [], shares: () => [],
        state: () => ({ joined: false, shareQuality: '1080p', shareMotion: 'sharp' }),
        setSettings: noop, setMuted: noop, setDeafened: noop, setPttHeld: noop,
        setLocalVolume: noop, setLocalMuted: noop,
        setShareQuality: noop, setShareMotion: noop,
        startShare: async () => false, stopShare: noop, isSharing: () => false,
        enableCam: async () => false, disableCam: async () => false,
        isCamOn: () => false, toggleCam: noop, cams: () => [],
        isJoined: () => false, isMuted: () => false, isDeafened: () => false
    };
}

let seq = 0;
const stream = () => ({ id: 'ms' + (++seq) });
const share = (id, name, isLocal) => ({ id, name, isLocal: !!isLocal, stream: stream() });
const cam = (id, name, isMe) => ({ id, name, isMe: !!isMe, stream: stream() });

const $ = (id) => document.getElementById(id);
const pills = () => Array.from(document.querySelectorAll('.stage-src'));
const pillText = () => pills().map((b) => b.textContent.trim());
const activePill = () => (pills().find((b) => b.classList.contains('active')) || {}).textContent;

beforeAll(async () => {
    const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
    document.documentElement.innerHTML = html
        .replace(/<script[\s\S]*?<\/script>/g, '')
        .replace(/^[\s\S]*?<body>/, '<head></head><body>')
        .replace(/<\/body>[\s\S]*$/, '</body>');

    window.lounge = {
        // Signed in, so enterApp() runs and setupVoice() registers the callbacks.
        auth: { status: vi.fn(async () => ({ authed: true })), login: vi.fn(async () => ({ success: true })), logout: noop },
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
        win: { minimize: noop, maximize: noop, close: noop, isFocused: vi.fn(async () => true), onFocus: unsub },
        app: {
            version: vi.fn(async () => '0.0.0-test'), isElevated: vi.fn(async () => false),
            openLogs: vi.fn(async () => true), notify: vi.fn(async () => false),
            setVoiceState: vi.fn(async () => ({})), setBadge: vi.fn(async () => true),
            openExternal: vi.fn(async () => true), systemTheme: vi.fn(async () => ({ dark: true })),
            setTheme: vi.fn(async () => true), onThemeChange: unsub, onCommand: unsub, onResync: unsub
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
    run('sounds.js');
    run('icons.js');
    window.createVoice = fakeVoice;      // stands in for voice.js
    run('app.js');

    // enterApp() is async; the callbacks land a few microtasks in.
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    expect(typeof cb.onShares).toBe('function');
});

describe('viewing stage', () => {
    it('stays closed until something is being presented', () => {
        cb.onShares([]);
        expect($('stage').hidden).toBe(true);
    });

    it('shows a single presenter with no switcher to choose from', () => {
        cb.onShares([share('a', 'Alice')]);
        expect($('stage').hidden).toBe(false);
        expect($('stage-title').textContent).toBe('Alice is sharing their screen');
        expect($('stage-sources').hidden).toBe(true);
    });

    it('offers every presenter once a second one starts', () => {
        cb.onShares([share('a', 'Alice'), share('b', 'Bob')]);
        expect($('stage-sources').hidden).toBe(false);
        expect(pillText()).toEqual(["Alice's screen", "Bob's screen"]);
        // The newest share must not steal the view.
        expect($('stage-title').textContent).toBe('Alice is sharing their screen');
        expect(activePill()).toBe("Alice's screen");
    });

    it('switches to whichever presenter you pick', () => {
        pills().find((b) => b.textContent.includes('Bob')).click();
        expect($('stage-title').textContent).toBe('Bob is sharing their screen');
        expect(activePill()).toBe("Bob's screen");
    });

    it('keeps your pick when another presenter appears or leaves', () => {
        cb.onShares([share('a', 'Alice'), share('b', 'Bob'), share('c', 'Cass')]);
        expect($('stage-title').textContent).toBe('Bob is sharing their screen');

        // Alice stops: Bob was the explicit choice and stays put.
        cb.onShares([share('b', 'Bob'), share('c', 'Cass')]);
        expect($('stage-title').textContent).toBe('Bob is sharing their screen');
    });

    it('falls back to another presenter when the one you watched stops', () => {
        cb.onShares([share('c', 'Cass')]);
        expect($('stage-title').textContent).toBe('Cass is sharing their screen');
    });

    it('lists live cameras as sources alongside the shares', () => {
        cb.onCams([cam('d', 'Dev')]);
        expect(pillText()).toEqual(["Cass's screen", "Dev's camera"]);
        // A camera does not take the stage on its own.
        expect($('stage-title').textContent).toBe("Cass is sharing their screen");
    });

    it('puts a camera on the stage when you choose it', () => {
        pills().find((b) => b.textContent.includes('Dev')).click();
        expect($('stage-title').textContent).toBe("Dev's camera");
        expect($('cam-grid').querySelector('.cam-tile').classList.contains('watching')).toBe(true);
    });

    it('closes the stage when the last share ends and only a camera is left', () => {
        cb.onShares([]);
        // A camera you chose deliberately keeps the stage…
        expect($('stage').hidden).toBe(false);
        expect($('stage-title').textContent).toBe("Dev's camera");
        // …until you click its tile again, which returns to the grid alone.
        $('cam-grid').querySelector('.cam-tile').click();
        expect($('stage').hidden).toBe(true);
    });

    it('promotes a camera straight from its tile', () => {
        $('cam-grid').querySelector('.cam-tile').click();
        expect($('stage').hidden).toBe(false);
        expect($('stage-title').textContent).toBe("Dev's camera");
    });

    it('drops the stage when every source goes away', () => {
        cb.onCams([]);
        cb.onShares([]);
        expect($('stage').hidden).toBe(true);
        expect($('camera-stage').hidden).toBe(true);
    });
});
