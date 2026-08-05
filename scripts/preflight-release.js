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
const { readNotes } = require('./release-notes');

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

    // The message box IS the editor. A release built without it is an app with
    // no way to type, which is not a subtle failure but is a silent one at
    // build time — vendor/ is gitignored, so what ships is whatever the last
    // vendor run left on disk.
    const cmFile = path.join(__dirname, '..', 'src', 'renderer', 'vendor', 'codemirror.js');
    if (!fs.existsSync(cmFile)) die('src/renderer/vendor/codemirror.js is missing — run `npm run vendor`.');
    const cmSrc = fs.readFileSync(cmFile, 'utf8');
    if (!/defineMode\("markdown"/.test(cmSrc)) {
        die('the vendored CodeMirror has no markdown mode — the composer would load without one.');
    }
    console.log('  preflight ok — the vendored editor is present, with its markdown mode');

    // …and the SDK the voice room is built on, for the same reason with a worse
    // failure. vendor-sdk.js WARNS and returns success when
    // @cloudflare/realtimekit is not installed — a reasonable thing to do at
    // postinstall, and the wrong thing during a release: the `&&` chain
    // continues, electron-builder packages a renderer with no
    // vendor/realtimekit.js in it, and every "Join VoiceChat" click lands in
    // lazy.js's error path. The app ships, updates itself onto everyone, and
    // voice is simply "unavailable" with nothing at build time having said so.
    // Two of the five vendored files were guarded; this is the one whose
    // absence costs a whole feature.
    const sdk = path.join(__dirname, '..', 'src', 'renderer', 'vendor', 'realtimekit.js');
    if (!fs.existsSync(sdk)) {
        die('src/renderer/vendor/realtimekit.js is missing — the packaged app would have\n' +
            '  no voice SDK at all. Run `npm install` (vendor-sdk.js skips silently when\n' +
            '  @cloudflare/realtimekit is not installed) and try again.');
    }
    // A truncated or empty copy is the same outage with a file to point at.
    if (fs.statSync(sdk).size < 100 * 1024) {
        die('src/renderer/vendor/realtimekit.js is too small to be the SDK bundle —\n' +
            '  it is probably a truncated copy. Run `npm run vendor` and try again.');
    }
    console.log('  preflight ok — the vendored voice SDK is present');
}

// The notes are checked FIRST and they are checked HERE, before anything is
// built, because they are the one release input a human has to write and so the
// only one that can be forgotten. v0.56.0 was published without them: the update
// banner and the whole history in Settings → About had nothing to say about it,
// which is a release nobody can find out anything about from inside the app.
// Failing here costs a second; finding out afterwards costs a version number.
function checkReleaseNotes() {
    let notes;
    try {
        notes = readNotes(pkg.version);
    } catch (e) {
        die(e.message);
    }
    console.log(`  preflight ok — release notes for v${pkg.version} ("${notes.title}")`);
}

// The TAG electron-builder creates has to name the source that was built.
//
// It creates the release through the GitHub API, and the API cuts the tag at
// whatever the default branch's HEAD is AT THAT MOMENT. `npm run release` ran
// before the commit was pushed, so the tag landed on the PREVIOUS release's
// commit — v0.55.0, v0.57.0 and v0.58.0 all did it. `git checkout v0.57.0` gave
// you v0.56.0's code, and the release page counted the release's own commit as
// "1 commit to main since this release".
//
// Nothing downstream notices, which is exactly why it went unnoticed: the feed
// and the installer are built from the working tree and are correct either way.
// It is the one thing that says WHICH source shipped, so it is worth a check
// that costs two git commands.
function checkCommitted() {
    const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    let head;
    try {
        // Tracked files only: dist/, and anything else gitignored, is not source.
        if (git(['status', '--porcelain', '--untracked-files=no'])) {
            die('the working tree has uncommitted changes.\n' +
                '  The release tag is cut from the pushed branch, so it would name the\n' +
                '  PREVIOUS commit and no tag would ever point at what shipped.\n' +
                '  Commit them and try again.');
        }
        head = git(['rev-parse', 'HEAD']);
        const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
        const remote = git(['ls-remote', 'origin', 'HEAD', `refs/heads/${branch}`]);
        if (!remote.includes(head)) {
            die(`HEAD (${head.slice(0, 7)}) is not on origin/${branch}.\n` +
                '  electron-builder cuts the tag at the remote branch head, so publishing\n' +
                '  now would tag the previous commit.\n' +
                `  Run \`git push origin ${branch}\` and try again.`);
        }
    } catch (e) {
        // A missing git, or no remote, is not a reason to refuse to release — but
        // it is a reason to say the tag will not be trustworthy. (die() exits the
        // process, so a genuine failure above never reaches here.)
        console.warn('  preflight warning — could not verify the commit is pushed (' +
            ((e && e.message) || 'unknown') + ').\n' +
            '  The release tag may not name the source that was built.');
        return;
    }
    console.log(`  preflight ok — HEAD ${head.slice(0, 7)} is committed and pushed`);
}

checkReleaseNotes();
checkVendoredWorklet();
checkCommitted();

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
