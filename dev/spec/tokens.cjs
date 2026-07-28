// Our variables, against theirs.
//
//   node dev/spec/tokens.cjs dev/spec/out/discord-tokens.json dev/spec/out/app-tokens.json
//
// The reference is not a collection of hex codes, it is a token system: its
// rules are written as var(--background-base-lowest), not as #121214, and the
// hex is just what that name resolves to in one theme. Every colour copied off
// a screenshot has been one resolved value of one token, transcribed without
// its name.
//
// This puts the two systems side by side. For each of ours it finds the
// reference token that resolves to the same paint — exactly, or nearest by
// luminance — and reports which of ours are already right, which are close
// enough to be deliberate, and which are simply a different colour.
//
// What it does NOT do is tell you to change anything. Ours is a smaller,
// deliberately flatter system with its own accent; a token that differs may be
// a decision. The point is that the difference is now visible and named
// instead of being discovered a fortnight later by eye.
const fs = require('fs');

// Distance in RGB, not in luminance.
//
// The first version of this matched on luminance alone and every single token
// found a "nearest" at a distance of zero — because against 4691 candidates
// something always shares a brightness. It confidently paired our --elev
// (#343439, a grey) with --orange-new-72 (#732700, a brown), which are the
// same weight of light and nothing else. A match has to account for hue, or it
// is just an index of how dark things are.
//
// Alpha counts too: a 4% white overlay and an opaque white are not neighbours.
const CLOSE = 12;                 // RGB units; beyond this it is our own colour

function parse(hex) {
    if (typeof hex !== 'string' || hex[0] !== '#') return null;
    const [rgbPart, aPart] = hex.split('@');
    const n = parseInt(rgbPart.slice(1, 7), 16);
    if (Number.isNaN(n)) return null;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: aPart === undefined ? 1 : parseFloat(aPart) };
}

function distance(x, y) {
    const d = Math.sqrt(((x.r - y.r) ** 2 + (x.g - y.g) ** 2 + (x.b - y.b) ** 2) / 3);
    // A full step of alpha is at least as big a difference as a full step of
    // colour, so it is scaled to the same range rather than added raw.
    return d + Math.abs(x.a - y.a) * 255;
}

// Same ranking the probe uses, so a name reported here matches a name reported
// against a component.
const RAMP = /-\d+$/;
const ROOT = /^--(background|bg|text|border|interactive|button|channel|panel|card|surface|content|elevation|radius|spacing|space|shadow|status|input|header|link|icon)\b/;
const rank = (n) => (RAMP.test(n) ? 100 : 0) + (ROOT.test(n) ? 0 : 10) + n.split('-').length;

const [refPath, oursPath] = process.argv.slice(2);
if (!refPath || !oursPath) {
    console.error('usage: node dev/spec/tokens.cjs <reference-tokens.json> <our-tokens.json>');
    process.exit(2);
}
const ref = JSON.parse(fs.readFileSync(refPath, 'utf8'));
const ours = JSON.parse(fs.readFileSync(oursPath, 'utf8'));

// hex -> best reference name for it
const byHex = {};
Object.entries(ref).forEach(([n, v]) => { if (v.hex) (byHex[v.hex] = byHex[v.hex] || []).push(n); });
Object.keys(byHex).forEach((h) => byHex[h].sort((a, b) => rank(a) - rank(b) || a.length - b.length));

const refColours = Object.entries(byHex).map(([hex, names]) => ({ hex, name: names[0], c: parse(hex) }))
    .filter((r) => r.c);

const rows = [];
Object.entries(ours).forEach(([name, v]) => {
    if (!v.hex) return;                       // not a colour: radii, timings, fonts
    const c = parse(v.hex);
    if (!c) return;

    const exact = byHex[v.hex];
    if (exact) {
        rows.push({ name, hex: v.hex, verdict: 'exact', ref: exact[0], delta: 0 });
        return;
    }
    let best = null;
    for (const r of refColours) {
        const d = distance(c, r.c);
        if (!best || d < best.delta) best = { ref: r.name, hex: r.hex, delta: d };
    }
    const close = best && best.delta <= CLOSE;
    rows.push({
        name, hex: v.hex,
        verdict: close ? 'close' : 'ours',
        // An unmatched token has no useful nearest, and printing one anyway is
        // how --elev came to be paired with a brown.
        ref: close ? best.ref + ' ' + best.hex : '—',
        delta: close ? +best.delta.toFixed(1) : null
    });
});

const order = { exact: 0, close: 1, ours: 2 };
rows.sort((a, b) => order[a.verdict] - order[b.verdict] || a.delta - b.delta);

const cols = [['name', 'ours'], ['hex', 'value'], ['verdict', ''], ['ref', 'reference'], ['delta', 'Δlum']];
const w = cols.map(([k, h]) => Math.max(h.length, ...rows.map((r) => String(r[k] === null ? '' : r[k]).length)));
const line = (c) => c.map((x, i) => String(x === null ? '' : x).padEnd(w[i])).join('  ');

console.log(line(cols.map((c) => c[1])));
console.log(w.map((n) => '-'.repeat(n)).join('  '));
rows.forEach((r) => console.log(line(cols.map((c) => r[c[0]]))));

const n = (v) => rows.filter((r) => r.verdict === v).length;
console.log('\n' + rows.length + ' of our colour tokens: '
    + n('exact') + ' land on a reference token exactly, '
    + n('close') + ' within ' + CLOSE + ' points, '
    + n('ours') + ' are our own.');
console.log(Object.keys(ref).length + ' reference tokens available in ' + refPath.split(/[\\/]/).pop() + '.');
