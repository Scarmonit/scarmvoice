// Soundboard — clips that everyone in the call hears, not just you.
//
// THE HARD PART is that last clause. Playing a clip through the speakers only
// reaches the person who pressed the button; for it to reach the call it has to
// be mixed into the OUTGOING microphone track. There is no API for "add another
// audio track to the call" that survives the SFU, so the mic acquisition itself
// is wrapped: getUserMedia's stream is summed with a soundboard bus and the sum
// is what gets published.
//
// This is the same patch-getUserMedia trick noise.js uses, and the ordering is
// deliberate. noise.js is loaded FIRST, so its patch is the inner one and the
// stream reaching us here is already denoised — which is what we want, because
// RNNoise is a speech model and running a vine boom through it would mangle it.
// Load order in index.html is therefore load-bearing: noise.js, then this.
//
// The mixing hop costs one extra MediaStreamSource→MediaStreamDestination
// round-trip on every mic acquisition, whether or not a clip is ever played.
// That is a real cost and it is accepted on purpose: the alternative is
// republishing the mic track the first time someone hits a sound, which drops
// audio mid-sentence for everyone in the room. The app already round-trips the
// mic through RNNoise's worklet, so this is the same class of cost the pipeline
// already pays.
//
// Everything degrades to silence rather than to a broken microphone: if any
// part of the mix fails, the ORIGINAL stream is returned untouched. A soundboard
// is a toy; a microphone is not.
(function () {
    'use strict';

    // Shipped with the website at /assets/audio/<name>.mp3 and fetched from
    // there rather than bundled: they are already deployed, already cached by
    // the browser half of the same product, and adding ~15 MB of mp3 to every
    // differential update to save one request would be a poor trade.
    const SOUNDS = [
        { id: 'airhorn', label: 'Airhorn' },
        { id: 'applause', label: 'Applause' },
        { id: 'bruh', label: 'Bruh' },
        { id: 'vine-boom', label: 'Vine boom' },
        { id: 'boowomp', label: 'Boo womp' },
        { id: 'sad-trombone', label: 'Sad trombone' },
        { id: 'womp-womp', label: 'Womp womp' },
        { id: 'oof', label: 'Oof' },
        { id: 'minecraft-oof', label: 'Minecraft oof' },
        { id: 'bonk', label: 'Bonk' },
        { id: 'nope', label: 'Nope' },
        { id: 'sheesh', label: 'Sheesh' },
        { id: 'nice', label: 'Nice' },
        { id: 'noice', label: 'Noice' },
        { id: 'yeet', label: 'Yeet' },
        { id: 'huh', label: 'Huh' },
        { id: 'crickets', label: 'Crickets' },
        { id: 'record-scratch', label: 'Record scratch' },
        { id: 'evil-laugh', label: 'Evil laugh' },
        { id: 'wilhelm', label: 'Wilhelm scream' },
        { id: 'emotional-damage', label: 'Emotional damage' },
        { id: 'triggered', label: 'Triggered' },
        { id: 'gta-wasted', label: 'Wasted' },
        { id: 'mission-passed', label: 'Mission passed' },
        { id: 'game-over', label: 'Game over' },
        { id: 'windows-xp', label: 'Windows XP' },
        { id: 'discord', label: 'Discord ping' },
        { id: 'ding', label: 'Ding' },
        { id: 'gong', label: 'Gong' },
        { id: 'siren', label: 'Siren' },
        { id: 'suspense', label: 'Suspense' },
        { id: 'yay', label: 'Yay' }
    ];

    // A clip longer than this is almost always a mistake (a whole song dropped
    // into the call), and there is no way to stop one mid-play from another
    // client. stopAll() exists for the local case.
    const MAX_SECONDS = 12;

    let baseUrl = '';
    let volume = 0.8;

    // ---- microphone gain ----------------------------------------------------
    // This lives here, in the soundboard, for one reason: mix() below is already
    // the place that takes the raw microphone apart and puts it back together
    // (source -> destination) on every acquisition. Inserting the gain into that
    // existing hop costs nothing; a second getUserMedia patch just to hold one
    // GainNode would add another round trip to every mic open for everybody,
    // including the people who never touch the slider.
    //
    // It is applied BEFORE publishing, so it is how loud everyone else hears
    // you — not a local monitor level.
    let micGain = 1;
    const liveMicGains = new Set();

    // The bus every clip connects to, and the thing mixed into the mic. Created
    // lazily so a session that never plays a sound never builds any of it.
    let bus = null;
    let playing = new Set();

    function ctx() {
        return window.ScarmAudio ? window.ScarmAudio.context() : null;
    }

    function busNode() {
        const c = ctx();
        if (!c) return null;
        if (bus && bus.context === c) return bus;
        bus = c.createGain();
        bus.gain.value = 1;         // per-clip gain does the volume; this is the tap point
        return bus;
    }

    function urlFor(id) {
        const base = String(baseUrl || 'https://scarmonit.com').replace(/\/+$/, '');
        return base + '/assets/audio/' + encodeURIComponent(id) + '.mp3';
    }

    // Decoded clips, kept for the session. These are tens of kilobytes each and
    // decoding on every press is audibly late the first time.
    const cache = new Map();

    async function buffer(id) {
        if (cache.has(id)) return cache.get(id);
        const c = ctx();
        if (!c) return null;
        const p = (async () => {
            const res = await fetch(urlFor(id));
            if (!res.ok) throw new Error('http ' + res.status);
            return await c.decodeAudioData(await res.arrayBuffer());
        })();
        // Cache the PROMISE, so two fast presses share one fetch. A failure
        // evicts, so a sound that failed once (offline) can be retried.
        cache.set(id, p);
        p.catch(() => cache.delete(id));
        return p;
    }

    // ---- the getUserMedia mix ----------------------------------------------

    function mix(raw) {
        const c = ctx();
        const b = busNode();
        if (!c || !b) return raw;
        try {
            const src = c.createMediaStreamSource(raw);
            const dest = c.createMediaStreamDestination();
            // mic -> gain -> destination, with the soundboard bus joining at the
            // destination so clips are NOT scaled by the speaker's input volume.
            const gain = c.createGain();
            gain.gain.value = micGain;
            src.connect(gain);
            gain.connect(dest);
            liveMicGains.add(gain);
            b.connect(dest);

            const track = dest.stream.getAudioTracks()[0];
            if (!track) return raw;

            const srcTracks = raw.getAudioTracks();
            // Same as noise.js: the mix is still that microphone's audio, and
            // the id is what every "is this already the right device?" check
            // downstream compares against.
            if (window.ScarmLib && window.ScarmLib.inheritDeviceId) {
                window.ScarmLib.inheritDeviceId(track, srcTracks);
            }
            let done = false;
            const origStop = track.stop.bind(track);
            // Same contract as noise.js: `fromEnded` means the SOURCE died, and
            // only then may the track we handed out be ended — ending it is what
            // makes the SDK reacquire, and doing that on a deliberate stop would
            // reopen a microphone the app had just released.
            const onSourceEnded = () => cleanup(true);
            const cleanup = (fromEnded) => {
                if (done) return;
                done = true;
                srcTracks.forEach((t) => { try { t.removeEventListener('ended', onSourceEnded); } catch (e) {} });
                liveMicGains.delete(gain);
                try { gain.disconnect(); } catch (e) {}
                try { src.disconnect(); } catch (e) {}
                // ONLY this destination. The bus is shared with every other
                // live acquisition and with the local monitor, so
                // b.disconnect() with no argument would silence them all.
                try { b.disconnect(dest); } catch (e) {}
                // The consumer only ever sees the mixed track, so stopping the
                // real mic here is what releases the device.
                srcTracks.forEach((t) => { try { t.stop(); } catch (e) {} });

                // A MediaStreamAudioDestinationNode track never ends on its own
                // — disconnecting its inputs leaves it 'live' and silent — so
                // without this the consumer went on encoding silence after the
                // microphone was gone, with nothing on screen to say so.
                if (fromEnded) {
                    try { origStop(); } catch (e) {}
                    try { track.dispatchEvent(new Event('ended')); } catch (e) {}
                    try { window.dispatchEvent(new CustomEvent('scarm:miclost')); } catch (e) {}
                }
            };
            srcTracks.forEach((t) => t.addEventListener('ended', onSourceEnded, { once: true }));
            track.stop = function () { cleanup(false); origStop(); };

            // Video rides along untouched — a getUserMedia asking for both must
            // not lose its camera to the audio path.
            const out = new MediaStream([track].concat(raw.getVideoTracks()));
            return out;
        } catch (e) {
            console.warn('[soundboard] could not mix into the mic:', e && e.message);
            return raw;
        }
    }

    (function patchGUM() {
        const md = navigator.mediaDevices;
        if (!md || !md.getUserMedia || md.__scarmBoardWrapped) return;
        const orig = md.getUserMedia.bind(md);
        md.getUserMedia = async function (constraints) {
            const stream = await orig(constraints);
            if (!constraints || !constraints.audio) return stream;
            if (!stream.getAudioTracks().length) return stream;
            return mix(stream);
        };
        md.__scarmBoardWrapped = true;
    })();

    // ---- playback -----------------------------------------------------------

    async function play(id) {
        const c = ctx();
        if (!c) return false;
        if (window.ScarmAudio && window.ScarmAudio.resume) {
            try { await window.ScarmAudio.resume(); } catch (e) {}
        }

        let buf;
        try { buf = await buffer(id); } catch (e) {
            console.warn('[soundboard] could not load', id, e && e.message);
            return false;
        }
        if (!buf) return false;
        if (buf.duration > MAX_SECONDS) {
            console.warn('[soundboard]', id, 'is longer than', MAX_SECONDS, 's — not playing');
            return false;
        }

        const b = busNode();
        const src = c.createBufferSource();
        src.buffer = buf;

        const g = c.createGain();
        g.gain.value = volume;
        src.connect(g);

        // Two taps, on purpose: the bus is what the call hears, c.destination is
        // what YOU hear. Without the second one the presser is the only person
        // in the room who cannot hear what they just played.
        if (b) g.connect(b);
        g.connect(c.destination);

        const rec = { src, g };
        playing.add(rec);
        src.onended = () => {
            playing.delete(rec);
            try { g.disconnect(); } catch (e) {}
            try { src.disconnect(); } catch (e) {}
        };
        try { src.start(); } catch (e) { playing.delete(rec); return false; }
        return true;
    }

    function stopAll() {
        playing.forEach((rec) => { try { rec.src.stop(); } catch (e) {} });
        playing.clear();
    }

    // The microphone half of this module, kept under its own name so nothing
    // has to know the two share a graph.
    window.ScarmMic = {
        setGain(v) {
            const n = Number(v);
            micGain = Number.isFinite(n) ? Math.max(0, Math.min(2, n)) : 1;
            // Live acquisitions are updated in place: changing this mid-call
            // must not mean republishing the track, which drops audio for
            // everyone in the room.
            liveMicGains.forEach((g) => { try { g.gain.value = micGain; } catch (e) {} });
        },
        getGain: () => micGain
    };

    window.ScarmBoard = {
        sounds: () => SOUNDS.slice(),
        setBaseUrl(v) { baseUrl = v || ''; },
        setVolume(v) {
            const n = Number(v);
            volume = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.8;
        },
        getVolume: () => volume,
        play,
        stopAll
    };
})();
