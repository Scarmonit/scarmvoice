// @vitest-environment jsdom
//
// Regressions found by the 0.75 audit pass. One describe per defect, each named
// after what the user saw rather than after the code that was wrong.
//
// The three main-process defects in the same pass are asserted in
// test/audit-0.75-main.test.js, which reads source rather than booting a DOM.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootRenderer, $, settle, type } from './helpers/renderer.js';

const RENDERER = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');

const POST = (over = {}) => Object.assign({
    id: 1, body: 'hello', name: 'Alice', client_id: 'alice', user_id: 2,
    created_at: 1700000000000, reactions: [], pinned: 0
}, over);

function router(over = {}) {
    return vi.fn(async (p, opts) => {
        if (over[p]) return over[p](opts);
        if (p === 'list') return { success: true, posts: [POST()], typing: [], voice: [], hasMore: false, maxId: 1 };
        if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
        if (p === 'presence') return { success: true, members: [] };
        if (p === 'account/users') return { success: true, users: [{ id: 1, username: 'Me', role: 'member' }] };
        if (p === 'dm/threads') return { success: true, threads: [] };
        return { success: true };
    });
}

beforeEach(() => {
    localStorage.clear();
});

// ONE MESSAGE COULD STOP THE WHOLE CHANNEL DRAWING.
//
// renderFormatted() recursed once per formatted span on a LINE, not per level of
// nesting, and the composer has no maxlength — the only ceiling is the server's
// 250,000-character MAX_BODY. So a single line of `*a*` repeated enough times
// overflowed the stack, and the RangeError escaped renderMessage, renderMessages
// and the poll with nothing on that path catching it: the offending row never
// appeared, NOR did anything after it, and every later poll threw in the same
// place. Anyone could wedge a channel for everyone in it.
describe('a very long line of formatting still renders', () => {
    // Its own timeout. This one deliberately renders sixty thousand characters
    // into twenty thousand elements — that is the whole point of it — and it
    // lands near the 5s default, so under a full parallel run whether it passed
    // depended on how loaded the machine was rather than on anything about the
    // recursion. The number is not a claim about speed.
    it('draws a message with far more spans than the stack has frames', async () => {
        const board = router({
            list: () => ({
                success: true, typing: [], voice: [], hasMore: false, maxId: 2,
                posts: [POST({ id: 2, body: '*a*'.repeat(20000) })]
            })
        });
        await bootRenderer({ board });
        await settle(20);

        const row = document.querySelector('#messages .msg[data-id="2"]');
        expect(row).toBeTruthy();
        expect(row.querySelectorAll('em').length).toBe(20000);
    }, 20000);

    // The real damage was collateral: the throw took the rest of the render with
    // it, so an ordinary message below the offending one vanished too.
    it('does not take the messages after it down as well', async () => {
        const board = router({
            list: () => ({
                success: true, typing: [], voice: [], hasMore: false, maxId: 4,
                posts: [
                    POST({ id: 3, body: '*a*'.repeat(20000) }),
                    POST({ id: 4, body: 'a perfectly ordinary message' })
                ]
            })
        });
        await bootRenderer({ board });
        await settle(20);

        expect(document.querySelector('#messages .msg[data-id="4"]')).toBeTruthy();
    }, 20000);

    // Nesting is what the recursion is FOR, and it still has to work.
    it('still nests one format inside another', async () => {
        const board = router({
            list: () => ({
                success: true, typing: [], voice: [], hasMore: false, maxId: 5,
                posts: [POST({ id: 5, body: '**bold _and italic_ here**' })]
            })
        });
        await bootRenderer({ board });
        await settle(20);

        const row = document.querySelector('#messages .msg[data-id="5"]');
        expect(row.querySelector('strong em')).toBeTruthy();
    });
});

// TYPING `constructor:` KILLED THE SEARCH BOX.
//
// SEARCH_OPS and HAS_KINDS were plain object literals indexed with a key the user
// typed, and `constructor` is a key every plain object has. It passed the "is
// this an operator?" guard as the Object function, then `(ops[k] = ops[k] ||
// []).push(v)` called .push on Object. The TypeError escaped the input listener,
// so the dropdown never repainted and the debounce that runs the search was never
// armed — the box stayed dead until the token was deleted.
describe('an operator that is only an Object property is not an operator', () => {
    const lib = () => window.ScarmLib;

    it('does not throw on constructor:', async () => {
        await bootRenderer({ board: router() });
        expect(() => lib().parseSearchQuery('constructor:foo hello')).not.toThrow();
    });

    it('leaves it in the text, like any other non-operator', async () => {
        await bootRenderer({ board: router() });
        const { text, ops } = lib().parseSearchQuery('constructor:foo hello');
        expect(text).toBe('constructor:foo hello');
        // Own property, not `ops.constructor` — `ops` is an ordinary object and
        // always inherits that one. The defect was never that the name resolves;
        // it was that the parser TREATED it as an operator and then wrote to it.
        expect(Object.prototype.hasOwnProperty.call(ops, 'constructor')).toBe(false);
    });

    it('does not offer completions for it at the caret', async () => {
        await bootRenderer({ board: router() });
        expect(lib().opAtCaret('constructor:fo', 14)).toBeNull();
    });

    // has:constructor resolved to the Object function, went into filter.types as
    // if it were a content kind, and matched nothing — so every message was
    // rejected and the column showed "No loaded messages match these filters".
    it('does not let has:constructor empty the whole list', async () => {
        await bootRenderer({ board: router() });
        expect(lib().HAS_KINDS.constructor).toBeUndefined();
    });

    it('still answers the operators that are real', async () => {
        await bootRenderer({ board: router() });
        const { text, ops } = lib().parseSearchQuery('from:alice has:image hello');
        expect(text).toBe('hello');
        expect(ops.from).toEqual(['alice']);
        expect(ops.has).toEqual(['image']);
    });
});

