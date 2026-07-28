// Side-by-side pixels, for the half of a difference that has no number.
//
//   node dev/spec/pixdiff.cjs dev/spec/out/discord.json dev/spec/out/app.json
//
// diff.cjs compares properties, and a property is only comparable if the probe
// thought to collect it. Some differences do not live in any single property:
// a gradient, where the ink sits inside its padding, a border that is present
// on three sides, an icon whose weight is wrong at the same nominal size.
// Those get noticed by eye or not at all — so this crops the same component
// out of both screenshots and puts them next to each other.
//
// Two numbers come out, and neither is a pixel-perfect diff, because the two
// crops are rarely the same size and scaling one to match invents detail that
// was never there:
//
//   meanΔ   distance between the average colours of the two crops. Catches a
//           fill that is close but not equal, and gradients, which no single
//           computed background colour describes.
//   formΔ   distance between 16x16 luminance signatures, each normalised to
//           its own crop. Size-independent, so it answers "is the light
//           arranged the same way inside this box" — padding, alignment, where
//           the glyph sits, whether an edge is painted.
//
// A high formΔ with a low meanΔ is the interesting case: right colours,
// wrong arrangement.
//
// The PNGs are decoded by handing them to a canvas in a headless page. There
// is a package for this; there is also already a browser in devDependencies,
// and it decodes PNG rather well.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'out');
const CELL = 220;                    // px per panel in the contact sheet

// The capture scripts write PNG, but a reference frame can also arrive as a
// JPEG from a screenshot tool, and a data: URL declaring the wrong type simply
// fails to decode.
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const dataUrl = (p) => 'data:' + (MIME[path.extname(p).toLowerCase()] || 'image/png')
    + ';base64,' + fs.readFileSync(p).toString('base64');

// Whatever frame sits beside the spec, under any of the names a screenshot
// might have been saved as.
function frameFor(jsonPath) {
    const stem = jsonPath.replace(/\.json$/, '');
    return Object.keys(MIME).map((e) => stem + e).find((p) => fs.existsSync(p)) || null;
}

// Everything below runs inside the page, where there is a canvas.
function inPage(job) {
    const load = (src) => new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error('decode failed'));
        i.src = src;
    });

    const crop = (img, box, scale) => {
        // A screenshot taken at deviceScaleFactor 2 is twice the size of the
        // CSS box the probe measured. Getting this wrong silently compares a
        // component against its own top-left quarter.
        const x = Math.max(0, Math.round(box.x * scale));
        const y = Math.max(0, Math.round(box.y * scale));
        const w = Math.min(Math.round(box.w * scale), img.width - x);
        const h = Math.min(Math.round(box.h * scale), img.height - y);
        if (w < 2 || h < 2) return null;
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, x, y, w, h, 0, 0, w, h);
        return c;
    };

    const mean = (c) => {
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let r = 0, g = 0, b = 0;
        for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
        const n = d.length / 4;
        return [r / n, g / n, b / n];
    };

    // Normalised per crop, so this measures ARRANGEMENT and not brightness —
    // brightness is already meanΔ's job, and counting it twice would make
    // every dark-on-dark panel look identical.
    const signature = (c) => {
        const s = document.createElement('canvas');
        s.width = s.height = 16;
        const sx = s.getContext('2d');
        sx.drawImage(c, 0, 0, 16, 16);
        const d = sx.getImageData(0, 0, 16, 16).data;
        const v = [];
        for (let i = 0; i < d.length; i += 4) v.push(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
        const lo = Math.min(...v), hi = Math.max(...v);
        const span = hi - lo;
        return span < 1 ? v.map(() => 0) : v.map((x) => (x - lo) / span);
    };

    const fit = (c, cell) => {
        const out = document.createElement('canvas');
        out.width = out.height = cell;
        const x = out.getContext('2d');
        x.fillStyle = '#000'; x.fillRect(0, 0, cell, cell);
        const k = Math.min(cell / c.width, cell / c.height, 1);
        const w = c.width * k, h = c.height * k;
        x.imageSmoothingEnabled = false;
        x.drawImage(c, (cell - w) / 2, (cell - h) / 2, w, h);
        return out;
    };

    return (async () => {
        const [refImg, oursImg] = await Promise.all([load(job.refPng), load(job.oursPng)]);
        const refScale = refImg.width / job.refViewport.w;
        const oursScale = oursImg.width / job.oursViewport.w;
        const rows = [];

        for (const item of job.items) {
            const a = crop(refImg, item.refBox, refScale);
            const b = crop(oursImg, item.oursBox, oursScale);
            if (!a || !b) { rows.push({ name: item.name, skipped: 'crop out of frame' }); continue; }

            const ma = mean(a), mb = mean(b);
            const meanD = Math.sqrt(ma.reduce((s, v, i) => s + (v - mb[i]) ** 2, 0) / 3);

            const sa = signature(a), sb = signature(b);
            const formD = Math.sqrt(sa.reduce((s, v, i) => s + (v - sb[i]) ** 2, 0) / sa.length) * 100;

            // Contact sheet: reference, ours, and the two overlaid in
            // difference so a shifted edge shows up as a bright line.
            const sheet = document.createElement('canvas');
            sheet.width = job.cell * 3; sheet.height = job.cell;
            const sx = sheet.getContext('2d');
            sx.fillStyle = '#000'; sx.fillRect(0, 0, sheet.width, sheet.height);
            sx.drawImage(fit(a, job.cell), 0, 0);
            sx.drawImage(fit(b, job.cell), job.cell, 0);
            sx.drawImage(fit(a, job.cell), job.cell * 2, 0);
            sx.globalCompositeOperation = 'difference';
            sx.drawImage(fit(b, job.cell), job.cell * 2, 0);
            sx.globalCompositeOperation = 'source-over';

            rows.push({
                name: item.name,
                meanD: +meanD.toFixed(1),
                formD: +formD.toFixed(1),
                refSize: a.width + 'x' + a.height,
                oursSize: b.width + 'x' + b.height,
                png: sheet.toDataURL('image/png')
            });
        }
        return rows;
    })();
}

