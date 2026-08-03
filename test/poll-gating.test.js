// @vitest-environment jsdom
//
// The board API must be SILENT while the login card is up.
//
// The bug this locks down: "Your session expired. Sign in again." appearing on
// the connect screen every few seconds, on a freshly opened app, forever.
//
// Nothing about the session had actually expired. The renderer's realtime
// status handler called startPolling() unconditionally, and three separate
// things emit a status event with no session behind them — rt.start(),
// rt.stop(), and a connect() that finds no credential. So:
//
//   * at boot, auth:status starts the socket BEFORE the account step, and its
//     status event armed the poll from behind the login card; and
//   * teardownSession() cleared the timer with stopPolling() and then re-armed
//     it a few lines later via its own await L.rt.stop().
//
// Either way the next tick called the board with no credential, got
// needsAuth/needsAccount back, and authGone() -> relogin() re-printed the
// expiry banner and stole focus back to the password field — then tore down,
// re-armed, and did it again four seconds later.
//
// The assertion is the invariant, not the plumbing: signed out, no board call.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RENDERER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');

// Set by the stub when app.js subscribes, so the test can drive the handler the
// main process would have driven.
let statusCb = null;
let board = null;

function stubBridge() {
    const noop = () => {};
    const unsub = () => noop;
    board = vi.fn(async () => ({ success: true, posts: [], channels: [], typing: [], voice: [] }));
    return {
        auth: {
            login: vi.fn(async () => ({ success: true })),
            logout: vi.fn(async () => ({ success: true })),
            // Signed out — the state the bug was visible in.
            status: vi.fn(async () => ({ authed: false }))
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
            start: vi.fn(async () => ({ connected: false })),
            stop: vi.fn(async () => ({ connected: false })),
            wake: vi.fn(async () => ({ connected: false })),
            send: noop, notifyPosted: noop, sendTyping: noop, sendVoice: noop,
            onMessage: unsub,
            onStatus: (cb) => { statusCb = cb; return noop; }
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
            isFocused: vi.fn(async () => true), onFocus: unsub, onHidden: unsub
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

function run(file) {
    const code = fs.readFileSync(path.join(RENDERER, file), 'utf8');
    // eslint-disable-next-line no-new-func
    new Function(code).call(window);
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

    // The composer IS a CodeMirror instance now, so the editor has to be on
    // window before app.js runs.
    run('vendor/codemirror.js');
    run('lib.js');
    run('audio.js');
    run('voice.js');
    run('sounds.js');
    run('icons.js');
    run('app.js');

    // Let boot() settle on the login screen.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
});

describe('polling is gated on a live session', () => {
    it('boots to the login card without a session', () => {
        expect(document.getElementById('login').hidden).toBe(false);
        expect(document.getElementById('app').hidden).toBe(true);
    });

    it('subscribes to realtime status', () => {
        expect(typeof statusCb).toBe('function');
    });

    it('does not poll the board when the socket connects behind the login card', async () => {
        vi.useFakeTimers();
        try {
            board.mockClear();
            // Exactly what rt.start()/connect()/stop() emit. Before the fix this
            // armed a 4s poll whose first tick 401'd into "session expired".
            statusCb({ connected: true, state: 'connected' });
            statusCb({ connected: false, state: 'reconnecting' });
            statusCb({ connected: false, state: 'disconnected' });

            // Several poll periods' worth (POLL_ACTIVE_MS is 4s).
            await vi.advanceTimersByTimeAsync(30000);

            expect(board).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('leaves the login card alone — no phantom expiry banner', () => {
        // The visible symptom. relogin() writes this string; nothing should
        // have called it, so the error line stays empty.
        expect(document.getElementById('login-error').textContent).toBe('');
        expect(document.getElementById('login-pw').hidden).toBe(false);
    });
});
