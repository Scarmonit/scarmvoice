// @vitest-environment jsdom
//
// The NATURAL half of the announcements: inside the app shell (lounge://
// exists) an announcement is an <audio> element pointed at lounge://tts, and
// the chosen aura speaker rides the URL — the server resolves an empty one to
// the gender default. When the stream errors, the local speech engine takes
// over; the announcement itself never goes missing.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RENDERER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');

let S, made, spoken;

class CapturingAudio {
    constructor(src) {
        this.src = src;
        this.volume = 1;
        this.listeners = {};
        made.push(this);
    }
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
    fire(ev) { (this.listeners[ev] || []).forEach((fn) => fn()); }
    play() { return Promise.resolve(); }
}

beforeAll(() => {
    made = [];
    spoken = [];
    window.Audio = CapturingAudio;
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    window.speechSynthesis = { getVoices: () => [], speak: (u) => spoken.push(u.text) };
    // The shell marker speakNatural gates on.
    window.lounge = { fileUrl: () => '', app: { log: () => {} } };
    new Function(fs.readFileSync(path.join(RENDERER, 'sounds.js'), 'utf8')).call(window);
    S = window.loungeSounds;
    S.init({ voiceSounds: true, announceVoice: 'female' });
});

beforeEach(() => {
    made.length = 0;
    spoken.length = 0;
});

describe('the announcement URL', () => {
    it('carries the text and the gender, and no speaker when none is chosen', () => {
        S.setSettings({ voiceSounds: true, announceVoice: 'female', announceSpeaker: '' });
        S.announceSelf('join', 'scarmonit');
        expect(made.length).toBe(1);
        expect(made[0].src).toContain('lounge://tts/?text=');
        expect(made[0].src).toContain(encodeURIComponent('scarmonit has joined the channel'));
        expect(made[0].src).toContain('voice=female');
        expect(made[0].src).not.toContain('speaker=');
    });

    it('carries the chosen aura speaker for the real announcement', () => {
        S.setSettings({ voiceSounds: true, announceVoice: 'male', announceSpeaker: 'draco' });
        S.announceSelf('join', 'scarmonit');
        expect(made[0].src).toContain('voice=male');
        expect(made[0].src).toContain('speaker=draco');
    });

    it('previews with the same selection the announcements use', () => {
        S.setSettings({ voiceSounds: true, announceVoice: 'female', announceSpeaker: 'thalia' });
        S.previewAnnounce('join', 'scarmonit');
        expect(made[0].src).toContain('speaker=thalia');
    });
});

describe('when the stream fails', () => {
    it('falls back to the local engine rather than silence', async () => {
        S.setSettings({ voiceSounds: true, announceVoice: 'female', announceSpeaker: 'luna' });
        S.announceSelf('join', 'scarmonit');
        made[0].fire('error');
        await Promise.resolve();
        expect(spoken).toEqual(['scarmonit has joined the channel']);
    });

    it('cools down after a failure instead of paying a timeout per arrival', () => {
        // The failure above armed the cooldown; the next announcement goes
        // straight to the local engine with no <audio> attempt at all.
        S.announceSelf('join', 'scarmonit');
        expect(made.length).toBe(0);
        expect(spoken).toEqual(['scarmonit has joined the channel']);
    });
});
