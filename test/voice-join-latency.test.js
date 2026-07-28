// @vitest-environment jsdom
//
// What joining a call waits for, and — more to the point — what it no longer
// waits for.
//
// Joining took 2-4 seconds, and two of those were queueing rather than work:
//
//   • the 647 KB SDK was loaded, and THEN a token was fetched from the board
//     and, behind it, Cloudflare's API. Neither needs anything from the other,
//     so running them in series simply added the two waits together.
//   • the UI was told "connected" at the very END of join(), after
//     selectSavedMic() — which enumerates audio devices and can re-acquire the
//     microphone. The call was already up; the spinner just outlived it.
//
// Both are timing properties, so both are tested by holding the slow things
// open and asking what has happened without them.
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
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
}

let sdkCalls, tokenCalls, sdkGate, tokenGate, devicesGate, states, meeting;

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
        join: vi.fn(() => Promise.resolve())
    };
}

beforeEach(() => {
    sdkCalls = 0;
    tokenCalls = 0;
    sdkGate = deferred();
    tokenGate = deferred();
    devicesGate = deferred();
    states = [];
    meeting = fakeMeeting();

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

describe('the two things join() waits on first', () => {
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
        sdkGate.resolve({ init: () => Promise.resolve(meeting) });
        tokenGate.resolve({ success: false, error: 'nope' });
        await settle();
        expect(String(await failed)).toMatch(/nope/);
        expect(v.isJoined()).toBe(false);
    });
});

describe('when the UI is told it is connected', () => {
    async function joinUpTo(v) {
        v.join();
        await settle(2);
        sdkGate.resolve({ init: () => Promise.resolve(meeting) });
        tokenGate.resolve({ success: true, token: 'jwt' });
        await settle();
    }

    it('reports connected without waiting for the device list', async () => {
        const v = makeVoice();
        await joinUpTo(v);

        // getAudioDevices() is still hanging — deliberately never resolved.
        expect(meeting.self.getAudioDevices).toHaveBeenCalled();
        // …and the call is already up, because it IS: join() resolved, audio is
        // flowing. Everything after this point is tuning.
        expect(v.isJoined()).toBe(true);
        expect(joinedYet()).toBe(true);
    });

    it('opens or closes the microphone before it paints, not after', async () => {
        // The one piece of post-join work that is NOT tuning: whether the mic
        // is live. It must be settled by the time anything is on screen.
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
