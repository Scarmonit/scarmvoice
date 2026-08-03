// @vitest-environment jsdom
//
// The formatting toolbar and the live-formatting layer under the caret.
//
// The design being pinned: this is a VIEW OVER MARKDOWN, not a rich-text
// editor. There is one document — the textarea — every button writes Markdown
// characters into it, and what is sent is the string in the box. So the tests
// that matter most are the boring ones:
//
//   • a button produces the exact syntax the message renderer already reads;
//   • the preview holds EXACTLY the characters in the field, because the
//     textarea is painted transparent on top of it and one character of drift
//     puts the caret beside the wrong glyph;
//   • the preview and the renderer share a parser, so what looks bold in the
//     box is bold in the message.
//
// jsdom has no execCommand, so every write here takes replaceRange's fallback
// path. That is deliberate — it is the path that has to keep working when the
// deprecated call finally goes away.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootRenderer, settle, type, $, composerInput, cmEditor } from './helpers/renderer.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The BUILT bundle, not the script that builds it: what matters is which
// languages are actually registered in the file the app loads. vendor/ is
// gitignored, so a fresh clone that has not run postinstall has nothing to
// compare against — skipped there, the same way the RNNoise worklet check is.
const HLJS = path.join(ROOT, 'src', 'renderer', 'vendor', 'hljs.js');
const vendored = fs.existsSync(HLJS);
const CSS = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'styles.css'), 'utf8');

const POST = {
    id: 7, body: 'hello', name: 'Alice', client_id: 'alice', user_id: 2,
    created_at: 1700000000000, reactions: [], pinned: 0
};

function router() {
    return vi.fn(async (p) => {
        if (p === 'list') return { success: true, posts: [POST], typing: [], voice: [], hasMore: false, maxId: 7 };
        if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
        if (p === 'presence') return { success: true, members: [] };
        if (p === 'dm/threads') return { success: true, threads: [] };
        return { success: true };
    });
}

const boot = (settings) => bootRenderer({ board: router(), settings });
const input = () => composerInput();
const cm = () => cmEditor();

// Put the caret where a person would have it, then press a toolbar button.
function select(start, end) {
    input().setSelectionRange(start, end === undefined ? start : end);
}
function click(fmt) {
    const btn = $('format-bar').querySelector('[data-fmt="' + fmt + '"]');
    btn.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
}
// Three of the old buttons live in menus now, the way the reference arranges
// them. These drive the menus rather than reaching past them.
function menuItem(label) {
    return [...$('fmt-menu').querySelectorAll('.fm-item')]
        .find((b) => b.querySelector('.fm-label').textContent === label);
}
function openMenu(id) {
    $(id).dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
}
function pickFromMore(label) {
    openMenu('btn-more');
    menuItem(label).click();
}
// The chords are the EDITOR'S KEYMAP, which is what it consults; jsdom's
// synthetic key events carry none of the codes CodeMirror maps from. Real
// keystrokes are checked in a browser instead.
function chord(name) {
    const fn = cm().getOption('extraKeys')[name];
    if (!fn) return 'unbound';
    return fn(cm());
}

async function withText(text, settings) {
    await boot(settings);
    await settle();
    $('btn-format').click();
    await settle();
    type(text);
    return input();
}

beforeEach(() => { localStorage.clear(); });

// ---------------------------------------------------------------------------

describe('the Format toggle', () => {
    it('is hidden until it is asked for, and remembers nothing by default', async () => {
        await boot({});
        await settle();
        expect($('format-bar').hidden).toBe(true);
        expect($('btn-format').getAttribute('aria-pressed')).toBe('false');
    });

    it('opens and closes', async () => {
        await boot({});
        await settle();
        $('btn-format').click();
        await settle();
        expect($('format-bar').hidden).toBe(false);
        expect($('btn-format').getAttribute('aria-pressed')).toBe('true');

        $('btn-format').click();
        await settle();
        expect($('format-bar').hidden).toBe(true);
    });

    it('starts open when that has been asked for', async () => {
        await boot({ formatBarOpen: true });
        await settle();
        expect($('format-bar').hidden).toBe(false);
    });

    it('opens on Ctrl+Shift+X, the way the reference does', async () => {
        await boot({});
        await settle();
        chord('Shift-Ctrl-X');
        await settle();
        expect($('format-bar').hidden).toBe(false);
    });
});

