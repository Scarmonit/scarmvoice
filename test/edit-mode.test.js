// @vitest-environment jsdom
//
// Edit Mode: the retail-WoW-style HUD editor.
//
// The model is one sentence. A LAYOUT IS A RECTANGLE PER ELEMENT — x/y/w/h as
// fractions of the app box, plus a shown/hidden flag — under a name. The
// default layout is not one of those: it is the CSS grid the app has always
// drawn, and it stays in force until something is actually moved or resized, at
// which point the arrangement is measured off the screen as it stands and
// becomes the starting point. So the app is unchanged for anybody who never
// opens this, and identical at the instant they do.
//
// This replaces the zone system that shipped in v0.76 — where only two panels
// could really move — rather than sitting beside it. There is one layout system
// and this is it.
//
// jsdom has no layout engine, so geometry is stubbed: see stubRects(). It reads
// each element's own inline left/top/width/height, which is what applyLayout
// writes, so a moved element really does measure as moved.
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

// A 1000x700 app box at the origin, so a fraction is a round number of pixels.
const APP = { x: 0, y: 0, w: 1000, h: 700 };
// Where each element sits in the DEFAULT grid, which jsdom cannot compute.
const GRID = {
    rail: [0, 0, 72, 700],
    sidebar: [72, 0, 300, 700],
    'members-panel': [736, 48, 264, 652],
    'user-dock': [0, 640, 372, 60],
    main: [372, 48, 364, 652],
    'chan-head': [372, 0, 628, 48],
    composer: [372, 580, 364, 66]
};
const mk = (x, y, w, h) => ({
    x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h
});

let realRect;
function stubRects() {
    realRect = window.Element.prototype.getBoundingClientRect;
    window.Element.prototype.getBoundingClientRect = function () {
        if (this.id === 'app') return mk(APP.x, APP.y, APP.w, APP.h);
        // A custom layout writes percentages inline; that IS the element's box.
        const st = this.style;
        if (st && st.left && st.width) {
            const f = (v) => parseFloat(v) / 100;
            return mk(APP.x + f(st.left) * APP.w, APP.y + f(st.top) * APP.h,
                f(st.width) * APP.w, f(st.height) * APP.h);
        }
        if (GRID[this.id]) return mk(...GRID[this.id]);
        return mk(0, 0, 0, 0);
    };
}
afterEach(() => { if (realRect) window.Element.prototype.getBoundingClientRect = realRect; realRect = null; });

async function openEditor() {
    $('set-edit-layout').click();
    await settle();
}

// One pointer gesture through the shield, the way a mouse would.
function gesture(from, to) {
    const shield = $('edit-shield');
    const o = { bubbles: true, cancelable: true, button: 0, pointerId: 1 };
    shield.dispatchEvent(new window.PointerEvent('pointerdown', Object.assign({ clientX: from.x, clientY: from.y }, o)));
    shield.dispatchEvent(new window.PointerEvent('pointermove', Object.assign({ clientX: to.x, clientY: to.y }, o)));
    shield.dispatchEvent(new window.PointerEvent('pointerup', Object.assign({ clientX: to.x, clientY: to.y }, o)));
}
const centreOf = (id) => {
    const r = $(id).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};
const boxOf = (id) => {
    const r = $(id).getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
};
const mode = () => $('app').dataset.layout;
const rows = () => [...$('edit-element-list').querySelectorAll('.ep-el')];
const rowFor = (name) => rows().find((r) => r.querySelector('.ep-el-name').textContent === name);
const tick = (name) => {
    const box = rowFor(name).querySelector('input');
    box.checked = !box.checked;
    box.dispatchEvent(new window.Event('change', { bubbles: true }));
};

beforeEach(() => { localStorage.clear(); });

// ---------------------------------------------------------------------------

