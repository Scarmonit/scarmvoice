// @vitest-environment jsdom
//
// Going back to a channel you were just in should not show you an empty column.
//
// Switching channels blanked the message pane and then waited a full network
// round trip — the app's single most repeated navigation, and for the whole of
// it the only thing on screen was a stray "Load earlier messages" button. What
// you last saw in a channel is remembered now, so the switch paints in the next
// frame and the fetch fills in behind it.
//
// The cache is never the source of truth. The two ways that could go wrong are
// what most of this file is about:
//
//   * it must not SURVIVE the fetch — the server's answer always replaces it,
//     including when messages changed while you were away; and
//   * it must not make the app re-announce messages you have already seen. The
//     chime block keys off "the newest id I held before this merge", and a
//     restored page moves that from 0 to a real id — which would turn every
//     message that arrived while you were in another channel into a fresh one,
//     and chime the moment you came back.
//
// ONE boot for the whole file, deliberately, exactly as render-diff-cost.test.js
// does and for the same reason: bootRenderer leaves the previous instance's
// poll timers running, and a second live renderer chimes into the same
// window.loungeSounds — which shows up here as a phantom extra chime belonging
// to nobody. (Measured: the same assertion reads 1 with one boot and 2 with
// two.)
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { bootRenderer, $, settle } from './helpers/renderer.js';

function post(id, ch, body) {
    return {
        id, channel: ch, body,
        client_id: 'them', user_id: 2, name: 'Someone',
        created_at: 1700000000000 + id * 1000,
        reactions: [], reply_count: 0, pinned: 0
    };
}

// Per-channel pages, rewritten between switches to stand for what the server
// would say next.
const pages = {
    general: [post(1, 'general', 'hello from general')],
    random: [post(2, 'random', 'hello from random')]
};
const listCalls = [];
let chimes = 0;
let app;

// Switch the way a person does — click the row in the sidebar — so this goes
// through the same handler the app does rather than poking an internal.
function clickChannel(name) {
    const row = $('channel-list').querySelector('.chan[data-channel="' + name + '"]');
    if (!row) throw new Error('no channel row for #' + name);
    row.click();
}

const bodies = () => Array.from($('messages').querySelectorAll('.msg'))
    .map((r) => r.querySelector('.msg-text') && r.querySelector('.msg-text').textContent)
    .filter(Boolean);

beforeAll(async () => {
    const board = vi.fn(async (p, opts) => {
        const key = String(p).split('?')[0];
        if (key === 'list') {
            const ch = (opts && opts.query && opts.query.channel) || 'general';
            listCalls.push(ch);
            await new Promise((r) => setTimeout(r, 0));   // stand in for a round trip
            return { success: true, posts: pages[ch] || [], hasMore: false, typing: [], voice: [] };
        }
        if (key === 'channels') {
            return { success: true, channels: [{ name: 'general', unread: 0 }, { name: 'random', unread: 0 }] };
        }
        if (key === 'presence') return { success: true, members: [] };
        if (key === 'dm/threads') return { success: true, threads: [] };
        return { success: true };
    });
    app = await bootRenderer({ board });
    await settle(30);
    window.loungeSounds.playMessage = () => { chimes++; };
});

describe('coming back to a channel', () => {
    it('paints what you last saw, before the fetch answers', async () => {
        expect(bodies()).toEqual(['hello from general']);

        clickChannel('random');
        await settle(20);
        expect(bodies()).toEqual(['hello from random']);

        // Back to #general, asserted BEFORE letting the round trip finish.
        // That gap is precisely what used to be blank.
        clickChannel('general');
        expect(bodies(), 'painted from the remembered page, same frame')
            .toEqual(['hello from general']);

        await settle(20);
        expect(bodies()).toEqual(['hello from general']);
    });

    it('still asks the server, and lets the answer win', async () => {
        clickChannel('random');
        await settle(20);

        // Changed while we were away. A cache that survived the fetch would go
        // on showing the old page for the rest of the session.
        pages.general = [post(3, 'general', 'a different message entirely')];

        listCalls.length = 0;
        clickChannel('general');
        await settle(20);

        expect(listCalls, 'the fetch still runs').toContain('general');
        expect(bodies()).toEqual(['a different message entirely']);
    });

    it('does not chime for messages that arrived while you were elsewhere', async () => {
        clickChannel('random');
        await settle(20);

        pages.general = [
            post(3, 'general', 'a different message entirely'),
            post(10, 'general', 'said while you were in random'),
            post(11, 'general', 'and this too')
        ];

        chimes = 0;
        clickChannel('general');
        await settle(20);

        expect(bodies()).toHaveLength(3);
        expect(chimes, 'chimes on returning to a channel').toBe(0);
    });

    // The one-shot suppression covers the restored page and nothing after it —
    // but a message in THE CHANNEL YOU ARE READING is governed by its own
    // setting now (Notifications -> Sounds -> "New Message in the channel I'm
    // currently reading"), which is off by default, matching the reference. You
    // are looking at it; a noise adds nothing.
    it('does not chime for a message in the channel you are watching', async () => {
        chimes = 0;
        pages.general = pages.general.concat([post(20, 'general', 'arriving while you watch')]);
        app.rt({ t: 'posted', channel: 'general' });
        await settle(30);

        // It still ARRIVES — this is about the sound, not about delivery.
        expect(bodies()).toHaveLength(4);
        expect(chimes, 'the channel on screen should be silent by default').toBe(0);
    });

    // …and the moment you are NOT looking at it, the ordinary chime is back. The
    // window going to the tray is enough — that is one of the four things
    // "reading it" requires.
    it('chimes for it again once the window is not on screen', async () => {
        app.hidden(true);
        chimes = 0;
        pages.general = pages.general.concat([post(21, 'general', 'and now with sound')]);
        app.rt({ t: 'posted', channel: 'general' });
        await settle(30);

        expect(chimes, 'a hidden window should chime for the open channel').toBe(1);
        app.hidden(false);
    });
});
