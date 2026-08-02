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
import { bootRenderer, settle, type, $ } from './helpers/renderer.js';

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
const input = () => $('composer-input');
const mirror = () => $('composer-mirror');

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
function chord(key, opts = {}) {
    input().dispatchEvent(new window.KeyboardEvent('keydown', Object.assign({
        key, ctrlKey: true, bubbles: true, cancelable: true
    }, opts)));
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
        chord('x', { shiftKey: true });
        await settle();
        expect($('format-bar').hidden).toBe(false);
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
        for (const [key, want] of [['b', '**x**'], ['i', '*x*'], ['u', '__x__']]) {
            const el = await withText('x');
            select(0, 1);
            chord(key);
            expect(el.value, key).toBe(want);
        }
    }, 20000);

    // With Shift held the key IS '*' and '&', so these have to be read off the
    // physical code rather than the character.
    it('reads the list chords off the key position, not the character', async () => {
        const el = await withText('one');
        select(0);
        input().dispatchEvent(new window.KeyboardEvent('keydown', {
            key: '*', code: 'Digit8', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true
        }));
        expect(el.value).toBe('- one');
    });

    it('leaves an unmodified letter alone', async () => {
        const el = await withText('x');
        select(0, 1);
        input().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'b', bubbles: true, cancelable: true }));
        expect(el.value).toBe('x');
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

