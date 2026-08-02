// The main-process half of the 0.75 audit pass.
//
// These read SOURCE rather than running it. main.js cannot be required in this
// suite — it reaches for a real Electron app object at module scope, and the two
// defects below are both about the ORDER in which module-scope statements run,
// which is exactly what a stub would paper over. The e2e tier launches the real
// binary but cannot see either (one decides a Chromium switch before the process
// exists, the other only shows up in what a quit does NOT flush).
//
// A source assertion is weaker than an executed one, so each is written to fail
// on the specific shape of the regression rather than on formatting.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main');

let main = '';
let net = '';
// The same source with its COMMENTS taken out, which every assertion below runs
// against. These files explain their own hazards by quoting the call that used
// to be there — the relaunch handler names app.exit(0) in prose, and the store
// init carries a paragraph about store.get() — so a needle matched against raw
// text can be satisfied, or contradicted, by the explanation rather than by the
// code. (palette.test.js keeps a `rules` copy for exactly this reason.)
let mainCode = '';
beforeAll(() => {
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
    main = fs.readFileSync(path.join(MAIN, 'main.js'), 'utf8').replace(/\r\n/g, '\n');
    net = fs.readFileSync(path.join(MAIN, 'net.js'), 'utf8').replace(/\r\n/g, '\n');
    mainCode = strip(main);
});

// TURNING HARDWARE ACCELERATION OFF DID NOTHING, EVER.
//
// store.js's cache starts as null and get() is `Object.assign({}, cache)`, so
// before init() every read answers `{}`. The hardware-acceleration check runs at
// module scope — it has to, because disableHardwareAcceleration() is only legal
// before the app is ready — while store.init() was called inside whenReady(). So
// the test was `undefined === false` on every launch and
// app.disableHardwareAcceleration() was unreachable code: the setting saved, the
// toggle read back as off, the app offered a restart to apply it, and Chromium
// came up with GPU compositing on regardless.
describe('the hardware acceleration setting can actually be read', () => {
    it('initialises the store before the switch is read', () => {
        const init = mainCode.indexOf('store.init();');
        const read = mainCode.indexOf('store.get().hardwareAcceleration');
        expect(init).toBeGreaterThan(-1);
        expect(read).toBeGreaterThan(-1);
        expect(init).toBeLessThan(read);
    });

    // Both have to be at module scope. If the read ever moves inside
    // whenReady() the switch stops working for the opposite reason —
    // disableHardwareAcceleration() is a no-op once the app is ready — so pin
    // that they are ahead of it.
    it('does both before the app is ready', () => {
        const ready = mainCode.indexOf('app.whenReady()');
        expect(ready).toBeGreaterThan(-1);
        expect(mainCode.indexOf('store.init();')).toBeLessThan(ready);
        expect(mainCode.indexOf('store.get().hardwareAcceleration')).toBeLessThan(ready);
    });
});

// THE RESTART THREW AWAY THE SETTING IT WAS RESTARTING FOR.
//
// app:relaunch called app.exit(0), which terminates without firing before-quit
// or will-quit. Settings writes are debounced by 250ms and the only reason to be
// on this path is that one was just made, so the restart raced store.flush() and
// usually won. It also skipped retirePresence() (you stayed in the member list)
// and ptt.shutdown() (the system-wide keyboard hook was still held as the
// replacement process started).
describe('restarting in place shuts down rather than terminating', () => {
    it('quits instead of exiting', () => {
        const h = mainCode.slice(mainCode.indexOf("handle('app:relaunch'"));
        const body = h.slice(0, h.indexOf('});'));
        expect(body).toContain('app.relaunch();');
        expect(body).toContain('app.quit();');
        expect(body).not.toMatch(/app\.exit\(/);
    });

    // before-quit is what flushes and retires; will-quit is what releases the
    // hook and the socket. Neither runs for app.exit(), so this asserts they
    // exist to be run.
    it('still has the handlers that quit runs and exit skipped', () => {
        expect(mainCode).toMatch(/app\.on\('before-quit'/);
        expect(mainCode).toMatch(/app\.on\('will-quit'/);
        expect(mainCode).toMatch(/store\.flush\(\)/);
    });
});

// THE THREADS PANEL WAS AN UNCONSTRAINED REPLICA READ.
//
// Four board endpoints open a D1 read-replication session server-side — the ones
// whose handlers call boardDb() and hand the session to json() so it echoes an
// x-d1-bookmark: list, thread, pins and threads. The client sent the bookmark for
// only the first three, so every /threads request arrived bare, the server
// defaulted it to 'first-unconstrained', and any replica however far behind could
// answer. It never spent forcePrimary either, which is the only read-your-writes
// lever available, since writes echo no bookmark of their own — so posting a
// reply and opening the Threads panel could simply not show the thread just
// created, with success:true so nothing fell back.
describe('every replica-routed read carries the bookmark', () => {
    it('names all four endpoints in one place', () => {
        const m = /const REPLICA_READS = new Set\(\[([^\]]*)\]\)/.exec(net);
        expect(m).toBeTruthy();
        const names = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
        expect(names.sort()).toEqual(['list', 'pins', 'thread', 'threads']);
    });

    it('uses that one set to decide both sending and storing', () => {
        expect(net.match(/REPLICA_READS\.has\(pathname\)/g)).toHaveLength(2);
    });

    // The old shape, so a revert is caught rather than merely un-asserted.
    it('no longer decides it with an equality chain', () => {
        expect(net).not.toMatch(/pathname === 'list' \|\| pathname === 'thread'/);
    });
});
