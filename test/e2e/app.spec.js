// End-to-end: launch the real app and check the things that only exist inside a
// running Electron process.
//
// These cover the "silently does nothing" class of bug, which no unit test can
// reach because it lives in main.js's window/session wiring:
//   • a missing entry in the permission ALLOWED set makes the promise HANG,
//     not reject — that's why the Fullscreen button appeared dead
//   • a will-navigate guard that allows file:// makes drag-and-drop replace the
//     whole UI with the dropped file
//   • a typo'd IPC channel fails only when someone clicks that one button
//
// Runs against the dev tree (`electron .`), never the packaged build: the
// shipped binary has the EnableNodeCliInspectArguments fuse disabled, and
// Playwright needs it to attach.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');

// Launching a second copy while the installed app is open makes the two fight
// over the user-data cache lock and the system-wide uiohook keyboard hook, which
// hard-crashes the running one. Refuse rather than take out someone's live call.
function runningInstances() {
    if (process.platform !== 'win32') return 0;
    try {
        const out = execSync('tasklist /FI "IMAGENAME eq ScarmVoice.exe" /NH', { encoding: 'utf8' });
        return (out.match(/ScarmVoice\.exe/gi) || []).length;
    } catch (e) {
        return 0;
    }
}

let app;
let page;
let userDataDir;
const pageErrors = [];

test.beforeAll(async () => {
    const running = runningInstances();
    if (running > 0) {
        throw new Error(
            `ScarmVoice is already running (${running} process(es)). Close it first — a second ` +
            'instance fights over the uiohook keyboard hook and can hard-crash the running app.\n' +
            '  Stop-Process -Name ScarmVoice'
        );
    }

    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scarmvoice-e2e-'));
    app = await electron.launch({
        args: ['.', `--user-data-dir=${userDataDir}`],
        cwd: ROOT
    });

    // Nothing here may open a real browser window or an Explorer window.
    await app.evaluate(({ shell }) => {
        globalThis.__openedExternally = [];
        shell.openExternal = async (url) => { globalThis.__openedExternally.push(url); };
        shell.showItemInFolder = () => {};
    });

    page = await app.firstWindow();
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
    if (app) await app.close();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
});

test('launches and shows the sign-in screen on a fresh profile', async () => {
    await expect(page.locator('#login')).toBeVisible();
    await expect(page.locator('#login-pw')).toBeVisible();
    await expect(page.locator('#login-btn')).toBeVisible();

    await page.screenshot({ path: path.join(ROOT, 'test-results', 'launch.png') });
});

test('exposes the whole preload bridge to the renderer', async () => {
    const shape = await page.evaluate(() => {
        const l = window.lounge;
        if (!l) return null;
        const out = {};
        for (const key of Object.keys(l)) {
            out[key] = typeof l[key] === 'function' ? 'fn' : Object.keys(l[key]).sort();
        }
        return out;
    });

    expect(shape).toBeTruthy();
    expect(Object.keys(shape).sort()).toEqual([
        'app', 'auth', 'board', 'copyImage', 'downloadAttachment', 'edit', 'fetchImage',
        'fileUrl', 'ptt', 'revealFile', 'rt', 'saveAttachment', 'settings', 'share',
        'startup', 'unfurl', 'update', 'uploadFile', 'voiceToken', 'win', 'youtube'
    ]);

    expect(shape.auth).toEqual(['login', 'logout', 'status']);
    expect(shape.settings).toEqual(['get', 'set']);
    expect(shape.rt).toEqual([
        'notifyPosted', 'onMessage', 'onStatus', 'send', 'sendTyping', 'sendVoice',
        'start', 'stop', 'wake'
    ]);
    expect(shape.update).toEqual(['check', 'download', 'getState', 'install', 'onState', 'setAuto']);
});

test('round-trips a real IPC call', async () => {
    // Proves the channel is registered, the handler runs, and the result
    // survives structured cloning back to the renderer.
    const settings = await page.evaluate(() => window.lounge.settings.get());

    expect(settings.baseUrl).toBe('https://scarmonit.com');
    expect(settings.clientId).toMatch(/^c/);
    expect(settings.room).toBe('lounge');
});

