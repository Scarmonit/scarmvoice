// @vitest-environment jsdom
//
// How a message body is turned into DOM.
//
// The bug this file exists for: an ordered list came out with every item
// numbered 1. The renderer took a run of CONSECUTIVE list lines and stopped at
// the first line that was not one — so a blank line between items, an indented
// sub-list, or a wrapped second line ended the <ol>, and the next item opened a
// brand new <ol>. A fresh <ol> counts from one, so a list written 1 through 8
// with any spacing at all drew as eight lists of one item: 1, 1, 1, 1, 1, 1, 1, 1.
//
// Rendering markdown is a pure function of the body, so these assertions are on
// the shape of the tree rather than on pixels — the numbers a reader sees come
// from <ol start> and the browser's own counter, and that is exactly what a
// broken parse destroys.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { bootRenderer, $, settle } from './helpers/renderer.js';

let h;

// ONE boot for the whole file, like test/render-diff-cost.test.js: bootRenderer
// leaves the previous instance's poll timers running and they re-render into the
// same #messages, so a boot per case turns into a document several renderers are
// fighting over. `posts` is the page the stubbed /list hands back, and it always
// holds the SAME id — so a resync replaces the row rather than appending one.
let posts = [];

const router = vi.fn(async (p) => {
    if (p === 'list') return { success: true, posts, typing: [], voice: [], hasMore: false, maxId: 1 };
    if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
    if (p === 'presence') return { success: true, members: [] };
    if (p === 'dm/threads') return { success: true, threads: [] };
    return { success: true };
});

beforeAll(async () => {
    localStorage.clear();
    h = await bootRenderer({ board: router });
    await settle();
});

// Put `body` in the channel as the only message, and hand back the .msg-text
// node it drew into.
async function render(body) {
    posts = [{
        id: 1, body, name: 'Alice', client_id: 'alice', user_id: 2,
        created_at: 1700000000000, reactions: [], pinned: 0
    }];
    h.resync();
    await settle();
    const rows = $('messages').querySelectorAll('.msg-text');
    expect(rows.length, 'expected exactly one message on screen').toBe(1);
    return rows[0];
}

// The numbers a reader actually sees. jsdom has no CSS counters, so this is the
// arithmetic the browser does: the list's start value, then one per item.
function visibleNumbers(ol) {
    const start = parseInt(ol.getAttribute('start') || '1', 10);
    return Array.from(ol.children).map((_, i) => start + i);
}

