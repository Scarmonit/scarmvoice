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

// Silence the instance booted LAST, before booting the next one.
//
// bootRenderer cannot shut a renderer down — teardownSession is private to
// app.js — so the previous instance's poll, presence heartbeat, DM poll and
// avatar sweep all keep firing. Its $(…) lookups resolve against the SAME
// document, so a stale instance repaints the fresh one's UI out of its own
// state: a channel badge cleared, a message row rebuilt with the wrong role's
// action bar, a banner filled in with the previous fixture's numbers. It is a
// whole class of cross-file flakiness, and because it depends on scheduling it
// lands on whichever spec the machine treated worst — reading as some unrelated
// feature breaking at random.
//
// app.js captures `const L = window.lounge` by REFERENCE, which is the hook: a
// board() on the old object that never settles reaches the old instance, and
// every fetch-then-render path it has is rooted in that one call. Its timers
// still fire; they just never get an answer to draw.
function silencePrevious() {
    const prev = window.lounge;
    if (!prev) return;
    prev.board = () => new Promise(() => {});
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
    let rtStatus = null;
    let editContext = null;
    let resync = null;
    let winHidden = null;
    let winFocus = null;

    silencePrevious();

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
            // opts.accountMe overrides the whole answer, for the specs that are
            // about a me() that FAILED rather than one that reported no account —
            // board() returns { success:false, network:true } for an edge 502 or a
            // Worker exception page, and the two mean very different things.
            me: vi.fn(opts.accountMe || (async () => ({ success: true, user })))
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
            // Held for the same reason as onMessage: whether the socket is up
            // decides which of the two typing pipes the renderer believes, and
            // the interesting bugs live in the handover between them.
            onStatus: (cb) => { rtStatus = cb; return noop; }
        },
        edit: {
            // Spies rather than no-ops: the context menu's whole job is to run one
            // of these on the right element, so a spec about the menu has nothing
            // to assert on otherwise.
            cut: vi.fn(async () => true),
            copy: vi.fn(async () => true),
            paste: vi.fn(async () => true),
            selectAll: vi.fn(async () => true),
            undo: vi.fn(async () => true),
            redo: vi.fn(async () => true),
            clipboard: vi.fn(async () => ({ text: false, image: false })),
            replaceMisspelling: vi.fn(async () => true),
            addToDictionary: vi.fn(async () => true),
            // Held, like rt.onMessage: main pushes this on every right-click in an
            // editable field, and it is the ONLY way the menu opens now — the
            // spellchecker's suggestions exist only on main's context-menu event,
            // and a DOM handler that cancelled the event to draw its own menu is
            // what stopped that event ever firing. See main.js.
            onContext: (cb) => { editContext = cb; return noop; }
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
            isFocused: vi.fn(async () => true),
            // Held: clicking back into the window republishes presence
            // (refreshPresenceSoon), which is the app's own way of asking the
            // member list to catch up without waiting for the heartbeat.
            onFocus: (cb) => { winFocus = cb; return noop; },
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
            // Whole-interface zoom lives in main because webFrame needs node in
            // the renderer. Answers with what it was asked for, the way the real
            // handler does once the value is in range.
            setZoom: vi.fn(async (p) => Math.max(50, Math.min(200, Math.round(Number(p) || 100)))),
            // Restart in place. A spy, not a no-op: "did it relaunch the app
            // behind their back" is the assertion the hardware-acceleration
            // switch needs.
            relaunch: vi.fn(async () => true),
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
    // The composer IS a CodeMirror instance now, so the editor has to be on
    // window before app.js runs. The vendored bundle is a classic script, which
    // is exactly what `run` executes — and CodeMirror initialises under jsdom
    // even though every measurement it takes comes back zero, because the
    // document model these specs drive is not the part that measures anything.
    run('vendor/codemirror.js');
    run('lazy.js');
    run('lib.js');
    run('audio.js');
    run('noise.js');
    // jsdom has no navigator.mediaDevices, so its getUserMedia patch no-ops —
    // but window.ScarmMic is defined either way, which is the half the renderer
    // pushes the saved input gain into.
    run('soundboard.js');
    run('sounds.js');
    // The theme engine — app.js calls ScarmTheme.apply from applyTheme()
    // during boot, exactly as index.html loads it.
    run('theme.js');
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
        // The realtime socket coming up or going down, as main.js reports it.
        rtStatus: (connected, state) => {
            if (rtStatus) rtStatus({ connected, state: state || (connected ? 'open' : 'closed') });
        },
        // Restore-from-tray, as main.js delivers it.
        resync: () => { if (resync) resync(); },
        // The window went to / came back from the tray.
        hidden: (h) => { if (winHidden) winHidden(h); },
        // A right-click in a text field, as main delivers it. Defaults match
        // Chromium's editFlags for "a field with text in it and nothing selected".
        rightClickField: (over = {}) => {
            if (!editContext) return;
            editContext(Object.assign({
                x: 100, y: 200, misspelledWord: '', suggestions: [],
                canUndo: false, canRedo: false,
                canCut: false, canCopy: false, canPaste: true, canSelectAll: true
            }, over));
        },
        // Focus left or came back.
        focus: (f) => { if (winFocus) winFocus(f); }
    };
}

// Type into the composer the way a person does, so the input listeners
// (autosize, send-button state, typing broadcast) all run.
// The message box is a CodeMirror instance now, not an element with an id.
// CodeMirror hangs the instance off its own wrapper, which is the public way in
// and needs nothing exposed from the app for the tests' benefit.
export const cmEditor = () => {
    const wrap = document.querySelector('.composer-field .CodeMirror');
    return wrap ? wrap.CodeMirror : null;
};

// …wearing the shape the specs were written against, so a spec that says
// `input().value` still reads. The app has an adapter of its own for the same
// reason; this is the test-side twin of it and deliberately no bigger.
export function composerInput() {
    const cm = cmEditor();
    if (!cm) return null;
    return {
        get value() { return cm.getValue(); },
        set value(v) { cm.setValue(String(v == null ? '' : v)); },
        get selectionStart() { return cm.indexFromPos(cm.getCursor('from')); },
        get selectionEnd() { return cm.indexFromPos(cm.getCursor('to')); },
        setSelectionRange(a, b) {
            cm.setSelection(cm.posFromIndex(a), cm.posFromIndex(b === undefined ? a : b));
        },
        focus() { cm.focus(); },
        get placeholder() { return cm.getOption('placeholder'); },
        get spellcheck() { return cm.getInputField().spellcheck; },
        getAttribute(k) { return cm.getInputField().getAttribute(k); },
        dispatchEvent(ev) { cm.getInputField().dispatchEvent(ev); return true; },
        get element() { return cm.getWrapperElement(); }
    };
}

export function type(text) {
    const cm = cmEditor();
    cm.setValue(String(text == null ? '' : text));
    return composerInput();
}
