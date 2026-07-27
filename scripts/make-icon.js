// Build build/icon.ico from build/icon-source.png, with no image dependencies.
//
// Decodes the source PNG by hand (zlib + un-filtering), area-averages it down to
// each icon size in premultiplied-alpha space so the transparent edges stay
// clean, re-encodes each size as a PNG, and wraps the set in a PNG-based ICO
// (supported by Windows Vista+ and by electron-builder).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'build', 'icon-source.png');
const OUT = path.join(ROOT, 'build', 'icon.ico');

// The in-app logo, generated from the same master. 128 px is 2x the largest
// place it is drawn (the 64 px sign-in mark), so it stays crisp on a HiDPI
// display without shipping the full-resolution original.
const LOGO_SIZE = 128;
const LOGO_OUT = path.join(ROOT, 'src', 'renderer', 'logo.png');

// ---- PNG decoding --------------------------------------------------------

function decodePNG(buf) {
    const SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    for (let i = 0; i < SIG.length; i++) {
        if (buf[i] !== SIG[i]) throw new Error('not a PNG file');
    }

    let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
    const idat = [];
    let pos = 8;

    while (pos < buf.length) {
        const len = buf.readUInt32BE(pos);
        const type = buf.toString('ascii', pos + 4, pos + 8);
        const data = buf.subarray(pos + 8, pos + 8 + len);
        pos += 12 + len;                       // length + type + data + crc

        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            bitDepth = data[8];
            colorType = data[9];
            interlace = data[12];
        } else if (type === 'IDAT') {
            idat.push(data);
        } else if (type === 'IEND') {
            break;
        }
    }

    if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth} (need 8)`);
    if (interlace !== 0) throw new Error('interlaced PNGs are not supported');

    const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };
    const channels = CHANNELS[colorType];
    if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`);

    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    const pixels = Buffer.alloc(stride * height);

    // Undo the per-scanline filters (PNG spec 9.2).
    let rp = 0;
    for (let y = 0; y < height; y++) {
        const filter = raw[rp++];
        const line = raw.subarray(rp, rp + stride);
        rp += stride;
        const out = pixels.subarray(y * stride, (y + 1) * stride);
        const prior = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;

        for (let x = 0; x < stride; x++) {
            const a = x >= channels ? out[x - channels] : 0;   // left
            const b = prior ? prior[x] : 0;                     // up
            const c = (prior && x >= channels) ? prior[x - channels] : 0; // upper-left
            let v = line[x];
            switch (filter) {
                case 0: break;
                case 1: v += a; break;
                case 2: v += b; break;
                case 3: v += (a + b) >> 1; break;
                case 4: {
                    const p = a + b - c;
                    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
                    v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
                    break;
                }
                default: throw new Error(`unknown PNG filter ${filter} on row ${y}`);
            }
            out[x] = v & 0xFF;
        }
    }

    // Normalise everything to RGBA.
    const rgba = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        const s = i * channels, d = i * 4;
        if (colorType === 6) {
            rgba[d] = pixels[s]; rgba[d + 1] = pixels[s + 1]; rgba[d + 2] = pixels[s + 2]; rgba[d + 3] = pixels[s + 3];
        } else if (colorType === 2) {
            rgba[d] = pixels[s]; rgba[d + 1] = pixels[s + 1]; rgba[d + 2] = pixels[s + 2]; rgba[d + 3] = 255;
        } else if (colorType === 4) {
            rgba[d] = rgba[d + 1] = rgba[d + 2] = pixels[s]; rgba[d + 3] = pixels[s + 1];
        } else {
            rgba[d] = rgba[d + 1] = rgba[d + 2] = pixels[s]; rgba[d + 3] = 255;
        }
    }
    return { width, height, rgba };
}

// ---- resampling ----------------------------------------------------------

