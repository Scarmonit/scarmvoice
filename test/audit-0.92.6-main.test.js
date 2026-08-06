// The main-process half of the 0.92.6 audit pass.
//
// This reads SOURCE. main.js cannot be required in this suite — it reaches for
// a real Electron app object at module scope — and the defect below is a
// module-scope decision made before any window, tray or splash exists, which is
// exactly what a stub would paper over. See audit-0.75-main.test.js for the
// same reasoning at more length.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main');

// Comments stripped, because this file explains its own hazards by quoting the
// condition that used to be there — an assertion matched against raw text could
// be satisfied by the explanation rather than by the code.
let mainCode = '';
beforeAll(() => {
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
    mainCode = strip(fs.readFileSync(path.join(MAIN, 'main.js'), 'utf8').replace(/\r\n/g, '\n'));
});

// A DOUBLE-CLICK ON AN UPDATE DAY PUT NOTHING ON SCREEN AT ALL.
//
// Three things can show something during the startup update gate, and on a
// start-minimized profile all three were off at once:
//
//   • the app window   — built hidden, revealed only inside gateSettled.then()
//   • the tray icon    — createTray() runs in startApp(), behind `await gateSettled`
//   • the splash       — ensureSplash() returns immediately unless splashWanted
//
// splashWanted asked `store.get().startMinimized`, which is the ordinary
// configuration for anybody who runs this in the tray. So a launch somebody
// performed by hand — argv carrying neither --openAsHidden nor --updated, which
// the reveal decision correctly reads as "show" — drew nothing for the whole
// gate: up to fifteen seconds on a stalled feed, and the length of an installer
// download once an update was found. Clicking the shortcut again did not help
// either: showWindow() defers to focusSplash(), which is a no-op when no splash
// was ever built.
//
// The reveal decision had this exact mistake removed from it already. The rule
// is that the LAUNCH says whether anybody asked for it, not the setting — the
// login item carries --openAsHidden for precisely that purpose.
describe('whether the startup update screen is wanted', () => {
    // The assignment, with whitespace and line breaks flattened. Not the
    // declaration a few hundred lines above it, which is only `= false`.
    const assignment = () => {
        const all = [...mainCode.matchAll(/(let\s+)?splashWanted\s*=\s*([^;]+);/g)]
            .filter((m) => !m[1]);
        expect(all.length, 'exactly one splashWanted assignment').toBe(1);
        return all[0][2].replace(/\s+/g, ' ');
    };

    it('asks the launch, not the start-minimized setting', () => {
        expect(assignment()).not.toMatch(/startMinimized/);
    });

    it('stays silent only for the launches nobody performed', () => {
        const a = assignment();
        expect(a).toMatch(/--openAsHidden/);
        expect(a).toMatch(/--updated/);
        // …unless the process being replaced was on screen, which outranks both.
        expect(a).toMatch(/resumeVisible/);
    });

    // The same question is answered one screen below, for updateResumeVisible,
    // and the two must not drift: both are "did anybody ask for this launch".
    it('matches the test the installing branch already writes', () => {
        const want = "resumeVisible || !(process.argv.includes('--openAsHidden') || process.argv.includes('--updated'))";
        const flat = mainCode.replace(/\s+/g, ' ');
        // Twice: once here, once in the updateResumeVisible write.
        const hits = flat.split(want.replace(/\s+/g, ' ')).length - 1;
        expect(hits).toBeGreaterThanOrEqual(2);
    });

    // The handover protection must NOT come to rest on splashWanted again:
    // window-all-closed fires when the gate destroys its hidden window, and
    // what holds the process open for the installer is the `installing` flag.
    it('does not put the install handover back on the splash', () => {
        const handler = mainCode.slice(mainCode.indexOf("app.on('window-all-closed'"));
        expect(handler).toMatch(/if \(installing\) return;/);
        expect(handler.slice(0, handler.indexOf('});'))).not.toMatch(/splashWanted/);
    });
});
