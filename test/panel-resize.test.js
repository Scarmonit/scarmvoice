// @vitest-environment jsdom
//
// The two resizable side panels: the channel list on the left, the member list on
// the right.
//
// HORIZONTAL ONLY, and the limits are the interesting part. A static floor and
// ceiling per panel stop either being dragged to a width it cannot be used at; on
// top of that a DYNAMIC clamp guarantees the message column keeps MAIN_MIN pixels
// whatever the window size. A static maximum alone cannot deliver that — 480 + 420
// is comfortable at 1900px wide and swallows the entire conversation at 1100px —
// which is why the clamp reads window.innerWidth and is re-applied on resize.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { bootRenderer, $, settle } from './helpers/renderer.js';

// Mirrors the constants in app.js. Written out rather than imported (the renderer
// is one IIFE with no exports), so a change to either has to be made twice —
// deliberately, because these numbers are a promise about the layout.
const SIDEBAR_MIN = 180, SIDEBAR_MAX = 480;
const MEMBERS_MIN = 160, MEMBERS_MAX = 420;
const MAIN_MIN = 420, RAIL_W = 72;

function router() {
    return vi.fn(async (p) => {
        if (p === 'list') return { success: true, posts: [], typing: [], voice: [], hasMore: false, maxId: 0 };
        if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
        if (p === 'presence') return { success: true, members: [] };
        if (p === 'dm/threads') return { success: true, threads: [] };
        return { success: true };
    });
}

// jsdom has no layout, so the property the grid reads IS the observable.
const sideW = () => parseInt(document.documentElement.style.getPropertyValue('--w-side'), 10);
const membersW = () => parseInt(document.documentElement.style.getPropertyValue('--w-members'), 10);

// jsdom implements neither pointer capture nor PointerEvent's coordinates the way a
// browser does, so the drag is driven through the same events the handler listens
// for with the two methods it calls stubbed out. The real thing is exercised
// end-to-end in test/e2e/panel-resize.spec.js.
function pointer(el, type, clientX, pointerId = 1) {
    const ev = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 });
    Object.defineProperty(ev, 'pointerId', { value: pointerId });
    el.dispatchEvent(ev);
    return ev;
}

function drag(handleId, fromX, toX) {
    const h = $(handleId);
    h.setPointerCapture = () => {};
    h.releasePointerCapture = () => {};
    pointer(h, 'pointerdown', fromX);
    pointer(h, 'pointermove', toX);
    pointer(h, 'pointerup', toX);
}

async function boot(width = 1400, settings = {}) {
    // jsdom's default is 1024, which is narrow enough that both panels start at
    // their dynamic ceiling and nothing can grow — a misleading baseline.
    window.innerWidth = width;
    const h = await bootRenderer({ board: router(), settings });
    await settle();
    return h;
}

beforeEach(() => { localStorage.clear(); });

describe('the widths a session starts with', () => {
    it('uses the stylesheet\'s values when nothing has been saved', async () => {
        await boot();
        expect(sideW()).toBe(300);
        expect(membersW()).toBe(264);
    });

    it('restores a width saved by a previous session', async () => {
        await boot(1400, { sidebarWidth: 360, membersWidth: 300 });
        expect(sideW()).toBe(360);
        expect(membersW()).toBe(300);
    });

    // A settings.json written by an older build has neither key.
    it('falls back cleanly when the saved value is nonsense', async () => {
        await boot(1400, { sidebarWidth: 0, membersWidth: null });
        expect(sideW()).toBe(300);
        expect(membersW()).toBe(264);
    });
});

describe('dragging the channel list', () => {
    it('follows the pointer to the right', async () => {
        await boot();
        drag('sidebar-resize', 300, 400);
        expect(sideW()).toBe(400);
    });

    it('follows the pointer to the left', async () => {
        await boot();
        drag('sidebar-resize', 300, 250);
        expect(sideW()).toBe(250);
    });

    it('stops at the minimum, so it cannot be made unusable', async () => {
        await boot();
        drag('sidebar-resize', 300, -500);
        expect(sideW()).toBe(SIDEBAR_MIN);
    });

    it('stops at the maximum', async () => {
        // Wide enough that the static ceiling is what binds, not the message column.
        await boot(2400);
        drag('sidebar-resize', 300, 3000);
        expect(sideW()).toBe(SIDEBAR_MAX);
    });

    // The requirement that a static maximum cannot express on its own.
    it('never crowds the message column, whatever the window width', async () => {
        await boot(1100);
        drag('sidebar-resize', 300, 3000);
        const main = 1100 - RAIL_W - sideW() - membersW();
        expect(main).toBeGreaterThanOrEqual(MAIN_MIN);
        // …and it really did stop short of its own static ceiling to do it.
        expect(sideW()).toBeLessThan(SIDEBAR_MAX);
    });

    it('is horizontal only — vertical pointer movement changes nothing', async () => {
        await boot();
        const h = $('sidebar-resize');
        h.setPointerCapture = () => {}; h.releasePointerCapture = () => {};
        pointer(h, 'pointerdown', 300);
        // Same clientX, and a clientY the handler never reads. There is deliberately
        // no vertical term anywhere in it.
        const ev = new window.MouseEvent('pointermove', { bubbles: true, clientX: 300, clientY: 900 });
        Object.defineProperty(ev, 'pointerId', { value: 1 });
        h.dispatchEvent(ev);
        pointer(h, 'pointerup', 300);
        expect(sideW()).toBe(300);
    });
});