// Area-average downscale. Colour is averaged premultiplied by alpha, so fully
// transparent pixels (which carry meaningless RGB) cannot bleed dark fringes
// into the antialiased edges.
function resize(src, sw, sh, size) {
    const out = Buffer.alloc(size * size * 4);

    for (let y = 0; y < size; y++) {
        const y0 = Math.floor(y * sh / size);
        const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sh / size));
        for (let x = 0; x < size; x++) {
            const x0 = Math.floor(x * sw / size);
            const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sw / size));

            let r = 0, g = 0, b = 0, a = 0, n = 0;
            for (let sy = y0; sy < y1; sy++) {
                for (let sx = x0; sx < x1; sx++) {
                    const i = (sy * sw + sx) * 4;
                    const al = src[i + 3] / 255;
                    r += src[i] * al; g += src[i + 1] * al; b += src[i + 2] * al;
                    a += src[i + 3];
                    n++;
                }
            }

            const d = (y * size + x) * 4;
            const alpha = a / n;
            // Un-premultiply back to straight alpha for storage.
            const scale = alpha > 0 ? 255 / alpha : 0;
            out[d] = Math.min(255, Math.round(r / n * scale));
            out[d + 1] = Math.min(255, Math.round(g / n * scale));
            out[d + 2] = Math.min(255, Math.round(b / n * scale));
            out[d + 3] = Math.round(alpha);
        }
    }
    return out;
}

// ---- PNG encoding --------------------------------------------------------

let CRC_TABLE = null;
function crc32(buf) {
    if (!CRC_TABLE) {
        CRC_TABLE = new Int32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            CRC_TABLE[n] = c;
        }
    }
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
}

function encodePNG(rgba, size) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 6;   // colour type: RGBA
    ihdr[10] = 0;  // deflate
    ihdr[11] = 0;  // adaptive filtering
    ihdr[12] = 0;  // no interlace

    const stride = size * 4;
    const raw = Buffer.alloc((stride + 1) * size);
    for (let y = 0; y < size; y++) {
        raw[y * (stride + 1)] = 0;   // filter: None
        rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    }

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

// ---- ICO container -------------------------------------------------------

function buildICO(entries) {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);              // reserved
    header.writeUInt16LE(1, 2);              // type: icon
    header.writeUInt16LE(entries.length, 4);

    const dir = Buffer.alloc(16 * entries.length);
    let offset = header.length + dir.length;
    entries.forEach((e, i) => {
        const o = i * 16;
        dir[o] = e.size >= 256 ? 0 : e.size;      // 0 means 256
        dir[o + 1] = e.size >= 256 ? 0 : e.size;
        dir[o + 2] = 0;                            // palette size
        dir[o + 3] = 0;                            // reserved
        dir.writeUInt16LE(1, o + 4);               // colour planes
        dir.writeUInt16LE(32, o + 6);              // bits per pixel
        dir.writeUInt32LE(e.png.length, o + 8);
        dir.writeUInt32LE(offset, o + 12);
        offset += e.png.length;
    });

    return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

function main() {
    if (!fs.existsSync(SOURCE)) {
        console.error(`[icon] missing ${path.relative(ROOT, SOURCE)} — cannot build the icon.`);
        process.exitCode = 1;
        return;
    }

    const src = decodePNG(fs.readFileSync(SOURCE));
    if (src.width !== src.height) {
        console.warn(`[icon] source is ${src.width}x${src.height}, not square — it will be squashed.`);
    }

    const entries = SIZES.map((size) => {
        const scaled = size === src.width && size === src.height
            ? src.rgba
            : resize(src.rgba, src.width, src.height, size);
        return { size, png: encodePNG(scaled, size) };
    });

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, buildICO(entries));
    console.log(`[icon] ${path.relative(ROOT, SOURCE)} (${src.width}px) -> ` +
        `${path.relative(ROOT, OUT)} (${SIZES.join('/')}px, ${Math.round(fs.statSync(OUT).size / 1024)} KB)`);

    makeRendererLogo(src);
}

// The renderer's logo used to be the full-resolution master — a ~260 KB PNG
// displayed at 48 px in the rail and 64 px on the sign-in screen. Every launch
// decoded all of it to draw a thumbnail, on the critical path to first paint.
// Same source, same resampler, sized for what it is actually used at (2x the
// largest use, so it stays sharp on a HiDPI display).
function makeRendererLogo(src) {
    const size = LOGO_SIZE;
    const scaled = (size === src.width && size === src.height)
        ? src.rgba
        : resize(src.rgba, src.width, src.height, size);
    const png = encodePNG(scaled, size);
    fs.writeFileSync(LOGO_OUT, png);
    console.log(`[icon] ${path.relative(ROOT, LOGO_OUT)} (${size}px, ` +
        `${Math.round(png.length / 1024)} KB)`);
}

main();
