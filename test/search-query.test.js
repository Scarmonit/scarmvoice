// The search box holds one string, and that string IS the state.
//
// `from:alice has:link before:2026-01-01 lunch` carries a query and three
// filters at once. The dropdown does not keep filters beside the box — it
// WRITES operators into it — which is what makes them typeable and clickable
// at the same time: there is only one representation, so the two can never
// drift apart.
//
// The parsing rules that matter are the ones about what is NOT an operator. A
// message about `http://example.com` or a ratio like `16:9` has to search for
// itself rather than disappear into a filter nobody asked for.
import { describe, it, expect } from 'vitest';
import lib from '../src/renderer/lib.js';

const { parseSearchQuery, opAtCaret, writeOp, postMatchesFilter } = lib;

describe('parsing a query', () => {
    it('splits operators out of the text', () => {
        const q = parseSearchQuery('from:alice has:link lunch plans');
        expect(q.text).toBe('lunch plans');
        expect(q.ops).toEqual({ from: ['alice'], has: ['link'] });
    });

    it('leaves anything that is not an operator alone', () => {
        // The whole reason the operator list is a closed set.
        const q = parseSearchQuery('see http://example.com/x at 16:9 ratio');
        expect(q.ops).toEqual({});
        expect(q.text).toBe('see http://example.com/x at 16:9 ratio');
    });

    it('takes a quoted value so names with spaces work', () => {
        const q = parseSearchQuery('from:"Ada Lovelace" notes');
        expect(q.ops.from).toEqual(['Ada Lovelace']);
        expect(q.text).toBe('notes');
    });

    it('keeps repeats rather than overwriting them', () => {
        // `from:a from:b` reads as "either of them" — the only reading that
        // makes repeating one useful.
        expect(parseSearchQuery('from:a from:b').ops.from).toEqual(['a', 'b']);
    });

    it('ignores a bare operator somebody is still typing', () => {
        // `from:` alone must not narrow the list to messages from nobody while
        // the dropdown is still offering them a name.
        const q = parseSearchQuery('from: hello');
        expect(q.ops.from).toBeUndefined();
        expect(q.text).toBe('hello');
    });

    it('is case-insensitive about the key, not the value', () => {
        const q = parseSearchQuery('From:Alice');
        expect(q.ops.from).toEqual(['Alice']);
    });
});

describe('completing an operator at the caret', () => {
    it('finds the operator the caret sits in', () => {
        const s = 'hello from:al world';
        const at = opAtCaret(s, 'hello from:al'.length);
        expect(at).toMatchObject({ key: 'from', value: 'al' });
        expect(s.slice(at.start, at.end)).toBe('from:al');
    });

    it('finds a bare operator, which is the moment the list is most useful', () => {
        const at = opAtCaret('from:', 5);
        expect(at).toMatchObject({ key: 'from', value: '' });
    });

    it('says nothing for ordinary words, or for a key that is not an operator', () => {
        expect(opAtCaret('hello world', 11)).toBeNull();
        expect(opAtCaret('note:thing', 10)).toBeNull();
    });

    it('handles a half-typed quoted value', () => {
        // The dropdown has to offer completions while the closing quote is
        // still missing — that is the whole point of offering them.
        expect(opAtCaret('from:"Ada Lov', 13)).toMatchObject({ key: 'from', value: 'Ada Lov' });
    });
});

describe('writing an operator back into the box', () => {
    it('replaces the token being typed, and leaves the caret after it', () => {
        const s = 'from:al lunch';
        const out = writeOp(s, 'from', 'alice', opAtCaret(s, 7));
        expect(out.text).toBe('from:alice lunch');
        // The caret indexes the NEW string, and lands past the value so the
        // next thing typed is the next word rather than a correction.
        expect(out.text.slice(0, out.caret)).toBe('from:alice ');
    });

    it('quotes a value only when it needs it', () => {
        expect(writeOp('', 'from', 'Ada Lovelace', null).text).toBe('from:"Ada Lovelace" ');
        expect(writeOp('', 'from', 'ada', null).text).toBe('from:ada ');
    });

    it('appends with a space when there is already something there', () => {
        expect(writeOp('lunch', 'has', 'link', null).text).toBe('lunch has:link ');
        expect(writeOp('lunch ', 'has', 'link', null).text).toBe('lunch has:link ');
    });
});

describe('what the operators actually narrow', () => {
    const post = (over) => Object.assign({
        id: 1, name: 'Alice', user_id: 2, client_id: 'c', body: 'hello',
        created_at: Date.parse('2026-03-15T12:00:00Z'), channel: 'general',
        pinned: 0, att_key: '', att_name: ''
    }, over);

    it('mentions: tests the same thing a ping does, asked about someone else', () => {
        const f = { mentionsNames: ['Bob'] };
        expect(postMatchesFilter(post({ body: 'hey @Bob look' }), f, 'Me')).toBe(true);
        expect(postMatchesFilter(post({ body: 'hey @Bobby look' }), f, 'Me')).toBe(false);
        expect(postMatchesFilter(post({ body: 'nothing here' }), f, 'Me')).toBe(false);
    });

    it('before: and after: are exclusive of the instant they name', () => {
        const day = Date.parse('2026-03-15T00:00:00Z');
        const next = Date.parse('2026-03-16T00:00:00Z');
        expect(postMatchesFilter(post(), { after: day }, 'Me')).toBe(true);
        expect(postMatchesFilter(post(), { before: next }, 'Me')).toBe(true);
        expect(postMatchesFilter(post(), { before: day }, 'Me')).toBe(false);
        expect(postMatchesFilter(post(), { after: next }, 'Me')).toBe(false);
    });

    it('in: matches the channel, and never matches a row that has none', () => {
        expect(postMatchesFilter(post(), { inChannel: 'general' }, 'Me')).toBe(true);
        expect(postMatchesFilter(post(), { inChannel: 'random' }, 'Me')).toBe(false);
        // A DM row carries no channel; it cannot be "in" one.
        expect(postMatchesFilter(post({ channel: undefined }), { inChannel: 'general' }, 'Me')).toBe(false);
    });

    it('still combines with everything that was already there', () => {
        const p = post({ body: 'the logo http://x.com/a', pinned: 1 });
        const f = { types: ['links'], pinned: true, text: 'logo', inChannel: 'general' };
        expect(postMatchesFilter(p, f, 'Me')).toBe(true);
        expect(postMatchesFilter(p, Object.assign({}, f, { text: 'nope' }), 'Me')).toBe(false);
    });
});
