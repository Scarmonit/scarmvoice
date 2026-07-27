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
const path = require('node:path');

const pkg = require(path.join(__dirname, '..', 'package.json'));
const tag = 'v' + pkg.version;
const repo = 'Scarmonit/scarmvoice';

function die(msg) {
    console.error('\n  release preflight failed: ' + msg + '\n');
    process.exit(1);
}

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
