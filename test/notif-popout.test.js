// @vitest-environment jsdom
//
// The channel header's notification popout, and the timed mute behind it.
//
// The header's bell used to open the channel's whole context menu — rename and
// delete included — which is not what a bell in a header means. It opens the
// reference's popout now: Mute Channel with a hover submenu of durations, then the
// three notification levels as radios.
//
// The MUTE is a second axis, not a fourth level, and that is the part worth
// pinning: the level says what a channel is normally worth hearing about, and a
// mute says "not for the next three hours" without throwing that away. So coming
// off mute has to restore the level that was already there.
//
// "Use Category Default" is deliberately absent. This board has no channel
// categories, so it would be a fourth radio meaning what the first one means.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { bootRenderer, $, settle } from './helpers/renderer.js';

const POST = {
    id: 1, body: 'hello', name: 'Alice', client_id: 'alice', user_id: 2,
    created_at: 1700000000000, reactions: [], pinned: 0, channel: 'general'
};

const router = () => vi.fn(async (p) => {
    if (p === 'list') return { success: true, posts: [POST], typing: [], voice: [], hasMore: false, maxId: 1 };
    if (p === 'channels') {
        return { success: true, channels: [{ name: 'general', unread: 0 }, { name: 'random', unread: 0 }] };
    }
    if (p === 'presence') return { success: true, members: [] };
    if (p === 'dm/threads') return { success: true, threads: [] };
    if (p === 'pins') return { success: true, pins: [] };
    if (p === 'threads') return { success: true, threads: [] };
    return { success: true };
});

const pop = () => $('notif-pop');
const sub = () => $('notif-sub');
const levels = () => Array.from($('np-radios').querySelectorAll('.np-radio'))
    .map((r) => r.querySelector('span').textContent);
const levelInput = (label) => Array.from($('np-radios').querySelectorAll('.np-radio'))
    .find((r) => r.querySelector('span').textContent === label).querySelector('input');
const durations = () => Array.from(sub().querySelectorAll('.np-item')).map((b) => b.textContent.trim());

let h;

async function open() {
    $('btn-chan-alerts').click();
    await settle();
}

// Set the level through the radio, which is the only way a person can.
async function pickLevel(label) {
    if (pop().hidden) await open();
    const input = levelInput(label);
    input.checked = true;
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
    await settle();
}

beforeAll(async () => {
    localStorage.clear();
    h = await bootRenderer({ board: router() });
    await settle();
    // ONE real write, so `h.settings` and the renderer's own settings object are
    // the same object from here on.
    //
    // bootRenderer's settings.get() answers with a COPY and its set() merges into
    // the original and returns IT — and saveSettings() in app.js assigns that
    // return value. So until the app has saved something once, poking h.settings
    // changes nothing the app can see; afterwards it is the same reference and a
    // spec can set up a precondition directly. Without this line the first
    // precondition in the file silently did nothing.
    await pickLevel('All Messages');
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
});

beforeEach(async () => {
    // Back to a clean slate without a second renderer: both axes are settings,
    // and the objects are shared (see above).
    h.settings.channelMuteUntil = {};
    h.settings.channelAlerts = {};
    h.settings.mutedChannels = [];
    while (!pop().hidden) {
        document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await settle();
    }
});

describe('opening it', () => {
    it('opens from the header bell, not the channel context menu', async () => {
        expect(pop().hidden).toBe(true);
        await open();
        expect(pop().hidden).toBe(false);
        expect($('btn-chan-alerts').getAttribute('aria-expanded')).toBe('true');
        // The rename/delete menu is emphatically NOT what this button does now.
        expect($('ctx-menu').hidden).toBe(true);
    });

    it('offers exactly three levels, and no category default', async () => {
        await open();
        expect(levels()).toEqual(['All Messages', 'Only @mentions', 'Nothing']);
        expect(pop().textContent).not.toContain('Category');
    });

    it('marks the level the channel is actually on', async () => {
        h.settings.channelAlerts = { general: 'mentions' };
        await open();
        expect(levelInput('Only @mentions').checked).toBe(true);
        expect(levelInput('All Messages').checked).toBe(false);
    });

    it('closes on Escape and on a click outside', async () => {
        await open();
        document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await settle();
        expect(pop().hidden).toBe(true);

        await open();
        $('messages').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
        await settle();
        expect(pop().hidden).toBe(true);
    });
});

