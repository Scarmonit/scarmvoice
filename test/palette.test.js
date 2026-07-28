// The stylesheet's own claims, checked as text.
//
// jsdom does not do layout, so the geometry in here was measured in a real
// browser against the real stylesheet and then pinned as the declarations that
// produce it. That is worth doing because every one of these is a value someone
// will reasonably want to nudge later, and each has a reason that is invisible
// from the declaration alone: the surface ramp has to stay near-neutral, the
// user card has to stay LIGHTER than the column it sits in, and an icon button
// that regains the browser's default padding puts its glyph off-centre again.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RENDERER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');

let css = '';
let dark = '';

beforeAll(() => {
    css = fs.readFileSync(path.join(RENDERER, 'styles.css'), 'utf8');
    dark = css.slice(css.indexOf(':root {'), css.indexOf('* { box-sizing'));
});

const hex = (name, block) => {
    const m = new RegExp('--' + name + ':\\s*(#[0-9a-f]{6})', 'i').exec(block);
    if (!m) throw new Error('no --' + name + ' in that block');
    const v = m[1];
    return { r: parseInt(v.slice(1, 3), 16), g: parseInt(v.slice(3, 5), 16), b: parseInt(v.slice(5, 7), 16), hex: v };
};

// Relative luminance is close enough for "is this lighter than that", and it is
// what the eye is judging when it decides a surface is raised or sunk.
const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

describe('the dark surface ramp', () => {
    const SURFACES = ['rail', 'side', 'chat', 'input', 'chat-2', 'panel', 'float', 'elev'];

    it('stays within a few points of neutral', () => {
        // A blue channel far above the red is what made every surface read navy
        // rather than grey. The composer was the worst of them at fifteen.
        SURFACES.forEach((name) => {
            const c = hex(name, dark);
            expect(c.b - c.r).toBeLessThanOrEqual(5);
            expect(c.b - c.r).toBeGreaterThanOrEqual(0);
            // Grey, not tinted: green tracks red too.
            expect(Math.abs(c.g - c.r)).toBeLessThanOrEqual(2);
        });
    });

    it('raises the user card out of the sidebar instead of sinking it in', () => {
        // This is the one that made the panel look dated: a card DARKER than the
        // column around it reads as a well, not as something floating.
        expect(lum(hex('panel', dark))).toBeGreaterThan(lum(hex('side', dark)));
        expect(lum(hex('side', dark))).toBeGreaterThan(lum(hex('rail', dark)));
    });

    it('keeps the composer from hovering over the column behind it', () => {
        // Was a thirteen-point step, which read as a raised card. The reference
        // barely separates the two at all.
        const step = lum(hex('input', dark)) - lum(hex('chat', dark));
        expect(step).toBeGreaterThan(0);
        expect(step).toBeLessThanOrEqual(6);
    });

    it('does the same in the light theme, where it was inverted too', () => {
        const light = css.slice(css.indexOf(':root[data-theme="light"]'));
        expect(lum(hex('panel', light))).toBeGreaterThan(lum(hex('side', light)));
    });
});

