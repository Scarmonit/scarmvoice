// Copy the RealtimeKit browser bundle out of node_modules into the renderer so
// the packaged app loads it from disk instead of a CDN. The website pulls
// @cloudflare/realtimekit@2.0.0 from jsDelivr; we pin the SAME version here,
// because that build is the one whose 64 kbps-mono Opus + audio-middleware
// behaviour was verified against the SFU.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'src', 'renderer', 'vendor');

const CANDIDATES = [
    'dist/browser.js',
    'dist/index.js',
    'dist/realtimekit.js'
];

function main() {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, '.gitkeep'), '');

    // Resolve by path, not require.resolve: the package's "exports" map does not
    // expose ./package.json, so the resolver refuses to look inside it.
    const pkgDir = path.join(ROOT, 'node_modules', '@cloudflare', 'realtimekit');
    if (!fs.existsSync(path.join(pkgDir, 'package.json'))) {
        console.warn('[vendor] @cloudflare/realtimekit not installed yet — skipping.');
        return;
    }

    let src = null;
    for (const rel of CANDIDATES) {
        const p = path.join(pkgDir, rel);
        if (fs.existsSync(p)) { src = p; break; }
    }
    if (!src) {
        console.error('[vendor] could not find a browser bundle in ' + pkgDir);
        console.error('[vendor] contents of dist/: ' +
            (fs.existsSync(path.join(pkgDir, 'dist')) ? fs.readdirSync(path.join(pkgDir, 'dist')).join(', ') : '(no dist)'));
        process.exitCode = 1;
        return;
    }

    const dest = path.join(OUT_DIR, 'realtimekit.js');
    fs.copyFileSync(src, dest);
    const version = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version;
    const kb = Math.round(fs.statSync(dest).size / 1024);
    console.log(`[vendor] realtimekit ${version} <- ${path.relative(pkgDir, src)} (${kb} KB)`);
}

main();