// v0.79.0 shipped without these rules: they sat beside the mirror layer the
// CodeMirror migration deleted and went with it. The menu is the last child of
// <body> and openFmtMenu() writes viewport coordinates into style.left/top, so
// with nothing making it a positioned overlay it became ordinary content — a
// full-width block in the bottom-left corner over the me bar, whose height
// pushed the sidebar, the message list and the composer up by its own 87px.
//
// jsdom has no layout, so what is pinned here is the stylesheet itself.
describe('the toolbar menu is a layer over the app, not a part of it', () => {
    const rule = (sel) => {
        const m = new RegExp('(^|\\})[^{}]*?\\' + sel + '\\s*\\{([^}]*)\\}', 'm').exec(CSS);
        return m ? m[2] : '';
    };

    it('is taken out of the flow, so opening it moves nothing', () => {
        const r = rule('.fmt-menu');
        expect(r).toMatch(/position:\s*fixed/);
        expect(r).toMatch(/z-index:\s*\d+/);
    });

    it('is drawn as a menu rather than as bare text on the page', () => {
        const r = rule('.fmt-menu');
        expect(r).toMatch(/background:/);
        expect(r).toMatch(/border(-radius)?:/);
    });

    // .fm-label and .fm-hint are ALSO the New Message modal's field label and
    // hint. Unscoped, that sheet's 16px bold heading styled every menu row and
    // stacked the shortcut underneath it.
    it('styles its own rows without borrowing the modal\'s', () => {
        expect(rule('.fm-item .fm-label')).toMatch(/font-size:\s*13px/);
        expect(rule('.fm-item .fm-hint')).toMatch(/font-size:\s*11px/);
    });

    it('still opens filled and hidden-when-closed', async () => {
        await withText('');
        openMenu('btn-more');
        await settle();
        expect($('fmt-menu').hidden).toBe(false);
        expect(menuItem('Link')).toBeTruthy();
        // Anything outside it closes it — the same listener the me bar sits under.
        document.body.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
        await settle();
        expect($('fmt-menu').hidden).toBe(true);
    });
});

describe('the marks a button writes', () => {
    it('wraps a selection in the syntax the renderer reads', async () => {
        const el = await withText('hello world');
        select(6, 11);
        click('bold');
        expect(el.value).toBe('hello **world**');
    });

    it('takes the mark off again', async () => {
        const el = await withText('hello **world**');
        select(8, 13);              // inside the stars
        click('bold');
        expect(el.value).toBe('hello world');
    });

    // The caret between the marks, so the next thing typed is the formatted
    // thing — a pair of stars with the caret after them is not the same offer.
    it('puts the caret between the marks with nothing selected', async () => {
        const el = await withText('');
        select(0);
        click('italic');
        expect(el.value).toBe('**');
        expect(el.selectionStart).toBe(1);
    });

    it('writes each of the marks on the bar itself', async () => {
        const cases = [
            ['bold', '**x**'], ['italic', '*x*'], ['underline', '__x__'],
            ['strike', '~~x~~'], ['code', '`x`']
        ];
        for (const [kind, want] of cases) {
            const el = await withText('x');
            select(0, 1);
            click(kind);
            expect(el.value, kind).toBe(want);
        }
        // Its own timeout: a whole renderer is booted per case, so this lands
        // near the 5s default and whether it passed depended on how loaded the
        // machine was rather than on anything about the marks.
    }, 20000);

    it('writes the ones that moved into More', async () => {
        const el = await withText('x');
        select(0, 1);
        pickFromMore('Spoiler');
        expect(el.value).toBe('||x||');
    });

    // Italic pressed inside **bold** used to see the inner star of each pair,
    // call it an italic wrapper and strip ONE star off each end — turning bold
    // into a stray asterisk.
    it('does not mistake one star of a bold pair for an italic', async () => {
        const el = await withText('**word**');
        select(2, 6);
        click('italic');
        expect(el.value).toBe('***word***');
    });

    it('makes a link and leaves the caret on the part still to be typed', async () => {
        const el = await withText('docs');
        select(0, 4);
        pickFromMore('Link');
        expect(el.value).toBe('[docs](url)');
        expect(el.value.slice(el.selectionStart, el.selectionEnd)).toBe('url');
    });

    it('turns a selected url into the target instead', async () => {
        const el = await withText('https://example.com');
        select(0, 19);
        pickFromMore('Link');
        expect(el.value).toBe('[](https://example.com)');
        expect(el.selectionStart).toBe(1);
    });
});

