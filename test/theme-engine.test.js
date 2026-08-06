// @vitest-environment jsdom
//
// The theme engine: Ash, Onyx, and the custom tint.
//
// The engine carries a MIRROR of the stylesheet's two palettes (reading them
// back through the cascade would tie it to a painted window and to load
// order), and a mirror can drift — so the first thing here parses styles.css
// and holds the mirror against it, value for value. If somebody retunes a
// surface in the stylesheet and not in theme.js, this is the test that says so.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RENDERER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');

let T;   // window.ScarmTheme

beforeAll(() => {
    new Function(fs.readFileSync(path.join(RENDERER, 'theme.js'), 'utf8')).call(window);
    T = window.ScarmTheme;
});

// Pull "--token: value;" pairs out of one block of styles.css.
function palette(css, openRe) {
    const start = css.search(openRe);
    expect(start, 'palette block exists in styles.css').toBeGreaterThan(-1);
    // The block runs to the first close brace at column 0.
    const body = css.slice(start, css.indexOf('\n}', start));
    const out = {};
    const re = /(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,6}|var\(--[a-z0-9-]+\))\s*;/g;
    let m;
    while ((m = re.exec(body))) { if (!(m[1] in out)) out[m[1]] = m[2].toLowerCase(); }
    return out;
}

