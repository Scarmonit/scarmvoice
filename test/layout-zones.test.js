// @vitest-environment jsdom
//
// Edit Layout: dragging the main sections between the app shell's regions.
//
// The model is two rules. Seven regions are cut out of the shell — five in the
// grid, two inside the chat column — and any of the four movable sections may
// sit in any of them; a region holds one section, so a drop onto an occupied
// region trades places with what was there. Between them those make an overlap,
// a duplicate, or a section with nowhere to be unreachable rather than unlikely.
//
// The version this replaces was three either/or switches, and the switches were
// the bug: the me bar looked movable and refused every target, and the message
// box could not be moved at all, because the places they were being dragged to
// did not exist as places. So the tests that matter most here are the ones that
// take a section nobody could move before and put it somewhere new.
//
// jsdom has no layout engine, so geometry is stubbed — see stubRects(). It
// answers from each element's OWN `data-zone`, which is what applyLayout writes,
// so the stub cannot drift from the thing it is standing in for.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootRenderer, settle, $ } from './helpers/renderer.js';

const CSS = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'styles.css'),
    'utf8');

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

// A 1000x700 window, carved the way the stylesheet carves it. Non-overlapping
// by construction, which is what makes "what is under the pointer" have exactly
// one answer.
const ZONE_RECT = {
    ztop: [0, 0, 1000, 56],
    zleft: [72, 104, 300, 500],
    zright: [736, 104, 264, 500],
    zdock: [0, 604, 372, 60],
    zbot: [0, 664, 1000, 36],
    'chat-top': [372, 104, 364, 60],
    'chat-bottom': [372, 480, 364, 60]
};
const rect = ([x, y, w, h]) => ({ x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h });
const zero = rect([0, 0, 0, 0]);

let realRect;
function stubRects() {
    realRect = window.Element.prototype.getBoundingClientRect;
    window.Element.prototype.getBoundingClientRect = function () {
        const id = this.dataset && (this.dataset.zoneProbe || this.dataset.zone);
        return id && ZONE_RECT[id] ? rect(ZONE_RECT[id]) : zero;
    };
}
afterEach(() => { if (realRect) window.Element.prototype.getBoundingClientRect = realRect; realRect = null; });

const centre = (id) => {
    const [x, y, w, h] = ZONE_RECT[id];
    return { x: x + w / 2, y: y + h / 2 };
};

function drag(fromZone, toZone) {
    const shield = $('layout-shield');
    const a = centre(fromZone), b = centre(toZone);
    const opts = { bubbles: true, cancelable: true, button: 0, pointerId: 1 };
    shield.dispatchEvent(new window.PointerEvent('pointerdown', Object.assign({ clientX: a.x, clientY: a.y }, opts)));
    shield.dispatchEvent(new window.PointerEvent('pointermove', Object.assign({ clientX: b.x, clientY: b.y }, opts)));
    shield.dispatchEvent(new window.PointerEvent('pointerup', Object.assign({ clientX: b.x, clientY: b.y }, opts)));
}

async function openEdit() {
    $('btn-settings').click();
    await settle();
    $('set-edit-layout').click();
    await settle();
}

// Where each section actually ended up, read off the elements themselves.
const zones = () => ({
    channels: $('sidebar').dataset.zone,
    members: $('members-panel').dataset.zone,
    mebar: $('user-dock').dataset.zone,
    composer: $('composer').dataset.zone
});

const DEFAULT = { channels: 'zleft', members: 'zright', mebar: 'zdock', composer: 'chat-bottom' };

beforeEach(() => { localStorage.clear(); });

// ---------------------------------------------------------------------------

