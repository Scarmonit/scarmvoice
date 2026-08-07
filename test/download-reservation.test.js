// Two downloads of one filename must not write into one file.
//
// board:downloadAttachment chose its destination with fsp.access — a look, not
// a reservation — and streamToFile awaits a whole authenticated fetch before
// createWriteStream opens the file. So the gap between "is this name free" and
// "this name is mine" is the width of a network round trip, not a
// microsecond. Nothing upstream narrows it: downloadImage() in the renderer
// awaits the IPC and does nothing else — no in-flight guard, no disabled
// control, no per-name lock.
//
// Two messages carrying image.png, or one picture asked for twice, therefore
// both saw ENOENT, both chose the bare name, and both pipelined into it with
// createWriteStream's default create-or-truncate flags. The bytes interleave,
// and BOTH calls still answer { success: true } on the same path — from a
// handler whose own comment two lines above promises it never silently
// clobbers an existing file.
//
// main.js cannot be imported: it reaches for a real Electron `app` at module
// scope (see upload-path-grant.test.js). So the registration is read out of
// the source and executed with injected bindings. That runs the ACTUAL
// production callback — not a reimplementation of it, which would only ever
// prove that the copy in this file is correct.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main');

// The complete `handle('board:downloadAttachment', …);` expression, verbatim.
// Registrations sit at one indent level and close with `\n    });`, and every
// block inside this one is indented further, so the first such terminator after
// the start IS this handler's own.
function handlerSource() {
    const src = fs.readFileSync(path.join(MAIN, 'main.js'), 'utf8').replace(/\r\n/g, '\n');
    const start = src.indexOf("handle('board:downloadAttachment'");
    expect(start, 'the board:downloadAttachment handler moved or was renamed').toBeGreaterThan(-1);
    const TERM = '\n    });';
    const end = src.indexOf(TERM, start);
    expect(end, 'could not find the end of the handler registration').toBeGreaterThan(start);
    return src.slice(start, end + TERM.length);
}

// Execute that expression with everything it closes over supplied by us. The
// fake `handle` exists only to capture the callback.
function loadHandler({ getDownloads, streamToFile }) {
    let captured = null;
    const run = new Function(
        'handle', 'app', 'path', 'fsp', 'streamToFile', 'rememberRevealable',
        handlerSource());
    run(
        (_channel, cb) => { captured = cb; },
        { getPath: () => getDownloads() },
        path,
        fsp,
        streamToFile,
        () => {}
    );
    expect(typeof captured, 'the registration handed back no callback').toBe('function');
    return captured;
}

// Yield to the event loop without a timer, bounded so a handler that throws
// early fails the assertion instead of hanging the suite.
async function until(cond, why) {
    for (let i = 0; i < 2000 && !cond(); i++) await new Promise((r) => setImmediate(r));
    expect(cond(), why).toBe(true);
}

describe('two concurrent downloads of the same filename', () => {
    let dir = null;
    afterEach(() => {
        if (dir) fs.rmSync(dir, { recursive: true, force: true });
        dir = null;
    });

    it('gives each one its own path, with both files intact', async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scarmvoice-dl-'));

        // The barrier stands exactly where the real fetch stands: the old code
        // picked its name BEFORE this point and created the file AFTER it, so
        // holding both callers here reproduces the production window without
        // depending on timing.
        let release;
        const barrier = new Promise((r) => { release = r; });
        let arrived = 0;

        const streamToFile = async (ref, destPath) => {
            arrived++;
            await barrier;
            // Distinct payloads: if both land on one path, whatever survives
            // cannot be both, and interleaving is visible as neither.
            await fsp.writeFile(destPath, ref.key === 'A' ? 'AAAA' : 'BBBB');
        };

        const handler = loadHandler({ getDownloads: () => dir, streamToFile });

        const a = handler(null, { key: 'A', name: 'shot.png' });
        const b = handler(null, { key: 'B', name: 'shot.png' });

        await until(() => arrived === 2, 'both handlers should have reached the fetch');
        release();
        const [ra, rb] = await Promise.all([a, b]);

        expect(ra.success).toBe(true);
        expect(rb.success).toBe(true);

        // THE REGRESSION: both used to answer the same path.
        expect(ra.path).not.toBe(rb.path);
        expect(new Set([path.basename(ra.path), path.basename(rb.path)]))
            .toEqual(new Set(['shot.png', 'shot (2).png']));

        // And each file holds all of its own bytes and none of the other's.
        expect(fs.readFileSync(ra.path, 'utf8')).toBe('AAAA');
        expect(fs.readFileSync(rb.path, 'utf8')).toBe('BBBB');
        expect(fs.readdirSync(dir).sort()).toEqual(['shot (2).png', 'shot.png']);
    });

    it('still disambiguates against a file that is already on disk', async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scarmvoice-dl-'));
        fs.writeFileSync(path.join(dir, 'shot.png'), 'OLD');

        const handler = loadHandler({
            getDownloads: () => dir,
            streamToFile: async (_ref, destPath) => { await fsp.writeFile(destPath, 'NEW'); }
        });

        const res = await handler(null, { key: 'A', name: 'shot.png' });
        expect(res.success).toBe(true);
        expect(path.basename(res.path)).toBe('shot (2).png');
        // The promise the handler's own comment makes, unchanged by the fix.
        expect(fs.readFileSync(path.join(dir, 'shot.png'), 'utf8')).toBe('OLD');
    });

    it('leaves no empty file behind when the download fails', async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scarmvoice-dl-'));

        const handler = loadHandler({
            getDownloads: () => dir,
            // Thrown the way attachmentResponse throws — BEFORE any pipeline
            // exists. streamToFile's own catch only covers a failed pipeline,
            // so it never sees this and never unlinks.
            streamToFile: async () => { throw new Error('Server returned 404'); }
        });

        const res = await handler(null, { key: 'A', name: 'gone.png' });
        expect(res.success).toBe(false);
        expect(res.error).toBe('Server returned 404');

        // Reserving the name creates the file up front. If a failed download
        // does not release it, a 0-byte file sits in Downloads looking like a
        // finished save, and it holds the name — so the retry lands on
        // "gone (2).png" instead of the name the reader actually asked for.
        expect(fs.existsSync(path.join(dir, 'gone.png'))).toBe(false);
        expect(fs.readdirSync(dir)).toEqual([]);
    });
});
