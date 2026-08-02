// End-to-end: the things about these three features that only a real window can
// answer, because jsdom has no layout engine at all.
//
//   • THE LIVE-FORMATTING LAYER IS AN ALIGNMENT PROBLEM. #composer-mirror is
//     drawn under a textarea painted transparent, so if the two typeset the
//     same string even slightly differently the caret stops sitting beside the
//     glyph it belongs to. The unit tests can prove the characters match; only
//     this can prove they land in the same places.
//   • THE LAYOUT ZONES ARE A GRID PROBLEM. The unit tests assert the
//     attributes and the stylesheet; only this shows the columns actually move,
//     and that a named area invalid in some way has not quietly collapsed the
//     whole grid.
//   • THE CODE BLOCK'S GUTTER has to line up with the code beside it, which is
//     a question about two elements' line boxes.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');

function runningInstances() {
    if (process.platform !== 'win32') return 0;
    try {
        const out = execSync('tasklist /FI "IMAGENAME eq ScarmVoice.exe" /NH', { encoding: 'utf8' });
        return (out.match(/ScarmVoice\.exe/gi) || []).length;
    } catch (e) {
        return 0;
    }
}

let app, page, userDataDir;

// Typed the way a person types: through the real keyboard, so the field's own
// input handling runs rather than a value assignment nothing listens to.
async function typeInComposer(text) {
    await page.locator('#composer-input').click();
    await page.locator('#composer-input').fill('');
    await page.locator('#composer-input').fill(text);
    await page.waitForTimeout(120);
}

const box = (sel) => page.locator(sel).boundingBox();