describe('the marks that belong to a line', () => {
    it('bullets every line the selection touches', async () => {
        const el = await withText('one\ntwo\nthree');
        select(1, 9);
        click('bullet');
        expect(el.value).toBe('- one\n- two\n- three');
    });

    it('numbers them, counting up', async () => {
        const el = await withText('one\ntwo\nthree');
        select(0, 13);
        click('number');
        expect(el.value).toBe('1. one\n2. two\n3. three');
    });

    it('takes the marker off again when every line already has it', async () => {
        const el = await withText('- one\n- two');
        select(0, 11);
        click('bullet');
        expect(el.value).toBe('one\ntwo');
    });

    // A mixed selection is somebody asking for all of it to become a list, not
    // for half of it to stop being one.
    it('completes a half-marked selection rather than clearing it', async () => {
        const el = await withText('- one\ntwo');
        select(0, 9);
        click('bullet');
        expect(el.value).toBe('- one\n- two');
    });

    it('replaces one line marker with another instead of stacking them', async () => {
        const el = await withText('- one');
        select(3);
        click('quote');
        expect(el.value).toBe('> one');
    });

    // The reference's font-size control. Markdown's three heading levels ARE its
    // type scale — there is no point size to offer — so this is what it means
    // here, and it is a menu rather than a cycle because a menu can say which
    // one you are already on.
    it('sets a heading level from the text size menu', async () => {
        const el = await withText('title');
        select(0);
        openMenu('btn-fontsize');
        menuItem('Heading 2').click();
        expect(el.value).toBe('## title');

        select(0);
        openMenu('btn-fontsize');
        menuItem('Heading 1').click();
        expect(el.value).toBe('# title');

        select(0);
        openMenu('btn-fontsize');
        menuItem('Normal text').click();
        expect(el.value).toBe('title');
    });

    it('says which level the caret is already on', async () => {
        await withText('## title');
        select(4);
        openMenu('btn-fontsize');
        expect(menuItem('Heading 2').classList.contains('on')).toBe(true);
        expect(menuItem('Normal text').classList.contains('on')).toBe(false);
    });

    it('keeps the indent it found', async () => {
        const el = await withText('    deep');
        select(6);
        click('bullet');
        expect(el.value).toBe('    - deep');
    });
});

describe('the keyboard chords', () => {
    it('binds the three every text box on this machine already uses', async () => {
        for (const [name, want] of [['Ctrl-B', '**x**'], ['Ctrl-I', '*x*'], ['Ctrl-U', '__x__']]) {
            const el = await withText('x');
            select(0, 1);
            chord(name);
            expect(el.value, name).toBe(want);
        }
    }, 20000);

    it('binds the list chords the reference uses', async () => {
        const el = await withText('one');
        select(0);
        chord('Shift-Ctrl-8');
        expect(el.value).toBe('- one');
        chord('Shift-Ctrl-7');
        expect(el.value).toBe('1. one');
        chord('Shift-Ctrl-9');
        expect(el.value).toBe('> one');
    });

    it('leaves an unmodified letter alone', async () => {
        await withText('x');
        await settle();
        // A bare letter is not bound at all — typing it is the editor's job.
        expect(chord('B')).toBe('unbound');
    });
});

