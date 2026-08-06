// @vitest-environment jsdom
//
// The renderer half of the 0.92.6 audit pass. Three defects, all of the same
// family: a question asked of the wrong thing, or asked too early.
import { describe, it, expect, vi } from 'vitest';
import { bootRenderer, $, settle } from './helpers/renderer.js';

function router(extra) {
    return vi.fn(async (p, opts) => {
        if (extra) {
            const hit = extra(p, opts);
            if (hit) return hit;
        }
        if (p === 'list') return { success: true, posts: [], typing: [], voice: [], hasMore: false };
        if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
        if (p === 'presence') return { success: true, members: [] };
        if (p === 'dm/threads') return { success: true, threads: [] };
        return { success: true };
    });
}

// ---------------------------------------------------------------------------
// THE ALT-TAB RELEASE ASKED WHETHER A MODULE HAD LOADED.
//
// Push-to-talk is global when the native hook carries it (a real hold) and when
// the accelerator fallback carries it (a system-wide latch). In both cases
// releasing the key on blur would break the feature, which is why the blur
// handler bails.
//
// It bailed on `ptt.available()`, which is `!!loadHook()` — whether uiohook's
// binary LOADED. On win32-x64 the prebuild always loads, so that was true for
// essentially everyone, and it is not the same question as whether the hook is
// carrying THIS binding. Record a key uiohook cannot name and Electron cannot
// express as an accelerator — the Menu key, Pause, IntlBackslash on an ISO
// keyboard, all three of which ptt.js calls out by name — and apply() answers
// 'none': push-to-talk is then driven ONLY by the renderer's own key events,
// and Settings says exactly that. Hold the key, alt-tab, and the keyup went to
// the other application. The microphone stayed open and transmitting to
// everyone in the call.
//
// The hint text was corrected for this same confusion. This was the call site
// it missed, and the only one where being wrong costs an open microphone.
describe('letting go of push-to-talk when the window loses focus', () => {
    const held = () => {
        const calls = [];
        return { calls, voice: { setPttHeld: (v) => calls.push(v), isJoined: () => true } };
    };

    // The module always loads on win32-x64, so `available` is true throughout —
    // that is exactly the condition under which this went wrong. What differs is
    // what apply() reports, and the renderer learns that by APPLYING: switching
    // the input mode in Settings is the path a person takes to get here.
    async function bootPtt(mode) {
        const h = held();
        const app = await bootRenderer({ board: router(), voice: h.voice });
        app.lounge.ptt.available = vi.fn(async () => true);
        app.lounge.ptt.apply = vi.fn(async () => ({ mode }));
        $('set-mode').value = 'ptt';
        $('set-mode').dispatchEvent(new window.Event('change', { bubbles: true }));
        await settle();
        h.calls.length = 0;                 // the mode change itself clears the hold
        return { app, calls: h.calls };
    }

    it('releases the microphone when push-to-talk is in-window only', async () => {
        const { calls } = await bootPtt('none');
        window.dispatchEvent(new window.Event('blur'));
        await settle();

        // Nothing else can end the hold: the keyup went to the other window.
        expect(calls).toContain(false);
    });

    it('keeps holding when the native hook carries the binding', async () => {
        const { calls } = await bootPtt('native');
        window.dispatchEvent(new window.Event('blur'));
        await settle();
        // Holding the key while working in another window is the whole point.
        expect(calls).not.toContain(false);
    });

    it('keeps holding when the fallback accelerator carries it', async () => {
        const { calls } = await bootPtt('toggle');
        window.dispatchEvent(new window.Event('blur'));
        await settle();
        // A latch is system-wide too — releasing it on blur would strand it on.
        expect(calls).not.toContain(false);
    });
});