describe('the formatting drawn under the caret', () => {
    const SAMPLES = [
        '',
        'plain text',
        '**bold** and *italic*',
        '__underline__ ~~strike~~ ||spoiler||',
        '***all three***',
        '`code span` and ``a ` inside``',
        '# heading\n> quote\n- item\n1. numbered',
        '```js\nconst a = 1;\n```',
        'unclosed **bold',
        '*',
        '**',
        'a_b_c snake_case_name',
        '<script>alert(1)</script>',
        '&amp; & <b>',
        'line one\n\nline three\n',
        '  indented **bold**  ',
        '- [link](https://example.com)',
        '>>> not a quote marker exactly',
        '```\nno language\n```\ntail'
    ];

    // The invariant, in its new shape. The layer is a stack of line boxes now
    // rather than one run of text with newlines in it — a block can carry a
    // background across the full width and hold a line number out in the
    // gutter, and a span cannot — so the characters are compared line by line.
    const mirrorText = () => [...mirror().querySelectorAll('.cm-line')]
        .map((l) => l.textContent).join('\n');

    it('holds exactly the characters in the field', async () => {
        await boot({});
        await settle();
        for (const s of SAMPLES) {
            type(s);
            // The one deliberate difference: a trailing empty line, so a message
            // that ends on Shift+Enter has a final row with height.
            expect(mirrorText(), JSON.stringify(s)).toBe(s + '\n');
        }
    });

    it('gives every source line exactly one line box', async () => {
        await boot({});
        await settle();
        for (const s of SAMPLES) {
            type(s);
            expect(mirror().querySelectorAll('.cm-line').length, JSON.stringify(s))
                .toBe(s.split('\n').length + 1);
        }
    });

    // THE RULE THE WHOLE LAYER RESTS ON.
    //
    // The caret is the textarea's, the glyphs are the layer's, and a textarea
    // can carry exactly one font — so any style here that changes how wide a
    // character is makes the drawn text drift away from the caret, cumulatively,
    // one character at a time.
    //
    // v0.76.0 shipped with the mono face and 0.92em on code spans and fences:
    // typing inside a ``` block left the caret further behind with every key.
    // Bold and italic were the same bug, slower. Emphasis is painted now —
    // colour, background, decorations and -webkit-text-stroke — and this is the
    // check that keeps it that way, because it is not a thing to remember.
    it('never changes a character’s width, in any of its marks', () => {
        const banned = /(^|[;{\s])(font-family|font-size|font-weight|font-style|font-stretch|font-variant|font|letter-spacing|word-spacing|text-transform|zoom|transform)\s*:/;
        // Comments stripped first: one of them MENTIONS .cm-mark, and an
        // unguarded scan ran from that word into the next real rule and blamed
        // it for whatever it found there.
        const bare = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
        const rules = bare.match(/\.cm-[\w-]+[^{}]*\{[^}]*\}/g) || [];
        expect(rules.length, 'no .cm-* rules found — did they move?').toBeGreaterThan(8);
        for (const rule of rules) {
            const selector = rule.split('{')[0].trim();
            // ONE exception, and it is the reason the exception is stated by
            // NAME rather than by trusting the author: a rule that changes both
            // boxes at once cannot pull them apart. The mono face for a message
            // holding a code block is that rule, and it names #composer-input.
            if (selector.includes('#composer-input')) continue;
            const body = rule.slice(rule.indexOf('{'));
            // …and anything taken OUT OF THE FLOW cannot push a glyph anywhere:
            // the line numbers live in the gutter, absolutely positioned, and
            // what they are set in is their own business.
            if (/position:\s*absolute/.test(body)) continue;
            expect(banned.test(body), selector + ' changes glyph metrics').toBe(false);
        }
    });

    // The fences are the panel's own edges — the opening line carries the title
    // bar and the closing one is its bottom rule — so neither shows its
    // backticks. The text is still there; only its ink is gone.
    // THE PANEL IS DRAWN, NOT LAID OUT. A border, rounded corners, an inset and
    // a gutter are all boxes the text would have to move for — and nothing here
    // may move the text at all. So it is an absolutely-positioned slice behind
    // each of the block's lines, which exists as far as the eye is concerned and
    // not at all as far as the caret is.
    it('draws the block’s panel behind the text rather than around it', () => {
        const flat = CSS.replace(/\s+/g, ' ');
        const rule = /\.cm-fl::before \{([^}]*)\}/.exec(flat);
        expect(rule, 'the panel must be a ::before, not a box on .cm-fl').toBeTruthy();
        expect(rule[1]).toContain('position: absolute');
        // Reaching left across the gutter the padding made, so the numbers are
        // inside the panel and not floating beside it.
        expect(rule[1]).toContain('calc(var(--cm-inset) - var(--cm-gutter))');
        expect(flat).toMatch(/\.cm-fl-open::before \{[^}]*border-radius: 8px 8px 0 0/);
        expect(flat).toMatch(/\.cm-fl-close::before \{[^}]*border-radius: 0 0 8px 8px/);
        // …and .cm-fl itself keeps no background of its own, or the slice would
        // be drawn on top of a slab that ends at the text.
        const plain = /\.cm-fl \{([^}]*)\}/.exec(flat);
        expect(plain === null || !/background/.test(plain[1])).toBe(true);
    });

    it('makes the title bar span the panel, not sit in a corner of it', () => {
        const flat = CSS.replace(/\s+/g, ' ');
        const rule = /\.codechip \{([^}]*)\}/.exec(flat);
        expect(rule).toBeTruthy();
        expect(rule[1]).toContain('left: var(--cm-inset)');
        expect(rule[1]).toContain('right: var(--cm-inset)');
        expect(rule[1]).toContain('border-radius: 8px 8px 0 0');
    });

    it('turns the backticks into the block’s edges', () => {
        const flat = CSS.replace(/\s+/g, ' ');
        expect(flat).toContain('.cm-fl-open .cm-mark, .cm-fl-close .cm-mark { opacity: 0; }');
    });

    // The gutter and the mono face are made by padding and typesetting BOTH
    // boxes in one rule. Named together on purpose: separately they drift, and
    // drift is the caret sitting beside the wrong glyph.
    it('makes the gutter and the mono face on both boxes at once', () => {
        const flat = CSS.replace(/\s+/g, ' ');
        const rule = /\.composer-field\.cm-code #composer-input, \.composer-field\.cm-code #composer-mirror \{([^}]*)\}/
            .exec(flat);
        expect(rule, 'the gutter/mono rule must name both boxes').toBeTruthy();
        expect(rule[1]).toContain('font-family: var(--mono)');
        expect(rule[1]).toContain('padding-left');
    });

    it('still draws code, bold and headings as something', () => {
        // Paint-only is the constraint, not an excuse to draw nothing.
        const rule = (sel) => (CSS.match(new RegExp('\\' + sel + '[^{}]*\\{[^}]*\\}')) || [''])[0];
        expect(rule('.cm-b')).toMatch(/-webkit-text-stroke/);
        expect(rule('.cm-head')).toMatch(/-webkit-text-stroke/);
        expect(rule('.cm-code, .cm-fence')).toMatch(/background/);
    });

    // The layer is positioned against a wrapper holding it and the field, NOT
    // against the composer row — the row also holds the attach button and the
    // tool cluster, and measured against that every character would sit one
    // button's width to the left of the caret it belongs to. jsdom cannot see
    // the misalignment, but it can see the structure that prevents it.
    it('shares a positioning wrapper with the field, and only with the field', async () => {
        await boot({});
        await settle();
        const field = mirror().parentElement;
        expect(field.classList.contains('composer-field')).toBe(true);
        expect(input().parentElement).toBe(field);
        expect([...field.children].map((c) => c.id))
            .toEqual(['composer-mirror', 'composer-input', 'composer-chrome']);
    });

    it('marks the syntax and formats what it wraps', async () => {
        await boot({});
        await settle();
        type('a **bold** b');
        expect(mirror().querySelector('.cm-b').textContent).toBe('bold');
        expect([...mirror().querySelectorAll('.cm-mark')].map((n) => n.textContent)).toEqual(['**', '**']);
    });

    it('uses the message renderer’s own reading of the syntax', async () => {
        await boot({});
        await settle();
        // ***x*** is bold AND italic to the renderer; the preview must not have
        // a second opinion about it.
        type('***x***');
        const inner = mirror().querySelector('.cm-b.cm-i, .cm-i.cm-b');
        expect(inner).toBeTruthy();
        expect(inner.textContent).toBe('x');
    });

    it('leaves everything inside a fence alone', async () => {
        await boot({});
        await settle();
        type('```js\n**not bold**\n```');
        expect(mirror().querySelector('.cm-b')).toBe(null);
        expect(mirror().querySelector('.cm-fl-body').textContent).toBe('**not bold**');
    });

    it('escapes what it is given, because it is the least trusted text here', async () => {
        await boot({});
        await settle();
        type('<img src=x onerror=1>');
        expect(mirror().querySelector('img')).toBe(null);
        expect(mirrorText()).toBe('<img src=x onerror=1>\n');
    });

    it('is off, and the field paints its own text, when the setting says so', async () => {
        await boot({ richComposer: false });
        await settle();
        type('**bold**');
        expect(mirror().hidden).toBe(true);
        expect(document.body.classList.contains('rich-composer')).toBe(false);
    });

    // The parse runs on every keystroke and the server accepts a quarter of a
    // megabyte. Past the ceiling the field goes back to painting itself, which
    // is exactly what it did before this feature existed.
    it('gives up on a message too big to reparse per keystroke', async () => {
        await boot({});
        await settle();
        type('x'.repeat(12001));
        expect(mirror().hidden).toBe(true);
        expect(document.body.classList.contains('rich-composer')).toBe(false);
        type('short again');
        expect(mirror().hidden).toBe(false);
    });

    it('follows text the app writes into the box, not only typing', async () => {
        await boot({ messageHistory: ['**recalled**'] });
        await settle();
        input().dispatchEvent(new window.KeyboardEvent('keydown', {
            key: 'ArrowUp', ctrlKey: true, bubbles: true, cancelable: true
        }));
        expect(mirrorText()).toBe('**recalled**\n');
    });
});

