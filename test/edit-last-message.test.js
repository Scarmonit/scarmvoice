// @vitest-environment jsdom
//
// Up-arrow editing: an empty message box and Up opens the last thing you said,
// Up again walks back through the ones before it, Down comes forward and
// eventually hands the keyboard back to the composer.
//
// The whole design is about NOT taking the key away from anything that already
// has a claim on it — the caret in a half-written message, the @mention
// suggestion list, a multi-line message inside the edit box itself — so most of
// what is pinned here is the cases where Up must go on meaning "up".
import { describe, it, expect, vi } from 'vitest';
import { bootRenderer, settle, type, $, cmEditor, composerInput } from './helpers/renderer.js';

const ME = { id: 1, username: 'Me', role: 'member' };
const THEM = { id: 2, username: 'Alice', role: 'member' };

const post = (id, user, body, over) => Object.assign({
    id, body, name: user.username, client_id: 'c' + user.id, user_id: user.id,
    created_at: 1700000000000 + id * 1000, reactions: [], pinned: 0
}, over || {});

// Two of mine with one of theirs between them, so "the next one back" cannot
// pass by accident.
const POSTS = [
    post(1, ME, 'my oldest'),
    post(2, THEM, 'not mine'),
    post(3, ME, 'my middle'),
    post(4, ME, 'my newest')
];

const PAIR = { id: 40, title: 'Alice', isGroup: false, user: THEM, members: [ME, THEM], unread: 0 };

function router(over = {}) {
    return vi.fn(async (p, o) => {
        if (p === 'list') {
            return { success: true, posts: over.posts || POSTS, typing: [], voice: [], hasMore: false, maxId: 4 };
        }
        if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
        if (p === 'presence') return { success: true, members: [] };
        if (p === 'dm/threads') return { success: true, threads: over.threads || [] };
        if (p === 'dm/list') {
            return { success: true, thread: PAIR, messages: over.dms || [], hasMore: false };
        }
        if (p === 'edit') { (over.edits || []).push(o.body); return { success: true }; }
        if (p === 'dm/message') { (over.edits || []).push(o.body); return { success: true }; }
        return { success: true };
    });
}

// The chord lives in the EDITOR'S KEYMAP, which is what the editor consults —
// jsdom's synthetic key events carry none of the codes CodeMirror maps from.
// Same approach as message-recall.test.js.
const press = (name) => {
    const fn = cmEditor().getOption('extraKeys')[name];
    return fn ? fn(cmEditor()) : 'unbound';
};

const editor = () => document.querySelector('.msg-edit textarea');
const editingRow = () => {
    const w = document.querySelector('.msg-edit');
    return w ? w.closest('.msg').dataset.id : null;
};

// An arrow inside the edit box, the way a person presses it: the caret goes
// where the key implies first, because that is what the handler asks about.
function pressInEditor(key, caret) {
    const ta = editor();
    const at = caret === 'end' ? ta.value.length : (caret === 'start' ? 0 : caret);
    ta.setSelectionRange(at, at);
    const ev = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    ta.dispatchEvent(ev);
    return ev;
}

describe('Up in an empty composer edits your last message', () => {
    it('opens the most recent message you sent', async () => {
        await bootRenderer({ board: router(), user: ME });
        await settle(20);

        expect(press('Up')).not.toBe('unbound');
        expect(editingRow()).toBe('4');
        expect(editor().value).toBe('my newest');
    });

    it('walks back past other people to the next message of yours', async () => {
        await bootRenderer({ board: router(), user: ME });
        await settle(20);

        press('Up');
        expect(editingRow()).toBe('4');
        pressInEditor('ArrowUp', 'start');
        await settle(4);
        expect(editingRow()).toBe('3');       // 2 is Alice's
        expect(editor().value).toBe('my middle');
        pressInEditor('ArrowUp', 'start');
        await settle(4);
        expect(editingRow()).toBe('1');
        expect(editor().value).toBe('my oldest');
    });

    it('stops at the oldest rather than wrapping round', async () => {
        await bootRenderer({ board: router(), user: ME });
        await settle(20);

        press('Up');
        pressInEditor('ArrowUp', 'start');
        await settle(4);
        pressInEditor('ArrowUp', 'start');
        await settle(4);
        expect(editingRow()).toBe('1');
        const ev = pressInEditor('ArrowUp', 'start');
        await settle(4);
        expect(editingRow()).toBe('1');        // still there
        expect(ev.defaultPrevented).toBe(false);   // and the caret keeps the key
    });

    it('comes forward on Down, and out to the composer past the newest', async () => {
        await bootRenderer({ board: router(), user: ME });
        await settle(20);

        press('Up');
        pressInEditor('ArrowUp', 'start');
        await settle(4);
        expect(editingRow()).toBe('3');
        pressInEditor('ArrowDown', 'end');
        await settle(4);
        expect(editingRow()).toBe('4');
        pressInEditor('ArrowDown', 'end');
        await settle(4);
        expect(editingRow()).toBe(null);       // no editor left open
        expect(document.querySelector('.msg-edit')).toBe(null);
    });

    it('saves from wherever the walk stopped', async () => {
        const edits = [];
        await bootRenderer({ board: router({ edits }), user: ME });
        await settle(20);

        press('Up');
        pressInEditor('ArrowUp', 'start');
        await settle(4);
        const ta = editor();
        ta.value = 'my middle, fixed';
        ta.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await settle(10);

        expect(edits.map((e) => [e.id, e.body])).toEqual([[3, 'my middle, fixed']]);
    });
});

