// The update is applied BEFORE the app starts, not on top of a running one.
//
// The old order was: launch, sign in, load the board, open the socket — and
// four seconds later notice an update, download it, and restart out from under
// whatever the user was now in the middle of. Everything about that was correct
// except the order. `startupGate()` moves the check in front of the window, and
// main.js creates nothing until it answers.
//
// Two answers, and the difference between them is the whole contract:
//
//   'launch'      main.js builds the app
//   'installing'  main.js builds NOTHING; quitAndInstall is already running
//
// The rule that outranks updating is that the app must always start. So the
// interesting half of this file is the failures — offline, a feed that never
// answers, a stalled download, an error mid-stream — every one of which has to
// end in 'launch' rather than a window that never appears. A gate that can
// strand somebody outside their own app is worse than an update that waits for
// the next launch, and nothing is lost by waiting: autoInstallOnAppQuit is armed
// and the in-app flow picks the same update up on its own.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadMain, resetMainModules } from './helpers/load.js';
import { electronState as env } from './helpers/electron-state.js';

let updater, gateSteps;

const stub = () => globalThis.__UPDATER_STUB__;
const fire = (event, payload) => (stub().handlers[event] || []).forEach((fn) => fn(payload));

// Let installNow()'s setImmediate — and the 500ms beat in front of it — run.
const flush = (ms = 1000) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
    vi.useFakeTimers();
    resetMainModules();
    const s = (globalThis.__UPDATER_STUB__ ||= { installs: [], checks: 0, downloads: 0, handlers: {} });
    s.installs.length = 0;
    s.checks = 0;
    s.downloads = 0;
    s.handlers = {};
    s.checkFails = null;
    // A packaged build: without this there is no feed and the gate is a no-op.
    env.isPackaged = true;
    updater = loadMain('updater.js');
    gateSteps = [];
    updater.init((channel, payload) => {
        if (channel === 'update:gate') gateSteps.push(payload);
    });
});

afterEach(() => {
    vi.useRealTimers();
    env.isPackaged = false;
});

const phases = () => gateSteps.map((s) => s.phase);

describe('the gate lets the app start', () => {
    it('when the feed says there is nothing to do', async () => {
        const verdict = updater.startupGate();
        expect(updater.gateOpen()).toBe(true);
        fire('update-not-available', {});
        await expect(verdict).resolves.toBe('launch');
        expect(updater.gateOpen()).toBe(false);
        expect(stub().installs.length).toBe(0);
    });

    it('when the check never answers', async () => {
        const verdict = updater.startupGate();
        await flush(20_000);
        await expect(verdict).resolves.toBe('launch');
        expect(stub().installs.length).toBe(0);
    });

    it('when the check rejects — offline, DNS, a 500 from the feed', async () => {
        stub().checkFails = 'getaddrinfo ENOTFOUND';
        const verdict = updater.startupGate();
        await flush(1);
        await expect(verdict).resolves.toBe('launch');
    });

    it('when the feed errors after finding one', async () => {
        const verdict = updater.startupGate();
        fire('update-available', { version: '9.9.9', releaseNotes: '' });
        fire('error', new Error('net::ERR_CONNECTION_RESET'));
        await expect(verdict).resolves.toBe('launch');
        expect(stub().installs.length).toBe(0);
    });

    it('when the download stalls', async () => {
        const verdict = updater.startupGate();
        fire('update-available', { version: '9.9.9', releaseNotes: '' });
        // Some bytes, then nothing — the case a plain "did it error?" check
        // cannot see, because nothing ever fails.
        fire('download-progress', { percent: 12 });
        await flush(6 * 60 * 1000);
        await expect(verdict).resolves.toBe('launch');
        expect(stub().installs.length).toBe(0);
    });

    it('immediately on an unpackaged dev run, without touching the feed', async () => {
        env.isPackaged = false;
        resetMainModules();
        const dev = loadMain('updater.js');
        await expect(dev.startupGate()).resolves.toBe('launch');
        expect(stub().checks).toBe(0);
    });
});

