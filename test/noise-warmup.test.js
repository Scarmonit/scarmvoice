// @vitest-environment jsdom
//
// The 1.9 MB thing standing in front of the microphone.
//
// noise.js patches getUserMedia, so EVERY microphone acquisition awaits
// addModule() on the RNNoise worklet before it can return a stream — 1.9 MB of
// JavaScript wrapping a WebAssembly build of the model. Joining a call acquires
// the microphone, so that fetch, parse and compile sat inside the join.
//
// Worse, release() used to CLOSE the AudioContext when the last stream ended,
// and the module registration dies with the context. So it was not a
// first-join cost that amortised away: leaving and rejoining rebuilt the whole
// thing, every time.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RENDERER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');

let addModuleCalls, gumCalls, contexts, lastCtx;

function fakeTrack() {
    return {
        readyState: 'live',
        stop: vi.fn(),
        addEventListener() {},
        removeEventListener() {}
    };
}

function fakeStream(audio) {
    const tracks = audio ? [fakeTrack()] : [];
    return {
        _t: tracks,
        getAudioTracks: () => tracks,
        getVideoTracks: () => [],
        addTrack() {}
    };
}

beforeEach(() => {
    addModuleCalls = 0;
    gumCalls = 0;
    contexts = 0;

    window.AudioContext = function () {
        contexts++;
        this.state = 'suspended';
        this.audioWorklet = {
            addModule: vi.fn(() => { addModuleCalls++; return Promise.resolve(); })
        };
        this.createMediaStreamSource = () => ({ connect() {}, disconnect() {} });
        this.createMediaStreamDestination = () => ({ stream: fakeStream(true) });
        this.resume = vi.fn(() => { this.state = 'running'; return Promise.resolve(); });
        this.suspend = vi.fn(() => { this.state = 'suspended'; return Promise.resolve(); });
        this.close = vi.fn(() => Promise.resolve());
        lastCtx = this;
    };
    window.AudioWorkletNode = function () {
        this.port = { postMessage() {}, onmessage: null };
        this.connect = () => {};
        this.disconnect = () => {};
    };
    window.MediaStream = function (tracks) {
        this._t = tracks || [];
        this.getAudioTracks = () => this._t;
        this.getVideoTracks = () => [];
        this.addTrack = (t) => this._t.push(t);
    };

    Object.defineProperty(window.navigator, 'mediaDevices', {
        configurable: true,
        value: {
            getUserMedia: vi.fn(() => { gumCalls++; return Promise.resolve(fakeStream(true)); })
        }
    });

    new Function(fs.readFileSync(path.join(RENDERER, 'noise.js'), 'utf8')).call(window);
    window.ScarmNoise.setEnabled(true);
});

// Acquire a microphone the way the SDK does, through the patched getUserMedia.
const openMic = () => window.navigator.mediaDevices.getUserMedia({ audio: true });

describe('warming the model', () => {
    it('compiles it without opening a microphone', async () => {
        await window.ScarmNoise.warm();
        expect(addModuleCalls).toBe(1);
        // The whole point: the expensive half happens BEFORE, and on its own.
        expect(gumCalls).toBe(0);
    });

    it('leaves nothing for the microphone to wait on', async () => {
        await window.ScarmNoise.warm();
        await openMic();
        // Already registered — the acquisition did not rebuild it.
        expect(addModuleCalls).toBe(1);
    });

    it('does nothing when the model is switched off', async () => {
        window.ScarmNoise.setEnabled(false);
        await window.ScarmNoise.warm();
        expect(addModuleCalls).toBe(0);
    });

    it('is safe to ask for twice', async () => {
        await Promise.all([window.ScarmNoise.warm(), window.ScarmNoise.warm()]);
        expect(addModuleCalls).toBe(1);
    });
});

describe('between one call and the next', () => {
    it('keeps the compiled model instead of rebuilding it', async () => {
        const first = await openMic();
        expect(addModuleCalls).toBe(1);

        // Leave the call: the consumer stops the track it was given.
        first.getAudioTracks()[0].stop();
        await Promise.resolve();

        // Rejoin.
        await openMic();
        // THE POINT. Closing the context threw the registration away with it,
        // so this used to be 2 — and every join after that another one.
        expect(addModuleCalls).toBe(1);
        expect(contexts).toBe(1);
    });

    it('parks the audio thread rather than holding a device open', async () => {
        const s = await openMic();
        s.getAudioTracks()[0].stop();
        await Promise.resolve();
        // Suspended, not closed: an idle context must not keep the render
        // thread (or on some drivers the device) awake, but closing it is what
        // made the next join expensive.
        expect(lastCtx.suspend).toHaveBeenCalled();
        expect(lastCtx.close).not.toHaveBeenCalled();
    });

    it('wakes it again for the next microphone', async () => {
        const s = await openMic();
        s.getAudioTracks()[0].stop();
        await Promise.resolve();
        expect(lastCtx.state).toBe('suspended');

        await openMic();
        expect(lastCtx.state).toBe('running');
    });
});