describe('the mirror matches styles.css', () => {
    const css = fs.readFileSync(path.join(RENDERER, 'styles.css'), 'utf8');
    const dark = palette(css, /^:root\s*\{/m);
    const light = palette(css, /^:root\[data-theme="light"\]\s*\{/m);

    it('dark values', () => {
        const toks = T.tokens();
        for (const tok of Object.keys(toks)) {
            const mine = toks[tok][0];
            if (mine === null) continue;    // --members aliases --chat in dark
            expect(dark[tok], tok + ' (dark)').toBe(mine);
        }
    });

    it('light values', () => {
        const toks = T.tokens();
        for (const tok of Object.keys(toks)) {
            expect(light[tok], tok + ' (light)').toBe(toks[tok][1]);
        }
    });
});

const lum = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return ((n >> 16) & 255) * 0.2126 + ((n >> 8) & 255) * 0.7152 + (n & 255) * 0.0722;
};
const rootVar = (p) => document.documentElement.style.getPropertyValue(p).trim();

describe('the presets', () => {
    it('ash is lighter than dark, onyx darker — both still a ladder', () => {
        T.apply('ash');
        const ashChat = rootVar('--chat'), ashRail = rootVar('--rail'), ashElev = rootVar('--elev');
        T.apply('onyx');
        const onyxChat = rootVar('--chat'), onyxRail = rootVar('--rail'), onyxElev = rootVar('--elev');

        expect(lum(ashChat)).toBeGreaterThan(lum('#1a1a1e'));
        expect(lum(onyxChat)).toBeLessThan(lum('#1a1a1e'));
        // Near black, but the steps survive: an elevated surface still reads
        // as elevated, or every popover disappears into the page.
        expect(lum(onyxRail)).toBeLessThan(8);
        expect(lum(onyxElev)).toBeGreaterThan(lum(onyxChat));
        expect(lum(ashElev)).toBeGreaterThan(lum(ashChat));
        expect(lum(ashRail)).toBeLessThan(lum(ashChat));
    });

    it('onyx keeps edges visible while it crushes surfaces', () => {
        // The unselected radio ring measured ~#242427 under onyx — an
        // affordance nobody could see. Edges are compressed far more gently
        // than the surfaces they outline.
        T.apply('onyx');
        const ring = rootVar('--well-ring');
        const well = rootVar('--well');
        expect(lum(ring)).toBeGreaterThan(45);
        expect(lum(ring)).toBeGreaterThan(lum(well) * 2.5);
        expect(lum(rootVar('--outline'))).toBeGreaterThan(lum(rootVar('--chat')) * 2);
    });

    it('both report dark-based chrome for the native caption buttons', () => {
        expect(T.apply('ash').base).toBe('dark');
        expect(T.apply('onyx').base).toBe('dark');
        expect(T.apply('onyx').symbolColor).toBe(T.apply('dark').symbolColor);
    });

    it('switching back to a stock theme clears every override', () => {
        T.apply('onyx');
        expect(rootVar('--chat')).not.toBe('');
        const chrome = T.apply('dark');
        expect(rootVar('--chat')).toBe('');
        expect(rootVar('--rail')).toBe('');
        expect(chrome).toMatchObject({ base: 'dark', color: '#131316' });
    });
});

// rgba(...) parser for the translucent structural panes.
const rgba = (v) => {
    const m = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(v);
    return m ? { r: +m[1], g: +m[2], b: +m[3], a: +m[4] } : null;
};

describe('the custom tint', () => {
    it('lays ONE dimmed sheet under the window and fixed overlays over it', () => {
        T.apply('custom', { base: 'dark', colors: ['#ff0000', '#0000ff'], intensity: 80, angle: 0 });
        // The underlay carries the whole blend, in order, as one smooth fade.
        // The angle is CSS's own, untranslated — 180° runs the first colour
        // top-to-bottom — matching how the reference reads its slider, so a
        // theme carried between the two apps keeps its direction.
        // …and the stops are the SHEET colours: the picks under the one
        // global dim (×0.88·k — at 80 that keeps ×0.704), with the luminance
        // floor lifting the deep blue (whose dimmed lum lands under 16)
        // proportionally back up.
        expect(rootVar('--theme-underlay')).toBe('linear-gradient(0deg, #b40000, #0000de)');
        // The structural panes are the reference's FIXED overlays — pure
        // black at constant opacities, so any sheet keeps its hue and the
        // panel-to-panel contrast never depends on the palette: the rail is
        // the bare sheet, the sidebar a 12% dip, chat a 22% slab.
        expect(rootVar('--rail')).toBe('rgba(0, 0, 0, 0)');
        expect(rootVar('--side')).toBe('rgba(0, 0, 0, 0.12)');
        expect(rootVar('--chat')).toBe('rgba(0, 0, 0, 0.22)');
        // Floating surfaces stay OPAQUE (a see-through menu is unreadable) and
        // take the hue tint instead.
        expect(rootVar('--float')).toMatch(/^#/);
    });

    it('the overlays are architecture — they never follow the slider', () => {
        // Intensity lives entirely in the sheet's dim. The chat slab's 22%
        // doubles as the readability guarantee under white text, so it must
        // be identical at every intensity and for every palette.
        T.apply('custom', { base: 'dark', colors: ['#ff0000'], intensity: 30 });
        const low = [rootVar('--rail'), rootVar('--side'), rootVar('--chat')];
        T.apply('custom', { base: 'dark', colors: ['#00ff88', '#123456'], intensity: 90 });
        const high = [rootVar('--rail'), rootVar('--side'), rootVar('--chat')];
        expect(low).toEqual(['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0.12)', 'rgba(0, 0, 0, 0.22)']);
        expect(high).toEqual(low);
    });

    it('floors the sheet so dark picks never crush to black under the slab', () => {
        // The safeguard lives at GENERATION, not in the overlays: a black
        // pick is lifted to the minimum luminance before the fixed 22% chat
        // slab lands on it, and the overlays stay untouched.
        T.apply('custom', { base: 'dark', colors: ['#000000'], intensity: 60 });
        expect(rootVar('--theme-underlay')).toBe('#101010');
        expect(rootVar('--chat')).toBe('rgba(0, 0, 0, 0.22)');
    });

    it('nested surfaces carry no fill — elevation is borders and shadows', () => {
        T.apply('custom', { base: 'dark', colors: ['#ff0000', '#0000ff'], intensity: 50, angle: 0 });
        // The me-bar + composer strip's near-zero plate lives in styles.css;
        // the tokens themselves stay clear so nothing stacks a second layer
        // over the sheet.
        expect(rootVar('--input')).toBe('transparent');
        expect(rootVar('--panel')).toBe('transparent');
        expect(rootVar('--sunk')).toBe('transparent');
        // …and the flag that lifts the #app backdrop (the second sheet the
        // gradient used to cross under every column) is raised with it.
        expect(T.apply('custom', { base: 'dark', colors: ['#ff0000'], intensity: 50 }).underlay).toBe(true);
        expect(T.apply('custom', { base: 'dark', colors: ['#ff0000'], intensity: 0 }).underlay).toBe(false);
    });

    it('the native caption strip wears the bare sheet at its own corner', () => {
        // The title bar's overlay is ZERO — it matches the rail, the
        // brightest band — so the strip is the sheet itself at the
        // top-right, and the window background is the chat slab's composite
        // at the centre.
        const chrome = T.apply('custom', {
            base: 'dark', colors: ['#ff8800', '#00ff00'], intensity: 50, angle: 180
        });
        const n = parseInt(chrome.color.slice(1), 16);
        const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
        // 180° runs the first colour from the top, so the caption strip sits
        // in orange territory: strongly chromatic, red-dominant.
        expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeGreaterThan(50);
        expect(r).toBeGreaterThan(b);
        // And DARK: the sheet is the picks at ×0.40 here, and the centre
        // takes the 22% slab on top of that.
        expect(lum(chrome.bg)).toBeLessThan(60);
        expect(lum(chrome.bg)).toBeLessThan(lum(chrome.color));
    });

    it('honours the gradient direction', () => {
        T.apply('custom', { base: 'dark', colors: ['#ff0000', '#0000ff'], intensity: 60, angle: 90 });
        expect(rootVar('--theme-underlay')).toBe('linear-gradient(90deg, #870000, #0000de)');
    });

    it('a single colour is a uniform wash, not a gradient', () => {
        T.apply('custom', { base: 'dark', colors: ['#5865f2'], intensity: 80 });
        expect(rootVar('--theme-underlay')).toBe('#3e47aa');
        expect(rgba(rootVar('--chat')).a).toBeLessThan(1);
    });

    it('the default theme renders the reference gradient exactly', () => {
        // The five default picks are chosen so the global dim at the default
        // 50% intensity lands each stop ON the reference's measured sheet —
        // what the rail shows before anyone customizes anything.
        T.apply('custom', T.defaultCustom());
        expect(rootVar('--theme-underlay'))
            .toBe('linear-gradient(180deg, #5a2519, #38193b, #1e0f60, #26353b, #2f5f06)');
    });

    it('intensity 0 is the stock ramp, untouched, with no underlay at all', () => {
        T.apply('custom', { base: 'dark', colors: ['#ff0000'], intensity: 0 });
        expect(rootVar('--chat')).toBe('#1a1a1e');
        expect(rootVar('--rail')).toBe('#0c0c0e');
        expect(rootVar('--theme-underlay')).toBe('');
    });

    it('a light base flips the overlays to white at the same opacities', () => {
        const chrome = T.apply('custom', { base: 'light', colors: ['#ff2d55'], intensity: 100 });
        expect(chrome.base).toBe('light');
        // The layering is identical — only the overlay colour inverts.
        expect(rootVar('--rail')).toBe('rgba(255, 255, 255, 0)');
        expect(rootVar('--side')).toBe('rgba(255, 255, 255, 0.12)');
        expect(rootVar('--chat')).toBe('rgba(255, 255, 255, 0.22)');
        // Its floats are still paper — opaque and near-white.
        expect(lum(rootVar('--float'))).toBeGreaterThan(180);
    });

    it('normalizeCustom refuses garbage without refusing the user', () => {
        expect(T.normalizeCustom(null)).toEqual({
            base: 'dark',
            colors: ['#cd5439', '#7f3986', '#4422da', '#567886', '#6bd80e'],
            intensity: 50, angle: 180
        });
        expect(T.normalizeCustom({ base: 'mauve', colors: ['xyz', '#ABC'], intensity: 999, angle: 999 }))
            .toEqual({ base: 'dark', colors: ['#aabbcc'], intensity: 100, angle: 279 });
        // One swatch per stop of the reference gradient: the cap is five.
        expect(T.normalizeCustom({ colors: ['#111111', '#222222', '#333333', '#444444', '#555555', '#666666'] }).colors.length)
            .toBe(5);
        // 360 IS 0 — the wheel wraps.
        expect(T.normalizeCustom({ angle: 360 }).angle).toBe(0);
    });

    it('surprise produces something the engine itself accepts', () => {
        for (let i = 0; i < 20; i++) {
            const cfg = T.randomCustom(i % 2 ? 'light' : 'dark');
            expect(T.normalizeCustom(cfg)).toEqual(cfg);
            expect(cfg.intensity).toBeGreaterThanOrEqual(55);
            expect(cfg.intensity).toBeLessThanOrEqual(90);
        }
    });
});

describe('picker colour math', () => {
    it('hex↔hsv round-trips', () => {
        ['#5865f2', '#ff0000', '#00ff00', '#123456', '#fafbfc'].forEach((hex) => {
            const [h, s, v] = T.hexToHsv(hex);
            expect(T.hsvToHex(h, s, v)).toBe(hex);
        });
    });
    it('normHex accepts what people type', () => {
        expect(T.normHex('5865F2')).toBe('#5865f2');
        expect(T.normHex('#abc')).toBe('#aabbcc');
        expect(T.normHex('#12345')).toBe(null);
        expect(T.normHex('')).toBe(null);
    });
});
