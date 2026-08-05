// What happens when the install the STARTUP GATE handed itself to never runs.
//
// The gate's two answers are 'launch' (main.js builds the app) and 'installing'
// (main.js builds nothing at all — no window, no tray, no session — because this
// process is about to be replaced by the NSIS installer). See update-gate.test.js
// for the first; this file is about the second one failing.
//
// It resolves 'installing' BEFORE the install is attempted, which is the right
// order — the splash has to say so while it still can — but it means a handover
// that never happens leaves a live process with no interface. The
// single-instance lock then makes that unfixable from outside: every relaunch
// signals this process instead of starting a new one, and main.js's `installing`
// flag turns those signals away too. The only way out was Task Manager.
//
// Two ways it fails, and neither used to be survivable:
//
//   • quitAndInstall THROWS — installNow caught it and only logged.
//   • quitAndInstall returns and nothing happens — AV holding the downloaded
//     installer, a spawn that does not take. electron-updater reports this by
//     firing 'error', and that handler's gateSettle() is a no-op once the gate
//     has already settled as 'installing'.
//
// The contract: the launch is claimed back exactly once, and the update is left
// on disk with autoInstallOnAppQuit armed, so it applies on the next quit.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadMain, resetMainModules } from './helpers/load.js';
import { electronState as env } from './helpers/electron-state.js';

let updater;

const stub = () => globalThis.__UPDATER_STUB__;
const fire = (event, payload) => (stub().handlers[event] || []).forEach((fn) => fn(payload));

// Long enough for installNow()'s 500ms beat and its setImmediate.
const flush = (ms = 1000) => vi.advanceTimersByTimeAsync(ms);

// The deadline gateInstall arms in case the handover simply never happens.
const HANDOVER_MS = 20_000;

beforeEach(() => {
    vi.useFakeTimers();
    resetMainModules();
    const s = (globalThis.__UPDATER_STUB__ ||= { installs: [], checks: 0, downloads: 0, handlers: {} });
    s.installs.length = 0;
    s.checks = 0;
    s.downloads = 0;
    s.handlers = {};
    s.checkFails = null;
    s.installThrows = null;
    env.isPackaged = true;
    updater = loadMain('updater.js');
    updater.init(() => {});
});

afterEach(() => {
    vi.useRealTimers();
    env.isPackaged = false;
    stub().installThrows = null;
});

// Drive the gate to the point where it has committed to installing.
async function commitToInstall() {
    const verdict = updater.startupGate();
    fire('update-available', { version: '9.9.9', releaseNotes: '' });
    fire('update-downloaded', { version: '9.9.9', releaseNotes: '' });
    await expect(verdict).resolves.toBe('installing');
}

describe('an install the gate committed to', () => {
    it('is attempted, and normally that is the end of the process', async () => {
        // The baseline the rest of this file is measured against: a handover
        // that WORKS must not be interrupted by the fallback.
        const launched = vi.fn();
        await commitToInstall();
        updater.onInstallGaveUp(launched);
        await flush();

        expect(stub().installs.length).toBe(1);
        // The real quitAndInstall kills the process here. Nothing has failed, so
        // nothing may claim the launch back yet.
        expect(launched).not.toHaveBeenCalled();
    });

    it('gives the launch back when quitAndInstall throws', async () => {
        stub().installThrows = 'EBUSY: the installer is locked';
        const launched = vi.fn();
        await commitToInstall();
        updater.onInstallGaveUp(launched);
        await flush();

        // Reported at once rather than waiting out the deadline: the throw is
        // conclusive.
        expect(launched).toHaveBeenCalledTimes(1);
    });

    it('gives the launch back when the installer never takes over', async () => {
        // quitAndInstall returns and the process simply stays alive — the AV
        // case. Nothing throws and nothing quits.
        const launched = vi.fn();
        await commitToInstall();
        updater.onInstallGaveUp(launched);
        await flush();
        expect(launched).not.toHaveBeenCalled();   // still hoping, correctly

        await vi.advanceTimersByTimeAsync(HANDOVER_MS);
        expect(launched).toHaveBeenCalledTimes(1);
    });

    it('gives the launch back when the feed reports the failure', async () => {
        const launched = vi.fn();
        await commitToInstall();
        updater.onInstallGaveUp(launched);
        await flush();

        // electron-updater's way of saying the handover failed. Past the gate
        // this settles nothing — it has already resolved 'installing' — so it
        // used to be swallowed entirely.
        fire('error', new Error('cannot spawn installer'));
        expect(launched).toHaveBeenCalledTimes(1);
    });

    it('gives it back only once, however many failures arrive', async () => {
        const launched = vi.fn();
        await commitToInstall();
        updater.onInstallGaveUp(launched);
        await flush();

        fire('error', new Error('cannot spawn installer'));
        fire('error', new Error('still cannot'));
        await vi.advanceTimersByTimeAsync(HANDOVER_MS * 2);

        // startApp() is not idempotent — a second call would build a second
        // window, tray and session over the first.
        expect(launched).toHaveBeenCalledTimes(1);
    });

    it('does not depend on main.js registering before the failure', async () => {
        // Registration happens the moment the gate resolves, so in practice it
        // always wins the race. A fallback that only exists if it does is the
        // same class of bug it is here to fix.
        stub().installThrows = 'EBUSY';
        const launched = vi.fn();
        await commitToInstall();
        await flush();                      // fail FIRST, with no listener

        updater.onInstallGaveUp(launched);  // …and register after
        expect(launched).toHaveBeenCalledTimes(1);
    });
});

describe('a mid-session install', () => {
    it('does not claim a launch back, because there is an app already', async () => {
        // No gate: the app is running and the user clicked the pill. A failure
        // here is a pill that did not work, not a machine with no app — and
        // calling startApp() over a live session would be its own bug.
        const launched = vi.fn();
        updater.onInstallGaveUp(launched);
        fire('update-downloaded', { version: '9.9.9', releaseNotes: '' });
        updater.installNow();
        await flush();

        fire('error', new Error('cannot spawn installer'));
        await vi.advanceTimersByTimeAsync(HANDOVER_MS * 2);

        expect(launched).not.toHaveBeenCalled();
    });
});
