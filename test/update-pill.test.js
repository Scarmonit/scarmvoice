// @vitest-environment jsdom
//
// The update pill: what appears when a release lands on a RUNNING app, and what
// one click on it does.
//
// The three things this is guarding:
//
//   • it appears BY ITSELF. Nothing here presses "Check for updates" — the app
//     is told over the realtime socket the moment a release goes live, and it
//     answers by asking its own feed. (The five-minute sweep in updater.js is
//     the fallback for a client that was not listening.)
//   • it is unmissable. One headline, "Update Available", across every state
//     that has something to click, on a filled accent pill rather than the
//     quiet float-coloured card the app uses to narrate.
//   • ONE click. The button is live in every state the pill is shown in, and
//     the whole pill is the target — a click while the download is still
//     running is remembered rather than refused (see updater.js installNow).
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RENDERER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');

const noop = () => {};
const unsub = () => noop;
const $ = (id) => document.getElementById(id);

const ME = { id: 1, username: 'Me', role: 'member' };

let rtHandler = null;          // the socket message callback app.js registers
// EVERY subscriber, not the last one. app.js calls onState twice — once for the
// pill and once to keep the Settings status line in sync while that panel is
// open — and a stub that remembers only the most recent callback drives the
// wrong one, so the pill never renders and every assertion below reads an empty
// banner for reasons that have nothing to do with the banner.
const stateSubs = [];
const update = {
    getState: vi.fn(async () => ({ status: 'idle', noteBlocks: [] })),
    check: vi.fn(async () => ({ ok: true })),
    download: vi.fn(async () => ({ ok: true })),
    install: vi.fn(async () => ({ ok: true })),
    setAuto: noop, postpone: noop,
    history: vi.fn(async () => ({ success: true, releases: [] })),
    onState: (cb) => { stateSubs.push(cb); return noop; }
};

let resyncHandler = null;

async function settle(n = 12) {
    for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

// hideBanner() lets the exit animation finish before the card leaves the flow,
// so [hidden] lands 200ms after the state that caused it. Waiting for the
// element rather than for a fixed delay keeps this from being a race that
// passes on a fast machine.
async function gone() {
    for (let i = 0; i < 40; i++) {
        if (pill().hidden) return true;
        await new Promise((r) => setTimeout(r, 10));
    }
    return pill().hidden;
}

// Push a state the way main/updater.js does — to every subscriber, because
// that is what ipcRenderer.on does.
async function state(patch) {
    const s = Object.assign({ status: 'idle', version: null, noteBlocks: [] }, patch);
    stateSubs.forEach((cb) => cb(s));
    await settle(2);
}

const pill = () => $('update-banner');
const isCta = () => pill().classList.contains('ub-cta');

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
        board: vi.fn(async (p) => {
            if (p === 'list') return { success: true, posts: [], typing: [], voice: [], hasMore: false, maxId: 0 };
            if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
            if (p === 'presence') return { success: true, members: [] };
            if (p === 'dm/threads') return { success: true, threads: [] };
            return { success: true };
        }),
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
            onMessage: (cb) => { rtHandler = cb; return noop; },
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
            setTheme: vi.fn(async () => true), onThemeChange: unsub, onCommand: unsub,
            onResync: (cb) => { resyncHandler = cb; return noop; }
        },
        startup: {
            get: vi.fn(async () => ({ openAtLogin: false, openAsHidden: false })),
            set: vi.fn(async () => ({ openAtLogin: false, openAsHidden: false }))
        },
        update,
        fileUrl: (k) => 'lounge://file/' + encodeURIComponent(k)
    };

    window.hljs = { highlightElement: noop };
    window.HTMLMediaElement.prototype.play = () => Promise.resolve();
    window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || noop;
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

describe('finding out on its own', () => {
    it('checks the moment a release is announced over the socket', async () => {
        expect(rtHandler).toBeTruthy();
        update.check.mockClear();
        rtHandler({ t: 'release', version: '9.9.9' });
        await settle();
        // Nobody pressed anything. This is the whole point: the app is told,
        // and it asks its own feed — which is the only thing that decides what
        // is actually installable.
        expect(update.check).toHaveBeenCalled();
    });

    it('checks again whenever the app comes back from being away', async () => {
        // Restored from the tray, woken from sleep, socket reconnected: any of
        // those is a window in which the announcement went out with nobody
        // here to hear it.
        expect(resyncHandler).toBeTruthy();
        update.check.mockClear();
        resyncHandler();
        await settle();
        expect(update.check).toHaveBeenCalled();
    });

    it('does not re-check on top of an update it already has', async () => {
        await state({ status: 'downloading', version: '9.9.9', progress: 40 });
        update.check.mockClear();
        rtHandler({ t: 'release', version: '9.9.9' });
        resyncHandler();
        await settle();
        // A second check restarts a download that is already running, and the
        // pill is on screen either way.
        expect(update.check).not.toHaveBeenCalled();
    });
});