describe('the layout the app starts in', () => {
    it('is the default when nothing has been saved', async () => {
        await boot({});
        await settle();
        expect(zones()).toEqual(DEFAULT);
    });

    it('is whatever was saved', async () => {
        await boot({ layout: { channels: 'zright', members: 'zleft', mebar: 'ztop', composer: 'chat-top' } });
        await settle();
        expect(zones()).toEqual({ channels: 'zright', members: 'zleft', mebar: 'ztop', composer: 'chat-top' });
    });

    // settings.json is a text file that outlives any one build.
    it('refuses a region that does not exist', async () => {
        await boot({ layout: { channels: 'orbit', members: 'zleft', mebar: 'zdock', composer: 'chat-bottom' } });
        await settle();
        expect(zones().channels).toBe('zleft');
        expect(zones().members).not.toBe('zleft');
    });

    // Two sections in one region is the one thing the model must never draw.
    it('separates two sections that claim the same region', async () => {
        await boot({ layout: { channels: 'zleft', members: 'zleft', mebar: 'zleft', composer: 'zleft' } });
        await settle();
        const z = zones();
        expect(new Set(Object.values(z)).size).toBe(4);
        expect(z.channels).toBe('zleft');
    });

    it('survives a layout that is not an object at all', async () => {
        await boot({ layout: 'sideways' });
        await settle();
        expect(zones()).toEqual(DEFAULT);
    });

    // v0.76.0 stored three either/or switches. Anyone who arranged their window
    // under it has one saved, and translating beats discarding.
    it('translates the three-switch layout the previous release wrote', async () => {
        await boot({ layout: { panels: 'swapped', dock: 'top', input: 'top' } });
        await settle();
        expect(zones()).toEqual({
            channels: 'zright', members: 'zleft', mebar: 'ztop', composer: 'chat-top'
        });
    });

    it('translates the previous release’s default to this one’s', async () => {
        await boot({ layout: { panels: 'default', dock: 'bottom', input: 'bottom' } });
        await settle();
        expect(zones()).toEqual(DEFAULT);
    });
});

describe('edit mode', () => {
    it('opens from settings and closes the sheet behind it', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEdit();
        expect($('layout-edit').hidden).toBe(false);
        expect($('settings').hidden).toBe(true);
    });

    it('outlines every movable section', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEdit();
        const names = [...$('layout-frames').querySelectorAll('.lay-sec-name')].map((n) => n.textContent);
        expect(names).toEqual(['Channels & DMs', 'Member list', 'Me bar', 'Message box']);
    });

    // The fix for "the me bar shows as movable but will not go anywhere": an
    // empty region has no size, and a target with no size cannot be hit. A probe
    // in every region is what gives them all somewhere to be dropped.
    it('puts a droppable probe in every region, empty ones included', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEdit();
        const probes = [...document.querySelectorAll('[data-zone-probe]')].map((p) => p.dataset.zoneProbe);
        expect(probes.sort()).toEqual(
            ['chat-bottom', 'chat-top', 'zbot', 'zdock', 'zleft', 'zright', 'ztop']);
    });

    it('takes the probes away again on the way out', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEdit();
        $('layout-done').click();
        await settle();
        expect(document.querySelectorAll('[data-zone-probe]').length).toBe(0);
    });

    it('offers EVERY region to whatever is being dragged', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEdit();

        const shield = $('layout-shield');
        const a = centre('zdock');            // the me bar
        shield.dispatchEvent(new window.PointerEvent('pointerdown', {
            bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: a.x, clientY: a.y
        }));
        expect($('layout-frames').querySelectorAll('.lay-zone').length).toBe(7);
    });
});

// ---------------------------------------------------------------------------
// The three the previous version could not do.

describe('moving a section that used to be stuck', () => {
    it('moves the me bar to the top bar', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEdit();
        drag('zdock', 'ztop');
        await settle();
        expect(zones().mebar).toBe('ztop');
    });

    it('moves the me bar to the bottom bar, and to a column', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEdit();
        drag('zdock', 'zbot');
        await settle();
        expect(zones().mebar).toBe('zbot');

        drag('zbot', 'zleft');
        await settle();
        expect(zones().mebar).toBe('zleft');
    });

    it('moves the message box out of the chat column entirely', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEdit();
        drag('chat-bottom', 'ztop');
        await settle();
        expect(zones().composer).toBe('ztop');
        // …and it really left #main, which is what puts it in the grid.
        expect($('composer').parentElement.id).toBe('app');
        expect($('composer').style.gridArea).toBe('ztop');
    });

    it('moves the message box above the messages and back', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEdit();
        drag('chat-bottom', 'chat-top');
        await settle();
        expect(zones().composer).toBe('chat-top');
        expect($('composer').parentElement.id).toBe('main');
        expect($('main').classList.contains('input-top')).toBe(true);

        drag('chat-top', 'chat-bottom');
        await settle();
        expect(zones().composer).toBe('chat-bottom');
        expect($('main').classList.contains('input-top')).toBe(false);
    });

    it('moves the member list into the chat column', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEdit();
        drag('zright', 'chat-top');
        await settle();
        expect(zones().members).toBe('chat-top');
        expect($('members-panel').parentElement.id).toBe('main');
    });
});