// ---------------------------------------------------------------------------
// The reference draws a fenced block in the composer as an editor: a titled
// panel with the language on it, numbered lines and coloured code.

describe('a code block while it is being written', () => {
    const chip = () => $('composer-chrome').querySelector('.codechip');
    const field = () => document.querySelector('.composer-field');

    it('turns the box into a code editor while it holds a block', async () => {
        await boot({});
        await settle();
        expect(field().classList.contains('cm-code')).toBe(false);
        type('```js\nconst a = 1;\n```');
        expect(field().classList.contains('cm-code')).toBe(true);
        type('no code here');
        expect(field().classList.contains('cm-code')).toBe(false);
    });

    it('numbers the lines of the block, and only those', async () => {
        await boot({});
        await settle();
        type('before\n```js\none\ntwo\nthree\n```\nafter');
        const nums = [...mirror().querySelectorAll('.cm-num')].map((n) => n.dataset.n);
        expect(nums).toEqual(['1', '2', '3']);
    });

    // Generated content, not text. The invariant this layer rests on is that its
    // text is the field's text — a number in the markup would break it as
    // surely as an extra character typed in.
    it('keeps the numbers out of the text', async () => {
        await boot({});
        await settle();
        type('```js\nconst a = 1;\n```');
        const text = [...mirror().querySelectorAll('.cm-line')].map((l) => l.textContent).join('\n');
        expect(text).toBe('```js\nconst a = 1;\n```\n');
    });

    it('titles the block with its language, and can change it', async () => {
        const el = await withText('```js\nconst a = 1;\n```');
        await settle();
        expect(chip()).toBeTruthy();
        expect(chip().querySelector('.codechip-lang span').textContent).toBe('JavaScript');

        chip().querySelector('.codechip-lang').click();
        await settle();
        $('lang-search').value = 'python';
        $('lang-search').dispatchEvent(new window.Event('input', { bubbles: true }));
        await settle();
        $('lang-list').querySelector('.lang-item').click();
        await settle();

        expect(el.value).toBe('```python\nconst a = 1;\n```');
        expect(chip().querySelector('.codechip-lang span').textContent).toBe('Python');
    });

    it('offers the block its own menu', async () => {
        const el = await withText('```js\nconst a = 1;\n```');
        await settle();
        chip().querySelector('.codechip-more').click();
        await settle();
        expect([...$('fmt-menu').querySelectorAll('.fm-label')].map((l) => l.textContent))
            .toEqual(['Change language', 'Copy code', 'Remove code block']);

        menuItem('Remove code block').click();
        await settle();
        expect(el.value).toBe('const a = 1;');
    });

    // CODE IS NOT PROSE. A textarea spell-checks all of itself or none of
    // itself, so while the message holds a block the whole field stops — red
    // squiggles under every identifier are worse than none under the sentence
    // above them.
    it('turns spellcheck off while there is code in the box', async () => {
        await boot({});
        await settle();
        expect(input().spellcheck).toBe(true);

        type('```js\nconst a = 1;\n```');
        expect(input().spellcheck).toBe(false);
        expect(input().getAttribute('spellcheck')).toBe('false');

        type('just a sentence');
        expect(input().spellcheck).toBe(true);
        expect(input().getAttribute('spellcheck')).toBe('true');
    });

    // The bar covers the opening line EXACTLY — it is that line, as far as
    // anybody looking at it is concerned, which is why the line's own ink is off.
    it('sizes the title bar to the line it stands in for', async () => {
        await withText('```js\nconst a = 1;\n```');
        await settle();
        const open = mirror().querySelector('.cm-fl-open');
        expect(chip().style.top).toBe(open.offsetTop + 'px');
        expect(chip().style.height).toBe(open.offsetHeight + 'px');
    });

    it('is one block per fence, however many there are', async () => {
        await withText('```js\na\n```\ntext\n```python\nb\n```');
        await settle();
        expect($('composer-chrome').querySelectorAll('.codechip').length).toBe(2);
    });

    it('titles an unclosed fence too, because it is still a block', async () => {
        await withText('```rust\nfn main() {');
        await settle();
        expect(chip().querySelector('.codechip-lang span').textContent).toBe('Rust');
    });

    // A stand-in on window.hljs with only the methods somebody else needed used
    // to throw straight through the preview and take the whole layer down.
    it('survives a highlighter that is not all there', async () => {
        await boot({});
        await settle();
        const real = window.hljs;
        window.hljs = { highlightElement: () => {} };
        try {
            type('```js\nconst a = 1;\n```');
            expect(mirror().hidden).toBe(false);
            const text = [...mirror().querySelectorAll('.cm-line')].map((l) => l.textContent).join('\n');
            expect(text).toBe('```js\nconst a = 1;\n```\n');
        } finally {
            if (real === undefined) delete window.hljs; else window.hljs = real;
        }
    });
});

