// @vitest-environment jsdom
//
// The theme feature as the person in Settings meets it: the Ash and Onyx
// radios, and the "Customize your theme" modal — base toggle, hex entry,
// intensity, add/remove colour, surprise, reset. The engine's own maths is
// covered in theme-engine.test.js; this file is about the wiring.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { bootRenderer, $, settle } from './helpers/renderer.js';

let app;
const rootStyle = () => document.documentElement.style;
const rootVar = (p) => rootStyle().getPropertyValue(p).trim();

function pickRadio(value) {
    const r = document.querySelector(`input[name="set-theme"][value="${value}"]`);
    r.checked = true;
    r.dispatchEvent(new window.Event('change', { bubbles: true }));
    return settle(6);
}

beforeAll(async () => {
    const board = vi.fn(async (p) => {
        const key = String(p).split('?')[0];
        if (key === 'list') return { success: true, posts: [], hasMore: false, typing: [], voice: [] };
        if (key === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
        if (key === 'presence') return { success: true, members: [] };
        if (key === 'dm/threads') return { success: true, threads: [] };
        return { success: true };
    });
    app = await bootRenderer({ board });
    await settle(30);
});

describe('the preset themes', () => {
    it('dark is the stylesheet alone — nothing written inline', async () => {
        await pickRadio('dark');
        expect(rootVar('--chat')).toBe('');
        expect(document.documentElement.dataset.theme).toBe('dark');
    });

    it('ash and onyx write their ramps over the dark base', async () => {
        await pickRadio('ash');
        expect(app.settings.theme).toBe('ash');
        const ashChat = rootVar('--chat');
        expect(ashChat).not.toBe('');
        // Still a DARK theme as far as every base-conditional rule knows.
        expect(document.documentElement.dataset.theme).toBe('dark');

        await pickRadio('onyx');
        expect(rootVar('--chat')).not.toBe(ashChat);
        expect(document.documentElement.dataset.theme).toBe('dark');

        // …and picking a stock theme again clears every override.
        await pickRadio('dark');
        expect(rootVar('--chat')).toBe('');
    });
});

describe('the customizer', () => {
    it('opening it IS choosing the custom theme, and it previews live', async () => {
        $('btn-theme-custom').click();
        await settle(8);
        expect($('theme-modal').hidden).toBe(false);
        expect(app.settings.theme).toBe('custom');
        // The default custom colour is applied to the app behind the modal.
        expect(rootVar('--chat')).not.toBe('');
    });

    it('typing a hex applies that colour', async () => {
        const hex = $('tm-hex');
        hex.value = '#ff0000';
        hex.dispatchEvent(new window.Event('input', { bubbles: true }));
        await settle(4);
        const chat = rootVar('--chat');
        const r = parseInt(chat.slice(1, 3), 16), b = parseInt(chat.slice(5, 7), 16);
        expect(r).toBeGreaterThan(b);
        expect($('tm-swatch-current').style.background).toBeTruthy();
    });

    it('intensity 0 hands the ramp back untouched', async () => {
        const slider = $('tm-intensity');
        slider.value = '0';
        slider.dispatchEvent(new window.Event('input', { bubbles: true }));
        await settle(4);
        expect($('tm-intensity-val').textContent).toBe('0%');
        expect(rootVar('--chat')).toBe('#1a1a1e');

        slider.value = '80';
        slider.dispatchEvent(new window.Event('input', { bubbles: true }));
        await settle(4);
        expect(rootVar('--chat')).not.toBe('#1a1a1e');
    });

    it('adds a second colour, then removes it', async () => {
        $('tm-add').click();
        await settle(4);
        expect(document.querySelectorAll('#tm-swatches .tm-sw').length).toBe(2);
        // With one colour there is nothing to remove, so no × was offered;
        // with two, every swatch carries one.
        const x = document.querySelector('#tm-swatches .tm-sw .tm-sw-x');
        expect(x).toBeTruthy();
        x.click();
        await settle(4);
        expect(document.querySelectorAll('#tm-swatches .tm-sw').length).toBe(1);
        expect(document.querySelector('#tm-swatches .tm-sw .tm-sw-x')).toBe(null);
    });

    it('the base toggle flips the whole app to a light footing', async () => {
        $('tm-base-light').click();
        await settle(4);
        expect(document.documentElement.dataset.theme).toBe('light');
        $('tm-base-dark').click();
        await settle(4);
        expect(document.documentElement.dataset.theme).toBe('dark');
    });

    it('surprise stays valid; reset goes back to the default colour', async () => {
        $('tm-surprise').click();
        await settle(4);
        const cfg = app.settings.customTheme;
        expect(cfg.colors.length).toBeGreaterThanOrEqual(1);
        expect(cfg.colors.length).toBeLessThanOrEqual(2);
        cfg.colors.forEach((c) => expect(c).toMatch(/^#[0-9a-f]{6}$/));
        // Surprise recolours the world; it must not flip day to night.
        expect(cfg.base).toBe('dark');

        $('tm-reset').click();
        await settle(4);
        expect(app.settings.customTheme.colors).toEqual(['#5865f2']);
        expect(app.settings.customTheme.intensity).toBe(70);
    });

    it('closes on Escape without dropping the edits', async () => {
        const ev = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
        $('theme-modal').dispatchEvent(ev);
        await settle(6);
        expect($('theme-modal').hidden).toBe(true);
        // The theme survives the modal: the tint is still applied.
        expect(app.settings.theme).toBe('custom');
        expect(rootVar('--chat')).not.toBe('');
    });

    it('docks beside the app instead of covering it', async () => {
        // The whole feature is the LIVE preview, and a centered modal over a
        // scrim sat on top of the very thing being previewed — the tint was
        // applying the entire time, invisibly, under 72% black. The picker is
        // a docked panel now, and nothing about opening it may dim the app.
        $('btn-theme-custom').click();
        await settle(8);
        expect($('theme-modal').hidden).toBe(false);
        expect($('theme-modal').classList.contains('tm-panel')).toBe(true);
        expect($('theme-modal').classList.contains('overlay'), 'no scrim wrapper').toBe(false);
        // The settings sheet covers the window, which is the preview — it is
        // closed on the way in…
        expect($('settings').hidden).toBe(true);
        // …and the footer's Back to Settings is the road back.
        $('tm-back').click();
        await settle(8);
        expect($('theme-modal').hidden).toBe(true);
        expect($('settings').hidden).toBe(false);
    });
});