// SIGNING OUT LEFT THE PREVIOUS ACCOUNT'S MESSAGE IN THE BOX.
//
// teardownSession() clears the stashed drafts, the thread drafts, the channel
// cache, the watermarks and the outbox, all with the stated reasoning that the
// next person to use this machine must not find them. The composer actually ON
// SCREEN was never in that list, and enterApp() does not reset it either — so
// the next account inherited the previous one's text, its staged files and its
// reply chip, and one Enter would have posted them under the new credential.
describe('signing out empties the composer that is on screen', () => {
    it('does not hand the next account the previous one\'s text', async () => {
        const board = router();
        const h = await bootRenderer({ board });

        type('payroll numbers attached, do not forward');
        await settle();
        expect($('composer-input').value).not.toBe('');

        // The account-token path: net answers "you need an account", which is
        // one of the two ways every background call reaches teardownSession().
        board.mockImplementation(async () => ({ success: false, needsAccount: true }));
        h.resync();
        await settle(20);

        expect($('composer-input').value).toBe('');
    });
});

// A DEAFENED PERSON SHOWED NO HEADSET BADGE UNLESS YOU WERE PEERED WITH THEM.
//
// renderVoiceRoster builds a row from the presence table for anyone with no SFU
// entry — which is EVERY row when you have not joined the call. That branch
// carried `muted` across and simply dropped `deafened`, though the payload has
// both and both are drawn.
describe('the headset-off badge appears for somebody you are not peered with', () => {
    it('carries deafened off the presence row, the way it carries muted', async () => {
        const board = router({
            list: () => ({
                success: true, posts: [], typing: [], hasMore: false, maxId: 0,
                voice: [{ client_id: 'bob', name: 'Bob', user_id: 3, muted: 0, deafened: 1 }]
            })
        });
        await bootRenderer({ board, voice: { isJoined: () => false } });
        await settle(20);

        const row = document.querySelector('#voice-users .vp[data-cid="bob"]');
        expect(row).toBeTruthy();
        expect(row.querySelector('[title="Deafened"]')).toBeTruthy();
    });
});

// THE STYLESHEET SAID A THING TWICE AND MEANT THE OLDER ONE.
//
// Two rules of equal specificity, later wins — so in both cases the redesign was
// dead and the superseded rule was what shipped. The .pinned-title comment in
// styles.css already describes this exact trap; these two were the ones still in
// it.
describe('no rule is defeated by an older copy of itself', () => {
    let css = '';
    beforeEach(() => {
        css = fs.readFileSync(path.join(RENDERER, 'styles.css'), 'utf8').replace(/\r\n/g, '\n');
    });

    // At rest the DM finder is a filled --input plate with --author text. The
    // stale copy repainted hover as --hover over the sidebar and dropped the
    // label to --muted, so the primary way into a conversation got DARKER and
    // dimmer under the cursor and read as disabled.
    it('lifts the conversation finder on hover, once', () => {
        expect(css.match(/#dm-find:hover/g)).toHaveLength(1);
        expect(css).toMatch(/#dm-find:hover \{ background: var\(--elev\); \}/);
    });

    // The update card's own 17px/2.2 glyph was overridden by a 15px/2.4 leftover
    // in the generic icon-size section, leaving an undersized, heavier glyph
    // floating in a 30px disc.
    it('sizes the update-card icon from the card, once', () => {
        expect(css.match(/\.ub-icon \.ico \{/g)).toHaveLength(1);
        expect(css).toMatch(/\.ub-icon \.ico \{ width: 17px; height: 17px; stroke-width: 2\.2; \}/);
    });

    // One class name, two unrelated widgets: the settings <button role="switch">
    // with a .switch-knob, and the popover's <span> wrapping a checkbox and an
    // <i>. The settings block is later in the file, so it resized the popover's
    // switch to 48x24 and put a border round it — while that widget's knob
    // travel is a hard-coded translateX(16px) drawn for a 38px track, leaving a
    // fully-on toggle parked mid-way.
    it('keeps the settings switch off the popover\'s switch', () => {
        expect(css).toMatch(/button\.switch \{[^}]*width: 48px/);
        expect(css).toMatch(/\n\.switch \{ position: relative; flex: 0 0 38px/);
    });
});
