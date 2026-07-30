// End-to-end: the spellchecker, in a real Electron process.
//
// test/spellcheck-menu.test.js covers the menu the renderer builds from what main
// sends it. Everything BELOW that is invisible to jsdom and is exactly where this
// feature can silently fail:
//
//   • whether main's `context-menu` event fires at all. It does not when the
//     renderer cancels the DOM contextmenu event — a cancelled event stops Blink
//     asking the browser process for a menu — and that is why the app underlined
//     misspellings for its whole life without ever being able to offer a
//     correction. If someone re-adds a preventDefault() to a text field, the
//     feature dies with no error anywhere; only this catches it.
//   • whether the spellchecker is actually running and flags a real typo. That
//     depends on webPreferences.spellcheck, on the session's languages, and on the
//     platform having a dictionary — none of which a stub can tell you about.
//   • whether replaceMisspelling edits the textarea the app is showing, and does
//     it as a real edit (an `input` event, so autosize and the send button react).
//
// Runs against the dev tree (`electron .`) for the same reason app.spec.js does:
// the packaged build has the node-cli-inspect fuse off and Playwright cannot
// attach to it.
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

let app;
let page;
let userDataDir;

// The composer lives behind the sign-in gate, and signing in needs the real
// server. Revealing the shell directly is enough: the spellchecker cares about a
// focused editable field, not about who is signed in.
async function revealComposer() {
    await page.evaluate(() => {
        document.getElementById('login').hidden = true;
        document.getElementById('app').hidden = false;
        const row = document.querySelector('.composer-row');
        if (row) row.style.display = '';
    });
}

// Where the middle of `word` sits inside the textarea, in page coordinates.
// Measured with the field's own computed font so it does not depend on the theme.
async function pointAtWord(word, before) {
    const ta = page.locator('#composer-input');
    const box = await ta.boundingBox();
    const m = await ta.evaluate((el, args) => {
        const cs = getComputedStyle(el);
        const ctx = document.createElement('canvas').getContext('2d');
        ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        return {
            pre: ctx.measureText(args.before).width,
            word: ctx.measureText(args.word).width,
            padLeft: parseFloat(cs.paddingLeft) || 0
        };
    }, { word, before });
    return { x: box.x + m.padLeft + m.pre + m.word / 2, y: box.y + box.height / 2 };
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

    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scarmvoice-spell-'));
    app = await electron.launch({ args: ['.', `--user-data-dir=${userDataDir}`], cwd: ROOT });
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    // Record every context-menu event main sees, so a spec can assert on what the
    // spellchecker reported as well as on what the menu did with it.
    await app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()[0];
        globalThis.__cm = [];
        w.webContents.on('context-menu', (_e, p) => {
            globalThis.__cm.push({
                isEditable: p.isEditable,
                misspelledWord: p.misspelledWord,
                suggestions: p.dictionarySuggestions,
                x: p.x, y: p.y
            });
        });
    });

    // Let boot finish before revealing the shell, or its own rewind to the
    // sign-in card undoes it a moment later.
    await page.waitForTimeout(2500);
    await revealComposer();
});

test.afterAll(async () => {
    if (app) await app.close();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
});

const lastEvent = () => app.evaluate(() => globalThis.__cm.at(-1) || null);
const clearEvents = () => app.evaluate(() => { globalThis.__cm.length = 0; });

test('the spellchecker is enabled with a language and needs no download', async () => {
    const info = await app.evaluate(({ BrowserWindow }) => {
        const s = BrowserWindow.getAllWindows()[0].webContents.session;
        return { enabled: s.isSpellCheckerEnabled(), languages: s.getSpellCheckerLanguages() };
    });
    expect(info.enabled).toBe(true);
    // Defaulted from the OS locale — deliberately NOT pinned to en-US, so a
    // non-English machine is checked in its own language.
    expect(info.languages.length).toBeGreaterThan(0);
});

test('the composer asks to be spellchecked', async () => {
    // A `spellcheck="false"` here would take the underline away with nothing else
    // failing, and the suggestions with it.
    expect(await page.locator('#composer-input').evaluate((el) => el.spellcheck)).toBe(true);
});

test('right-clicking a text field reaches the main process', async () => {
    // THE regression this file exists for. The renderer used to cancel this event
    // to draw its own menu, which stopped Blink asking for one at all — so main
    // never heard, and the spellchecker's answers were unreachable.
    await clearEvents();
    const ta = page.locator('#composer-input');
    await ta.click();
    await ta.fill('');
    await ta.type('hello there', { delay: 20 });

    const at = await pointAtWord('there', 'hello ');
    await page.mouse.click(at.x, at.y, { button: 'right' });
    await page.waitForTimeout(400);

    const ev = await lastEvent();
    expect(ev, 'main never saw the right-click — has a preventDefault come back?').toBeTruthy();
    expect(ev.isEditable).toBe(true);
    // Correctly spelled, so no spelling section — just the editing commands.
    expect(ev.misspelledWord).toBe('');
    expect(await page.locator('#ctx-menu').isVisible()).toBe(true);
    const labels = await page.locator('#ctx-menu .ctx-label').allTextContents();
    expect(labels).toEqual(['Cut', 'Copy', 'Paste', 'Select all']);
    await page.keyboard.press('Escape');
});

