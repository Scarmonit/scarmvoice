// A `position: fixed` panel must resolve against the VIEWPORT, whatever the
// Accessibility pane is set to.
//
// This is a layout fact and nothing but a real browser can answer it, which is
// why it lives here rather than in the jsdom suite: jsdom does no layout at all,
// so every rect in it is zero and the bug this guards was invisible to 1,100
// unit tests.
//
// The bug: Accessibility → Saturation applies a CSS filter, and a filter makes
// an element the containing block for its `position: fixed` descendants. Four
// panels — the account panel over your name, the two audio panels behind the
// me-bar's carets, and the connection details over the voice panel — were
// children of #app, which is one of the filtered surfaces. All four are placed
// from getBoundingClientRect(), which is viewport-relative, so with the slider
// anywhere below 100% they were drawn one title bar (31px) lower than asked —
// and they open UPWARD out of the bottom bar, so they came down over the very
// control that opened them. With the update pill showing it was worse again.
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

// Every panel in the app that is placed from a viewport rect. If one is added
// later it belongs here, and it belongs outside any filtered surface.
const PANELS = ['me-popover', 'mic-pop', 'spk-pop', 'conn-pop'];

let app;
let page;
let userDataDir;

test.beforeAll(async () => {
    if (runningInstances() > 0) {
        throw new Error('ScarmVoice is already running — close it first (Stop-Process -Name ScarmVoice).');
    }
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scarmvoice-fixed-'));
    app = await electron.launch({ args: ['.', `--user-data-dir=${userDataDir}`], cwd: ROOT });
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
    if (app) await app.close();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
});

// Pin each panel at a known viewport coordinate and read back where it landed.
// The offset between the two is the whole question.
async function measure(desaturated) {
    return page.evaluate(({ ids, desat }) => {
        const root = document.documentElement;
        root.style.setProperty('--sat', '0.4');
        root.style.setProperty('--unsat', '2.5');
        root.classList.toggle('desat', desat);
        // These panels slide in, and a transform moves the rendered rect. This
        // is the app's own reduced-motion switch — the one Accessibility sets —
        // so it measures the resting position rather than a frame of the
        // entrance.
        root.classList.add('no-motion');
        // #app is hidden on a fresh profile (the sign-in card is up), and a
        // hidden ancestor would make every rect zero.
        document.getElementById('app').hidden = false;

        const out = {};
        ids.forEach((id) => {
            const el = document.getElementById(id);
            const was = el.hidden;
            el.hidden = false;
            el.style.top = '200px';
            el.style.left = '120px';
            const r = el.getBoundingClientRect();
            out[id] = { top: Math.round(r.top), left: Math.round(r.left) };
            el.hidden = was;
            el.style.top = '';
            el.style.left = '';
        });
        root.classList.remove('desat');
        root.classList.remove('no-motion');
        document.getElementById('app').hidden = true;
        return out;
    }, { ids: PANELS, desat: desaturated });
}

test('the floating panels sit where they are put, with saturation off', async () => {
    const at = await measure(false);
    for (const id of PANELS) {
        expect(at[id], id).toEqual({ top: 200, left: 120 });
    }
});

test('…and still do with saturation turned down', async () => {
    // The filter really is on, or this proves nothing.
    const filtered = await page.evaluate(() => {
        document.documentElement.style.setProperty('--sat', '0.4');
        document.documentElement.classList.add('desat');
        const f = getComputedStyle(document.getElementById('app')).filter;
        document.documentElement.classList.remove('desat');
        return f;
    });
    expect(filtered).toContain('saturate');

    const plain = await measure(false);
    const desat = await measure(true);
    for (const id of PANELS) {
        // Both the absolute answer and the comparison: one says the coordinate
        // is honoured, the other says the setting is what did or did not move it.
        expect(desat[id], id).toEqual({ top: 200, left: 120 });
        expect(desat[id], id).toEqual(plain[id]);
    }
});

test('nothing placed from a viewport rect is left inside a filtered surface', async () => {
    // The structural version of the same claim, so a panel moved back under #app
    // fails here even if somebody has changed how it is positioned.
    const inside = await page.evaluate((ids) => ids.filter((id) => {
        const el = document.getElementById(id);
        return !!(el && el.closest('#app'));
    }), PANELS);
    expect(inside).toEqual([]);
});
