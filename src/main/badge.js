// The unread-count overlay drawn on the Windows taskbar button.
//
// setOverlayIcon needs a nativeImage, and the main process has no canvas — the
// only drawing surface available is nativeImage.createFromBitmap over a raw
// BGRA buffer. SVG is not an option: nativeImage cannot decode it.
//
// So the digits come from a 3x5 bitmap font, scaled up. Three glyphs is the most
// we ever draw ("99+"), and at 32x32 the overlay is sharp on a 100% DPI taskbar
// and acceptable when Windows scales it down to 16x16.
//
// The pixel work is kept separate from the Electron call so it can be tested
// without a running app.
const SIZE = 32;

// Bit per pixel, most significant bit leftmost, five rows of three.
const GLYPHS = {
    '0': [0b111, 0b101, 0b101, 0b101, 0b111],
    '1': [0b010, 0b110, 0b010, 0b010, 0b111],
    '2': [0b111, 0b001, 0b111, 0b100, 0b111],
    '3': [0b111, 0b001, 0b111, 0b001, 0b111],
    '4': [0b101, 0b101, 0b111, 0b001, 0b001],
    '5': [0b111, 0b100, 0b111, 0b001, 0b111],
    '6': [0b111, 0b100, 0b111, 0b101, 0b111],
    '7': [0b111, 0b001, 0b010, 0b010, 0b010],
    '8': [0b111, 0b101, 0b111, 0b101, 0b111],
    '9': [0b111, 0b101, 0b111, 0b001, 0b111],
    '+': [0b000, 0b010, 0b111, 0b010, 0b000]
};

// #e83c3c, in the BGRA order the bitmap wants.
const BG = { b: 60, g: 60, r: 232 };

// How a count is written on the badge. Anything past 99 becomes "99+" — the
// exact number stops being useful and stops fitting.
function badgeLabel(count) {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    if (!n) return '';
    return n > 99 ? '99+' : String(n);
}

// Raw BGRA pixels for the badge: a filled disc with the label centred on it.
function badgeBitmap(label, size = SIZE) {
    const buf = Buffer.alloc(size * size * 4);      // zeroed = fully transparent
    const put = (x, y, b, g, r, a) => {
        if (x < 0 || y < 0 || x >= size || y >= size) return;
        const i = (y * size + x) * 4;
        buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = a;
    };

    // Filled disc, antialiased by measuring how far each pixel is past the edge.
    const c = (size - 1) / 2;
    const radius = size / 2 - 0.5;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const d = Math.hypot(x - c, y - c);
            if (d > radius + 1) continue;
            const a = Math.round(255 * Math.min(1, Math.max(0, radius - d + 0.5)));
            // createFromBitmap expects PREMULTIPLIED alpha (the toBitmap()
            // format) — straight alpha on the AA edge read as brighter-than-
            // red and drew a light fringe around the disc.
            if (a > 0) {
                put(x, y,
                    Math.round(BG.b * a / 255),
                    Math.round(BG.g * a / 255),
                    Math.round(BG.r * a / 255), a);
            }
        }
    }

    // Centre the label. 3px glyphs at 2x with a 1px gap between them.
    const scale = 2;
    const gap = 1;
    const chars = String(label || '').split('').filter((ch) => GLYPHS[ch]);
    const textW = chars.length * 3 * scale + Math.max(0, chars.length - 1) * gap;
    let x0 = Math.round((size - textW) / 2);
    const y0 = Math.round((size - 5 * scale) / 2);

    chars.forEach((ch) => {
        const rows = GLYPHS[ch];
        for (let ry = 0; ry < 5; ry++) {
            for (let rx = 0; rx < 3; rx++) {
                if (!(rows[ry] & (1 << (2 - rx)))) continue;
                for (let sy = 0; sy < scale; sy++) {
                    for (let sx = 0; sx < scale; sx++) {
                        put(x0 + rx * scale + sx, y0 + ry * scale + sy, 255, 255, 255, 255);
                    }
                }
            }
        }
        x0 += 3 * scale + gap;
    });

    return buf;
}

// Cached: the same handful of labels recur for the life of the process, and
// redrawing on every render would be pure waste.
const cache = new Map();

function badgeIcon(label) {
    if (cache.has(label)) return cache.get(label);
    const { nativeImage } = require('electron');
    const img = nativeImage.createFromBitmap(badgeBitmap(label), { width: SIZE, height: SIZE });
    cache.set(label, img);
    return img;
}

module.exports = { badgeLabel, badgeBitmap, badgeIcon, SIZE, GLYPHS };
