// Flip the release live — but only once the assets are actually on it.
//
// electron-builder used to publish straight to a LIVE release ("releaseType":
// "release"), and it creates the release record on the FIRST upload and streams
// the bytes afterwards. So from the moment the run started until the 84 MB
// installer finished uploading, `releases/latest` on the repo resolved to a
// release with nothing in it — and two things read exactly that:
//
//   • the website's "Download for Windows" button, which points at
//     releases/latest/download/ScarmVoice-Setup.exe and 404s
//   • every installed client, which fetches latest.yml from the newest release
//     and reports an update error when it isn't there yet
//
// The publish target is a DRAFT now (electron-builder's default once
// "releaseType" is gone). A draft is invisible to `releases/latest` and to the
// update feed, so a run that dies mid-upload changes nothing for anyone — and
// `gh api repos/:owner/:repo/releases/tags/<tag>` 404s on a draft, so the tag
// preflight still passes on the retry and electron-builder reuses the draft it
// left behind.
//
// This is the last step: assert both artifacts are present, then publish.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readNotes } = require('./release-notes');

const pkg = require(path.join(__dirname, '..', 'package.json'));
const tag = 'v' + pkg.version;
const repo = (pkg.build && pkg.build.publish && pkg.build.publish.owner)
    ? `${pkg.build.publish.owner}/${pkg.build.publish.repo}`
    : 'Scarmonit/scarmvoice';

// Both halves of an update. The installer without latest.yml is a download
// nobody is offered; latest.yml without the installer is an offer that 404s.
const REQUIRED = ['ScarmVoice-Setup.exe', 'latest.yml'];

function die(msg) {
    console.error('\n  release publish failed: ' + msg + '\n');
    process.exit(1);
}

function gh(args) {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

let assets = [];
try {
    assets = JSON.parse(gh(['release', 'view', tag, '--repo', repo, '--json', 'assets']))
        .assets.map((a) => a.name);
} catch (e) {
    die(`could not read the ${tag} release on ${repo}.\n  ` +
        String((e.stderr || '') + (e.stdout || '')).trim().split('\n')[0]);
}

const missing = REQUIRED.filter((n) => !assets.includes(n));
if (missing.length) {
    die(`${tag} is missing ${missing.join(' and ')} (has: ${assets.join(', ') || 'nothing'}).\n` +
        '  Leaving it as a draft — nobody is offered a release that cannot be installed.\n' +
        '  Re-run `npm run release`; electron-builder will reuse the draft.');
}

// The notes go on BEFORE the release goes live, in the same command that
// publishes it, so there is no window in which the update banner offers a
// version it can say nothing about — and no manual step left to forget. The
// preflight has already checked the file exists, so this can only fail on a
// version bump between the two, which is worth stopping for.
let notes;
try {
    notes = readNotes(pkg.version);
} catch (e) {
    die(e.message + '\n  The release is still a DRAFT — write them and re-run `npm run release`.');
}

// Through a file, not an argument: the body is multi-line and full of quotes,
// dashes and backticks, and every one of those is a way for a shell to mangle
// it or for an argument list to hit its length limit.
const bodyFile = path.join(os.tmpdir(), `scarmvoice-notes-${pkg.version}.md`);
try {
    fs.writeFileSync(bodyFile, notes.body, 'utf8');
    gh(['release', 'edit', tag, '--repo', repo, '--title', notes.title, '--notes-file', bodyFile]);
} catch (e) {
    die(`could not attach the release notes to ${tag}.\n  ` +
        String((e.stderr || '') + (e.stdout || '')).trim().split('\n')[0]);
} finally {
    try { fs.unlinkSync(bodyFile); } catch (e) { /* never existed */ }
}

// Believe the server, not the write above: this is the last check before
// anything is offered to anyone, and a release with no body is a release the
// app cannot describe.
let live = null;
try {
    live = JSON.parse(gh(['release', 'view', tag, '--repo', repo, '--json', 'body,name']));
} catch (e) {
    die(`could not confirm the notes landed on ${tag}.\n  ` +
        String((e.stderr || '') + (e.stdout || '')).trim().split('\n')[0]);
}
if (!live || !live.body || live.body.trim().length < 80) {
    die(`${tag} still has no release notes on GitHub after setting them.\n` +
        '  Leaving it as a draft rather than offering a version the app cannot describe.');
}

try {
    // --latest so the download button and the update feed both resolve here.
    gh(['release', 'edit', tag, '--repo', repo, '--draft=false', '--latest']);
} catch (e) {
    die(`could not publish ${tag}.\n  ` +
        String((e.stderr || '') + (e.stdout || '')).trim().split('\n')[0]);
}

console.log(`  published ${tag} — "${notes.title}" — with ${assets.join(', ')}`);
