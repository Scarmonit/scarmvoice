// Load the main-process modules the way Electron does: through Node's CommonJS
// registry.
//
// This matters because the modules require() each other — net.js does
// `require('./store')`. Importing store.js as ESM from a test would hand the
// test one instance while net.js quietly used another, so a session written by
// the test would be invisible to the code under test.
//
// They also hold state at module scope (settings cache, session cookie, D1
// bookmark), so resetMainModules() clears the cache between tests.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN_DIR = path.resolve(here, '..', '..', 'src', 'main');

export function resetMainModules() {
    for (const key of Object.keys(require_.cache)) {
        if (key.startsWith(MAIN_DIR)) delete require_.cache[key];
    }
}

export function loadMain(name) {
    return require_(path.join(MAIN_DIR, name));
}
