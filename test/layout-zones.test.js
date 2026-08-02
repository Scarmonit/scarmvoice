// @vitest-environment jsdom
//
// Edit Layout: dragging the main sections between a fixed set of zones, and
// saving arrangements as templates.
//
// The design being pinned here is that the set of layouts is FINITE and written
// out by hand in the stylesheet. A section is dropped into a zone, a zone is a
// patch to one of three two-valued choices, and every combination of those is a
// grid somebody laid out. That is what makes an overlapping or half-off-screen
// arrangement unreachable rather than merely unlikely — so the tests that matter
// most are the ones that check the stylesheet still covers all eight, and that
// nothing outside that vocabulary can get into the setting.
//
// jsdom has no layout engine, so the geometry every drag depends on is stubbed:
// see stubRects(). It answers from the CURRENT data-attributes, which is exactly
// what measureZones() relies on — it puts the app into a candidate layout, reads
// the rectangle back, and restores it, all without painting.
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

// A 1000x700 window, in the shape #app actually takes. Every rect is answered
// from the live data-attributes, so the two candidate positions a section can
// occupy really are different rectangles — which is the whole mechanism the zone
// outlines and the drop hit-test are built on.
const W = 1000, H = 700, RAIL = 72, COL = 300, MAIN_L = RAIL + COL, MAIN_R = W - 264;
const rect = (x, y, w, h) => ({ x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h });

function rectFor(id) {
    const app = document.getElementById('app');
    const swapped = app.dataset.panels === 'swapped';
    const dockTop = app.dataset.dock === 'top';
    const inputTop = app.dataset.input === 'top';
    const bodyTop = dockTop ? 56 : 0;
    const leftCol = rect(RAIL, bodyTop, COL, H - bodyTop);
    const rightCol = rect(MAIN_R, bodyTop, W - MAIN_R, H - bodyTop);
    switch (id) {
        case 'sidebar': return swapped ? rightCol : leftCol;
        case 'members-panel': return swapped ? leftCol : rightCol;
        case 'user-dock': return dockTop ? rect(0, 0, W, 56) : rect(0, H - 60, RAIL + COL, 60);
        case 'composer': return inputTop
            ? rect(MAIN_L, bodyTop + 48, MAIN_R - MAIN_L, 80)
            : rect(MAIN_L, H - 90, MAIN_R - MAIN_L, 80);
        case 'main': return rect(MAIN_L, bodyTop + 48, MAIN_R - MAIN_L, H - bodyTop - 48);
        default: return rect(0, 0, 0, 0);
    }
}

let realRect;
function stubRects() {
    realRect = window.Element.prototype.getBoundingClientRect;
    window.Element.prototype.getBoundingClientRect = function () {
        return rectFor(this.id);
    };
}
afterEach(() => { if (realRect) window.Element.prototype.getBoundingClientRect = realRect; realRect = null; });

const point = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

// One whole drag, through the shield the way a pointer would.
function drag(from, to) {
    const shield = $('layout-shield');
    const opts = { bubbles: true, cancelable: true, button: 0, pointerId: 1 };
    shield.dispatchEvent(new window.PointerEvent('pointerdown', Object.assign({ clientX: from.x, clientY: from.y }, opts)));
    shield.dispatchEvent(new window.PointerEvent('pointermove', Object.assign({ clientX: to.x, clientY: to.y }, opts)));
    shield.dispatchEvent(new window.PointerEvent('pointerup', Object.assign({ clientX: to.x, clientY: to.y }, opts)));
}

async function openEdit() {
    $('btn-settings').click();
    await settle();
    $('set-edit-layout').click();
    await settle();
}

const lay = () => {
    const a = $('app');
    return { panels: a.dataset.panels, dock: a.dataset.dock, input: a.dataset.input };
};

beforeEach(() => { localStorage.clear(); });

// ---------------------------------------------------------------------------

describe('the layout the app starts in', () => {
    it('is the default when nothing has been saved', async () => {
        await boot({});
        await settle();
        expect(lay()).toEqual({ panels: 'default', dock: 'bottom', input: 'bottom' });
    });

    it('is whatever was saved', async () => {
        await boot({ layout: { panels: 'swapped', dock: 'top', input: 'top' } });
        await settle();
        expect(lay()).toEqual({ panels: 'swapped', dock: 'top', input: 'top' });
    });

    // settings.json is a text file that outlives any one build. A word no rule
    // matches is not a broken layout, it is a window with no grid at all.
    it('refuses a value no stylesheet rule answers to', async () => {
        await boot({ layout: { panels: 'diagonal', dock: 'floating', input: 'top' } });
        await settle();
        expect(lay()).toEqual({ panels: 'default', dock: 'bottom', input: 'top' });
    });

    it('survives a layout that is not an object at all', async () => {
        await boot({ layout: 'sideways' });
        await settle();
        expect(lay()).toEqual({ panels: 'default', dock: 'bottom', input: 'bottom' });
    });
});

