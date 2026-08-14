// @vitest-environment jsdom
//
// txwatch — the outgoing-audio instrumentation.
//
// The complaint it exists for is "you sound robotic and choppy, but only you",
// which is a statement about ONE direction of ONE person's audio. Nothing in
// the app could speak to that: sampleConnection() reports loss CUMULATIVELY
// since the call began (a thirty-second burst inside a two-hour call moves that
// average by nothing at all), and [calltrace] records transports dying, which
// is a different fault — the call stays up throughout this one.
//
// What is pinned here is not "it logs something". It is that the log
// DISTINGUISHES causes that sound identical at the far end, because that
// distinction is the entire deliverable: packets lost on the upload path is
// somebody's network, packets never produced is this machine, and a suppressor
// missing its deadline is this codebase.
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

function fakeMeeting() {
    const self = emitter();
    Object.assign(self, {
        name: 'Me', customParticipantId: 'me', audioTrack: null, videoEnabled: false,
        enableAudio: () => Promise.resolve(), disableAudio: () => Promise.resolve(),
        getAudioDevices: () => Promise.resolve([]), setDevice: () => Promise.resolve()
    });
    const joinedList = emitter();
    joinedList.toArray = () => [];
    return {
        self, meta: emitter(), participants: { joined: joinedList },
        join: vi.fn(() => Promise.resolve()), leave: vi.fn()
    };
}

// THE SEND PATH, as getStats() describes it. `world` is mutable, so a test can
// make the connection go bad halfway through a call the way it does in life.
let world;
let logged;

function resetWorld() {
    world = {
        // Cumulative counters, advanced by tickWorld() below.
        packetsSent: 0,
        bytesSent: 0,
        sendDelay: 0,          // seconds, cumulative over all packets
        packetsLost: 0,
        samplesDur: 0,         // seconds of audio the source has produced
        // Per-second behaviour, which the tests change to model a fault.
        pps: 50,               // packets produced per second
        bytesPerPacket: 160,   // ~64kbps at 50pps
        lossPerSec: 0,
        sendDelayPerPacket: 0.002,
        captureRate: 1,        // seconds of audio produced per second of clock
        audioLevel: 0.2,
        jitter: 0.005,         // seconds
        roundTripTime: 0.03,
        availableOutgoingBitrate: 900000,
        fmtp: 'minptime=10;useinbandfec=1',
        // The suppressor's cumulative counters.
        nsUnderruns: 0,
        nsFrames: 0,
        nsUnderrunsPerSec: 0,
        // "the microphone is shut" — no outbound audio stream at all
        silentTransport: false
    };
}

// Advance the world by `secs` of call time.
function tickWorld(secs) {
    world.packetsSent += world.pps * secs;
    world.bytesSent += world.pps * secs * world.bytesPerPacket;
    world.sendDelay += world.pps * secs * world.sendDelayPerPacket;
    world.packetsLost += world.lossPerSec * secs;
    world.samplesDur += world.captureRate * secs;
    world.nsUnderruns += world.nsUnderrunsPerSec * secs;
    world.nsFrames += 100 * secs;
}

function statsMap() {
    const rows = [];
    if (!world.silentTransport) {
        rows.push({
            id: 'o1', type: 'outbound-rtp', kind: 'audio',
            packetsSent: world.packetsSent, bytesSent: world.bytesSent,
            totalPacketSendDelay: world.sendDelay, retransmittedPacketsSent: 0,
            codecId: 'c1', mediaSourceId: 'ms1'
        });
        rows.push({
            id: 'c1', type: 'codec', mimeType: 'audio/opus', sdpFmtpLine: world.fmtp
        });
        rows.push({
            id: 'ms1', type: 'media-source', kind: 'audio',
            audioLevel: world.audioLevel, totalSamplesDuration: world.samplesDur
        });
        rows.push({
            id: 'r1', type: 'remote-inbound-rtp', kind: 'audio',
            packetsLost: world.packetsLost, jitter: world.jitter,
            roundTripTime: world.roundTripTime
        });
    }
    rows.push({ id: 't1', type: 'transport', selectedCandidatePairId: 'p1' });
    rows.push({
        id: 'p1', type: 'candidate-pair', state: 'succeeded', nominated: true,
        availableOutgoingBitrate: world.availableOutgoingBitrate,
        currentRoundTripTime: world.roundTripTime
    });
    const m = new Map();
    rows.forEach((r) => m.set(r.id, r));
    return m;
}