describe('the app before anybody edits it', () => {
    it('is the CSS grid, untouched', async () => {
        await boot({});
        await settle();
        expect(mode()).toBe('grid');
        for (const id of ['sidebar', 'members-panel', 'user-dock', 'main', 'chan-head']) {
            expect($(id).style.left, id).toBe('');
        }
    });

    it('marks every managed element so the editor can find it', async () => {
        await boot({});
        await settle();
        for (const k of ['rail', 'channels', 'members', 'chat', 'header', 'mebar', 'composer',
            'typing', 'search', 'toolbar']) {
            expect(document.querySelector('[data-el="' + k + '"]'), k).toBeTruthy();
        }
    });

    // A half-filled custom layout would place some elements and leave the rest
    // stacked on top of each other at their static positions.
    it('refuses a saved layout that is not the right shape', async () => {
        await boot({
            activeLayout: 'L1',
            layouts: [{ id: 'L1', name: 'Broken', custom: true, els: { chat: { x: 'yes' } } }]
        });
        await settle();
        expect(mode()).toBe('grid');
    });

    it('survives layouts that are not an array at all', async () => {
        await boot({ layouts: 'nope', activeLayout: 'ghost' });
        await settle();
        expect(mode()).toBe('grid');
    });
});

describe('the control panel', () => {
    it('opens on Edit Mode and closes the settings sheet behind it', async () => {
        await boot({});
        await settle();
        stubRects();
        $('btn-settings').click();
        await settle();
        await openEditor();
        expect($('edit-mode').hidden).toBe(false);
        expect($('settings').hidden).toBe(true);
        expect(document.body.classList.contains('edit-mode')).toBe(true);
    });

    it('lists every element, grouped, with a checkbox each', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEditor();
        expect(rows().length).toBe(10);
        expect([...$('edit-element-list').querySelectorAll('.ep-group')].map((g) => g.textContent))
            .toEqual(['Panels', 'Bars', 'Details']);
        expect(rows().every((r) => r.querySelector('input[type="checkbox"]'))).toBe(true);
        for (const name of ['Me bar', 'Channels list', 'Member list', 'Message box',
            'Message area', 'Channel header', 'Servers rail']) {
            expect(rowFor(name), name).toBeTruthy();
        }
    });

    it('outlines every movable element', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEditor();
        expect([...$('edit-frames').querySelectorAll('.ed-name')].map((n) => n.textContent))
            .toEqual(['Servers rail', 'Channels list', 'Member list', 'Message area',
                'Channel header', 'Me bar', 'Message box']);
    });

    it('offers the grid, its size and element snapping, and remembers them', async () => {
        const h = await boot({});
        await settle();
        stubRects();
        await openEditor();
        expect($('edit-grid').hidden).toBe(false);
        expect($('edit-grid-size-val').textContent).toBe('24');

        $('edit-show-grid').click();
        await settle();
        expect($('edit-grid').hidden).toBe(true);

        $('edit-grid-size').value = '48';
        $('edit-grid-size').dispatchEvent(new window.Event('change', { bubbles: true }));
        await settle();
        const saved = h.lounge.settings.set.mock.calls.map((c) => c[0]).filter((p) => p && p.editorPrefs).pop();
        expect(saved.editorPrefs.gridSize).toBe(48);
        expect(saved.editorPrefs.showGrid).toBe(false);
    });

    it('clamps a grid size somebody edited into the settings file by hand', async () => {
        await boot({ editorPrefs: { gridSize: 100000, showGrid: true, snapElements: true } });
        await settle();
        stubRects();
        await openEditor();
        expect($('edit-grid-size-val').textContent).toBe('96');
    });
});

// ---------------------------------------------------------------------------

