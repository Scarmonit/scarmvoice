// WHEN a downloaded update installs, and who decides.
//
// At STARTUP the gate installs it before the app exists — nothing is open, so
// there is nothing to interrupt (see update-gate.test.js).
//
// MID-SESSION it waits. It used to restart the app out from under whatever you
// were doing, which is the exact thing the startup gate exists to avoid, and
// the banner's only job was to narrate a restart that was already happening.
// Now the bytes sit on disk, a pill says so at the top of the window, and ONE
// CLICK installs and restarts. Nothing is lost by waiting: autoInstallOnAppQuit
// is armed, so closing the app applies it whether the pill was clicked or not.
//
// `waitingFor` is how the pill knows what to say:
//   'user'      ready, nothing in the way, waiting to be clicked
//   'call'      ready, but a call is running — restarting drops you out of it
//   'download'  clicked, and the bytes are still coming
//
// The countdown that used to sit in front of all this is gone and must not come
// back; everCountedDown() below is what asserts that.
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

// A download that dies mid-stream — a dropped connection, a 5xx from release
// storage. Distinct from checkForUpdates() rejecting, which is the feed being
// unreachable before anything started.
function fireError(message) {
    (stub().handlers.error || []).forEach((fn) => fn(new Error(message)));
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

describe('a downloaded update, mid-session', () => {
    it('waits to be asked rather than restarting the app', async () => {
        fireDownloaded('9.9.9');
        await vi.advanceTimersByTimeAsync(60_000);
        // The whole point: it does NOT take the app away.
        expect(stub().installs.length).toBe(0);
        const s = updater.getState();
        expect(s.status).toBe('ready');
        expect(s.version).toBe('9.9.9');
        expect(s.waitingFor).toBe('user');
        expect(everCountedDown()).toBe(false);
    });

    it('installs on one click, and comes back on the new version', async () => {
        fireDownloaded('9.9.9');
        await flush();
        updater.installNow();
        await flush();
        expect(stub().installs.length).toBe(1);
        // isSilent + isForceRunAfter: install quietly, come back up on the new
        // version rather than leaving the user staring at a closed app.
        expect(stub().installs[0]).toMatchObject({ isSilent: true, isForceRunAfter: true });
    });

    it('keeps the two dead controls answering, without reviving them', async () => {
        // Both of these used to hold a restart. Neither is a decision any more,
        // and the IPC surface keeps them only so an older renderer still
        // resolves — but neither may install anything by itself either.
        expect(updater.postpone()).toMatchObject({ ok: false, forced: true });
        fireDownloaded('9.9.9');
        await flush();
        updater.setAuto(false);
        await flush();
        expect(stub().installs.length).toBe(0);
        expect(updater.getState().waitingFor).toBe('user');
    });
});

describe('a click before the download has finished', () => {
    it('is remembered, so one click stays one click', async () => {
        // The pill appears as soon as an update is AVAILABLE, and a click then
        // means what it means ten seconds later. Rather than a disabled button
        // and a second press, the intent is held and acted on when the bytes
        // land.
        const r = updater.installNow();
        expect(r).toMatchObject({ ok: true, pending: true });
        expect(stub().installs.length).toBe(0);
        expect(updater.getState().waitingFor).toBe('download');

        fireDownloaded('9.9.9');
        await flush();
        expect(stub().installs.length).toBe(1);
    });

    it('does not restart somebody who never asked', async () => {
        // The mirror of the test above, and the reason it is worth having: an
        // update that downloads on its own must not inherit a click that was
        // never made.
        fireDownloaded('9.9.9');
        await vi.advanceTimersByTimeAsync(60_000);
        expect(stub().installs.length).toBe(0);
    });
});

describe('a download that dies after it was clicked', () => {
    it('stops holding the button flat under the word Try again', async () => {
        // Clicking while the bytes are still coming is the documented flow, and
        // it sets waitingFor:'download' so the button reads "Updating…" and goes
        // inert. If the download then FAILS the pill's copy changes to "download
        // failed … Try again" — and the flag used to survive that, so the
        // control under that word stayed disabled and the only way to retry was
        // to click the bar around it.
        updater.installNow();
        expect(updater.getState().waitingFor).toBe('download');

        fireError('ENOTFOUND objects.githubusercontent.com');
        await flush();

        const s = updater.getState();
        expect(s.status).toBe('available');
        expect(s.stalled).toBe(true);
        expect(s.waitingFor).toBeNull();
    });

    it('still remembers the click, so the retry needs no second press', async () => {
        updater.installNow();
        fireError('socket hang up');
        await flush();

        // The failure clears what the pill is WAITING on, never what the user
        // asked for.
        fireDownloaded('9.9.9');
        await flush();
        expect(stub().installs.length).toBe(1);
    });

    it('leaves a ready update alone when a later check errors', async () => {
        // The mirror: this error did not happen to a download, so nothing about
        // the pill's state is its business.
        fireDownloaded('9.9.9');
        await flush();
        expect(updater.getState().waitingFor).toBe('user');

        fireError('rate limited');
        await flush();
        const s = updater.getState();
        expect(s.status).toBe('ready');
        expect(s.stalled).toBe(false);
        expect(s.waitingFor).toBe('user');
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

    it('offers it the moment the call ends, without restarting by itself', async () => {
        updater.setBusy(true);
        fireDownloaded('9.9.9');
        await flush();
        expect(stub().installs.length).toBe(0);

        updater.setBusy(false);
        await vi.advanceTimersByTimeAsync(60_000);
        // The call was the only thing in the way, so the pill stops blaming it —
        // but the click is still the user's to make.
        expect(stub().installs.length).toBe(0);
        expect(updater.getState().waitingFor).toBe('user');
    });

    it('lets the person in the call overrule it', async () => {
        // The pill says "Restart now" during a call, and it means it. Nothing
        // else in the app may restart through a call — but somebody who reads
        // "your call will end" and presses it anyway has made the one decision
        // that is genuinely theirs, and refusing it would be a button that lies.
        updater.setBusy(true);
        fireDownloaded('9.9.9');
        await flush();
        expect(stub().installs.length).toBe(0);   // nothing automatic, ever
        expect(updater.getState().waitingFor).toBe('call');

        updater.installNow();
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

// Coming back the way you left it.
//
// "Start minimized to the tray" is about a launch NOBODY asked for — at
// sign-in, in the background. Clicking "Restart Now" is the opposite: somebody
// is at the window watching the app they are using go away. It used to come
// back into the tray on that profile, so the button read as having closed the
// app. main.js answers "is the window on screen?" — this module's job is only
// to ask, at the last moment anything can still see it, and on every path that
// replaces the process.
describe('the state the app is replaced from', () => {
    it('is recorded before the installer is handed the app', async () => {
        const order = [];
        updater.onBeforeInstall(() => order.push('asked'));
        fireDownloaded('9.9.9');
        await flush();

        updater.installNow();
        await flush();
        order.push('installed');

        // Asked FIRST: the answer is written into settings, and settings are
        // flushed by installNow on its way out. Asking afterwards would write
        // into a process that is already being killed.
        expect(order).toEqual(['asked', 'installed']);
        expect(stub().installs.length).toBe(1);
    });

    it('is recorded on a click that beat the download, too', async () => {
        // This click installs from update-downloaded rather than from the call
        // the user made, so a hook wired only into the direct path would miss
        // exactly the case where the user waited longest at the window.
        const asked = vi.fn();
        updater.onBeforeInstall(asked);

        updater.installNow();               // still downloading
        expect(asked).not.toHaveBeenCalled();

        fireDownloaded('9.9.9');
        await flush();
        expect(asked).toHaveBeenCalledTimes(1);
        expect(stub().installs.length).toBe(1);
    });

    it('is not asked for when nothing is being installed', async () => {
        const asked = vi.fn();
        updater.onBeforeInstall(asked);
        fireDownloaded('9.9.9');
        await vi.advanceTimersByTimeAsync(60_000);
        // A ready update that is sitting there waiting to be clicked has not
        // replaced anything, so there is no state to freeze.
        expect(asked).not.toHaveBeenCalled();
    });

    it('cannot stop the install by throwing', async () => {
        // It writes a setting for the sake of the NEXT launch. Losing that is a
        // window in the tray; losing the install is an app that will not update.
        updater.onBeforeInstall(() => { throw new Error('store is on fire'); });
        fireDownloaded('9.9.9');
        await flush();
        updater.installNow();
        await flush();
        expect(stub().installs.length).toBe(1);
    });
});
