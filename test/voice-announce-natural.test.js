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

describe('a peer is spoken in their own voice', () => {
    it('uses THEIR speaker, rendered while the announce delay ticks', () => {
        vi.useFakeTimers();
        // I am thalia/female. Bob published zeus/male — his announcement is
        // his, in his voice, whatever I picked for myself.
        S.setSettings({ voiceSounds: true, announceVoice: 'female', announceSpeaker: 'thalia' });
        S.reset();
        S.voiceRoster([{ id: 'me', name: 'Me' }], true, 'me', false);
        vi.advanceTimersByTime(2000);           // past the settle window
        made.length = 0;

        S.voiceRoster([
            { id: 'me', name: 'Me' },
            { id: 'b', name: 'bob', greet: 'Big Bob', farewell: '', speaker: 'zeus', vgender: 'male' }
        ], true, 'me', false);
        // NOTHING has been spoken yet — but the audio already exists: the
        // join line started rendering the moment the join was noticed, and
        // his future leave line was warmed alongside it.
        expect(made.length).toBe(2);
        expect(made.some((el) =>
            el.src.includes('speaker=zeus') && el.src.includes('voice=male') &&
            el.src.includes(encodeURIComponent('Big Bob has joined the channel')))).toBe(true);
        expect(made.some((el) =>
            el.src.includes(encodeURIComponent('bob has left the channel')))).toBe(true);

        // Fire time REUSES the prepared element — the wait and the network
        // overlapped instead of stacking.
        vi.advanceTimersByTime(700);
        expect(made.length).toBe(2);
        vi.useRealTimers();
    });

    it('warming my own sentences is deduped by URL', () => {
        S.setSettings({ voiceSounds: true, announceVoice: 'female', announceSpeaker: 'luna' });
        made.length = 0;
        S.warmAnnouncements('scarmonit');
        expect(made.length).toBe(2);            // my join + my leave
        S.warmAnnouncements('scarmonit');       // nothing changed — no refetch
        expect(made.length).toBe(2);
        // …and the real announcement plays the element the warm built.
        S.announceSelf('join', 'scarmonit');
        expect(made.length).toBe(2);
    });
});

describe('when the stream fails', () => {
    it('falls back to the local engine rather than silence', async () => {
        // A speaker no earlier test prepared, so this announcement builds a
        // FRESH element — the one whose failure is under test.
        S.setSettings({ voiceSounds: true, announceVoice: 'female', announceSpeaker: 'cora' });
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
