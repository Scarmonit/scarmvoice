// @vitest-environment jsdom
//
// DOUBLE-TAP ESCAPE CLEARS THE MESSAGE BOX.
//
// The shortcut is a few lines; this file is long because Escape already means
// eight other things in this app and none of them may change. So the
// interesting assertions are the negative ones: with a menu, a modal, an
// autocomplete or an open editor up, two Escapes must leave the typed message
// exactly where it was.
//
// The guarantee is structural rather than a list kept in step by hand — the
// clear is one branch of the ONE Escape chain, below every surface that chain
// knows about, so a press that dismissed something is never half of a
// double-tap. It outranks only the drawers, and only while the caret is in a
// box with something in it: there is a single composer and it MOVES into the DM
// drawer, so without that rank the feature would work in channels and nowhere
// else.
//
// Because a keystroke that throws away a long message is a trap without a way
// back, the clear goes through the editor's own undo history: Ctrl+Z restores
// it.
//
// ONE renderer, booted once. bootRenderer cannot shut an instance down, and a
// second one builds a second CodeMirror into the same container and a second
// set of document key listeners — so a file that boots per test is testing a
// keyboard chain against whichever instance happens to answer first.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootRenderer, settle, cmEditor, $ } from './helpers/renderer.js';

const RENDERER = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');

const ME = { id: 1, username: 'Me', role: 'member' };
const ALICE = { id: 2, username: 'Alice', role: 'member' };
const PAIR = { id: 40, title: 'Alice', isGroup: false, user: ALICE, members: [ME, ALICE], unread: 0 };

const POST = {
    id: 501, body: 'something to edit', name: 'Me', client_id: 'me', user_id: 1,
    created_at: 1700000000000, reactions: [], pinned: 0
};

const board = vi.fn(async (route) => {
    const p = String(route).split('?')[0];
    if (p === 'list') return { success: true, posts: [POST], typing: [], voice: [], hasMore: false, maxId: 501 };
    if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
    if (p === 'presence') {
        return { success: true, members: [{ client_id: 'alice', user_id: 2, name: 'Alice', status: 'online', custom: '' }] };
    }
    if (p === 'account/users') return { success: true, users: [ME, ALICE] };
    if (p === 'dm/threads') return { success: true, threads: [PAIR] };
    if (p === 'dm/list') return { success: true, thread: PAIR, messages: [] };
    return { success: true };
});

// Type into the composer the way a person does — an insert carrying the
// '+input' origin, which is what a keystroke looks like from the app's side —
// and leave the caret after it.
function put(text) {
    const cm = cmEditor();
    cm.setValue('');
    cm.replaceRange(String(text), { line: 0, ch: 0 }, null, '+input');
    focusComposer();
    return cm;
}

// jsdom moves focus for a real focus() on the element; CodeMirror's hasFocus()
// reads document.activeElement, so this is what makes the box "the one being
// typed in".
function focusComposer() { cmEditor().getInputField().focus(); }

const esc = (target) => (target || document.body).dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

async function escTwice(target) {
    esc(target);
    await settle(1);
    esc(target);
    await settle(2);
}

const boxText = () => cmEditor().getValue();

beforeAll(async () => {
    await bootRenderer({ user: ME, board });
    await settle(8);
});

beforeEach(async () => {
    // A clean box AND a clean undo history, so one test's undo cannot reach
    // into the message another one typed.
    const cm = cmEditor();
    cm.setValue('');
    cm.clearHistory();
    document.body.focus();
    // …and a DISARMED double-tap. One instance serves the whole file, so a
    // test that ended on a single Escape would otherwise leave the next one's
    // first press looking like the second half of a double-tap. Escape over an
    // EMPTY box falls to the end of the chain, which is exactly where the timer
    // is dropped — and on the way it closes anything a previous test left up.
    for (let i = 0; i < 3; i++) { esc(document.body); await settle(1); }
});

afterEach(() => { vi.useRealTimers(); });

