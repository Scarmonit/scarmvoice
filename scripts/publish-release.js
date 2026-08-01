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

// ---- tell the apps that are already running --------------------------------
//
// Everything above makes the release findable. This makes it found NOW.
//
// An installed app checks the feed on a five-minute sweep, which for something
// somebody has had open all day is five minutes of running a version that has
// been superseded — and before that it was three HOURS, which in practice meant
// the update arrived at the next launch and "Check for updates" in Settings was
// the only way to learn about it sooner.
//
// So the last thing a release does is say so: /api/board/release asks the
// board's realtime object to broadcast a `release` nudge, every connected
// client answers it by checking its own update feed, and the update pill
// appears in about a second.
//
// BEST EFFORT, ALWAYS. This runs after the release is already live and public,
// so nothing here can invalidate it — a missing token, an offline box or a 500
// costs the announcement and nothing else, and the five-minute sweep picks the
// release up regardless. A release that FAILED because a notification failed
// would be a strictly worse trade.
const ANNOUNCE_URL = process.env.SCARMVOICE_ANNOUNCE_URL || 'https://scarmonit.com/api/board/release';
const token = process.env.SCARMVOICE_RELEASE_TOKEN || '';

(async () => {
    if (!token) {
        console.log('  (no SCARMVOICE_RELEASE_TOKEN — running clients will pick this up ' +
            'on their next check, within five minutes)');
        return;
    }
    try {
        const res = await fetch(ANNOUNCE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
            body: JSON.stringify({ version: pkg.version }),
            signal: AbortSignal.timeout(10000)
        });
        const out = await res.json().catch(() => ({}));
        if (!res.ok || !out.success) {
            console.warn(`  announce failed (${res.status}${out.error ? ': ' + out.error : ''}) — ` +
                'running clients will pick this up on their next check');
            return;
        }
        console.log(`  announced v${pkg.version} to ${out.delivered || 0} connected client(s)`);
    } catch (e) {
        console.warn('  announce failed (' + ((e && e.message) || 'unknown') + ') — ' +
            'running clients will pick this up on their next check');
    }
})();