describe('edit mode', () => {
    it('opens from settings, and closes the sheet behind it', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEdit();
        expect($('layout-edit').hidden).toBe(false);
        expect($('settings').hidden).toBe(true);
        expect(document.body.classList.contains('layout-editing')).toBe(true);
    });

    it('outlines every movable section', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEdit();
        const names = [...$('layout-frames').querySelectorAll('.lay-sec-name')].map((n) => n.textContent);
        expect(names).toEqual(['Channels & DMs', 'Member list', 'Me bar', 'Message box']);
    });

    it('draws only the zones the dragged section may go in', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEdit();

        const shield = $('layout-shield');
        const from = point(rectFor('user-dock'));
        shield.dispatchEvent(new window.PointerEvent('pointerdown', {
            bubbles: true, cancelable: true, button: 0, pointerId: 1,
            clientX: from.x, clientY: from.y
        }));
        const zones = [...$('layout-frames').querySelectorAll('.lay-zone')].map((z) => z.textContent);
        expect(zones.length).toBe(2);
        expect(zones.join(' ')).toMatch(/Top bar/);
        expect(zones.join(' ')).toMatch(/Below the channels/);
    });

    it('closes on Done and leaves the arrangement in place', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEdit();
        drag(point(rectFor('sidebar')), point(rectFor('members-panel')));
        await settle();
        expect(lay().panels).toBe('swapped');

        $('layout-done').click();
        await settle();
        expect($('layout-edit').hidden).toBe(true);
        expect(lay().panels).toBe('swapped');
    });
});

describe('dropping a section into a zone', () => {
    it('swaps the two columns', async () => {
        const h = await boot({});
        await settle();
        stubRects();
        await openEdit();

        drag(point(rectFor('sidebar')), point(rectFor('members-panel')));
        await settle();
        expect(lay().panels).toBe('swapped');
        const saved = h.lounge.settings.set.mock.calls.map((c) => c[0]).filter((p) => p && p.layout).pop();
        expect(saved.layout.panels).toBe('swapped');
    });

    // Dropping either panel into the other's column is the SAME rearrangement.
    // Describing both as one patch is what makes them unable to disagree.
    it('swaps them from the member list too', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEdit();

        drag(point(rectFor('members-panel')), point(rectFor('sidebar')));
        await settle();
        expect(lay().panels).toBe('swapped');
    });

    it('moves the me bar to the top', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEdit();

        // Its "top" zone is measured with dock=top applied, so the target is the
        // full-width strip the bar would occupy — not where it is now.
        drag(point(rectFor('user-dock')), { x: W / 2, y: 20 });
        await settle();
        expect(lay().dock).toBe('top');
    });

    it('moves the message box above the messages', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEdit();

        const target = rect(MAIN_L, 48, MAIN_R - MAIN_L, 80);
        drag(point(rectFor('composer')), point(target));
        await settle();
        expect(lay().input).toBe('top');
    });

    it('leaves everything alone when the drop lands on nothing', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEdit();

        drag(point(rectFor('sidebar')), { x: 4, y: 4 });
        await settle();
        expect(lay()).toEqual({ panels: 'default', dock: 'bottom', input: 'bottom' });
    });

    it('changes only the choice the zone names', async () => {
        await boot({ layout: { panels: 'default', dock: 'top', input: 'top' } });
        await settle();
        stubRects();
        await openEdit();

        drag(point(rectFor('sidebar')), point(rectFor('members-panel')));
        await settle();
        expect(lay()).toEqual({ panels: 'swapped', dock: 'top', input: 'top' });
    });
});

