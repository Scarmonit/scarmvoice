// @vitest-environment jsdom
//
// One person, two install ids — and everything that went wrong because of it.
//
// The realtime layer substitutes an install id of its own for any it cannot
// verify against the account. So its roster, its typing feed and its presence
// can all name somebody by a DIFFERENT id than the SFU and the HTTP endpoints
// use for the same person. Every place the client joined those two sources on
// the id alone then drew one person as two:
//
//   • the voice roster grew a second copy that appeared and vanished every few
//     seconds as the socket and the poll took turns — reported as "a clone that
//     joins and leaves on a loop";
//   • the typing line read "XIAIX and XIAIX are typing…".
//
// The id mismatch is fixed at its source (main.js no longer opens the socket
// before the install is bound), but the client must not be able to produce a
// phantom person again if it ever recurs — which is what this file pins.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RENDERER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');

const noop = () => {};
const unsub = () => noop;
const $ = (id) => document.getElementById(id);

const ME = { id: 1, username: 'Scarmonit', role: 'admin' };

// The two ids for ONE person. REAL is what they post, heartbeat and join voice
// under; RT is what the realtime layer handed their socket instead.
const REAL = 'c39rosj75zdbms4x2t8a';
const RT = 's0d1e2f3a4b5c6d7e8f9';
const THEM_UID = 3;

let rtOnMessage = null;          // the renderer's socket handler
let winOnFocus = null;           // main's focus/blur bridge
let onResync = null;             // main's restore-from-tray bridge
let voiceApi = null;             // the fake engine, so a test can drive it
let voiceOpts = null;            // the callbacks app.js hands the engine
let peerMuted = false;           // what the SFU says about THEIR microphone

// The member list the presence endpoint returns — the person by their REAL id.
const MEMBERS = [{ client_id: REAL, user_id: THEM_UID, name: 'XIAIX', status: 'online', custom: '' }];

let listPosts = [];
let typingRows = [];

const board = vi.fn(async (p) => {
    if (p === 'list') {
        return { success: true, posts: listPosts, typing: typingRows, voice: [], hasMore: false, maxId: 0 };
    }
    if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
    if (p === 'presence') return { success: true, members: MEMBERS };
    if (p === 'post') return { success: true, id: 991 };
    if (p === 'dm/threads') return { success: true, threads: [] };
    return { success: true };
});

