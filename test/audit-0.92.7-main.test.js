// The main-process half of the 0.92.7 audit pass.
//
// Four defects, and the thread running through three of them is a decision
// being made twice: an answer that one piece of code arrives at carefully and
// another overwrites a moment later without knowing what it cost.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { electronState as env } from './helpers/electron-state.js';
import { loadMain, resetMainModules } from './helpers/load.js';

const MAIN = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main');

// ---------------------------------------------------------------------------
// A FAILED CHECK UN-READIED AN UPDATE THAT WAS ALREADY ON DISK.
//
// electron-updater reports a failed check TWICE — the 'error' event, and then a
// rejection of the promise checkForUpdates() returned. The event listener in
// updater.js is the one that knows what a failure is allowed to do to `state`:
// it deliberately keeps a downloaded update at 'ready', with a comment saying
// why. The promise's .catch then ran one microtask later and set 'error' over
// the top of it.
//
// Two things fall over when the status is 'error'. The renderer has no
// UPDATE_COPY entry for it, so the whole update pill vanishes; and
// scheduleAutoRestart() opens `if (state.status !== 'ready') return`, so a
// "Restart now" pressed earlier and remembered in installWhenReady is silently
// dropped when the call it was waiting on ends. Settings › Check for updates
// calls this unguarded, so one click on a dropped connection was enough.
describe('a check that fails while an update is already downloaded', () => {
    let updater;
    const stub = () => globalThis.__UPDATER_STUB__;
    const fire = (event, payload) => (stub().handlers[event] || []).forEach((fn) => fn(payload));
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
        s.installThrows = null;
        env.isPackaged = true;
        updater = loadMain('updater.js');
        updater.init(() => {});
        updater.startDownload();      // registers the feed handlers via load()
    });
    afterEach(() => { vi.useRealTimers(); });

    async function readyUpdate() {
        // No startupGate() was opened, so gateInstall() answers false and
        // update-downloaded parks on the pill exactly as it does mid-session.
        fire('update-downloaded', { version: '9.9.9', releaseNotes: 'A title\n\nsomething changed' });
        await flush();
        expect(updater.getState().status).toBe('ready');
    }

    it('leaves the update ready, and the pill with something to show', async () => {
        updater.setBusy(true);            // a call in progress, so nothing installs
        await readyUpdate();

        stub().checkFails = 'getaddrinfo ENOTFOUND github.com';
        updater.checkNow();
        await flush();

        const s = updater.getState();
        expect(s.status).toBe('ready');
        expect(s.version).toBe('9.9.9');
    });

    it('still installs when the call ends, honouring the click it was given', async () => {
        updater.setBusy(true);            // a call is running
        // "Restart now", pressed while the bytes are still coming: remembered
        // in installWhenReady rather than performed.
        updater.installNow();
        await flush();
        await readyUpdate();
        // The call is what is holding it, so still nothing has installed.
        expect(stub().installs.length).toBe(0);
        expect(updater.getState().waitingFor).toBe('call');

        // …and now the feed goes unreachable. This has nothing to do with the
        // update already in hand, and must cost it nothing.
        stub().checkFails = 'socket hang up';
        updater.checkNow();
        await flush();

        updater.setBusy(false);           // the call ends
        await flush();
        expect(stub().installs.length).toBe(1);
    });

    // The mirror, so the fix cannot be "never report an error": with nothing
    // downloaded there is no answer worth protecting and Settings must still be
    // able to say the check failed.
    it('still reports the failure when there is no update in hand', async () => {
        // Not mid-download, or the listener would report the stall instead —
        // that is a different failure with its own answer ('available').
        fire('checking-for-update');
        stub().checkFails = 'rate limited';
        updater.checkNow();
        await flush();
        expect(updater.getState().status).toBe('error');
    });
});