describe('moving an element', () => {
    it('moves the me bar — the one that would not move before', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEditor();

        const before = boxOf('user-dock');
        gesture(centreOf('user-dock'), { x: 500, y: 100 });
        await settle();
        const after = boxOf('user-dock');
        expect(mode()).toBe('custom');
        expect(after.y).toBeLessThan(before.y);
        expect(after.x).not.toBe(before.x);
        // A move is not a resize.
        expect(after.w).toBe(before.w);
        expect(after.h).toBe(before.h);
    });

    it('moves the message box — the other one that would not', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEditor();

        const before = boxOf('composer');
        gesture(centreOf('composer'), { x: 200, y: 200 });
        await settle();
        expect(boxOf('composer').y).toBeLessThan(before.y);
        // In a custom layout the box is free-standing rather than the last row
        // of the message area — it cannot be positioned inside something it is
        // also allowed to sit beside.
        expect($('composer').parentElement.id).toBe('app');
    });

    // One boot each. Dragging them all in one go piles them onto the same spot,
    // and from the second move onwards the grab lands on whichever of the heap
    // is smallest — which is correct behaviour and a useless test.
    for (const [id, label] of [
        ['rail', 'the servers rail'], ['sidebar', 'the channels list'],
        ['members-panel', 'the member list'], ['main', 'the message area'],
        ['chan-head', 'the channel header']
    ]) {
        it('moves ' + label, async () => {
            await boot({});
            await settle();
            stubRects();
            await openEditor();
            const before = boxOf(id);
            // TOWARDS the middle, whichever way that is. Several of these start
            // flush against an edge at full height or full width, so a drag the
            // other way is one the clamp is entitled to refuse entirely.
            const c = centreOf(id);
            const step = (from, to) => (from > to ? -96 : 96);
            gesture(c, { x: c.x + step(c.x, APP.w / 2), y: c.y + step(c.y, APP.h / 2) });
            await settle();
            const after = boxOf(id);
            expect(after.x !== before.x || after.y !== before.y, id + ' did not move').toBe(true);
            expect(after.w).toBe(before.w);
            expect(after.h).toBe(before.h);
        });
    }

    it('switches the shell to custom placement the first time, not before', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEditor();
        expect(mode()).toBe('grid');
        gesture(centreOf('user-dock'), { x: 400, y: 300 });
        await settle();
        expect(mode()).toBe('custom');
    });

    // The switch has to be invisible: everything is measured off the screen as
    // it stands, so nothing jumps at the moment it happens.
    it('keeps every element exactly where it was when it switches', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEditor();
        const before = {};
        for (const id of ['rail', 'sidebar', 'members-panel', 'main', 'chan-head', 'composer']) {
            before[id] = boxOf(id);
        }
        const c = centreOf('user-dock');
        gesture(c, c);                       // pick it up and put it straight back
        await settle();
        expect(mode()).toBe('custom');
        for (const id of Object.keys(before)) expect(boxOf(id), id).toEqual(before[id]);
    });

    it('snaps to the grid', async () => {
        await boot({ editorPrefs: { gridSize: 50, showGrid: true, snapElements: false } });
        await settle();
        stubRects();
        await openEditor();
        const c = centreOf('user-dock');
        gesture(c, { x: c.x + 63, y: c.y - 117 });
        await settle();
        const r = boxOf('user-dock');
        expect(r.x % 50).toBe(0);
        expect(r.y % 50).toBe(0);
    });

    // THE TOGGLES HAVE TO BE BELIEVABLE. Turning element snapping off used to
    // leave the window's own edges in the candidate list AND the grid catching
    // every drag regardless — so an element let go anywhere near a side still
    // jumped, and the switch read as doing nothing at all.
    it('lands exactly where it was let go with both snaps off', async () => {
        await boot({ editorPrefs: { gridSize: 24, showGrid: true, snapGrid: false, snapElements: false } });
        await settle();
        stubRects();
        await openEditor();
        const c = centreOf('user-dock');
        gesture(c, { x: c.x + 37, y: c.y - 63 });
        await settle();
        const r = boxOf('user-dock');
        expect(r.x).toBe(0 + 37);
        expect(r.y).toBe(640 - 63);
    });

    it('stops snapping to other elements when that is switched off', async () => {
        await boot({ editorPrefs: { gridSize: 24, showGrid: true, snapGrid: false, snapElements: true } });
        await settle();
        stubRects();
        await openEditor();
        // The channels list's left edge is at 72. Let go three pixels short of
        // it: with element snapping ON that is a snap, and nothing else is
        // within reach of the me bar's other two vertical edges — a target has
        // to be unambiguous or the test is really about which line won.
        const c = centreOf('user-dock');
        gesture(c, { x: c.x + 69, y: c.y });
        await settle();
        expect(boxOf('user-dock').x).toBe(72);

        $('edit-snap-elements').click();
        await settle();
        gesture(centreOf('user-dock'), { x: centreOf('user-dock').x - 3, y: centreOf('user-dock').y });
        await settle();
        expect(boxOf('user-dock').x).toBe(69);
    });

    it('stops snapping to the grid when that is switched off', async () => {
        await boot({ editorPrefs: { gridSize: 50, showGrid: true, snapGrid: true, snapElements: false } });
        await settle();
        stubRects();
        await openEditor();
        const c = centreOf('user-dock');
        gesture(c, { x: c.x + 63, y: c.y });
        await settle();
        expect(boxOf('user-dock').x % 50).toBe(0);

        $('edit-snap-grid').click();
        await settle();
        gesture(centreOf('user-dock'), { x: centreOf('user-dock').x + 7, y: centreOf('user-dock').y });
        await settle();
        expect(boxOf('user-dock').x % 50).not.toBe(0);
    });

    it('never lets an element leave the window', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEditor();
        gesture(centreOf('user-dock'), { x: -4000, y: -4000 });
        await settle();
        let r = boxOf('user-dock');
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeGreaterThanOrEqual(0);

        gesture(centreOf('user-dock'), { x: 9000, y: 9000 });
        await settle();
        r = boxOf('user-dock');
        expect(r.x + r.w).toBeLessThanOrEqual(APP.w);
        expect(r.y + r.h).toBeLessThanOrEqual(APP.h);
    });

    // WITHOUT A STATED STACKING ORDER an element dragged onto another VANISHES
    // behind it — absolutely-positioned siblings stack in document order, and
    // the message area is declared after most of them with an opaque
    // background. Dragging the me bar into the middle of the chat drew its
    // outline over an empty box, which reads as the element having been
    // destroyed. The order is: message area at the back, panels on it, bars
    // over both.
    it('states a stacking order, so a bar dragged onto the chat stays visible', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEditor();
        gesture(centreOf('user-dock'), { x: 550, y: 300 });
        await settle();

        const z = (id) => Number($(id).style.zIndex);
        expect(z('main')).toBeLessThan(z('user-dock'));
        expect(z('main')).toBeLessThan(z('composer'));
        expect(z('main')).toBeLessThan(z('members-panel'));
        expect(z('members-panel')).toBeLessThan(z('user-dock'));
    });

    it('takes the stacking order away again with the custom layout', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEditor();
        gesture(centreOf('user-dock'), { x: 550, y: 300 });
        await settle();
        expect($('user-dock').style.zIndex).not.toBe('');

        $('edit-revert').click();
        await settle();
        expect($('user-dock').style.zIndex).toBe('');
    });

    it('selects what it picks up, and says how big it is', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEditor();
        gesture(centreOf('members-panel'), centreOf('members-panel'));
        await settle();
        expect($('edit-selected').hidden).toBe(false);
        expect($('edit-selected').querySelector('.ep-sel-name').textContent).toBe('Member list');
        expect($('edit-selected').querySelector('.ep-sel-dims').textContent).toMatch(/\d+ × \d+ px/);
        expect(rowFor('Member list').classList.contains('sel')).toBe(true);
    });

    it('grows resize handles on whatever is selected', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEditor();
        expect($('edit-frames').querySelectorAll('.ed-h').length).toBe(0);
        gesture(centreOf('members-panel'), centreOf('members-panel'));
        await settle();
        expect($('edit-frames').querySelectorAll('.ed-h').length).toBe(8);
    });
});

