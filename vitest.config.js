// Unit tests for the main-process modules. Deliberately narrow: only `test/`
// is collected, so nothing under dist/ or node_modules/ can ever be picked up.
//
// The alias swaps the real `electron` package (which, outside an Electron
// process, is just a path string) for a stub exposing the handful of APIs these
// modules use. It's an alias rather than vi.mock() because the sources are
// CommonJS and require() bypasses vi.mock entirely.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default {
    test: {
        environment: 'node',
        include: ['test/**/*.test.js'],
        restoreMocks: true,
        setupFiles: [path.join(here, 'test', 'setup.js')],
        alias: {
            electron: path.join(here, 'test', 'stubs', 'electron.cjs')
        }
    }
};