test.beforeAll(async () => {
    const running = runningInstances();
    if (running > 0) {
        throw new Error(
            `ScarmVoice is already running (${running} process(es)). Close it first — a second ` +
            'instance fights over the uiohook keyboard hook and can hard-crash the running app.\n' +
            '  Stop-Process -Name ScarmVoice'
        );
    }

    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scarmvoice-format-'));
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
            if (p === 'list') {
                return {
                    success: true, hasMore: false, maxId: 1, typing: [], voice: [],
                    posts: [{
                        id: 1, name: 'Owner', client_id: 'owner', user_id: 1,
                        created_at: 1700000000000, reactions: [], pinned: 0,
                        body: '```javascript\nconst a = 1;\nconsole.info(a);\nreturn a;\n```'
                    }]
                };
            }
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

// ---------------------------------------------------------------------------

test('the formatting layer is typeset identically to the field over it', async () => {
    await typeInComposer('plain');
    const same = await page.evaluate(() => {
        const m = getComputedStyle(document.getElementById('composer-mirror'));
        const i = getComputedStyle(document.getElementById('composer-input'));
        const keys = ['fontFamily', 'fontSize', 'lineHeight', 'letterSpacing', 'wordSpacing',
            'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight',
            'whiteSpace', 'overflowWrap', 'wordBreak', 'textIndent', 'tabSize'];
        return keys.filter((k) => m[k] !== i[k]);
    });
    expect(same, 'these properties differ between the mirror and the field').toEqual([]);
});

test('it occupies exactly the box the field does', async () => {
    await typeInComposer('plain');
    const d = await page.evaluate(() => {
        const m = document.getElementById('composer-mirror').getBoundingClientRect();
        const i = document.getElementById('composer-input').getBoundingClientRect();
        return { x: Math.abs(m.left - i.left), y: Math.abs(m.top - i.top), w: Math.abs(m.width - i.width) };
    });
    expect(d.x).toBeLessThan(1.5);
    expect(d.y).toBeLessThan(1.5);
    expect(d.w).toBeLessThan(1.5);
});

// The real proof: a string long enough to wrap several times has to wrap at the
// SAME points in both, which is what equal scroll heights means at equal widths.
test('the same text wraps to the same height in both', async () => {
    const long = 'The quick brown fox jumps over the lazy dog, and then **turns around** ' +
        'and does it again while somebody writes *a very long sentence* about it, ' +
        'twice over, so that the box has to wrap at least three or four times.';
    await typeInComposer(long);
    const h = await page.evaluate(() => ({
        mirror: document.getElementById('composer-mirror').scrollHeight,
        input: document.getElementById('composer-input').scrollHeight
    }));
    // The mirror carries one deliberate extra newline so a final empty line has
    // somewhere to be, which is at most one line of slack.
    expect(Math.abs(h.mirror - h.input)).toBeLessThanOrEqual(
        await page.evaluate(() => parseFloat(getComputedStyle(document.getElementById('composer-input')).lineHeight)) + 1);
});

test('the field stops painting its own glyphs, but keeps its caret', async () => {
    await typeInComposer('hello');
    const c = await page.evaluate(() => {
        const s = getComputedStyle(document.getElementById('composer-input'));
        return { color: s.color, caret: s.caretColor };
    });
    expect(c.color).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    expect(c.caret).not.toMatch(/rgba\(0, 0, 0, 0\)/);
});

test('what it draws is actually formatted, not just marked up', async () => {
    await typeInComposer('a **bold** b *italic* c');
    const w = await page.evaluate(() => {
        const b = document.querySelector('#composer-mirror .cm-b');
        const i = document.querySelector('#composer-mirror .cm-i');
        return {
            bold: b && getComputedStyle(b).fontWeight,
            italic: i && getComputedStyle(i).fontStyle
        };
    });
    expect(Number(w.bold)).toBeGreaterThanOrEqual(700);
    expect(w.italic).toBe('italic');
});

// ---------------------------------------------------------------------------

test('the formatting bar opens above the field, not inside it', async () => {
    await page.locator('#btn-format').click();
    await page.waitForTimeout(200);
    const bar = await box('#format-bar');
    const row = await box('.composer-row');
    expect(bar).toBeTruthy();
    expect(bar.y + bar.height).toBeLessThanOrEqual(row.y + 1);
    await page.locator('#btn-format').click();
    await page.waitForTimeout(200);
});

test('the language menu opens on screen', async () => {
    await page.locator('#btn-format').click();
    await page.waitForTimeout(200);
    await page.locator('#btn-code-block').click();
    await page.waitForTimeout(200);
    const pop = await box('#lang-pop');
    const size = page.viewportSize() || await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    expect(pop).toBeTruthy();
    expect(pop.x).toBeGreaterThanOrEqual(0);
    expect(pop.y).toBeGreaterThanOrEqual(0);
    expect(pop.x + pop.width).toBeLessThanOrEqual(size.width + 1);
    expect(pop.y + pop.height).toBeLessThanOrEqual(size.height + 1);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    await page.locator('#btn-format').click();
    await page.waitForTimeout(200);
});

// ---------------------------------------------------------------------------

test('a code block numbers its lines, in step with the code', async () => {
    const gutter = page.locator('.msg-codeblock .cb-gutter').first();
    await expect(gutter).toHaveText('1\n2\n3');
    const metrics = await page.evaluate(() => {
        const g = document.querySelector('.msg-codeblock .cb-gutter');
        const c = document.querySelector('.msg-codeblock pre.msg-code code');
        const gs = getComputedStyle(g), cs = getComputedStyle(c);
        return {
            gLine: parseFloat(gs.lineHeight), cLine: parseFloat(cs.lineHeight),
            gSize: parseFloat(gs.fontSize), cSize: parseFloat(cs.fontSize),
            gTop: g.getBoundingClientRect().top + parseFloat(gs.paddingTop),
            cTop: c.getBoundingClientRect().top
        };
    });
    // Same line box, same size, same first baseline — the three things that make
    // number N sit beside line N.
    expect(Math.abs(metrics.gLine - metrics.cLine)).toBeLessThan(0.6);
    expect(Math.abs(metrics.gSize - metrics.cSize)).toBeLessThan(0.6);
    expect(Math.abs(metrics.gTop - metrics.cTop)).toBeLessThan(2);
});

test('it says what language it is in, and is still highlighted', async () => {
    await expect(page.locator('.msg-codeblock .cb-lang').first()).toHaveText('JavaScript');
    // hljs is lazy-loaded on first use; it has had the whole boot to arrive.
    await page.waitForTimeout(500);
    const spans = await page.locator('.msg-codeblock pre.msg-code code span').count();
    expect(spans).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------

test('swapping the columns actually moves them', async () => {
    const before = { side: await box('#sidebar'), main: await box('#main'), members: await box('#members-panel') };
    expect(before.side.x).toBeLessThan(before.main.x);
    expect(before.members.x).toBeGreaterThan(before.main.x);

    await page.evaluate(() => document.getElementById('app').dataset.panels = 'swapped');
    await page.waitForTimeout(200);

    const after = { side: await box('#sidebar'), main: await box('#main'), members: await box('#members-panel') };
    expect(after.side.x).toBeGreaterThan(after.main.x);
    expect(after.members.x).toBeLessThan(after.main.x);
    // Nothing collapsed: an invalid grid-template-areas is dropped whole, and
    // the symptom is a window with no columns rather than wrong ones.
    expect(after.side.width).toBeGreaterThan(100);
    expect(after.members.width).toBeGreaterThan(100);
    expect(after.main.width).toBeGreaterThan(300);

    await page.evaluate(() => document.getElementById('app').dataset.panels = 'default');
    await page.waitForTimeout(200);
});

test('the me bar becomes a full-width bar on top', async () => {
    await page.evaluate(() => document.getElementById('app').dataset.dock = 'top');
    await page.waitForTimeout(200);

    const dock = await box('#user-dock');
    const head = await box('#chan-head');
    const rail = await box('#rail');
    expect(dock.y + dock.height).toBeLessThanOrEqual(head.y + 1);
    expect(dock.y + dock.height).toBeLessThanOrEqual(rail.y + 1);
    expect(dock.width).toBeGreaterThan(rail.width * 3);
    // The header keeps its own height rather than stretching to the dock's,
    // which is why the dock gets a row of its own instead of sharing one.
    expect(Math.round(head.height)).toBe(48);

    await page.evaluate(() => document.getElementById('app').dataset.dock = 'bottom');
    await page.waitForTimeout(200);
});

test('the message box moves above the messages', async () => {
    const below = { composer: await box('#composer'), messages: await box('#messages-wrap') };
    expect(below.composer.y).toBeGreaterThan(below.messages.y);

    await page.evaluate(() => document.getElementById('app').dataset.input = 'top');
    await page.waitForTimeout(200);

    const above = { composer: await box('#composer'), messages: await box('#messages-wrap') };
    expect(above.composer.y).toBeLessThan(above.messages.y);

    await page.evaluate(() => document.getElementById('app').dataset.input = 'bottom');
    await page.waitForTimeout(200);
});
