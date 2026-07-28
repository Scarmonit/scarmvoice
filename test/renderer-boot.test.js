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
    run('lazy.js');
    run('noise.js');
    // Same order as index.html. soundboard.js patches getUserMedia and is a
    // no-op when navigator.mediaDevices is absent, which it is in jsdom — but
    // it still has to parse and still has to define window.ScarmBoard, which is
    // exactly the class of breakage this tier exists to catch.
    run('soundboard.js');
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
        expect(typeof window.ScarmBoard).toBe('object');
    });

    it('exposes a soundboard with clips and a clamped volume', () => {
        const sounds = window.ScarmBoard.sounds();
        expect(Array.isArray(sounds)).toBe(true);
        expect(sounds.length).toBeGreaterThan(0);
        expect(sounds.every((s) => s.id && s.label)).toBe(true);

        // Volume is published to the whole call, so an out-of-range value
        // reaching the gain node is everyone's problem, not just the sender's.
        window.ScarmBoard.setVolume(5);
        expect(window.ScarmBoard.getVolume()).toBe(1);
        window.ScarmBoard.setVolume(-2);
        expect(window.ScarmBoard.getVolume()).toBe(0);
        window.ScarmBoard.setVolume('nonsense');
        expect(window.ScarmBoard.getVolume()).toBe(0.8);
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

// The login card is a small state machine across four panels, and every bug the
// user hit was a transition getting it wrong: the wrong panel visible, focus
// pulled out of the field being typed into, or a step replaced while its owner
// was in their email client fetching a code.
describe('login flow', () => {
    const $ = (id) => document.getElementById(id);
    const visible = (id) => !$(id).hidden;

    // Panels are mutually exclusive; the click handlers are the real ones,
    // wired at IIFE scope when app.js evaluated.
    function panels() {
        return {
            pw: visible('login-pw'),
            signin: visible('login-acct'),
            create: visible('login-create'),
            verify: visible('login-verify'),
            totp: visible('login-totp')
        };
    }

    it('starts on the board password step, alone', async () => {
        await new Promise((r) => setTimeout(r, 0));
        expect(panels()).toEqual({ pw: true, signin: false, create: false, verify: false, totp: false });
    });

    it('says the first password is the app\'s, not an account\'s', () => {
        // The whole complaint: two password fields in one flow, both labelled
        // "Password", so people tried their account password on the door.
        expect($('login-pw').placeholder).toBe('Board password');
        expect($('login-pw-hint').textContent).toMatch(/unlocks the app/i);
        expect($('login-sub').textContent).toMatch(/shared password/i);
    });

    it('has no display name field to impersonate anyone with', () => {
        // The name everyone sees is the account username. There is no free-text
        // name on the login card, and Settings shows rather than asks.
        expect($('login-name')).toBeNull();
        expect($('set-name').readOnly).toBe(true);
    });

    it('keeps sign-in and account creation on separate panels', () => {
        $('login-goto-create').click();
        expect(panels()).toEqual({ pw: false, signin: false, create: true, verify: false, totp: false });
        // The email field belongs to creation only — on the sign-in panel it
        // used to sit there with nothing saying whether it was wanted.
        expect($('login-create').contains($('login-new-email'))).toBe(true);
        expect($('login-acct').contains($('login-new-email'))).toBe(false);

        $('login-goto-signin').click();
        expect(panels()).toEqual({ pw: false, signin: true, create: false, verify: false, totp: false });
    });

    it('does not pull focus out of a field being typed into', () => {
        // The reported bug: type a username, Tab to the password, and focus
        // snaps back up to the username mid-word. Any re-entry of a panel that
        // is already up called focus() unconditionally.
        $('login-goto-signin').click();
        $('login-acct-pw').focus();
        expect(document.activeElement.id).toBe('login-acct-pw');

        $('login-goto-signin').click();      // re-enter the panel it is already on
        expect(document.activeElement.id).toBe('login-acct-pw');

        $('login-goto-create').click();      // a real transition may take focus
        expect(document.activeElement.id).toBe('login-new-user');
    });

    it('tells the user the code screen will wait for them', () => {
        expect($('login-verify').textContent).toMatch(/wait for you/i);
    });
});

// The account panel and the two device menus only exist once something is
// clicked, so booting alone never touches them — every id they reach for is
// unverified until then. That is precisely how the profile-picture button
// shipped broken, so these drive the clicks.
describe('the account panel', () => {
    const $ = (id) => document.getElementById(id);
    const click = (id) => $(id).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    it('opens from the name and paints who you are', () => {
        expect($('me-popover').hidden).toBe(true);
        click('btn-name');
        expect($('me-popover').hidden).toBe(false);
        expect($('btn-name').getAttribute('aria-expanded')).toBe('true');
        // Signed out in this harness, so the two account-only actions are gone
        // and the handle says so rather than showing an empty @.
        expect($('mep-handle').textContent).toBe('not signed in');
        expect($('mep-switch').hidden).toBe(true);
        expect($('mep-copy-id').hidden).toBe(true);
        expect(errors).toEqual([]);
    });

    it('closes when the name is clicked again', () => {
        click('btn-name');
        expect($('me-popover').hidden).toBe(true);
        expect($('btn-name').getAttribute('aria-expanded')).toBe('false');
    });

    it('offers the four presence modes with the active one ticked', () => {
        click('btn-name');
        click('mep-status');
        const menu = $('ctx-menu');
        expect(menu.hidden).toBe(false);

        const labels = [...menu.querySelectorAll('.ctx-item')].map((b) => b.textContent.trim());
        expect(labels[0]).toBe('Online');
        expect(labels[1]).toBe('Idle');
        expect(labels[2]).toMatch(/^Do Not Disturb/);
        expect(labels[3]).toMatch(/^Invisible/);

        // Every mode carries its colour, which is the thing being chosen.
        const dots = [...menu.querySelectorAll('.ctx-dot')].map((d) => d.className);
        expect(dots.length).toBe(4);
        expect(dots[1]).toContain('away');
        expect(dots[2]).toContain('dnd');
        expect(dots[3]).toContain('invisible');

        // Default profile: Online is the active one.
        const checked = [...menu.querySelectorAll('.ctx-item.checked')].map((b) => b.textContent.trim());
        expect(checked).toEqual(['Online']);
    });

    it('writes the chosen mode and keeps the dnd boolean in step', async () => {
        window.lounge.settings.set.mockClear();
        // Idle is the second item in the menu opened by the test above.
        const items = [...$('ctx-menu').querySelectorAll('.ctx-item')];
        items[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 0));

        const patch = window.lounge.settings.set.mock.calls[0][0];
        expect(patch.presence).toBe('idle');
        // The Settings checkbox reads the boolean; if these two ever disagree
        // the app says one thing and does another.
        expect(patch.dnd).toBe(false);
        // And the me-bar's second line is never blank — it shows the mode when
        // there is no custom status.
        expect($('me-status').textContent).toBe('Idle');
        expect($('me-status').hidden).toBe(false);
        expect(errors).toEqual([]);
    });

    it('turns Do Not Disturb into the boolean the rest of the app reads', async () => {
        click('btn-name');
        click('mep-status');
        window.lounge.settings.set.mockClear();
        const items = [...$('ctx-menu').querySelectorAll('.ctx-item')];
        items[2].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 0));

        const patch = window.lounge.settings.set.mock.calls[0][0];
        expect(patch.presence).toBe('dnd');
        expect(patch.dnd).toBe(true);
        expect($('me-status').textContent).toBe('Do Not Disturb');
    });

    it('stops publishing presence entirely while invisible', async () => {
        click('btn-name');
        click('mep-status');
        const items = [...$('ctx-menu').querySelectorAll('.ctx-item')];
        items[3].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 0));

        // "Invisible" is not a status the server understands — it is the
        // ABSENCE of one, so the row is retired rather than relabelled. If this
        // ever sends a status instead, everyone else renders an unknown state.
        const presenceCalls = window.lounge.board.mock.calls.filter((c) => c[0] === 'presence');
        expect(presenceCalls.length).toBeGreaterThan(0);
        expect(presenceCalls[presenceCalls.length - 1][1].body.leaving).toBe(true);
    });
});

