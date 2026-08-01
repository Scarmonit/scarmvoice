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
        // Five minutes, not the three HOURS this used to be. An app somebody
        // leaves open all day should not be finding out about a release most of
        // a working day late — and this is only the fallback anyway: a release
        // pushes a `release` nudge down the realtime socket and the renderer
        // turns that straight into a check.
        await flush(5 * 60 * 1000 + 1000);
        expect(stub().checks).toBeGreaterThan(asked);
    });
});

// The gate is a STARTUP thing, and the two halves answer differently on
// purpose. Before the app exists there is nothing to interrupt, so it installs.
// Once the app is up there is a person in the middle of something, so it waits
// and offers — which is the same argument the gate itself is built on, applied
// to the other end of the session. See updater-autorestart.test.js.
describe('a mid-session update, with no gate open', () => {
    it('does NOT install itself', async () => {
        updater.startDownload();
        fire('update-downloaded', { version: '9.9.9', releaseNotes: '' });
        await flush();
        expect(stub().installs.length).toBe(0);
        expect(updater.getState().waitingFor).toBe('user');
    });

    it('installs when it is asked to', async () => {
        updater.startDownload();
        fire('update-downloaded', { version: '9.9.9', releaseNotes: '' });
        await flush();
        updater.installNow();
        await flush();
        expect(stub().installs.length).toBe(1);
    });

    it('says a call is what it is waiting for, while one is running', async () => {
        updater.setBusy(true);
        updater.startDownload();
        fire('update-downloaded', { version: '9.9.9', releaseNotes: '' });
        await flush();
        expect(stub().installs.length).toBe(0);
        expect(updater.getState().waitingFor).toBe('call');

        updater.setBusy(false);
        await flush();
        // Still nothing automatic — but it stops blaming a call that has ended.
        expect(stub().installs.length).toBe(0);
        expect(updater.getState().waitingFor).toBe('user');
    });
});

// A downloaded update is a FACT, not a phase.
//
// `state.status` is one field, and every later event overwrote it. So a manual
// "Check for updates" — or an error from a periodic recheck — wrote 'checking' or
// 'error' over a 'ready' that meant "the bytes are on disk". scheduleAutoRestart()
// refuses to act unless the status is exactly 'ready', so an update that had
// downloaded and was being held for the end of a call was permanently disarmed by
// anyone pressing that button while the call was still running. The banner's
// promise — "it will install when your call ends" — then went unkept until the next
// quit.
describe('an update that is already downloaded', () => {
    // Get to "downloaded, held for a call in progress".
    async function held() {
        updater.setBusy(true);
        // startDownload() is what lazily requires electron-updater and registers
        // the event handlers — the same thing the mid-session specs above rely on.
        updater.startDownload();
        fire('update-available', { version: '9.9.9', releaseNotes: 'x' });
        fire('update-downloaded', { version: '9.9.9', releaseNotes: 'x' });
        await flush();
        expect(updater.getState().status).toBe('ready');
        expect(updater.getState().waitingFor).toBe('call');
        expect(stub().installs).toHaveLength(0);   // never mid-call
        return updater;
    }

    it('survives a manual check while a call is in progress', async () => {
        await held();

        updater.checkNow();
        fire('checking-for-update');
        await flush();

        expect(updater.getState().status).toBe('ready');
    });

    it('survives an error that has nothing to do with it', async () => {
        await held();

        fire('error', new Error('getaddrinfo ENOTFOUND'));
        await flush();

        expect(updater.getState().status).toBe('ready');
    });

    it('is still installable after the call ends', async () => {
        // The point of this block: a later 'checking' or 'error' event must not
        // disarm an update whose bytes are already on disk. What proves it is
        // that the install still WORKS afterwards — it just needs the click now
        // rather than happening by itself.
        await held();
        fire('checking-for-update');
        fire('error', new Error('feed unreachable'));
        await flush();

        updater.setBusy(false);
        await flush();
        expect(updater.getState().status).toBe('ready');
        expect(updater.getState().waitingFor).toBe('user');

        updater.installNow();
        await flush();
        expect(stub().installs).toHaveLength(1);
    });

    it('is invalidated by a genuinely newer build', async () => {
        await held();

        // A different version means the file on disk is not the update on offer.
        fire('update-available', { version: '9.9.10', releaseNotes: 'y' });
        fire('checking-for-update');
        await flush();

        expect(updater.getState().status).not.toBe('ready');
    });
});
