// @vitest-environment jsdom
//
// The right-click menu for a text field, and the spelling suggestions on top of
// it.
//
// WHY THIS MENU IS OPENED BY MAIN. `spellcheck: true` has underlined misspellings
// in the composer since the app existed — on Windows 10+ Chromium uses the OS
// spellchecker, so there is no dictionary download and it works offline. What the
// app could never do was offer the CORRECTIONS, because the misspelled word and
// its suggestions exist only on main's `context-menu` event, and the renderer's
// own DOM `contextmenu` handler called preventDefault() to draw the app's styled
// menu instead. A cancelled contextmenu event stops Blink asking the browser
// process for a menu at all, so that event never fired: the red squiggle was a
// dead end you could not act on.
//
// So main sends everything the menu needs and the renderer only renders it. This
// file drives that push and checks what comes out; test/e2e/spellcheck.spec.js
// proves the halves it cannot see — that the event fires at all, that Chromium
// really flags the word, and that replaceMisspelling edits the textarea.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { bootRenderer, $, settle } from './helpers/renderer.js';

// One message in the channel, so the "a message is still not a text field" case
// below has a row to right-click without booting a second renderer into the same
// document.
const POST = {
    id: 1, body: 'hello', name: 'Alice', client_id: 'alice', user_id: 2,
    created_at: 1700000000000, reactions: [], pinned: 0
};

const router = () => vi.fn(async (p) => {
    if (p === 'list') return { success: true, posts: [POST], typing: [], voice: [], hasMore: false, maxId: 1 };
    if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
    if (p === 'presence') return { success: true, members: [] };
    if (p === 'dm/threads') return { success: true, threads: [] };
    return { success: true };
});

const menu = () => $('ctx-menu');
const labels = () => Array.from(menu().querySelectorAll('.ctx-label')).map((s) => s.textContent);
const itemFor = (label) => Array.from(menu().querySelectorAll('.ctx-item'))
    .find((b) => b.querySelector('.ctx-label') && b.querySelector('.ctx-label').textContent === label);
const disabled = (label) => !!(itemFor(label) && itemFor(label).disabled);

let h;
beforeEach(async () => {
    localStorage.clear();
    h = await bootRenderer({ board: router() });
    await settle();
});

describe('right-clicking a correctly spelled word', () => {
    it('offers the editing commands and nothing about spelling', async () => {
        h.rightClickField();
        await settle();

        expect(menu().hidden).toBe(false);
        expect(labels()).toEqual(['Cut', 'Copy', 'Paste', 'Select all']);
    });

    // Chromium's own answer, delivered with the click. It replaced a round trip to
    // read the clipboard, so the menu opens in one hop instead of two — and it
    // knows about image data, which a text-only check did not.
    it('greys out what the field cannot do', async () => {
        h.rightClickField({ canCut: false, canCopy: false, canPaste: false, canSelectAll: false });
        await settle();

        ['Cut', 'Copy', 'Paste', 'Select all'].forEach((l) => expect(disabled(l), l).toBe(true));
    });

    it('enables them when the field says it can', async () => {
        h.rightClickField({ canCut: true, canCopy: true, canPaste: true, canSelectAll: true });
        await settle();

        ['Cut', 'Copy', 'Paste', 'Select all'].forEach((l) => expect(disabled(l), l).toBe(false));
    });

    it('runs the native command rather than reimplementing it', async () => {
        h.rightClickField({ canPaste: true });
        await settle();

        itemFor('Paste').click();
        await settle();
        expect(h.lounge.edit.paste).toHaveBeenCalled();
    });

    it('opens where the click was', async () => {
        h.rightClickField({ x: 240, y: 310 });
        await settle();
        // params.x/y are CSS pixels relative to the page — i.e. exactly
        // clientX/clientY, verified against a real right-click in the e2e spec.
        expect(menu().style.left).toBe('240px');
        expect(menu().style.top).toBe('310px');
    });
});

