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
    // Voice ACTION sounds. mute/unmute/deafen/undeafen are local — only the
    // person doing it hears them. share-start/share-stop reach everyone in the
    // call, but not by being transmitted: every client plays its own copy when
    // it sees the share appear or vanish (voice.js setSharer/clearSharer), so
    // the scope falls out of who receives the event — only call members do.
    const UI_URLS = {
        mute: 'sounds/mute.mp3',
        unmute: 'sounds/unmute.mp3',
        deafen: 'sounds/deafen.mp3',
        undeafen: 'sounds/undeafen.mp3',
        'share-start': 'sounds/share-start.mp3',
        'share-stop': 'sounds/share-stop.mp3'
    };
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
    let uiEls = {};                // action sounds, keyed by UI_URLS kind

    function log(msg) { try { console.info('[sound] ' + msg); } catch (e) {} }

    // The master switch, checked by both. It is deliberately NOT the same thing as
    // Do Not Disturb — that also silences toasts and badges, and this is sounds
    // only — and it leaves the two individual settings alone, so turning it off
    // restores whatever they already were rather than a default.
    function allSilenced() { return !!settings.disableAllSounds; }
    function voiceEnabled() { return !allSilenced() && settings.voiceSounds !== false; }
    function notifyEnabled() { return !allSilenced() && settings.notificationSound !== false; }

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
        // The action sounds, same treatment as the chimes above.
        try {
            Object.keys(UI_URLS).forEach((kind) => {
                const el = new Audio(UI_URLS[kind]);
                el.preload = 'auto'; el.volume = VOLUME;
                uiEls[kind] = el;
            });
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
        [joinEl, leaveEl, messageEl].concat(Object.values(uiEls)).forEach((el) => {
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

    // A voice ACTION — mute, unmute, deafen, undeafen, a share starting or
    // stopping. Behind the same toggle as the join/leave chimes: they are the
    // same kind of sound, and someone who silenced those has answered this
    // question too.
    function playUi(kind) {
        if (!voiceEnabled()) return;
        const el = uiEls[kind];
        if (!el) return;
        try { el.currentTime = 0; const p = el.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
    }

    // ---- spoken join / leave announcements ------------------------------
    // The static "Greetings" / "See ya around" clips are replaced by SPEECH:
    // "<name> has joined the channel" / "<name> has left the channel", where
    // the name is the person's account username — or the custom Greeting /
    // Leaving text they set in Settings, which travels to every peer on the
    // realtime voice roster exactly the way muted and deafened do.
    //
    // speechSynthesis, not a network service: Windows ships the voices, the
    // audio is generated on this machine, and nothing about an announcement
    // leaves it. The one thing it cannot do is setSinkId — announcements play
    // on the system default output device. If speech is unavailable the old
    // chime plays instead: an arrival that makes no sound at all is the
    // regression this feature must never cause.

    function pickTtsVoice() {
        let voices = [];
        try { voices = window.speechSynthesis.getVoices() || []; } catch (e) { return null; }
        if (!voices.length) return null;
        const en = voices.filter((v) => /^en/i.test(v.lang || ''));
        const pool = en.length ? en : voices;
        // Windows names its stock voices after people; these cover every en-*
        // install back to Windows 10. Falls back to the first English voice
        // rather than to silence when the wanted gender is not installed.
        const want = settings.announceVoice === 'male'
            ? /david|mark|guy|james|george|ryan|liam|\bmale\b/i
            : /zira|jenny|aria|eva|hazel|susan|libby|sonia|michelle|\bfemale\b/i;
        return pool.find((v) => want.test(v.name || '')) || pool[0] || null;
    }

    function speakLocal(text) {
        try {
            if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) return false;
            const u = new window.SpeechSynthesisUtterance(text);
            const v = pickTtsVoice();
            if (v) u.voice = v;
            u.volume = 0.9;
            u.rate = 1;
            window.speechSynthesis.speak(u);
            return true;
        } catch (e) { return false; }
    }

    // The NATURAL voice: the board renders the sentence with a neural model
    // (Workers AI) and streams back a small mp3, reached through lounge://tts
    // so the session never leaves the main process. Windows' own speech API
    // only exposes its 1990s SAPI voices to apps, which is the robotic sound
    // this replaces — speakLocal survives as the offline fallback.
    //
    // Playing an <audio> element instead of speechSynthesis also fixes output
    // routing: announcements follow the speaker chosen in Settings now, where
    // speechSynthesis could only ever use the system default.
    //
    // One failure arms a short cooldown so an offline session degrades to the
    // local voice at once instead of paying a network timeout per arrival.
    let naturalDownUntil = 0;

    function speakNatural(text) {
        return new Promise((resolve, reject) => {
            // The lounge:// scheme only exists inside the app shell.
            if (!window.lounge || !window.lounge.fileUrl) { reject(new Error('no shell')); return; }
            if (Date.now() < naturalDownUntil) { reject(new Error('cooling down')); return; }
            let settled = false;
            const done = (ok, why) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (ok) resolve();
                else { naturalDownUntil = Date.now() + 60000; reject(new Error(why)); }
            };
            let el;
            try {
                el = new Audio('lounge://tts/?text=' + encodeURIComponent(text) +
                    '&voice=' + (settings.announceVoice === 'male' ? 'male' : 'female'));
            } catch (e) { done(false, 'no audio'); return; }
            el.volume = 0.9;
            const sink = settings.speakerDeviceId || '';
            if (typeof el.setSinkId === 'function') {
                try { Promise.resolve(el.setSinkId(sink)).catch(() => {}); } catch (e) {}
            }
            el.addEventListener('playing', () => done(true), { once: true });
            el.addEventListener('error', () => done(false, 'stream error'), { once: true });
            // A render is a few hundred ms; four seconds means it is not coming.
            const timer = setTimeout(() => done(false, 'timeout'), 4000);
            const p = el.play();
            if (p && p.catch) p.catch(() => done(false, 'play refused'));
        });
    }

    // One announcement. `who` is the person's custom text when they set one,
    // else the name the roster carries — which the server resolved from their
    // account, not from anything a client typed. Natural voice first, the
    // local engine when the network fails, the old chime when even that is
    // missing — an arrival that makes no sound at all is the one regression
    // this feature must never cause.
    function announce(kind, who, force) {
        if (!force && (!voiceEnabled() || settings.dnd)) return;
        const said = String(who || 'Someone');
        const text = said + (kind === 'leave' ? ' has left the channel' : ' has joined the channel');
        // The fallback is taken SYNCHRONOUSLY when the natural path cannot
        // even be attempted — outside the app shell, or inside the failure
        // cooldown — rather than round-tripping through a rejection.
        if (!window.lounge || !window.lounge.fileUrl || Date.now() < naturalDownUntil) {
            if (!speakLocal(text)) playVoice(kind);
            return;
        }
        speakNatural(text).catch(() => {
            if (!speakLocal(text)) playVoice(kind);
        });
    }

    // My own arrival and departure, called by app.js on the join/leave
    // transition: my roster row races my own join, and by the time I leave the
    // roster is already gone — so both read settings directly. The LEAVER
    // hearing their own leave announcement is deliberate.
    function announceSelf(kind, username) {
        const custom = kind === 'leave' ? settings.farewellText : settings.greetText;
        announce(kind, String(custom || '').trim() || username);
    }

    // The settings panel's preview: always audible — the click IS the request,
    // whatever the sound toggles say.
    function previewAnnounce(kind, username) {
        const custom = kind === 'leave' ? settings.farewellText : settings.greetText;
        announce(kind, String(custom || '').trim() || username, true);
    }

    // ---- join / leave diffing -------------------------------------------
    // Armed only while I'm in the call, so these are never audible to someone
    // who isn't in voice — same guarantee the website makes.

    let armed = false;
    let armAt = 0;
    let prevById = null;

    // ENTRIES are kept, not reduced to ids: a leave is announced after the
    // person's row is gone, so their name and Leaving text have to come from
    // the roster as it stood while they were still in it.
    function entryMap(list) {
        const o = {};
        (list || []).forEach((p) => {
            if (p && p.id) {
                o[p.id] = { name: p.name || 'Someone', greet: p.greet || '', farewell: p.farewell || '' };
            }
        });
        return o;
    }

    // An arrival is announced on a short DELAY, and the words are resolved
    // when the announcement actually fires, from the freshest entry we hold.
    //
    // The race this closes: a joiner shows up in the SFU peer list a beat
    // before their roster row — the one carrying their custom Greeting text —
    // arrives over the socket. Announcing at first sight spoke the username
    // every time and made the custom text look like it only worked for its
    // owner. Waiting one beat lets the row land; the entry is re-read at fire
    // time, so whatever arrived in the meantime is what gets spoken.
    //
    // A join that evaporates inside the window (a connection blip) cancels
    // silently — no join, and no leave for a join nobody heard.
    const JOIN_SAY_DELAY_MS = 800;
    let latestById = {};
    const pendingJoins = new Map();   // id -> timer

    function clearPendingJoins() {
        pendingJoins.forEach((t) => clearTimeout(t));
        pendingJoins.clear();
    }

    // Call on every voice roster render. `joined` = am I in the call.
    // `silent` (DND) suppresses playback WITHOUT disarming: folding DND into
    // `joined` made toggling DND off replay announcements mid-call.
    function voiceRoster(list, joined, myId, silent) {
        if (!joined) { armed = false; prevById = null; latestById = {}; clearPendingJoins(); return; }

        latestById = entryMap(list);

        if (!armed) {                       // the first render after I join
            armed = true;
            armAt = Date.now();
            // Everyone already here is the baseline, not an arrival — and my
            // own announcement is app.js's announceSelf, on the transition.
            prevById = latestById;
            return;
        }

        const byId = latestById;
        if (Date.now() - armAt < SETTLE_MS) { prevById = byId; return; }

        if (prevById && !silent) {
            for (const a in byId) {
                if (a === myId || prevById[a] || pendingJoins.has(a)) continue;
                pendingJoins.set(a, setTimeout(() => {
                    pendingJoins.delete(a);
                    const e = latestById[a];
                    if (e) announce('join', e.greet || e.name);
                }, JOIN_SAY_DELAY_MS));
            }
            for (const b in prevById) {
                if (b === myId || byId[b]) continue;
                if (pendingJoins.has(b)) {
                    // Came and went before anyone was told — say nothing at all.
                    clearTimeout(pendingJoins.get(b));
                    pendingJoins.delete(b);
                    continue;
                }
                announce('leave', prevById[b].farewell || prevById[b].name);
            }
        }
        prevById = byId;
    }

    function reset() { armed = false; prevById = null; latestById = {}; clearPendingJoins(); }

    window.loungeSounds = {
        init, setSettings, playMessage, playVoice, playUi, voiceRoster, reset,
        announceSelf, previewAnnounce
    };
})();
