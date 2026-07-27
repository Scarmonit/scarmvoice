// The IPC channel contract between preload.js and main.js.
//
// A typo'd channel name is invisible until a user clicks the one button that
// uses it, and then it fails in production with "No handler registered for
// 'board:uplaod'". Nothing else in the suite would catch it: the preload bridge
// is a plain object of closures, so the name only exists as a string literal on
// both sides.
//
// This reads the two source files and compares the literals — no Electron, no
// app launch, instant.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main');

function channels(file, pattern) {
    const src = fs.readFileSync(path.join(MAIN_DIR, file), 'utf8');
    return new Set(Array.from(src.matchAll(pattern), (m) => m[1]));
}

// Matches both `ipcMain.handle('x', …)` and the bare `handle('x', …)` that
// registerIpc uses — every handler goes through main.js's sender-validating
// wrapper, which registers the real ipcMain listener with a non-literal name.
// Anchored to the start of a line so `protocol.handle('lounge', …)`, which is
// a URL scheme rather than an IPC channel, isn't swept up with them.
const handled = channels('main.js', /^\s*(?:ipcMain\.)?handle\(\s*'([^']+)'/gm);
const invoked = channels('preload.js', /ipcRenderer\.invoke\(\s*'([^']+)'/g);
const subscribed = channels('preload.js', /\bsub\(\s*'([^']+)'/g);
const sent = channels('main.js', /(?:webContents|win\.webContents)\.send\(\s*'([^']+)'/g);

describe('ipcMain.handle <-> ipcRenderer.invoke', () => {
    it('registers a handler for every channel the bridge invokes', () => {
        const missing = [...invoked].filter((c) => !handled.has(c)).sort();
        expect(missing, 'preload invokes channels main.js never handles').toEqual([]);
    });

    it('exposes every handler the main process registers', () => {
        // A handler with no bridge method is unreachable — either dead code or a
        // half-wired feature.
        const unreachable = [...handled].filter((c) => !invoked.has(c)).sort();
        expect(unreachable, 'main.js handles channels the bridge never invokes').toEqual([]);
    });

    it('has a non-trivial number of channels, so the regexes still match', () => {
        // Guards against a refactor (e.g. building channel names dynamically)
        // silently reducing both sides to zero and passing vacuously.
        expect(handled.size).toBeGreaterThan(30);
        expect(invoked.size).toBe(handled.size);
    });
});

describe('main -> renderer events', () => {
    it('has a subscriber for every event the main process pushes', () => {
        const unheard = [...sent].filter((c) => !subscribed.has(c)).sort();
        expect(unheard, 'main.js sends events the bridge never subscribes to').toEqual([]);
    });
});