describe('the level radios', () => {
    it('writes the level and leaves the popout open', async () => {
        await open();
        levelInput('Nothing').checked = true;
        levelInput('Nothing').dispatchEvent(new window.Event('change', { bubbles: true }));
        await settle();

        expect(h.settings.channelAlerts.general).toBe('none');
        // Picking a level is a setting, not a command — the radio moving is the
        // confirmation, and closing would hide it.
        expect(pop().hidden).toBe(false);
    });

    it('keeps the legacy muted list in step', async () => {
        // The website still reads the binary list, and so does an older build of
        // this app — a channel silenced here must not come back to life there.
        await open();
        levelInput('Nothing').checked = true;
        levelInput('Nothing').dispatchEvent(new window.Event('change', { bubbles: true }));
        await settle();
        expect(h.settings.mutedChannels).toContain('general');
    });
});

describe('Mute Channel', () => {
    it('opens the durations on hover, with the reference s six', async () => {
        await open();
        $('np-mute').dispatchEvent(new window.MouseEvent('mouseenter'));
        await settle();

        expect(sub().hidden).toBe(false);
        expect(durations()).toEqual([
            'For 15 Minutes', 'For 1 Hour', 'For 3 Hours',
            'For 8 Hours', 'For 24 Hours', 'Until I turn it back on'
        ]);
    });

    it('opens them on click too, for touch and the keyboard', async () => {
        await open();
        $('np-mute').click();
        await settle();
        expect(sub().hidden).toBe(false);
        $('np-mute').click();
        await settle();
        expect(sub().hidden).toBe(true);
    });

    it('stores a real expiry for a timed mute', async () => {
        const before = Date.now();
        await open();
        $('np-mute').click();
        await settle();
        Array.from(sub().querySelectorAll('.np-item'))
            .find((b) => b.textContent.includes('For 1 Hour')).click();
        await settle();

        const until = h.settings.channelMuteUntil.general;
        expect(until).toBeGreaterThan(before + 59 * 60000);
        expect(until).toBeLessThan(before + 61 * 60000);
        // Chosen, so it closes — unlike a level, this one is a command.
        expect(pop().hidden).toBe(true);
    });

    it('stores the indefinite mute as its own value, not as a date', async () => {
        await open();
        $('np-mute').click();
        await settle();
        Array.from(sub().querySelectorAll('.np-item'))
            .find((b) => b.textContent.includes('Until I turn it back on')).click();
        await settle();
        // -1, not a timestamp a hundred years out: "no expiry" is a different
        // thing from "an expiry so far away nobody will see it".
        expect(h.settings.channelMuteUntil.general).toBe(-1);
    });

    it('offers the way back out once the channel is muted', async () => {
        h.settings.channelMuteUntil = { general: -1 };
        await open();
        expect($('np-unmute').hidden).toBe(false);
        // …and says what is currently true, which a row reading only "Mute
        // Channel" could not.
        expect($('np-mute-label').textContent).toContain('until you turn it back on');

        $('np-unmute').click();
        await settle();
        expect(h.settings.channelMuteUntil.general).toBe(undefined);
    });

    it('hides Unmute when the channel is not muted', async () => {
        await open();
        expect($('np-unmute').hidden).toBe(true);
    });
});

describe('what a mute actually does', () => {
    const row = () => document.querySelector('.chan[data-channel="general"]');

    it('dims the channel row while it lasts', async () => {
        // Through the real action, which is what repaints the sidebar.
        await open();
        $('np-mute').click();
        await settle();
        Array.from(sub().querySelectorAll('.np-item'))
            .find((b) => b.textContent.includes('For 3 Hours')).click();
        await settle();
        expect(row().classList.contains('muted')).toBe(true);
    });

    it('stops on its own once the time is up', async () => {
        // channelMutedNow is deliberately READ-ONLY — it must not write from
        // inside a render or an alert check — so an entry whose time has passed
        // simply reads as unmuted, and the periodic sweep tidies it up later.
        //
        // Asserted on the DIMMING RULE rather than on a repaint, because nothing
        // repaints the sidebar when a timestamp quietly goes stale: that is the
        // whole reason pruneExpiredMutes runs on a timer. Opening the popout is
        // what asks the question here, and it answers from the same predicate the
        // row does.
        h.settings.channelMuteUntil = { general: Date.now() - 1000 };
        await open();
        // Not muted any more: no way back out is offered, and the label has
        // dropped the "muted until…" line.
        expect($('np-unmute').hidden).toBe(true);
        expect($('np-mute-label').textContent).toBe('Mute Channel');
    });

    it('does not touch the level, so unmuting restores it', async () => {
        h.settings.channelAlerts = { general: 'mentions' };
        h.settings.channelMuteUntil = { general: -1 };
        await open();
        // Muted, and STILL on mentions — the two are separate axes.
        expect(levelInput('Only @mentions').checked).toBe(true);

        $('np-unmute').click();
        await settle();
        expect(h.settings.channelAlerts.general).toBe('mentions');
    });
});
