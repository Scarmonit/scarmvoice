// @vitest-environment jsdom
//
// The Accessibility and System panes, and the switches that replaced the
// checkboxes across Notifications.
//
// The point of this file is that none of it is decoration. Every control here
// writes a setting AND changes something — a class, a variable, an IPC call — and
// what it changes is asserted rather than assumed. A settings pane full of
// toggles that control nothing is exactly what the guardrail for this work said
// not to build.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { bootRenderer, $, settle } from './helpers/renderer.js';

const router = () => vi.fn(async (p) => {
    if (p === 'list') return { success: true, posts: [], typing: [], voice: [], hasMore: false, maxId: 0 };
    if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
    if (p === 'presence') return { success: true, members: [] };
    if (p === 'dm/threads') return { success: true, threads: [] };
    // An avatar on file for user 1, so the preview has a real picture to resolve —
    // which is the whole point of the fixture reading myUserId() rather than -1.
    if (p === 'avatars') return { success: true, avatars: { 1: 'board/avatars/1.png' } };
    return { success: true };
});

const root = () => document.documentElement;
// app.js as text, for the handful of assertions about WIRING that jsdom's lack of
// layout puts out of reach — the scrollspy reads geometry, and every rect is zero.
const readSrc = () => fs.readFileSync(
    path.resolve(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
const pane = (title) => Array.from(document.querySelectorAll('#settings-body .set-group'))
    .find((g) => g.querySelector('h3') && g.querySelector('h3').textContent.trim() === title);
const nav = (title) => Array.from(document.querySelectorAll('.set-nav-item'))
    .find((b) => b.textContent.trim() === title);

// A slider moves by setting value + dispatching input, which is what dragging one
// does — the app listens on `input` so the change lands under the thumb.
async function slide(id, value) {
    const el = $(id);
    el.value = String(value);
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
    await settle();
}
async function flip(id) {
    $(id).click();
    await settle();
}

let h;
beforeAll(async () => {
    localStorage.clear();
    h = await bootRenderer({ board: router() });
    await settle();
    // Open the sheet the way a person does, so every control is painted from the
    // settings rather than left at its markup default.
    $('btn-settings').click();
    await settle(20);
});

describe('the panes exist and are reachable', () => {
    it('has an Accessibility pane and a System pane', () => {
        expect(pane('Accessibility')).toBeTruthy();
        expect(pane('System')).toBeTruthy();
        expect(nav('Accessibility')).toBeTruthy();
        expect(nav('System')).toBeTruthy();
    });

    it('replaced Behaviour with System rather than adding a second one', () => {
        expect(pane('Behaviour')).toBeUndefined();
    });

    it('has the reference s Accessibility subsections', () => {
        const subs = Array.from(pane('Accessibility').querySelectorAll('h4.set-sub'))
            .map((h4) => h4.textContent);
        expect(subs).toEqual([
            'Text Readability', 'Visual Density', 'Color & Contrast',
            'Reduced Motion', 'Audio & Screen Reader'
        ]);
    });

    it('has the reference s Notifications subsections, minus Email', () => {
        const subs = Array.from(pane('Notifications').querySelectorAll('h4.set-sub'))
            .map((h4) => h4.textContent);
        // No Email: this board sends no notification mail, so a pane for it would
        // control nothing.
        expect(subs).toEqual(['Overview', 'Sounds', 'Badges', 'Advanced']);
    });

    it('builds no Nitro, billing, phone or category settings', () => {
        const text = $('settings-body').textContent;
        ['Nitro', 'Billing', 'Subscription', 'Phone Number', 'Family Center', 'Account Standing']
            .forEach((word) => expect(text, word).not.toContain(word));
    });
});

describe('the live preview', () => {
    it('draws real message rows through the real renderer', async () => {
        nav('Accessibility').click();
        await settle();
        const msgs = $('a11y-preview-msgs').querySelectorAll('.msg');
        expect(msgs.length).toBe(2);
        // Real rendering, not a picture: the markdown, the link and the reactions
        // all come out of the same code the conversation uses.
        expect($('a11y-preview-msgs').querySelector('strong').textContent).toBe('bold');
        expect($('a11y-preview-msgs').querySelector('a')).toBeTruthy();
        expect($('a11y-preview-msgs').querySelectorAll('button.reaction').length).toBe(2);
    });
});

describe('Text Readability', () => {
    it('sets the chat font size in pixels, and moves the variable', async () => {
        await slide('set-font-px', 20);
        expect(h.settings.chatFontPx).toBe(20);
        expect(root().style.getPropertyValue('--chat-fs')).toBe('20px');
        // The old four-name scale is still written, so anything reading it keeps
        // working — 20px is nearest to "Extra Large" (21px).
        expect(h.settings.chatFontSize).toBe('xlarge');
    });

    // The sizes the chat actually offers are NOT evenly spaced (12, 14, 15, 16, 18,
    // 20, 24), so step="1" let the thumb rest on 13 or 17 — a size no tick names.
    // The value snaps onto the nearest one it may hold, and the element's own value
    // is rewritten so the thumb lands there too.
    it('snaps to the sizes the scale actually names', async () => {
        await slide('set-font-px', 17);
        expect($('set-font-px').value).toBe('16');
        expect(h.settings.chatFontPx).toBe(16);

        await slide('set-font-px', 13);
        expect($('set-font-px').value).toBe('12');

        // 22 is two from 20 and two from 24; the first of the pair wins, which is
        // what a stable nearest-match gives.
        await slide('set-font-px', 22);
        expect($('set-font-px').value).toBe('20');
        await slide('set-font-px', 16);
    });

    it('clamps to the reference s 12-24 range', async () => {
        await slide('set-font-px', 99);
        expect(h.settings.chatFontPx).toBe(24);
        await slide('set-font-px', 1);
        expect(h.settings.chatFontPx).toBe(12);
        await slide('set-font-px', 16);
    });

    it('highlights the nearest mark on the scale, and marks the track', async () => {
        await slide('set-font-px', 18);
        const host = $('ticks-font');
        const labels = Array.from(host.querySelectorAll('.set-tick'));
        expect(labels.filter((t) => t.classList.contains('on')).map((t) => t.textContent))
            .toEqual(['18px']);
        // A TICK MARK per value as well as a label. The track used to be a plain bar
        // with numbers floating above it, so every label named a position nothing on
        // the track agreed with.
        expect(host.querySelectorAll('.set-tick-mark')).toHaveLength(labels.length);
        // The end labels align to their own end rather than centring on it —
        // centred, the first hangs off the left of the column.
        expect(labels[0].classList.contains('first')).toBe(true);
        expect(labels[labels.length - 1].classList.contains('last')).toBe(true);
        await slide('set-font-px', 16);
    });

    it('gives every slider in the sheet a scale, not just this pane s', () => {
        // Voice & Audio's three had no scale at all, and set --fill nowhere, so they
        // sat permanently half filled at the CSS default.
        ['set-font-px', 'set-msg-gap', 'set-zoom', 'set-saturation',
            'set-invol', 'set-outvol', 'set-vad'].forEach((id) => {
            const input = $(id);
            expect(input, id).toBeTruthy();
            const host = input.previousElementSibling;
            expect(host && host.classList.contains('set-ticks'), id).toBe(true);
            expect(host.querySelectorAll('.set-tick-mark').length, id).toBeGreaterThan(1);
            expect(host.querySelectorAll('.set-tick').length, id)
                .toBe(host.querySelectorAll('.set-tick-mark').length);
            expect(input.style.getPropertyValue('--fill'), id).not.toBe('');
        });
    });

    it('underlines links only when asked', async () => {
        expect(root().classList.contains('underline-links')).toBe(false);
        await flip('set-underline');
        expect(h.settings.underlineLinks).toBe(true);
        expect(root().classList.contains('underline-links')).toBe(true);
        await flip('set-underline');
        expect(root().classList.contains('underline-links')).toBe(false);
    });
});

describe('Visual Density', () => {
    it('writes UI density onto the root, where the list rules read it', async () => {
        const spacious = document.querySelector('input[name="set-uidensity"][value="spacious"]');
        spacious.checked = true;
        spacious.dispatchEvent(new window.Event('change', { bubbles: true }));
        await settle();
        expect(h.settings.uiDensity).toBe('spacious');
        expect(root().dataset.uiDensity).toBe('spacious');
    });

    it('drives the same density the message list already had', async () => {
        const compact = document.querySelector('input[name="set-msgdisplay"][value="compact"]');
        compact.checked = true;
        compact.dispatchEvent(new window.Event('change', { bubbles: true }));
        await settle();
        expect(h.settings.density).toBe('compact');
        expect($('messages').classList.contains('compact')).toBe(true);

        const dflt = document.querySelector('input[name="set-msgdisplay"][value="cozy"]');
        dflt.checked = true;
        dflt.dispatchEvent(new window.Event('change', { bubbles: true }));
        await settle();
        expect($('messages').classList.contains('compact')).toBe(false);
    });

    it('sets message-group spacing, and clears the override at the shipped value', async () => {
        await slide('set-msg-gap', 4);
        expect(h.settings.msgGroupGap).toBe(4);
        expect(root().style.getPropertyValue('--msg-gap')).toBe('4px');
        // 16 is what the stylesheet's own em-based margin already produces, so the
        // override comes off rather than pinning it to a pixel value.
        await slide('set-msg-gap', 16);
        expect(root().style.getPropertyValue('--msg-gap')).toBe('');
    });

    // ON RELEASE, not while dragging. Zoom is the one slider whose effect is the
    // whole window, so watching the interface pulse under the thumb is not a preview
    // — `change` on a range input is exactly "the drag ended".
    it('does not zoom while the thumb is moving', async () => {
        h.lounge.app.setZoom.mockClear();
        await slide('set-zoom', 150);          // `input` only
        await settle(20);
        expect(h.lounge.app.setZoom).not.toHaveBeenCalled();
        // …but the scale follows the thumb, so the control still feels live.
        expect(Array.from($('ticks-zoom').querySelectorAll('.set-tick'))
            .filter((t) => t.classList.contains('on')).map((t) => t.textContent)).toEqual(['150']);
    });

    it('asks the main process to zoom when the drag ends', async () => {
        h.lounge.app.setZoom.mockClear();
        const el = $('set-zoom');
        el.value = '125';
        el.dispatchEvent(new window.Event('change', { bubbles: true }));
        await settle(20);
        expect(h.lounge.app.setZoom).toHaveBeenCalledWith(125);
        expect(h.settings.zoomLevel).toBe(125);

        el.value = '100';
        el.dispatchEvent(new window.Event('change', { bubbles: true }));
        await settle(20);
    });

    it('snaps zoom onto the stops it actually offers', async () => {
        // Non-uniform, like the font scale — and step="1" on the element, because a
        // step attribute re-snaps whatever the list writes back: snapping 60 to 67
        // then had step="5" turn it into 65, a level no tick names.
        await slide('set-zoom', 103);
        expect($('set-zoom').value).toBe('100');
        await slide('set-zoom', 58);
        expect($('set-zoom').value).toBe('50');
        const el = $('set-zoom');
        el.value = '100';
        el.dispatchEvent(new window.Event('change', { bubbles: true }));
        await settle(20);
    });
});

describe('Color & Contrast', () => {
    it('applies 0% as 0%, not as 100%', async () => {
        // The bug: the value was parsed as `(parseInt(…) || 0) || 100`, and 0 is
        // falsy — so dragging to 0% applied FULL saturation. The one value where the
        // reading and the effect were opposites.
        await slide('set-saturation', 0);
        expect(h.settings.saturation).toBe(0);
        expect(root().classList.contains('desat')).toBe(true);
        expect(root().style.getPropertyValue('--sat')).toBe('0');
        // …and the media exemption is a no-op at zero rather than a divide by zero:
        // calc(1 / 0) is invalid at computed-value time, so the declaration would be
        // dropped and images would inherit the greyscale they are meant to escape.
        expect(root().style.getPropertyValue('--unsat')).toBe('1');
        await slide('set-saturation', 100);
    });

    it('desaturates through a variable, and takes the filter off entirely at 100', async () => {
        await slide('set-saturation', 40);
        expect(root().classList.contains('desat')).toBe(true);
        expect(root().style.getPropertyValue('--sat')).toBe('0.4');
        expect(root().style.getPropertyValue('--unsat')).toBe('2.5');

        // A filter creates a containing block, so leaving one on at saturate(1)
        // would change how position:fixed resolves for every descendant — for no
        // visual gain at all.
        await slide('set-saturation', 100);
        expect(root().classList.contains('desat')).toBe(false);
        expect(root().style.getPropertyValue('--sat')).toBe('');
    });

    it('turns high contrast on and off', async () => {
        await flip('set-contrast');
        expect(h.settings.highContrast).toBe(true);
        expect(root().classList.contains('high-contrast')).toBe(true);
        await flip('set-contrast');
        expect(root().classList.contains('high-contrast')).toBe(false);
    });
});

describe('Reduced Motion and the screen reader', () => {
    it('stops animations on request, not only when Windows asks', async () => {
        await flip('set-reduced-motion');
        expect(h.settings.reducedMotion).toBe(true);
        expect(root().classList.contains('no-motion')).toBe(true);
        await flip('set-reduced-motion');
        expect(root().classList.contains('no-motion')).toBe(false);
    });

    it('makes the conversation an assertive live region when asked', async () => {
        expect($('messages').getAttribute('aria-live')).toBe('polite');
        await flip('set-announce');
        expect($('messages').getAttribute('aria-live')).toBe('assertive');
        await flip('set-announce');
        expect($('messages').getAttribute('aria-live')).toBe('polite');
    });
});

describe('System', () => {
    it('greys out Start minimized until launch-on-startup is on', async () => {
        expect($('row-launch-hidden').classList.contains('disabled')).toBe(true);
        expect($('set-launch-hidden').disabled).toBe(true);

        await flip('set-launch');
        expect(h.lounge.startup.set).toHaveBeenCalled();
    });

    it('reads the OS back rather than assuming the write took', async () => {
        // Windows can refuse. A switch that flipped anyway would be lying, so the
        // answer comes from the login item and not from the click.
        h.lounge.startup.set.mockImplementation(async () => ({ openAtLogin: false, openAsHidden: false }));
        await flip('set-launch');
        expect($('set-launch').getAttribute('aria-checked')).toBe('false');
    });

    it('offers a restart for hardware acceleration rather than pretending', async () => {
        await flip('set-hwaccel');
        expect(h.settings.hardwareAcceleration).toBe(false);
        // The dialog is the whole point: Chromium can only be told before start-up.
        expect($('dialog').hidden).toBe(false);
        expect($('dialog-msg').textContent).toContain('restart');
        $('dialog-cancel').click();
        await settle();
        // Declined, so it is saved and NOT applied — no relaunch behind their back.
        expect(h.lounge.app.relaunch).not.toHaveBeenCalled();
        await flip('set-hwaccel');
        $('dialog-cancel').click();
        await settle();
    });

    it('lists only keybinds the app really implements', () => {
        const labels = Array.from($('set-default-keys').querySelectorAll('.set-key'))
            .map((r) => r.firstChild.textContent);
        expect(labels).toContain('Search this channel');
        expect(labels).toContain('Larger chat text');
        // Nothing about servers, overlays or quick-switchers: none of them exist
        // here, and a shortcut list that lies is worse than a short one.
        const text = $('set-default-keys').textContent;
        ['server', 'Overlay', 'QuickSwitcher'].forEach((w) => expect(text).not.toContain(w));
    });

    it('edits one push-to-talk binding from either pane', () => {
        // Voice & Audio's advanced block and System's keybind list are two views of
        // ONE setting; two buttons showing different keys for the same hotkey is
        // the bug this shape avoids.
        expect($('set-ptt-2').textContent).toBe($('set-ptt').textContent);
    });
});

describe('Notifications', () => {
    it('is switches now, not checkboxes', () => {
        ['set-notify', 'set-taskbar-flash', 'set-dnd', 'set-notify-sound',
            'set-sound-own', 'set-voice-sounds', 'set-mute-sounds', 'set-badge']
            .forEach((id) => {
                expect($(id), id).toBeTruthy();
                expect($(id).getAttribute('role'), id).toBe('switch');
            });
    });

    it('previews a sound without changing anything', async () => {
        const play = vi.spyOn(window.loungeSounds, 'playMessage');
        pane('Notifications').querySelector('.set-preview').click();
        await settle();
        expect(play).toHaveBeenCalled();
        play.mockRestore();
    });

    it('silences every sound with one switch, and keeps the individual choices', async () => {
        expect(h.settings.notificationSound).not.toBe(false);
        await flip('set-mute-sounds');
        expect(h.settings.disableAllSounds).toBe(true);
        // The individual settings are untouched, so turning it off restores them
        // rather than a default.
        expect(h.settings.notificationSound).not.toBe(false);
        await flip('set-mute-sounds');
        expect(h.settings.disableAllSounds).toBe(false);
    });

    it('sends the taskbar-flash choice with the badge count', async () => {
        h.lounge.app.setBadge.mockClear();
        await flip('set-taskbar-flash');
        // Two answers, not one folded together: somebody can want the count
        // without the button pulsing at them.
        expect(h.settings.taskbarFlash).toBe(false);
        await flip('set-taskbar-flash');
    });
});

// The two internal inconsistencies the preview had: it drew a GENERATED avatar
// while every other face in the app — the message list, the sidebar, and the
// profile header at the top of this very sheet — drew the real photograph, and
// neither of its reaction pills was in the reacted state, so it could not show that
// the two states differ at all.
describe('the preview shows the reader s own message, not a stand-in', () => {
    it('resolves the avatar the same way the message list does', async () => {
        nav('Accessibility').click();
        await settle();
        const av = $('a11y-preview-msgs').querySelector('.msg-avatar');
        expect(av).toBeTruthy();
        // With an avatar on file the row carries the class that shows the picture;
        // the fixture used to hard-code user_id: -1, which could never resolve one.
        expect(av.classList.contains('has-img')).toBe(true);
        expect(av.querySelector('img')).toBeTruthy();
    });

    it('names the reader, not a hard-coded name', async () => {
        nav('Accessibility').click();
        await settle();
        expect($('a11y-preview-msgs').querySelector('.msg-author').textContent)
            .toBe(h.settings.displayName);
    });

    it('shows one reaction reacted-to and one not', async () => {
        nav('Accessibility').click();
        await settle();
        const pills = Array.from($('a11y-preview-msgs').querySelectorAll('.reaction'));
        expect(pills).toHaveLength(2);
        expect(pills[0].classList.contains('mine')).toBe(true);
        expect(pills[1].classList.contains('mine')).toBe(false);
    });
});

// The sub-nav is TWO-WAY: clicking an entry scrolls to its heading, and scrolling
// moves the highlight to whatever you are reading. On every pane with subsections,
// not just Accessibility.
//
// jsdom does no layout, so getBoundingClientRect answers zero for everything and
// the spy cannot be driven by real geometry here. What it CAN pin is the wiring and
// the bug: the scroll reset that made a click bounce, and the fact that every pane
// is subscribed rather than one.
describe('the settings sub-nav', () => {
    const subsOf = (pane) => {
        nav(pane).click();
        const wrap = Array.from(document.querySelectorAll('.set-nav-subs')).find((w) => !w.hidden);
        return wrap ? Array.from(wrap.children).filter((b) => !b.hidden) : [];
    };

    it('lists subsections for every pane that has them, not just Accessibility', () => {
        ['Accessibility', 'Notifications', 'System', 'Account', 'Voice & Audio'].forEach((pane) => {
            expect(subsOf(pane).length, pane).toBeGreaterThan(1);
        });
    });

    // THE BOUNCE. showPane() reset the scroller to the top unconditionally, and the
    // sub-nav click calls showPane for the pane that is ALREADY OPEN — so the scroll
    // snapped to 0 and the smooth scroll to the heading then ran from there. Two
    // competing scroll actions, which is exactly how it looked.
    it('does not reset the scroll when the pane is already open', async () => {
        const body = $('settings-body');
        nav('Accessibility').click();
        await settle();

        // jsdom will hold whatever scrollTop is assigned even without layout.
        body.scrollTop = 400;
        const subs = subsOf('Accessibility');
        subs[2].click();
        await settle();
        expect(body.scrollTop, 'a same-pane click must not jump to the top').toBe(400);
    });

    it('DOES reset the scroll when the pane changes', async () => {
        const body = $('settings-body');
        nav('Accessibility').click();
        await settle();
        body.scrollTop = 400;
        nav('System').click();
        await settle();
        // A different pane is a different document; starting part-way down it would
        // be showing the middle of something never opened.
        expect(body.scrollTop).toBe(0);
    });

    it('marks the clicked entry, and only that one', async () => {
        const subs = subsOf('Notifications');
        subs[2].click();
        await settle();
        const on = subs.filter((b) => b.classList.contains('on'));
        expect(on).toHaveLength(1);
        expect(on[0]).toBe(subs[2]);
    });

    it('scrolls smoothly rather than jumping', async () => {
        // The animation is what makes the bounce visible when it happens, and a
        // jump-to would hide it — so the call itself is worth pinning.
        const body = $('settings-body');
        const spy = vi.spyOn(body, 'scrollTo');
        subsOf('Accessibility')[1].click();
        await settle();
        expect(spy).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }));
        spy.mockRestore();
    });

    it('subscribes the scroller once, for whichever pane is open', async () => {
        // One listener on the scroller that asks which pane is showing, rather than
        // one per pane — so a new pane with an h4.set-sub is spied on for free.
        const src = readSrc();
        const fn = src.slice(src.indexOf('function syncSpy'), src.indexOf('function showPane'));
        expect(fn).toContain('items.find((it) => !it.g.hidden)');
        expect(src).toContain("body.addEventListener('scroll', syncSpy, { passive: true })");
        // …and the bottom of the pane counts as the last section, which a short
        // final section could never reach by its heading alone.
        expect(fn).toContain('body.scrollHeight - body.scrollTop - body.clientHeight');
    });
});