beforeEach(() => {
    vi.useFakeTimers();
    resetWorld();
    logged = [];

    window.MediaStream = function (tracks) {
        this._t = tracks || [];
        this.getAudioTracks = () => this._t;
        this.getVideoTracks = () => [];
        this.id = 'stream';
    };
    window.ScarmAudio = { createMeter: () => null, onTick: () => noop, resume: noop, setSinkId: noop };
    window.ScarmLazy = {
        realtimekit: () => Promise.resolve({ init: () => Promise.resolve(fakeMeeting()) })
    };
    window.ScarmNoise = {
        isEnabled: () => true,
        isWorking: () => true,
        stats: () => Promise.resolve({
            t: 'stats', quanta: 0, frames: world.nsFrames,
            underruns: world.nsUnderruns, ready: true, failed: false
        })
    };
    window.lounge = { voiceToken: () => Promise.resolve({ success: true, token: 'jwt' }), app: { log: (s) => logged.push(s) } };

    window.RTCPeerConnection = class {
        constructor() { this.connectionState = 'connected'; }
        setLocalDescription(d) { return Promise.resolve(d); }
        setRemoteDescription(d) { return Promise.resolve(d); }
        getStats() { return Promise.resolve(statsMap()); }
    };

    new Function(fs.readFileSync(path.join(RENDERER, 'voice.js'), 'utf8')).call(window);
});

afterEach(() => { vi.useRealTimers(); });

function makeVoice() {
    const v = window.createVoice({
        onState: noop, onParticipants: noop, onSpeaking: noop,
        onShares: noop, onCams: noop, onError: noop, onNotice: noop
    });
    v.setSettings({ clientId: 'me', displayName: 'Me', voiceMode: 'open' });
    return v;
}

async function joinUp() {
    const v = makeVoice();
    v.join();
    await settle();
    // One peer connection has to exist for the watch to have anything to read.
    new window.RTCPeerConnection();
    return v;
}

// Run the call forward, advancing the world in step with the watch's own
// two-second sampling clock.
async function runCall(seconds) {
    for (let i = 0; i < seconds / 2; i++) {
        tickWorld(2);
        await vi.advanceTimersByTimeAsync(2000);
    }
}

const report = () => logged.filter((l) => l.startsWith('[txwatch]'));
const reportText = () => report().join('\n');
const reportHeaders = () => report().filter((l) => l.includes('==== outgoing audio report'));

describe('a healthy call', () => {
    it('records samples and writes nothing', async () => {
        await joinUp();
        await runCall(40);

        expect(window.loungeVoiceStats().length).toBeGreaterThan(10);
        expect(reportHeaders()).toEqual([]);
    });

    it('measures the send rate and bitrate it actually saw', async () => {
        await joinUp();
        await runCall(20);

        const s = window.loungeVoiceStats();
        const last = s[s.length - 1];
        expect(last.pps).toBeCloseTo(50, 0);
        expect(last.kbps).toBeCloseTo(64, 0);
        expect(last.lossPct).toBe(0);
        expect(last.captureRatio).toBeCloseTo(1, 2);
    });
});

describe('it names the layer the fault is in', () => {
    it('calls far-end loss an UPLOAD problem, not a send stall', async () => {
        await joinUp();
        await runCall(10);
        // Packets keep leaving at the normal rate; the far end stops getting
        // some of them. That is the wire, not this machine.
        world.lossPerSec = 4;               // ~8% of 50pps
        await runCall(10);

        const t = reportText();
        expect(t).toContain('UPLOAD-LOSS');
        expect(t).not.toContain('SEND-STALL');
        expect(t).not.toContain('SUPPRESSOR-UNDERRUN');
    });

    it('calls packets that were never produced a SEND-STALL, not loss', async () => {
        await joinUp();
        await runCall(10);
        // The mic still has signal, but the encoder stopped producing.
        world.pps = 12;
        await runCall(10);

        const t = reportText();
        expect(t).toContain('SEND-STALL');
        expect(t).toContain('packets were not produced, not lost');
        expect(t).not.toContain('UPLOAD-LOSS');
    });

    it('does not accuse the encoder when the microphone is simply silent', async () => {
        await joinUp();
        await runCall(10);
        // Nobody is talking. Fewer packets here is not a fault, and a diagnosis
        // that fires every time somebody stops speaking is worse than none.
        world.pps = 10;
        world.audioLevel = 0;
        await runCall(20);

        expect(reportText()).not.toContain('SEND-STALL');
    });

    it('names the noise suppressor when the audio thread misses its deadline', async () => {
        await joinUp();
        await runCall(10);
        world.nsUnderrunsPerSec = 240;      // holes the far end hears as dropouts
        await runCall(10);

        const t = reportText();
        expect(t).toContain('SUPPRESSOR-UNDERRUN');
        expect(t).toContain('noise filter could not fill in time');
    });

    it('flags a capture graph that produced less audio than the clock', async () => {
        await joinUp();
        await runCall(10);
        world.captureRate = 0.9;            // the source starved
        await runCall(10);

        expect(reportText()).toContain('CAPTURE-STARVED');
    });

    it('flags local queueing and a collapsed upload estimate', async () => {
        await joinUp();
        await runCall(10);
        world.sendDelayPerPacket = 0.25;
        world.availableOutgoingBitrate = 20000;
        await runCall(10);

        const t = reportText();
        expect(t).toContain('SEND-QUEUE');
        expect(t).toContain('UPLOAD-STARVED');
    });

    it('catches DTX coming back — the one cause of this that lives in the code', async () => {
        await joinUp();
        await runCall(10);
        // If the strip in patchRTC ever stops taking, opus starts gating the
        // stream on its own VAD again and the symptom returns identically.
        world.fmtp = 'minptime=10;useinbandfec=1;usedtx=1';
        await runCall(10);

        const t = reportText();
        expect(t).toContain('DTX-ON');
        expect(t).toContain('the strip in patchRTC did not hold');
    });
});