describe('ordered lists', () => {
    it('numbers a plain 1-through-8 list 1 through 8', async () => {
        const el = await render('1. one\n2. two\n3. three\n4. four\n5. five\n6. six\n7. seven\n8. eight');
        const lists = el.querySelectorAll('ol.msg-list');
        expect(lists.length, 'the list was split into several lists').toBe(1);
        expect(visibleNumbers(lists[0])).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        expect(Array.from(lists[0].children).map((li) => li.textContent))
            .toEqual(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight']);
    });

    it('keeps counting across the blank lines between items', async () => {
        // THE reported symptom. Every item used to become its own <ol>, so every
        // item showed "1.".
        const el = await render('1. one\n\n2. two\n\n3. three\n\n4. four');
        const lists = el.querySelectorAll('ol.msg-list');
        expect(lists.length).toBe(1);
        expect(visibleNumbers(lists[0])).toEqual([1, 2, 3, 4]);
    });

    it('numbers sequentially even when every item was typed as 1.', async () => {
        // What a paste out of a chat log looks like, and what markdown says to do
        // with it: the first number is the start, the rest are advisory.
        const el = await render('1. one\n1. two\n1. three');
        const ol = el.querySelector('ol.msg-list');
        expect(visibleNumbers(ol)).toEqual([1, 2, 3]);
        expect(ol.getAttribute('start')).toBe(null);
    });

    it('honours a list that starts somewhere other than one', async () => {
        const el = await render('5. five\n6. six\n7. seven');
        const ol = el.querySelector('ol.msg-list');
        expect(ol.getAttribute('start')).toBe('5');
        expect(visibleNumbers(ol)).toEqual([5, 6, 7]);
    });

    it('survives a wrapped second line inside an item', async () => {
        const el = await render('1. one\n   continues here\n2. two');
        const lists = el.querySelectorAll('ol.msg-list');
        expect(lists.length).toBe(1);
        expect(visibleNumbers(lists[0])).toEqual([1, 2]);
        expect(lists[0].children[0].textContent).toContain('continues here');
    });

    it('keeps the outer numbering when an item holds a nested list', async () => {
        const el = await render('1. one\n   - sub a\n   - sub b\n2. two\n3. three');
        const outer = el.querySelector('ol.msg-list');
        expect(visibleNumbers(outer)).toEqual([1, 2, 3]);
        const nested = outer.children[0].querySelector('ul.msg-list');
        expect(nested, 'the sub-list was not nested inside its item').toBeTruthy();
        expect(nested.children.length).toBe(2);
        // …and the nested list is INSIDE the first item, not a sibling that broke
        // the outer list in half.
        expect(el.querySelectorAll('ol.msg-list').length).toBe(1);
    });

    it('keeps a nested ordered list counting on its own', async () => {
        const el = await render('1. one\n    1. inner a\n    2. inner b\n2. two');
        const outer = el.querySelector('ol.msg-list');
        expect(visibleNumbers(outer)).toEqual([1, 2]);
        const inner = outer.children[0].querySelector('ol.msg-list');
        expect(inner).toBeTruthy();
        expect(visibleNumbers(inner)).toEqual([1, 2]);
    });

    it('starts a new list when the marker changes from numbers to bullets', async () => {
        const el = await render('1. one\n2. two\n- bullet');
        expect(el.querySelectorAll('ol.msg-list').length).toBe(1);
        expect(el.querySelectorAll('ul.msg-list').length).toBe(1);
        expect(visibleNumbers(el.querySelector('ol.msg-list'))).toEqual([1, 2]);
    });

    it('ends the list at ordinary prose below it', async () => {
        const el = await render('1. one\n2. two\n\nand then some prose');
        expect(el.querySelector('ol.msg-list').children.length).toBe(2);
        expect(el.textContent).toContain('and then some prose');
        // The prose is a paragraph, not a third list item.
        expect(el.querySelector('.msg-para').textContent).toBe('and then some prose');
    });
});

describe('unordered lists', () => {
    it('stays one list across blank lines', async () => {
        const el = await render('- one\n\n- two\n\n- three');
        const lists = el.querySelectorAll('ul.msg-list');
        expect(lists.length).toBe(1);
        expect(lists[0].children.length).toBe(3);
    });

    it('leaves *italic* on its own line alone', async () => {
        // A bullet needs whitespace after the marker, or every italicised line
        // would become a one-item list.
        const el = await render('*emphasis*');
        expect(el.querySelector('ul.msg-list')).toBe(null);
        expect(el.querySelector('em').textContent).toBe('emphasis');
    });
});

describe('inline formatting', () => {
    it('renders bold, italic, strike and underline', async () => {
        const el = await render('**b** *i* ~~s~~ __u__');
        expect(el.querySelector('strong').textContent).toBe('b');
        expect(el.querySelector('em').textContent).toBe('i');
        expect(el.querySelector('del').textContent).toBe('s');
        expect(el.querySelector('u').textContent).toBe('u');
    });

    it('renders ***text*** as bold AND italic', async () => {
        // The two-star rule used to take this and leave the odd star behind, so
        // it drew a bold "*x" followed by a stray "*".
        const el = await render('***both***');
        const strong = el.querySelector('strong');
        expect(strong).toBeTruthy();
        expect(strong.querySelector('em').textContent).toBe('both');
        expect(el.textContent).toBe('both');
    });

    it('italicises _text_ but leaves snake_case_names alone', async () => {
        const el = await render('call _this_ on snake_case_name please');
        expect(el.querySelector('em').textContent).toBe('this');
        expect(el.textContent).toContain('snake_case_name');
    });

    it('keeps formatting characters literal inside a code span', async () => {
        const el = await render('use `**not bold**` here');
        expect(el.querySelector('code.inline-code').textContent).toBe('**not bold**');
        expect(el.querySelector('strong')).toBe(null);
    });

    it('reads a double-backtick span as code', async () => {
        const el = await render('``a ` b``');
        expect(el.querySelector('code.inline-code').textContent).toBe('a ` b');
    });

    it('leaves a lone backtick as a backtick', async () => {
        // Splitting the line on every backtick made everything after an odd one
        // look like code.
        const el = await render('2 ` 3 is not code');
        expect(el.querySelector('code.inline-code')).toBe(null);
        expect(el.textContent).toBe('2 ` 3 is not code');
    });

    it('still hides a spoiler until it is clicked', async () => {
        const el = await render('||secret||');
        const sp = el.querySelector('.spoiler');
        expect(sp.classList.contains('revealed')).toBe(false);
        sp.click();
        expect(sp.classList.contains('revealed')).toBe(true);
    });
});

describe('blocks', () => {
    it('renders # ## ### as headings and -# as subtext', async () => {
        const el = await render('# big\n## medium\n### small\n-# quiet');
        expect(el.querySelector('.msg-h1').textContent).toBe('big');
        expect(el.querySelector('.msg-h2').textContent).toBe('medium');
        expect(el.querySelector('.msg-h3').textContent).toBe('small');
        expect(el.querySelector('.msg-sub').textContent).toBe('quiet');
    });

    it('leaves #channel-name as text', async () => {
        // The space is not optional. Without it every mention of a channel would
        // become a heading.
        const el = await render('see #general for that');
        expect(el.querySelector('.msg-h')).toBe(null);
        expect(el.textContent).toBe('see #general for that');
    });

    it('renders a list inside a blockquote', async () => {
        const el = await render('> 1. one\n> 2. two');
        const q = el.querySelector('blockquote.msg-bq');
        expect(q).toBeTruthy();
        expect(visibleNumbers(q.querySelector('ol.msg-list'))).toEqual([1, 2]);
    });

    it('quotes everything after >>>', async () => {
        const el = await render('>>> first\nsecond\nthird');
        const q = el.querySelector('blockquote.msg-bq');
        expect(q.textContent).toContain('first');
        expect(q.textContent).toContain('third');
        // Nothing escaped the quote: every paragraph the body produced is inside it.
        expect(Array.from(el.querySelectorAll('.msg-para')).every((p) => q.contains(p))).toBe(true);
    });

    it('keeps a fenced code block verbatim', async () => {
        const el = await render('```js\n1. not a list\n**not bold**\n```');
        const code = el.querySelector('pre.msg-code code');
        expect(code.className).toContain('language-js');
        expect(code.textContent).toBe('1. not a list\n**not bold**');
        expect(el.querySelector('ol.msg-list')).toBe(null);
    });
});

describe('a very long message', () => {
    it('renders a body far past the old 2000-character cap', async () => {
        // The cap is gone (the server's MAX_BODY is the only limit now), so the
        // renderer has to cope with a transcript-sized paste. A numbered list
        // inside one is the shape that is actually pasted.
        const lines = [];
        for (let i = 1; i <= 400; i++) lines.push(i + '. item number ' + i + ' ' + 'x'.repeat(200));
        const body = lines.join('\n\n');
        expect(body.length).toBeGreaterThan(80000);

        const started = Date.now();
        const el = await render(body);
        const ol = el.querySelector('ol.msg-list');
        // One list, 400 items, numbered 1..400 — not 400 lists all saying 1.
        expect(el.querySelectorAll('ol.msg-list').length).toBe(1);
        expect(ol.children.length).toBe(400);
        expect(visibleNumbers(ol)[399]).toBe(400);
        // Not a timing assertion so much as a smoke alarm: the old signature
        // stringified the whole body on every render pass, and a quadratic parse
        // here would blow straight past this.
        expect(Date.now() - started).toBeLessThan
            (20000);
    });
});