describe('Up stays the caret key everywhere it should', () => {
    it('does nothing when there is text in the box', async () => {
        await bootRenderer({ board: router(), user: ME });
        await settle(20);

        type('half a thought');
        await settle(2);
        expect(press('Up')).toBe(window.CodeMirror.Pass);
        expect(document.querySelector('.msg-edit')).toBe(null);
        expect(composerInput().value).toBe('half a thought');
    });

    it('does nothing when you have written nothing in this channel', async () => {
        await bootRenderer({ board: router({ posts: [post(9, THEM, 'only theirs')] }), user: ME });
        await settle(20);

        expect(press('Up')).toBe(window.CodeMirror.Pass);
        expect(document.querySelector('.msg-edit')).toBe(null);
    });

    it('never opens somebody else\'s message, even for an admin', async () => {
        const ADMIN = { id: 1, username: 'Me', role: 'admin' };
        await bootRenderer({
            board: router({ posts: [post(9, THEM, 'only theirs')] }), user: ADMIN
        });
        await settle(20);

        expect(press('Up')).toBe(window.CodeMirror.Pass);
        expect(document.querySelector('.msg-edit')).toBe(null);
    });

    it('leaves a multi-line edit alone until the caret is on the first line', async () => {
        await bootRenderer({
            board: router({ posts: [post(5, ME, 'line one\nline two')] }), user: ME
        });
        await settle(20);

        press('Up');
        expect(editor().value).toBe('line one\nline two');
        // Caret on the second line: the arrow belongs to the caret.
        const ev = pressInEditor('ArrowUp', 'end');
        await settle(4);
        expect(ev.defaultPrevented).toBe(false);
        expect(editingRow()).toBe('5');
    });

    it('will not walk away from an edit that has been typed into', async () => {
        await bootRenderer({ board: router(), user: ME });
        await settle(20);

        press('Up');
        expect(editingRow()).toBe('4');
        editor().value = 'my newest, half rewritten';
        const ev = pressInEditor('ArrowUp', 'start');
        await settle(4);
        expect(ev.defaultPrevented).toBe(false);
        expect(editingRow()).toBe('4');
        expect(editor().value).toBe('my newest, half rewritten');
    });
});

describe('Up in a conversation edits the conversation', () => {
    it('opens your last DM, not your last channel message', async () => {
        const dms = [
            { id: 501, from: THEM.id, body: 'their dm', created_at: 1700000000000 },
            { id: 502, from: ME.id, body: 'my dm', created_at: 1700000060000 }
        ];
        await bootRenderer({ board: router({ threads: [PAIR], dms }), user: ME });
        await settle(20);
        $('dm-list').querySelectorAll('.dm-row')[0].click();
        await settle(20);

        press('Up');
        expect(editingRow()).toBe('502');
        expect(editor().value).toBe('my dm');
        // …and in the conversation column, not the channel list behind it.
        expect($('dm-messages').querySelector('.msg-edit')).not.toBe(null);
        expect($('messages').querySelector('.msg-edit')).toBe(null);
    });

    it('does nothing in the DM view with no conversation picked', async () => {
        // The channel list is behind the panel. An editor opened into it would
        // be invisible AND permanent: renderMessages() refuses to repaint while
        // a .msg-edit exists, and nothing on screen could close this one.
        await bootRenderer({ board: router({ threads: [PAIR] }), user: ME });
        await settle(20);
        $('rail-dms').click();
        await settle(20);
        $('dm-close').click();
        await settle(10);

        expect(press('Up')).toBe(window.CodeMirror.Pass);
        expect(document.querySelector('.msg-edit')).toBe(null);
    });

    it('skips a message still in flight — there is no server row to edit', async () => {
        const dms = [{ id: 501, from: ME.id, body: 'landed', created_at: 1700000000000 }];
        let release = null;
        const base = router({ threads: [PAIR], dms });
        const board = vi.fn(async (p, o) => {
            if (p === 'dm/send') { await new Promise((r) => { release = r; }); return { success: true, id: 502 }; }
            return base(p, o);
        });
        await bootRenderer({ board, user: ME });
        await settle(20);
        $('dm-list').querySelectorAll('.dm-row')[0].click();
        await settle(20);

        type('still sending');
        await settle(2);
        $('composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
        await settle(6);
        expect($('dm-messages').innerHTML).toContain('still sending');   // it IS on screen

        press('Up');
        expect(editingRow()).toBe('501');       // the confirmed one, not the echo
        if (release) release();
    });
});
