// THE UPDATE THAT QUIT THE APP INSTEAD OF INSTALLING IT.
//
// 0.92.2 moved the window build alongside the startup update check — two
// independent waits that used to be queued one behind the other. It also meant
// that, for the first time, the gate OWNS a window while it decides. The
// 'installing' verdict destroys that window to hand over to the NSIS installer,
// and whether anything is left behind it comes down to `splashWanted`:
//
//   splashWanted = resumeVisible || !(startMinimized || --openAsHidden)
//
// …which is FALSE for a profile with "start minimized to the tray" on — the
// exact configuration the login item registers. So the destroy took the window
// count to zero, `window-all-closed` fired, and app.quit() ran inside the 500ms
// before installNow() could call quitAndInstall(silent, relaunch). The update
// still applied, through electron-updater's autoInstallOnAppQuit — which
// installs SILENTLY AND DOES NOT RELAUNCH. The app simply vanished on update
// day for the people who run it hidden. The 20s "the installer never took over"
// safety net died with the process that was supposed to run it.
//
// These read SOURCE rather than running it, for the reason audit-0.75-main.js
// gives: main.js reaches for a real Electron app object at module scope, and
// what is being pinned here is the ORDER and the GUARDS around statements that
// only a real Electron process ever executes. Each assertion is written against
// the shape of the regression rather than against formatting.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main');

// Comments stripped, for the same reason the other main-source suite does it:
// this file's hazards are explained in prose that names the very calls being
// asserted about, so a needle matched against raw text could be satisfied by
// the explanation instead of by the code.
let mainCode = '';
beforeAll(() => {
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
    mainCode = strip(fs.readFileSync(path.join(MAIN, 'main.js'), 'utf8'));
});

describe('the startup gate handing this process to an installer', () => {
    it('does not let the last window closing quit it', () => {
        const h = mainCode.slice(mainCode.indexOf("app.on('window-all-closed'"));
        const body = h.slice(0, h.indexOf('});') + 3);
        expect(body).toBeTruthy();
        // The guard, and BEFORE the quit — a check that runs after app.quit()
        // is not a check.
        expect(body).toMatch(/if\s*\(\s*installing\s*\)\s*return/);
        expect(body.indexOf('installing')).toBeLessThan(body.indexOf('app.quit()'));
    });

    it('sets the flag before it destroys the window', () => {
        // The guard above is only live if `installing` is already true when the
        // destroy empties the window list — the event is emitted synchronously
        // from Electron's WindowList::RemoveWindow.
        const branch = mainCode.slice(mainCode.indexOf("verdict === 'installing'"));
        const set = branch.indexOf('installing = true');
        const destroy = branch.indexOf('win.destroy()');
        expect(set).toBeGreaterThan(-1);
        expect(destroy).toBeGreaterThan(-1);
        expect(set).toBeLessThan(destroy);
    });

    it('gives the launch back when the installer never takes over', () => {
        // The fallback rebuilds the app in this process. It has to take the
        // VERDICT back as well as the flag: both consumers of gateSettled — the
        // reveal in createWindow and the renderer's held auth:status — still
        // read 'installing', so the window startApp() builds would come up
        // invisible and sessionless, findable only via the tray.
        const h = mainCode.slice(mainCode.indexOf('updater.onInstallGaveUp('));
        const body = h.slice(0, h.indexOf('});') + 3);
        expect(body).toContain('installing = false');
        expect(body).toMatch(/gateSettled\s*=\s*Promise\.resolve\('launch'\)/);
        // …and before the app is rebuilt, or the new window reads the old one.
        expect(body.indexOf('gateSettled')).toBeLessThan(body.indexOf('startApp()'));
    });
});

describe('the update screen', () => {
    it('quits the app when the user closes it', () => {
        // It used to work by arithmetic: the splash was the only window in
        // existence, so closing it emptied the window list and window-all-closed
        // quit the app. The gate builds the app window alongside the check now,
        // and that hidden window keeps the process alive — so Quit closed the
        // only thing on screen and left ScarmVoice running invisibly.
        const h = mainCode.slice(mainCode.indexOf("splash.on('closed'"));
        const body = h.slice(0, h.indexOf('});') + 3);
        expect(body).toContain('app.quit()');
        // Distinguished from the app's own teardown, which disowns the window
        // before destroying it — otherwise closeSplash() would quit the app
        // every time an update screen came down normally.
        expect(body).toMatch(/splash\s*!==\s*null/);
    });

    it('comes down on the reveal decision, not on ready-to-show alone', () => {
        // The reveal stopped hanging off ready-to-show precisely because that
        // event is unreliable on this app (measured: same build, fires one run
        // and not the next). The splash teardown was left waiting on it, so on
        // the launches where it never fires the app window appeared UNDERNEATH
        // an "Updating…" screen that stayed for the full 15s fallback.
        const h = mainCode.slice(mainCode.indexOf('if (splash) {'));
        const body = h.slice(0, h.indexOf('\n    }') + 6);
        expect(body).toContain('onRevealDecided(closeSplash)');
        expect(body).not.toMatch(/once\('ready-to-show',\s*closeSplash\)/);
        // The 15s backstop stays: a window that never becomes ready at all must
        // not leave the update screen up for the session.
        expect(body).toMatch(/setTimeout\(closeSplash,\s*15000\)/);
    });

    it('fires every reveal waiter when the decision lands', () => {
        const h = mainCode.slice(mainCode.indexOf('const decideReveal'));
        const body = h.slice(0, h.indexOf('gateSettled.then'));
        expect(body).toContain('winReadyToShow = true');
        expect(body).toMatch(/revealWaiters\.splice\(0\)/);
    });
});