describe('dropping onto an occupied region', () => {
    it('trades places with whatever was there', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEdit();
        drag('zleft', 'zright');
        await settle();
        expect(zones()).toEqual({
            channels: 'zright', members: 'zleft', mebar: 'zdock', composer: 'chat-bottom'
        });
    });

    it('never leaves two sections in one region, however they are moved', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEdit();
        for (const [from, to] of [
            ['zleft', 'ztop'], ['zright', 'ztop'], ['zdock', 'zleft'],
            ['chat-bottom', 'zright'], ['ztop', 'zbot']
        ]) {
            drag(from, to);
            await settle();
            const z = zones();
            expect(new Set(Object.values(z)).size, JSON.stringify(z)).toBe(4);
        }
    });

    it('leaves everything alone when the drop lands on nothing', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEdit();
        const shield = $('layout-shield');
        const a = centre('zleft');
        const opts = { bubbles: true, cancelable: true, button: 0, pointerId: 1 };
        shield.dispatchEvent(new window.PointerEvent('pointerdown', Object.assign({ clientX: a.x, clientY: a.y }, opts)));
        shield.dispatchEvent(new window.PointerEvent('pointermove', Object.assign({ clientX: 500, clientY: 690 - 0 }, opts)));
        shield.dispatchEvent(new window.PointerEvent('pointerup', Object.assign({ clientX: 3000, clientY: 3000 }, opts)));
        await settle();
        expect(zones()).toEqual(DEFAULT);
    });

    it('saves what it moved', async () => {
        const h = await boot({});
        await settle();
        stubRects();
        await openEdit();
        drag('zdock', 'ztop');
        await settle();
        const saved = h.lounge.settings.set.mock.calls.map((c) => c[0]).filter((p) => p && p.layout).pop();
        expect(saved.layout.mebar).toBe('ztop');
    });
});

describe('backing out', () => {
    it('puts the entry arrangement back on Cancel', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEdit();
        drag('zdock', 'ztop');
        await settle();
        expect(zones().mebar).toBe('ztop');

        $('layout-cancel').click();
        await settle();
        expect(zones()).toEqual(DEFAULT);
        expect($('layout-edit').hidden).toBe(true);
    });

    it('treats Escape as Cancel', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEdit();
        drag('zleft', 'zright');
        await settle();
        document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await settle();
        expect(zones()).toEqual(DEFAULT);
    });

    it('puts the default back from Reset', async () => {
        await boot({ layout: { channels: 'ztop', members: 'zleft', mebar: 'zbot', composer: 'zright' } });
        await settle();
        stubRects();
        await openEdit();
        $('layout-reset').click();
        await settle();
        expect(zones()).toEqual(DEFAULT);
    });
});

describe('the message box and the conversation drawer', () => {
    // The drawer owns the box for as long as a conversation is open. Where it
    // goes AFTERWARDS is the layout's answer — it used to be a comment node
    // planted where the box happened to be the first time a DM was ever opened,
    // which would have marched it back there over whatever the user had chosen.
    it('gives the box back to its region after a conversation closes', async () => {
        await bootRenderer({
            settings: { layout: { channels: 'zleft', members: 'zright', mebar: 'zdock', composer: 'ztop' } },
            board: vi.fn(async (p) => {
                if (p === 'dm/threads') {
                    return {
                        success: true,
                        threads: [{ id: 40, title: 'Alice', isGroup: false, user: { id: 2, username: 'Alice' }, members: [], unread: 0 }]
                    };
                }
                if (p === 'dm/list') return { success: true, thread: { id: 40, title: 'Alice', members: [] }, messages: [] };
                if (p === 'list') return { success: true, posts: [], typing: [], voice: [], hasMore: false, maxId: 0 };
                if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
                if (p === 'presence') return { success: true, members: [] };
                return { success: true };
            })
        });
        await settle();
        expect($('composer').parentElement.id).toBe('app');

        $('rail-dms').click();
        await settle();
        const row = $('dm-list').querySelector('.dm-row') || $('dm-list-slot').querySelector('.dm-row');
        if (row) {
            row.click();
            await settle();
            expect($('composer').parentElement.id).toBe('dm-composer-slot');
        }

        $('rail-home').click();
        await settle();
        expect($('composer').parentElement.id).toBe('app');
        expect($('composer').style.gridArea).toBe('ztop');
    });
});