describe('backing out', () => {
    it('puts the entry arrangement back on Cancel', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEdit();

        drag(point(rectFor('sidebar')), point(rectFor('members-panel')));
        await settle();
        expect(lay().panels).toBe('swapped');

        $('layout-cancel').click();
        await settle();
        expect(lay().panels).toBe('default');
        expect($('layout-edit').hidden).toBe(true);
    });

    // Escape means Cancel here, the same as the button: the arrangement is
    // applied as it is made, so backing out is the only thing left to ask for.
    it('treats Escape as Cancel', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEdit();

        drag(point(rectFor('sidebar')), point(rectFor('members-panel')));
        await settle();
        document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await settle();
        expect(lay().panels).toBe('default');
        expect($('layout-edit').hidden).toBe(true);
    });

    it('puts the default back from the Reset button', async () => {
        await boot({ layout: { panels: 'swapped', dock: 'top', input: 'top' } });
        await settle();
        stubRects();
        await openEdit();

        $('layout-reset').click();
        await settle();
        expect(lay()).toEqual({ panels: 'default', dock: 'bottom', input: 'bottom' });
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
        const h = await boot({ layout: { panels: 'swapped', dock: 'bottom', input: 'top' } });
        await settle();
        $('btn-settings').click();
        await settle();
        await saveAs('Wide left');

        const saved = h.lounge.settings.set.mock.calls
            .map((c) => c[0]).filter((p) => p && p.layoutTemplates).pop();
        expect(saved.layoutTemplates.length).toBe(1);
        expect(saved.layoutTemplates[0].name).toBe('Wide left');
        expect(saved.layoutTemplates[0].layout).toEqual({ panels: 'swapped', dock: 'bottom', input: 'top' });
        expect(rows().length).toBe(1);
    });

    it('recalls one, arrangement and all', async () => {
        await boot({
            layout: { panels: 'default', dock: 'bottom', input: 'bottom' },
            layoutTemplates: [{ id: 't1', name: 'Mirror', layout: { panels: 'swapped', dock: 'top', input: 'top' } }]
        });
        await settle();
        $('btn-settings').click();
        await settle();

        rows()[0].querySelector('button').click();
        await settle();
        expect(lay()).toEqual({ panels: 'swapped', dock: 'top', input: 'top' });
    });

    it('stops at ten, and says so before asking for a name', async () => {
        const full = Array.from({ length: 10 }, (_, i) => ({
            id: 't' + i, name: 'L' + i, layout: { panels: 'default', dock: 'bottom', input: 'bottom' }
        }));
        await boot({ layoutTemplates: full });
        await settle();
        $('btn-settings').click();
        await settle();

        $('set-save-layout').click();
        await settle();
        // No name was asked for: the refusal came first.
        expect($('dialog').hidden).toBe(true);
        expect($('toast').textContent).toMatch(/10 layout templates/);
        expect(rows().length).toBe(10);
    });

    // A list that grew past the cap under an older build must not stay grown.
    it('caps a list that is already too long', async () => {
        const many = Array.from({ length: 14 }, (_, i) => ({
            id: 't' + i, name: 'L' + i, layout: { panels: 'default', dock: 'bottom', input: 'bottom' }
        }));
        await boot({ layoutTemplates: many });
        await settle();
        $('btn-settings').click();
        await settle();
        expect(rows().length).toBe(10);
    });

    it('deletes one, once it is confirmed', async () => {
        await boot({
            layoutTemplates: [
                { id: 't1', name: 'One', layout: { panels: 'default', dock: 'bottom', input: 'bottom' } },
                { id: 't2', name: 'Two', layout: { panels: 'swapped', dock: 'bottom', input: 'bottom' } }
            ]
        });
        await settle();
        $('btn-settings').click();
        await settle();
        expect(rows().length).toBe(2);

        rows()[0].querySelectorAll('button')[1].click();
        await settle();
        $('dialog-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
        await settle();

        expect(rows().length).toBe(1);
        expect(rows()[0].textContent).toMatch(/Two/);
    });

    it('drops a template whose layout is nonsense back to the default', async () => {
        await boot({
            layoutTemplates: [{ id: 't1', name: 'Broken', layout: { panels: 'sideways' } }]
        });
        await settle();
        $('btn-settings').click();
        await settle();

        rows()[0].querySelector('button').click();
        await settle();
        expect(lay()).toEqual({ panels: 'default', dock: 'bottom', input: 'bottom' });
    });

    it('says how many slots are used', async () => {
        await boot({
            layoutTemplates: [{ id: 't1', name: 'One', layout: { panels: 'default', dock: 'bottom', input: 'bottom' } }]
        });
        await settle();
        $('btn-settings').click();
        await settle();
        expect($('lay-tpl-count').textContent).toBe('1 of 10');
    });
});

// ---------------------------------------------------------------------------
// The stylesheet half. Every arrangement the UI can reach has to be one that
// was written out — this is the check that the two vocabularies still match.