describe('the audio panels behind the me-bar carets', () => {
    const $ = (id) => document.getElementById(id);
    const click = (el) => (typeof el === 'string' ? $(el) : el)
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    it('opens the input panel with every control the design calls for', () => {
        click('btn-mic-menu');
        expect($('mic-pop').hidden).toBe(false);
        const titles = [...$('mic-pop').querySelectorAll('.ap-title')].map((t) => t.textContent.trim());
        expect(titles).toEqual([
            'Input Device', 'Input Profile', 'Input Volume', 'Push to Talk', 'Voice Settings'
        ]);
        expect(errors).toEqual([]);
    });

    it('names the current device and profile rather than leaving them blank', () => {
        // jsdom has no media stack, which is the same shape as a machine that
        // has refused microphone access: no labels are readable. The rows still
        // have to say something.
        expect($('ap-input-device-value').textContent).toBeTruthy();
        expect($('ap-input-profile-value').textContent).toBe('Standard');
    });

    it('shows one panel at a time', () => {
        click('btn-spk-menu');
        expect($('mic-pop').hidden).toBe(true);
        expect($('spk-pop').hidden).toBe(false);
        const titles = [...$('spk-pop').querySelectorAll('.ap-title')].map((t) => t.textContent.trim());
        expect(titles).toEqual(['Output Device', 'Output Volume', 'Voice Settings']);
    });

    it('opens the device list from the top row', async () => {
        click('ap-output-device');
        await new Promise((r) => setTimeout(r, 0));
        const labels = [...$('ctx-menu').querySelectorAll('.ctx-item')].map((b) => b.textContent.trim());
        expect(labels[0]).toBe('Windows Default');
        expect(labels.some((l) => /allow microphone access/i.test(l))).toBe(true);
        // Opening the list must NOT count as clicking away from the panel.
        expect($('spk-pop').hidden).toBe(false);
    });

    it('writes the input volume as a fraction, not a percentage', async () => {
        click('btn-mic-menu');
        window.lounge.settings.set.mockClear();
        const slider = $('ap-input-volume');
        slider.value = '150';
        slider.dispatchEvent(new window.Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 0));
        // The gain node multiplies, so 150% has to arrive as 1.5. Sending 150
        // would be +43 dB of clipping into everyone else's ears.
        expect(window.lounge.settings.set.mock.calls[0][0].micVolume).toBe(1.5);
    });

    it('drives the same voice mode the Settings dropdown does', async () => {
        window.lounge.settings.set.mockClear();
        const box = $('ap-ptt');
        box.checked = true;
        box.dispatchEvent(new window.Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 0));
        expect(window.lounge.settings.set.mock.calls[0][0].voiceMode).toBe('ptt');
        // The two controls are one setting; if the dropdown does not follow,
        // Settings shows a different answer to the panel.
        expect($('set-mode').value).toBe('ptt');
        expect(errors).toEqual([]);
    });
});

