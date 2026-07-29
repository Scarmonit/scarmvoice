// Boot the REAL renderer into jsdom, signed in, against a stubbed
// window.lounge.
//
// test/dm-actions.test.js and test/dm-view.test.js each carry their own copy of
// this bootstrap, which was fine for two files and stops being fine at four.
// New specs use this instead; the existing two are left alone deliberately —
// rewriting a passing test to prove a fix in a different file is how a
// regression suite quietly loses its teeth.
//
// Every renderer module is executed the way index.html does it (a classic
// script assigning a global), in the same order, because that order is
// load-bearing: lib.js before app.js, noise.js before soundboard.js.
import { vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RENDERER = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'renderer');

const noop = () => {};
const unsub = () => noop;

export const $ = (id) => document.getElementById(id);

// A handful of macrotask turns. The renderer's boot is a chain of awaits with
// no completion signal, so tests wait rather than hook into it.
export async function settle(n = 12) {
    for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

export const DEFAULT_SETTINGS = {
    baseUrl: 'https://scarmonit.com', room: 'lounge', clientId: 'me',
    displayName: 'Me', channel: 'general', theme: 'dark', density: 'cozy',
    chatFontSize: 'medium', showMembers: true, catTextOpen: true,
    catDmsOpen: true, catVoiceOpen: true,
    localVolumes: {}, localMuted: {}, blocked: {}, mutedChannels: [],
    voiceMode: 'open', pttBinding: { type: 'key', code: 'Backquote' }
};

// opts.board     — the /api/board/* router (a vi.fn)
// opts.user      — who account.me() reports
// opts.authStatus — override auth.status(), e.g. a promise that never settles
// opts.settings  — merged over DEFAULT_SETTINGS
// opts.voice     — merged over the inert voice double, for the specs that are
//                  about what the renderer TELLS the voice engine
export async function bootRenderer(opts = {}) {
    const user = opts.user || { id: 1, username: 'Me', role: 'member' };
    const board = opts.board || vi.fn(async () => ({ success: true }));
    const settings = Object.assign({}, DEFAULT_SETTINGS, opts.settings || {});
    let rtMessage = null;
    let resync = null;
    let winHidden = null;

    const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
    document.documentElement.innerHTML = html
        .replace(/<script[\s\S]*?<\/script>/g, '')
        .replace(/^[\s\S]*?<body>/, '<head></head><body>')
        .replace(/<\/body>[\s\S]*$/, '</body>');

    const lounge = {
        auth: {
            status: vi.fn(opts.authStatus || (async () => ({ authed: true }))),
            login: vi.fn(async () => ({ success: true })),
            logout: vi.fn(async () => ({ success: true }))
        },
        account: {
            register: vi.fn(async () => ({ success: false })),
            login: vi.fn(async () => ({ success: false })),
            logout: vi.fn(async () => ({ success: true })),
            verify: vi.fn(async () => ({ success: false })),
            resend: vi.fn(async () => ({ success: false })),
            removal: vi.fn(async () => ({ success: false })),
            me: vi.fn(async () => ({ success: true, user }))
        },
        board,
        uploadFile: vi.fn(async () => ({ success: true })),
        uploadAttachment: vi.fn(async () => ({ success: true })),
        onUploadProgress: unsub,
        // Empty by default (a pasted blob has no path). A spec that cares about
        // the stream-from-disk upload path overrides it, because "" is exactly
        // the value that makes uploadOne fall back to sending the bytes.
        pathForFile: opts.pathForFile || (() => ''),
        saveAttachment: vi.fn(async () => ({ success: true, path: 'C:/x/pic.png' })),
        downloadAttachment: vi.fn(async () => ({ success: true, path: 'C:/x/pic.png' })),
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
            // Held, so a spec can deliver a socket event the way the Durable
            // Object does rather than reaching into app.js.
            onMessage: (cb) => { rtMessage = cb; return noop; },
            onStatus: unsub
        },
        edit: {
            cut: noop, copy: noop, paste: noop, selectAll: noop,
            clipboard: vi.fn(async () => ({ text: false, image: false }))
        },
        settings: {
            get: vi.fn(async () => Object.assign({}, settings)),
            set: vi.fn(async (p) => Object.assign(settings, p))
        },
        ptt: {
            apply: vi.fn(async () => ({ mode: 'native' })),
            available: vi.fn(async () => true),
            describe: vi.fn(async () => 'Backquote'), onChange: unsub
        },
        win: {
            minimize: noop, maximize: noop, close: noop,
            isFocused: vi.fn(async () => true), onFocus: unsub,
            // Held: main.js sends this on the real window events, and it is the
            // only way the renderer can know it is in the tray — document.hidden
            // is frozen at false by backgroundThrottling:false.
            onHidden: (cb) => { winHidden = cb; return noop; }
        },
        app: {
            version: vi.fn(async () => '0.0.0-test'), isElevated: vi.fn(async () => false),
            openLogs: vi.fn(async () => true), notify: vi.fn(async () => false),
            setVoiceState: vi.fn(async () => ({})), setBadge: vi.fn(async () => true),
            openExternal: vi.fn(async () => true), systemTheme: vi.fn(async () => ({ dark: true })),
            setTheme: vi.fn(async () => true), onThemeChange: unsub,
            onCommand: unsub,
            // Captured, not discarded: this is the callback main.js fires on
            // restore-from-tray / wake, and it is now the only way a test can
            // make the renderer resync on demand. The visibilitychange event it
            // used to dispatch never fires in production (backgroundThrottling
            // is off, so document.hidden is frozen) — driving the app through it
            // was exercising a path the app never takes.
            onResync: (cb) => { resync = cb; return noop; }
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
    window.lounge = lounge;

    window.hljs = { highlightElement: noop };
    window.HTMLMediaElement.prototype.play = () => Promise.resolve();
    window.matchMedia = window.matchMedia ||
        (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || noop;
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 404 }));
    globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((f) => setTimeout(f, 0));

    const run = (f) => new Function(fs.readFileSync(path.join(RENDERER, f), 'utf8')).call(window);
    run('lazy.js');
    run('lib.js');
    run('audio.js');
    run('noise.js');
    // jsdom has no navigator.mediaDevices, so its getUserMedia patch no-ops —
    // but window.ScarmMic is defined either way, which is the half the renderer
    // pushes the saved input gain into.
    run('soundboard.js');
    run('sounds.js');
    run('icons.js');
    // jsdom has no script loader, so an injected <script src="vendor/…"> never
    // resolves either way and lazy.js's promise would hang forever — which in
    // drawQr() reads as an unhandled rejection rather than as the "could not
    // load" path every caller already degrades into. Answer the way a failed
    // fetch does, and let a spec that wants a bundle put it on `window` first.
    window.ScarmLazy = Object.assign({}, window.ScarmLazy, {
        hljs: async () => window.hljs || null,
        qrcode: async () => window.qrcode || null,
        realtimekit: async () => window.RealtimeKitClient || null
    });
    // Voice is rarely what these specs are about; stand in for it. `opts.voice`
    // is merged over the top for the ones that are.
    const voiceDouble = Object.assign({
        join: async () => {}, leave: noop, roster: () => [], shares: () => [],
        state: () => ({ joined: false, shareQuality: '1080p', shareMotion: 'sharp' }),
        setSettings: noop, setMuted: noop, setDeafened: noop, setPttHeld: noop,
        setLocalVolume: noop, setLocalMuted: noop,
        setShareQuality: noop, setShareMotion: noop,
        startShare: async () => false, stopShare: noop, isSharing: () => false,
        enableCam: async () => false, disableCam: async () => false,
        isCamOn: () => false, toggleCam: noop, cams: () => [],
        isJoined: () => false, isMuted: () => false, isDeafened: () => false
    }, opts.voice || {});
    window.createVoice = () => voiceDouble;
    run('app.js');

    await settle();
    // `rt(msg)` delivers one realtime frame, exactly as main.js relays it.
    return {
        $, board, lounge, settings, voice: voiceDouble,
        rt: (msg) => { if (rtMessage) rtMessage(msg); },
        // Restore-from-tray, as main.js delivers it.
        resync: () => { if (resync) resync(); },
        // The window went to / came back from the tray.
        hidden: (h) => { if (winHidden) winHidden(h); }
    };
}

// Type into the composer the way a person does, so the input listeners
// (autosize, send-button state, typing broadcast) all run.
export function type(text) {
    const input = $('composer-input');
    input.value = text;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    return input;
}