describe('inserting a code block', () => {
    const items = () => [...$('lang-list').querySelectorAll('.lang-item')];

    async function openLangs() {
        openMenu('btn-more');
        menuItem('Code block').click();
        await settle();
    }

    it('offers the languages and writes the fence with the tag on it', async () => {
        const el = await withText('');
        await openLangs();
        expect($('lang-pop').hidden).toBe(false);

        $('lang-search').value = 'javascript';
        $('lang-search').dispatchEvent(new window.Event('input', { bubbles: true }));
        await settle();
        items()[0].click();
        await settle();

        expect(el.value).toBe('```javascript\n\n```');
        expect($('lang-pop').hidden).toBe(true);
    });

    it('finds a language by the name people actually type', async () => {
        await withText('');
        await openLangs();
        $('lang-search').value = 'py';
        $('lang-search').dispatchEvent(new window.Event('input', { bubbles: true }));
        await settle();
        expect(items()[0].textContent).toMatch(/Python/);
    });

    it('wraps a selection as the body of the block', async () => {
        const el = await withText('const a = 1;');
        select(0, 12);
        await openLangs();
        $('lang-search').value = 'javascript';
        $('lang-search').dispatchEvent(new window.Event('input', { bubbles: true }));
        await settle();
        items()[0].click();
        await settle();
        expect(el.value).toBe('```javascript\nconst a = 1;\n```');
    });

    // A fence only opens a block at the start of a line, so the newline is
    // syntax rather than tidiness — and is added only where it is missing.
    it('breaks the line first when the caret is mid-sentence', async () => {
        const el = await withText('look: ');
        select(6);
        await openLangs();
        $('lang-search').value = 'plain';
        $('lang-search').dispatchEvent(new window.Event('input', { bubbles: true }));
        await settle();
        items()[0].click();
        await settle();
        expect(el.value).toBe('look: \n```\n\n```');
    });

    it('closes on Escape without inserting anything', async () => {
        const el = await withText('untouched');
        await openLangs();
        $('lang-search').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        await settle();
        expect($('lang-pop').hidden).toBe(true);
        expect(el.value).toBe('untouched');
    });

    // A menu offering a language the bundle cannot highlight silently produces
    // plain monospace, which looks like the feature not working.
    it.skipIf(!vendored)('offers only languages the vendored highlighter registers', async () => {
        await withText('');
        await openLangs();
        const bundle = fs.readFileSync(HLJS, 'utf8');
        const registered = new Set(
            (bundle.match(/registerLanguage\(["']([\w+#._-]+)["']/g) || [])
                .map((s) => /["']([\w+#._-]+)["']/.exec(s)[1]));
        const tags = items().map((b) => (b.querySelector('.li-tag') || { textContent: '' }).textContent)
            .filter(Boolean);
        expect(tags.length).toBeGreaterThan(20);
        for (const tag of tags) expect(registered.has(tag), tag + ' is not vendored').toBe(true);
    });
});

// ---------------------------------------------------------------------------
// The live layer. Every one of these is really the same assertion: the mirror
// holds the same characters as the field.

// ---------------------------------------------------------------------------
// The message box is a CodeMirror document whose text IS the Markdown. What was
// once a decorative layer painted behind a textarea — and every caret bug that
// came with keeping two copies of the same string in step — is now the editor's
// own rendering of its own document. There is nothing left to drift.

describe('the message box is the editor', () => {
    it('holds the message as its document, character for character', async () => {
        await boot({});
        await settle();
        for (const s of [
            '', 'plain text', '**bold** and *italic*', '```js\nconst a = 1;\n```',
            '# heading\n> quote\n- item', 'a_b_c snake_case_name', '<script>alert(1)</script>'
        ]) {
            type(s);
            expect(cm().getValue(), JSON.stringify(s)).toBe(s);
            expect(input().value, JSON.stringify(s)).toBe(s);
        }
    });

    it('reads Markdown, so the formatting is the mode’s and not a second parser', async () => {
        await boot({});
        await settle();
        const mode = cm().getOption('mode');
        expect(mode.name).toBe('markdown');
        expect(mode.fencedCodeBlockHighlighting).toBe(true);
    });

    // Turning the drawing off leaves the same document — the message is the
    // same string either way, which is the point of Markdown being the format.
    it('drops to plain text when the setting says so, without touching the text', async () => {
        await boot({});
        await settle();
        type('**bold**');
        $('btn-settings').click();
        await settle();
        $('set-rich-composer').click();
        await settle();
        expect(cm().getOption('mode')).toBe(null);
        expect(input().value).toBe('**bold**');
    });

    it('never leaves a second copy of the text anywhere', async () => {
        await boot({});
        await settle();
        type('anything');
        expect($('composer-mirror')).toBe(null);
        expect($('composer-chrome')).toBe(null);
    });
});

describe('a code block while it is being written', () => {
    // Read off the MARKS, not the document. A replacedWith widget only enters
    // the DOM when CodeMirror renders the line it is on, and jsdom lays nothing
    // out, so nothing is ever rendered here — but the mark and its node exist
    // either way, and they are what the app actually builds. The rendered
    // article is checked in a browser.
    const chips = () => cm().getAllMarks()
        .map((m) => m.replacedWith)
        .filter((n) => n && n.classList && n.classList.contains('cb-chip'));
    const chipLang = () => {
        const n = chips()[0];
        return n ? n.querySelector('.cb-chip-lang span').textContent : null;
    };
    const panelLines = () => {
        let n = 0;
        for (let i = cm().firstLine(); i <= cm().lastLine(); i++) {
            const cls = cm().lineInfo(i).wrapClass || '';
            if (/cb-(open|body|close)/.test(cls)) n++;
        }
        return n;
    };

    it('titles the block with its language', async () => {
        await withText('```js\nconst a = 1;\n```');
        await settle();
        expect(chipLang()).toBe('JavaScript');
        expect(panelLines()).toBe(3);
    });

    it('gives each block in a message its own title', async () => {
        await withText('```js\na\n```\ntext\n```python\nb\n```');
        await settle();
        expect(chips().map((n) => n.querySelector('.cb-chip-lang span').textContent))
            .toEqual(['JavaScript', 'Python']);
    });

    it('titles an unclosed fence too, because it is still a block', async () => {
        await withText('```rust\nfn main() {');
        await settle();
        expect(chipLang()).toBe('Rust');
    });

    it('changes the language from the chip, rewriting the fence', async () => {
        const el = await withText('```js\nconst a = 1;\n```');
        await settle();
        chips()[0].querySelector('.cb-chip-lang').click();
        await settle();
        $('lang-search').value = 'python';
        $('lang-search').dispatchEvent(new window.Event('input', { bubbles: true }));
        await settle();
        $('lang-list').querySelector('.lang-item').click();
        await settle();
        expect(el.value).toBe('```python\nconst a = 1;\n```');
    });

    it('offers the block its own menu', async () => {
        const el = await withText('```js\nconst a = 1;\n```');
        await settle();
        chips()[0].querySelector('.cb-chip-more').click();
        await settle();
        expect([...$('fmt-menu').querySelectorAll('.fm-label')].map((l) => l.textContent))
            .toEqual(['Change language', 'Copy code', 'Remove code block']);
        menuItem('Remove code block').click();
        await settle();
        expect(el.value).toBe('const a = 1;');
    });

    // The gutter numbers CODE, not the message, so a block always starts at 1
    // and the prose around it is not numbered at all.
    it('numbers the code and only the code', async () => {
        await withText('before\n```js\none\ntwo\n```\nafter');
        await settle();
        const fmt = cm().getOption('lineNumberFormatter');
        expect([0, 1, 2, 3, 4, 5].map((i) => fmt(i + 1))).toEqual(['', '', '1', '2', '', '']);
        expect(cm().getOption('lineNumbers')).toBe(true);
    });

    it('takes the gutter away when there is no code', async () => {
        await withText('just a sentence');
        await settle();
        expect(cm().getOption('lineNumbers')).toBe(false);
    });

    // CODE IS NOT PROSE. One field checks all of itself or none of itself, so
    // the whole box stops while the message holds a block.
    it('turns spellcheck off while there is code in the box', async () => {
        await boot({});
        await settle();
        expect(input().spellcheck).toBe(true);
        type('```js\nconst a = 1;\n```');
        await settle();
        expect(input().spellcheck).toBe(false);
        type('just a sentence');
        await settle();
        expect(input().spellcheck).toBe(true);
    });

    // The fence's own text is replaced by an ATOMIC mark. Atomic is what keeps
    // the caret out of it — the arrows step over the whole thing rather than
    // landing inside ```javascript where there is nothing to see.
    it('makes the fence a single atomic mark', async () => {
        await withText('```js\nconst a = 1;\n```');
        await settle();
        const marks = cm().getAllMarks().filter((m) => m.atomic);
        expect(marks.length).toBe(2);          // the opening fence and the closing one
        expect(marks.every((m) => m.inclusiveLeft && m.inclusiveRight)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// The three behaviours the editor cannot know about, because they are about
// Markdown rather than about text. Everything else — caret, arrows, selection,
// copy, paste, undo — is CodeMirror's and is not re-implemented anywhere.
//
// These drive the KEYMAP rather than synthesising keystrokes: the keymap is
// what the editor consults, and jsdom's key events do not carry the codes
// CodeMirror reads. Real keystrokes are checked in a browser instead.

describe('the keys the editor cannot answer on its own', () => {
    const keymap = () => cm().getOption('extraKeys');
    const press = (name) => keymap()[name](cm());

    it('sends on Enter', async () => {
        const el = await withText('hello');
        let asked = 0;
        const form = $('composer');
        const real = form.requestSubmit;
        form.requestSubmit = () => { asked++; };
        try { press('Enter'); } finally { form.requestSubmit = real; }
        expect(asked).toBe(1);
        expect(el.value).toBe('hello');       // Enter did not also insert a line
    });

    it('indents inside a block and passes Tab on outside one', async () => {
        const el = await withText('```js\none\n```');
        await settle();
        select(6);
        press('Tab');
        expect(el.value).toBe('```js\n    one\n```');

        type('just a sentence');
        await settle();
        select(4);
        // Passing is what lets the browser move the focus to the next control,
        // which is how somebody who does not use a mouse reaches Send.
        expect(press('Tab')).toBe(window.CodeMirror.Pass);
    });

    it('outdents on Shift-Tab, and stops at the margin', async () => {
        const el = await withText('```js\n        deep\n```');
        await settle();
        select(10);
        press('Shift-Tab');
        expect(el.value).toBe('```js\n    deep\n```');
        press('Shift-Tab');
        expect(el.value).toBe('```js\ndeep\n```');
        press('Shift-Tab');
        expect(el.value).toBe('```js\ndeep\n```');
    });

    it('removes an empty block whole, and closes the gap', async () => {
        const el = await withText('before\n```js\n\n```\nafter');
        await settle();
        select(13);
        press('Backspace');
        expect(el.value).toBe('before\nafter');
    });

    it('removes one that is the whole message', async () => {
        const el = await withText('```js\n\n```');
        await settle();
        select(6);
        press('Backspace');
        expect(el.value).toBe('');
    });

    it('removes an unclosed one too', async () => {
        const el = await withText('```js');
        await settle();
        select(5);
        press('Backspace');
        expect(el.value).toBe('');
    });

    // With code still in it the fences are not the user's to delete by
    // accident: they are one atomic mark, which the editor would take whole,
    // leaving a block with no top and nothing on screen to say why.
    it('refuses to eat the fence while there is still code', async () => {
        const el = await withText('```js\ncode\n```');
        await settle();
        select(6);                             // start of the first code line
        expect(press('Backspace')).toBe(undefined);
        expect(el.value).toBe('```js\ncode\n```');

        select(10);                            // end of the last code line
        expect(press('Delete')).toBe(undefined);
        expect(el.value).toBe('```js\ncode\n```');
    });

    it('leaves an ordinary delete inside the code to the editor', async () => {
        await withText('```js\ncode\n```');
        await settle();
        select(8);
        expect(press('Backspace')).toBe(window.CodeMirror.Pass);
    });

    it('claims the chords the editor would otherwise answer itself', async () => {
        await withText('x');
        await settle();
        // Ctrl-U is the editor's undoSelection and Ctrl-D its deleteLine. Both
        // would happen underneath the app's own bindings if they were not taken.
        for (const name of ['Ctrl-B', 'Ctrl-I', 'Ctrl-U', 'Ctrl-K', 'Ctrl-D',
            'Shift-Ctrl-X', 'Shift-Ctrl-S', 'Shift-Ctrl-C',
            'Shift-Ctrl-7', 'Shift-Ctrl-8', 'Shift-Ctrl-9',
            'Ctrl-Alt-C', 'Ctrl-Up', 'Ctrl-Down']) {
            expect(typeof keymap()[name], name).toBe('function');
        }
    });

    it('writes the marks the chords stand for', async () => {
        const el = await withText('x');
        await settle();
        select(0, 1);
        press('Ctrl-B');
        expect(el.value).toBe('**x**');
    });

    // Tab has to be able to reach the browser, and the editor's own default
    // keymap binds it. A keymap that binds it to `false` is what tells
    // CodeMirror to leave the event alone entirely.
    it('has a keymap that lets Tab out', async () => {
        await withText('');
        await settle();
        expect(cm().getOption('keyMap')).toBe('scarmvoice');
        expect(window.CodeMirror.keyMap.scarmvoice.Tab).toBe(false);
        expect(window.CodeMirror.keyMap.scarmvoice['Shift-Tab']).toBe(false);
    });
});

describe('what the message ends up being', () => {
    // The point of the whole exercise: the toolbar changes the TEXT, and the
    // text is what is sent. Nothing here stores HTML.
    it('sends the markdown, not a rich document', async () => {
        const h = await boot({});
        await settle();
        $('btn-format').click();
        await settle();
        type('hello');
        select(0, 5);
        click('bold');
        $('composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
        await settle();

        const post = h.lounge.board.mock.calls
            .map((c) => c[1]).filter((o) => o && o.body && o.body.body).pop();
        expect(post.body.body).toBe('**hello**');
    });
});

// ---------------------------------------------------------------------------

describe('a code block once it has been sent', () => {
    async function render(body) {
        await bootRenderer({
            board: vi.fn(async (p) => {
                if (p === 'list') {
                    return {
                        success: true, hasMore: false, maxId: 9, typing: [], voice: [],
                        posts: [{
                            id: 9, body, name: 'Alice', client_id: 'alice', user_id: 2,
                            created_at: 1700000000000, reactions: [], pinned: 0
                        }]
                    };
                }
                if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
                if (p === 'presence') return { success: true, members: [] };
                if (p === 'dm/threads') return { success: true, threads: [] };
                return { success: true };
            })
        });
        await settle();
        return $('messages').querySelector('.msg-codeblock');
    }

    it('says what language it is in', async () => {
        const box = await render('```javascript\nconst a = 1;\n```');
        expect(box).toBeTruthy();
        expect(box.querySelector('.cb-lang').textContent).toBe('JavaScript');
        expect(box.dataset.lang).toBe('javascript');
    });

    it('numbers its lines', async () => {
        const box = await render('```\na\nb\nc\n```');
        expect(box.querySelector('.cb-gutter').textContent).toBe('1\n2\n3');
    });

    // A fence written by hand can carry anything. An unknown tag is shown as
    // itself rather than swallowed — it is what the author wrote, and the block
    // renders as plain monospace, which is the honest pairing.
    it('shows an unknown tag as written, and an unlabelled block as Code', async () => {
        expect((await render('```brainfuck\n+++\n```')).querySelector('.cb-lang').textContent).toBe('brainfuck');
        expect((await render('```\nplain\n```')).querySelector('.cb-lang').textContent).toBe('Code');
    });

    it('resolves the short tags people actually type', async () => {
        expect((await render('```js\nx\n```')).querySelector('.cb-lang').textContent).toBe('JavaScript');
        expect((await render('```py\nx\n```')).querySelector('.cb-lang').textContent).toBe('Python');
    });

    // The frame is around the `pre`, never inside it: the highlighter looks for
    // `pre.msg-code code` and rewrites the whole of it, so anything put in there
    // would be thrown away on the first render.
    it('leaves the element the highlighter looks for exactly where it was', async () => {
        const box = await render('```javascript\nconst a = 1;\n```');
        const code = box.querySelector('pre.msg-code > code');
        expect(code).toBeTruthy();
        expect(code.className).toBe('language-javascript');
        expect(code.textContent).toBe('const a = 1;');
    });
});