describe('microphone gain', () => {
    it('is clamped, because it is published to everyone', () => {
        // This is applied BEFORE the track is published, so an out-of-range
        // value is the whole room's problem rather than the speaker's.
        window.ScarmMic.setGain(9);
        expect(window.ScarmMic.getGain()).toBe(2);
        window.ScarmMic.setGain(-3);
        expect(window.ScarmMic.getGain()).toBe(0);
        window.ScarmMic.setGain('nonsense');
        expect(window.ScarmMic.getGain()).toBe(1);
        window.ScarmMic.setGain(1);
    });
});

describe('me-bar tooltips', () => {
    const $ = (id) => document.getElementById(id);
    const over = (el) => el.dispatchEvent(new window.MouseEvent('pointerover', { bubbles: true }));
    const out = (el) => el.dispatchEvent(new window.MouseEvent('pointerout', { bubbles: true }));

    // The `title` attribute draws an OS bubble after a multi-second delay that
    // ignores the theme entirely. These five are the ones you point at most, so
    // they are the ones that had to stop using it.
    const EXPECT = {
        'btn-mute': 'Mute',
        'btn-mic-menu': 'Input Options',
        'btn-deafen': 'Deafen',
        'btn-spk-menu': 'Output Options',
        'btn-settings': 'User Settings'
    };

    it('labels every me-bar control, and none of them by title', () => {
        Object.entries(EXPECT).forEach(([id, label]) => {
            expect($(id).getAttribute('data-tip')).toBe(label);
            // Same string in both places: the tip is the accessible name too,
            // since the glyph inside is aria-hidden and announces nothing.
            expect($(id).getAttribute('aria-label')).toBe(label);
            expect($(id).hasAttribute('title')).toBe(false);
        });
    });

    it('shows the label on hover and takes it away again', () => {
        Object.entries(EXPECT).forEach(([id, label]) => {
            over($(id));
            const tip = document.querySelector('.tip');
            expect(tip).toBeTruthy();
            expect(tip.hidden).toBe(false);
            expect(tip.textContent).toBe(label);
            out($(id));
            expect(tip.hidden).toBe(true);
        });
        expect(errors).toEqual([]);
    });

    it('reuses one node rather than leaving a trail of them', () => {
        over($('btn-mute'));
        over($('btn-deafen'));
        expect(document.querySelectorAll('.tip').length).toBe(1);
        out($('btn-deafen'));
    });

    it('repaints when the label changes rather than the target', () => {
        // Mute and deafen rewrite their own label, so the same element can be
        // hovered twice and have to say two different things. Skipping the
        // repaint because the target is unchanged is what leaves "Mute" sitting
        // over a button that now unmutes.
        const b = $('btn-mute');
        over(b);
        expect(document.querySelector('.tip').textContent).toBe('Mute');
        b.setAttribute('data-tip', 'Unmute');
        over(b);
        expect(document.querySelector('.tip').textContent).toBe('Unmute');
        b.setAttribute('data-tip', 'Mute');
        out(b);
    });

    it('draws the user-settings cog filled, not as one more outline toggle', () => {
        const svg = $('btn-settings').querySelector('svg');
        const path = svg.querySelector('path');
        expect(path.getAttribute('fill')).toBe('currentColor');
        expect(path.getAttribute('fill-rule')).toBe('evenodd');
        // The hole in the middle is a second subpath, not a separate <circle>:
        // evenodd is what punches it, and a circle would fill in solid.
        expect(svg.querySelectorAll('circle').length).toBe(0);
    });
});