(async () => {
    const [refPath, oursPath] = process.argv.slice(2);
    if (!refPath || !oursPath) {
        console.error('usage: node dev/spec/pixdiff.cjs <reference.json> <ours.json>');
        process.exit(2);
    }
    const ref = JSON.parse(fs.readFileSync(refPath, 'utf8'));
    const ours = JSON.parse(fs.readFileSync(oursPath, 'utf8'));
    const refPng = frameFor(refPath);
    const oursPng = frameFor(oursPath);
    for (const [p, src] of [[refPng, refPath], [oursPng, oursPath]]) {
        if (!p) {
            console.error('no image beside ' + path.basename(src)
                + ' — the capture that writes the json writes a frame next to it.');
            console.error('the relay path does not, because a page cannot screenshot itself: use spec:ref.');
            process.exit(1);
        }
    }

    const items = Object.keys(ref.components)
        .filter((n) => {
            const a = ref.components[n], b = ours.components[n];
            return a && b && !a.missing && !b.missing
                && a.box && b.box && a.box.x !== undefined && b.box.x !== undefined;
        })
        .map((n) => ({ name: n, refBox: ref.components[n].box, oursBox: ours.components[n].box }));

    if (!items.length) {
        console.error('nothing comparable — both captures need box.x/box.y, so re-run them with the current probe.');
        process.exit(1);
    }

    const browser = await chromium.launch();
    const page = await browser.newPage();
    const rows = await page.evaluate(inPage, {
        refPng: dataUrl(refPng), oursPng: dataUrl(oursPng),
        refViewport: ref.viewport, oursViewport: ours.viewport,
        items, cell: CELL
    });
    await browser.close();

    const dir = path.join(OUT, 'pix');
    fs.mkdirSync(dir, { recursive: true });
    rows.forEach((r) => {
        if (!r.png) return;
        fs.writeFileSync(path.join(dir, r.name + '.png'), Buffer.from(r.png.split(',')[1], 'base64'));
        delete r.png;
    });

    const scored = rows.filter((r) => !r.skipped).sort((a, b) => (b.formD + b.meanD) - (a.formD + a.meanD));
    const w = (k, h) => Math.max(h.length, ...scored.map((r) => String(r[k]).length));
    const cols = [['name', 'component'], ['meanD', 'meanΔ'], ['formD', 'formΔ'], ['refSize', 'reference'], ['oursSize', 'ours']];
    const widths = cols.map(([k, h]) => w(k, h));
    const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');

    console.log(line(cols.map((c) => c[1])));
    console.log(widths.map((n) => '-'.repeat(n)).join('  '));
    scored.forEach((r) => console.log(line(cols.map((c) => r[c[0]]))));
    rows.filter((r) => r.skipped).forEach((r) => console.log(r.name + ' — ' + r.skipped));
    console.log('\ncontact sheets in dev/spec/out/pix (reference | ours | difference)');
    console.log('sorted worst first. high formΔ with low meanΔ = right colours, wrong arrangement.');
})();
