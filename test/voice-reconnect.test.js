// @vitest-environment jsdom
//
// The two voice-stability fixes, pinned.
//
// 1. RECONNECT. The SDK emits roomLeft {state:'disconnected'} on EVERY
//    signaling-socket close — and starts its own reconnect loop in the same
//    breath, which on success rejoins the same room from inside and emits
//    roomJoined {reconnected:true}. Only {state:'failed'} means it gave up
//    ("SDK re-initialization is required"). So 'disconnected' gets a grace
//    window for that recovery to land — no teardown, no new meeting, the
//    common blip costs a second or two — and only 'failed' or an expired
//    grace triggers the from-scratch teardown + rejoin (which puts
//    mute/deafen back, and gives up loudly once when the network is truly
//    gone).
//
// 2. DTX. The SDK's transport switches opus DTX on unconditionally (its
//    enableDtx defaults true, and its config normalizer drops the flag), and
//    behind RNNoise the opus voice-activity detector cuts the stream in and
//    out around quiet speech — the reported "voice randomly goes robotic".
//    The wrapped RTCPeerConnection strips usedtx=1 from every description.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RENDERER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');

const noop = () => {};
// Fake-timer friendly: everything the engine defers (join promises, the
// rejoin backoff) advances through the mocked clock.
const settle = (n = 8) => vi.advanceTimersByTimeAsync(n);

// A minimal event emitter with the on/off the engine's bind/unwire use.
function emitter() {
    const map = {};
    return {
        on(ev, fn) { (map[ev] = map[ev] || []).push(fn); },
        off(ev, fn) { map[ev] = (map[ev] || []).filter((f) => f !== fn); },
        emit(ev, d) { (map[ev] || []).slice().forEach((f) => f(d)); },
        listeners(ev) { return (map[ev] || []).length; }
    };
}

function fakeMeeting() {
    const self = emitter();
    Object.assign(self, {
        name: 'Me',
        customParticipantId: 'me',
        audioTrack: null,
        videoEnabled: false,
        enableAudio: () => Promise.resolve(),
        disableAudio: () => Promise.resolve(),
        getAudioDevices: () => Promise.resolve([]),
        setDevice: () => Promise.resolve()
    });
    const joinedList = emitter();
    joinedList.toArray = () => [];
    return {
        self,
        meta: emitter(),
        participants: { joined: joinedList },
        join: vi.fn(() => Promise.resolve()),
        leave: vi.fn()
    };
}

let meetings, inits, tokens, errors, notices, states, NativePC, pcs;

beforeEach(() => {
    vi.useFakeTimers();
    meetings = [];
    inits = 0;
    tokens = 0;
    errors = [];
    notices = [];
    states = [];
    pcs = [];

    window.MediaStream = function (tracks) {
        this._t = tracks || [];
        this.getAudioTracks = () => this._t;
        this.getVideoTracks = () => [];
        this.id = 'stream';
    };
    window.ScarmAudio = { createMeter: () => null, onTick: () => noop, resume: noop, setSinkId: noop };
    // Each init hands back a FRESH meeting, the way the real SDK does — the
    // reconnect is a re-initialization, not a resume.
    window.ScarmLazy = {
        realtimekit: () => Promise.resolve({
            init: () => {
                inits++;
                const m = fakeMeeting();
                meetings.push(m);
                return Promise.resolve(m);
            }
        })
    };
    window.lounge = {
        voiceToken: () => { tokens++; return Promise.resolve({ success: true, token: 'jwt-' + tokens }); },
        app: { log: noop }
    };

    // What patchRTC wraps. Records every construction and every description
    // the "native" side was actually given.
    NativePC = class {
        constructor() { this.local = []; this.remote = []; pcs.push(this); }
        setLocalDescription(d) { this.local.push(d); return Promise.resolve(); }
        setRemoteDescription(d) { this.remote.push(d); return Promise.resolve(); }
        getStats() { return Promise.resolve(new Map()); }
    };
    window.RTCPeerConnection = NativePC;

    new Function(fs.readFileSync(path.join(RENDERER, 'voice.js'), 'utf8')).call(window);
});

