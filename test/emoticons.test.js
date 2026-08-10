// @vitest-environment jsdom
//
// Text emoticons -> emoji (src/renderer/lib.js).
//
// The table is the easy half. The rules around it are where this either works
// or quietly eats something somebody meant to type, so that is what is pinned
// here: a token only converts when it STARTS a word and a space or the end of
// the message ENDS one.
//
// The second rule is not a nicety. This app has `:name:` custom emoji, and
// ":party:" passes through ":p" on the way to being typed — a converter that
// fired the moment a token completed would turn it into "😛arty:" under the
// writer's hands.
import { describe, it, expect, vi } from 'vitest';
import lib from '../src/renderer/lib.js';
import { bootRenderer, settle, type, $ } from './helpers/renderer.js';

const { emoticonsToEmoji, emoticonBeforeCaret, EMOTICONS } = lib;

describe('emoticonsToEmoji', () => {
    it('converts the common emoticons', () => {
        expect(emoticonsToEmoji(':(')).toBe('🙁');
        expect(emoticonsToEmoji(':)')).toBe('🙂');
        expect(emoticonsToEmoji(':D')).toBe('😃');
        expect(emoticonsToEmoji(';)')).toBe('😉');
        expect(emoticonsToEmoji(':P')).toBe('😛');
    });

    it('converts them in the middle of a sentence', () => {
        expect(emoticonsToEmoji('well that is a shame :( see you later'))
            .toBe('well that is a shame 🙁 see you later');
    });

    it('converts two in a row', () => {
        // The trailing boundary is a lookahead precisely so the space between
        // them is still there to satisfy the leading boundary of the second.
        expect(emoticonsToEmoji(':) :(')).toBe('🙂 🙁');
    });

    it('prefers the longest token', () => {
        expect(emoticonsToEmoji(':-)')).toBe('🙂');
        // ">:(" is not a ">" followed by a frown.
        expect(emoticonsToEmoji('>:(')).toBe('😠');
    });

    it('leaves a token that does not start a word alone', () => {
        // The case this rule exists for.
        expect(emoticonsToEmoji('see http://example.com/x')).toBe('see http://example.com/x');
        expect(emoticonsToEmoji('meet at 12:00')).toBe('meet at 12:00');
        expect(emoticonsToEmoji('a:)')).toBe('a:)');
    });

    it('leaves a token that does not end a word alone', () => {
        // The `:name:` custom-emoji guard.
        expect(emoticonsToEmoji(':party:')).toBe(':party:');
        expect(emoticonsToEmoji('use :Doge: here')).toBe('use :Doge: here');
        expect(emoticonsToEmoji(':)x')).toBe(':)x');
    });

    it('leaves code alone', () => {
        expect(emoticonsToEmoji('type `:(` to frown')).toBe('type `:(` to frown');
        expect(emoticonsToEmoji('```\nif x:\n  f( :( )\n```')).toBe('```\nif x:\n  f( :( )\n```');
    });

    it('converts around a code span rather than giving up on the message', () => {
        expect(emoticonsToEmoji(':) `:(` :)')).toBe('🙂 `:(` 🙂');
    });

    it('leaves everything after an unclosed fence alone', () => {
        // The normal state of a message being written.
        expect(emoticonsToEmoji(':)\n```\n:( still typing'))
            .toBe('🙂\n```\n:( still typing');
    });

    it('converts across lines', () => {
        expect(emoticonsToEmoji('one :)\ntwo :(')).toBe('one 🙂\ntwo 🙁');
    });

    it('passes empty and non-string input through', () => {
        expect(emoticonsToEmoji('')).toBe('');
        expect(emoticonsToEmoji(null)).toBe('');
        expect(emoticonsToEmoji(undefined)).toBe('');
    });

    it('is a no-op for a message with nothing to convert', () => {
        const s = 'nothing to see here';
        expect(emoticonsToEmoji(s)).toBe(s);
    });

    it('every table entry survives a round trip', () => {
        for (const [token, emoji] of Object.entries(EMOTICONS)) {
            expect(emoticonsToEmoji('a ' + token + ' b'), token).toBe('a ' + emoji + ' b');
        }
    });
});