// ---------------------------------------------------------------------------
// THE PERIODIC RECHECK RE-OPENED A DOWNLOAD THAT HAD ALREADY FINISHED.
//
// isUpdateAvailable() compares the feed against the RUNNING version, not
// against what is sitting on disk, so an update that has downloaded and is
// waiting to be clicked is re-announced by every check. The handler reported it
// as 'available', which walked the pill back from "ready to install" — and, one
// statement later, defeated startDownload()'s own 'ready' guard, so it emitted
// `downloading, progress: 0` and asked for the bytes again.
//
// `downloaded` is kept outside `state.status` for precisely this reason: having
// the bytes is a fact, not a phase. Neither site was reading it.
describe('a version that is already downloaded being announced again', () => {
    let updater;
    const stub = () => globalThis.__UPDATER_STUB__;
    const fire = (event, payload) => (stub().handlers[event] || []).forEach((fn) => fn(payload));
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
        s.installThrows = null;
        env.isPackaged = true;
        updater = loadMain('updater.js');
        updater.init(() => {});
        updater.startDownload();      // registers the feed handlers via load()
    });
    afterEach(() => { vi.useRealTimers(); });

    it('stays ready, and asks for no bytes it already has', async () => {
        updater.setBusy(true);
        fire('update-downloaded', { version: '9.9.9', releaseNotes: 'T\n\nbody' });
        await flush();
        const downloadsAfterFirst = stub().downloads;

        fire('checking-for-update');
        fire('update-available', { version: '9.9.9', releaseNotes: 'T\n\nbody' });
        await flush();

        const s = updater.getState();
        expect(s.status).toBe('ready');
        expect(s.progress).toBe(100);
        expect(stub().downloads).toBe(downloadsAfterFirst);
    });

    // …and a genuinely newer release must still supersede it, or the guard
    // would strand everyone on the first update of a session.
    it('gives way to a newer release, which downloads as normal', async () => {
        updater.setBusy(true);
        fire('update-downloaded', { version: '9.9.9', releaseNotes: 'T\n\nbody' });
        await flush();
        const before = stub().downloads;

        fire('update-available', { version: '9.9.10', releaseNotes: 'T\n\nbody' });
        await flush();

        expect(updater.getState().status).toBe('downloading');
        expect(stub().downloads).toBe(before + 1);
    });
});

