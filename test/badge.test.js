// badge.js — the unread-count overlay drawn on the taskbar button.
//
// This is drawn pixel by pixel into a BGRA buffer because the main process has
// no canvas and nativeImage cannot decode SVG, so the arithmetic is worth
// pinning: an off-by-one in the glyph packing or the centring produces an icon
// that is subtly wrong in a way nobody notices until it ships.
//
// The handler this replaced never drew anything at all — it cleared the overlay
// on zero and otherwise only flashed the window — and no caller ever invoked it.
import { describe, it, expect } from 'vitest';
import { loadMain, resetMainModules } from './helpers/load.js';

resetMainModules();
const badge = loadMain('badge.js');
const { badgeLabel, badgeBitmap, SIZE, GLYPHS } = badge;

// Alpha channel of one pixel in the BGRA buffer.
function alphaAt(buf, x, y, size = SIZE) {
    return buf[(y * size + x) * 4 + 3];
}
function pixel(buf, x, y, size = SIZE) {
    const i = (y * size + x) * 4;
    return { b: buf[i], g: buf[i + 1], r: buf[i + 2], a: buf[i + 3] };
}

describe('badgeLabel', () => {
    it('is empty for nothing unread, so the overlay is cleared instead of drawn', () => {
        expect(badgeLabel(0)).toBe('');
        expect(badgeLabel(null)).toBe('');
        expect(badgeLabel(undefined)).toBe('');
        expect(badgeLabel(-3)).toBe('');
    });

    it('shows the count up to 99', () => {
        expect(badgeLabel(1)).toBe('1');
        expect(badgeLabel(42)).toBe('42');
        expect(badgeLabel(99)).toBe('99');
    });

    it('caps at 99+ where the exact number stops being useful', () => {
        expect(badgeLabel(100)).toBe('99+');
        expect(badgeLabel(5000)).toBe('99+');
    });
});

describe('badgeBitmap', () => {
    it('is a full BGRA buffer for the icon size', () => {
        expect(badgeBitmap('1')).toHaveLength(SIZE * SIZE * 4);
    });

    it('leaves the corners transparent — it is a disc, not a square', () => {
        const buf = badgeBitmap('1');
        expect(alphaAt(buf, 0, 0)).toBe(0);
        expect(alphaAt(buf, SIZE - 1, 0)).toBe(0);
        expect(alphaAt(buf, 0, SIZE - 1)).toBe(0);
        expect(alphaAt(buf, SIZE - 1, SIZE - 1)).toBe(0);
    });

    it('fills the disc opaquely away from its edge', () => {
        const buf = badgeBitmap('');
        expect(alphaAt(buf, SIZE / 2, 2)).toBe(255);       // top of the circle
        expect(alphaAt(buf, 2, SIZE / 2)).toBe(255);       // left
    });

    it('antialiases the rim rather than stepping straight to transparent', () => {
        const buf = badgeBitmap('');
        const alphas = [];
        for (let x = 0; x < SIZE; x++) alphas.push(alphaAt(buf, x, SIZE / 2));
        // Somewhere on the way in from the edge there is a partial pixel.
        expect(alphas.some((a) => a > 0 && a < 255)).toBe(true);
    });

    it('draws the label in white on the badge colour', () => {
        const buf = badgeBitmap('1');
        let white = 0;
        let red = 0;
        for (let y = 0; y < SIZE; y++) {
            for (let x = 0; x < SIZE; x++) {
                const p = pixel(buf, x, y);
                if (p.a !== 255) continue;
                if (p.r === 255 && p.g === 255 && p.b === 255) white++;
                else if (p.r === 232 && p.g === 60 && p.b === 60) red++;
            }
        }
        // The '1' glyph is 010/110/010/010/111 = 8 lit cells; at 2x each cell
        // is 4 pixels, so 32.
        expect(white).toBe(32);
        expect(red).toBeGreaterThan(200);
    });

    it('draws more glyph pixels for more digits', () => {
        const lit = (label) => {
            const buf = badgeBitmap(label);
            let n = 0;
            for (let i = 0; i < SIZE * SIZE; i++) {
                if (buf[i * 4] === 255 && buf[i * 4 + 1] === 255 && buf[i * 4 + 2] === 255) n++;
            }
            return n;
        };
        expect(lit('99')).toBeGreaterThan(lit('9'));
        expect(lit('99+')).toBeGreaterThan(lit('99'));
    });

    it('keeps even the widest label inside the icon', () => {
        // "99+" is the widest thing ever drawn; nothing may be clipped at the edge.
        const buf = badgeBitmap('99+');
        for (let y = 0; y < SIZE; y++) {
            expect(pixel(buf, 0, y).r).not.toBe(255);
            expect(pixel(buf, SIZE - 1, y).r).not.toBe(255);
        }
    });

    it('centres the label horizontally', () => {
        const buf = badgeBitmap('8');
        const cols = [];
        for (let x = 0; x < SIZE; x++) {
            for (let y = 0; y < SIZE; y++) {
                if (pixel(buf, x, y).r === 255 && pixel(buf, x, y).g === 255) { cols.push(x); break; }
            }
        }
        const mid = (cols[0] + cols[cols.length - 1]) / 2;
        expect(Math.abs(mid - (SIZE - 1) / 2)).toBeLessThanOrEqual(1);
    });

    it('ignores characters it has no glyph for instead of drawing nothing', () => {
        // Defensive: a label is only ever built by badgeLabel, but a stray
        // character must not blank the badge.
        const buf = badgeBitmap('4x');
        let white = 0;
        for (let i = 0; i < SIZE * SIZE; i++) if (buf[i * 4 + 3] === 255 && buf[i * 4] === 255) white++;
        expect(white).toBeGreaterThan(0);
    });

    it('has a five-row, three-column glyph for every character it can draw', () => {
        Object.entries(GLYPHS).forEach(([ch, rows]) => {
            expect(rows, ch).toHaveLength(5);
            rows.forEach((r) => expect(r).toBeLessThanOrEqual(0b111));
        });
    });
});