describe('the settings screen', () => {
    const $ = (id) => document.getElementById(id);
    const nav = () => [...document.querySelectorAll('.set-nav-item')];
    const shown = () => [...document.querySelectorAll('.set-group')]
        .filter((g) => !g.hidden).map((g) => g.querySelector('h3').textContent);
    const type = (q) => {
        $('set-search').value = q;
        $('set-search').dispatchEvent(new window.Event('input', { bubbles: true }));
    };

    it('files every section under a divider, in the markup s own order', () => {
        expect(nav().map((b) => b.textContent.trim())).toEqual([
            'Account', 'Custom emoji', 'Privacy',
            'Voice & Audio', 'Notifications', 'Appearance', 'Screen share', 'Behaviour',
            'About'
        ]);
        expect([...document.querySelectorAll('.set-nav-head')].map((h) => h.textContent))
            .toEqual(['User Settings', 'App Settings']);
        // Every destination has a glyph; a nav of bare words is what it used to be.
        expect(nav().every((b) => b.querySelector('svg'))).toBe(true);
    });

    it('shows exactly one section at a time', () => {
        expect(shown()).toEqual(['Account']);
        nav().find((b) => b.textContent.includes('Behaviour')).click();
        expect(shown()).toEqual(['Behaviour']);
        expect(nav().filter((b) => b.classList.contains('on')).map((b) => b.textContent.trim()))
            .toEqual(['Behaviour']);
    });

    it('searches the sections contents, not just their titles', () => {
        // Nobody knows that the tray toggle lives under "Behaviour" — which is
        // the whole reason the box is there.
        type('tray');
        expect(nav().filter((b) => !b.hidden).map((b) => b.textContent.trim())).toEqual(['Behaviour']);
        expect(shown()).toEqual(['Behaviour']);
        // A divider with nothing under it is worse than no divider.
        expect([...document.querySelectorAll('.set-nav-head')].filter((h) => !h.hidden)
            .map((h) => h.textContent)).toEqual(['App Settings']);
    });

    it('puts everything back when the box is cleared', () => {
        type('');
        expect(nav().every((b) => !b.hidden)).toBe(true);
        expect([...document.querySelectorAll('.set-nav-head')].every((h) => !h.hidden)).toBe(true);
        expect(errors).toEqual([]);
    });

    it('leaves nothing stranded: every section is reachable from the nav', () => {
        const titles = [...document.querySelectorAll('.set-group h3')].map((h) => h.textContent);
        expect(nav().map((b) => b.textContent.trim()).sort()).toEqual(titles.sort());
    });
});

