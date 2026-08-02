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

    it('writes each of the five inline marks', async () => {
        const cases = [
            ['bold', '**x**'], ['italic', '*x*'], ['underline', '__x__'],
            ['strike', '~~x~~'], ['code', '`x`'], ['spoiler', '||x||']
        ];
        for (const [kind, want] of cases) {
            const el = await withText('x');
            select(0, 1);
            click(kind);
            expect(el.value, kind).toBe(want);
        }
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
        click('link');
        expect(el.value).toBe('[docs](url)');
        expect(el.value.slice(el.selectionStart, el.selectionEnd)).toBe('url');
    });

    it('turns a selected url into the target instead', async () => {
        const el = await withText('https://example.com');
        select(0, 19);
        click('link');
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

    it('cycles the heading through the three levels Markdown has, then off', async () => {
        const el = await withText('title');
        select(0);
        $('btn-heading').click();
        expect(el.value).toBe('# title');
        $('btn-heading').click();
        expect(el.value).toBe('## title');
        $('btn-heading').click();
        expect(el.value).toBe('### title');
        $('btn-heading').click();
        expect(el.value).toBe('title');
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
    });

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
        $('btn-code-block').click();
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

    it('holds exactly the characters in the field', async () => {
        await boot({});
        await settle();
        for (const s of SAMPLES) {
            type(s);
            // The one deliberate difference: a trailing newline, so a message
            // that ends on Shift+Enter has a final line with height.
            expect(mirror().textContent, JSON.stringify(s)).toBe(s + '\n');
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
        const rules = CSS.match(/\.cm-[\w-]+[^{}]*\{[^}]*\}/g) || [];
        expect(rules.length, 'no .cm-* rules found — did they move?').toBeGreaterThan(8);
        for (const rule of rules) {
            const body = rule.slice(rule.indexOf('{'));
            expect(banned.test(body), rule.split('{')[0].trim() + ' changes glyph metrics').toBe(false);
        }
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
        expect([...field.children].map((c) => c.id)).toEqual(['composer-mirror', 'composer-input']);
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
        expect(mirror().querySelector('.cm-fence').textContent).toBe('**not bold**');
    });

    it('escapes what it is given, because it is the least trusted text here', async () => {
        await boot({});
        await settle();
        type('<img src=x onerror=1>');
        expect(mirror().querySelector('img')).toBe(null);
        expect(mirror().textContent).toBe('<img src=x onerror=1>\n');
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
        expect(mirror().textContent).toBe('**recalled**\n');
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
