// @vitest-environment jsdom
//
// "Drop to upload" — which drags it is for, and which it is emphatically not.
//
// The overlay used to appear for a picture that was ALREADY IN THE CHAT: pick
// one up off the message list to look at it, or to drag it out to the desktop,
// and the whole app offered to upload the file you were already looking at.
//
// The cause is that an in-page image drag and an image dragged in from a
// browser are the same drag by every visible measure — text/html plus
// text/uri-list, no 'Files' — so nothing about the payload can tell them
// apart. Only where the gesture STARTED can, which is what the marker type
// asserted below records.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { bootRenderer, $, settle } from './helpers/renderer.js';

const MARK = 'application/x-scarmvoice-internal';

// A stand-in for the real thing: jsdom has no DataTransfer, and the app only
// ever reads `types` on the way in. setData appends the way a real drag data
// store does, which is the behaviour the fix depends on.
function transfer(types) {
    return {
        types: [...types],
        files: [],
        items: [],
        getData: () => '',
        setData(type) { if (!this.types.includes(type)) this.types.push(type); }
    };
}

function fire(type, dt, target = window) {
    const e = new window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'dataTransfer', { value: dt, configurable: true });
    target.dispatchEvent(e);
    return e;
}

// The drag left the window — relatedTarget null is how the app tells that
// apart from crossing between two elements inside it.
function leaveWindow() {
    const e = new window.Event('dragleave', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'relatedTarget', { value: null, configurable: true });
    Object.defineProperty(e, 'dataTransfer', { value: transfer([]), configurable: true });
    window.dispatchEvent(e);
}

// The app ignores a second drop within 50ms of the first, because Electron has
// delivered the same one to both the window and the document depending on the
// version. Two drops in two tests land well inside that, so wait it out rather
// than letting the guard eat the event under test.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function drop(dt) {
    await wait(60);
    fire('drop', dt);
}

const overlayUp = () => !$('drop-hint').hidden;
const staged = () => $('upload-list').textContent.trim();

// An image being dragged, as Chromium describes one — from a browser window or
// from our own message list, identically.
const IMAGE_DRAG = ['text/html', 'text/uri-list', 'text/plain'];

beforeAll(async () => {
    const board = vi.fn(async (p) => {
        const key = String(p).split('?')[0];
        if (key === 'list') return { success: true, posts: [], hasMore: false, typing: [], voice: [] };
        if (key === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
        if (key === 'presence') return { success: true, members: [] };
        if (key === 'dm/threads') return { success: true, threads: [] };
        return { success: true };
    });
    await bootRenderer({ board });
    await settle(30);
});

describe('the upload drop zone', () => {
    // Every test starts with no drag in progress, whatever the last one left.
    beforeEach(() => leaveWindow());

    it('appears for files dragged in from outside', async () => {
        fire('dragenter', transfer(['Files']));
        expect(overlayUp()).toBe(true);
        await drop(transfer(['Files']));
        expect(overlayUp()).toBe(false);
    });

    it('still appears for an image dragged in from a browser', async () => {
        // No 'Files' on this one — it is a URL, and the app fetches the bytes
        // itself. It has to keep working: it is the case that made the app
        // accept uri-list drags in the first place.
        fire('dragenter', transfer(IMAGE_DRAG));
        expect(overlayUp()).toBe(true);
        await drop(transfer(IMAGE_DRAG));
        expect(overlayUp()).toBe(false);
    });

    it('stays away for a picture picked up out of the chat', async () => {
        // The whole bug, end to end: the drag starts inside the window, so the
        // dragstart handler marks it, and everything downstream sees the mark.
        const dt = transfer(IMAGE_DRAG);
        fire('dragstart', dt, $('messages'));
        expect(dt.types, 'the drag is marked as ours').toContain(MARK);

        fire('dragenter', dt);
        expect(overlayUp(), 'no "Drop to upload" for something already posted').toBe(false);
    });

    it('does not re-upload a chat picture dropped back on the window', async () => {
        // The overlay is only the visible half. Dropping it must not stage the
        // file either — that is the same mistake one step later.
        const dt = transfer(IMAGE_DRAG);
        fire('dragstart', dt, $('messages'));
        await drop(dt);
        await settle(6);
        expect(staged(), 'nothing was staged for sending').toBe('');
        expect(overlayUp()).toBe(false);
    });

    it('marks nothing for the next drag in from outside', async () => {
        // The marker rides on the DataTransfer, so it cannot outlive the
        // gesture that carried it. A boolean would have had to be cleared by a
        // 'dragend' that is not guaranteed to arrive — the message list
        // re-renders on every poll, and one that carries the dragged image away
        // with it would leave uploads broken for the rest of the session.
        const inside = transfer(IMAGE_DRAG);
        fire('dragstart', inside, $('messages'));
        fire('dragenter', inside);
        expect(overlayUp()).toBe(false);

        // No dragend, exactly as if the source element had been re-rendered
        // away mid-drag. The next real upload must still be offered.
        fire('dragenter', transfer(['Files']));
        expect(overlayUp(), 'a real upload still works afterwards').toBe(true);
        await drop(transfer(['Files']));
    });
});