describe('templates', () => {
    async function saveAs(name) {
        $('set-save-layout').click();
        await settle();
        $('dialog-input').value = name;
        $('dialog-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
        await settle();
    }
    const rows = () => [...$('lay-tpl-list').querySelectorAll('.lay-tpl')];

    it('saves the current arrangement under a name', async () => {
        const h = await boot({ layout: { channels: 'zright', members: 'zleft', mebar: 'ztop', composer: 'chat-top' } });
        await settle();
        $('btn-settings').click();
        await settle();
        await saveAs('Mirror');

        const saved = h.lounge.settings.set.mock.calls
            .map((c) => c[0]).filter((p) => p && p.layoutTemplates).pop();
        expect(saved.layoutTemplates.length).toBe(1);
        expect(saved.layoutTemplates[0].name).toBe('Mirror');
        expect(saved.layoutTemplates[0].layout.mebar).toBe('ztop');
        expect(rows().length).toBe(1);
    });

    it('recalls one, arrangement and all', async () => {
        await boot({
            layoutTemplates: [{
                id: 't1', name: 'Mirror',
                layout: { channels: 'zright', members: 'zleft', mebar: 'zbot', composer: 'chat-top' }
            }]
        });
        await settle();
        $('btn-settings').click();
        await settle();
        rows()[0].querySelector('button').click();
        await settle();
        expect(zones()).toEqual({ channels: 'zright', members: 'zleft', mebar: 'zbot', composer: 'chat-top' });
    });

    it('stops at ten, and says so before asking for a name', async () => {
        const full = Array.from({ length: 10 }, (_, i) => ({ id: 't' + i, name: 'L' + i, layout: DEFAULT }));
        await boot({ layoutTemplates: full });
        await settle();
        $('btn-settings').click();
        await settle();
        $('set-save-layout').click();
        await settle();
        expect($('dialog').hidden).toBe(true);
        expect($('toast').textContent).toMatch(/10 layout templates/);
    });

    it('caps a list that is already too long', async () => {
        const many = Array.from({ length: 14 }, (_, i) => ({ id: 't' + i, name: 'L' + i, layout: DEFAULT }));
        await boot({ layoutTemplates: many });
        await settle();
        $('btn-settings').click();
        await settle();
        expect(rows().length).toBe(10);
    });

    it('deletes one, once it is confirmed', async () => {
        await boot({
            layoutTemplates: [
                { id: 't1', name: 'One', layout: DEFAULT },
                { id: 't2', name: 'Two', layout: { channels: 'zright', members: 'zleft', mebar: 'zdock', composer: 'chat-bottom' } }
            ]
        });
        await settle();
        $('btn-settings').click();
        await settle();
        rows()[0].querySelectorAll('button')[1].click();
        await settle();
        $('dialog-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
        await settle();
        expect(rows().length).toBe(1);
        expect(rows()[0].textContent).toMatch(/Two/);
    });

    it('drops a template whose layout is nonsense back to something valid', async () => {
        await boot({ layoutTemplates: [{ id: 't1', name: 'Broken', layout: { channels: 'orbit' } }] });
        await settle();
        $('btn-settings').click();
        await settle();
        rows()[0].querySelector('button').click();
        await settle();
        expect(new Set(Object.values(zones())).size).toBe(4);
    });

    it('translates a template saved by the previous release', async () => {
        await boot({
            layoutTemplates: [{ id: 't1', name: 'Old', layout: { panels: 'swapped', dock: 'top', input: 'bottom' } }]
        });
        await settle();
        $('btn-settings').click();
        await settle();
        rows()[0].querySelector('button').click();
        await settle();
        expect(zones()).toEqual({
            channels: 'zright', members: 'zleft', mebar: 'ztop', composer: 'chat-bottom'
        });
    });

    it('says how many slots are used', async () => {
        await boot({ layoutTemplates: [{ id: 't1', name: 'One', layout: DEFAULT }] });
        await settle();
        $('btn-settings').click();
        await settle();
        expect($('lay-tpl-count').textContent).toBe('1 of 10');
    });
});

// ---------------------------------------------------------------------------

describe('the stylesheet behind the regions', () => {
    const grid = () => /#app\s*\{([^}]*)\}/.exec(CSS)[1];

    it('names every region the model can put a section in', () => {
        const areas = /grid-template-areas:([^;]*);/.exec(grid())[1];
        for (const z of ['ztop', 'zleft', 'zright', 'zdock', 'zbot']) {
            expect(new RegExp('\\b' + z + '\\b').test(areas), 'missing ' + z).toBe(true);
        }
        // …and the two that are not grid areas at all, but children of #main.
        expect(CSS).toMatch(/#main > \[data-zone="chat-top"\]/);
        expect(CSS).toMatch(/#main > \[data-zone="chat-bottom"\]/);
    });

    // A named area has to be a RECTANGLE or the whole declaration is invalid and
    // the browser falls back to no areas at all — a blank window, not a wrong
    // one. Nothing in jsdom would ever notice.
    it('keeps every area rectangular, and every row the same width', () => {
        const rows = (/grid-template-areas:([^;]*);/.exec(grid())[1].match(/"[^"]*"/g) || [])
            .map((r) => r.slice(1, -1).trim().split(/\s+/));
        expect(rows.length).toBeGreaterThan(2);
        const width = rows[0].length;
        for (const r of rows) expect(r.length, 'ragged row: ' + r.join(' ')).toBe(width);

        const names = new Set(rows.flat());
        for (const name of names) {
            const cells = [];
            rows.forEach((r, y) => r.forEach((c, x) => { if (c === name) cells.push([x, y]); }));
            const xs = cells.map((c) => c[0]), ys = cells.map((c) => c[1]);
            const w = Math.max(...xs) - Math.min(...xs) + 1;
            const h = Math.max(...ys) - Math.min(...ys) + 1;
            expect(cells.length, name + ' is not a rectangle').toBe(w * h);
        }
    });

    it('gives a section its width from the region rather than from itself', () => {
        expect(CSS).toMatch(/#members-panel\[data-zonekind="col"\][^{]*\{[^}]*width: var\(--w-members\)/);
        expect(CSS).toMatch(/\[data-zonekind="bar"\]\s*\{[^}]*width: auto/);
    });

    it('only offers a drag strip where there is a width to drag', () => {
        expect(CSS).toMatch(/\.pane-resize \{ display: none; \}/);
        expect(CSS).toMatch(/\[data-zonekind="col"\] > \.pane-resize \{ display: block/);
        expect(CSS).toMatch(/\[data-zone="zleft"\] > \.pane-resize \{ right: -4px/);
        expect(CSS).toMatch(/\[data-zone="zright"\] > \.pane-resize \{ left: -4px/);
    });

    it('re-places the conversation panel for the shape of this grid', () => {
        expect(CSS).toMatch(/#dm-panel \{ grid-column: 3 \/ 5; grid-row: 2 \/ 5; \}/);
    });
});

describe('resizing a panel that has moved', () => {
    // The strip swaps edges with the panel, so which way a rightward drag widens
    // it is a property of the LAYOUT, not of which handle it is.
    async function dragHandle(id, dx) {
        const h = $(id);
        const opts = { bubbles: true, cancelable: true, button: 0, pointerId: 2 };
        h.dispatchEvent(new window.PointerEvent('pointerdown', Object.assign({ clientX: 500 }, opts)));
        h.dispatchEvent(new window.PointerEvent('pointermove', Object.assign({ clientX: 500 + dx }, opts)));
        h.dispatchEvent(new window.PointerEvent('pointerup', Object.assign({ clientX: 500 + dx }, opts)));
        await settle();
    }
    const sideW = () => parseInt(document.documentElement.style.getPropertyValue('--w-side'), 10);

    it('widens the channel list to the right when it is on the left', async () => {
        await boot({ sidebarWidth: 200 });
        await settle();
        const before = sideW();
        await dragHandle('sidebar-resize', 40);
        expect(sideW()).toBeGreaterThan(before);
    });

    it('widens it to the LEFT once it has moved to the right column', async () => {
        await boot({
            sidebarWidth: 200,
            layout: { channels: 'zright', members: 'zleft', mebar: 'zdock', composer: 'chat-bottom' }
        });
        await settle();
        const before = sideW();
        await dragHandle('sidebar-resize', 40);
        expect(sideW()).toBeLessThan(before);
    });
});
