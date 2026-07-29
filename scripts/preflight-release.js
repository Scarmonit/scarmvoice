// Refuse to publish over a version that already exists on GitHub.
//
// This exists because it happened. v0.12.1 was released, users auto-updated to
// it, and a later run reused the same version number — electron-builder
// cheerfully OVERWROTE the assets ("already exists on GitHub"). Everyone who had
// taken the first build was then stranded: their app reports 0.12.1, the feed
// offers 0.12.1, and electron-updater correctly answers "no update available".
// There is no way out of that except shipping a new version number, and no way
// to notice it except checking first.
//
// Runs before every `npm run release`. Fails loudly rather than silently
// clobbering a published artifact.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const pkg = require(path.join(__dirname, '..', 'package.json'));
const tag = 'v' + pkg.version;
const repo = 'Scarmonit/scarmvoice';

function die(msg) {
    console.error('\n  release preflight failed: ' + msg + '\n');
    process.exit(1);
}

// The RNNoise worklet is GENERATED — scripts/rnnoise-processor.js concatenated
// onto the wasm glue — and src/renderer/vendor is gitignored, so the file on
// disk is whatever the last `npm install` left behind. It used to be built only
// at postinstall, which meant editing the processor and running `npm run
// release` shipped the OLD worklet with no warning at all: v0.54.1 went out
// with a processor that could not report a failed model, so a machine where the
// wasm would not start ran the microphone with NO noise suppression while the
// UI said the AI filter was on. `vendor` is part of the build now; this asserts
// it actually took, because a silent staleness is exactly what went wrong.
//
// AFTER that vendor step, not before it. This used to be the first thing the
// release script ran — ahead of the `npm run vendor` in the same command — so
// it judged whatever an earlier run happened to leave on disk and said nothing
// at all about what this build would package. Editing the processor and running
// `npm run release` therefore failed the release outright, telling the operator
// to run the very command that was already queued behind it.
function checkVendoredWorklet() {
    const processor = path.join(__dirname, 'rnnoise-processor.js');
    const worklet = path.join(__dirname, '..', 'src', 'renderer', 'vendor', 'rnnoise-worklet.js');
    let src;
    let built;
    try {
        src = fs.readFileSync(processor, 'utf8');
        built = fs.readFileSync(worklet, 'utf8');
    } catch (e) {
        die('could not read the RNNoise worklet or its source (' + e.message + ').\n' +
            '  Run `npm run vendor` and try again.');
    }
    if (!built.endsWith(src)) {
        die('src/renderer/vendor/rnnoise-worklet.js is STALE — it does not end with the\n' +
            '  current scripts/rnnoise-processor.js. Run `npm run vendor` and re-run.');
    }
    console.log('  preflight ok — the vendored RNNoise worklet is current');
}

checkVendoredWorklet();

let body;
try {
    body = execFileSync('gh', ['api', `repos/${repo}/releases/tags/${tag}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
} catch (e) {
    const err = String((e.stderr || '') + (e.stdout || ''));
    // 404 is the good case: this version has never been published.
    if (/Not Found|HTTP 404/i.test(err)) {
        console.log(`  preflight ok — ${tag} is unpublished`);
        process.exit(0);
    }
    // Anything else (no gh, not logged in, network) must not silently pass:
    // a preflight that fails open is not a preflight.
    die(`could not ask GitHub whether ${tag} exists.\n  ${err.trim().split('\n')[0]}`);
}

let assets = [];
try { assets = (JSON.parse(body).assets || []).map((a) => a.name); } catch (e) { /* treat as existing */ }

die(
    `${tag} is ALREADY PUBLISHED on ${repo}` +
    (assets.length ? ` with ${assets.join(', ')}` : '') + '.\n' +
    '  Publishing over it strands everyone who already installed that build:\n' +
    '  their app and the update feed would both report the same version, so\n' +
    '  electron-updater will never offer them anything again.\n\n' +
    `  Bump "version" in package.json past ${pkg.version} and re-run.`
);
