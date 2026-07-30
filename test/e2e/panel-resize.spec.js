// End-to-end: the resizable side panels, dragged with real pointer events in a
// real Electron window.
//
// test/panel-resize.test.js covers the arithmetic in jsdom, which has no layout at
// all — it can only assert the CSS custom property the grid reads. What only this
// can show is that the property actually MOVES THE COLUMNS, that the message area
// keeps the width the clamp promises it, and that the handle is reachable with a
// mouse where the panel edge actually is.
//
// The app is booted SIGNED IN by stubbing three IPC handlers in main and reloading:
// the resizing is initialised inside enterApp(), so a shell revealed by unhiding
// #app in the DOM has the markup and none of the wiring — which is exactly the
// mistake that made an earlier version of this look broken.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');

// Mirrors app.js. The message column's guaranteed width is the promise being tested.
const MAIN_MIN = 420;
const SIDEBAR_MIN = 180;

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

const widths = () => page.evaluate(() => {
    const box = (id) => Math.round(document.getElementById(id).getBoundingClientRect().width);
    return { sidebar: box('sidebar'), members: box('members-panel'), main: box('main') };
});

// These tests share ONE app instance, so a width left behind by an earlier drag
// changes what the next one is allowed to do — the dynamic clamp reads the opposite
// panel's width. Every test that measures a delta resets first.
async function resetPanels() {
    for (const id of ['sidebar-resize', 'members-resize']) {
        const b = await page.locator('#' + id).boundingBox();
        await page.mouse.dblclick(b.x + b.width / 2, b.y + b.height / 2);
        await page.waitForTimeout(120);
    }
    await page.mouse.move(700, 400);      // park the pointer off both handles
}