afterEach(() => { vi.useRealTimers(); });

function makeVoice() {
    const v = window.createVoice({
        onState: (s) => states.push(s),
        onParticipants: noop, onSpeaking: noop, onShares: noop, onCams: noop,
        onError: (m) => errors.push(m),
        onNotice: (m) => notices.push(m)
    });
    v.setSettings({ clientId: 'me', displayName: 'Me', voiceMode: 'open' });
    return v;
}

async function joinUp(v) {
    v.join();
    await settle();
    expect(v.isJoined()).toBe(true);
}

const current = () => meetings[meetings.length - 1];

describe('a room socket that dropped', () => {
    it('lets the SDK recover it first — no teardown, no new meeting', async () => {
        const v = makeVoice();
        await joinUp(v);
        expect(inits).toBe(1);

        current().self.emit('roomLeft', { state: 'disconnected' });
        await settle();
        // 'disconnected' means the socket closed AND the SDK's own reconnect
        // loop is already running. The call is not torn down for that: the
        // engine stays joined (media may well still be flowing) and waits.
        expect(v.isJoined()).toBe(true);
        expect(notices.some((m) => /reconnecting/i.test(m))).toBe(true);

        // The SDK wins the race: same meeting, rejoined from inside.
        await vi.advanceTimersByTimeAsync(1500);
        current().self.emit('roomJoined', { reconnected: true });
        await settle();

        expect(v.isJoined()).toBe(true);
        expect(inits).toBe(1);                 // no second meeting was built
        expect(notices.some((m) => /reconnected/i.test(m))).toBe(true);
        expect(errors).toEqual([]);
        // …and no from-scratch rejoin fires later off the expired grace.
        await vi.advanceTimersByTimeAsync(30000);
        expect(inits).toBe(1);
    });

    it('rebuilds from scratch when the SDK does not recover in time', async () => {
        const v = makeVoice();
        await joinUp(v);
        expect(inits).toBe(1);

        current().self.emit('roomLeft', { state: 'disconnected' });
        await settle();
        expect(v.isJoined()).toBe(true);       // grace window open

        // No roomJoined arrives. Grace (6s) expires -> teardown -> rejoin
        // on the backoff (first attempt at 1.2s).
        await vi.advanceTimersByTimeAsync(6100);
        expect(v.isJoined()).toBe(false);      // torn down honestly now
        await vi.advanceTimersByTimeAsync(2000);
        expect(inits).toBe(2);
        expect(v.isJoined()).toBe(true);
        expect(notices.some((m) => /reconnected/i.test(m))).toBe(true);
        expect(errors).toEqual([]);
    });

    it("re-asserts the microphone after the SDK's own recovery", async () => {
        const v = makeVoice();
        await joinUp(v);
        const self = current().self;
        const enables = [];
        self.enableAudio = vi.fn(() => { enables.push(Date.now()); return Promise.resolve(); });

        self.emit('roomLeft', { state: 'disconnected' });
        await settle();
        self.emit('roomJoined', { reconnected: true });
        await settle();
        // The rejoin rebuilt the producers; the engine must re-state its
        // intent (open mode, unmuted -> the mic should be on) rather than
        // assume the SDK restored it.
        expect(self.enableAudio).toHaveBeenCalled();
        expect(v.isJoined()).toBe(true);
    });

    it("puts the person's mute state back after the rejoin", async () => {
        const v = makeVoice();
        await joinUp(v);
        v.setMuted(true);
        expect(v.isMuted()).toBe(true);

        current().self.emit('roomLeft', { state: 'failed' });
        await vi.advanceTimersByTimeAsync(2500);
        expect(v.isJoined()).toBe(true);
        // A fresh join starts unmuted; the reconnect must not — the person
        // muted themselves and the drop was not their doing.
        expect(v.isMuted()).toBe(true);
    });

    it('gives up after the backoff and says so once', async () => {
        const v = makeVoice();
        await joinUp(v);
        // Every re-init fails from here on — the network is really down.
        window.ScarmLazy.realtimekit = () => Promise.reject(new Error('offline'));

        current().self.emit('roomLeft', { state: 'disconnected' });
        // Grace (6s, no SDK recovery on a dead network) + the full backoff
        // ladder (1.2s + 4s + 10s) + settling.
        await vi.advanceTimersByTimeAsync(30000);

        expect(v.isJoined()).toBe(false);
        // ONE verdict, not one red toast per failed attempt.
        expect(errors.length).toBe(1);
        expect(errors[0]).toMatch(/could not reconnect/i);
    });

    it('stands down when the person rejoined by hand first', async () => {
        const v = makeVoice();
        await joinUp(v);
        v.setMuted(true);

        current().self.emit('roomLeft', { state: 'disconnected' });
        // Grace expires with no SDK recovery — teardown happens now.
        await vi.advanceTimersByTimeAsync(6100);
        expect(v.isJoined()).toBe(false);

        // They clicked the channel before the first retry fired.
        v.join();
        await settle();
        expect(v.isJoined()).toBe(true);

        await vi.advanceTimersByTimeAsync(20000);
        // Their join, their fresh state: the retry must not stack another
        // init on top of it or drag the old mute back over it.
        expect(inits).toBe(2);
        expect(v.isMuted()).toBe(false);
    });

    it('does not rejoin somebody the SFU removed', async () => {
        const v = makeVoice();
        await joinUp(v);

        current().self.emit('roomLeft', { state: 'kicked' });
        await vi.advanceTimersByTimeAsync(20000);

        // Rejoining would fight the moderator who did it.
        expect(v.isJoined()).toBe(false);
        expect(inits).toBe(1);
        expect(errors.some((m) => /removed from the call/i.test(m))).toBe(true);
    });

    it('ignores a roomLeft from a deliberate leave', async () => {
        const v = makeVoice();
        await joinUp(v);

        v.leave();
        // leave() unwires before meeting.leave(), so the SDK's own 'left'
        // echo lands on no live handler at all.
        expect(current().self.listeners('roomLeft')).toBe(0);
        current().self.emit('roomLeft', { state: 'left' });
        await vi.advanceTimersByTimeAsync(20000);
        expect(v.isJoined()).toBe(false);
        expect(inits).toBe(1);
    });
});

