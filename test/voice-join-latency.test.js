// @vitest-environment jsdom
//
// What joining a call waits for, and — more to the point — what it no longer
// waits for.
//
// Joining took 2-4 seconds, and most of it was queueing rather than work.
// Measured with the jointrace instrumentation (2026-08-06), the median join
// spent ~1.2-2.1s inside SDK.init — a strictly serial chain of the
// participant-config fetch, the wss:// connect to the SFU edge (which is
// never reused between joins) and the server hello — before the room join
// proper even started. None of that needs the click, so none of it waits for
// the click any more:
//
//   • hovering the voice channel warms a whole MEETING now, not just the
//     token: SDK loaded, token spent, API config fetched, signaling socket
//     open. The click consumes it and pays only for joining the room.
//   • the cold path (nobody hovered) still loads the SDK and mints the token
//     concurrently, then inits — the old behaviour, unchanged.
//   • the UI is told "connected" as soon as the room join lands; microphone
//     acquisition and device selection happen behind it, through the same
//     applyTransmit chain push-to-talk has always used.
//
// All timing properties, so all tested by holding the slow things open and
// asking what has happened without them.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RENDERER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');

const noop = () => {};
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await tick(); };

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((r, j) => { resolve = r; reject = j; });
    return { promise, resolve, reject };
}

let sdkCalls, tokenCalls, initCalls, sdkGate, tokenGate, devicesGate, states, meeting;

// A meeting the engine can wire itself to, with nothing real behind it.
function fakeMeeting() {
    const on = () => {};
    return {
        self: {
            on,
            name: 'Me',
            customParticipantId: 'me',
            audioTrack: null,
            videoEnabled: false,
            enableAudio: () => Promise.resolve(),
            disableAudio: () => Promise.resolve(),
            // The slow one. Held open by the test.
            getAudioDevices: vi.fn(() => devicesGate.promise),
            setDevice: vi.fn(() => Promise.resolve())
        },
        meta: { on },
        participants: { joined: { on, toArray: () => [] } },
        join: vi.fn(() => Promise.resolve()),
        leave: vi.fn()
    };
}

// An SDK whose init hands back a fresh fake meeting and counts.
function fakeSdk() {
    return {
        init: vi.fn((opts) => {
            initCalls++;
            meeting = fakeMeeting();
            meeting.__token = opts.authToken;
            return Promise.resolve(meeting);
        })
    };
}

beforeEach(() => {
    sdkCalls = 0;
    tokenCalls = 0;
    initCalls = 0;
    sdkGate = deferred();
    tokenGate = deferred();
    devicesGate = deferred();
    states = [];
    meeting = null;

    // jsdom has neither, and the engine builds one per published track.
    window.MediaStream = function (tracks) {
        this._t = tracks || [];
        this.getAudioTracks = () => this._t;
        this.getVideoTracks = () => [];
        this.id = 'stream';
    };
    // Metering is not what this file is about; a null meter is a supported
    // answer (watchSpeaking returns early).
    window.ScarmAudio = { createMeter: () => null, onTick: () => noop, resume: noop, setSinkId: noop };
    window.ScarmLazy = {
        realtimekit: vi.fn(() => { sdkCalls++; return sdkGate.promise; })
    };
    window.lounge = {
        voiceToken: vi.fn(() => { tokenCalls++; return tokenGate.promise; })
    };

    new Function(fs.readFileSync(path.join(RENDERER, 'voice.js'), 'utf8')).call(window);
});

function makeVoice() {
    const v = window.createVoice({
        onState: (s) => states.push(s),
        onParticipants: noop, onSpeaking: noop, onShares: noop, onCams: noop,
        onError: noop
    });
    // A saved microphone, so selectSavedMic actually does its slow work rather
    // than returning immediately.
    v.setSettings({ clientId: 'me', displayName: 'Me', micDeviceId: 'mic-1', voiceMode: 'open' });
    return v;
}

const joinedYet = () => states.some((s) => s.joined);

describe('the two things a cold join waits on first', () => {
    it('asks for the SDK and the token at the same time', async () => {
        const v = makeVoice();
        v.join();
        await settle(2);

        // Neither has resolved. In the old order the token was not even
        // REQUESTED until the SDK had finished loading and parsing.
        expect(sdkCalls).toBe(1);
        expect(tokenCalls).toBe(1);
    });

    it('still fails cleanly when the token is refused', async () => {
        const v = makeVoice();
        const failed = v.join().catch((e) => e);
        sdkGate.resolve(fakeSdk());
        tokenGate.resolve({ success: false, error: 'nope' });
        await settle();
        expect(String(await failed)).toMatch(/nope/);
        expect(v.isJoined()).toBe(false);
    });
});