describe('double-tapping Escape in the message box', () => {
    it('clears what was typed', async () => {
        put('a message I no longer want');
        await escTwice(cmEditor().getInputField());
        expect(boxText()).toBe('');
    });

    it('leaves a single Escape alone', async () => {
        put('still here');
        esc(cmEditor().getInputField());
        await settle(2);
        expect(boxText()).toBe('still here');
    });

    it('does not count two presses far apart as a double-tap', async () => {
        put('still here');
        esc(cmEditor().getInputField());
        await settle(1);
        // Well past the window. Only the CLOCK is faked, so settle() still runs.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(Date.now() + 4000));
        esc(cmEditor().getInputField());
        await settle(2);
        expect(boxText()).toBe('still here');
    });

    it('does nothing when the caret is somewhere else', async () => {
        put('typed, then clicked away');
        $('search-input').focus();
        await escTwice($('search-input'));
        expect(boxText()).toBe('typed, then clicked away');
    });

    it('does not stay armed from Escapes pressed over an empty box', async () => {
        // An empty box takes no part in this — those presses fall straight past
        // the branch, so Escape still means whatever it meant before — and they
        // must not leave the timer armed either, or the FIRST Escape after
        // typing something would clear it.
        focusComposer();
        await escTwice(cmEditor().getInputField());

        put('typed after all those Escapes');
        esc(cmEditor().getInputField());
        await settle(2);

        expect(boxText()).toBe('typed after all those Escapes');
    });
});

describe('Ctrl+Z after an accidental clear', () => {
    it('brings the message back', async () => {
        put('the long message I did not mean to throw away');
        await escTwice(cmEditor().getInputField());
        expect(boxText()).toBe('');

        // The editor's own undo, which is what Ctrl+Z runs — and it can only
        // work because the clear was an EDIT rather than a setValue.
        cmEditor().execCommand('undo');
        await settle(2);

        expect(boxText()).toBe('the long message I did not mean to throw away');
    });

    it('puts the send button back with it', async () => {
        put('worth sending');
        await escTwice(cmEditor().getInputField());
        expect($('btn-send').disabled).toBe(true);

        cmEditor().execCommand('undo');
        await settle(3);

        expect($('btn-send').disabled).toBe(false);
    });
});

describe('everything Escape already did', () => {
    it('dismisses an open autocomplete instead, and that press does not count', async () => {
        put('@Ali');
        await settle(2);
        const pop = document.querySelector('.mention-pop');
        expect(pop && !pop.hidden, 'the mention list did not open').toBe(true);

        // The first Escape dismisses the list — and because the branch that
        // arms the timer never ran, the second is only the FIRST half of a
        // double-tap.
        await escTwice(cmEditor().getInputField());

        expect(pop.hidden).toBe(true);
        expect(boxText()).toBe('@Ali');
    });

    it('closes a modal instead, and that press does not count', async () => {
        put('mid-message');
        $('btn-settings').click();
        await settle(6);
        expect($('settings').hidden).toBe(false);

        await escTwice(document.body);

        expect($('settings').hidden).toBe(true);
        expect(boxText()).toBe('mid-message');
    });

    it('closes the message menu instead', async () => {
        put('mid-message');
        $('messages').querySelector('.msg[data-id="501"]')
            .dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
        await settle(3);
        expect($('ctx-menu').hidden).toBe(false);

        await escTwice(document.body);

        expect($('ctx-menu').hidden).toBe(true);
        expect(boxText()).toBe('mid-message');
    });

    // An open inline editor is guarded TWICE over, and both guards are pinned
    // rather than the drawn editor — which cannot be held still here, because a
    // repaint between opening it and pressing a key detaches the row it was
    // built into and the test ends up asserting against a node nothing is
    // listening to.
    //
    //   • Escape inside the editor stops propagating, so the document's chain —
    //     and therefore this branch — never runs at all.
    //   • Even if it did, the caret is in the EDIT box, not the composer, and
    //     the branch asks for the composer's focus. That half is covered
    //     behaviourally by "does nothing when the caret is somewhere else".
    it('cannot fire while an inline editor is open', async () => {
        const src = fs.readFileSync(
            path.join(RENDERER, 'app.js'), 'utf8');
        const at = src.indexOf('// Inline editor: Enter saves, Shift+Enter newlines, Esc cancels.');
        expect(at, 'the inline editor moved; this spec needs re-pointing').toBeGreaterThan(-1);
        const editor = src.slice(at, at + 4000);
        const escLine = editor.split('\n').find((l) => l.includes("e.key === 'Escape'"));
        expect(escLine, 'the editor no longer handles Escape').toBeTruthy();
        expect(escLine).toContain('stopPropagation');
    });
});

// Last, because opening a conversation moves the composer into the drawer and
// this file has nothing after it that needs the channel back.
describe('in a conversation', () => {
    it('clears the message there too', async () => {
        const row = $('dm-list').querySelector('.dm-row');
        expect(row, 'no conversation row to open').toBeTruthy();
        row.click();
        await settle(16);
        expect($('dm-panel').hidden, 'the conversation did not open').toBe(false);

        put('half a reply');
        await escTwice(cmEditor().getInputField());

        expect(boxText()).toBe('');
        // …and the conversation is still open: Escape was about the message.
        expect($('dm-panel').hidden).toBe(false);
    });
});
