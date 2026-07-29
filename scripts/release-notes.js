// Where a release's notes come from, and what counts as having any.
//
// This exists because v0.56.0 shipped without them. The notes were a manual
// `gh release edit` after `npm run release` — a step that lived in somebody's
// head and in no file, so the first release published by someone who did not
// know about it went out blank. That is not a cosmetic loss: `updater.js`
// parses this text and it is the ONLY thing the app can show about what
// changed, in two places that both matter —
//
//   • the update banner, which is what someone sees when they are offered the
//     new version and is their one chance to know what they are accepting
//   • Settings → About → Release notes, which is the whole published history
//
// So the notes are a build input now, checked by the preflight before anything
// is built and applied by the publish step before the release goes live.
//
// FORMAT. One file per version at build/release-notes/v<version>.md:
//
//   line 1        the release TITLE — a short phrase, e.g. "The audit pass".
//                 It is the release's name on GitHub and the heading in the
//                 history list.
//   line 2        blank
//   the rest      the BODY, in the house style: written for the person
//                 running the app, not for whoever wrote the code. Plain
//                 language, no file names, no internal identifiers. Sections
//                 are a line that is entirely bold — `**Your window**` — which
//                 is what updater.js's parseNotes() reads as a heading; bullets
//                 are ordinary `-` lines. Anything else renders as a paragraph.
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'build', 'release-notes');

// Short enough that a placeholder fails, long enough that a genuinely small
// release still passes.
const MIN_BODY = 80;

function notesPath(version) {
    return path.join(DIR, 'v' + version + '.md');
}

// -> { path, title, body } or throws with a message worth printing.
function readNotes(version) {
    const file = notesPath(version);
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
        throw new Error(
            'no release notes for v' + version + '.\n' +
            '  Write them at build/release-notes/v' + version + '.md — first line is the\n' +
            '  title, the rest is the body. See scripts/release-notes.js for the format,\n' +
            '  and any previous file in that folder for the house style.'
        );
    }
    const lines = raw.replace(/\r\n/g, '\n').split('\n');
    const title = (lines.shift() || '').trim();
    const body = lines.join('\n').trim();
    if (!title) throw new Error('build/release-notes/v' + version + '.md has no title on its first line.');
    if (body.length < MIN_BODY) {
        throw new Error(
            'build/release-notes/v' + version + '.md has no real body (' + body.length + ' characters).\n' +
            '  This text is the only thing the app can show about what changed.'
        );
    }
    return { path: file, title, body };
}

module.exports = { readNotes, notesPath, DIR };