// ---------------------------------------------------------------------------
// THE READ-YOUR-WRITES DEBT WAS DROPPED BY THE TWO CASES ITS OWN COMMENT NAMES.
//
// board() spends `forcePrimary` at the top of a replica read — it writes
// `x-d1-bookmark: first-primary` and clears the flag — and puts it back at the
// bottom when the answer turned out to be no use. The restore sits AFTER every
// early return in the 401 branch and after the one in the unparseable-body
// branch, which are two of the three cases the comment above it lists.
//
// So: post a message, have the refetch come back as a disbelieved 401 or as
// Cloudflare's HTML 1101 page, and the next read goes out unconstrained, is
// answered by a lagging replica, and the user's own message is missing from the
// channel they are looking at until some later poll happens to catch up.
describe('read-your-writes after an answer that was no use', () => {
    let root;
    const realFetch = global.fetch;
    let calls;

    function stubFetch(handler) {
        calls = [];
        global.fetch = vi.fn(async (url, opts) => {
            calls.push({ url, opts });
            return handler(url, opts, calls.length - 1);
        });
    }
    const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), {
        status, headers: { 'content-type': 'application/json' }
    });
    const bookmarks = () => calls
        .filter((c) => String(c.url).includes('/api/board/list'))
        .map((c) => (c.opts.headers || {})['x-d1-bookmark']);

    async function load() {
        resetMainModules();
        const store = loadMain('store.js');
        store.init();
        store.writeSession('SESSION123');
        const net = loadMain('net.js');
        net.init();
        return net;
    }

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'scarmvoice-audit927-'));
        env.userDataDir = path.join(root, 'Roaming', 'ScarmVoice');
        env.encryptionAvailable = true;
    });
    afterEach(() => {
        global.fetch = realFetch;
        try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* windows */ }
    });

    // A POST that succeeded owes the next read a primary. Spend it on a `list`
    // that answers with `reply`, then look at what the read after that asks for.
    async function spendThenRetry(reply) {
        const net = await load();
        let listNo = 0;
        stubFetch((url) => {
            if (String(url).includes('/api/board/post')) return jsonRes({ success: true, id: 7 });
            if (String(url).includes('/api/board/list')) {
                listNo++;
                if (listNo === 1) return reply();
                return jsonRes({ success: true, posts: [] });
            }
            // confirmSignedOut()'s gate probe: still authed, so the 401 above is
            // disbelieved and treated as transient — the documented case.
            if (String(url).includes('/auth/status')) return jsonRes({ authed: true });
            return jsonRes({ success: true });
        });

        await net.board('post', { method: 'POST', body: { body: 'hi' } });
        await net.board('list', {});
        await net.board('list', {});
        return bookmarks();
    }

    it('is still owed after a 401 nobody could confirm', async () => {
        const asked = await spendThenRetry(() => jsonRes({ success: false, error: 'unauthorized' }, 401));
        expect(asked[0]).toBe('first-primary');
        expect(asked[1]).toBe('first-primary');
    });

    it('is still owed after a needsAccount 401 from the middleware', async () => {
        const asked = await spendThenRetry(
            () => jsonRes({ success: false, needsAccount: true }, 401));
        expect(asked[0]).toBe('first-primary');
        expect(asked[1]).toBe('first-primary');
    });

    it('is still owed after a body that would not parse', async () => {
        // A Worker that threw: status 500 carrying Cloudflare's HTML 1101 page.
        const asked = await spendThenRetry(() => new Response('<!DOCTYPE html>1101', {
            status: 500, headers: { 'content-type': 'text/html' }
        }));
        expect(asked[0]).toBe('first-primary');
        expect(asked[1]).toBe('first-primary');
    });

    // The debt is a debt, not a latch: an answer that WAS usable pays it off.
    it('is settled by a read that actually came back', async () => {
        const net = await load();
        stubFetch((url) => {
            if (String(url).includes('/api/board/post')) return jsonRes({ success: true, id: 7 });
            return jsonRes({ success: true, posts: [] });
        });
        await net.board('post', { method: 'POST', body: { body: 'hi' } });
        await net.board('list', {});
        await net.board('list', {});
        const asked = bookmarks();
        expect(asked[0]).toBe('first-primary');
        expect(asked[1]).not.toBe('first-primary');
    });
});