describe('the stylesheet behind the zones', () => {
    const AREAS = ['rail', 'side', 'main', 'members', 'head', 'user'];

    // Each of the four grids, by the selector that selects it.
    const grids = () => {
        const out = {};
        const re = /(#app(?:\[[^\]]*\])*)\s*\{([^}]*grid-template-areas:[^}]*)\}/g;
        let m;
        while ((m = re.exec(CSS))) out[m[1]] = m[2];
        return out;
    };

    it('lays out all four column-and-row combinations', () => {
        const g = grids();
        expect(Object.keys(g).sort()).toEqual([
            '#app',
            '#app[data-dock="top"]',
            '#app[data-panels="swapped"]',
            '#app[data-panels="swapped"][data-dock="top"]'
        ].sort());
    });

    it('gives every section a place in every one of them', () => {
        for (const [sel, body] of Object.entries(grids())) {
            const areas = /grid-template-areas:([^;]*);/.exec(body)[1];
            for (const name of AREAS) {
                expect(new RegExp('\\b' + name + '\\b').test(areas), sel + ' is missing ' + name).toBe(true);
            }
        }
    });

    // A named area has to be a RECTANGLE or the whole declaration is invalid and
    // the browser falls back to no areas at all — which is a blank window, not a
    // wrong one. Checked here because nothing in jsdom would ever notice.
    it('keeps every area rectangular', () => {
        for (const [sel, body] of Object.entries(grids())) {
            const rows = (/grid-template-areas:([^;]*);/.exec(body)[1].match(/"[^"]*"/g) || [])
                .map((r) => r.slice(1, -1).trim().split(/\s+/));
            const width = rows[0].length;
            for (const r of rows) expect(r.length, sel + ' has a ragged row').toBe(width);
            for (const name of AREAS) {
                const cells = [];
                rows.forEach((r, y) => r.forEach((c, x) => { if (c === name) cells.push([x, y]); }));
                if (!cells.length) continue;
                const xs = cells.map((c) => c[0]), ys = cells.map((c) => c[1]);
                const w = Math.max(...xs) - Math.min(...xs) + 1;
                const h = Math.max(...ys) - Math.min(...ys) + 1;
                expect(cells.length, sel + ': ' + name + ' is not a rectangle').toBe(w * h);
            }
        }
    });

    it('moves the message box with `order`, and only inside the chat column', () => {
        expect(CSS).toMatch(/#app\[data-input="top"\] #main > #composer/);
        expect(CSS).toMatch(/#app\[data-input="top"\] #main > #typing-line/);
    });

    // #dm-panel is placed by track NUMBER rather than by area name, so it is the
    // one thing that does not follow the named areas on its own.
    it('re-places the conversation panel for a swapped or top-docked window', () => {
        expect(CSS).toMatch(/#app\[data-panels="swapped"\] #dm-panel \{[^}]*grid-column: 2 \/ 4/);
        expect(CSS).toMatch(/#app\[data-dock="top"\] #dm-panel \{[^}]*grid-row: 2 \/ 4/);
    });

    it('moves both drag strips to the edge facing the chat', () => {
        expect(CSS).toMatch(/#app\[data-panels="swapped"\] #sidebar-resize[\s\S]{0,80}left: -4px/);
        expect(CSS).toMatch(/#app\[data-panels="swapped"\] #members-resize \{[^}]*right: -4px/);
    });
});

describe('resizing a panel that has moved', () => {
    // The strip swaps edges with the panel, so which way a rightward drag
    // widens it is a property of the LAYOUT, not of which handle it is. It used
    // to be a constant captured when the handles were wired — once, for the life
    // of the process — so after a swap every drag resized the wrong way.
    async function dragHandle(id, dx) {
        const h = $(id);
        const opts = { bubbles: true, cancelable: true, button: 0, pointerId: 2 };
        h.dispatchEvent(new window.PointerEvent('pointerdown', Object.assign({ clientX: 500 }, opts)));
        h.dispatchEvent(new window.PointerEvent('pointermove', Object.assign({ clientX: 500 + dx }, opts)));
        h.dispatchEvent(new window.PointerEvent('pointerup', Object.assign({ clientX: 500 + dx }, opts)));
        await settle();
    }
    const sideW = () => parseInt(document.documentElement.style.getPropertyValue('--w-side'), 10);

    // Well under the clamp at jsdom's window width, so the drag has room to
    // move the number in either direction and neither test is measuring a
    // panel that was already as wide as it is allowed to be.
    it('widens the channel list to the right when it is on the left', async () => {
        await boot({ sidebarWidth: 200 });
        await settle();
        const before = sideW();
        await dragHandle('sidebar-resize', 40);
        expect(sideW()).toBeGreaterThan(before);
    });

    it('widens it to the LEFT once it has moved to the right column', async () => {
        await boot({ sidebarWidth: 200, layout: { panels: 'swapped', dock: 'bottom', input: 'bottom' } });
        await settle();
        const before = sideW();
        await dragHandle('sidebar-resize', 40);
        expect(sideW()).toBeLessThan(before);
    });
});