// ---------------------------------------------------------------------------
// A block is drawn as an editor, so it has to answer like one.

describe('the keyboard inside a code block', () => {
    // before / ```js / code one / code two / ``` / after
    const DOC = 'before\n```js\ncode one\ncode two\n```\nafter';
    const L = { before: 0, open: 7, one: 13, two: 22, close: 31, after: 35 };

    function key(k, opts = {}) {
        const ev = new window.KeyboardEvent('keydown', Object.assign({
            key: k, bubbles: true, cancelable: true
        }, opts));
        input().dispatchEvent(ev);
        input().dispatchEvent(new window.KeyboardEvent('keyup', { key: k, bubbles: true }));
        return ev;
    }
    async function inBlock(text) {
        const el = await withText(text === undefined ? DOC : text);
        await settle();
        return el;
    }

    // THE FENCE LINES ARE CHROME. The opening ``` carries the title bar and the
    // closing one is the panel's bottom edge, both with their ink off — so an
    // Up from the first line of code used to put the caret INSIDE THE TITLE BAR,
    // where there is nothing to see and anything typed corrupts the fence. That
    // is what "the arrows escape the block" was.
    it('steps over the title bar going up, not into it', async () => {
        const el = await inBlock();
        select(L.one);
        const ev = key('ArrowUp');
        expect(ev.defaultPrevented).toBe(true);
        expect(el.selectionStart).toBe(L.before);
    });

    it('steps over the bottom edge going down', async () => {
        const el = await inBlock();
        select(L.two);
        const ev = key('ArrowDown');
        expect(ev.defaultPrevented).toBe(true);
        expect(el.selectionStart).toBe(L.after);
    });

    // Between lines of code it does nothing at all: the browser already moves
    // the caret correctly, and column memory is its business.
    it('leaves an ordinary move between code lines alone', async () => {
        await inBlock();
        select(L.one);
        expect(key('ArrowDown').defaultPrevented).toBe(false);
    });

    it('keeps the column it had', async () => {
        const el = await inBlock();
        select(L.one + 4);                       // "code| one"
        key('ArrowUp');
        expect(el.selectionStart).toBe(L.before + 4);
    });

    // Off the end of the message there is nowhere to step to, so it is left to
    // do whatever it would have done.
    it('lets the caret run off the end when there is nothing past the block', async () => {
        await inBlock('```js\ncode\n```');
        select(6);                               // the one line of code
        expect(key('ArrowUp').defaultPrevented).toBe(false);
    });

    // The net, for the moves that are deliberately not intercepted — a click on
    // the title bar, a wrapped line, an undo.
    it('moves a caret that has landed on the title bar into the code', async () => {
        const el = await inBlock();
        select(L.open + 2);
        input().dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        expect(el.selectionStart).toBe(L.one + 2);
    });

    it('moves a caret that has landed on the bottom edge back up into it', async () => {
        const el = await inBlock();
        select(L.close + 1);
        input().dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        expect(el.selectionStart).toBe(L.two + 1);
    });

    it('sends it the way it was travelling when it was an arrow', async () => {
        const el = await inBlock();
        select(L.close);
        input().dispatchEvent(new window.KeyboardEvent('keyup', { key: 'ArrowDown', bubbles: true }));
        expect(el.selectionStart).toBe(L.after);
    });
});