describe('the gate applies an update instead of starting', () => {
    it('installs, and answers "installing" so nothing else boots', async () => {
        const verdict = updater.startupGate();
        fire('update-available', { version: '9.9.9', releaseNotes: '' });
        fire('update-downloaded', { version: '9.9.9', releaseNotes: '' });

        await expect(verdict).resolves.toBe('installing');
        await flush();
        expect(stub().installs.length).toBe(1);
        expect(stub().installs[0]).toMatchObject({ isSilent: true, isForceRunAfter: true });
    });

    it('does not wait on a call that cannot exist yet', async () => {
        // setBusy is how a call holds a restart back mid-session. At startup
        // there is no call — and a stale flag must not be able to strand the
        // gate, which is why the install path does not consult it.
        updater.setBusy(true);
        const verdict = updater.startupGate();
        fire('update-available', { version: '9.9.9', releaseNotes: '' });
        fire('update-downloaded', { version: '9.9.9', releaseNotes: '' });
        await expect(verdict).resolves.toBe('installing');
        await flush();
        expect(stub().installs.length).toBe(1);
    });
});

describe('what the update screen is told', () => {
    it('narrates check, then download with a real percentage, then install', async () => {
        const verdict = updater.startupGate();
        expect(phases()).toEqual(['checking']);

        fire('update-available', { version: '9.9.9', releaseNotes: '' });
        fire('download-progress', { percent: 41.6 });
        fire('update-downloaded', { version: '9.9.9', releaseNotes: '' });
        await verdict;

        expect(phases()).toEqual(['checking', 'downloading', 'downloading', 'installing']);
        // Rounded, because the screen prints it.
        expect(gateSteps[2]).toMatchObject({ phase: 'downloading', percent: 42 });
        expect(gateSteps[2].version).toBe('9.9.9');
        expect(gateSteps[3]).toMatchObject({ phase: 'installing', percent: 100 });
    });

    it('says nothing more once it has answered', async () => {
        const verdict = updater.startupGate();
        fire('update-not-available', {});
        await verdict;
        const after = gateSteps.length;
        // A late frame from a check still unwinding must not repaint a window
        // that is being torn down, or resurrect one that was never built.
        fire('download-progress', { percent: 80 });
        fire('update-downloaded', { version: '9.9.9', releaseNotes: '' });
        expect(gateSteps.length).toBe(after);
    });
});

describe('the launch check behind the window', () => {
    it('does not ask again when the gate already got an answer', async () => {
        const verdict = updater.startupGate();
        fire('update-not-available', {});
        await verdict;
        const asked = stub().checks;
        updater.checkOnLaunch();
        expect(stub().checks).toBe(asked);
    });

    it('DOES ask when the gate gave up without one', async () => {
        const verdict = updater.startupGate();
        await flush(20_000);          // the check timed out
        await verdict;
        const asked = stub().checks;
        updater.checkOnLaunch();
        expect(stub().checks).toBe(asked + 1);
    });

    it('still arms the periodic recheck either way', async () => {
        const verdict = updater.startupGate();
        fire('update-not-available', {});
        await verdict;
        updater.checkOnLaunch();
        const asked = stub().checks;
        await flush(3 * 60 * 60 * 1000 + 1000);
        expect(stub().checks).toBeGreaterThan(asked);
    });
});

describe('a mid-session update is unaffected', () => {
    it('still installs itself when no gate is open', async () => {
        // The gate is a startup thing. Everything the app already did about an
        // update arriving hours into a session has to keep working.
        updater.startDownload();
        fire('update-downloaded', { version: '9.9.9', releaseNotes: '' });
        await flush();
        expect(stub().installs.length).toBe(1);
    });

    it('and still waits for a call to end', async () => {
        updater.setBusy(true);
        updater.startDownload();
        fire('update-downloaded', { version: '9.9.9', releaseNotes: '' });
        await flush();
        expect(stub().installs.length).toBe(0);
        expect(updater.getState().waitingFor).toBe('call');

        updater.setBusy(false);
        await flush();
        expect(stub().installs.length).toBe(1);
    });
});
