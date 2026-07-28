// @vitest-environment jsdom
//
// Attachments that exist on disk must be uploaded BY PATH.
//
// main/net.js streams such a file straight from disk into a presigned PUT, so
// the bytes are never held in the renderer, never cross IPC, and never sit in a
// Worker. The renderer's half of that contract is one field — `path` — carried
// from webUtils.getPathForFile through the staging list into the upload
// payload, and it was silently dropped in the middle: stageFiles() built the
// staged item without it, so uploadOne()'s `if (item.path)` branch could never
// be taken and every attachment went the ArrayBuffer-over-IPC route the branch
// exists to avoid.
//
// Nothing failed loudly. A screenshot uploads fine either way; the composer's
// advertised 1 GB does not.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { bootRenderer, $, settle } from './helpers/renderer.js';

const PATH = 'C:\\Users\\me\\Videos\\holiday.mp4';

function boardRouter() {
    return vi.fn(async (p) => {
        if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
        if (p === 'list') return { success: true, posts: [], hasMore: false, maxId: 0 };
        if (p === 'post') return { success: true, id: 7 };
        return { success: true };
    });
}

// The picker's own path into stageFiles. jsdom's <input type=file> has no way
// to be given files by a user, so the FileList is defined on the element the
// way the change handler reads it.
function pick(file) {
    const input = $('file-input');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
}

function submitComposer() {
    $('composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}

describe('attachments that exist on disk', () => {
    let lounge;

    beforeEach(async () => {
        const booted = await bootRenderer({
            board: boardRouter(),
            pathForFile: (f) => (f && f.name ? PATH : '')
        });
        lounge = booted.lounge;
    });

    it('uploads by path rather than by reading the whole file into the renderer', async () => {
        const file = new window.File([new Uint8Array(64)], 'holiday.mp4', { type: 'video/mp4' });
        pick(file);
        await settle();

        submitComposer();
        await settle();

        expect(lounge.uploadAttachment).toHaveBeenCalled();
        const payload = lounge.uploadAttachment.mock.calls[0][0];
        expect(payload.path).toBe(PATH);
        // The two are mutually exclusive by design — main reads `data` only when
        // there is no path, and sending both would defeat the point entirely.
        expect(payload.data).toBeUndefined();
        expect(payload.name).toBe('holiday.mp4');
        expect(payload.type).toBe('video/mp4');
    });

    it('still sends the bytes for something that was never on disk', async () => {
        // A pasted screenshot / a recorded clip: getPathForFile answers '', and
        // the bytes are all there is.
        const booted = await bootRenderer({ board: boardRouter(), pathForFile: () => '' });
        const file = new window.File([new Uint8Array(8)], 'pasted.png', { type: 'image/png' });
        pick(file);
        await settle();

        submitComposer();
        await settle();

        const payload = booted.lounge.uploadAttachment.mock.calls[0][0];
        expect(payload.path).toBeFalsy();
        expect(payload.data).toBeDefined();
    });
});
