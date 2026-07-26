// @vitest-environment jsdom
//
// sounds.js — the join/leave/message chimes, and the diffing rules that decide
// when they fire.
//
// The rules are the website's, and the awkward one is the settle window: when
// you join a call, the whole existing roster arrives at once. Without a guard
// that's a burst of join chimes for people who were already there. Only the
// clock is faked here (Date), so the real async load path still runs.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const JOIN = 'sounds/voice-join.ogg';
const LEAVE = 'sounds/voice-leave.ogg';
const SETTLE_MS = 1500;

let played;      // every chime, in order

// Minimal Web Audio + Audio element doubles: enough for sounds.js to take its
// normal path, and they record instead of making noise.
class FakeAudio {
    constructor(src) { this.src = src; this.volume = 1; this.preload = ''; this.currentTime = 0; }
    play() { played.push(this.src); return Promise.resolve(); }
    load() {}
}

class FakeAudioContext {
    constructor() { this.state = 'running'; this.destination = {}; }
    decodeAudioData(_raw, resolve) { resolve({ duration: 0.2 }); }
    createBufferSource() { return { buffer: null, connect() {}, start() { played.push('message'); } }; }
    createGain() { return { gain: { value: 0 }, connect() {} }; }
    resume() { return Promise.resolve(); }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const jump = (ms) => vi.setSystemTime(new Date(Date.now() + ms));

async function boot(settings = {}) {
    played = [];
    window.AudioContext = FakeAudioContext;
    globalThis.AudioContext = FakeAudioContext;
    window.Audio = FakeAudio;
    globalThis.Audio = FakeAudio;
    globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });

    vi.resetModules();
    // audio.js owns the renderer's single AudioContext; sounds.js borrows it
    // rather than opening a second one, so it has to be loaded first — exactly
    // the order index.html uses.
    await import('../src/renderer/audio.js');
    await import('../src/renderer/sounds.js');

    const sounds = window.loungeSounds;
    sounds.init({ notificationSound: true, voiceSounds: true, ...settings });
    await flush();        // let the chime buffer finish decoding
    played = [];          // ignore anything the load path itself did
    return sounds;
}

// Joining always chimes for you; most tests care about what happens after.
function joinCall(sounds, roster, myId = 'me') {
    sounds.voiceRoster(roster, true, myId);
    played = [];
    jump(SETTLE_MS + 1);
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});

afterEach(() => {
    vi.useRealTimers();
});

describe('message chime', () => {
    it('plays when the setting is on', async () => {
        const sounds = await boot({ notificationSound: true });
        sounds.playMessage();
        expect(played).toEqual(['message']);
    });

    it('stays silent when the setting is off', async () => {
        const sounds = await boot({ notificationSound: false });
        sounds.playMessage();
        expect(played).toEqual([]);
    });

    it('follows a setting changed at runtime', async () => {
        const sounds = await boot({ notificationSound: true });
        sounds.setSettings({ notificationSound: false, voiceSounds: true });
        sounds.playMessage();
        expect(played).toEqual([]);
    });

    it('is unaffected by the voice toggle', async () => {
        const sounds = await boot({ notificationSound: true, voiceSounds: false });
        sounds.playMessage();
        expect(played).toEqual(['message']);
    });
});

describe('joining a call', () => {
    it('chimes once for you and not for everyone already there', async () => {
        const sounds = await boot();
        sounds.voiceRoster([{ id: 'me' }, { id: 'a' }, { id: 'b' }], true, 'me');

        // The pre-existing roster arrives in one render — one chime, not three.
        expect(played).toEqual([JOIN]);
    });

    it('swallows arrivals inside the settle window', async () => {
        const sounds = await boot();
        sounds.voiceRoster([{ id: 'me' }, { id: 'a' }], true, 'me');
        played = [];

        jump(SETTLE_MS - 100);
        sounds.voiceRoster([{ id: 'me' }, { id: 'a' }, { id: 'b' }], true, 'me');

        expect(played).toEqual([]);
    });
});

describe('roster changes after the settle window', () => {
    it('chimes when someone joins', async () => {
        const sounds = await boot();
        joinCall(sounds, [{ id: 'me' }, { id: 'a' }]);

        sounds.voiceRoster([{ id: 'me' }, { id: 'a' }, { id: 'b' }], true, 'me');

        expect(played).toEqual([JOIN]);
    });

    it('chimes when someone leaves', async () => {
        const sounds = await boot();
        joinCall(sounds, [{ id: 'me' }, { id: 'a' }, { id: 'b' }]);

        sounds.voiceRoster([{ id: 'me' }, { id: 'a' }], true, 'me');

        expect(played).toEqual([LEAVE]);
    });

    it('chimes both when one arrives as another leaves', async () => {
        const sounds = await boot();
        joinCall(sounds, [{ id: 'me' }, { id: 'a' }]);

        sounds.voiceRoster([{ id: 'me' }, { id: 'b' }], true, 'me');

        expect(played).toEqual([JOIN, LEAVE]);
    });

    it('stays silent when nothing changed', async () => {
        const sounds = await boot();
        joinCall(sounds, [{ id: 'me' }, { id: 'a' }]);

        sounds.voiceRoster([{ id: 'me' }, { id: 'a' }], true, 'me');

        expect(played).toEqual([]);
    });

    it('never chimes for your own id', async () => {
        const sounds = await boot();
        joinCall(sounds, [{ id: 'me' }, { id: 'a' }]);

        // You drop out of the roster momentarily — that is not a leave event.
        sounds.voiceRoster([{ id: 'a' }], true, 'me');

        expect(played).toEqual([]);
    });

    it('ignores entries with no id', async () => {
        const sounds = await boot();
        joinCall(sounds, [{ id: 'me' }]);

        sounds.voiceRoster([{ id: 'me' }, {}, null], true, 'me');

        expect(played).toEqual([]);
    });
});

describe('arming', () => {
    it('is silent for someone who is not in the call', async () => {
        const sounds = await boot();
        sounds.voiceRoster([{ id: 'a' }, { id: 'b' }], false, 'me');
        expect(played).toEqual([]);
    });

    it('disarms on leaving, then chimes again on the next join', async () => {
        const sounds = await boot();
        joinCall(sounds, [{ id: 'me' }, { id: 'a' }]);

        sounds.voiceRoster([], false, 'me');       // I left the call
        expect(played).toEqual([]);

        sounds.voiceRoster([{ id: 'me' }, { id: 'a' }], true, 'me');
        expect(played).toEqual([JOIN]);
    });

    it('re-arms after reset()', async () => {
        const sounds = await boot();
        joinCall(sounds, [{ id: 'me' }]);

        sounds.reset();
        sounds.voiceRoster([{ id: 'me' }, { id: 'a' }], true, 'me');

        // Back to a first render: my own chime, nothing for 'a'.
        expect(played).toEqual([JOIN]);
    });

    it('respects the voiceSounds toggle', async () => {
        const sounds = await boot({ voiceSounds: false });
        sounds.voiceRoster([{ id: 'me' }], true, 'me');

        jump(SETTLE_MS + 1);
        sounds.voiceRoster([{ id: 'me' }, { id: 'a' }], true, 'me');

        expect(played).toEqual([]);
    });
});