async function settle(n = 14) {
    for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
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
            onMessage: (cb) => { rtOnMessage = cb; return noop; },
            onStatus: unsub
        },
        edit: {
            cut: noop, copy: noop, paste: noop, selectAll: noop,
            clipboard: vi.fn(async () => ({ text: false, image: false }))
        },
        settings: {
            get: vi.fn(async () => ({
                baseUrl: 'https://scarmonit.com', room: 'lounge', clientId: 'me',
                displayName: 'Scarmonit', channel: 'general', theme: 'dark', density: 'cozy',
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
            isFocused: vi.fn(async () => true),
            onFocus: (cb) => { winOnFocus = cb; return noop; },
            onHidden: () => noop
        },
        app: {
            version: vi.fn(async () => '0.0.0-test'), isElevated: vi.fn(async () => false),
            openLogs: vi.fn(async () => true), notify: vi.fn(async () => false),
            setVoiceState: vi.fn(async () => ({})), setBadge: vi.fn(async () => true),
            openExternal: vi.fn(async () => true), systemTheme: vi.fn(async () => ({ dark: true })),
            setTheme: vi.fn(async () => true), onThemeChange: unsub, onCommand: unsub,
            // Held: app:resync is the event main.js fires on restore-from-tray,
            // and the one that now drives a background refresh. The synthetic
            // visibilitychange these specs used to dispatch never reaches the
            // app — backgroundThrottling is off, so Chromium freezes
            // document.hidden at false and never fires it.
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
    // jsdom implements neither, and jumpToLatest() uses scrollTo — without
    // this the rail tests pass while throwing into vitest's unhandled trap.
    Element.prototype.scrollTo = Element.prototype.scrollTo || noop;
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

    // A voice engine that is IN the call, with the other person peered under
    // their REAL install id — which is what the SFU always sees, because the
    // token is minted for the id the client actually holds.
    window.createVoice = (opts) => {
        voiceOpts = opts;
        voiceApi = {
            joined: true,
            muted: false,
            deafened: false,
            join: async () => {}, leave: vi.fn(),
            roster: () => (voiceApi.joined
                ? [{ id: 'me', name: 'Scarmonit', isMe: true, muted: false, deafened: false },
                    { id: REAL, name: 'XIAIX', isMe: false, muted: peerMuted }]
                : []),
            shares: () => [],
            state: () => ({ joined: voiceApi.joined, shareQuality: '1080p', shareMotion: 'sharp' }),
            setSettings: noop, setMuted: noop, setDeafened: noop, setPttHeld: noop,
            setLocalVolume: noop, setLocalMuted: noop,
            setShareQuality: noop, setShareMotion: noop,
            startShare: async () => false, stopShare: noop, isSharing: () => false,
            enableCam: async () => false, disableCam: async () => false,
            isCamOn: () => false, toggleCam: noop, cams: () => [],
            isJoined: () => voiceApi.joined,
            isMuted: () => voiceApi.muted,
            isDeafened: () => voiceApi.deafened,
            toggleMuted: vi.fn(), toggleDeafened: vi.fn(),
            warm: vi.fn()
        };
        return voiceApi;
    };
    run('app.js');
    await settle();
});

describe('the voice roster', () => {
    it('draws one row for a person the socket and the SFU name differently', async () => {
        // The realtime roster, carrying the SUBSTITUTE id — the exact payload
        // that used to produce the clone.
        rtOnMessage({
            t: 'voice',
            list: [{ cid: RT, user_id: THEM_UID, name: 'XIAIX', muted: false }]
        });
        await settle(2);

        const rows = Array.from($('voice-users').querySelectorAll('.vp'));
        const named = rows.map((r) => r.querySelector('.vp-name').textContent);
        expect(named.filter((n) => n === 'XIAIX').length).toBe(1);
        // Me, and them. Not me, them, and them again.
        expect(rows.length).toBe(2);
    });

    it('offers the same voice menu from your own row in the member list', () => {
        // The identical row in the member sidebar did nothing at all, while the
        // one under the voice channel opened mute/deafen/leave. Same person,
        // same call, two different answers depending on which list you clicked.
        const mine = $('members-list').querySelector('.vp.me');
        expect(mine).toBeTruthy();
        mine.click();
        const labels = Array.from($('ctx-menu').querySelectorAll('.ctx-label')).map((s) => s.textContent);
        expect(labels).toContain('Leave Voice');
        expect(labels.some((l) => /Mute Microphone|Unmute Microphone/.test(l))).toBe(true);
        expect(labels.some((l) => /Deafen|Undeafen/.test(l))).toBe(true);
    });

    it('offers you a way out of the call from your own row', () => {
        const mine = $('voice-users').querySelector('.vp.me');
        expect(mine).toBeTruthy();
        mine.click();
        const labels = Array.from($('ctx-menu').querySelectorAll('.ctx-label')).map((s) => s.textContent);
        expect(labels).toContain('Leave Voice');

        const before = voiceApi.leave.mock.calls.length;
        Array.from($('ctx-menu').querySelectorAll('.ctx-item'))
            .find((b) => b.textContent.includes('Leave Voice')).click();
        expect(voiceApi.leave.mock.calls.length).toBe(before + 1);
    });
});

describe('what everyone can see about a microphone', () => {
    const peerRow = () => $('voice-users').querySelector(`.vp[data-cid="${REAL}"]`);

    it('shows that somebody has muted THEMSELVES', async () => {
        // voice.js maps this from the SFU's audioEnabled. It used to report
        // `settings.localMuted[cid]` instead — whether *I* had silenced them —
        // so muting yourself was visible to nobody but yourself.
        peerMuted = true;
        rtOnMessage({ t: 'voice', list: [{ cid: RT, user_id: THEM_UID, name: 'XIAIX', muted: true }] });
        await settle(2);
        expect(peerRow().querySelector('[title="Muted"]')).toBeTruthy();
    });

    it('shows that somebody has deafened themselves', async () => {
        // Deafening never touches a published track, so the SFU cannot know it
        // at all — it rides the presence layer, and the SFU row has to inherit
        // it from there or nobody would ever see it.
        rtOnMessage({
            t: 'voice',
            list: [{ cid: RT, user_id: THEM_UID, name: 'XIAIX', muted: true, deafened: true }]
        });
        await settle(2);
        expect(peerRow().querySelector('[title="Deafened"]')).toBeTruthy();
        peerMuted = false;
    });

    it('takes a peer mute from the SFU, not from my own local mute of them', () => {
        // Static, because the mapping lives in voice.js's closure: the two are
        // different facts and must not share a field again.
        const voicejs = fs.readFileSync(path.join(RENDERER, 'voice.js'), 'utf8');
        expect(voicejs).toContain('muted: p.audioEnabled === false');
        expect(voicejs).toMatch(/localMuted: !!\(settings\.localMuted/);
    });
});

describe('warming the next call', () => {
    it('mints a fresh token when a call ends', async () => {
        // A participant token is CONSUMED by the join that spends it, so the
        // warm-up has to run again for the next one. Latched with the SDK — which
        // genuinely is once per session — exactly one join per session got a warm
        // token and every rejoin paid the full ~800ms round trip again.
        //
        // Leaving is also the moment no hover arrives to trigger it: the pointer
        // is usually already sitting inside the voice area when somebody hangs up.
        voiceApi.warm.mockClear();
        voiceOpts.onState(Object.assign(voiceApi.state(), { joined: true }));
        voiceOpts.onState(Object.assign(voiceApi.state(), { joined: false }));
        await new Promise((r) => setTimeout(r, 700));
        expect(voiceApi.warm).toHaveBeenCalled();
    });
});

describe('the speaking ring in the me bar', () => {
    const wrap = () => document.querySelector('#me-bar .me-av-wrap');

    it('lights up when it is YOU talking', () => {
        expect(wrap()).toBeTruthy();
        expect(wrap().classList.contains('speaking')).toBe(false);
        voiceOpts.onSpeaking('me', true, true);
        expect(wrap().classList.contains('speaking')).toBe(true);
        voiceOpts.onSpeaking('me', false, true);
        expect(wrap().classList.contains('speaking')).toBe(false);
    });

    it('does not light up for somebody else talking', () => {
        voiceOpts.onSpeaking(REAL, true, false);
        expect(wrap().classList.contains('speaking')).toBe(false);
        voiceOpts.onSpeaking(REAL, false, false);
    });

    it('survives the repaint a call state change triggers', () => {
        // renderMe() rewrites the avatar's inline style, which is why the ring
        // is on the wrapper — drawn on the avatar it would be erased at exactly
        // the moment somebody joins or leaves the call.
        voiceOpts.onSpeaking('me', true, true);
        voiceOpts.onState(voiceApi.state());
        expect(wrap().classList.contains('speaking')).toBe(true);
        voiceOpts.onSpeaking('me', false, true);
    });
});

describe('the typing line', () => {
    it('names a person once however many ids they arrive under', async () => {
        // BOTH pipes have to deliver for this to reproduce: the poll's row under
        // the id they post with, THEN the socket's under the substitute. A test
        // that only fires one of them passes with the bug still in.
        typingRows = [{ client_id: REAL, name: 'XIAIX' }];
        onResync();
        await settle();
        rtOnMessage({ t: 'typing', channel: 'general', cid: RT, name: 'XIAIX' });
        await settle(2);

        expect($('typing-line').textContent).toBe('XIAIX is typing…');
    });

    it('never says that YOU are typing', async () => {
        // A poll first, so this starts from the list the server actually
        // reports rather than from the previous test's leftovers.
        typingRows = [{ client_id: 'some-other-install-of-mine', name: 'Scarmonit' }];
        onResync();
        await settle();
        // …and the socket's copy of me, under a third id.
        rtOnMessage({ t: 'typing', channel: 'general', cid: 'another', name: 'Scarmonit' });
        await settle(2);
        expect($('typing-line').textContent).toBe('');
        typingRows = [];
    });
});

describe('the rail', () => {
    const inDmPlace = () => !$('dm-sidebar').hidden && $('sidebar').hidden;

    it('goes to direct messages and back again from the server mark', async () => {
        $('rail-dms').click();
        await settle();
        expect(inDmPlace()).toBe(true);

        // The way BACK. This used to jump a message list that was not on
        // screen and leave you exactly where you were, so the only exit was
        // pressing @ a second time — a toggle pretending to be navigation.
        $('rail-home').click();
        await settle();
        expect(inDmPlace()).toBe(false);
    });

    it('only ever goes TO direct messages, never back out of them', async () => {
        $('rail-dms').click();
        await settle();
        expect(inDmPlace()).toBe(true);

        // Pressing it again used to throw you back to the channel. A
        // destination that means "leave" when you are already on it is the
        // reason the way back was not findable.
        $('rail-dms').click();
        await settle();
        expect(inDmPlace()).toBe(true);

        $('rail-home').click();
        await settle();
        expect(inDmPlace()).toBe(false);
    });

    it('marks which of the two places you are in', async () => {
        $('rail-dms').click();
        await settle();
        expect($('rail-dms').classList.contains('active')).toBe(true);
        expect($('rail-home').classList.contains('active')).toBe(false);

        $('rail-home').click();
        await settle();
        expect($('rail-home').classList.contains('active')).toBe(true);
        expect($('rail-dms').classList.contains('active')).toBe(false);
    });

    it('names both marks on hover', () => {
        // data-tip, not title: the app draws its own tooltip at once, where the
        // OS bubble waits a second and ignores the theme.
        expect($('rail-dms').getAttribute('data-tip')).toBe('Direct Messages');
        expect($('rail-home').getAttribute('data-tip')).toBe('ScarmVoice');
        // And a name for anything that cannot see the glyph.
        expect($('rail-dms').getAttribute('aria-label')).toBe('Direct Messages');
        expect($('rail-home').getAttribute('aria-label')).toBe('ScarmVoice');
    });
});

describe('what you publish about yourself', () => {
    // The last thing the presence heartbeat told the server.
    const lastPresence = () => {
        const calls = board.mock.calls.filter((c) => c[0] === 'presence');
        return calls.length ? calls[calls.length - 1][1].body : null;
    };

    it('stays online when the window merely loses focus', async () => {
        expect(winOnFocus).toBeTruthy();
        winOnFocus(false);                       // clicked into another window
        board.mockClear();
        // Any change publishes immediately rather than up to 20s later.
        const st = $('set-status');
        st.value = 'heads down';
        st.dispatchEvent(new window.Event('change', { bubbles: true }));
        await settle();

        // `!windowFocused` used to mean away, so everyone was away almost all of
        // the time — the member list showed people as away while they sat there
        // reading it.
        expect(lastPresence().status).toBe('online');
    });

    it('still goes away when the window is put away', async () => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        board.mockClear();
        const st = $('set-status');
        st.value = 'in the tray';
        st.dispatchEvent(new window.Event('change', { bubbles: true }));
        await settle();
        expect(lastPresence().status).toBe('away');
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        winOnFocus(true);
    });
});

describe('sending a message', () => {
    it('shows it to the sender at once, before the server page carries it', async () => {
        // The read replica has not caught up — `list` still returns nothing,
        // which is exactly the state that left your own message off your own
        // screen until you switched channels and came back.
        listPosts = [];
        const input = $('composer-input');
        input.value = 'does this show up';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        $('composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
        await settle();

        const rows = Array.from($('messages').querySelectorAll('.msg'));
        expect(rows.some((r) => r.textContent.includes('does this show up'))).toBe(true);
    });

    it('does not draw it twice once the page catches up', async () => {
        // Same id the post returned: the echo and the server copy share a row.
        listPosts = [{
            id: 991, body: 'does this show up', name: 'Scarmonit', client_id: 'me',
            user_id: ME.id, created_at: Date.now(), reactions: [], pinned: 0
        }];
        onResync();
        await settle();

        const hits = Array.from($('messages').querySelectorAll('.msg'))
            .filter((r) => r.textContent.includes('does this show up'));
        expect(hits.length).toBe(1);
    });
});