describe('resizing an element', () => {
    // Select first, then take hold of a handle rather than the body.
    async function grabHandle(id, which) {
        gesture(centreOf(id), centreOf(id));
        await settle();
        const r = $(id).getBoundingClientRect();
        return {
            e: { x: r.right, y: r.top + r.height / 2 },
            s: { x: r.left + r.width / 2, y: r.bottom },
            w: { x: r.left, y: r.top + r.height / 2 }
        }[which];
    }

    it('widens from the west handle without moving the east edge', async () => {
        await boot({ editorPrefs: { gridSize: 4, showGrid: true, snapElements: false } });
        await settle();
        stubRects();
        await openEditor();
        const before = boxOf('members-panel');
        const at = await grabHandle('members-panel', 'w');
        gesture(at, { x: at.x - 80, y: at.y });
        await settle();
        const after = boxOf('members-panel');
        expect(after.w).toBeGreaterThan(before.w);
        expect(after.x + after.w).toBe(before.x + before.w);
    });

    it('shortens from the south handle without moving the top', async () => {
        await boot({ editorPrefs: { gridSize: 4, showGrid: true, snapElements: false } });
        await settle();
        stubRects();
        await openEditor();
        const before = boxOf('sidebar');
        const at = await grabHandle('sidebar', 's');
        gesture(at, { x: at.x, y: at.y - 200 });
        await settle();
        const after = boxOf('sidebar');
        expect(after.h).toBeLessThan(before.h);
        expect(after.y).toBe(before.y);
    });

    // Nothing may be squeezed to a size it cannot be used at — that is a layout
    // somebody would have to reset their way out of.
    it('stops at the element’s minimum rather than vanishing', async () => {
        await boot({ editorPrefs: { gridSize: 4, showGrid: true, snapElements: false } });
        await settle();
        stubRects();
        await openEditor();
        const at = await grabHandle('members-panel', 'w');
        gesture(at, { x: at.x + 5000, y: at.y });
        await settle();
        const after = boxOf('members-panel');
        expect(after.w).toBeGreaterThanOrEqual(120);
        expect(after.h).toBeGreaterThanOrEqual(90);
    });
});

