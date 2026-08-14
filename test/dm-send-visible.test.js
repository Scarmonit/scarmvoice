// @vitest-environment jsdom
//
// "I send a DM and can't see it — I have to click into a channel and back
// before it shows up."
//
// The row was there the whole time. The conversation column was not looking at
// it: renderDmMessages() decided whether it was allowed to follow the newest
// message by measuring where the scrollbar happened to be, and nothing ever
// pinned the column back. Anything that loads late — an avatar, an image, a
// link preview — grows the content under a reader who has not touched the
// wheel, and from that moment the column was permanently "somewhere else":
// every repaint left it wherever innerHTML = '' had dropped it, which is the
// TOP of the loaded history. Switching channel and back re-opens the
// conversation, and openDm scrolls to the end — which is why that "fixed" it.
//
// The channel column has had the answer since optimistic sends went in: your
// own message always pulls you to it (see echoPost), and a late image re-pins
// the view. This is the same two rules for the other list.
import { describe, it, expect, vi } from 'vitest';
import { bootRenderer, settle, type, $ } from './helpers/renderer.js';

const ME = { id: 1, username: 'Me', role: 'member' };
const THEM = { id: 2, username: 'Alice', role: 'member' };
const PAIR = { id: 40, title: 'Alice', isGroup: false, user: THEM, members: [ME, THEM], unread: 0 };

function router() {
    const state = {
        msgs: [{ id: 501, from: THEM.id, body: 'hello', created_at: 1700000000000 }],
        next: 502
    };
    const board = vi.fn(async (p, o) => {
        if (p === 'dm/threads') return { success: true, threads: [PAIR] };
        if (p === 'dm/list') return { success: true, thread: PAIR, messages: state.msgs.slice(), hasMore: false };
        if (p === 'dm/send') {
            const id = state.next++;
            state.msgs.push({ id, from: ME.id, body: o.body.body, created_at: 1700000060000 + id });
            return { success: true, id, created_at: 1700000060000 + id };
        }
        if (p === 'list') return { success: true, posts: [], typing: [], voice: [], hasMore: false, maxId: 0 };
        if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
        if (p === 'presence') return { success: true, members: [] };
        return { success: true };
    });
    return { board, state };
}

// jsdom lays nothing out, so a scrolling column has to be described by hand.
// A 300-tall box over content that is `base` tall plus 200 per message row —
// which is the part that matters, because the bug is entirely about what
// happens to the scroll when the content's height changes under the reader.
const ROW_H = 200;
function fakeScroll(el, top, base = 1000) {
    let scrollTop = top;
    let extra = 0;
    const height = () => base + extra + el.querySelectorAll('.msg').length * ROW_H;
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: height });
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 300 });
    Object.defineProperty(el, 'scrollTop', {
        configurable: true, get: () => scrollTop, set: (v) => { scrollTop = v; }
    });
    // Something that is not a message row growing — a picture finishing.
    return { grow: (by) => { extra += by; } };
}

async function openPair() {
    $('dm-list').querySelectorAll('.dm-row')[0].click();
    await settle(20);
}

async function send(text) {
    type(text);
    await settle(2);
    $('composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await settle(20);
}

describe('a sent DM is visible to the sender straight away', () => {
    it('pulls the conversation to the new message even when the column has drifted off the end', async () => {
        const { board } = router();
        await bootRenderer({ board, user: ME });
        await settle(20);
        await openPair();

        const box = $('dm-messages');
        // Content grew after openDm scrolled to the bottom. Nobody scrolled.
        fakeScroll(box, 0);

        await send('can you see this');

        expect(box.innerHTML).toContain('can you see this');
        expect(box.scrollTop).toBe(box.scrollHeight);
    });

    it('keeps following for the next message too', async () => {
        const { board } = router();
        await bootRenderer({ board, user: ME });
        await settle(20);
        await openPair();

        const box = $('dm-messages');
        const geom = fakeScroll(box, 0);
        await send('one');
        geom.grow(200);                       // the row it just drew
        await send('two');

        expect(box.innerHTML).toContain('two');
        expect(box.scrollTop).toBe(box.scrollHeight);
    });

    it('still does not yank a reader who has scrolled back', async () => {
        const { board } = router();
        const h = await bootRenderer({ board, user: ME });
        await settle(20);
        await openPair();

        const box = $('dm-messages');
        fakeScroll(box, 200);
        // Reading back through the history, by hand — this is the ONLY thing
        // that stops the column following.
        box.dispatchEvent(new window.Event('scroll'));
        await settle(4);

        // …and THEIR message arrives over the socket. It goes on the end, and
        // the reader stays where they were reading: the repaint gives back the
        // height it added rather than dumping them at the top of the history.
        h.rt({
            t: 'dm', id: 900, thread: PAIR.id, body: 'from Alice',
            from: { id: THEM.id, username: 'Alice' }, created_at: 1700000900000
        });
        await settle(6);

        expect(box.innerHTML).toContain('from Alice');
        // Not slammed to the bottom, and — the half that was broken — not left
        // at 0 either, which is where innerHTML = '' had put it.
        expect(box.scrollTop).toBe(200 + ROW_H);
        expect(box.scrollTop).not.toBe(box.scrollHeight);
    });

    it('re-pins the column when an image finishes loading under it', async () => {
        const { board } = router();
        await bootRenderer({ board, user: ME });
        await settle(20);
        await openPair();

        const box = $('dm-messages');
        const geom = fakeScroll(box, 0);
        box.scrollTop = box.scrollHeight - box.clientHeight;    // at the bottom
        box.dispatchEvent(new window.Event('scroll'));
        await settle(2);

        // An image finishes decoding and the content grows under the reader.
        // Without the re-pin they are now 400px off the end, having done
        // nothing — and this column never came back from that.
        const img = document.createElement('img');
        box.appendChild(img);
        geom.grow(400);
        img.dispatchEvent(new window.Event('load'));

        expect(box.scrollTop).toBe(box.scrollHeight);
    });
});
