// Builds src/renderer/vendor/rnnoise-worklet.js: the @jitsi/rnnoise-wasm
// SINGLE_FILE sync build (wasm embedded as base64, compiled synchronously —
// exactly what an AudioWorklet needs, since worklets can neither fetch nor
// importScripts) concatenated with our processor.
//
// Same pattern as vendor-sdk.js: runs at postinstall, output is committed to
// nothing — vendor/ is gitignored and rebuilt from node_modules every install.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'node_modules', '@jitsi', 'rnnoise-wasm', 'dist', 'rnnoise-sync.js');
const OUT_DIR = path.join(__dirname, '..', 'src', 'renderer', 'vendor');
const OUT = path.join(OUT_DIR, 'rnnoise-worklet.js');
const PROCESSOR = path.join(__dirname, 'rnnoise-processor.js');

function main() {
    if (!fs.existsSync(SRC)) {
        console.error('[vendor-rnnoise] @jitsi/rnnoise-wasm is not installed — run npm install');
        process.exit(1);
    }
    let glue = fs.readFileSync(SRC, 'utf8');
    // The dist file is an ES module; a worklet module is too, but we inline the
    // factory instead of re-exporting it so the processor below can close over it.
    glue = glue.replace(/export default createRNNWasmModuleSync;?\s*$/, '');
    // import.meta is only legal in true ES modules. addModule() does load this
    // file as one, but the emscripten reference is inside a plain function and
    // only used for URL resolution we never hit (SINGLE_FILE embeds the wasm).
    glue = glue.replace('import.meta.url', '"file:///rnnoise-sync.js"');

    const processor = fs.readFileSync(PROCESSOR, 'utf8');
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT, glue + '\n' + processor);
    console.log('[vendor-rnnoise] wrote ' + OUT + ' (' + fs.statSync(OUT).size + ' bytes)');
}

main();
