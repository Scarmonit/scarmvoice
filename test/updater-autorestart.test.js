// Updates install themselves, and now they do it IMMEDIATELY.
//
// There used to be a ten-second countdown with a "Not now" under it. Every
// update therefore waited on somebody either ignoring it or missing it, and an
// update nobody finished applying is an update that was never shipped. The rule
// is now: downloaded means installed, and the app comes back on the new version.
//
// Exactly one thing may still hold it, and that one is worth the whole of this
// file: a call in progress. Restarting mid-conversation drops you out of it,
// which is a worse interruption than any update is worth — and the wait it
// creates is bounded by the length of the call.
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { loadMain, resetMainModules } from './helpers/load.js';

let updater, sent;

// The electron-updater stand-in (see test/stubs/electron-updater.cjs).
const stub = () => globalThis.__UPDATER_STUB__;

// Drive the real event the feed would fire, through the handlers updater.js
// registered on load().
function fireDownloaded(version) {
    (stub().handlers['update-downloaded'] || []).forEach((fn) => fn({ version, releaseNotes: '' }));
}

// Let installNow()'s setImmediate run.
const flush = () => vi.advanceTimersByTimeAsync(1);

beforeEach(() => {
    vi.useFakeTimers();
    resetMainModules();
    // Cleared IN PLACE: the stub module captured this object when it was first
    // required and holds that reference, so replacing it here would leave the
    // stub recording into one object while the test read another.
    const s = (globalThis.__UPDATER_STUB__ ||= { installs: [], checks: 0, downloads: 0, handlers: {} });
    s.installs.length = 0;
    s.checks = 0;
    s.downloads = 0;
    s.handlers = {};
    updater = loadMain('updater.js');
    sent = [];
    updater.init((channel, state) => sent.push({ channel, state: { ...state } }));
    updater.startDownload();          // registers the feed handlers via load()
});

afterEach(() => { vi.useRealTimers(); });

// The countdown is gone, so no state this module ever publishes may carry one.
const everCountedDown = () => sent.some((s) => typeof s.state.restartIn === 'number');

describe('a downloaded update', () => {
    it('installs at once, with no timer in front of it', async () => {
        fireDownloaded('9.9.9');
        await flush();
        expect(stub().installs.length).toBe(1);
        // isSilent + isForceRunAfter: install quietly, come back up on the new
        // version rather than leaving the user staring at a closed app.
        expect(stub().installs[0]).toMatchObject({ isSilent: true, isForceRunAfter: true });
        expect(everCountedDown()).toBe(false);
    });

    it('cannot be talked out of it', async () => {
        // Both of these used to hold the restart. Neither is a decision any more,
        // and the IPC surface keeps them only so an older renderer still resolves.
        expect(updater.postpone()).toMatchObject({ ok: false, forced: true });
        updater.setAuto(false);
        fireDownloaded('9.9.9');
        await flush();
        expect(stub().installs.length).toBe(1);
    });
});

describe('a call in progress', () => {
    it('holds the restart, and says so rather than failing silently', async () => {
        updater.setBusy(true);
        fireDownloaded('9.9.9');
        await vi.advanceTimersByTimeAsync(60_000);
        expect(stub().installs.length).toBe(0);
        const s = updater.getState();
        expect(s.status).toBe('ready');
        expect(s.waitingFor).toBe('call');
        expect(s.restartIn).toBeNull();
        expect(everCountedDown()).toBe(false);
    });

    it('lets it through the moment the call ends', async () => {
        updater.setBusy(true);
        fireDownloaded('9.9.9');
        await flush();
        expect(stub().installs.length).toBe(0);

        updater.setBusy(false);
        await flush();
        expect(stub().installs.length).toBe(1);
    });

    it('does not fire on an empty state when a call ends', async () => {
        // Nothing was ever downloaded here: leaving a call must not by itself
        // quit the app.
        updater.setBusy(true);
        updater.setBusy(false);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(stub().installs.length).toBe(0);
        expect(updater.getState().status).not.toBe('error');
    });
});