// ---------------------------------------------------------------------------
// A SESSION THAT ENDED MID-STARTUP CAME BACK TO LIFE.
//
// enterApp() is a ten-await function whose caller does not await it, and the
// shell is on screen from its third line. On a slow link its waits are seconds
// long — net.js retries at 400ms and 1200ms and gives up only after twenty — so
// signing out while the startup burst is still in flight is an ordinary thing
// to do, not a contrived one.
//
// Nothing re-checked the session afterwards. When the last request finally
// landed, the tail ran in full: the presence heartbeat teardown had just
// stopped, the DM poll, the five-minute avatar sweep — and, with auto-join on,
// joinVoice(), which opens the microphone. Behind the sign-in card.
describe('signing out while the app is still starting up', () => {
    it('does not join voice, or re-arm the polls, when the burst lands late', async () => {
        let releaseChannels;
        const board = router((p) => {
            if (p !== 'channels') return null;
            return new Promise((res) => {
                releaseChannels = () => res({ success: true, channels: [{ name: 'general', unread: 0 }] });
            });
        });
        const joins = [];
        const app = await bootRenderer({
            board,
            settings: { autoJoinVoice: true },
            voice: { join: async () => { joins.push(1); }, isJoined: () => false }
        });

        // Startup is parked on the channel list; the shell is already up.
        expect($('app').hidden).toBe(false);
        expect(joins.length).toBe(0);

        $('btn-logout').click();
        await settle(20);
        expect($('login').hidden).toBe(false);

        // …and now the request everybody had forgotten about comes back.
        releaseChannels();
        await settle(30);

        expect(joins.length).toBe(0);            // no microphone behind the login card
        expect($('login').hidden).toBe(false);   // and the shell did not come back either
        expect($('app').hidden).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// THE MIC TEST OUTLIVED THE PANE IT BELONGED TO.
//
// stopMicTest() bumps a generation BEFORE its own `if (!micTest) return`,
// precisely so a capture that has not finished opening can be cancelled — the
// comment on that counter names the pane switch as one of its callers. The pane
// switch then guarded the call on `micTest &&`, which is null for the whole
// 100-500ms Chromium spends opening the device. So the bump never happened, the
// stream passed startMicTest's guard, and it installed itself on a pane that
// was already hidden: microphone open, in-use light on, "Stop Test" off screen.
describe('leaving the Voice pane while the mic test is still opening', () => {
    it('cancels the capture instead of installing it on a hidden pane', async () => {
        const stopped = [];
        let openMic = null;
        const track = { stop: () => stopped.push(1), kind: 'audio' };
        const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
        Object.defineProperty(window.navigator, 'mediaDevices', {
            configurable: true,
            value: {
                enumerateDevices: async () => [],
                getUserMedia: () => new Promise((res) => { openMic = () => res(stream); })
            }
        });
        await bootRenderer({
            board: router(),
            voice: { micTestConstraints: () => ({ audio: true }), isJoined: () => false }
        });
        // AFTER the boot: bootRenderer runs audio.js, which defines the real
        // ScarmAudio over anything set before it — and the real createMeter
        // answers null under jsdom, which is a DIFFERENT reason for the stream
        // to be stopped and would make this spec pass without the fix.
        window.ScarmAudio = Object.assign({}, window.ScarmAudio, {
            createMeter: () => ({ rms: () => 0, isSpeech: () => false, stop() {} }),
            onTick: () => () => {}
        });

        $('btn-settings').click();
        await settle();

        // Voice & Audio, then Mic Test — and the device is still opening.
        const nav = () => [...document.querySelectorAll('.set-nav-item:not(.set-nav-logout)')];
        const byName = (re) => nav().find((b) => re.test(b.textContent.trim()));
        const voiceBtn = byName(/^Voice & Audio$/);
        expect(voiceBtn, 'the Voice & Audio nav entry').toBeTruthy();
        voiceBtn.click();
        await settle();
        $('btn-mic-test').click();
        await settle();
        expect(openMic, 'the mic test asked for a capture').toBeTypeOf('function');

        // Now switch away, exactly as a click on another nav entry does.
        const other = byName(/^Appearance$/);
        expect(other, 'another settings pane').toBeTruthy();
        other.click();
        await settle();

        // …and only now does Chromium hand the stream over.
        openMic();
        await settle(20);

        expect(stopped.length).toBe(1);                       // released, not installed
        expect($('btn-mic-test').textContent).toBe('Mic Test');
    });
});