describe('showing and hiding', () => {
    it('hides an element from its checkbox and brings it back', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEditor();
        expect(rowFor('Member list').querySelector('input').checked).toBe(true);

        tick('Member list');
        await settle();
        expect($('members-panel').classList.contains('el-hidden')).toBe(true);

        tick('Member list');
        await settle();
        expect($('members-panel').classList.contains('el-hidden')).toBe(false);
    });

    it('hides the ones that are shown but never moved', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEditor();
        for (const name of ['Typing indicator', 'Header search', 'Formatting bar']) tick(name);
        await settle();
        expect($('typing-line').classList.contains('el-hidden')).toBe(true);
        expect($('search-box').classList.contains('el-hidden')).toBe(true);
        expect($('format-bar').classList.contains('el-hidden')).toBe(true);
    });

    // Hiding is not moving: it must not drag the whole shell into custom
    // placement, or a window that was still responsive stops being so.
    it('does not switch the shell to custom placement on its own', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEditor();
        tick('Member list');
        await settle();
        expect(mode()).toBe('grid');
    });

    it('stops outlining something that is not on screen', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEditor();
        const before = $('edit-frames').querySelectorAll('.ed-frame').length;
        tick('Me bar');
        await settle();
        expect($('edit-frames').querySelectorAll('.ed-frame').length).toBe(before - 1);
    });
});

// ---------------------------------------------------------------------------

