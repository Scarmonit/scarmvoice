// @vitest-environment jsdom
//
// Ctrl+Up / Ctrl+Down in the message box, walking back through what you have
// already sent.
//
// The interesting decisions are all about NOT getting in the way:
//   • the chord is Ctrl+arrow rather than the bare arrows, because this box
//     holds multi-line messages and the arrows have to keep moving the caret;
//   • a half-written message is stashed on the way back and handed over again
//     on the way forward, so a stray Ctrl+Up costs nothing;
//   • both ends stop rather than wrap — wrapping is indistinguishable from a
//     keypress that did not register;
//   • the history is written to disk, so signing out has to take it with it.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { bootRenderer, settle, type, $ } from './helpers/renderer.js';

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

function press(key, opts = {}) {
    input().dispatchEvent(new window.KeyboardEvent('keydown', Object.assign({
        key, ctrlKey: true, bubbles: true, cancelable: true
    }, opts)));
}

async function send(text) {
    type(text);
    $('composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
}

beforeEach(() => { localStorage.clear(); });

describe('recalling a sent message', () => {
    it('brings back the last thing sent, then the one before it', async () => {
        await boot({ messageHistory: ['second', 'first'] });
        await settle();

        press('ArrowUp');
        expect(input().value).toBe('second');
        press('ArrowUp');
        expect(input().value).toBe('first');
    });

    it('comes forward again on Ctrl+Down', async () => {
        await boot({ messageHistory: ['second', 'first'] });
        await settle();

        press('ArrowUp');
        press('ArrowUp');
        expect(input().value).toBe('first');
        press('ArrowDown');
        expect(input().value).toBe('second');
    });

    // The one that decides whether the feature is safe to press by accident.
    it('hands back the half-written message on the way past the newest', async () => {
        await boot({ messageHistory: ['second', 'first'] });
        await settle();
        type('half a thought');

        press('ArrowUp');
        expect(input().value).toBe('second');
        press('ArrowDown');
        expect(input().value).toBe('half a thought');
    });

    // Wrapping round from the oldest entry back to the draft reads exactly like
    // a keypress that did not register.
    it('stops at both ends rather than wrapping', async () => {
        await boot({ messageHistory: ['b', 'a'] });
        await settle();

        press('ArrowUp'); press('ArrowUp'); press('ArrowUp'); press('ArrowUp');
        expect(input().value).toBe('a');

        press('ArrowDown'); press('ArrowDown'); press('ArrowDown');
        expect(input().value).toBe('');
    });

    it('does nothing with no history at all', async () => {
        await boot({ messageHistory: [] });
        await settle();
        type('typing');
        press('ArrowUp');
        expect(input().value).toBe('typing');
    });

    // Once the box has been edited it is the user's again: a later Ctrl+Down
    // must not overwrite it with a draft stashed before the walk began.
    it('ends the walk as soon as the box is edited', async () => {
        await boot({ messageHistory: ['second', 'first'] });
        await settle();
        type('mine');

        press('ArrowUp');
        expect(input().value).toBe('second');
        type('mine again');
        press('ArrowDown');
        expect(input().value).toBe('mine again');
    });

    it('leaves the caret at the end of what it recalled', async () => {
        await boot({ messageHistory: ['a longer message'] });
        await settle();
        press('ArrowUp');
        expect(input().selectionStart).toBe('a longer message'.length);
        expect(input().selectionEnd).toBe('a longer message'.length);
    });
});

describe('the keys it is deliberately not bound to', () => {
    it('leaves a plain arrow alone, so the caret still moves', async () => {
        await boot({ messageHistory: ['second', 'first'] });
        await settle();
        type('line one\nline two');

        press('ArrowUp', { ctrlKey: false });
        expect(input().value).toBe('line one\nline two');
    });

    // Shift+Ctrl+Up selects by line in a textarea. Alt is a window manager's.
    it('leaves Ctrl+Shift and Ctrl+Alt arrows alone', async () => {
        await boot({ messageHistory: ['second'] });
        await settle();
        type('untouched');

        press('ArrowUp', { shiftKey: true });
        expect(input().value).toBe('untouched');
        press('ArrowUp', { altKey: true });
        expect(input().value).toBe('untouched');
    });

    // The suggestion list handles the bare arrows, and used to take the
    // modified ones with them — it listens in the CAPTURE phase, ahead of the
    // composer, so an open @mention swallowed Ctrl+Up entirely.
    it('recalls even with the mention list open', async () => {
        await boot({ messageHistory: ['second'] });
        await settle();
        type('hey @a');
        await settle();

        press('ArrowUp');
        expect(input().value).toBe('second');
    });
});

describe('the toggle', () => {
    it('does nothing at all when it is off', async () => {
        await boot({ messageHistory: ['second', 'first'], messageRecall: false });
        await settle();
        type('mine');

        press('ArrowUp');
        expect(input().value).toBe('mine');
        press('ArrowDown');
        expect(input().value).toBe('mine');
    });

    // The switch is only ever seen inside the sheet, and opening the sheet is
    // what repaints every control in it from the settings that are now loaded.
    // Asserting before that would be asserting on the paint wireSwitch does at
    // module scope, before boot() has fetched anything.
    async function switchState() {
        $('btn-settings').click();
        await settle();
        return $('set-msg-recall').getAttribute('aria-checked');
    }

    // A settings file written before this feature existed has no such key. It
    // must read as the default the store declares, which is ON — and the switch
    // has to agree with the keys, because it asks the same question.
    it('is on for a settings blob that predates it', async () => {
        await boot({ messageHistory: ['second'] });
        await settle();
        expect(await switchState()).toBe('true');
        press('ArrowUp');
        expect(input().value).toBe('second');
    });

    it('paints itself off when the setting says so', async () => {
        await boot({ messageHistory: [], messageRecall: false });
        await settle();
        expect(await switchState()).toBe('false');
    });
});

describe('what gets remembered', () => {
    it('records a sent message, newest first', async () => {
        const h = await boot({ messageHistory: [] });
        await settle();
        await send('one');
        await send('two');

        const last = h.lounge.settings.set.mock.calls
            .map((c) => c[0]).filter((p) => p && p.messageHistory).pop();
        expect(last.messageHistory).toEqual(['two', 'one']);
    });

    // 25 entries is not many, and "the last 25 things I sent" is worth more than
    // 25 copies of "ok".
    it('moves a repeat to the front rather than filling a second slot', async () => {
        const h = await boot({ messageHistory: ['b', 'a'] });
        await settle();
        await send('a');

        const last = h.lounge.settings.set.mock.calls
            .map((c) => c[0]).filter((p) => p && p.messageHistory).pop();
        expect(last.messageHistory).toEqual(['a', 'b']);
    });

    it('keeps at most 25', async () => {
        const start = Array.from({ length: 25 }, (_, i) => 'm' + i);
        const h = await boot({ messageHistory: start });
        await settle();
        await send('newest');

        const last = h.lounge.settings.set.mock.calls
            .map((c) => c[0]).filter((p) => p && p.messageHistory).pop();
        expect(last.messageHistory.length).toBe(25);
        expect(last.messageHistory[0]).toBe('newest');
        expect(last.messageHistory).not.toContain('m24');
    });

    // An attachment with no message has nothing to bring back.
    it('records nothing for a send with no text', async () => {
        const h = await boot({ messageHistory: [] });
        await settle();
        type('');
        $('composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
        await settle();

        const wrote = h.lounge.settings.set.mock.calls
            .map((c) => c[0]).filter((p) => p && p.messageHistory);
        expect(wrote).toEqual([]);
    });

    it('starts the next walk from the message just sent', async () => {
        await boot({ messageHistory: ['old'] });
        await settle();
        await send('just now');

        press('ArrowUp');
        expect(input().value).toBe('just now');
    });
});