describe('right-clicking a misspelled word', () => {
    const MISSPELLED = {
        misspelledWord: 'mispelled',
        suggestions: ['misspelled', 'dispelled'],
        canCut: true, canCopy: true, canPaste: true, canSelectAll: true
    };

    it('lists the corrections above the editing commands', async () => {
        h.rightClickField(MISSPELLED);
        await settle();

        expect(labels()).toEqual([
            'misspelled', 'dispelled', 'Add to dictionary',
            'Cut', 'Copy', 'Paste', 'Select all'
        ]);
    });

    // Bold, because the label is a WORD that will be inserted rather than the name
    // of a command. It is where and how every browser draws them, and it is what
    // stops two suggestions reading as two more menu commands.
    it('draws them as content, not as commands', async () => {
        h.rightClickField(MISSPELLED);
        await settle();

        expect(itemFor('misspelled').classList.contains('strong')).toBe(true);
        expect(itemFor('Cut').classList.contains('strong')).toBe(false);
    });

    it('replaces the word through the native command when one is clicked', async () => {
        h.rightClickField(MISSPELLED);
        await settle();

        itemFor('dispelled').click();
        await settle();

        expect(h.lounge.edit.replaceMisspelling).toHaveBeenCalledWith('dispelled');
        // Chromium's editing command, not a hand-rolled splice: it acts on the
        // selection the renderer is already showing, fires a real `input` event and
        // lands on the undo stack. See the handler in main.js.
        expect(h.lounge.edit.paste).not.toHaveBeenCalled();
        expect(menu().hidden).toBe(true);
    });

    it('closes the menu after correcting', async () => {
        h.rightClickField(MISSPELLED);
        await settle();
        itemFor('misspelled').click();
        await settle();
        expect(menu().hidden).toBe(true);
    });

    it('teaches the dictionary a word, and says it did', async () => {
        h.rightClickField(MISSPELLED);
        await settle();

        itemFor('Add to dictionary').click();
        await settle();

        expect(h.lounge.edit.addToDictionary).toHaveBeenCalledWith('mispelled');
        expect($('toast').textContent).toContain('mispelled');
        expect($('toast').hidden).toBe(false);
    });

    it('stays quiet when the dictionary refuses the word', async () => {
        h.lounge.edit.addToDictionary.mockImplementation(async () => false);
        h.rightClickField(MISSPELLED);
        await settle();

        itemFor('Add to dictionary').click();
        await settle();

        expect($('toast').hidden).toBe(true);
    });

    // Chromium finds nothing for a bad enough typo, and for a name it finds nothing
    // at all. A menu that silently looks like any other leaves the reader wondering
    // whether the click missed; saying so also keeps "Add to dictionary" in the
    // same place either way, which is the item they actually want in that case.
    it('says so when there are no corrections to offer', async () => {
        h.rightClickField({ misspelledWord: 'Scarmonit', suggestions: [] });
        await settle();

        expect(labels()).toEqual([
            'No suggestions', 'Add to dictionary',
            'Cut', 'Copy', 'Paste', 'Select all'
        ]);
        expect(disabled('No suggestions')).toBe(true);
        expect(disabled('Add to dictionary')).toBe(false);
    });

    it('caps a pathological list so the commands stay reachable', async () => {
        // main slices to five; this pins the renderer not to grow it back.
        h.rightClickField({
            misspelledWord: 'x',
            suggestions: ['a', 'b', 'c', 'd', 'e']
        });
        await settle();
        expect(labels().slice(0, 5)).toEqual(['a', 'b', 'c', 'd', 'e']);
        expect(labels()).toContain('Select all');
    });
});

describe('the menu and the field it belongs to', () => {
    // #ctx-menu prevents its own mousedown so it never takes focus, which is what
    // lets a native editing command land on the field that was right-clicked. The
    // menu re-focuses it anyway before running one: the invariant is a repaint away
    // from not holding, and the failure mode is a menu item that silently does
    // nothing at all.
    it('puts focus back on the field before running a command', async () => {
        const input = $('composer-input');
        input.focus();
        expect(document.activeElement).toBe(input);

        h.rightClickField({ canPaste: true });
        await settle();

        // Something else steals focus while the menu is open.
        $('btn-send').focus();
        itemFor('Paste').click();
        await settle();

        expect(document.activeElement).toBe(input);
        expect(h.lounge.edit.paste).toHaveBeenCalled();
    });

    it('survives the field being removed while the menu is open', async () => {
        const scratch = document.createElement('input');
        document.body.appendChild(scratch);
        scratch.focus();

        h.rightClickField({ canPaste: true });
        await settle();

        scratch.remove();                 // a repaint took the field away
        expect(() => itemFor('Paste').click()).not.toThrow();
        await settle();
        expect(h.lounge.edit.paste).toHaveBeenCalled();
    });
});

// The menu the app draws for a MESSAGE is unchanged: those rows cancel their own
// contextmenu event, so main never hears about them and never pushes anything.
// Worth pinning, because the fix moved the editable-field menu onto a channel
// that a message row must not start arriving on.
describe('a message is still not a text field', () => {
    it('opens its own menu from its own DOM handler', async () => {
        const row = $('messages').querySelector('.msg[data-id="1"]');
        expect(row, 'the fixture message should be rendered').toBeTruthy();

        const ev = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        row.dispatchEvent(ev);

        // Cancelled here, which is exactly why main never sees it — and so the
        // editable-field push this feature added can never fire for a message.
        expect(ev.defaultPrevented).toBe(true);
        expect(labels()).toContain('Reply');
        expect(labels()).not.toContain('Paste');
    });
});
