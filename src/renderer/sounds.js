// Sound effects — the same assets and trigger rules as the website.
//
// Three sounds, two independent user toggles:
//   • voice-join  / voice-leave  -> settings.voiceSounds
//   • itell-message (new message) -> settings.notificationSound
//
// The message chime decodes through Web Audio so there is no first-play delay,
// exactly like board.js. The browser needs a user gesture to unlock audio; the
// desktop app disables that requirement via the autoplay-policy switch in
// main.js, but the gesture unlock is kept as a belt-and-braces fallback.
(function () {
    'use strict';

    const JOIN_URL = 'sounds/voice-join.ogg';
    const LEAVE_URL = 'sounds/voice-leave.ogg';
    const MESSAGE_URLS = ['sounds/itell-message.ogg', 'sounds/itell-message.mp3'];
    const VOLUME = 0.6;

    // After I join, don't chime for the people who were already in the call —
    // their roster entries all arrive at once. Matches the website.
    const SETTLE_MS = 1500;

    let settings = {};
    let initialized = false;       // init() is re-entered on every board-open
    let ctx = null;
    let messageBuf = null;
    let messageEl = null;          // fallback if Web Audio is unavailable
    let joinEl = null;
    let leaveEl = null;

    function log(msg) { try { console.info('[sound] ' + msg); } catch (e) {} }

    function voiceEnabled() { return settings.voiceSounds !== false; }
    function notifyEnabled() { return settings.notificationSound !== false; }

    // ---- message chime (Web Audio, buffered) -----------------------------

    function loadMessageBuffer(i) {
        if (i >= MESSAGE_URLS.length) { ctx = null; initElementFallback(); return; }
        fetch(MESSAGE_URLS[i])
            .then((r) => { if (!r.ok) throw new Error('http ' + r.status); return r.arrayBuffer(); })
            .then((raw) => new Promise((res, rej) => ctx.decodeAudioData(raw, res, rej)))
            .then((buf) => { messageBuf = buf; log('loaded ' + MESSAGE_URLS[i]); })
            .catch(() => loadMessageBuffer(i + 1));
    }

    function initElementFallback() {
        try {
            const el = document.createElement('audio');
            el.src = (el.canPlayType && el.canPlayType('audio/ogg; codecs="vorbis"'))
                ? MESSAGE_URLS[0] : MESSAGE_URLS[1];
            el.preload = 'auto';
            el.volume = VOLUME;
            el.load();
            messageEl = el;
            log('loaded (element fallback)');
        } catch (e) {}
    }

    function init(initialSettings) {
        settings = Object.assign({}, initialSettings || {});

        // init() runs once per board-open, so signing out and back in calls it
        // again. Everything below is one-time setup; without this the second
        // pass refetched the buffer, rebuilt the chime elements, and added a
        // second pair of capture-phase unlock listeners.
        if (initialized) return;
        initialized = true;

        // The renderer's one shared AudioContext (audio.js) — this used to open
        // its own, which counted against Chromium's six-context page limit for
        // the whole life of the app.
        ctx = window.ScarmAudio ? window.ScarmAudio.context() : null;
        if (ctx) loadMessageBuffer(0); else initElementFallback();

        // Preload the voice chimes as plain elements — they're short and only
        // ever fire while the window has already been interacted with.
        try {
            joinEl = new Audio(JOIN_URL); joinEl.preload = 'auto'; joinEl.volume = VOLUME;
            leaveEl = new Audio(LEAVE_URL); leaveEl.preload = 'auto'; leaveEl.volume = VOLUME;
        } catch (e) {}
        applySink();

        // Fallback unlock, in case the autoplay policy still gates us.
        function unlock() {
            if (ctx && ctx.state !== 'running') {
                window.ScarmAudio.resume().then((running) => {
                    if (running) { log('unlocked'); done(); }
                });
            } else done();
        }
        function done() {
            document.removeEventListener('pointerdown', unlock, true);
            document.removeEventListener('keydown', unlock, true);
        }
        document.addEventListener('pointerdown', unlock, true);
        document.addEventListener('keydown', unlock, true);
    }

    // Send the chimes to the speaker the app is set to, like everything else.
    //
    // The message chime rides the shared AudioContext, which audio.js routes
    // with setSinkId, and every voice element in a call is routed by voice.js —
    // but the join/leave chimes are plain <audio> elements built here and were
    // never routed at all. So somebody listening on headphones heard the call in
    // the headphones and everybody's arrivals and departures out of the desktop
    // speakers, on the same machine, at the same moment.
    //
    // '' is the valid sinkId for "Windows Default" and must be SET rather than
    // skipped — treating it as "nothing to do" is what once made choosing the
    // default speaker a silent no-op once a specific device had been picked.
    function applySink() {
        const id = settings.speakerDeviceId || '';
        [joinEl, leaveEl, messageEl].forEach((el) => {
            if (!el || typeof el.setSinkId !== 'function') return;
            try { Promise.resolve(el.setSinkId(id)).catch(() => {}); } catch (e) {}
        });
    }

    function setSettings(next) {
        settings = Object.assign({}, next || {});
        applySink();
    }

    function playMessage() {
        if (!notifyEnabled()) return;
        try {
            if (ctx && messageBuf) {
                if (ctx.state !== 'running') window.ScarmAudio.resume();
                const src = ctx.createBufferSource();
                const gain = ctx.createGain();
                gain.gain.value = VOLUME;
                src.buffer = messageBuf;
                src.connect(gain);
                gain.connect(ctx.destination);
                src.start(0);
                return;
            }
            if (messageEl) { messageEl.currentTime = 0; const p = messageEl.play(); if (p && p.catch) p.catch(() => {}); }
        } catch (e) { /* never let a sound break the UI */ }
    }

    function playVoice(kind) {
        if (!voiceEnabled()) return;
        const el = (kind === 'leave') ? leaveEl : joinEl;
        if (!el) return;
        try { el.currentTime = 0; const p = el.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
    }

    // ---- join / leave diffing -------------------------------------------
    // Armed only while I'm in the call, so these are never audible to someone
    // who isn't in voice — same guarantee the website makes.

    let armed = false;
    let armAt = 0;
    let prevIds = null;

    function idSet(list) {
        const o = {};
        (list || []).forEach((p) => { if (p && p.id) o[p.id] = 1; });
        return o;
    }

    // Call on every voice roster render. `joined` = am I in the call.
    // `silent` (DND) suppresses playback WITHOUT disarming: folding DND into
    // `joined` made toggling DND off replay your own join chime mid-call.
    function voiceRoster(list, joined, myId, silent) {
        if (!joined) { armed = false; prevIds = null; return; }

        if (!armed) {                       // the first render after I join
            armed = true;
            armAt = Date.now();
            prevIds = idSet(list);
            if (!silent) playVoice('join'); // my own arrival chime
            return;
        }

        const ids = idSet(list);
        if (Date.now() - armAt < SETTLE_MS) { prevIds = ids; return; }

        let joinHit = false, leaveHit = false;
        if (prevIds) {
            for (const a in ids) { if (a !== myId && !prevIds[a]) joinHit = true; }
            for (const b in prevIds) { if (b !== myId && !ids[b]) leaveHit = true; }
        }
        prevIds = ids;
        if (joinHit && !silent) playVoice('join');
        if (leaveHit && !silent) playVoice('leave');
    }

    function reset() { armed = false; prevIds = null; }

    window.loungeSounds = { init, setSettings, playMessage, playVoice, voiceRoster, reset };
})();