describe('hiding an SVG', () => {
    // `hidden` is defined on HTMLElement. SVGElement is not an HTMLElement, so
    // `svg.hidden = true` sets a property nothing reads and the element stays on
    // screen — silently, with no error anywhere. It cost us two features: the
    // mic never picked up its slash when muted, and the audio player's play
    // triangle stayed put for the whole track.
    it('is not something a property assignment can do', () => {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        document.body.appendChild(svg);
        svg.hidden = true;
        expect(svg.hasAttribute('hidden')).toBe(false);   // the trap, pinned
        svg.toggleAttribute('hidden', true);
        expect(svg.hasAttribute('hidden')).toBe(true);
        svg.remove();
    });

    it('is done by attribute everywhere the renderer swaps a glyph', () => {
        const src = fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');
        // Anything named like an icon must not be assigned .hidden. Elements
        // that are <span>/<div> are free to — this only covers the ones the
        // icon layer turns into SVG.
        const offenders = src.split('\n')
            .map((line, i) => ({ line: line.trim(), n: i + 1 }))
            .filter(({ line }) => /\b(ico|icon|svg|arrow|caret|glyph)\w*\.hidden\s*=/i.test(line));
        expect(offenders).toEqual([]);
    });
});

describe('the muted and deafened states', () => {
    const $ = (id) => document.getElementById(id);
    const shown = (id) => [...$(id).querySelectorAll('svg')]
        .filter((s) => !s.hasAttribute('hidden')).map((s) => s.getAttribute('class'));

    it('starts on the plain glyph', () => {
        expect(shown('btn-mute')).toEqual(['ico']);
        expect(shown('btn-deafen')).toEqual(['ico']);
    });

    it('has a slashed glyph to swap to, hidden by attribute', () => {
        // The attribute, not a property — see above. If the markup ever ships
        // these as anything but a pair, the swap has nothing to swap.
        ['btn-mute', 'btn-deafen'].forEach((id) => {
            expect($(id).querySelectorAll('svg').length).toBe(2);
            expect($(id).querySelector('.ico-off').hasAttribute('hidden')).toBe(true);
        });
    });

    it('swaps them with toggleAttribute', () => {
        // toggleIcons is reachable only through a live voice connection, so the
        // guarantee is at the source: the one line that does the swap.
        const src = fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');
        const fn = src.slice(src.indexOf('function toggleIcons('));
        const body = fn.slice(0, fn.indexOf('\n    }'));
        expect(body).toMatch(/on\.toggleAttribute\('hidden'/);
        expect(body).toMatch(/offIco\.toggleAttribute\('hidden'/);
    });

    it('draws the slash with a cutout behind it', () => {
        // A bare line across a 22px glyph reads as part of the drawing. The
        // backing stroke is what separates them, and it has to come FIRST so
        // the line lands on top of the gap.
        const icons = fs.readFileSync(path.join(RENDERER, 'icons.js'), 'utf8');
        ['mic-off', 'headset-off'].forEach((name) => {
            const i = icons.indexOf(`'${name}':`);
            const body = icons.slice(i, icons.indexOf("',\n", i));
            expect(body.indexOf('ico-cut')).toBeGreaterThan(-1);
            expect(body.indexOf('ico-cut')).toBeLessThan(body.lastIndexOf('M3.6 3.2'));
        });
    });
});
