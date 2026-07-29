// @vitest-environment jsdom
//
// The transmission gate — the one place the microphone is opened and closed.
//
// THE BUG THIS EXISTS FOR. meeting.self.enableAudio and meeting.self.disableAudio
// share a single lock in the RealtimeKit SDK (lockName "Self.toggleAudio"), and
// that lock is NOT a queue: a second call while the first is outstanding throws
// UnsupportedConcurrentMethodExecution *synchronously*, and the lock is held until
// the first call's promise settles — through the real getUserMedia, the RNNoise
// worklet, the soundboard mix and the publish to the SFU. Hundreds of
// milliseconds on the first acquisition of a session.
//
// A push-to-talk TAP is shorter than that. The press called enableAudio; the
// release called disableAudio inside the lock window; the synchronous throw was
// swallowed by a bare try/catch, and `lastTransmit` had ALREADY been set to false.
// So the gate believed the microphone was closed, its equality guard refused every
// later attempt, and the mic stayed open and transmitting for the rest of the call
// underneath an idle microphone icon. Pressing Mute in the same window failed
// identically.
//
// The lock is reproduced here rather than mocked away, because the throw being
// synchronous is the whole reason the old code could not see it.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RENDERER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');

function emitter() {
    const handlers = {};
    return {
        on(name, fn) { (handlers[name] ||= []).push(fn); },
        emit(name, arg) { (handlers[name] || []).forEach((fn) => fn(arg)); }
    };
}

let meeting;
let calls;          // every enable/disable, in order
let release;        // resolves the in-flight acquisition

// self.enableAudio / self.disableAudio with the SDK's real locking semantics.
function makeSelf() {
    let locked = false;
    const guard = (name, body) => function () {
        if (locked) {
            const e = new Error(`Unsupported concurrent calls on method: meeting.self.${name}.`);
            e.name = 'UnsupportedConcurrentMethodExecution';
            throw e;                       // SYNCHRONOUS, exactly as the SDK does
        }
        locked = true;
        const v = body();
        Promise.resolve(v).then(() => { locked = false; }, () => { locked = false; });
        return v;
    };

    const self = Object.assign(emitter(), {
        customParticipantId: 'me', name: 'Me',
        audioEnabled: false,
        screenShareEnabled: false, screenShareTracks: {},
        enableScreenShare() {}, disableScreenShare() {}
    });
    self.enableAudio = guard('enableAudio', () => {
        calls.push('enable');
        // Held open until the test lets go — the mic-acquisition window.
        return new Promise((res) => { release = () => { self.audioEnabled = true; res(); }; });
    });
    self.disableAudio = guard('disableAudio', () => {
        calls.push('disable');
        self.audioEnabled = false;
        return Promise.resolve();
    });
    return self;
}

beforeEach(async () => {
    document.body.innerHTML = '';
    calls = [];
    release = null;

    let seq = 0;
    window.MediaStream = class {
        constructor(tracks) { this.id = 'ms' + (++seq); this.tracks = (tracks || []).slice(); }
        addTrack(t) { this.tracks.push(t); }
    };
    globalThis.MediaStream = window.MediaStream;
    window.HTMLMediaElement.prototype.play = () => Promise.resolve();
    window.ScarmAudio = {
        createMeter: () => null, createGain: () => null,
        onTick: () => () => {}, setSinkId: () => {}
    };

    const joined = Object.assign(emitter(), { toArray: () => [] });
    meeting = { self: makeSelf(), participants: { joined }, join: () => {}, leave: () => {} };
    window.RealtimeKitClient = { init: vi.fn(async () => meeting) };
    window.ScarmLazy = {
        realtimekit: vi.fn(async () => window.RealtimeKitClient),
        hljs: async () => null, qrcode: async () => null,
        has: (name) => !!window[name]
    };
    window.lounge = { voiceToken: vi.fn(async () => ({ success: true, token: 't' })) };

    const code = fs.readFileSync(path.join(RENDERER, 'voice.js'), 'utf8');
    // eslint-disable-next-line no-new-func
    new Function(code).call(window);
});

const settle = async (n = 8) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

async function joinedPtt() {
    const voice = window.createVoice({});
    voice.setSettings({ clientId: 'me', displayName: 'Me', voiceMode: 'ptt' });
    await voice.join();
    await settle();
    // join() closes the mic for push-to-talk before anything else happens.
    expect(calls).toEqual(['disable']);
    calls.length = 0;
    return voice;
}

describe('the push-to-talk transmission gate', () => {
    it('releases the microphone after a tap shorter than the acquisition', async () => {
        const voice = await joinedPtt();

        voice.setPttHeld(true);              // press
        await settle();
        expect(calls).toEqual(['enable']);
        expect(release).toBeTruthy();        // still acquiring — the lock is held

        voice.setPttHeld(false);             // release, INSIDE the lock window
        await settle();
        // Nothing was attempted while the lock was held, so nothing threw.
        expect(calls).toEqual(['enable']);

        release();                           // the acquisition finally lands
        await settle();

        // …and the release it was cancelling runs now, rather than being lost.
        expect(calls).toEqual(['enable', 'disable']);
        expect(meeting.self.audioEnabled).toBe(false);
        expect(voice.state().transmitting).toBe(false);
    });

    it('does not report an idle microphone while one is still open', async () => {
        const voice = await joinedPtt();
        voice.setPttHeld(true);
        await settle();
        voice.setPttHeld(false);
        await settle();

        // The gate says "not transmitting" the moment the release is asked for,
        // which is fine — but by the time everything has settled the engine must
        // actually agree with it. That is the claim the old code broke.
        release();
        await settle();
        expect(voice.state().transmitting).toBe(meeting.self.audioEnabled);
    });

    it('drops a stale queued call instead of undoing a newer decision', async () => {
        const voice = await joinedPtt();

        voice.setPttHeld(true);
        await settle();
        voice.setPttHeld(false);             // queued: close it
        await settle();
        voice.setPttHeld(true);              // …changed my mind, still holding
        await settle();

        release();
        await settle();

        // One acquisition, and no close at all: the intent when the chain got to
        // run was "transmit", and the microphone is already open.
        expect(calls).toEqual(['enable']);
        expect(meeting.self.audioEnabled).toBe(true);
        expect(voice.state().transmitting).toBe(true);
    });

    it('lets Mute through during an acquisition', async () => {
        const voice = await joinedPtt();
        voice.setPttHeld(true);
        await settle();

        voice.setMuted(true);                // the other way into the same lock
        await settle();
        release();
        await settle();

        expect(calls).toEqual(['enable', 'disable']);
        expect(meeting.self.audioEnabled).toBe(false);
    });

    it('unblocks the gate when a release genuinely fails', async () => {
        const voice = await joinedPtt();
        voice.setPttHeld(true);
        await settle();
        release();
        await settle();
        expect(meeting.self.audioEnabled).toBe(true);

        // A disableAudio that rejects for a real reason. lastTransmit must not be
        // left equal to the state we only hoped for, or the equality guard blocks
        // every retry and the mic can never be closed again.
        meeting.self.disableAudio = () => Promise.reject(new Error('device gone'));
        voice.setPttHeld(false);
        await settle();

        // Reported honestly: the microphone is still open.
        expect(voice.state().transmitting).toBe(true);

        // …and the next press/release is still able to act.
        meeting.self.disableAudio = () => { calls.push('disable'); meeting.self.audioEnabled = false; return Promise.resolve(); };
        voice.setPttHeld(true);
        await settle();
        voice.setPttHeld(false);
        await settle();
        expect(meeting.self.audioEnabled).toBe(false);
    });
});