test('a misspelled word is flagged, and the menu offers the correction', async () => {
    await clearEvents();
    const ta = page.locator('#composer-input');
    await ta.click();
    await ta.fill('');
    // Typed rather than assigned: Chromium spellchecks as the field is edited.
    await ta.type('this is a mispelled word', { delay: 25 });
    await page.waitForTimeout(1500);

    const at = await pointAtWord('mispelled', 'this is a ');
    await page.mouse.click(at.x, at.y, { button: 'right' });
    await page.waitForTimeout(600);

    const ev = await lastEvent();
    expect(ev.misspelledWord).toBe('mispelled');
    expect(ev.suggestions).toContain('misspelled');
    // params.x/y are the click point in page coordinates — what the renderer
    // positions the menu with.
    expect(Math.abs(ev.x - at.x)).toBeLessThan(3);

    // The suggestion is at the top of the app's own menu, bold, above the
    // editing commands.
    const labels = await page.locator('#ctx-menu .ctx-label').allTextContents();
    expect(labels[0]).toBe('misspelled');
    expect(labels).toContain('Add to dictionary');
    expect(labels.indexOf('misspelled')).toBeLessThan(labels.indexOf('Cut'));
    expect(await page.locator('#ctx-menu .ctx-item.strong .ctx-label').first().textContent())
        .toBe('misspelled');
});

test('clicking the correction rewrites the word in the composer', async () => {
    // Continues from the menu the previous test left open — that is the real
    // sequence, and reopening it would only re-test the previous assertion.
    await page.evaluate(() => { globalThis.__inputs = 0;
        document.getElementById('composer-input')
            .addEventListener('input', () => { globalThis.__inputs++; }); });

    await page.locator('#ctx-menu .ctx-item.strong').first().click();
    await page.waitForTimeout(500);

    expect(await page.locator('#composer-input').inputValue()).toBe('this is a misspelled word');
    expect(await page.locator('#ctx-menu').isVisible()).toBe(false);
    // A real edit, not a value assignment: this is what makes autosize and the
    // send button update themselves, and what puts the change on the undo stack.
    expect(await page.evaluate(() => globalThis.__inputs)).toBeGreaterThan(0);
});

test('the correction can be undone', async () => {
    await page.locator('#composer-input').click();
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(300);
    // Back to the typo — replaceMisspelling went through the editing pipeline
    // rather than around it.
    expect(await page.locator('#composer-input').inputValue()).toContain('mispelled');
});

test('a word added to the dictionary stops being flagged', async () => {
    const ta = page.locator('#composer-input');
    await ta.click();
    await ta.fill('');
    await ta.type('scarmvoicetestword here', { delay: 25 });
    await page.waitForTimeout(1200);

    await clearEvents();
    let at = await pointAtWord('scarmvoicetestword', '');
    await page.mouse.click(at.x, at.y, { button: 'right' });
    await page.waitForTimeout(600);
    expect((await lastEvent()).misspelledWord).toBe('scarmvoicetestword');

    // Take the app's own "Add to dictionary" path, not the session API directly,
    // so the IPC handler and its validation are what gets exercised.
    const addTo = page.locator('#ctx-menu .ctx-item', { hasText: 'Add to dictionary' });
    await addTo.click();
    await page.waitForTimeout(800);

    const words = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.session.listWordsInSpellCheckerDictionary());
    expect(words).toContain('scarmvoicetestword');

    // …and it is no longer reported as a misspelling. Retyped so the field is
    // re-checked against the dictionary it has just learned.
    await ta.click();
    await ta.fill('');
    await ta.type('scarmvoicetestword here', { delay: 25 });
    await page.waitForTimeout(1500);
    await clearEvents();
    at = await pointAtWord('scarmvoicetestword', '');
    await page.mouse.click(at.x, at.y, { button: 'right' });
    await page.waitForTimeout(600);
    expect((await lastEvent()).misspelledWord).toBe('');

    // Leave the profile as we found it — this dictionary is the user's on a real
    // machine, and the e2e profile is temporary but the OS list is not.
    await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.session
            .removeWordFromSpellCheckerDictionary('scarmvoicetestword'));
});

test('the dictionary refuses something that is not a word', async () => {
    const results = await page.evaluate(async () => ({
        empty: await window.lounge.edit.addToDictionary(''),
        spaced: await window.lounge.edit.addToDictionary('two words'),
        huge: await window.lounge.edit.addToDictionary('x'.repeat(200))
    }));
    expect(results).toEqual({ empty: false, spaced: false, huge: false });
});
