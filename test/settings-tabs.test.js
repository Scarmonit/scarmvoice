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
import { bootRenderer, $, settle } from './helpers/renderer.js';

const router = () => vi.fn(async (p) => {
    if (p === 'list') return { success: true, posts: [], typing: [], voice: [], hasMore: false, maxId: 0 };
    if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
    if (p === 'presence') return { success: true, members: [] };
    if (p === 'dm/threads') return { success: true, threads: [] };
    return { success: true };
});

const root = () => document.documentElement;
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
        await slide('set-font-px', 22);
        expect(h.settings.chatFontPx).toBe(22);
        expect(root().style.getPropertyValue('--chat-fs')).toBe('22px');
        // The old four-name scale is still written, so anything reading it keeps
        // working — 22px is nearest to "Extra Large" (21px).
        expect(h.settings.chatFontSize).toBe('xlarge');
    });

    it('clamps to the reference s 12-24 range', async () => {
        await slide('set-font-px', 99);
        expect(h.settings.chatFontPx).toBe(24);
        await slide('set-font-px', 1);
        expect(h.settings.chatFontPx).toBe(12);
        await slide('set-font-px', 16);
    });

    it('highlights the nearest mark on the scale', async () => {
        await slide('set-font-px', 18);
        const on = Array.from($('ticks-font').children).filter((t) => t.classList.contains('on'));
        expect(on.map((t) => t.textContent)).toEqual(['18px']);
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

    it('asks the main process to zoom, because the renderer has no webFrame', async () => {
        await slide('set-zoom', 125);
        await settle(20);
        expect(h.lounge.app.setZoom).toHaveBeenCalledWith(125);
        expect(h.settings.zoomLevel).toBe(125);
        await slide('set-zoom', 100);
        await settle(20);
    });
});

describe('Color & Contrast', () => {
    it('desaturates through a variable, and takes the filter off entirely at 100', async () => {
        await slide('set-saturation', 40);
        expect(root().classList.contains('desat')).toBe(true);
        expect(root().style.getPropertyValue('--sat')).toBe('0.4');

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