describe('the report itself', () => {
    it('carries the run-up, not only the bad samples', async () => {
        await joinUp();
        await runCall(40);                   // twenty healthy samples first
        world.lossPerSec = 5;
        await runCall(10);

        const lines = report().filter((l) => /\d\d:\d\d:\d\d/.test(l));
        expect(lines.length).toBeGreaterThan(10);
        // Healthy samples in the same dump, so a reader can see it degrade.
        expect(lines.some((l) => !l.includes('<<<'))).toBe(true);
        expect(lines.some((l) => l.includes('<<<'))).toBe(true);
    });

    it('says what the codec negotiated and whether DTX was stripped', async () => {
        await joinUp();
        await runCall(10);
        world.lossPerSec = 5;
        await runCall(10);

        const t = reportText();
        expect(t).toContain('codec=opus');
        expect(t).toContain('dtxStripped=true');
        expect(t).toContain('inbandFec=true');
    });

    it('writes at most one report a minute', async () => {
        await joinUp();
        world.lossPerSec = 5;
        await runCall(120);

        expect(reportHeaders().length).toBeLessThanOrEqual(3);
        expect(reportHeaders().length).toBeGreaterThanOrEqual(1);
    });

    it('does not fire on a single bad sample', async () => {
        await joinUp();
        await runCall(10);
        world.lossPerSec = 5;
        tickWorld(2);
        await vi.advanceTimersByTimeAsync(2000);   // exactly one bad interval
        world.lossPerSec = 0;
        tickWorld(2);
        await vi.advanceTimersByTimeAsync(2000);

        expect(reportHeaders()).toEqual([]);
    });
});

describe('asking for a report by hand', () => {
    it('writes the window even when nothing tripped', async () => {
        await joinUp();
        await runCall(20);
        expect(reportHeaders()).toEqual([]);

        expect(window.loungeVoiceReport()).toBe(true);
        expect(reportText()).toContain('manual request');
    });

    it('still works just after hanging up — the complaint often comes then', async () => {
        const v = await joinUp();
        await runCall(20);
        v.leave();
        await settle();

        expect(window.loungeVoiceReport()).toBe(true);
        expect(reportText()).toContain('manual request');
    });

    it('says so rather than writing an empty report', async () => {
        expect(window.loungeVoiceReport()).toBe(false);
        expect(reportText()).toContain('nothing recorded');
    });
});

describe('what it refuses to measure', () => {
    it('takes no sample at all while there is no outbound audio', async () => {
        world.silentTransport = true;
        await joinUp();
        await runCall(20);

        expect(window.loungeVoiceStats()).toEqual([]);
        expect(reportHeaders()).toEqual([]);
    });

    it('does not invent a stall across a gap in the stream', async () => {
        await joinUp();
        await runCall(10);
        // The mic is shut mid-call and reopened. The counters restart; a naive
        // difference across that gap would read as a huge stall that never
        // happened.
        world.silentTransport = true;
        await runCall(10);
        world.silentTransport = false;
        await runCall(10);

        expect(reportText()).not.toContain('SEND-STALL');
    });
});
