// @vitest-environment jsdom
//
// LEAVING A CALL DURING ITS OWN MICROPHONE ACQUISITION DID NOT LEAVE IT.
//
// The SDK gives enableAudio and disableAudio ONE lock, "Self.toggleAudio", and
// that lock is not a queue: taken, it throws (`executeWithLock` in the vendored
// bundle raises UnsupportedConcurrentMethodExecution before applying the
// method). voice.js already knows this — it is the entire reason applyTransmit
// funnels every enable/disable through txChain.
//
// meeting.leave() went round that chain. And meeting.leave() is not just a
// socket close: SelfController.cleanupSelf BEGINS with `await
// self.disableAudio()`. So a leave that landed while the join's own first
// enableAudio was still in flight — a window join() opens itself, because it
// calls applyTransmit() and then pushState() on the next line, which is what
// puts the Disconnect button on screen — threw inside the SDK's async teardown.
// The throw became a rejection the synchronous try/catch could not see, and
// every step after it was skipped: tracks never stopped, media handler never
// destructed, transports and the SFU socket never closed. voice.js then nulled
// `meeting`, so nothing could retry.
//
// The user's app said they had left. Their microphone was still open and still
// publishing into the room.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RENDERER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');

const noop = () => {};
const settle = (n = 8) => vi.advanceTimersByTimeAsync(n);

function emitter() {
    const map = {};
    return {
        on(ev, fn) { (map[ev] = map[ev] || []).push(fn); },
        off(ev, fn) { map[ev] = (map[ev] || []).filter((f) => f !== fn); },
        emit(ev, d) { (map[ev] || []).slice().forEach((f) => f(d)); }
    };
}

function lockError() {
    const e = new Error('Unsupported concurrent calls on method: meeting.self.disableAudio.');
    e.name = 'UnsupportedConcurrentMethodExecution';
    return e;
}

// A meeting that models the ONE thing this spec is about: the shared
// non-queueing toggleAudio lock, and an SDK teardown that begins by taking it.
function lockedMeeting() {
    const self = emitter();
    let locked = false;
    let releaseEnable = null;

    Object.assign(self, {
        name: 'Me',
        customParticipantId: 'me',
        audioTrack: null,
        videoEnabled: false,
        // Holds the lock until the test lets go — the real one holds it for the
        // length of getUserMedia + the noise worklet + the SFU publish.
        enableAudio: () => {
            if (locked) throw lockError();
            locked = true;
            return new Promise((res) => { releaseEnable = () => { locked = false; res(); }; });
        },
        disableAudio: () => {
            if (locked) throw lockError();
            return Promise.resolve();
        },
        getAudioDevices: () => Promise.resolve([]),
        setDevice: () => Promise.resolve()
    });

    const joinedList = emitter();
    joinedList.toArray = () => [];

    const m = {
        self,
        meta: emitter(),
        participants: { joined: joinedList },
        join: vi.fn(() => Promise.resolve()),
        // Everything the real teardown does AFTER disableAudio, which is
        // everything that matters: stopping the tracks and closing the
        // transports and the room socket.
        tornDown: false,
        leave: vi.fn(async () => {
            self.disableAudio();      // cleanupSelf's first statement
            m.tornDown = true;        // unreachable while the lock is held
        }),
        releaseMic: () => { if (releaseEnable) releaseEnable(); }
    };
    return m;
}

let meetings, errors;

beforeEach(() => {
    vi.useFakeTimers();
    meetings = [];
    errors = [];

    window.MediaStream = function (tracks) {
        this._t = tracks || [];
        this.getAudioTracks = () => this._t;
        this.getVideoTracks = () => [];
        this.id = 'stream';
    };
    window.ScarmAudio = { createMeter: () => null, onTick: () => noop, resume: noop, setSinkId: noop };
    window.ScarmLazy = {
        realtimekit: () => Promise.resolve({
            init: () => {
                const m = lockedMeeting();
                meetings.push(m);
                return Promise.resolve(m);
            }
        })
    };
    window.lounge = {
        voiceToken: () => Promise.resolve({ success: true, token: 'jwt' }),
        app: { log: noop }
    };
    window.RTCPeerConnection = class {
        setLocalDescription() { return Promise.resolve(); }
        setRemoteDescription() { return Promise.resolve(); }
        getStats() { return Promise.resolve(new Map()); }
    };

    new Function(fs.readFileSync(path.join(RENDERER, 'voice.js'), 'utf8')).call(window);
});

afterEach(() => { vi.useRealTimers(); });

function makeVoice(mode) {
    const v = window.createVoice({
        onState: noop, onParticipants: noop, onSpeaking: noop,
        onShares: noop, onCams: noop,
        onError: (m) => errors.push(m), onNotice: noop
    });
    v.setSettings({ clientId: 'me', displayName: 'Me', voiceMode: mode || 'open' });
    return v;
}

const current = () => meetings[meetings.length - 1];

describe('disconnecting while the microphone is still opening', () => {
    it('tears the meeting down once the toggleAudio lock is free', async () => {
        const v = makeVoice();
        v.join();
        await settle();

        // In the call, and the mic acquisition that join() started is still in
        // flight — which is exactly when the Disconnect button becomes usable.
        expect(v.isJoined()).toBe(true);
        const m = current();
        expect(m.leave).not.toHaveBeenCalled();

        v.leave();
        await settle();

        // The UI half of leaving is immediate — it must never wait on the
        // network — but the SDK teardown has NOT been fired into the held lock.
        expect(v.isJoined()).toBe(false);
        expect(m.leave).not.toHaveBeenCalled();

        // The acquisition lands; the teardown follows it and completes.
        m.releaseMic();
        await settle();

        expect(m.leave).toHaveBeenCalled();
        expect(m.tornDown).toBe(true);
        expect(errors).toEqual([]);
    });

    it('still tears down when nothing holds the lock', async () => {
        const v = makeVoice('ptt');            // push-to-talk: join opens no mic
        v.join();
        await settle();
        expect(v.isJoined()).toBe(true);

        const m = current();
        v.leave();
        await settle();

        expect(v.isJoined()).toBe(false);
        expect(m.leave).toHaveBeenCalled();
        expect(m.tornDown).toBe(true);
    });

    it('leaves nothing behind that a later join has to wait for', async () => {
        const v = makeVoice();
        v.join();
        await settle();
        const first = current();

        v.leave();
        first.releaseMic();
        await settle();
        expect(first.tornDown).toBe(true);

        // A second call joins and opens its own microphone — the SDK's locks
        // are keyed per peer, so the previous teardown must not be in its way.
        v.join();
        await settle();
        expect(v.isJoined()).toBe(true);
        expect(meetings.length).toBe(2);
        expect(current()).not.toBe(first);
    });
});
