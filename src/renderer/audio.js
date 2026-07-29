// The renderer's single AudioContext, plus the one timer that drives every
// level meter in the app.
//
// WHY THIS EXISTS: Chromium caps a page at six concurrent AudioContexts. The
// code used to create one per participant for speaking detection, another per
// participant boosted above 100%, one for the microphone test, and one for the
// notification chime. In a call with four other people the seventh constructor
// call throws — and because the failure was caught and ignored, the symptom was
// simply that the speaking indicator stopped working for whoever joined last,
// with nothing in the console to explain it. One context has no such limit:
// analysers and gain nodes are cheap, contexts are not.
//
// The second job here is the tick loop. Each meter used to run its own
// requestAnimationFrame at 60 Hz. For a speaking dot that is roughly ten times
// more often than anyone can perceive, so all meters now share a single 20 Hz
// interval — which also keeps running when the window is hidden, where rAF is
// throttled to a stop.
(function () {
    'use strict';

    const TICK_MS = 50;             // 20 Hz — smooth enough for a dot or a bar
    // 2048 samples is ~43 ms at 48 kHz, so each reading covers nearly the whole
    // 50 ms between ticks. At 512 it covered 11 ms — a fifth of the interval —
    // so a tick that happened to land between two syllables read almost
    // nothing, and the speaking indicator dropped out mid-sentence.
    const FFT_SIZE = 2048;

    // How fast a level falls once the sound does. Applied per tick, so 0.72 is
    // a ~150 ms decay: fast enough to feel live, slow enough that the gaps
    // inside ordinary speech do not read as silence.
    const RELEASE = 0.72;

    // Speech is PEAKY — its peaks run 3-5x its RMS — where room tone, a fan or
    // a hum is comparatively flat. Testing the peak against a proportionally
    // higher bar therefore catches quiet speech that an RMS test misses without
    // simply lowering the bar for everything.
    const CREST = 3;

    let ctx = null;
    let sinkId = '';
    const meters = new Set();
    const tickers = new Set();
    let timer = null;

    // Created on first use rather than at load, so a session that never plays a
    // sound or joins a call never opens an audio device at all.
    function context() {
        if (ctx) return ctx;
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        try {
            ctx = new AC();
        } catch (e) {
            console.error('[audio] could not create the AudioContext:', e.message);
            return null;
        }
        applySink();
        return ctx;
    }

    // Route everything this context plays to the chosen output device. Without
    // this, per-user volume boosts (which have to go through a GainNode, because
    // HTMLMediaElement.volume caps at 1) ignored the speaker selection entirely
    // and came out of the system default.
    // '' is a REAL sinkId — it means "the system default device" — and it is
    // exactly what "Windows Default" writes. Treating it as "nothing to do"
    // meant that once a specific device had been picked there was no way back:
    // the context stayed pinned to it while the UI claimed otherwise.
    function applySink() {
        if (!ctx || typeof ctx.setSinkId !== 'function') return;
        Promise.resolve(ctx.setSinkId(sinkId || '')).catch((e) => {
            console.warn('[audio] setSinkId failed:', e && e.message);
        });
    }

    function setSinkId(id) {
        sinkId = id || '';
        applySink();
    }

    // Chromium still suspends a context created without a user gesture in some
    // states; resume() is cheap and idempotent.
    function resume() {
        const c = context();
        if (!c || c.state === 'running') return Promise.resolve(!!c);
        return Promise.resolve(c.resume()).then(() => c.state === 'running').catch(() => false);
    }

    // ---- the shared tick -------------------------------------------------

    // Everything on this tick drives something you can SEE — speaking dots and
    // the mic-test bar. With backgroundThrottling disabled on the window (so the
    // presence heartbeat survives the tray), Chromium does not throttle this for
    // us, so a five-person call minimised to the tray kept running 20 Hz × 5
    // analysers — a 512-sample RMS loop each — to animate indicators on a window
    // nobody is looking at. Suspending while hidden is free: the first tick
    // after the window comes back re-reads live levels within 50 ms.
    //
    // That was written against `document.hidden`, which NEVER BECOMES TRUE in
    // this app: backgroundThrottling:false freezes it at false through both a
    // tray hide and a minimize, and visibilitychange never fires (verified in
    // this Electron build). So the loop above has been running the whole time.
    // The main process is the only thing that knows, and it now says so —
    // app.js forwards win:hidden here.
    let hidden = false;

    function shouldRun() {
        return (meters.size || tickers.size) && !hidden;
    }

    function setHidden(h) {
        hidden = !!h;
        if (hidden) stopTimer(); else ensureTimer();
    }

    function ensureTimer() {
        if (timer || !shouldRun()) return;
        timer = setInterval(() => {
            meters.forEach((m) => m.sample());
            tickers.forEach((fn) => {
                try { fn(); } catch (e) { console.error('[audio] ticker threw:', e); }
            });
            if (!shouldRun()) stopTimer();
        }, TICK_MS);
    }

    function stopTimer() {
        if (!timer) return;
        clearInterval(timer);
        timer = null;
    }

    // Run `fn` on the shared tick. Returns an unsubscribe function.
    function onTick(fn) {
        if (typeof fn !== 'function') return () => {};
        tickers.add(fn);
        ensureTimer();
        return () => { tickers.delete(fn); if (!meters.size && !tickers.size) stopTimer(); };
    }

    // ---- level meters ----------------------------------------------------

    // A meter taps a stream and exposes its current RMS. The analyser is
    // deliberately NOT connected to the destination — this is measurement only,
    // and connecting it would play the stream a second time.
    function createMeter(stream) {
        const c = context();
        if (!c || !stream) return null;

        let src, analyser;
        try {
            src = c.createMediaStreamSource(stream);
            analyser = c.createAnalyser();
            analyser.fftSize = FFT_SIZE;
            analyser.smoothingTimeConstant = 0.5;
            src.connect(analyser);
        } catch (e) {
            console.warn('[audio] could not meter that stream:', e.message);
            return null;
        }

        // FLOAT samples, not bytes. getByteTimeDomainData quantises to 1/128,
        // so at the level ordinary speech actually reaches with AGC off — an
        // RMS around 0.02-0.04 — the signal was only three to five quantisation
        // steps tall and the measurement noise was a large fraction of it.
        const data = new Float32Array(analyser.fftSize);
        const meter = {
            level: 0,        // this reading
            envLevel: 0,     // fast attack, slow release
            peakLevel: 0,
            sample() {
                analyser.getFloatTimeDomainData(data);
                let sum = 0;
                let peak = 0;
                for (let i = 0; i < data.length; i++) {
                    const v = data[i];
                    sum += v * v;
                    const a = v < 0 ? -v : v;
                    if (a > peak) peak = a;
                }
                const rms = Math.sqrt(sum / data.length);
                meter.level = rms;
                meter.peakLevel = peak;
                // Rises instantly, falls gently — the shape an indicator wants.
                meter.envLevel = rms > meter.envLevel
                    ? rms
                    : meter.envLevel * RELEASE + rms * (1 - RELEASE);
            },
            rms() { return meter.level; },
            envelope() { return meter.envLevel; },
            peak() { return meter.peakLevel; },
            // THE definition of "this is speech", in one place. Both the live
            // indicator and the Settings mic-test meter ask this, so the meter
            // in Settings cannot promise something the indicator then fails to
            // do — which is what makes the threshold slider calibratable at all.
            isSpeech(threshold) {
                const t = Number(threshold) > 0 ? Number(threshold) : 0;
                return meter.envLevel > t || meter.peakLevel > t * CREST;
            },
            stop() {
                meters.delete(meter);
                try { src.disconnect(); } catch (e) {}
                try { analyser.disconnect(); } catch (e) {}
                if (!meters.size && !tickers.size) stopTimer();
            }
        };
        meters.add(meter);
        ensureTimer();
        return meter;
    }

    // ---- gain (volume boost above 100%) ----------------------------------

    // Routes a stream through a GainNode to the shared destination, for the
    // per-participant volumes that go past what an <audio> element can do.
    function createGain(stream, value) {
        const c = context();
        if (!c || !stream) return null;
        try {
            const src = c.createMediaStreamSource(stream);
            const gain = c.createGain();
            gain.gain.value = Number(value) || 1;
            src.connect(gain);
            gain.connect(c.destination);
            return {
                set(v) { gain.gain.value = Math.max(0, Number(v) || 0); },
                stop() {
                    try { src.disconnect(); } catch (e) {}
                    try { gain.disconnect(); } catch (e) {}
                }
            };
        } catch (e) {
            console.warn('[audio] could not build the boost graph:', e.message);
            return null;
        }
    }

    // Diagnostics: how close are we to the limit that used to break this?
    function stats() {
        return {
            context: ctx ? ctx.state : 'none',
            sinkId: sinkId || 'default',
            meters: meters.size,
            tickers: tickers.size,
            ticking: !!timer
        };
    }

    window.ScarmAudio = { context, resume, setSinkId, createMeter, createGain, onTick, setHidden, stats, TICK_MS };
})();
