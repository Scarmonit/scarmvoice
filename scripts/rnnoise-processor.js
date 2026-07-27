// AudioWorklet processor half of the vendored rnnoise-worklet.js — appended
// after the emscripten glue by vendor-rnnoise.js. Runs on the audio thread.
//
// RNNoise processes exactly 480 samples at 48 kHz per frame (10 ms), while the
// render quantum is 128 samples, so both directions go through small buffers.
// That costs one frame (~10 ms) of added latency, which is well under anything
// a voice call notices.
/* global createRNNWasmModuleSync, AudioWorkletProcessor, registerProcessor */
(function () {
    'use strict';

    const FRAME = 480;

    class ScarmRnnoiseProcessor extends AudioWorkletProcessor {
        constructor() {
            super();
            this.ready = false;
            this.failed = false;
            this.closed = false;
            this.inBuf = new Float32Array(FRAME);
            this.inLen = 0;
            this.outQueue = [];
            this.outFrame = null;
            this.outPos = 0;

            // Report the outcome back to noise.js. Without this the main thread
            // logged "rnnoise active" purely because the graph was built, so a
            // wasm that never compiled looked identical to one that worked —
            // suppression could be completely inert and nothing said so.
            const announce = (ok, why) => {
                try { this.port.postMessage({ t: ok ? 'ready' : 'failed', why: why || '' }); } catch (e) {}
            };
            const boot = (m) => {
                try {
                    this.wasm = m;
                    this.state = m._rnnoise_create(0);
                    this.ptr = m._malloc(FRAME * 4);
                    this.ready = true;
                    announce(true);
                } catch (e) {
                    this.failed = true;
                    announce(false, (e && e.message) || 'rnnoise_create failed');
                }
            };
            const bootFailed = (e) => {
                this.failed = true;
                announce(false, (e && e.message) || 'wasm module failed to load');
            };
            try {
                // The sync build compiles at import time; the factory returns the
                // module (sometimes promise-shaped, depending on emscripten
                // version), so accept both.
                const mod = createRNNWasmModuleSync();
                if (mod && typeof mod.then === 'function') mod.then(boot, bootFailed);
                else if (mod && !mod._rnnoise_create && mod.ready && typeof mod.ready.then === 'function') {
                    mod.ready.then(boot, bootFailed);
                } else boot(mod);
            } catch (e) {
                bootFailed(e);
            }

            this.port.onmessage = (ev) => {
                if (ev.data !== 'close') return;
                this.closed = true;
                try {
                    if (this.state) this.wasm._rnnoise_destroy(this.state);
                    if (this.ptr) this.wasm._free(this.ptr);
                } catch (e) { /* the graph is going away regardless */ }
                this.state = 0;
                this.ptr = 0;
            };
        }

        process(inputs, outputs) {
            if (this.closed) return false;
            const input = inputs[0] && inputs[0][0];
            const output = outputs[0] && outputs[0][0];
            if (!output) return true;

            // Not ready (still compiling) or wasm failed: pass audio through
            // untouched rather than going silent — a broken enhancer must never
            // cost the user their mic.
            if (!input || this.failed || !this.ready) {
                if (input) output.set(input);
                else output.fill(0);
                return true;
            }

            let i = 0;
            while (i < input.length) {
                const take = Math.min(FRAME - this.inLen, input.length - i);
                this.inBuf.set(input.subarray(i, i + take), this.inLen);
                this.inLen += take;
                i += take;
                if (this.inLen === FRAME) {
                    // RNNoise wants 16-bit-range floats. Re-read HEAPF32 each
                    // frame: wasm memory growth detaches the old view.
                    const off = this.ptr >> 2;
                    let heap = this.wasm.HEAPF32;
                    for (let j = 0; j < FRAME; j++) heap[off + j] = this.inBuf[j] * 32768;
                    this.wasm._rnnoise_process_frame(this.state, this.ptr, this.ptr);
                    heap = this.wasm.HEAPF32;
                    const out = new Float32Array(FRAME);
                    for (let j = 0; j < FRAME; j++) {
                        const v = heap[off + j] / 32768;
                        out[j] = v > 1 ? 1 : (v < -1 ? -1 : v);
                    }
                    this.outQueue.push(out);
                    this.inLen = 0;
                }
            }

            for (let o = 0; o < output.length; o++) {
                if (!this.outFrame) {
                    if (!this.outQueue.length) { output[o] = 0; continue; }
                    this.outFrame = this.outQueue.shift();
                    this.outPos = 0;
                }
                output[o] = this.outFrame[this.outPos++];
                if (this.outPos >= this.outFrame.length) this.outFrame = null;
            }
            return true;
        }
    }

    registerProcessor('scarm-rnnoise', ScarmRnnoiseProcessor);
})();