describe('opus DTX', () => {
    const OFFER = 'v=0\r\na=fmtp:111 minptime=10;useinbandfec=1;usedtx=1;maxaveragebitrate=64000\r\n';

    it('is stripped from both descriptions on every peer connection', async () => {
        const pc = new window.RTCPeerConnection();
        await pc.setLocalDescription({ type: 'offer', sdp: OFFER });
        await pc.setRemoteDescription({ type: 'answer', sdp: OFFER });

        const native = pcs[pcs.length - 1];
        expect(native.local[0].sdp).not.toContain('usedtx');
        expect(native.remote[0].sdp).not.toContain('usedtx');
        // Only DTX goes. FEC and the bitrate ceiling are the good parts.
        expect(native.local[0].sdp).toContain('useinbandfec=1');
        expect(native.local[0].sdp).toContain('maxaveragebitrate=64000');
        // …and no dangling semicolon where usedtx was cut out.
        expect(native.local[0].sdp).not.toMatch(/;;|;\r/);
    });

    it('leaves a DTX-free description untouched', async () => {
        const clean = 'v=0\r\na=fmtp:111 minptime=10;useinbandfec=1\r\n';
        const pc = new window.RTCPeerConnection();
        const desc = { type: 'offer', sdp: clean };
        await pc.setLocalDescription(desc);
        // The very same object, not a copy — nothing was rebuilt.
        expect(pcs[pcs.length - 1].local[0]).toBe(desc);
    });

    it('keeps the implicit no-argument setLocalDescription working', async () => {
        const pc = new window.RTCPeerConnection();
        await pc.setLocalDescription();
        expect(pcs[pcs.length - 1].local.length).toBe(1);
        expect(pcs[pcs.length - 1].local[0]).toBe(undefined);
    });
});
