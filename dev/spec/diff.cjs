// Compares two spec files and prints only what differs.
//
//   node dev/spec/diff.cjs dev/spec/out/discord.json dev/spec/out/app.json
//
// The point of the thresholds is that nobody wants a report saying a colour is
// one point out. They exist so the output is a list of things worth doing,
// not a list of things that are technically unequal.
const fs = require('fs');

const COLOUR_TOLERANCE = 4;      // points of luminance
const SIZE_TOLERANCE = 2;        // px
const IGNORE = new Set(['at', 'viewport', 'text', 'fontFamily', 'stateRules']);

function hexToLum(h) {
    if (typeof h !== 'string' || h[0] !== '#') return null;
    const n = parseInt(h.slice(1, 7), 16);
    return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
}

function near(a, b) {
    if (a === b) return true;
    const la = hexToLum(a), lb = hexToLum(b);
    if (la !== null && lb !== null) return Math.abs(la - lb) <= COLOUR_TOLERANCE;
    const na = parseFloat(a), nb = parseFloat(b);
    if (Number.isFinite(na) && Number.isFinite(nb) && /px$/.test(String(a)) && /px$/.test(String(b))) {
        return Math.abs(na - nb) <= SIZE_TOLERANCE;
    }
    return false;
}

function compare(name, ref, ours, out) {
    if (!ref || ref.missing) return;                 // nothing to compare against
    if (!ours || ours.missing) { out.push([name, 'component', 'present', 'MISSING']); return; }

    // A pane that fills its column is as big as the window lets it be, so its
    // width and height say nothing about either app. Only compare a box when it
    // is small enough to have been chosen rather than inherited.
    const CHOSEN = 400;
    if (ref.box && ours.box) {
        ['w', 'h'].forEach((k) => {
            if (ref.box[k] > CHOSEN && ours.box[k] > CHOSEN) return;
            if (Math.abs(ref.box[k] - ours.box[k]) > SIZE_TOLERANCE) {
                out.push([name, 'box.' + k, ref.box[k] + 'px', ours.box[k] + 'px']);
            }
        });
    }
    if (ref.ink && ours.ink) {
        ['w', 'h'].forEach((k) => {
            if (Math.abs(ref.ink[k] - ours.ink[k]) > SIZE_TOLERANCE) {
                out.push([name, 'glyph.' + k, ref.ink[k] + 'px', ours.ink[k] + 'px']);
            }
        });
    }
    // A colour and its token name are one fact, so they go on one line. Left
    // as separate rows they doubled the length of the report and put the
    // interesting half — the NAME the reference gives that colour — on a line
    // of its own where it read as a second, unrelated difference.
    const tokenOf = (side, key) => {
        const t = side[key + 'Token'];
        return t && t.length ? '  ' + t[0] : '';
    };

    Object.keys(ref).forEach((k) => {
        if (IGNORE.has(k) || k === 'box' || k === 'ink' || k === 'glyphs' || k === 'onHover') return;
        if (/Lum$/.test(k)) return;                   // covered by its colour
        if (/Token$/.test(k)) return;                 // folded into its colour
        if (/^onHoverReal$|^onActiveReal$/.test(k)) return;   // behaviour, reported below
        const a = ref[k], b = ours[k];
        if (b === undefined) { out.push([name, k, String(a), '(unset)']); return; }
        if (near(a, b)) return;
        const isColour = /[Cc]olor$/.test(k);
        out.push([name, k,
            String(a) + (isColour ? tokenOf(ref, k) : ''),
            String(b) + (isColour ? tokenOf(ours, k) : '')]);
    });

    // Hover is a behaviour, so report only whether one side has it at all.
    if (ref.onHover && !ours.onHover) out.push([name, 'onHover', 'changes', 'no change']);
    // The forced-pseudo-class measurement, when both captures have one. This is
    // the reliable half — onHover above only ever sees JS-driven state.
    [['onHoverReal', ':hover'], ['onActiveReal', ':active']].forEach(([key, label]) => {
        const a = ref[key], b = ours[key];
        if (!a && !b) return;
        if (a && !b) { out.push([name, label, Object.keys(a).join(','), 'no change']); return; }
        if (!a && b) { out.push([name, label, 'no change', Object.keys(b).join(',')]); return; }
        Object.keys(a).forEach((p) => {
            if (b[p] === undefined) { out.push([name, label + ' ' + p, String(a[p]), '(unchanged)']); return; }
            if (!near(a[p], b[p])) out.push([name, label + ' ' + p, String(a[p]), String(b[p])]);
        });
    });
}

const [refPath, oursPath] = process.argv.slice(2);
if (!refPath || !oursPath) {
    console.error('usage: node dev/spec/diff.cjs <reference.json> <ours.json>');
    process.exit(2);
}
const ref = JSON.parse(fs.readFileSync(refPath, 'utf8'));
const ours = JSON.parse(fs.readFileSync(oursPath, 'utf8'));

const rows = [];
Object.keys(ref.components).forEach((n) => compare(n, ref.components[n], ours.components[n], rows));

if (!rows.length) {
    console.log('no differences above threshold (' + Object.keys(ref.components).length + ' components)');
    process.exit(0);
}
const w = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => String(r[i]).length), ['component', 'property', 'reference', 'ours'][i].length));
const line = (r) => r.map((c, i) => String(c).padEnd(w[i])).join('  ');
console.log(line(['component', 'property', 'reference', 'ours']));
console.log(w.map((n) => '-'.repeat(n)).join('  '));
let last = '';
rows.forEach((r) => { console.log(line([r[0] === last ? '' : r[0], r[1], r[2], r[3]])); last = r[0]; });
console.log('\n' + rows.length + ' difference' + (rows.length === 1 ? '' : 's') + ' worth looking at.');