describe('saved layouts', () => {
    async function answerPrompt(name) {
        $('dialog-input').value = name;
        $('dialog-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
        await settle();
    }
    const options = () => [...$('edit-layout-select').options].map((o) => o.textContent);
    const CUSTOM = {
        rail: { x: 0, y: 0, w: 0.05, h: 1 }, channels: { x: 0.05, y: 0, w: 0.2, h: 1 },
        members: { x: 0.8, y: 0, w: 0.2, h: 1 }, chat: { x: 0.25, y: 0.1, w: 0.55, h: 0.7 },
        header: { x: 0.25, y: 0, w: 0.75, h: 0.1 }, mebar: { x: 0, y: 0.9, w: 0.25, h: 0.1 },
        composer: { x: 0.25, y: 0.8, w: 0.55, h: 0.1 }
    };

    it('starts on Default, which cannot be renamed or deleted', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEditor();
        expect(options()).toEqual(['Default']);
        expect($('edit-layout-select').value).toBe('default');
        expect($('edit-layout-rename').disabled).toBe(true);
        expect($('edit-layout-delete').disabled).toBe(true);
    });

    // Saving over Default asks for a name and makes a new one — the default is
    // what Reset means, so it is the one thing that cannot be written over.
    it('turns a save on Default into a new named layout', async () => {
        const h = await boot({});
        await settle();
        stubRects();
        await openEditor();
        gesture(centreOf('user-dock'), { x: 500, y: 200 });
        await settle();

        $('edit-save').click();
        await settle();
        await answerPrompt('Wide');

        const saved = h.lounge.settings.set.mock.calls.map((c) => c[0]).filter((p) => p && p.layouts).pop();
        expect(saved.layouts.length).toBe(1);
        expect(saved.layouts[0].name).toBe('Wide');
        expect(saved.layouts[0].custom).toBe(true);
        expect(options()).toEqual(['Default', 'Wide']);
        expect($('edit-layout-rename').disabled).toBe(false);
    });

    it('stores a rectangle and a visibility for every element', async () => {
        const h = await boot({});
        await settle();
        stubRects();
        await openEditor();
        gesture(centreOf('user-dock'), { x: 500, y: 200 });
        await settle();
        tick('Member list');
        await settle();
        $('edit-save').click();
        await settle();
        await answerPrompt('Full');

        const saved = h.lounge.settings.set.mock.calls.map((c) => c[0]).filter((p) => p && p.layouts).pop();
        const els = saved.layouts[0].els;
        for (const k of ['rail', 'channels', 'members', 'chat', 'header', 'mebar', 'composer']) {
            expect(Number.isFinite(els[k].x), k + ' has no x').toBe(true);
            expect(Number.isFinite(els[k].w), k + ' has no w').toBe(true);
        }
        expect(els.members.hidden).toBe(true);
        expect(els.chat.hidden).toBe(false);
    });

    it('restores position, size and visibility when a layout is applied', async () => {
        const els = JSON.parse(JSON.stringify(CUSTOM));
        els.members.hidden = true;
        await boot({ layouts: [{ id: 'L1', name: 'Mine', custom: true, els }], activeLayout: 'L1' });
        await settle();
        stubRects();
        expect(mode()).toBe('custom');
        expect(boxOf('main')).toEqual({ x: 250, y: 70, w: 550, h: 490 });
        expect(boxOf('user-dock')).toEqual({ x: 0, y: 630, w: 250, h: 70 });
        expect($('members-panel').classList.contains('el-hidden')).toBe(true);
    });

    it('switches between layouts from the dropdown', async () => {
        await boot({ layouts: [{ id: 'L1', name: 'Mine', custom: true, els: CUSTOM }], activeLayout: 'default' });
        await settle();
        stubRects();
        await openEditor();
        expect(mode()).toBe('grid');

        $('edit-layout-select').value = 'L1';
        $('edit-layout-select').dispatchEvent(new window.Event('change', { bubbles: true }));
        await settle();
        expect(mode()).toBe('custom');

        $('edit-layout-select').value = 'default';
        $('edit-layout-select').dispatchEvent(new window.Event('change', { bubbles: true }));
        await settle();
        expect(mode()).toBe('grid');
    });

    it('renames one', async () => {
        const h = await boot({ layouts: [{ id: 'L1', name: 'Old', custom: false, els: {} }], activeLayout: 'L1' });
        await settle();
        stubRects();
        await openEditor();
        $('edit-layout-rename').click();
        await settle();
        await answerPrompt('New name');
        const saved = h.lounge.settings.set.mock.calls.map((c) => c[0]).filter((p) => p && p.layouts).pop();
        expect(saved.layouts[0].name).toBe('New name');
    });

    it('deletes one, once it is confirmed, and falls back to Default', async () => {
        await boot({ layouts: [{ id: 'L1', name: 'Gone', custom: false, els: {} }], activeLayout: 'L1' });
        await settle();
        stubRects();
        await openEditor();
        $('edit-layout-delete').click();
        await settle();
        $('dialog-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
        await settle();
        expect(options()).toEqual(['Default']);
        expect($('edit-layout-select').value).toBe('default');
    });

    it('stops at ten, and says so before asking for a name', async () => {
        const full = Array.from({ length: 10 }, (_, i) => ({ id: 'L' + i, name: 'L' + i, custom: false, els: {} }));
        await boot({ layouts: full });
        await settle();
        stubRects();
        await openEditor();
        $('edit-layout-new').click();
        await settle();
        expect($('dialog').hidden).toBe(true);
        expect($('toast').textContent).toMatch(/10 layouts/);
    });

    it('caps a list that is already too long', async () => {
        const many = Array.from({ length: 14 }, (_, i) => ({ id: 'L' + i, name: 'L' + i, custom: false, els: {} }));
        await boot({ layouts: many });
        await settle();
        stubRects();
        await openEditor();
        expect(options().length).toBe(11);       // Default plus ten
    });

    it('says how many slots are used', async () => {
        await boot({ layouts: [{ id: 'L1', name: 'One', custom: false, els: {} }] });
        await settle();
        stubRects();
        await openEditor();
        expect($('edit-layout-count').textContent).toBe('1 of 10 saved layouts');
    });
});

describe('leaving', () => {
    it('puts everything back on Revert All Changes', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEditor();
        gesture(centreOf('user-dock'), { x: 500, y: 150 });
        await settle();
        expect(mode()).toBe('custom');

        $('edit-revert').click();
        await settle();
        expect(mode()).toBe('grid');
        expect($('user-dock').style.left).toBe('');
    });

    it('closes cleanly with nothing left drawn over the app', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEditor();
        $('edit-close').click();
        await settle();
        expect($('edit-mode').hidden).toBe(true);
        expect(document.body.classList.contains('edit-mode')).toBe(false);
        expect($('edit-frames').textContent).toBe('');
    });

    // Unsaved work is several minutes of fiddling, and Save is easy to walk past.
    it('asks before dropping unsaved changes, and keeps them if asked', async () => {
        const h = await boot({});
        await settle();
        stubRects();
        await openEditor();
        gesture(centreOf('user-dock'), { x: 500, y: 150 });
        await settle();

        $('edit-close').click();
        await settle();
        expect($('dialog').hidden).toBe(false);
        expect($('dialog-title').textContent).toMatch(/Leave Edit Mode/);
        // "Save and leave" -> the name prompt, then gone.
        $('dialog-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
        await settle();
        $('dialog-input').value = 'Kept';
        $('dialog-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
        await settle();

        expect($('edit-mode').hidden).toBe(true);
        const saved = h.lounge.settings.set.mock.calls.map((c) => c[0]).filter((p) => p && p.layouts).pop();
        expect(saved.layouts[0].name).toBe('Kept');
    });

    it('discards them when told to', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEditor();
        gesture(centreOf('user-dock'), { x: 500, y: 150 });
        await settle();

        $('edit-close').click();
        await settle();
        $('dialog-cancel').click();
        await settle();
        expect($('edit-mode').hidden).toBe(true);
        expect(mode()).toBe('grid');
    });

    it('leaves straight away when nothing has changed', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEditor();
        $('edit-close').click();
        await settle();
        expect($('dialog').hidden).toBe(true);
        expect($('edit-mode').hidden).toBe(true);
    });
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Right-click an element and it offers the adjustments THAT element has.

describe('per-element options', () => {
    function rightClick(id) {
        const c = centreOf(id);
        $('edit-shield').dispatchEvent(new window.MouseEvent('contextmenu', {
            bubbles: true, cancelable: true, clientX: c.x, clientY: c.y
        }));
    }
    const labels = () => [...$('el-options-body').querySelectorAll('.ep-label')]
        .map((l) => l.textContent.trim().replace(/\s+\d+%$/, ''));
    const seg = (label) => {
        const row = [...$('el-options-body').querySelectorAll('.ep-row')]
            .find((r) => r.querySelector('.ep-label').textContent.startsWith(label));
        return row ? [...row.querySelectorAll('.ep-seg button')] : [];
    };

    it('opens on a right-click, named for what was under the pointer', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEditor();
        expect($('el-options').hidden).toBe(true);

        rightClick('user-dock');
        await settle();
        expect($('el-options').hidden).toBe(false);
        expect($('el-options-title').textContent).toBe('Me bar');
        // …and selects it, so the outline says which one is being adjusted.
        expect($('edit-selected').querySelector('.ep-sel-name').textContent).toBe('Me bar');
    });

    it('offers a bar its orientation, its order and its size', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEditor();
        rightClick('user-dock');
        await settle();
        expect(labels()).toEqual(['Orientation', 'Order', 'Width', 'Height', 'Shown']);
    });

    // A control that does nothing is worse than no control: the member list has
    // no meaningful orientation, so it is not offered one.
    it('offers a panel only what a panel has', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEditor();
        rightClick('members-panel');
        await settle();
        expect(labels()).toEqual(['Order', 'Width', 'Height', 'Shown']);

        rightClick('main');
        await settle();
        expect(labels()).toEqual(['Width', 'Height', 'Shown']);
    });

    it('turns a bar on its side', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEditor();
        rightClick('user-dock');
        await settle();
        expect($('me-bar').dataset.flow).toBe(undefined);

        seg('Orientation').find((b) => b.textContent === 'Vertical').click();
        await settle();
        expect($('me-bar').dataset.flow).toBe('column');

        seg('Orientation').find((b) => b.textContent === 'Horizontal').click();
        await settle();
        // Back to its own default means no attribute at all, not one that
        // restates it.
        expect($('me-bar').dataset.flow).toBe(undefined);
    });

    it('reverses the order of what is inside', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEditor();
        rightClick('chan-head');
        await settle();
        seg('Order').find((b) => b.textContent === 'Reversed').click();
        await settle();
        expect($('chan-head').dataset.flow).toBe('row-reverse');
    });

    it('resizes from the sliders', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEditor();
        rightClick('members-panel');
        await settle();
        const width = [...$('el-options-body').querySelectorAll('input[type="range"]')][0];
        width.value = '40';
        width.dispatchEvent(new window.Event('input', { bubbles: true }));
        await settle();
        expect(boxOf('members-panel').w).toBe(400);
    });

    it('reverts just that element, leaving the others alone', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEditor();
        gesture(centreOf('user-dock'), { x: 500, y: 200 });
        await settle();
        gesture(centreOf('sidebar'), { x: 300, y: 300 });
        await settle();
        const movedSidebar = boxOf('sidebar');

        rightClick('user-dock');
        await settle();
        $('el-revert').click();
        await settle();
        expect(boxOf('user-dock')).toEqual({ x: 0, y: 640, w: 372, h: 60 });
        expect(boxOf('sidebar')).toEqual(movedSidebar);
    });

    it('puts one element back where the default arrangement has it', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEditor();
        gesture(centreOf('members-panel'), { x: 300, y: 300 });
        await settle();
        expect(boxOf('members-panel').x).not.toBe(736);

        rightClick('members-panel');
        await settle();
        $('el-reset').click();
        await settle();
        expect(boxOf('members-panel')).toEqual({ x: 736, y: 48, w: 264, h: 652 });
    });

    it('closes on a click outside, and with edit mode', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEditor();
        rightClick('user-dock');
        await settle();
        document.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
        await settle();
        expect($('el-options').hidden).toBe(true);

        rightClick('user-dock');
        await settle();
        $('edit-close').click();
        await settle();
        expect($('el-options').hidden).toBe(true);
    });

    it('says nothing when the right-click lands on nothing', async () => {
        await boot({});
        await settle();
        stubRects();
        await openEditor();
        $('edit-shield').dispatchEvent(new window.MouseEvent('contextmenu', {
            bubbles: true, cancelable: true, clientX: 4000, clientY: 4000
        }));
        await settle();
        expect($('el-options').hidden).toBe(true);
    });
});

