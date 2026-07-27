// ML noise suppression (RNNoise) — the Krisp-style layer Discord users expect.
//
// The browser's own noiseSuppression constraint is a simple spectral filter;
// RNNoise is a small RNN that removes keyboard clatter, fans and hum far more
// convincingly. It runs in an AudioWorklet fed by a getUserMedia patch, so it
// applies to EVERY mic acquisition (voice calls, voice messages, the mic test)
// without the SDK knowing it exists — same pattern voice.js already uses for
// getDisplayMedia.
//
// Loaded before vendor/realtimekit.js so the SDK only ever sees the patched
// getUserMedia. Every failure path falls back to the raw stream: a broken
// enhancer must never cost anyone their microphone.
(function () {
    'use strict';

    let ctx = null;             // dedicated 48 kHz context — RNNoise's native rate
    let workletReady = null;
    let enabled = false;
    let active = 0;             // wrapped streams still alive

    // An AudioContext holds a real audio device open. Left running between calls
    // it kept the render thread (and on some drivers the device itself) awake for
    // the rest of the session, so it goes away with the last wrapped stream.
    function release() {
        active = Math.max(0, active - 1);
        if (active || !ctx) return;
        const dying = ctx;
        ctx = null;
        workletReady = null;    // the module registration dies with the context
        dying.close().catch(() => {});
    }

    function ensureWorklet() {
        if (!ctx) ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
        if (!workletReady) {
            workletReady = ctx.audioWorklet.addModule('vendor/rnnoise-worklet.js')
                .catch((e) => {
                    console.warn('[noise] rnnoise worklet failed to load:', e && e.message);
                    workletReady = null;    // allow a retry on the next acquisition
                    throw e;
                });
        }
        return workletReady;
    }

    async function wrap(raw) {
        try {
            await ensureWorklet();
            if (ctx.state !== 'running') await ctx.resume().catch(() => {});

            const src = ctx.createMediaStreamSource(raw);
            const node = new AudioWorkletNode(ctx, 'scarm-rnnoise', {
                numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1]
            });
            const dest = ctx.createMediaStreamDestination();
            src.connect(node);
            node.connect(dest);

            const track = dest.stream.getAudioTracks()[0];
            const srcTracks = raw.getAudioTracks();
            let done = false;
            active++;
            const cleanup = () => {
                if (done) return;
                done = true;
                // When the teardown came from track.stop() rather than from an
                // 'ended' event, {once} never fired and these would otherwise
                // pile up one set per mic acquisition.
                srcTracks.forEach((t) => { try { t.removeEventListener('ended', cleanup); } catch (e) {} });
                try { node.port.postMessage('close'); } catch (e) {}
                try { src.disconnect(); } catch (e) {}
                try { node.disconnect(); } catch (e) {}
                // The consumer only ever sees the processed track; stopping the
                // REAL mic here is what turns the OS mic indicator off.
                //
                // AUDIO tracks only. This patch wraps every getUserMedia on the
                // page, so a combined {audio, video} capture would have had its
                // still-in-use video track stopped along with the mic.
                raw.getAudioTracks().forEach((t) => { try { t.stop(); } catch (e) {} });
                release();
            };

            const origStop = track.stop.bind(track);
            track.stop = () => { origStop(); cleanup(); };
            // Device unplugged / revoked upstream: tear down rather than
            // feeding the call eternal silence from a dead graph.
            srcTracks.forEach((t) => t.addEventListener('ended', cleanup, { once: true }));

            // The processor reports whether the wasm actually came up. Logging
            // "active" merely because the graph was built meant a suppression
            // that silently passed audio straight through still claimed to be on.
            node.port.onmessage = (ev) => {
                const d = ev && ev.data;
                if (!d || !d.t) return;
                if (d.t === 'ready') console.info('[noise] rnnoise active on mic capture');
                else if (d.t === 'failed') {
                    console.warn('[noise] rnnoise did NOT start (' + (d.why || 'unknown') +
                        ') — the mic is passing through unprocessed');
                }
            };

            const out = new MediaStream([track]);
            raw.getVideoTracks().forEach((t) => out.addTrack(t));
            return out;
        } catch (e) {
            console.warn('[noise] suppression unavailable, using the raw mic:', e && e.message);
            return raw;
        }
    }

    (function patchGUM() {
        const md = navigator.mediaDevices;
        if (!md || !md.getUserMedia || md.__scarmNoiseWrapped) return;
        const orig = md.getUserMedia.bind(md);
        md.getUserMedia = async function (constraints) {
            const stream = await orig(constraints);
            if (!enabled) return stream;
            if (!constraints || !constraints.audio) return stream;
            if (!stream.getAudioTracks().length) return stream;
            return wrap(stream);
        };
        md.__scarmNoiseWrapped = true;
    })();

    window.ScarmNoise = {
        setEnabled(v) { enabled = !!v; },
        isEnabled() { return enabled; }
    };
})();