describe('the meeting warmed before the click', () => {
    it('is initialised once however many times somebody hovers', async () => {
        const v = makeVoice();
        sdkGate.resolve(fakeSdk());
        tokenGate.resolve({ success: true, token: 'jwt' });
        v.warm();
        v.warm();
        v.warm();
        await settle();
        // Each init opens a socket and takes a participant slot server-side,
        // so hovering must not multiply them.
        expect(tokenCalls).toBe(1);
        expect(initCalls).toBe(1);
    });

    it('is consumed by the join — no second init, no second token', async () => {
        const v = makeVoice();
        sdkGate.resolve(fakeSdk());
        tokenGate.resolve({ success: true, token: 'jwt' });
        v.warm();
        await settle();
        expect(initCalls).toBe(1);

        await v.join();
        expect(v.isJoined()).toBe(true);
        // The join spent the meeting it already had.
        expect(initCalls).toBe(1);
        expect(tokenCalls).toBe(1);
    });

    it('a click while the warm-up is still in flight waits for it rather than starting over', async () => {
        const v = makeVoice();
        v.warm();
        await settle(2);

        const joining = v.join();
        await settle(2);
        // Still nothing resolved — the join is riding the warm-up's promise,
        // not spawning its own init.
        sdkGate.resolve(fakeSdk());
        tokenGate.resolve({ success: true, token: 'jwt' });
        await joining;
        expect(v.isJoined()).toBe(true);
        expect(initCalls).toBe(1);
        expect(tokenCalls).toBe(1);
    });

    it('is warmed again for the NEXT join, not just the first', async () => {
        // The bug the old token warm-up had, pinned at the meeting level now:
        // consuming the held meeting must not mean exactly one fast join per
        // session.
        const v = makeVoice();
        sdkGate.resolve(fakeSdk());
        tokenGate.resolve({ success: true, token: 'first' });
        v.warm();
        await settle();
        await v.join();
        expect(v.isJoined()).toBe(true);
        v.leave();

        tokenGate = deferred();
        tokenGate.resolve({ success: true, token: 'second' });
        v.warm();
        await settle();
        expect(tokenCalls).toBe(2);
        expect(initCalls).toBe(2);
    });

    it('declines to warm while a call is up', async () => {
        const v = makeVoice();
        sdkGate.resolve(fakeSdk());
        tokenGate.resolve({ success: true, token: 'jwt' });
        await v.join();
        expect(v.isJoined()).toBe(true);

        const before = initCalls;
        v.warm();
        await settle(2);
        // Nothing to warm for: there is no next join to prepare while this one
        // is still running.
        expect(initCalls).toBe(before);
    });

    it('falls back to a cold join when the warm-up failed', async () => {
        // A warm-up that could not init (bad token, dead network at hover
        // time) must leave the click path fully working.
        const v = makeVoice();
        const sdk = fakeSdk();
        sdk.init.mockImplementationOnce(() => { initCalls++; return Promise.reject(new Error('token expired')); });
        sdkGate.resolve(sdk);
        tokenGate.resolve({ success: true, token: 'stale' });
        v.warm();
        await settle();
        expect(initCalls).toBe(1);

        tokenGate = deferred();
        tokenGate.resolve({ success: true, token: 'fresh' });
        await v.join();
        expect(v.isJoined()).toBe(true);
        expect(initCalls).toBe(2);
        expect(meeting.__token).toBe('fresh');
    });

    it('rebuilds from scratch when the warm meeting is rejected at the room', async () => {
        // The one risk of initialising early: the meeting can die between
        // warming and use — socket idled out, token expired at the SFU. Left
        // unhandled that turns a speed-up into people not being able to join.
        const v = makeVoice();
        const sdk = fakeSdk();
        sdkGate.resolve(sdk);
        tokenGate.resolve({ success: true, token: 'warmed' });
        v.warm();
        await settle();
        const warmed = meeting;
        warmed.join.mockImplementation(() => Promise.reject(new Error('socket is gone')));

        tokenGate = deferred();
        tokenGate.resolve({ success: true, token: 'fresh' });
        await v.join();
        expect(v.isJoined()).toBe(true);
        // The dead meeting was released, a fresh one was built and joined.
        expect(warmed.leave).toHaveBeenCalled();
        expect(initCalls).toBe(2);
        expect(meeting.__token).toBe('fresh');
        expect(meeting.join).toHaveBeenCalled();
    });
});

describe('when the UI is told it is connected', () => {
    async function joinUpTo(v) {
        const p = v.join();
        await settle(2);
        sdkGate.resolve(fakeSdk());
        tokenGate.resolve({ success: true, token: 'jwt' });
        await p;
        await settle();
    }

    it('reports connected without waiting for the device list', async () => {
        const v = makeVoice();
        await joinUpTo(v);

        // getAudioDevices() is still hanging — deliberately never resolved.
        expect(meeting.self.getAudioDevices).toHaveBeenCalled();
        // …and the call is already up, because it IS: join() resolved, the
        // room join landed. Everything after this point is tuning.
        expect(v.isJoined()).toBe(true);
        expect(joinedYet()).toBe(true);
    });

    it('intends to transmit before it paints, not after', async () => {
        // The one piece of post-join work that is NOT tuning: whether the mic
        // is meant to be live. The acquisition itself now runs behind the
        // paint (the same order push-to-talk always used), but the STATE must
        // be settled by the time anything is on screen.
        const v = makeVoice();
        await joinUpTo(v);
        const first = states.find((s) => s.joined);
        expect(first).toBeTruthy();
        expect(first.transmitting).toBe(true);
    });

    it('still selects the saved microphone, just not in front of the user', async () => {
        const v = makeVoice();
        await joinUpTo(v);
        expect(joinedYet()).toBe(true);

        devicesGate.resolve([{ deviceId: 'mic-1', label: 'Headset' }]);
        await settle();
        expect(meeting.self.setDevice).toHaveBeenCalled();
    });

    it('abandons the tuning if the call ended while the device list hung', async () => {
        const v = makeVoice();
        await joinUpTo(v);
        v.leave();
        devicesGate.resolve([{ deviceId: 'mic-1', label: 'Headset' }]);
        await settle();
        // setDevice() acquires the microphone. Running it after leave() is the
        // hot-mic-after-you-left case the generation counter exists to prevent.
        expect(meeting.self.setDevice).not.toHaveBeenCalled();
    });
});