describe('the stylesheet behind it', () => {
    it('lays the checkbox list out in two columns', () => {
        expect(CSS).toMatch(/\.ep-list \{[^}]*grid-template-columns: 1fr 1fr/);
        expect(CSS).toMatch(/\.ep-group \{[^}]*grid-column: 1 \/ -1/);
    });

    // The base rules are id selectors (#rail, #me-bar, #chan-head); an attribute
    // alone loses to every one of them. Scoping under #app outranks them without
    // reaching for !important.
    it('outranks the elements’ own flex rules without !important', () => {
        expect(CSS).toMatch(/#app \[data-flow="row-reverse"\] \{ flex-direction: row-reverse; \}/);
        expect(CSS).toMatch(/#app \[data-flow="column"\] \{ flex-direction: column; \}/);
        expect(CSS).not.toMatch(/data-flow[^}]*!important/);
    });
});

describe('the stylesheet behind the shell', () => {
    it('keeps the default arrangement a grid, and only that', () => {
        expect(CSS).toMatch(/#app \{[^}]*grid-template-areas:\s*\n?\s*"rail side head head"/);
        expect(CSS).toMatch(/#app\[data-layout="custom"\] \{[^}]*display: block/);
        expect(CSS).toMatch(/#app\[data-layout="custom"\] > \[data-el\] \{[^}]*position: absolute/);
    });

    it('hides with display, so the grid closes over the gap', () => {
        expect(CSS).toMatch(/\[data-el\]\.el-hidden \{ display: none !important; \}/);
    });

    it('draws the grid overlay from one custom property', () => {
        expect(CSS).toMatch(/--edit-grid:\s*24px/);
        expect(CSS).toMatch(/#edit-grid \{[\s\S]*?repeating-linear-gradient/);
    });

    it('takes the drag strips away where they would do nothing', () => {
        expect(CSS).toMatch(/#app\[data-layout="custom"\] \.pane-resize \{ display: none; \}/);
    });
});
