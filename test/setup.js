// Redirect `require('electron')` to our stub.
//
// The main-process modules are CommonJS, and their require() calls resolve
// through Node's own module machinery — which neither vi.mock() nor Vite's
// alias map can see. Patching _resolveFilename is the one layer that catches
// them all. Without this, `require('electron')` outside an Electron process
// returns the path to the binary, so `const { app } = require('electron')`
// silently yields undefined.
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const STUBS = {
    electron: path.join(here, 'stubs', 'electron.cjs'),
    // rt.js's socket, so half-open connections can be produced on demand.
    ws: path.join(here, 'stubs', 'ws.cjs'),
    // updater.js's feed. The real one talks to GitHub and, on quitAndInstall,
    // launches an installer and kills the process — so "did it decide to
    // install, and when" is only testable against a stand-in.
    'electron-updater': path.join(here, 'stubs', 'electron-updater.cjs')
};

// jsdom implements no scrolling at all, and the renderer scrolls in ordinary
// paths (jumpToLatest uses Element.scrollTo). Absent, those throw into vitest's
// unhandled-error trap — tests still pass, but they pass alongside an exception,
// which is exactly how a real one goes unnoticed. Per-environment, so the
// main-process files that share this setup are untouched.
if (typeof Element !== 'undefined' && Element.prototype) {
    const noop = () => {};
    Element.prototype.scrollTo = Element.prototype.scrollTo || noop;
    Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || noop;
}

// The message box is a CodeMirror instance, and CodeMirror measures. jsdom
// implements Range but not its geometry, so the editor's very first layout pass
// (hasBadBidiRects, which asks a Range how wide one character is) throws before
// the document these specs actually drive has been touched.
//
// A zero rect is the honest answer here: jsdom lays nothing out, so every
// measurement is zero already. Nothing in this suite asserts on composer
// geometry — that is checked in a real browser, where the numbers are real.
if (typeof Range !== 'undefined' && Range.prototype) {
    const zeroRect = () => ({
        x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0,
        toJSON() { return this; }
    });
    Range.prototype.getBoundingClientRect = Range.prototype.getBoundingClientRect || zeroRect;
    Range.prototype.getClientRects = Range.prototype.getClientRects ||
        function () { return Object.assign([], { item: () => null }); };
}

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (STUBS[request]) return STUBS[request];
    return originalResolve.call(this, request, ...rest);
};