describe('the pill', () => {
    it('appears as soon as an update is available, and says so', async () => {
        await state({ status: 'available', version: '9.9.9' });
        expect(pill().hidden).toBe(false);
        expect($('ub-text').textContent).toBe('Update Available');
        expect($('ub-sub').textContent).toContain('9.9.9');
        expect(isCta()).toBe(true);
    });

    it('keeps ONE headline while the download runs', async () => {
        await state({ status: 'downloading', version: '9.9.9', progress: 40 });
        // It used to rename itself between "Update available", "Downloading
        // update" and "Update ready" — three notifications for one event, and
        // only the last was pressable.
        expect($('ub-text').textContent).toBe('Update Available');
        expect($('ub-sub').textContent).toContain('40%');
        expect($('ub-progress').hidden).toBe(false);
        expect(isCta()).toBe(true);
    });

    it('…and when it is ready to install', async () => {
        await state({ status: 'ready', version: '9.9.9', waitingFor: 'user' });
        expect($('ub-text').textContent).toBe('Update Available');
        expect($('ub-action').textContent).toBe('Restart & Update');
        expect($('ub-action').disabled).toBe(false);
        expect(isCta()).toBe(true);
    });

    it('names the one thing that can hold it', async () => {
        await state({ status: 'ready', version: '9.9.9', waitingFor: 'call' });
        expect($('ub-sub').textContent).toContain('call');
        // Still pressable: restarting through your own call is a choice only
        // the person in it can make.
        expect($('ub-action').disabled).toBe(false);
        expect($('ub-action').textContent).toBe('Restart now');
    });

    it('admits a download that died, and offers the way out', async () => {
        await state({ status: 'available', version: '9.9.9', stalled: true, error: 'ENOTFOUND' });
        expect($('ub-text').textContent).toBe('Update Available');
        expect($('ub-sub').textContent).toContain('ENOTFOUND');
        expect($('ub-action').textContent).toBe('Try again');
        expect($('ub-action').disabled).toBe(false);
    });

    it('stays out of the way when there is nothing to say', async () => {
        await state({ status: 'none' });
        expect(await gone()).toBe(true);
    });
});

describe('one click', () => {
    it('installs from the button', async () => {
        await state({ status: 'ready', version: '9.9.9', waitingFor: 'user' });
        update.install.mockClear();
        $('ub-action').click();
        await settle();
        expect(update.install).toHaveBeenCalled();
    });

    it('installs from anywhere on the pill', async () => {
        await state({ status: 'ready', version: '9.9.9', waitingFor: 'user' });
        update.install.mockClear();
        $('ub-text').click();
        await settle();
        // A 90px button inside a 620px bar is a small target for the one action
        // the bar exists to offer.
        expect(update.install).toHaveBeenCalled();
    });

    it('works while the download is still running', async () => {
        await state({ status: 'downloading', version: '9.9.9', progress: 12 });
        update.install.mockClear();
        $('ub-action').click();
        await settle();
        // install() remembers the click and acts on it when the bytes land, so
        // the user never presses twice — see installNow in main/updater.js.
        expect(update.install).toHaveBeenCalled();
        expect(update.download).not.toHaveBeenCalled();
    });

    it('goes flat once the click is on its way', async () => {
        await state({ status: 'downloading', version: '9.9.9', progress: 30, waitingFor: 'download' });
        expect($('ub-action').textContent).toBe('Updating…');
        expect($('ub-action').disabled).toBe(true);
    });

    it('is not what dismiss means', async () => {
        await state({ status: 'ready', version: '9.9.9', waitingFor: 'user' });
        update.install.mockClear();
        $('ub-dismiss').click();
        await settle();
        expect(update.install).not.toHaveBeenCalled();
        expect(await gone()).toBe(true);
    });
});