test('keeps the renderer free of Node and the session cookie', async () => {
    const leaks = await page.evaluate(() => ({
        require: typeof window.require,
        process: typeof window.process,
        ipcRenderer: typeof window.ipcRenderer,
        bridgeHasCookie: JSON.stringify(window.lounge).includes('sb_auth')
    }));

    expect(leaks.require).toBe('undefined');
    expect(leaks.process).toBe('undefined');
    expect(leaks.ipcRenderer).toBe('undefined');
    expect(leaks.bridgeHasCookie).toBe(false);
});

test('grants the fullscreen permission instead of hanging', async () => {
    // The original bug: 'fullscreen' was missing from main.js's ALLOWED set, so
    // requestFullscreen() never resolved OR rejected. A .catch() could not see
    // it and the button looked dead. HUNG here means that regressed.
    await page.evaluate(() => {
        window.__fs = 'PENDING';
        document.addEventListener('click', () => {
            const hung = setTimeout(() => { window.__fs = 'HUNG'; }, 3000);
            document.documentElement.requestFullscreen()
                .then(() => { clearTimeout(hung); window.__fs = 'OK'; })
                .catch((e) => { clearTimeout(hung); window.__fs = 'REJECTED: ' + e.message; });
        }, { once: true, capture: true });
    });

    await page.mouse.click(5, 5);            // requestFullscreen needs a user gesture

    await expect
        .poll(() => page.evaluate(() => window.__fs), { timeout: 10000 })
        .toBe('OK');

    await page.evaluate(() => document.exitFullscreen().catch(() => {}));
});

test('denies a permission that is not on the allow list', async () => {
    const state = await page.evaluate(async () => {
        try {
            const r = await navigator.permissions.query({ name: 'geolocation' });
            return r.state;
        } catch (e) {
            return 'query-unsupported';
        }
    });

    expect(['denied', 'query-unsupported']).toContain(state);
});

test('blocks file:// navigation so a dropped file cannot replace the UI', async () => {
    const before = page.url();

    await page.evaluate(() => { window.location.href = 'file:///C:/Windows/win.ini'; });
    await page.waitForTimeout(500);

    expect(page.url()).toBe(before);

    // Asked of the main process, not via a locator: a preventDefault-ed
    // navigation leaves Playwright's frame marked "navigating", so locator
    // queries block for their full timeout even though nothing moved.
    const state = await app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()[0];
        return { url: w.webContents.getURL(), title: w.webContents.getTitle() };
    });

    expect(state.url).toMatch(/index\.html$/);
    expect(state.url).not.toMatch(/win\.ini/);

    // ...and the UI itself is still mounted, not replaced by the dropped file.
    const stillMounted = await page.evaluate(() => !!document.getElementById('login'));
    expect(stillMounted).toBe(true);
});

test('sends external links to the OS browser, not the app window', async () => {
    const before = page.url();

    await page.evaluate(() => { window.location.href = 'https://example.com/'; });
    await page.waitForTimeout(500);

    expect(page.url()).toBe(before);
    const opened = await app.evaluate(() => globalThis.__openedExternally);
    expect(opened).toContain('https://example.com/');
});

test('registers the lounge:// attachment protocol', async () => {
    // Probed from the main process: the renderer's CSP allows lounge: in
    // img-src but not connect-src, so a renderer fetch would be blocked by CSP
    // rather than reaching the handler.
    const result = await app.evaluate(async ({ net }) => {
        const status = async (url) => {
            try { return (await net.fetch(url)).status; } catch (e) { return 'threw: ' + e.message; }
        };
        return {
            missingKey: await status('lounge://file/'),
            wrongHost: await status('lounge://bogus/whatever')
        };
    });

    expect(result.missingKey).toBe(400);
    expect(result.wrongHost).toBe(404);
});

test('starts up without an uncaught renderer exception', async () => {
    expect(pageErrors).toEqual([]);
});