describe('emoticonBeforeCaret', () => {
    it('fires on the space that ends the emoticon', () => {
        expect(emoticonBeforeCaret('oh no :( ')).toEqual({ start: 6, token: ':(', emoji: '🙁' });
    });

    it('fires at the start of the line', () => {
        expect(emoticonBeforeCaret(':) ')).toEqual({ start: 0, token: ':)', emoji: '🙂' });
    });

    it('does not fire while the token is still being typed', () => {
        expect(emoticonBeforeCaret('oh no :(')).toBe(null);
        expect(emoticonBeforeCaret(':party')).toBe(null);
        expect(emoticonBeforeCaret(':p')).toBe(null);
    });

    it('does not fire on a token that does not start a word', () => {
        expect(emoticonBeforeCaret('http://x ')).toBe(null);
        expect(emoticonBeforeCaret('at 12:00 ')).toBe(null);
    });

    it('does not fire on a space that follows anything else', () => {
        expect(emoticonBeforeCaret('hello ')).toBe(null);
        expect(emoticonBeforeCaret(':) hello ')).toBe(null);
    });

    it('reports where the token starts, so the caller can replace exactly it', () => {
        const hit = emoticonBeforeCaret('a :-) ');
        expect(hit.start).toBe(2);
        expect(hit.token).toBe(':-)');
        const before = 'a :-) ';
        expect(before.slice(hit.start, hit.start + hit.token.length)).toBe(':-)');
    });

    it('handles empty input', () => {
        expect(emoticonBeforeCaret('')).toBe(null);
        expect(emoticonBeforeCaret(null)).toBe(null);
    });
});

// The wiring, which is the part a table and two regexes cannot prove: what
// leaves the composer is what the reader on the other end sees, so the
// conversion has to happen to the message being SENT and not merely to the
// pixels in the box.
describe('the composer', () => {
    const router = () => vi.fn(async (p) => {
        if (p === 'list') return { success: true, posts: [], typing: [], voice: [], hasMore: false };
        if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
        if (p === 'presence') return { success: true, members: [] };
        if (p === 'dm/threads') return { success: true, threads: [] };
        return { success: true };
    });

    const posted = (board) => {
        const call = board.mock.calls.find((c) => c[0] === 'post');
        return call && call[1].body.body;
    };

    it('sends the emoji, not the emoticon', async () => {
        const board = router();
        await bootRenderer({ board });

        type('that is a shame :(');
        await settle();
        board.mockClear();
        $('composer').requestSubmit();
        await settle();

        expect(posted(board)).toBe('that is a shame 🙁');
    });

    it('sends an emoticon on its own line, the one the live pass never sees', async () => {
        const board = router();
        await bootRenderer({ board });

        type('line one\n:D');
        await settle();
        board.mockClear();
        $('composer').requestSubmit();
        await settle();

        expect(posted(board)).toBe('line one\n😃');
    });

    it('leaves a code block in the message alone', async () => {
        const board = router();
        await bootRenderer({ board });

        type('look :)\n```\nfn(x) :(\n```');
        await settle();
        board.mockClear();
        $('composer').requestSubmit();
        await settle();

        expect(posted(board)).toBe('look 🙂\n```\nfn(x) :(\n```');
    });

    it('leaves an inline code span alone', async () => {
        const board = router();
        await bootRenderer({ board });

        type('the regex is `[:P]` :)');
        await settle();
        board.mockClear();
        $('composer').requestSubmit();
        await settle();

        expect(posted(board)).toBe('the regex is `[:P]` 🙂');
    });
});

// The switch, in Settings › Chat › Formatting. Off means the text goes out
// exactly as it was typed — and it is read at conversion time, so it applies to
// the next message rather than the next launch.
describe('the emoji auto-conversion setting', () => {
    const router = () => vi.fn(async (p) => {
        if (p === 'list') return { success: true, posts: [], typing: [], voice: [], hasMore: false };
        if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
        if (p === 'presence') return { success: true, members: [] };
        if (p === 'dm/threads') return { success: true, threads: [] };
        return { success: true };
    });
    const posted = (board) => {
        const call = board.mock.calls.find((c) => c[0] === 'post');
        return call && call[1].body.body;
    };

    // The switch is painted when the sheet opens, so that is where its state is
    // read from — the same as every other switch in there.
    const openSettings = async () => { $('btn-settings').click(); await settle(); };

    it('is on by default', async () => {
        await bootRenderer({ board: router() });
        await openSettings();
        expect($('set-emoticons').getAttribute('aria-checked')).toBe('true');
    });

    it('shows as off when it has been turned off', async () => {
        await bootRenderer({ board: router(), settings: { emojiAutoConvert: false } });
        await openSettings();
        expect($('set-emoticons').getAttribute('aria-checked')).toBe('false');
    });

    it('sends the emoticon untouched when it is off', async () => {
        const board = router();
        await bootRenderer({ board, settings: { emojiAutoConvert: false } });

        type('that is a shame :(');
        await settle();
        board.mockClear();
        $('composer').requestSubmit();
        await settle();

        expect(posted(board)).toBe('that is a shame :(');
    });

    it('takes effect on the next message, without a reload', async () => {
        const board = router();
        const { lounge } = await bootRenderer({ board, settings: { emojiAutoConvert: false } });

        $('set-emoticons').click();
        await settle();
        expect(lounge.settings.set).toHaveBeenCalledWith({ emojiAutoConvert: true });

        type('better now :)');
        await settle();
        board.mockClear();
        $('composer').requestSubmit();
        await settle();

        expect(posted(board)).toBe('better now 🙂');
    });
});
