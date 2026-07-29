// The RNNoise worklet on disk has to match the processor it is generated from.
//
// src/renderer/vendor/rnnoise-worklet.js is BUILT — scripts/vendor-rnnoise.js
// concatenates the wasm glue with scripts/rnnoise-processor.js — and vendor/ is
// gitignored, so what ships is whatever the last generator run left behind. That
// generator used to run only at `npm install`, and never as part of `npm run
// build`/`dist`/`release`.
//
// So v0.54.1 shipped a worklet built from an older processor: the one WITHOUT
// the ready/failed reporting. The consequence is not cosmetic. noise.js decides
// whether RNNoise is actually running from the `{t:'failed'}` message the
// processor posts; with an older processor that message never arrives,
// isWorking() keeps answering true, and app.js's onFailure handler never fires —
// while voice.js has already switched Chromium's own noiseSuppression off
// because "RNNoise owns it". A machine where the wasm cannot start therefore ran
// the microphone with NO suppression at all, and the UI said the AI filter was
// on.
//
// `npm run vendor` is part of the build now and preflight-release.js refuses to
// publish a stale one. This is the third guard, and the one that runs on every
// `npm test`.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROCESSOR = path.join(ROOT, 'scripts', 'rnnoise-processor.js');
const WORKLET = path.join(ROOT, 'src', 'renderer', 'vendor', 'rnnoise-worklet.js');

// vendor/ is gitignored, so a fresh clone that has not run postinstall yet has
// no file to check. Skipping is correct there — the release preflight is the
// gate that matters, and failing CI on a missing generated artifact would only
// teach people to ignore this.
const built = fs.existsSync(WORKLET);

describe.skipIf(!built)('the vendored RNNoise worklet', () => {
    it('ends with the current processor source', () => {
        const processor = fs.readFileSync(PROCESSOR, 'utf8');
        const worklet = fs.readFileSync(WORKLET, 'utf8');
        expect(worklet.endsWith(processor)).toBe(true);
    });

    it('carries the failure reporting noise.js depends on', () => {
        // Named explicitly rather than left to the byte comparison above: this
        // is the specific thing whose absence is silent and expensive.
        const worklet = fs.readFileSync(WORKLET, 'utf8');
        expect(worklet).toMatch(/bootFailed/);
        expect(worklet).toMatch(/'failed'|"failed"/);
    });
});