describe('Tab inside a code block', () => {
    const DOC = '```js\none\ntwo\n```';

    function tab(shift) {
        const ev = new window.KeyboardEvent('keydown', {
            key: 'Tab', shiftKey: !!shift, bubbles: true, cancelable: true
        });
        input().dispatchEvent(ev);
        return ev;
    }

    it('indents instead of moving the focus away', async () => {
        const el = await withText(DOC);
        await settle();
        select(6);                               // start of "one"
        const ev = tab();
        expect(ev.defaultPrevented).toBe(true);
        expect(el.value).toBe('```js\n    one\ntwo\n```');
    });

    it('indents every line a selection touches', async () => {
        const el = await withText(DOC);
        await settle();
        select(6, 13);                           // "one\ntwo"
        tab();
        expect(el.value).toBe('```js\n    one\n    two\n```');
    });

    it('outdents on Shift+Tab, and stops at the margin', async () => {
        const el = await withText('```js\n        deep\n```');
        await settle();
        select(8);
        tab(true);
        expect(el.value).toBe('```js\n    deep\n```');
        select(8);
        tab(true);
        expect(el.value).toBe('```js\ndeep\n```');
        select(6);
        tab(true);
        expect(el.value).toBe('```js\ndeep\n```');
    });

    it('keeps the selection over the same text, so it can be indented twice', async () => {
        const el = await withText(DOC);
        await settle();
        select(6, 13);
        tab();
        tab();
        expect(el.value).toBe('```js\n        one\n        two\n```');
    });

    // Everywhere else Tab is how somebody who does not use a mouse reaches the
    // send button, and it stays that way.
    it('still moves the focus outside a code block', async () => {
        const el = await withText('just a sentence');
        await settle();
        select(4);
        const ev = tab();
        expect(ev.defaultPrevented).toBe(false);
        expect(el.value).toBe('just a sentence');
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
