// A path arriving over IPC is renderer-supplied, and main must not read it.
//
// board:uploadAttachment takes { name, type, size, path } and streams that path
// off the disk into a presigned PUT. The path is supposed to come from
// webUtils.getPathForFile — a file the USER picked in a dialog or dropped on the
// window — but the channel accepts any string, and the renderer is the one part
// of this app that runs content other people wrote (message bodies, custom
// emoji, unfurl metadata, avatar URLs). Unchecked, one call with a path of its
// own choosing publishes %APPDATA%\ScarmVoice\account.bin — the account token
// the whole main/renderer split exists to keep out of the renderer — as a board
// attachment anyone can then fetch. settings.json, and every other file this
// user can read, go the same way.
//
// The fix is the one already used for board:revealFile: main only accepts a path
// it handed out itself. The preload reports each path webUtils answers with, and
// nothing else can get onto that list — getPathForFile resolves the blob backing
// a real File and returns '' for anything the renderer merely constructed.
//
// main.js cannot be required here (it reaches for a real Electron app object at
// module scope — see audit-0.75-main.test.js), so these read the source. Each is
// written to fail on the shape of the regression rather than on formatting.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main');

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

let mainCode = '';
let preloadCode = '';
// The body of the uploadAttachment handler, comments removed — the prose around
// it describes the attack, so a needle matched against raw text could be
// satisfied by the explanation rather than by the code.
let uploadHandler = '';

beforeAll(() => {
    const read = (f) => fs.readFileSync(path.join(MAIN, f), 'utf8').replace(/\r\n/g, '\n');
    mainCode = strip(read('main.js'));
    preloadCode = strip(read('preload.js'));

    const start = mainCode.indexOf("handle('board:uploadAttachment'");
    expect(start, 'the board:uploadAttachment handler moved or was renamed').toBeGreaterThan(-1);
    // To the next handler registration, which is where this one ends.
    const after = mainCode.indexOf('handle(', start + 10);
    uploadHandler = mainCode.slice(start, after > -1 ? after : start + 2000);
});

describe('the upload path allow-list', () => {
    it('exists, and is fed only by the preload', () => {
        // The grant channel is one-way and its only sender is pathForFile.
        expect(mainCode).toMatch(/ipcMain\.on\(\s*['"]path:granted['"]/);
        expect(preloadCode).toMatch(/ipcRenderer\.send\(\s*['"]path:granted['"]/);
        // …and the send sits inside pathForFile, not somewhere the renderer can
        // reach with a string of its own.
        const pf = preloadCode.slice(preloadCode.indexOf('pathForFile:'));
        const end = pf.indexOf('saveAttachment:');
        expect(pf.slice(0, end > -1 ? end : 600)).toMatch(/path:granted/);
    });

    it('validates the sender of a grant, like every other channel', () => {
        // ipcMain.on bypasses the handle() wrapper that does this for the rest
        // of the IPC surface, so it has to do it itself.
        const at = mainCode.indexOf("ipcMain.on('path:granted'");
        const body = mainCode.slice(at, at + 500);
        expect(body).toMatch(/fromMainFrame\(\s*event\s*\)/);
    });

    it('is bounded, so a long session cannot grow it without limit', () => {
        const at = mainCode.indexOf("ipcMain.on('path:granted'");
        expect(mainCode.slice(at, at + 500)).toMatch(/uploadable\.delete/);
    });

    it('refuses an upload of any path it did not hand out', () => {
        // The check must be a membership test on the resolved path — resolved,
        // or '..\\..\\Windows\\..' style spellings of a granted path would each
        // read as a different string from the one that was granted.
        expect(uploadHandler).toMatch(/uploadable\.has\(\s*path\.resolve\(/);
        // …and it must REFUSE rather than fall through to the upload.
        expect(uploadHandler).toMatch(/return\s*\{\s*success:\s*false/);
    });

    it('refuses before it reads anything', () => {
        // Order is the whole point: a check that runs after net.uploadAttachment
        // has already stat'd and opened the file is not a check.
        const guard = uploadHandler.search(/uploadable\.has/);
        const upload = uploadHandler.search(/net\.uploadAttachment/);
        expect(guard).toBeGreaterThan(-1);
        expect(upload).toBeGreaterThan(-1);
        expect(guard).toBeLessThan(upload);
    });

    it('still allows the in-memory path, which names no file at all', () => {
        // A pasted screenshot and a finished voice recording arrive as bytes
        // with no path. They must not be caught by a path check.
        expect(uploadHandler).toMatch(/bytes/);
        // The guard is conditional on there BEING a path.
        expect(uploadHandler).toMatch(/if\s*\(\s*wanted\s*&&/);
    });
});

// The other two main-process reads of a remote image, fixed alongside it.
describe('fetching an image from a remote host', () => {
    it('does not abort the transfer it is in the middle of', () => {
        // AbortSignal.timeout aborts the response BODY as well as the header
        // exchange, so a 20s deadline killed every download slower than that —
        // which on a domestic uplink is anything past a few megabytes. net.js
        // fixed exactly this for attachments with a disarmable controller; this
        // is the same fix on the remote-URL path.
        const at = mainCode.indexOf('async function fetchRemoteImage');
        const body = mainCode.slice(at, mainCode.indexOf('async function boundedBuffer'));
        expect(at).toBeGreaterThan(-1);
        expect(body, 'the wall-clock signal is back').not.toMatch(/AbortSignal\.timeout/);
        expect(body).toMatch(/new AbortController\(\)/);
        // Disarmed once the headers are in, which is what the deadline covers.
        expect(body).toMatch(/disarm\(\)/);
        // The reason has to stay a TimeoutError: board:fetchImage branches on it.
        expect(body).toMatch(/TimeoutError/);
    });

    it('holds a dragged-in image to the image ceiling, not the 1 GB one', () => {
        // This path buffers in main and then copies the bytes across IPC. At the
        // attachment ceiling a URL claiming an image content-type could put a
        // gigabyte in the process that owns the tray, the PTT hook and all
        // networking — three times over, once per copy.
        const at = mainCode.indexOf("handle('board:fetchImage'");
        const body = mainCode.slice(at, at + 1500);
        expect(body).toMatch(/boundedBuffer\(\s*res\s*,\s*MAX_CLIPBOARD_IMAGE\s*\)/);
        expect(body).not.toMatch(/net\.MAX_UPLOAD/);
    });

    it('drains a response it is about to throw away', () => {
        // An unconsumed body pins its keep-alive connection until GC. Every
        // other abandon site in main.js and net.js cancels; these three did not.
        const at = mainCode.indexOf('async function attachmentResponse');
        const body = mainCode.slice(at, mainCode.indexOf("handle('board:saveAttachment'"));
        expect(body).toMatch(/refuse\(/);
        // No bare throw of a fresh Error left on a path holding a response.
        expect(body).not.toMatch(/throw new Error\(`Server returned/);
    });
});
