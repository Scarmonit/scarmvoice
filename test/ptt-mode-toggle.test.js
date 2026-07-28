// @vitest-environment jsdom
//
// Switching push-to-talk off and on must not leave the microphone open.
//
// The transmit gate in voice.js is `!muted && (mode === 'ptt' ? pttHeld : true)`,
// so `pttHeld` is live state that only means anything while the mode is 'ptt' —
// and only the key handlers ever clear it. Both of those handlers bail the
// instant the mode is no longer 'ptt':
//
//     if (settings.voiceMode !== 'ptt' || !voice) return;
//
// which means the key-up that would have closed the mic is DISCARDED if the
// mode changed while the key was still down. `pttHeld` is then stuck true, and
// the next switch back to push-to-talk re-reads it and opens the microphone
// with nobody holding anything.
//
// Every control that changes the mode therefore has to reset the held state.
// Two of the four did (#set-mode and the input panel's switch); the two that
// did not are the two reachable DURING a call — the voice panel's PTT button
// and the Voice & Audio pane's switch — which is precisely where a hot mic
// costs something.
import { describe, it, expect } from 'vitest';
import { bootRenderer, $, settle } from './helpers/renderer.js';

// Mirrors voice.js's gate exactly — modeAllowsTransmit() + applyTransmit()'s
// `want === lastTransmit` short-circuit — so this asserts the real outcome
// (is audio going out?) rather than that some particular method was called.
function pttVoice() {
    let settings = {};
    let pttHeld = false;
    let transmitting = null;

    const modeAllows = () => (settings.voiceMode === 'ptt' ? pttHeld : true);
    const applyTransmit = () => {
        const want = modeAllows();          // never muted in this spec
        if (want === transmitting) return;
        transmitting = want;
    };

    return {
        join: async () => {}, leave: () => {}, roster: () => [], shares: () => [],
        state: () => ({
            joined: true, muted: false, deafened: false, transmitting: transmitting === true,
            shareQuality: '1080p', shareMotion: 'sharp'
        }),
        setSettings(next) { settings = Object.assign({}, next || {}); applyTransmit(); },
        setPttHeld(v) { if (pttHeld === !!v) return; pttHeld = !!v; applyTransmit(); },
        setMuted: () => {}, setDeafened: () => {},
        setLocalVolume: () => {}, setLocalMuted: () => {},
        setShareQuality: () => {}, setShareMotion: () => {},
        startShare: async () => false, stopShare: () => {}, isSharing: () => false,
        enableCam: async () => false, disableCam: async () => false,
        isCamOn: () => false, toggleCam: () => {}, cams: () => [],
        isJoined: () => true, isMuted: () => false, isDeafened: () => false,

        transmitting: () => transmitting === true,
        held: () => pttHeld
    };
}

function key(type) {
    window.dispatchEvent(new window.KeyboardEvent(type, { code: 'Backquote', bubbles: true }));
}

async function click(id) {
    $(id).click();
    await settle();
}

// The sequence a person actually performs: talk, decide mid-sentence that
// open mic would be easier, let go of the key, change your mind.
async function toggleModeWhileHolding(toggleId) {
    const voice = pttVoice();
    await bootRenderer({ voice, settings: { voiceMode: 'ptt' } });

    key('keydown');
    expect(voice.transmitting(), 'holding the key should open the mic').toBe(true);

    await click(toggleId);                  // push-to-talk OFF, key still down
    key('keyup');                           // the release the old code threw away
    await click(toggleId);                  // push-to-talk ON again
    return voice;
}

describe('changing voice mode clears the push-to-talk held state', () => {
    it('the voice panel button does not leave the mic open', async () => {
        const voice = await toggleModeWhileHolding('btn-ptt');
        expect(voice.held(), 'pttHeld survived the mode change').toBe(false);
        expect(voice.transmitting(), 'the mic is open with no key held').toBe(false);
    });

    it('the Voice & Audio switch does not leave the mic open', async () => {
        const voice = await toggleModeWhileHolding('set-ptt-toggle');
        expect(voice.held(), 'pttHeld survived the mode change').toBe(false);
        expect(voice.transmitting(), 'the mic is open with no key held').toBe(false);
    });

    // The two that already did this, so the behaviour stays pinned for all four
    // rather than only for the two being fixed.
    it('the input panel switch does not leave the mic open', async () => {
        const voice = pttVoice();
        await bootRenderer({ voice, settings: { voiceMode: 'ptt' } });

        key('keydown');
        expect(voice.transmitting()).toBe(true);

        $('ap-ptt').checked = false;
        $('ap-ptt').dispatchEvent(new window.Event('change', { bubbles: true }));
        await settle();
        key('keyup');
        $('ap-ptt').checked = true;
        $('ap-ptt').dispatchEvent(new window.Event('change', { bubbles: true }));
        await settle();

        expect(voice.transmitting()).toBe(false);
    });

    it('the Voice & Audio dropdown does not leave the mic open', async () => {
        const voice = pttVoice();
        await bootRenderer({ voice, settings: { voiceMode: 'ptt' } });

        key('keydown');
        expect(voice.transmitting()).toBe(true);

        $('set-mode').value = 'open';
        $('set-mode').dispatchEvent(new window.Event('change', { bubbles: true }));
        await settle();
        key('keyup');
        $('set-mode').value = 'ptt';
        $('set-mode').dispatchEvent(new window.Event('change', { bubbles: true }));
        await settle();

        expect(voice.transmitting()).toBe(false);
    });

    // Nothing above should have broken the ordinary case.
    it('still transmits while the key is genuinely held', async () => {
        const voice = pttVoice();
        await bootRenderer({ voice, settings: { voiceMode: 'ptt' } });

        expect(voice.transmitting()).toBe(false);
        key('keydown');
        expect(voice.transmitting()).toBe(true);
        key('keyup');
        expect(voice.transmitting()).toBe(false);
    });
});
