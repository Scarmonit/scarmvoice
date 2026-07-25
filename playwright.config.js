// End-to-end tests that launch the real app.
//
// Kept separate from the Vitest suite: these specs are `.spec.js` under
// test/e2e, while Vitest only collects `test/**/*.test.js`, so neither runner
// picks up the other's files.
//
// workers: 1 — every spec drives one real Electron process with a native
// keyboard hook. Running them concurrently would have two instances fighting
// over it.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
    testDir: './test/e2e',
    testMatch: '**/*.spec.js',
    fullyParallel: false,
    workers: 1,
    timeout: 30000,
    reporter: [['list']],
    outputDir: 'test-results'
});