async function dragHandle(id, dx) {
    const h = page.locator('#' + id);
    const b = await h.boundingBox();
    const y = b.y + b.height / 2;
    await page.mouse.move(b.x + b.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + dx, y, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(150);
}

test.beforeAll(async () => {
    const running = runningInstances();
    if (running > 0) {
        throw new Error(
            `ScarmVoice is already running (${running} process(es)). Close it first — a second ` +
            'instance fights over the uiohook keyboard hook and can hard-crash the running app.\n' +
            '  Stop-Process -Name ScarmVoice'
        );
    }

    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scarmvoice-panes-'));
    app = await electron.launch({ args: ['.', `--user-data-dir=${userDataDir}`], cwd: ROOT });
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    await app.evaluate(({ ipcMain }) => {
        for (const ch of ['auth:status', 'account:me', 'board:call']) {
            try { ipcMain.removeHandler(ch); } catch (e) { /* not registered yet */ }
        }
        ipcMain.handle('auth:status', () => ({ authed: true }));
        ipcMain.handle('account:me', () => ({
            success: true, user: { id: 1, username: 'Owner', role: 'owner' }
        }));
        ipcMain.handle('board:call', (_e, arg) => {
            const p = arg && arg.path;
            if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
            if (p === 'list') return { success: true, posts: [], typing: [], voice: [], hasMore: false, maxId: 0 };
            if (p === 'presence') return { success: true, members: [] };
            if (p === 'dm/threads') return { success: true, threads: [] };
            if (p === 'account/users') return { success: true, users: [{ id: 1, username: 'Owner', role: 'owner' }] };
            return { success: true };
        });
    });
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
});

test.afterAll(async () => {
    if (app) await app.close();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
});

test('both handles are where the panel edges are, and say they resize', async () => {
    for (const [handle, panel, edge] of [
        ['#sidebar-resize', '#sidebar', 'right'],
        ['#members-resize', '#members-panel', 'left']
    ]) {
        const hb = await page.locator(handle).boundingBox();
        const pb = await page.locator(panel).boundingBox();
        expect(hb, handle).toBeTruthy();
        // Straddling the edge is what makes it findable with a mouse.
        const edgeX = edge === 'right' ? pb.x + pb.width : pb.x;
        expect(Math.abs(hb.x + hb.width / 2 - edgeX)).toBeLessThan(2);
        // Full height, and a resize cursor.
        expect(Math.round(hb.height)).toBe(Math.round(pb.height));
        expect(await page.locator(handle).evaluate((el) => getComputedStyle(el).cursor)).toBe('col-resize');
    }
});

test('the indicator appears on hover and is invisible at rest', async () => {
    const h = page.locator('#sidebar-resize');
    const opacity = () => h.evaluate((el) => getComputedStyle(el, '::after').opacity);

    // Park the pointer well away from the handle first.
    await page.mouse.move(700, 400);
    await page.waitForTimeout(250);
    expect(Number(await opacity())).toBe(0);

    const b = await h.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.waitForTimeout(250);
    expect(Number(await opacity())).toBe(1);
});

test('dragging the channel list actually moves the columns', async () => {
    await resetPanels();
    const before = await widths();
    await dragHandle('sidebar-resize', 100);
    const after = await widths();

    expect(after.sidebar).toBe(before.sidebar + 100);
    // The message column gave up exactly what the sidebar took — nothing else moved.
    expect(after.members).toBe(before.members);
    expect(after.main).toBe(before.main - 100);
});

test('dragging the member list moves them the other way', async () => {
    await resetPanels();
    const before = await widths();
    await dragHandle('members-resize', -60);        // its handle faces the messages
    const after = await widths();

    expect(after.members).toBe(before.members + 60);
    expect(after.sidebar).toBe(before.sidebar);
    expect(after.main).toBe(before.main - 60);
});

test('neither panel can be dragged over the message area', async () => {
    await resetPanels();
    await dragHandle('sidebar-resize', 2000);
    let w = await widths();
    expect(w.main).toBeGreaterThanOrEqual(MAIN_MIN);

    await dragHandle('members-resize', -2000);
    w = await widths();
    expect(w.main).toBeGreaterThanOrEqual(MAIN_MIN);
    // Still a usable app rather than one column crushed to nothing.
    expect(w.sidebar).toBeGreaterThanOrEqual(SIDEBAR_MIN);
});

test('neither can be dragged away to nothing', async () => {
    await resetPanels();
    await dragHandle('sidebar-resize', -2000);
    const w = await widths();
    expect(w.sidebar).toBe(SIDEBAR_MIN);
});

test('resizing is horizontal only', async () => {
    await resetPanels();
    const before = await widths();
    const heights = await page.evaluate(() => ({
        sidebar: Math.round(document.getElementById('sidebar').getBoundingClientRect().height),
        members: Math.round(document.getElementById('members-panel').getBoundingClientRect().height)
    }));

    const h = page.locator('#sidebar-resize');
    const b = await h.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + 100);
    await page.mouse.down();
    // Straight down. Nothing may happen at all.
    await page.mouse.move(b.x + b.width / 2, b.y + 500, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(150);

    expect(await widths()).toEqual(before);
    expect(await page.evaluate(() => ({
        sidebar: Math.round(document.getElementById('sidebar').getBoundingClientRect().height),
        members: Math.round(document.getElementById('members-panel').getBoundingClientRect().height)
    }))).toEqual(heights);
});

test('double-clicking a handle restores the default', async () => {
    await resetPanels();
    await dragHandle('sidebar-resize', 90);
    expect((await widths()).sidebar).not.toBe(300);

    const b = await page.locator('#sidebar-resize').boundingBox();
    await page.mouse.dblclick(b.x + b.width / 2, b.y + b.height / 2);
    await page.waitForTimeout(200);
    expect((await widths()).sidebar).toBe(300);
});

test('the width survives a restart', async () => {
    await resetPanels();
    await dragHandle('sidebar-resize', 70);
    await dragHandle('members-resize', -40);
    const set = await widths();
    // Written through to settings.json at the end of the drag.
    const saved = await page.evaluate(async () => {
        const s = await window.lounge.settings.get();
        return { sidebarWidth: s.sidebarWidth, membersWidth: s.membersWidth };
    });
    expect(saved.sidebarWidth).toBe(set.sidebar);
    expect(saved.membersWidth).toBe(set.members);

    // A reload is the renderer's restart: the widths come back off disk before the
    // first paint rather than snapping from the stylesheet's defaults.
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
    expect(await widths()).toEqual(set);
});
