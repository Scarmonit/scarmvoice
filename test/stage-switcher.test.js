// @vitest-environment jsdom
//
// The viewing stage, driven the way the voice engine drives it. Boots the real
// renderer signed in, with window.createVoice replaced by a capture of the
// callbacks app.js registers — so onShares/onCams can be fired by hand and the
// resulting DOM asserted.
//
// What it protects: WATCHING IS OPT-IN. A stream that starts is offered — a Live
// tile in the call grid, a LIVE badge in the roster — and plays only once
// somebody asks for it. The regression this exists to catch is the old
// behaviour, where the newest screen share was dropped onto the stage of
// everyone in the call whether they wanted it or not. With several streams live,
// the user's pick between them (and between somebody's screen and their camera)
// is the rest of the feature.
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
let watched = null;
// Driven by the roster test at the bottom, which needs the app to believe it is
// in a call with somebody in it.
let inCall = false;
let people = [];
function fakeVoice(opts) {
    Object.assign(cb, opts);
    return {
        join: async () => {}, leave: noop, roster: () => people, shares: () => [],
        state: () => ({ joined: false, shareQuality: '1080p', shareMotion: 'sharp' }),
        setSettings: noop, setMuted: noop, setDeafened: noop, setPttHeld: noop,
        setLocalVolume: noop, setLocalMuted: noop,
        setShareQuality: noop, setShareMotion: noop,
        // The renderer tells the engine what it is watching so the share audio
        // can follow the picture; the last value is asserted below.
        setWatchedShare: (cid) => { watched = cid || null; }, watchedShare: () => watched,
        startShare: async () => false, stopShare: noop, isSharing: () => false,
        enableCam: async () => false, disableCam: async () => false,
        isCamOn: () => false, toggleCam: noop, cams: () => [],
        isJoined: () => inCall, isMuted: () => false, isDeafened: () => false
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
const pill = (name) => pills().find((b) => b.textContent.includes(name));
// The offer in the call grid: one Live tile per screen share, each with the
// button that opts you in.
const liveTiles = () => Array.from(document.querySelectorAll('.share-tile'));
const liveTile = (name) => liveTiles().find((t) => t.textContent.includes(name));
const watchBtn = (name) => liveTile(name).querySelector('.live-watch');

beforeAll(async () => {
    const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
    document.documentElement.innerHTML = html
        .replace(/<script[\s\S]*?<\/script>/g, '')
        .replace(/^[\s\S]*?<body>/, '<head></head><body>')
        .replace(/<\/body>[\s\S]*$/, '</body>');

    window.lounge = {
        // Signed in, so enterApp() runs and setupVoice() registers the callbacks.
        auth: { status: vi.fn(async () => ({ authed: true })), login: vi.fn(async () => ({ success: true })), logout: noop },
        account: {
            register: vi.fn(async () => ({ success: false })), login: vi.fn(async () => ({ success: false })),
            logout: vi.fn(async () => ({ success: true })),
            // Signed into an account too — accounts are mandatory, and a null
            // user would park boot() at the account gate instead of enterApp().
            me: vi.fn(async () => ({ success: true, user: { id: 1, username: 'Me', role: 'member', client_id: 'me' } }))
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
            start: vi.fn(async () => ({ connected: false })), stop: vi.fn(async () => ({ connected: false })),
            wake: vi.fn(async () => ({ connected: false })),
            send: noop, notifyPosted: noop, sendTyping: noop, sendVoice: noop,
            onMessage: unsub, onStatus: unsub
        },
        edit: { cut: noop, copy: noop, paste: noop, selectAll: noop, clipboard: vi.fn(async () => ({ text: false, image: false })),
            onContext: unsub, replaceMisspelling: vi.fn(async () => true), addToDictionary: vi.fn(async () => true) },
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
        win: { minimize: noop, maximize: noop, close: noop, isFocused: vi.fn(async () => true), onFocus: unsub, onHidden: unsub },
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
    // The composer IS a CodeMirror instance now, so the editor has to be on
    // window before app.js runs.
    run('vendor/codemirror.js');
    run('lib.js');
    run('audio.js');
    run('noise.js');    // defines window.ScarmNoise; its getUserMedia patch no-ops in jsdom
    run('sounds.js');
    run('theme.js');
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

    it('OFFERS a stream rather than starting it — the whole point', () => {
        cb.onShares([share('a', 'Alice')]);
        // Nothing is playing. The old behaviour put Alice's screen on every
        // participant's stage the instant she pressed Share.
        expect($('stage').hidden).toBe(true);
        // What there is instead: a tile in the call grid saying she is live and
        // a button to take it up.
        expect($('camera-stage').hidden).toBe(false);
        expect(liveTiles()).toHaveLength(1);
        expect(liveTile('Alice').textContent).toContain('LIVE');
        expect(watchBtn('Alice').textContent).toBe('Watch Stream');
        // And no video element for it: an unwatched share is not decoded here.
        expect(liveTile('Alice').querySelector('video')).toBe(null);
        // The engine is told nobody is being watched, so its audio stays muted.
        expect(watched).toBe(null);
    });

    it('opens the stream when you press Watch Stream', () => {
        watchBtn('Alice').click();
        expect($('stage').hidden).toBe(false);
        expect($('stage-title').textContent).toBe("Watching Alice's screen");
        expect(watched).toBe('a');
        expect(watchBtn('Alice').textContent).toBe('Stop Watching');
        expect(liveTile('Alice').classList.contains('watching')).toBe(true);
    });

    it('leaves the stream again without ending it', () => {
        $('stage-close').click();
        expect($('stage').hidden).toBe(true);
        expect(watched).toBe(null);
        // The presenter is untouched — the offer is still standing.
        expect(watchBtn('Alice').textContent).toBe('Watch Stream');
    });

    it('does not drag you into a second presenter either', () => {
        cb.onShares([share('a', 'Alice'), share('b', 'Bob')]);
        expect($('stage').hidden).toBe(true);
        expect(liveTiles()).toHaveLength(2);

        watchBtn('Bob').click();
        expect($('stage-title').textContent).toBe("Watching Bob's screen");
        // With more than one live stream the strip appears, so switching
        // between them is one click.
        expect($('stage-sources').hidden).toBe(false);
        expect(pillText()).toEqual(["Alice's screen", "Bob's screen"]);
        expect(activePill()).toBe("Bob's screen");
    });

    it('keeps your pick when another presenter appears or leaves', () => {
        cb.onShares([share('a', 'Alice'), share('b', 'Bob'), share('c', 'Cass')]);
        expect($('stage-title').textContent).toBe("Watching Bob's screen");

        // Alice stops: Bob was the explicit choice and stays put.
        cb.onShares([share('b', 'Bob'), share('c', 'Cass')]);
        expect($('stage-title').textContent).toBe("Watching Bob's screen");
    });

    it('closes rather than helping itself to the next presenter', () => {
        // The one you were watching stops. Falling through to Cass would be the
        // same forced view this feature exists to remove.
        cb.onShares([share('c', 'Cass')]);
        expect($('stage').hidden).toBe(true);
        expect(watched).toBe(null);
        expect(liveTile('Cass')).toBeTruthy();
    });

    it('offers a camera and a screen as two separate things to watch', () => {
        watchBtn('Cass').click();
        cb.onCams([cam('d', 'Dev')]);
        expect(pillText()).toEqual(["Cass's screen", "Dev's camera"]);
        // A camera does not take the stage on its own either.
        expect($('stage-title').textContent).toBe("Watching Cass's screen");
    });

    it('puts a camera on the stage when you choose it', () => {
        pill('Dev').click();
        expect($('stage-title').textContent).toBe("Dev's camera");
        // …and the share audio goes with the picture: no longer watching Cass.
        expect(watched).toBe(null);
        expect($('cam-grid').querySelector('.cam-tile:not(.share-tile)')
            .classList.contains('watching')).toBe(true);
    });

    it('lets one person offer both, and lets you pick between them', () => {
        // Dev shares their screen while their camera is still on.
        cb.onShares([share('d', 'Dev')]);
        expect(pillText()).toEqual(["Dev's screen", "Dev's camera"]);
        expect($('stage-title').textContent).toBe("Dev's camera");

        pill("Dev's screen").click();
        expect($('stage-title').textContent).toBe("Watching Dev's screen");
        expect(watched).toBe('d');

        pill("Dev's camera").click();
        expect($('stage-title').textContent).toBe("Dev's camera");
        expect(watched).toBe(null);
    });

    it('closes the stage when the share you left ends and only a camera is left', () => {
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

    it('opens your OWN share by itself, and lets you put it away', () => {
        cb.onCams([]);
        cb.onShares([share('me', 'Me', true)]);
        // You pressed Share a moment ago; this is where you check what the rest
        // of the call is being sent.
        expect($('stage').hidden).toBe(false);
        expect($('stage-title').textContent).toBe('You are sharing your screen');
        // Your own preview is not something you "watch", so nothing is reported
        // to the engine and the buttons say what they do.
        expect(watched).toBe(null);
        expect($('stage-close').textContent).toBe('Hide');
        expect($('stage-stop').hidden).toBe(false);

        $('stage-close').click();
        expect($('stage').hidden).toBe(true);
        // …and it stays away until you ask for it back.
        cb.onShares([share('me', 'Me', true)]);
        expect($('stage').hidden).toBe(true);
        expect(watchBtn('You').textContent).toBe('Show preview');
    });

    it('drops the stage when every source goes away', () => {
        cb.onCams([]);
        cb.onShares([]);
        expect($('stage').hidden).toBe(true);
        expect($('camera-stage').hidden).toBe(true);
    });

    // The sidebar half of the offer. With nothing auto-opening, a person who is
    // looking at the conversation rather than the grid needs the roster to say a
    // stream exists — and the row they click has to lead somewhere.
    it('badges a live presenter in the voice roster and offers both streams from their popover', () => {
        inCall = true;
        people = [
            { id: 'a', name: 'Alice', isMe: false, muted: false },
            { id: 'me', name: 'Me', isMe: true, muted: false }
        ];
        cb.onCams([cam('a', 'Alice')]);
        cb.onShares([share('a', 'Alice')]);

        const row = Array.from(document.querySelectorAll('#voice-users .vu'))
            .find((li) => li.textContent.includes('Alice'));
        expect(row.querySelector('.vp-live').textContent).toBe('LIVE');

        row.click();
        // Screen and camera are two separate entries: someone doing both is two
        // things to watch, and this is where you choose.
        expect($('pop-watch').hidden).toBe(false);
        expect($('pop-watch-label').textContent).toBe('Watch Stream');
        expect($('pop-watch-cam').hidden).toBe(false);
        expect($('pop-watch-cam-label').textContent).toBe('Watch Camera');

        $('pop-watch').click();
        expect($('stage-title').textContent).toBe("Watching Alice's screen");
        expect(watched).toBe('a');

        // …and the camera is one more click away, not a different feature.
        row.click();
        expect($('pop-watch-label').textContent).toBe('Stop Watching Stream');
        $('pop-watch-cam').click();
        expect($('stage-title').textContent).toBe("Alice's camera");
        expect(watched).toBe(null);
    });
});