describe('dragging the member list', () => {
    // Its handle is on the LEFT edge, so dragging left WIDENS it.
    it('widens when dragged left', async () => {
        await boot();
        drag('members-resize', 1000, 940);
        expect(membersW()).toBe(324);
    });

    it('narrows when dragged right', async () => {
        await boot();
        drag('members-resize', 1000, 1060);
        expect(membersW()).toBe(204);
    });

    it('stops at its minimum and its maximum', async () => {
        await boot(2400);
        drag('members-resize', 1000, 3000);
        expect(membersW()).toBe(MEMBERS_MIN);
        drag('members-resize', 1000, -3000);
        expect(membersW()).toBe(MEMBERS_MAX);
    });

    it('never crowds the message column either', async () => {
        await boot(1100);
        drag('members-resize', 1000, -3000);
        const main = 1100 - RAIL_W - sideW() - membersW();
        expect(main).toBeGreaterThanOrEqual(MAIN_MIN);
    });
});

describe('the width is remembered', () => {
    it('persists at the END of a drag, not on every frame', async () => {
        const h = await boot();
        h.lounge.settings.set.mockClear();

        const handle = $('sidebar-resize');
        handle.setPointerCapture = () => {}; handle.releasePointerCapture = () => {};
        pointer(handle, 'pointerdown', 300);
        pointer(handle, 'pointermove', 320);
        pointer(handle, 'pointermove', 340);
        pointer(handle, 'pointermove', 380);
        // Three frames of movement and nothing written yet: settings.set is an IPC
        // round trip and a debounced whole-file write, and a drag produces one move
        // event per frame.
        expect(h.lounge.settings.set).not.toHaveBeenCalled();

        pointer(handle, 'pointerup', 380);
        await settle();
        const patch = h.lounge.settings.set.mock.calls.at(-1)[0];
        expect(patch.sidebarWidth).toBe(380);
    });

    it('saves the member list width too', async () => {
        const h = await boot();
        h.lounge.settings.set.mockClear();
        drag('members-resize', 1000, 950);
        await settle();
        const patch = h.lounge.settings.set.mock.calls.at(-1)[0];
        expect(patch.membersWidth).toBe(314);
    });
});

describe('the handles as controls', () => {
    it('announce themselves as vertical separators', async () => {
        await boot();
        ['sidebar-resize', 'members-resize', 'dm-sidebar-resize'].forEach((id) => {
            const h = $(id);
            expect(h, id).toBeTruthy();
            expect(h.getAttribute('role')).toBe('separator');
            expect(h.getAttribute('aria-orientation')).toBe('vertical');
            expect(h.getAttribute('aria-label')).toBeTruthy();
            // Focusable, because the arrow keys below have to be reachable.
            expect(h.tabIndex).toBe(0);
        });
    });

    it('resizes with the arrow keys', async () => {
        await boot();
        $('sidebar-resize').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        expect(sideW()).toBe(310);
        $('sidebar-resize').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
        expect(sideW()).toBe(300);
        // Shift is the coarse step.
        $('sidebar-resize').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
        expect(sideW()).toBe(340);
    });

    // The handles are wired ONCE, however many times a session starts.
    //
    // initPaneResizing() runs from enterApp(), and enterApp() runs again on every
    // sign-in — but the handles are markup that outlives the session, so a
    // sign-out and back in left two sets of listeners on the same three of them.
    // Dragging survived it (the second mover saw the width the first had just
    // written and returned), and the keyboard did not: each duplicate read that
    // width and added the step again, so one press moved the panel two steps,
    // then three.
    it('still moves one step per press after signing out and back in', async () => {
        await boot();
        $('btn-logout').click();
        await settle(30);
        expect($('login').hidden).toBe(false);

        $('login-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
        await settle(40);
        expect($('app').hidden).toBe(false);
        expect(sideW()).toBe(300);

        $('sidebar-resize').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        expect(sideW()).toBe(310);
    });

    it('takes the member list the other way, matching its edge', async () => {
        await boot();
        // Its handle faces the messages, so Left widens it.
        $('members-resize').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
        expect(membersW()).toBe(274);
    });

    it('resets to the default on double-click', async () => {
        await boot(1400, { sidebarWidth: 470, membersWidth: 400 });
        expect(sideW()).toBe(470);
        $('sidebar-resize').dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
        expect(sideW()).toBe(300);
        $('members-resize').dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
        expect(membersW()).toBe(264);
    });
});

describe('a window that gets narrower', () => {
    // Shrinking the window is the other way to squeeze the message column, so the
    // clamp is re-applied rather than only enforced while dragging.
    it('gives width back rather than letting the panels swallow the messages', async () => {
        await boot(2000, { sidebarWidth: 480, membersWidth: 420 });
        expect(sideW()).toBe(480);

        window.innerWidth = 1100;
        window.dispatchEvent(new window.Event('resize'));

        const main = 1100 - RAIL_W - sideW() - membersW();
        expect(main).toBeGreaterThanOrEqual(MAIN_MIN);
        expect(sideW()).toBeLessThan(480);
    });
});

describe('hiding the member list', () => {
    it('lets the channel list use the room it frees', async () => {
        await boot(1100, { sidebarWidth: 480 });
        const withMembers = sideW();

        $('btn-members').click();
        await settle();

        // The panel is gone, so the sidebar's dynamic ceiling rises.
        expect($('members-panel').hidden).toBe(true);
        expect(sideW()).toBeGreaterThan(withMembers);
    });
});