// ---------------------------------------------------------------------------
// THE SSRF HOST CHECK HAD A BRANCH THAT COULD NEVER FIRE.
//
// A remote image URL is chosen by whoever posted the message, and fetching one
// happens in the main process — no CORS, no sandbox, on this machine's network
// — so isPrivateHost decides whether a message can reach the router, a
// loopback service, or anything else only this machine can see.
//
// It is only ever asked about a `new URL(...).hostname`, and the WHATWG
// serializer writes IPv6 as hex pieces: `[::ffff:127.0.0.1]` arrives as
// `[::ffff:7f00:1]`. The branch written for "::ffff:127.0.0.1 and friends"
// matched a trailing dotted quad, which that string does not contain — so the
// whole IPv4-mapped range walked past the check.
//
// Read out of the source and executed, rather than asserted as text: the defect
// was that the code looked right, so only running it proves anything. main.js
// itself cannot be required — it reaches for a real Electron app at module
// scope — which is why this takes the slice it needs.
describe('the private-host check, on the addresses the URL parser actually produces', () => {
    let isPrivateHost;

    beforeEach(() => {
        const src = fs.readFileSync(path.join(MAIN, 'main.js'), 'utf8').replace(/\r\n/g, '\n');
        const from = src.indexOf('const PRIVATE_V4');
        const to = src.indexOf('function boardOrigin');
        expect(from, 'PRIVATE_V4 is where this expects it').toBeGreaterThan(-1);
        expect(to, 'boardOrigin still follows isPrivateHost').toBeGreaterThan(from);
        // eslint-disable-next-line no-new-func
        isPrivateHost = new Function(src.slice(from, to) + '\nreturn isPrivateHost;')();
    });

    const host = (u) => new URL(u).hostname;

    it('refuses IPv4-mapped loopback and private ranges', () => {
        expect(isPrivateHost(host('https://[::ffff:127.0.0.1]/a.png'))).toBe(true);
        expect(isPrivateHost(host('https://[::ffff:192.168.1.1]/a.png'))).toBe(true);
        expect(isPrivateHost(host('https://[::ffff:10.0.0.5]/a.png'))).toBe(true);
        expect(isPrivateHost(host('https://[::ffff:169.254.169.254]/a.png'))).toBe(true);
        expect(isPrivateHost(host('https://[::ffff:100.64.0.1]/a.png'))).toBe(true);
    });

    it('refuses the IPv4-compatible and SIIT spellings of the same address', () => {
        expect(isPrivateHost(host('https://[::127.0.0.1]/a.png'))).toBe(true);
        expect(isPrivateHost(host('https://[::ffff:0:127.0.0.1]/a.png'))).toBe(true);
    });

    it('still refuses what it always did', () => {
        expect(isPrivateHost(host('http://127.0.0.1/a.png'))).toBe(true);
        expect(isPrivateHost(host('https://localhost/a.png'))).toBe(true);
        expect(isPrivateHost(host('https://[::1]/a.png'))).toBe(true);
        expect(isPrivateHost(host('https://[fc00::1]/a.png'))).toBe(true);
        expect(isPrivateHost(host('https://[fe80::1]/a.png'))).toBe(true);
    });

    // The other half: a guard that refuses everything is not a guard, it is an
    // outage. Ordinary public hosts, including IPv6 ones, still pass.
    it('lets public addresses through', () => {
        expect(isPrivateHost(host('https://example.com/a.png'))).toBe(false);
        expect(isPrivateHost(host('https://[2606:4700::6810:85e5]/a.png'))).toBe(false);
        expect(isPrivateHost(host('https://[::ffff:8.8.8.8]/a.png'))).toBe(false);
        expect(isPrivateHost(host('https://1.1.1.1/a.png'))).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// A LAUNCH SOMEBODY PERFORMED HAD NOWHERE TO BE DEFLECTED TO.
//
// Three things can put something on screen while the startup gate holds the
// app back, and on a login-item launch all three are off: the window is built
// hidden and revealed inside gateSettled.then(), the tray is created in
// startApp() behind the same await, and ensureSplash() returns immediately
// because splashWanted was decided from THIS process's argv (--openAsHidden).
//
// showWindow() records a second launch in showOnStart and then calls
// focusSplash(), which is a no-op with no splash to focus — so a double-click
// on the shortcut drew nothing at all, for up to five minutes with an installer
// download in flight. splashWanted describes the launch this process was
// started with and cannot answer for a later one, so the second launch forces
// the screen instead.
describe('a second launch while the startup gate is open', () => {
    let mainCode = '';
    beforeEach(() => {
        const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
        mainCode = strip(fs.readFileSync(path.join(MAIN, 'main.js'), 'utf8').replace(/\r\n/g, '\n'))
            .replace(/\s+/g, ' ');
    });

    const gateBranch = () => {
        const at = mainCode.indexOf('if (installing || updater.gateOpen())');
        expect(at, 'showWindow still deflects while the gate is open').toBeGreaterThan(-1);
        return mainCode.slice(at, mainCode.indexOf('return;', at));
    };

    it('builds the update screen rather than focusing one that was never made', () => {
        const branch = gateBranch();
        expect(branch).toMatch(/showOnStart = true/);
        expect(branch).toMatch(/ensureSplash\(true\)/);
    });

    it('and ensureSplash honours that force over the launch-kind flag', () => {
        expect(mainCode).toMatch(/function ensureSplash\(force\) \{ if \(!splashWanted && !force\) return;/);
    });
});
