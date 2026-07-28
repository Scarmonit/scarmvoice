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

    // A failure has to reach the UI, not just the console. voice.js turns the
    // browser's OWN noiseSuppression constraint off while this is enabled
    // ("RNNoise owns it"), so a broken RNNoise leaves the microphone with no
    // suppression whatsoever — strictly worse than never switching it on. The
    // owner of the toggle is the only code that can undo that, so it gets told.
    let broken = false;
    let failureCb = null;

    function markBroken(why) {
        if (broken) return;     // one report per enable, not one per acquisition
        broken = true;
        // The report is a courtesy; a listener that throws must not take the
        // caller's fall-back-to-the-raw-stream path down with it.
        try { if (failureCb) failureCb(why || 'unknown'); } catch (e) {}
    }

    // An AudioContext holds a real audio device open, so it must not be left
    // RUNNING between calls — it kept the render thread (and on some drivers the
    // device itself) awake for the rest of the session.
    //
    // But it used to be CLOSED, and closing it threw away the worklet module
    // with it. That module is 1.9 MB of JavaScript wrapping a WebAssembly build
    // of RNNoise, and it sits directly in front of the microphone: every
    // getUserMedia awaits addModule() before it can return a stream, and joining
    // a call acquires the microphone. So every join after the first re-fetched,
    // re-parsed and re-compiled the whole thing while the user watched a
    // spinner — a cost measured in hundreds of milliseconds, paid again on every
    // single join.
    //
    // Suspending parks the audio thread just as effectively and keeps the
    // registration, so the next acquisition is a resume() rather than a rebuild.
    function release() {
        active = Math.max(0, active - 1);
        if (active || !ctx) return;
        ctx.suspend().catch(() => {});
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

    // Build the expensive half AHEAD of the microphone.
    //
    // Nothing here acquires audio: it creates the context and compiles the
    // module, which is the part that costs. Called when somebody looks like they
    // are about to join, so the load happens in the seconds before the click
    // rather than inside it — see the warm-up in app.js.
    function warm() {
        if (!enabled) return Promise.resolve(false);
        try {
            return ensureWorklet().then(() => true, () => false);
        } catch (e) {
            return Promise.resolve(false);
        }
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
                if (d.t === 'ready') {
                    broken = false;
                    console.info('[noise] rnnoise active on mic capture');
                } else if (d.t === 'failed') {
                    console.warn('[noise] rnnoise did NOT start (' + (d.why || 'unknown') +
                        ') — the mic is passing through unprocessed');
                    markBroken(d.why);
                }
            };

            const out = new MediaStream([track]);
            raw.getVideoTracks().forEach((t) => out.addTrack(t));
            return out;
        } catch (e) {
            console.warn('[noise] suppression unavailable, using the raw mic:', e && e.message);
            markBroken(e && e.message);
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
        setEnabled(v) {
            enabled = !!v;
            // Switching it back on is the user asking for another go, so a
            // failure from an earlier session must not permanently suppress the
            // next report — nor make isWorking() lie about a fresh attempt.
            if (enabled) broken = false;
        },
        isEnabled() { return enabled; },
        // Compile the model before it is needed. Safe to call repeatedly — the
        // module registration is cached on the context.
        warm,
        // "Enabled" is what the user asked for; this is what they are actually
        // getting. Optimistic until an acquisition proves otherwise.
        isWorking() { return enabled && !broken; },
        // Called with the reason the first time suppression fails while
        // enabled. The listener's job is to put the browser's own suppression
        // back — audio itself is never at risk, the raw mic is always returned.
        onFailure(cb) { failureCb = typeof cb === 'function' ? cb : null; }
    };
})();
