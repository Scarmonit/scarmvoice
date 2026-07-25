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
    ws: path.join(here, 'stubs', 'ws.cjs')
};

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (STUBS[request]) return STUBS[request];
    return originalResolve.call(this, request, ...rest);
};
