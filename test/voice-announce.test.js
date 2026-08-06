// @vitest-environment jsdom
//
// Greeting & Leaving — the spoken join/leave announcements that replaced the
// static "Greetings" / "See ya around" clips.
//
// The contract under test: every arrival and departure is SPOKEN as
// "<who> has joined/left the channel", where <who> is the person's account
// username unless they set a custom Greeting/Leaving text — which travels to
// the announcer on the voice roster, exactly like muted and deafened do. The
// leaver hears their own announcement (announceSelf, driven by app.js on the
// join/leave transition); everyone already in the call at join time is a
// baseline, not a round of arrivals.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RENDERER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');

let spoken;     // every utterance handed to the fake engine
let S;          // window.loungeSounds

const VOICES = [
    { name: 'Microsoft David - English (United States)', lang: 'en-US' },
    { name: 'Microsoft Zira - English (United States)', lang: 'en-US' }
];

beforeAll(() => {
    spoken = [];
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; this.voice = null; } };
    window.speechSynthesis = {
        getVoices: () => VOICES,
        speak: (u) => spoken.push(u)
    };
    window.lounge = { app: { log: () => {} } };
    new Function(fs.readFileSync(path.join(RENDERER, 'sounds.js'), 'utf8')).call(window);
    S = window.loungeSounds;
    S.init({ voiceSounds: true, notificationSound: true, announceVoice: 'female' });
});

beforeEach(() => {
    vi.useFakeTimers();
    spoken.length = 0;
    S.reset();
    S.setSettings({ voiceSounds: true, notificationSound: true, announceVoice: 'female' });
});

const row = (id, name, greet, farewell) => ({ id, name, greet: greet || '', farewell: farewell || '' });

// Join the call and get past the settle window, with `others` already there.
function arm(others) {
    S.voiceRoster([row('me', 'Me')].concat(others || []), true, 'me', false);
    vi.advanceTimersByTime(2000);   // SETTLE_MS is 1500
}

describe('announcing the others', () => {
    it('speaks a username arrival and departure', () => {
        arm([]);
        S.voiceRoster([row('me', 'Me'), row('a', 'alice')], true, 'me', false);
        expect(spoken.map((u) => u.text)).toEqual(['alice has joined the channel']);

        S.voiceRoster([row('me', 'Me')], true, 'me', false);
        expect(spoken.map((u) => u.text)).toEqual([
            'alice has joined the channel',
            'alice has left the channel'
        ]);
    });

    it('speaks the custom texts in place of the name — and only the name', () => {
        arm([]);
        S.voiceRoster([row('me', 'Me'), row('b', 'bob', 'Big Bob', 'The Legend')], true, 'me', false);
        expect(spoken[0].text).toBe('Big Bob has joined the channel');

        // The leave text comes from the roster AS IT STOOD — bob's row is
        // already gone when the leave is noticed.
        S.voiceRoster([row('me', 'Me')], true, 'me', false);
        expect(spoken[1].text).toBe('The Legend has left the channel');
    });

    it('treats everyone already in the call as a baseline, not arrivals', () => {
        arm([row('a', 'alice'), row('b', 'bob')]);
        expect(spoken).toEqual([]);
    });

    it('never announces my own row from the diff', () => {
        // My arrival and departure are announceSelf's, on the transition —
        // the roster copy of me racing in or out must not double-speak them.
        arm([row('a', 'alice')]);
        S.voiceRoster([row('a', 'alice')], true, 'me', false);
        expect(spoken).toEqual([]);
    });

    it('stays quiet under do-not-disturb without losing its place', () => {
        arm([]);
        S.voiceRoster([row('me', 'Me'), row('a', 'alice')], true, 'me', true);
        expect(spoken).toEqual([]);
        // …and alice does not get re-announced once DND lifts: the diff moved on.
        S.voiceRoster([row('me', 'Me'), row('a', 'alice')], true, 'me', false);
        expect(spoken).toEqual([]);
    });
});

describe('announcing myself', () => {
    it('uses my username when the boxes are empty', () => {
        S.announceSelf('join', 'scarmonit');
        S.announceSelf('leave', 'scarmonit');
        expect(spoken.map((u) => u.text)).toEqual([
            'scarmonit has joined the channel',
            'scarmonit has left the channel'
        ]);
    });

    it('uses my Greeting and Leaving texts when set', () => {
        S.setSettings({ voiceSounds: true, announceVoice: 'female', greetText: 'The Boss', farewellText: 'Elvis' });
        S.announceSelf('join', 'scarmonit');
        S.announceSelf('leave', 'scarmonit');
        expect(spoken.map((u) => u.text)).toEqual([
            'The Boss has joined the channel',
            'Elvis has left the channel'
        ]);
    });

    it('is gated by the voice-sounds toggle, but the preview is not', () => {
        S.setSettings({ voiceSounds: false, announceVoice: 'female' });
        S.announceSelf('join', 'scarmonit');
        expect(spoken).toEqual([]);
        // The preview click IS the request to hear it.
        S.previewAnnounce('join', 'scarmonit');
        expect(spoken.map((u) => u.text)).toEqual(['scarmonit has joined the channel']);
    });
});

describe('the voice choice', () => {
    it('female picks Zira, male picks David, on a stock Windows install', () => {
        S.announceSelf('join', 'a');
        expect(spoken[0].voice.name).toMatch(/Zira/);

        S.setSettings({ voiceSounds: true, announceVoice: 'male' });
        S.announceSelf('join', 'a');
        expect(spoken[1].voice.name).toMatch(/David/);
    });
});
