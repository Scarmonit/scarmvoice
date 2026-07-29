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
const path = require('node:path');

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

try {
    // --latest so the download button and the update feed both resolve here.
    gh(['release', 'edit', tag, '--repo', repo, '--draft=false', '--latest']);
} catch (e) {
    die(`could not publish ${tag}.\n  ` +
        String((e.stderr || '') + (e.stdout || '')).trim().split('\n')[0]);
}

console.log(`  published ${tag} with ${assets.join(', ')}`);
