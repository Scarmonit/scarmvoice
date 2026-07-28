// @vitest-environment jsdom
//
// The measurement behind the speaking ring.
//
// The ring was unreliable — people talking with no ring, which reads as "my
// microphone is not working" — and every reason was in how the level was read:
//
//   • 8-bit samples. getByteTimeDomainData quantises to 1/128, so at the level
//     ordinary speech reaches with AGC off (RMS ~0.02-0.04) the signal was
//     three to five steps tall and the measurement noise was a good fraction
//     of it.
//   • An 11ms window sampled every 50ms. Four fifths of the audio was never
//     looked at, so a tick landing between two syllables read near silence.
//   • One instantaneous comparison, with nothing to carry a detection across
//     the dip between words.
//   • RMS tested against a threshold people calibrate against the PEAKS of the
//     meter bar — so the bar reaching the marker never meant the average did.
//
// The stub analyser below implements ONLY getFloatTimeDomainData, so a
// regression back to the byte API fails here rather than quietly losing
// precision again.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RENDERER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');

// The app's default: settings.speakThreshold 6, divided by 100.
const T = 0.06;

let analyser = null;     // the one the meter built
let signal = null;       // what the next read returns

function makeAnalyser() {
    const a = {
        fftSize: 32,
        smoothingTimeConstant: 0,
        getFloatTimeDomainData(arr) {
            for (let i = 0; i < arr.length; i++) arr[i] = signal ? signal(i, arr.length) : 0;
        },
        disconnect() {}
    };
    analyser = a;
    return a;
}

// Constant amplitude: room tone, a fan, a hum. Crest factor ~1.
const flat = (amp) => () => amp;

// Peaky the way speech is: a few large excursions over a quiet floor, so the
// peak runs many times the RMS.
const peaky = (peak, floor, hits) => (i, n) => (i % Math.floor(n / hits) === 0 ? peak : floor);

const silence = () => 0;

beforeAll(() => {
    window.AudioContext = function () {
        return {
            state: 'running',
            destination: {},
            createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
            createAnalyser: makeAnalyser,
            createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
            resume: () => Promise.resolve()
        };
    };
    new Function(fs.readFileSync(path.join(RENDERER, 'audio.js'), 'utf8')).call(window);
});

function meterOn(sig) {
    signal = sig;
    const m = window.ScarmAudio.createMeter({});   // the stub ignores the stream
    expect(m).toBeTruthy();
    return m;
}

describe('the level meter', () => {
    it('reads a window that covers the gap between ticks', () => {
        meterOn(silence);
        // 2048 samples is ~43ms at 48kHz against a 50ms tick. At 512 it was
        // 11ms, so four fifths of the audio was never measured at all.
        expect(analyser.fftSize).toBeGreaterThanOrEqual(2048);
        expect(analyser.fftSize * (1000 / 48000)).toBeGreaterThan(window.ScarmAudio.TICK_MS * 0.8);
    });

    it('reads samples as floats, not as bytes', () => {
        // A quarter of one quantisation step of the old 8-bit path. Under it
        // this rounded to zero; it must now be measurable.
        const tiny = 0.002;
        const m = meterOn(flat(tiny));
        m.sample();
        expect(m.rms()).toBeGreaterThan(tiny * 0.9);
        expect(m.rms()).toBeLessThan(tiny * 1.1);
    });
});

describe('deciding that somebody is speaking', () => {
    it('ignores steady room tone sitting just under the threshold', () => {
        const m = meterOn(flat(T * 0.8));
        for (let i = 0; i < 5; i++) m.sample();
        expect(m.isSpeech(T)).toBe(false);
    });

    it('catches speech whose AVERAGE is under the threshold but whose peaks are not', () => {
        // RMS well below the bar, peaks well above it — which is what speech
        // looks like, and what a plain `rms > threshold` test threw away.
        const m = meterOn(peaky(0.20, 0.01, 4));
        m.sample();
        expect(m.rms()).toBeLessThan(T);
        expect(m.peak()).toBeGreaterThan(T);
        expect(m.isSpeech(T)).toBe(true);
    });

    it('holds through the dip between two words instead of dropping out', () => {
        const m = meterOn(flat(0.09));          // a loud syllable
        m.sample();
        expect(m.isSpeech(T)).toBe(true);

        // …and the gap after it. The envelope falls gently rather than
        // snapping to the new reading, so one quiet window cannot put the ring
        // out mid-sentence.
        signal = flat(0.004);
        m.sample();
        expect(m.envelope()).toBeGreaterThan(m.rms());
        expect(m.isSpeech(T)).toBe(true);
    });

    it('does eventually let go when the talking stops', () => {
        const m = meterOn(flat(0.09));
        m.sample();
        signal = silence;
        for (let i = 0; i < 20; i++) m.sample();
        expect(m.isSpeech(T)).toBe(false);
    });

    it('still reports the raw level, for the meter bar', () => {
        // The bar in Settings wants what the microphone is doing right now; the
        // envelope is for the decision, not the display.
        const m = meterOn(flat(0.10));
        m.sample();
        expect(m.rms()).toBeGreaterThan(0.09);
        signal = silence;
        m.sample();
        expect(m.rms()).toBeLessThan(0.001);
    });
});

describe('one definition of speech', () => {
    const voicejs = fs.readFileSync(path.join(RENDERER, 'voice.js'), 'utf8');
    const appjs = fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');

    it('is what the live indicator asks', () => {
        expect(voicejs).toContain('meter.isSpeech(threshold)');
        expect(voicejs).not.toMatch(/meter\.rms\(\)\s*>\s*threshold/);
    });

    it('is what the Settings mic test asks too', () => {
        // Otherwise the meter people calibrate the slider against promises
        // something the ring then fails to do.
        expect(appjs).toContain('meter.isSpeech(vadRms())');
    });

    it('holds the ring long enough to cross a word boundary', () => {
        const hang = /SPEAK_HANG_MS\s*=\s*(\d+)/.exec(voicejs);
        expect(hang).toBeTruthy();
        expect(Number(hang[1])).toBeGreaterThanOrEqual(300);
    });
});