describe('the user panel', () => {
    it('is an inset card, not a full-bleed strip', () => {
        // Two rules carry this selector; the grid-area one comes first.
        const rule = (css.match(/#me-bar \{[^}]*\}/g) || []).find((r) => r.includes('padding'));
        expect(rule).toMatch(/margin:\s*0 8px 8px/);
        expect(rule).toMatch(/border-radius:\s*8px/);
        // 8 of margin + 7 of padding + the identity block's own 6 puts the
        // avatar 21px from the window edge and 13px inside the card.
        expect(rule).toMatch(/padding:\s*7px/);
    });

    it('separates the two control groups by more than it separates a caret', () => {
        // A caret has to read as belonging to the control BEFORE it. .me-ctl has
        // no gap of its own, so this is the only distance between the groups —
        // if it ever drops to nothing the grouping inverts.
        const gap = /\.me-actions \{[^}]*gap:\s*(\d+)px/.exec(css);
        expect(Number(gap[1])).toBeGreaterThanOrEqual(5);
        expect(/\.me-ctl \{[^}]*gap/.test(css)).toBe(false);
    });

    it('sizes the presence dot as a 10px core inside a 3px cutout', () => {
        const rule = /\.me-presence \{[^}]*\}/.exec(css)[0];
        expect(rule).toMatch(/width:\s*16px/);
        expect(rule).toMatch(/border:\s*3px solid var\(--panel\)/);
        // The ring is punched in the CARD's colour, so it has to follow it.
        expect(rule).not.toMatch(/border:\s*3px solid #/);
    });

    it('draws its glyphs dimmer than its text, and the status line brighter than a hint', () => {
        expect(/#me-bar \.icon-btn \{[^}]*color:\s*var\(--panel-icon\)/.test(css)).toBe(true);
        expect(/\.me-status \{[^}]*color:\s*var\(--muted\)/.test(css)).toBe(true);
        expect(/#composer-input::placeholder \{ color: var\(--placeholder\); \}/.test(css)).toBe(true);
    });
});

describe('icon buttons', () => {
    it('reset the browser padding that pushed every glyph off-centre', () => {
        // Buttons default to `padding: 1px 6px`. On a fixed-width button that
        // leaves a content box narrower than the glyph, and a centred item wider
        // than its area overflows to one side only — so every icon in the app
        // sat a couple of pixels right of the button it belonged to.
        const rule = /\.icon-btn \{[^}]*\}/.exec(css)[0];
        expect(rule).toMatch(/padding:\s*0/);
    });

    it('keeps every me-bar glyph inside its own button', () => {
        const btn = (sel) => Number(new RegExp(sel + '[^}]*width:\\s*(\\d+)px').exec(css)[1]);
        const caretBtn = btn('\\.me-ctl \\.me-ctl-caret \\{');
        const caretIco = Number(/#me-bar \.me-ctl-caret \.ico \{[^}]*width:\s*(\d+)px/.exec(css)[1]);
        expect(caretIco).toBeLessThanOrEqual(caretBtn);

        const mainBtn = Number(/\.me-ctl \.me-ctl-main \{[^}]*width:\s*(\d+)px/.exec(css)[1]);
        const deafenIco = Number(/#me-bar #btn-deafen \.ico \{[^}]*width:\s*(\d+)px/.exec(css)[1]);
        expect(deafenIco).toBeLessThanOrEqual(mainBtn);
    });
});

describe('the caret glyph', () => {
    it('is drawn pointing down rather than turned into place', () => {
        const icons = fs.readFileSync(path.join(RENDERER, 'icons.js'), 'utf8');
        const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
        expect(icons).toMatch(/'chevron-down':/);
        // A rotated glyph keeps its unrotated box, so the box and the ink
        // disagree about where the centre is. Both carets use the drawn one.
        expect((html.match(/data-icon="chevron-down"/g) || []).length).toBe(2);
        expect(/\.me-ctl \.me-ctl-caret \.ico \{[^}]*rotate/.test(css)).toBe(false);
    });

    it('nudges the way it points', () => {
        expect(/\.me-ctl-caret:hover \.ico \{ transform: translateY\(1\.5px\); \}/.test(css)).toBe(true);
    });
});

describe('hover motion', () => {
    it('gives each control its own gesture, and lets it be turned off', () => {
        expect(/#btn-settings:hover \.ico \{ transform: rotate\(90deg\); \}/.test(css)).toBe(true);
        expect(/#btn-mute:hover \.ico \{ transform: scale\(1\.15\); \}/.test(css)).toBe(true);
        expect(/@keyframes headset-wiggle/.test(css)).toBe(true);
        expect(/#btn-deafen:hover \.ico \{ animation: headset-wiggle/.test(css)).toBe(true);

        // An animation ignores `transition: none`, so reduced motion has to
        // switch it off by name or the headset shakes anyway.
        const reduced = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce) {\n  #me-bar'));
        expect(reduced).toMatch(/#btn-deafen:hover \.ico \{ animation: none; \}/);
        expect(reduced).toMatch(/\.me-ctl-caret:hover \.ico,/);
    });
});
