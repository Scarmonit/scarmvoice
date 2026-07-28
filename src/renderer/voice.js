// Voice engine — Cloudflare RealtimeKit SFU.
//
// Mirrors the behaviour the website's board-voice.js already proved against
// this SFU, so desktop and browser users land in the same room and sound the
// same. Notably:
//   • enableHighBitrate: true -> 64 kbps mono Opus, which is the ceiling for a
//     mono source. There is no numeric bitrate knob in this SDK.
//   • AGC off by default — its level loop audibly self-modulates ("wobble").
//   • Participants are keyed by customParticipantId (== our clientId), which is
//     stable across sessions, so per-user volume/mute prefs persist.
//   • Transmission is gated by enableAudio()/disableAudio() rather than a gain
//     node, so push-to-talk actually stops sending rather than sending silence.
(function () {
    'use strict';

    // RMS above which a participant reads as "speaking". Settable per user from
    // Settings > Voice & Audio, calibrated against the mic-test meter there.
    const SPEAK_THRESHOLD = 0.055;   // fallback when the setting is unset
    // Held long enough to cover the gap between two words. At 220ms the ring
    // flickered off between syllables; the meter's own release does part of the
    // work now, and this covers the rest.
    const SPEAK_HANG_MS = 350;

    // ---- screen-share quality ------------------------------------------------
    // Same tiers, bitrates and encoder levers the website uses, so a desktop
    // share looks identical to a browser share to everyone receiving it.
    //   sharp  = detail + maintain-resolution + 30fps -> crisp text
    //   smooth = motion + maintain-framerate + 60fps  -> fluid video/gameplay
    const SHARE_TIERS = {
        '720p': { w: 1280, h: 720 },
        '1080p': { w: 1920, h: 1080 },
        '1440p': { w: 2560, h: 1440 }   // keeps high-DPI/4K displays from being blurred down
    };
    const SHARE_BITRATES = {
        '720p': { sharp: 2500000, smooth: 5000000 },
        '1080p': { sharp: 5000000, smooth: 12000000 },
        '1440p': { sharp: 8000000, smooth: 16000000 }
    };

    // Live copy of the active tier/motion, read by the getDisplayMedia patch
    // below (which is installed once, before any meeting exists).
    let shareQuality = '1080p';
    let shareMotion = 'sharp';

    function shareTier() { return SHARE_TIERS[shareQuality] || SHARE_TIERS['1080p']; }
    function isSmooth() { return shareMotion === 'smooth'; }

    function shareCaptureConstraints() {
        const t = shareTier();
        return {
            width: { ideal: t.w, max: t.w },
            height: { ideal: t.h, max: t.h },
            frameRate: isSmooth() ? { ideal: 60, max: 60 } : { ideal: 30, max: 30 }
        };
    }

    // Which outgoing video track is the screen share. Set when the local share
    // starts, cleared when it stops; null means "no share, don't tune anything
    // as one". The camera track must never match this.
    let SHARE_TRACK_ID = null;
    // Kept for the console: `loungeShareTrack()` while debugging a share.
    function shareVideoTrackId() { return SHARE_TRACK_ID; }
    window.loungeShareTrack = shareVideoTrackId;

    // Bumped on every share start/stop transition. Retry loops capture it when
    // armed and bail if it moved — covers the case where SHARE_TRACK_ID was
    // null from the start (producer not up yet), which the id check can't.
    let SHARE_GEN = 0;

    // Late-binding for the id: screenShareUpdate can fire before the SDK has
    // published the video track, leaving SHARE_TRACK_ID null. The retry loop
    // used to fall back to "tune any video sender" in that window, which with a
    // camera already on meant pinning the CAMERA at the share's bitrate and
    // maintain-resolution — the exact confusion the id match exists to prevent.
    // Re-reading it each attempt closes the window instead.
    function refreshShareTrackId() {
        if (SHARE_TRACK_ID) return SHARE_TRACK_ID;
        try {
            const v = meetingRef && meetingRef.self &&
                meetingRef.self.screenShareTracks && meetingRef.self.screenShareTracks.video;
            if (v && v.id) SHARE_TRACK_ID = v.id;
        } catch (e) { /* not up yet */ }
        return SHARE_TRACK_ID;
    }

    // The engine closure assigns this so the module-level share helpers can see
    // the live meeting without threading it through every call.
    let meetingRef = null;

    function shareProfile() {
        const smooth = isSmooth();
        return {
            contentHint: smooth ? 'motion' : 'detail',
            degradation: smooth ? 'maintain-framerate' : 'maintain-resolution',
            maxFramerate: smooth ? 60 : 30,
            maxBitrate: (SHARE_BITRATES[shareQuality] || SHARE_BITRATES['1080p'])[smooth ? 'smooth' : 'sharp']
        };
    }

    // RealtimeKit/mediasoup exposes no screen-share bitrate API, and under its
    // default cap the encoder silently downscales the share to ~720p —
    // contentHint alone does not hold it. The reliable WebRTC lever is
    // RTCRtpSender.setParameters on the real sender, but the SDK hides its
    // RTCPeerConnection, so we wrap the constructor to keep a registry.
    const PCS = [];
    // Closed connections from previous sessions would otherwise pin native
    // resources forever and get pointlessly iterated on every share.
    function prunePCS() {
        for (let i = PCS.length - 1; i >= 0; i--) {
            const pc = PCS[i];
            if (!pc || pc.signalingState === 'closed' || pc.connectionState === 'closed') {
                PCS.splice(i, 1);
            }
        }
    }
    (function patchRTC() {
        try {
            const Native = window.RTCPeerConnection || window.webkitRTCPeerConnection;
            if (!Native || Native.__loungeWrapped) return;
            const Wrapped = function (cfg, con) {
                const pc = (arguments.length > 1) ? new Native(cfg, con) : new Native(cfg);
                try { PCS.push(pc); } catch (e) {}
                return pc;
            };
            Wrapped.prototype = Native.prototype;               // instanceof + prototype intact
            try { Object.setPrototypeOf(Wrapped, Native); } catch (e) {}  // inherit statics
            Wrapped.__loungeWrapped = true;
            window.RTCPeerConnection = Wrapped;
        } catch (e) { /* quality pinning is best-effort */ }
    })();

    // The SDK calls getDisplayMedia with its own (~720p) constraints, which caps
    // the CAPTURE before any encoder is involved. Force the active tier while
    // preserving whatever else the SDK asked for.
    (function patchGDM() {
        try {
            const md = navigator.mediaDevices;
            if (!md || !md.getDisplayMedia || md.__loungeGdmWrapped) return;
            const orig = md.getDisplayMedia.bind(md);
            md.getDisplayMedia = function (constraints) {
                constraints = constraints || {};
                const vid = (constraints.video && typeof constraints.video === 'object')
                    ? Object.assign({}, constraints.video) : {};
                const cap = shareCaptureConstraints();
                vid.width = cap.width;
                vid.height = cap.height;
                vid.frameRate = cap.frameRate;
                constraints.video = vid;
                return orig(constraints);
            };
            md.__loungeGdmWrapped = true;
        } catch (e) {}
    })();

    // Pin the outgoing SCREEN SHARE sender to full resolution and the active
    // tier's bitrate. Once the camera can also be on, "the video sender" is no
    // longer unambiguous — matching on the share track's own id keeps these
    // settings off the camera, which wants none of them.
    function forceScreenQuality() {
        prunePCS();
        const prof = shareProfile();
        // Re-read rather than trusting whatever the id was when the loop armed:
        // the track often appears a beat after the sender does.
        const shareTrackId = refreshShareTrackId();
        // Still unknown — do nothing rather than guess. Tuning "any video
        // sender" here is what used to re-tune a live camera at 16 Mbps.
        if (!shareTrackId) return 0;
        let found = 0;
        PCS.forEach((pc) => {
            if (!pc || typeof pc.getSenders !== 'function') return;
            let senders;
            try { senders = pc.getSenders(); } catch (e) { return; }
            senders.forEach((sender) => {
                if (!sender || !sender.track || sender.track.kind !== 'video') return;
                if (sender.track.id !== shareTrackId) return;
                found++;
                try { sender.track.contentHint = prof.contentHint; } catch (e) {}
                try {
                    const p = sender.getParameters();
                    // Never fabricate an encoding: setParameters rejects an
                    // encodings array whose length differs from the one
                    // getParameters returned, so the old `p.encodings = [{}]`
                    // guaranteed an InvalidModificationError (swallowed by the
                    // catch below) on the exact call it was meant to rescue.
                    if (!p.encodings || !p.encodings.length) return;
                    if (p.encodings.length === 1) {
                        p.encodings[0].scaleResolutionDownBy = 1;
                        p.encodings[0].maxBitrate = prof.maxBitrate;
                        p.encodings[0].maxFramerate = prof.maxFramerate;
                    } else {
                        // simulcast: lift the highest-resolution layer
                        const top = p.encodings.reduce((a, b) =>
                            ((b.scaleResolutionDownBy || 1) < (a.scaleResolutionDownBy || 1)) ? b : a);
                        top.scaleResolutionDownBy = 1;
                        top.maxBitrate = prof.maxBitrate;
                        top.maxFramerate = prof.maxFramerate;
                    }
                    p.degradationPreference = prof.degradation;
                    Promise.resolve(sender.setParameters(p)).catch(() => {});
                } catch (e) {}
            });
        });
        return found;
    }

    // Bumped by every re-tune, including a mid-share quality/motion change.
    // SHARE_GEN only moves on start/stop, so without this a user cycling
    // 720p -> 1080p -> 1440p left three retry loops running concurrently, each
    // re-asserting a profile the others had just overwritten.
    let TUNE_GEN = 0;

    // The producer/sender appears asynchronously after enableScreenShare.
    function forceScreenQualityRetry() {
        let tries = 0;
        const shareGen = SHARE_GEN;
        const tuneGen = ++TUNE_GEN;
        (function go() {
            // Stop if the share ended/restarted, or a newer tune superseded us.
            if (shareGen !== SHARE_GEN || tuneGen !== TUNE_GEN) return;
            const found = forceScreenQuality();
            if (tries === 0) console.info('[share] video senders found:', found, 'across', PCS.length, 'peer connections');
            // Each setParameters that moves degradationPreference can make
            // Chromium reconfigure the encoder, so once the settings are
            // confirmed on the wire there is nothing to gain from hammering it
            // five more times over the next seven seconds.
            if (found > 0 && shareSettingsApplied()) return;
            if (++tries < 6) setTimeout(go, tries * 500);
        })();
    }

    // Read back what the sender actually accepted — the only proof that the
    // pinning took, as opposed to being silently clamped or ignored.
    function shareSettingsApplied() {
        const prof = shareProfile();
        const id = SHARE_TRACK_ID;
        if (!id) return false;
        let confirmed = false;
        PCS.forEach((pc) => {
            if (confirmed || !pc || typeof pc.getSenders !== 'function') return;
            let senders;
            try { senders = pc.getSenders(); } catch (e) { return; }
            senders.forEach((sender) => {
                if (confirmed || !sender || !sender.track || sender.track.id !== id) return;
                try {
                    const p = sender.getParameters();
                    if (!p.encodings || !p.encodings.length) return;
                    const top = p.encodings.length === 1 ? p.encodings[0]
                        : p.encodings.reduce((a, b) =>
                            ((b.scaleResolutionDownBy || 1) < (a.scaleResolutionDownBy || 1)) ? b : a);
                    if (top.maxBitrate === prof.maxBitrate &&
                        p.degradationPreference === prof.degradation) confirmed = true;
                } catch (e) { /* unreadable — assume not applied */ }
            });
        });
        return confirmed;
    }

    // Is the share actually leaving this machine? bytesSent climbing on an
    // outbound video RTP stream is the only proof that matters — a local
    // preview only shows that capture works.
    function reportShareStats(label) {
        prunePCS();
        let seen = 0;
        PCS.forEach((pc, idx) => {
            if (!pc || typeof pc.getStats !== 'function') return;
            pc.getStats().then((stats) => {
                stats.forEach((r) => {
                    if (r.type === 'outbound-rtp' && r.kind === 'video') {
                        seen++;
                        console.info(`[share] ${label} pc#${idx} outbound video:`,
                            JSON.stringify({
                                bytesSent: r.bytesSent,
                                framesEncoded: r.framesEncoded,
                                frameWidth: r.frameWidth,
                                frameHeight: r.frameHeight,
                                fps: r.framesPerSecond
                            }));
                    }
                });
            }).catch(() => {});
        });
        setTimeout(() => {
            if (!seen) console.warn(`[share] ${label}: NO outbound video RTP stream — the share is not being published`);
        }, 800);
    }
    window.loungeShareStats = () => reportShareStats('manual');

    // Round-trip time, measured by the transport rather than by us. The STUN
    // connectivity check on whichever candidate pair the connection actually
    // settled on IS the latency to the server — an application-level ping over
    // a different socket would be a different number about a different path.
    //
    // Returns null when nothing has measured it yet. A number nobody measured is
    // worse than no number, so this never guesses.
    // Everything the connection knows about itself, read off getStats(). Every
    // field here is measured by the transport — none of it is estimated, and
    // anything unmeasured comes back null rather than as a plausible number.
    async function sampleConnection() {
        prunePCS();
        const out = {
            rtt: null,            // ms, this sample
            lossPct: null,        // % of our outbound packets the far end never got
            candidate: null,      // relay / srflx / host — how the media is routed
            protocol: null,       // udp / tcp
            remote: null,         // the address media is actually going to
            codec: null,
            peers: 0
        };
        for (const pc of PCS) {
            if (!pc || typeof pc.getStats !== 'function') continue;
            if (pc.connectionState === 'closed' || pc.connectionState === 'failed') continue;
            let stats;
            try { stats = await pc.getStats(); } catch (e) { continue; }
            out.peers++;

            const byId = new Map();
            const pairs = new Map();
            let selectedId = null;
            stats.forEach((r) => {
                byId.set(r.id, r);
                if (r.type === 'candidate-pair') pairs.set(r.id, r);
                // Chromium names the live pair on the transport; it is the only
                // one whose RTT describes the path media is actually taking.
                if (r.type === 'transport' && r.selectedCandidatePairId) selectedId = r.selectedCandidatePairId;
            });
            let pair = selectedId ? pairs.get(selectedId) : null;
            if (!pair) pairs.forEach((p) => { if (p.state === 'succeeded' && p.nominated) pair = p; });
            if (!pair) pairs.forEach((p) => { if (!pair && p.state === 'succeeded') pair = p; });

            let rtt = (pair && typeof pair.currentRoundTripTime === 'number')
                ? pair.currentRoundTripTime : null;
            // RTCP's own estimate, for the window before the first STUN check
            // lands. Same units, measured a different way.
            if (rtt === null) {
                stats.forEach((r) => {
                    if (r.type === 'remote-inbound-rtp' && typeof r.roundTripTime === 'number') {
                        if (rtt === null || r.roundTripTime < rtt) rtt = r.roundTripTime;
                    }
                });
            }
            // The shortest live path, when a mesh call has several.
            if (rtt !== null && (out.rtt === null || rtt * 1000 < out.rtt)) out.rtt = Math.round(rtt * 1000);

            // How the media is routed, from the pair actually in use.
            if (pair && out.candidate === null) {
                const local = byId.get(pair.localCandidateId);
                const remote = byId.get(pair.remoteCandidateId);
                if (local) {
                    out.candidate = local.candidateType || null;
                    out.protocol = local.protocol || null;
                }
                if (remote && remote.address) {
                    out.remote = remote.address + (remote.port ? ':' + remote.port : '');
                }
            }

            // Loss on what WE send: the far end reports back how much of our
            // audio never arrived. packetsSent is ours, packetsLost is theirs —
            // which is why this is outbound loss and not inbound.
            let sent = 0;
            let lost = 0;
            stats.forEach((r) => {
                if (r.type === 'outbound-rtp' && r.kind === 'audio') {
                    if (typeof r.packetsSent === 'number') sent += r.packetsSent;
                    const c = byId.get(r.codecId);
                    if (c && c.mimeType && out.codec === null) out.codec = c.mimeType.split('/').pop();
                }
                if (r.type === 'remote-inbound-rtp' && r.kind === 'audio'
                    && typeof r.packetsLost === 'number') {
                    lost += Math.max(0, r.packetsLost);
                }
            });
            if (sent > 0 && out.lossPct === null) {
                out.lossPct = Math.round((lost / (sent + lost)) * 1000) / 10;
            }
        }
        return out;
    }

    // The number on its own, for the callers that only want that.
    async function sampleRtt() {
        return (await sampleConnection()).rtt;
    }
    // Alongside loungeShareStats: "what does the app think my latency is, right
    // now" is the first question anyone asks when the number looks wrong.
    window.loungeRtt = sampleRtt;

    function createVoice(opts) {
        const on = Object.assign({
            onState: () => {},
            onParticipants: () => {},
            onSpeaking: () => {},
            onShares: () => {},
            onCams: () => {},
            onError: () => {}
        }, opts || {});

        let meeting = null;
        let rttMs = null;
        let rttTimer = null;
        let conn = null;
        // Four minutes of samples at one every three seconds — the same span the
        // reference's graph covers. Older ones fall off the front.
        const RTT_HISTORY = 80;
        const rttHistory = [];
        let joined = false;
        let joining = false;
        let muted = false;
        let deafened = false;
        let mutedBeforeDeafen = false;
        let lastTransmit = null;

        let localSharing = false;
        // Every live presenter, keyed by participant id. The SFU happily carries
        // several screen shares at once; which one you WATCH is a viewer-side
        // choice made in the UI, so the engine keeps them all published.
        const sharers = new Map();  // cid -> { id, name, isLocal, stream, sig }

        let settings = {};
        const audioEls = {};        // cid -> HTMLAudioElement
        const shareAudioEls = {};   // cid -> HTMLAudioElement carrying that share's audio
        const gainNodes = {};       // cid -> { ctx, src, gain, dest } for >100% boost
        const analysers = {};       // cid -> { ctx, analyser, data, raf, speaking, until }
        let sink = null;

        // ---- helpers -----------------------------------------------------

        function ensureSink() {
            if (sink) return sink;
            sink = document.getElementById('audio-sink');
            if (!sink) {
                sink = document.createElement('div');
                sink.id = 'audio-sink';
                sink.hidden = true;
                document.body.appendChild(sink);
            }
            return sink;
        }

        function cidOf(p) {
            return (p && (p.customParticipantId || p.id)) || null;
        }

        // Three seconds is what the number is worth: it is a running average
        // inside the transport already, so sampling faster only shows jitter.
        // A push only when the DISPLAYED value would change, or the panel
        // repaints on every tick for a millisecond nobody can see.
        const RTT_MS = 3000;
        function startRtt() {
            stopRtt();
            const tick = () => sampleConnection().then((c) => {
                const v = c.rtt;
                conn = c;
                // A gap rather than a fabricated point: a sample that failed is
                // not a sample of zero, and the graph has to be able to show it.
                rttHistory.push(v);
                while (rttHistory.length > RTT_HISTORY) rttHistory.shift();
                const changed = (v === null) !== (rttMs === null)
                    || (v !== null && rttMs !== null && Math.abs(v - rttMs) >= 3);
                rttMs = v;
                if (changed) pushState();
            }).catch(() => {});
            tick();
            rttTimer = setInterval(tick, RTT_MS);
        }
        function stopRtt() {
            if (rttTimer) clearInterval(rttTimer);
            rttTimer = null;
            rttMs = null;
            conn = null;
            rttHistory.length = 0;
        }

        function state() {
            return {
                joined, joining, muted, deafened,
                rtt: rttMs,
                transmitting: lastTransmit === true,
                sharing: localSharing,
                sharers: shareList().map((s) => ({ id: s.id, name: s.name, isLocal: s.isLocal })),
                shareQuality, shareMotion,
                cam: isCamOn()
            };
        }

        function pushState() { on.onState(state()); }

        function fail(where, err) {
            const msg = (err && err.message) || String(err || 'unknown error');
            console.error('[voice] ' + where + ':', err);
            on.onError(where + ': ' + msg);
        }

        // ---- per-participant local volume / mute -------------------------
        // Up to 100% is the element's own volume. Above that we route the
        // stream through a GainNode, because HTMLMediaElement.volume caps at 1.

        function dropGain(cid) {
            const g = gainNodes[cid];
            if (!g) return;
            g.stop();
            delete gainNodes[cid];
        }

        function applyLocalAudio(cid) {
            const el = audioEls[cid];
            if (!el) return;
            const vol = settings.localVolumes && settings.localVolumes[cid] !== undefined
                ? Number(settings.localVolumes[cid]) : 1;
            const isMuted = !!(settings.localMuted && settings.localMuted[cid]);
            const master = settings.outputVolume === undefined ? 1 : Number(settings.outputVolume);

            const effective = Math.max(0, vol * master);
            el.muted = isMuted || deafened;

            if (effective <= 1) {
                dropGain(cid);
                el.volume = effective;
                return;
            }
            // Boost path: element silenced, the shared context's GainNode does
            // all the work (it can exceed 1, which the element cannot).
            let g = gainNodes[cid];
            if (!g && el.srcObject) {
                g = window.ScarmAudio.createGain(el.srcObject, effective);
                if (g) gainNodes[cid] = g;
            }
            if (g) {
                // The element must stay silent on EVERY pass while the gain
                // graph exists — un-silencing it here made the same audio play
                // twice (element at 100% + boosted graph) after any re-apply.
                el.volume = 0;
                // The graph plays via the shared AudioContext, which ignores
                // el.muted entirely — mute/deafen must zero the gain itself,
                // or a >100% participant stays audible while you're deafened.
                g.set((isMuted || deafened) ? 0 : effective);
            } else {
                // No gain graph available: the element's own max is the best we can do.
                el.volume = 1;
            }
        }

        function applySinkId(el) {
            const id = settings.speakerDeviceId;
            if (!id || typeof el.setSinkId !== 'function') return;
            el.setSinkId(id).catch(() => {});
        }

        // Screen-share audio rides its own element rather than the on-screen
        // <video>, so you keep hearing a presenter you're not currently watching.
        // No >100% boost path here: a share's audio follows the same person's
        // volume/mute prefs, clamped to what the element can do.
        function applyShareAudio(cid) {
            const el = shareAudioEls[cid];
            if (!el) return;
            const vol = settings.localVolumes && settings.localVolumes[cid] !== undefined
                ? Number(settings.localVolumes[cid]) : 1;
            const master = settings.outputVolume === undefined ? 1 : Number(settings.outputVolume);
            el.muted = deafened || !!(settings.localMuted && settings.localMuted[cid]);
            el.volume = Math.max(0, Math.min(1, vol * master));
        }

        function attachShareAudio(cid, tracks) {
            const track = tracks && tracks.audio;
            if (!cid || !track) { detachShareAudio(cid); return; }
            ensureSink();
            let el = shareAudioEls[cid];
            if (!el) {
                el = document.createElement('audio');
                el.autoplay = true;
                el.setAttribute('playsinline', '');
                sink.appendChild(el);
                shareAudioEls[cid] = el;
                applySinkId(el);
            }
            try { el.srcObject = new MediaStream([track]); } catch (e) { return; }
            applyShareAudio(cid);
            el.play().catch(() => {});
        }

        function detachShareAudio(cid) {
            const el = shareAudioEls[cid];
            if (!el) return;
            try { el.srcObject = null; el.remove(); } catch (e) {}
            delete shareAudioEls[cid];
        }

        function applyAllLocalAudio() {
            Object.keys(audioEls).forEach(applyLocalAudio);
            Object.keys(shareAudioEls).forEach(applyShareAudio);
        }

        // ---- speaking detection ------------------------------------------
        // The SDK has no reliable cross-version active-speaker event, so we
        // measure RMS off each stream. One analyser per participant on the
        // shared AudioContext (see audio.js) — a context per participant used to
        // blow past Chromium's six-context limit in a call of five.

        function watchSpeaking(cid, stream, isLocal) {
            stopSpeaking(cid);
            if (!stream) return;

            const meter = window.ScarmAudio.createMeter(stream);
            if (!meter) return;

            const rec = analysers[cid] = { meter, speaking: false, until: 0, isLocal, off: null };

            // Sampling happens on the shared tick; this callback only turns the
            // level into a boolean with a short hang so the dot doesn't strobe.
            rec.off = window.ScarmAudio.onTick(() => {
                const now = performance.now();
                // A muted/non-transmitting local mic must never light up.
                const gated = isLocal && (muted || lastTransmit === false);
                const threshold = Number(settings.speakThreshold) > 0
                    ? Number(settings.speakThreshold) / 100
                    : SPEAK_THRESHOLD;
                // meter.isSpeech, not a bare RMS compare: the meter owns that
                // definition so the Settings mic test and this agree. A plain
                // `rms() > threshold` is what made the ring unreliable — it
                // asked whether the last 11ms happened to be loud, rather than
                // whether somebody is talking.
                if (!gated && meter.isSpeech(threshold)) rec.until = now + SPEAK_HANG_MS;
                const nowSpeaking = !gated && now < rec.until;

                if (nowSpeaking !== rec.speaking) {
                    rec.speaking = nowSpeaking;
                    // isLocal is passed through: the me-bar wants to know that
                    // THIS is you, and comparing ids in the renderer would be
                    // guessing at something this closure already knows.
                    on.onSpeaking(cid, nowSpeaking, isLocal);
                }
            });
        }

        function stopSpeaking(cid) {
            const rec = analysers[cid];
            if (!rec) return;
            if (rec.off) rec.off();
            rec.meter.stop();
            delete analysers[cid];
            if (rec.speaking) on.onSpeaking(cid, false, rec.isLocal);
        }

        function stopAllSpeaking() {
            Object.keys(analysers).forEach(stopSpeaking);
        }

        // ---- remote audio attach/detach ----------------------------------

        // Which track each participant's <audio> is currently carrying, so an
        // event that doesn't actually change the track is a no-op.
        const audioTrackIds = Object.create(null);

        function attachAudio(p) {
            const cid = cidOf(p);
            if (!cid || !p.audioTrack) return;
            ensureSink();

            let el = audioEls[cid];
            const fresh = !el;
            if (!el) {
                el = document.createElement('audio');
                el.autoplay = true;
                el.setAttribute('playsinline', '');
                sink.appendChild(el);
                audioEls[cid] = el;
                applySinkId(el);
            }

            // This runs on every audioUpdate, which fires on every remote mute
            // and unmute. Rebuilding unconditionally swapped srcObject and tore
            // down the WebAudio boost graph and the speaking analyser each time
            // — an audible click for anyone boosted above 100%, and a dropped
            // speaking dot. The camera and screen-share paths already guard on
            // track identity; this is the one that didn't.
            if (!fresh && audioTrackIds[cid] === p.audioTrack.id) {
                applyLocalAudio(cid);          // volume/mute prefs may still have moved
                return;
            }

            let stream;
            try {
                stream = new MediaStream([p.audioTrack]);
                el.srcObject = stream;
            } catch (e) { return; }
            audioTrackIds[cid] = p.audioTrack.id;

            dropGain(cid);            // stream changed — rebuild any boost graph
            applyLocalAudio(cid);
            watchSpeaking(cid, stream, false);
            tuneReceiver(p.audioTrack);
            el.play().catch(() => {});
        }

        // Trim NetEq's conservative default buffering on the receiving end.
        // Chromium clamps whatever we ask for and grows it back on a bad link,
        // so this is a hint toward lower conversational latency, not a promise.
        function tuneReceiver(track) {
            if (!track) return;
            prunePCS();
            PCS.forEach((pc) => {
                if (!pc || typeof pc.getReceivers !== 'function') return;
                let receivers;
                try { receivers = pc.getReceivers(); } catch (e) { return; }
                receivers.forEach((r) => {
                    if (!r || !r.track || r.track.id !== track.id) return;
                    // Both are Chromium-specific and absent elsewhere.
                    try { if ('jitterBufferTarget' in r) r.jitterBufferTarget = 40; } catch (e) {}
                    try { if ('playoutDelayHint' in r) r.playoutDelayHint = 0; } catch (e) {}
                });
            });
        }

        function detachAudio(p) {
            const cid = cidOf(p);
            if (!cid) return;
            dropGain(cid);
            stopSpeaking(cid);
            delete audioTrackIds[cid];   // or a rejoin reusing the id would skip the rebuild
            const el = audioEls[cid];
            if (el) {
                try { el.srcObject = null; el.remove(); } catch (e) {}
                delete audioEls[cid];
            }
        }

        // ---- roster ------------------------------------------------------

        function roster() {
            const list = [];
            if (!meeting) return list;
            try {
                if (meeting.self) {
                    list.push({
                        id: cidOf(meeting.self),
                        name: meeting.self.name || settings.displayName || 'You',
                        isMe: true,
                        muted,
                        // Known locally and nowhere else — without it your own
                        // row in the sidebar showed a muted mic and no deafened
                        // headset, whatever the user panel said.
                        deafened
                    });
                }
                const pj = meeting.participants && meeting.participants.joined;
                const arr = pj && pj.toArray ? pj.toArray() : [];
                arr.forEach((p) => {
                    const cid = cidOf(p);
                    list.push({
                        id: cid,
                        name: p.name || 'Anonymous',
                        isMe: false,
                        // THEIR microphone, not my opinion of it. This used to
                        // report `settings.localMuted[cid]` — whether *I* had
                        // silenced them — so somebody muting themselves was
                        // visible to nobody but themselves, and a person I had
                        // locally muted was shown to me as having muted
                        // themselves. Two different facts under one name.
                        //
                        // audioEnabled is the SFU's own view of their published
                        // track, so it is both authoritative and immediate.
                        muted: p.audioEnabled === false,
                        // Kept separately, because the roster still wants to
                        // show that I have silenced someone.
                        localMuted: !!(settings.localMuted && settings.localMuted[cid]),
                        volume: settings.localVolumes && settings.localVolumes[cid] !== undefined
                            ? Number(settings.localVolumes[cid]) : 1,
                        audioEnabled: p.audioEnabled !== false
                    });
                });
            } catch (e) { /* roster is best-effort */ }
            return list;
        }

        let lastRosterSig = '';
        function render() {
            const list = roster();
            // Worth logging because it distinguishes "really peered in the SFU"
            // from "merely listed in the D1 presence table" — the sidebar merges
            // both, so a broken call looks identical to a working one.
            const sig = list.map((p) => p.id).sort().join(',');
            if (sig !== lastRosterSig) {
                lastRosterSig = sig;
                console.info('[voice] SFU peers (' + list.length + '):',
                    list.map((p) => p.name + (p.isMe ? ' (me)' : '')).join(', ') || 'none');
            }
            on.onParticipants(list);
        }

        // What are we actually RECEIVING? If a remote is publishing and we are
        // subscribed, there will be inbound-rtp streams with bytes arriving.
        function reportInboundStats() {
            PCS.forEach((pc, idx) => {
                if (!pc || typeof pc.getStats !== 'function') return;
                pc.getStats().then((stats) => {
                    stats.forEach((r) => {
                        if (r.type === 'inbound-rtp' && r.bytesReceived) {
                            console.info(`[voice] inbound pc#${idx} ${r.kind}:`, JSON.stringify({
                                bytesReceived: r.bytesReceived,
                                frameWidth: r.frameWidth,
                                frameHeight: r.frameHeight
                            }));
                        }
                    });
                }).catch(() => {});
            });
        }
        window.loungeInbound = reportInboundStats;

        // Every SDK subscription made for the CURRENT meeting. meeting.leave()
        // does not take these off, and each handler closes over module state
        // with no generation check — so an event arriving during the SDK's own
        // async teardown would rebuild the audio elements and share entries that
        // leave() had just cleared, and they'd survive until the next leave.
        let wired = [];

        function bind(emitter, event, handler) {
            if (!emitter || typeof emitter.on !== 'function') return;
            try {
                emitter.on(event, handler);
                wired.push({ emitter, event, handler });
            } catch (e) { /* this SDK build doesn't expose that event */ }
        }

        function unwire() {
            const list = wired;
            wired = [];
            list.forEach(({ emitter, event, handler }) => {
                try {
                    if (typeof emitter.off === 'function') emitter.off(event, handler);
                    else if (typeof emitter.removeListener === 'function') emitter.removeListener(event, handler);
                } catch (e) { /* best effort — the emitter may already be dead */ }
            });
        }

        function wire(m) {
            // Re-run watchLocal on every self audioUpdate: mute/PTT replaces the
            // published track (disableAudio really stops it), so a meter bound
            // once at join goes dark after the first cycle — and in PTT mode the
            // track doesn't exist until the first transmit at all.
            bind(m.self, 'audioUpdate', () => { watchLocal(); render(); });
            const pj = m.participants && m.participants.joined;
            bind(pj, 'participantJoined', (p) => { attachAudio(p); render(); pushCams(); });
            bind(pj, 'participantLeft', (p) => { detachAudio(p); render(); pushCams(); });
            bind(pj, 'audioUpdate', (p) => { attachAudio(p); render(); });
            bind(pj, 'videoUpdate', () => pushCams());
            if (pj) {
                try { (pj.toArray ? pj.toArray() : []).forEach(attachAudio); } catch (e) {}
            }
            bind(m.self, 'videoUpdate', () => pushCams());
            wireReconnect(m);
            wireShare(m);
        }

        // The SDK survives a transport drop by tearing the peer connection down
        // and REBUILDING the producers. Everything forceScreenQuality() pinned —
        // maxBitrate, maxFramerate, scaleResolutionDownBy, degradationPreference,
        // contentHint — lives on the old sender and dies with it, and
        // SHARE_TRACK_ID still names the dead track so nothing would re-match.
        //
        // Without this listener, one Wi-Fi blip mid-share dropped the share to
        // the SFU default (~720p) for the rest of the session, silently. That is
        // precisely the failure the whole quality-pinning mechanism exists to
        // prevent, so it has to be re-applied when the transport comes back.
        function wireReconnect(m) {
            const onBack = (why) => {
                prunePCS();
                if (!joined) return;
                console.info('[voice] media transport re-established (' + why + ') — re-applying tuning');
                // The producers are new, so anything keyed to the old track id
                // has to be re-read rather than reused.
                SHARE_TRACK_ID = null;
                applyStreamPriorities();
                applyAllLocalAudio();
                if (localSharing) {
                    SHARE_GEN++;
                    refreshShareTrackId();
                    tuneLocalShare();
                }
            };

            bind(m.meta, 'mediaConnectionUpdate', (s) => {
                // Shape varies by SDK build; treat anything that isn't an
                // explicit connected/reconnected signal as noise.
                const state = s && (s.state || s.transportState);
                if (state === 'connected' || state === 'reconnected') onBack('mediaConnectionUpdate');
            });
            bind(m.self, 'roomJoined', (d) => {
                if (d && d.reconnected) onBack('roomJoined');
            });
        }

        // ---- camera ------------------------------------------------------
        // Plain RealtimeKit video on the same meeting the website uses, so a
        // camera turned on here shows up there and vice versa. The screen share
        // is a separate track pair and is unaffected.

        // One MediaStream per track, cached: camList() runs on every roster
        // event, and a fresh MediaStream gets a fresh random .id each time —
        // which defeats the renderer's stream-id check and made every cam tile
        // re-attach (black flash) on every participant event.
        const camStreams = new Map();   // track.id -> MediaStream
        function camStream(track) {
            if (!track) return new MediaStream();
            camStreams.forEach((s, id) => {
                const t = s.getVideoTracks()[0];
                if (!t || t.readyState === 'ended') camStreams.delete(id);
            });
            let s = camStreams.get(track.id);
            if (!s) {
                s = new MediaStream();
                try { s.addTrack(track); } catch (e) {}
                camStreams.set(track.id, s);
            }
            return s;
        }

        // Everyone with a live camera, me first.
        function camList() {
            if (!meeting) return [];
            const out = [];
            try {
                const self = meeting.self;
                if (self && self.videoEnabled && self.videoTrack) {
                    out.push({
                        id: selfCid(),
                        name: (self.name || settings.displayName || 'You'),
                        isMe: true,
                        stream: camStream(self.videoTrack)
                    });
                }
            } catch (e) {}
            try {
                const pj = meeting.participants && meeting.participants.joined;
                (pj && pj.toArray ? pj.toArray() : []).forEach((p) => {
                    if (!p.videoEnabled || !p.videoTrack) return;
                    out.push({
                        id: cidOf(p),
                        name: p.name || 'Someone',
                        isMe: false,
                        stream: camStream(p.videoTrack)
                    });
                });
            } catch (e) {}
            return out;
        }

        function pushCams() {
            try { on.onCams(camList()); } catch (e) {}
            pushState();
        }

        function isCamOn() {
            try { return !!(meeting && meeting.self && meeting.self.videoEnabled); } catch (e) { return false; }
        }

        function enableCam() {
            if (!meeting || !meeting.self || !meeting.self.enableVideo) {
                on.onError('the camera needs an active call — join voice first');
                return Promise.resolve(false);
            }
            return Promise.resolve(meeting.self.enableVideo())
                .then(() => { pushCams(); return true; })
                .catch((e) => {
                    const msg = (e && e.message) || String(e);
                    if (!/denied|cancel|abort|NotAllowed/i.test(msg)) on.onError('could not start the camera — ' + msg);
                    else on.onError('camera access was denied');
                    return false;
                });
        }

        function disableCam() {
            try {
                if (meeting && meeting.self && meeting.self.disableVideo) {
                    return Promise.resolve(meeting.self.disableVideo())
                        .then(() => { pushCams(); return true; })
                        .catch(() => { pushCams(); return false; });
                }
            } catch (e) {}
            pushCams();
            return Promise.resolve(false);
        }

        // ---- screen share ------------------------------------------------

        function buildShareStream(tracks) {
            const s = new MediaStream();
            try {
                if (tracks && tracks.video) s.addTrack(tracks.video);
                if (tracks && tracks.audio) s.addTrack(tracks.audio);
            } catch (e) {}
            return s;
        }

        function selfCid() {
            try {
                return (meeting && meeting.self && (meeting.self.customParticipantId || meeting.self.id)) ||
                    settings.clientId;
            } catch (e) { return settings.clientId; }
        }

        // Identifies the track pair behind a share. The SDK re-fires
        // screenShareUpdate for unrelated reasons; rebuilding the MediaStream
        // each time would swap the <video>'s srcObject and flash it black.
        function trackSig(tracks) {
            const v = (tracks && tracks.video && tracks.video.id) || '-';
            const a = (tracks && tracks.audio && tracks.audio.id) || '-';
            return v + '/' + a;
        }

        // Remote presenters first, in the order they started — a locally shared
        // screen is the one thing you can already see, so it never displaces
        // someone else's from the top of the list.
        function shareList() {
            const arr = Array.from(sharers.values());
            return arr.filter((s) => !s.isLocal).concat(arr.filter((s) => s.isLocal))
                .map((s) => ({ id: s.id, name: s.name, isLocal: s.isLocal, stream: s.stream }));
        }

        function pushShares() {
            try { on.onShares(shareList()); } catch (e) {}
            pushState();
        }

        function setSharer(id, name, isLocal, tracks) {
            if (!id) return;
            const prev = sharers.get(id);
            const sig = trackSig(tracks);
            const stream = (prev && prev.sig === sig) ? prev.stream : buildShareStream(tracks);
            sharers.set(id, { id, name, isLocal, stream, sig });
            // Your own share's audio is already coming out of your speakers.
            if (!isLocal) attachShareAudio(id, tracks);
            pushShares();
        }

        function clearSharer(id) {
            if (!id || !sharers.delete(id)) return;
            detachShareAudio(id);
            pushShares();
        }

        // Re-assert the active tier once the SDK has the capture running. The
        // capture constraint, the SDK's own constraint, and the encoder all have
        // to agree or the share silently drops to ~720p.
        function tuneLocalShare() {
            try {
                const prof = shareProfile();
                const cap = shareCaptureConstraints();
                const v = meeting && meeting.self && meeting.self.screenShareTracks &&
                    meeting.self.screenShareTracks.video;
                console.info('[share] enabled. screenShareEnabled=' +
                    (meeting && meeting.self && meeting.self.screenShareEnabled) +
                    ' videoTrack=' + (v ? `${v.label} readyState=${v.readyState}` : 'MISSING') +
                    ' settings=' + (v && v.getSettings ? JSON.stringify(v.getSettings()) : 'n/a'));
                if (v) {
                    v.contentHint = prof.contentHint;
                    if (v.applyConstraints) v.applyConstraints(cap).catch(() => {});
                    // If the source disappears (window closed, "Stop sharing"),
                    // tell the SDK rather than leaving a dead tile up.
                    //
                    // Tagged because this function also runs on every mid-share
                    // quality/motion change: {once:true} doesn't dedupe distinct
                    // closures, so each of those added another listener and the
                    // source closing then fired stopShare() N times.
                    if (!v.__loungeEndBound) {
                        v.__loungeEndBound = true;
                        v.addEventListener('ended', () => stopShare(), { once: true });
                    }
                }
                if (meeting && meeting.self && typeof meeting.self.updateScreenshareConstraints === 'function') {
                    Promise.resolve(meeting.self.updateScreenshareConstraints(cap)).catch(() => {});
                }
                forceScreenQualityRetry();
                // The share sender does not exist at join time, so this is the
                // first chance to de-prioritise it against the voice stream.
                applyStreamPriorities();
                const tuneGen = TUNE_GEN;
                setTimeout(() => {
                    if (tuneGen !== TUNE_GEN) return;   // superseded by a newer tune
                    try {
                        const v2 = meeting.self.screenShareTracks && meeting.self.screenShareTracks.video;
                        if (v2) v2.contentHint = shareProfile().contentHint;
                    } catch (e) {}
                }, 1500);
                setTimeout(() => {
                    if (tuneGen !== TUNE_GEN) return;
                    reportShareStats('t+5s');
                }, 5000);
            } catch (e) {}
        }

        function wireShare(m) {
            bind(m.self, 'screenShareUpdate', (d) => {
                if (d && d.screenShareEnabled) {
                    localSharing = true;
                    SHARE_GEN++;   // new share — retire any older retry loop
                    const tracks = d.screenShareTracks || m.self.screenShareTracks || {};
                    SHARE_TRACK_ID = (tracks.video && tracks.video.id) || null;
                    tuneLocalShare();
                    setSharer(selfCid(), m.self.name || settings.displayName || 'You', true, tracks);
                } else {
                    localSharing = false;
                    SHARE_GEN++;   // share over — kill in-flight retry loops
                    SHARE_TRACK_ID = null;
                    clearSharer(selfCid());
                    pushState();
                }
            });

            const pj = m.participants && m.participants.joined;
            if (!pj || !pj.on) return;

            bind(pj, 'screenShareUpdate', (p) => {
                const cid = cidOf(p);
                const t = p.screenShareTracks || {};
                console.info('[share] REMOTE screenShareUpdate from', p.name, cid,
                    'enabled=' + p.screenShareEnabled,
                    'video=' + (t.video ? `${t.video.readyState}` : 'none'),
                    'audio=' + (t.audio ? `${t.audio.readyState}` : 'none'));
                if (p.screenShareEnabled) {
                    setSharer(cid, p.name || 'Someone', false, p.screenShareTracks);
                } else {
                    clearSharer(cid);
                }
            });
            bind(pj, 'participantLeft', (p) => clearSharer(cidOf(p)));
            // Someone already sharing when they (or we) arrive.
            bind(pj, 'participantJoined', (p) => {
                if (p.screenShareEnabled) {
                    setSharer(cidOf(p), p.name || 'Someone', false, p.screenShareTracks);
                }
            });
            try {
                (pj.toArray ? pj.toArray() : []).forEach((p) => {
                    if (p.screenShareEnabled) {
                        setSharer(cidOf(p), p.name || 'Someone', false, p.screenShareTracks);
                    }
                });
            } catch (e) {}
        }

        // The source must already be chosen (main process holds the selection)
        // before this runs — enableScreenShare triggers getDisplayMedia at once.
        function startShare() {
            if (!meeting || !meeting.self || !meeting.self.enableScreenShare) {
                on.onError('screen sharing is unavailable — join voice first');
                return Promise.resolve(false);
            }
            return Promise.resolve(meeting.self.enableScreenShare())
                .then(() => true)
                .catch((e) => {
                    const msg = (e && e.message) || String(e);
                    // A cancelled picker isn't an error worth shouting about.
                    if (!/denied|cancel|abort|NotAllowed/i.test(msg)) {
                        on.onError('could not start sharing — ' + msg);
                    }
                    return false;
                });
        }

        // Note SHARE_TRACK_ID is cleared here as well as on the SDK's disabled
        // event: relying on that event alone left a stale id behind whenever it
        // was delayed or dropped.
        function stopShare() {
            SHARE_GEN++;   // stop any quality-retry loop before the SDK winds down
            SHARE_TRACK_ID = null;
            try {
                if (meeting && meeting.self && meeting.self.disableScreenShare) {
                    Promise.resolve(meeting.self.disableScreenShare()).catch(() => {});
                }
            } catch (e) {}
            localSharing = false;
            clearSharer(selfCid());
            pushState();
        }

        // ---- transmission gate -------------------------------------------

        let pttHeld = false;

        // Shared by the engine and the Settings mic test, so the meter is
        // calibrated against the same processing chain the call actually uses.
        function browserNoiseSuppression() {
            if (settings.noiseSuppressionAI) return false;   // RNNoise owns it
            return settings.noiseSuppression !== false;
        }

        function micTestConstraints() {
            const audio = {
                echoCancellation: settings.echoCancellation !== false,
                autoGainControl: !!settings.autoGainControl,
                noiseSupression: browserNoiseSuppression(),
                noiseSuppression: browserNoiseSuppression()
            };
            if (settings.micDeviceId) audio.deviceId = { exact: settings.micDeviceId };
            return { audio };
        }

        function modeAllowsTransmit() {
            if (settings.voiceMode === 'ptt') return pttHeld;
            return true;
        }

        function applyTransmit() {
            const want = !muted && modeAllowsTransmit();
            if (want === lastTransmit) return;
            lastTransmit = want;
            try {
                if (meeting && meeting.self) {
                    const fn = want ? meeting.self.enableAudio : meeting.self.disableAudio;
                    if (fn) {
                        // These return promises. A bare try/catch only sees a
                        // synchronous throw, so a failure became an unhandled
                        // rejection while lastTransmit had ALREADY been set to
                        // the state we only hoped for, and the equality guard
                        // above then blocked every retry.
                        //
                        // Both directions can fail, and they fail into opposite
                        // states: acquiring the mic (device unplugged,
                        // permission revoked) leaves us silent, while failing to
                        // release it leaves audio still going out. Reporting
                        // "idle" for the second one put a calm microphone icon
                        // over a live mic.
                        Promise.resolve(fn.call(meeting.self)).catch((e) => {
                            // Either value differs from `want`, so the retry is
                            // unblocked as well.
                            if (lastTransmit === want) lastTransmit = want ? null : true;
                            fail('microphone', e);
                            pushState();
                        });
                    }
                }
            } catch (e) { /* SDK will re-sync on the next state event */ }
            pushState();
        }

        // ---- join / leave ------------------------------------------------

        // Bumped by every leave(). A join() re-checks it after each await so a
        // leave that raced an in-flight join (tray "Leave voice", session
        // expiry) actually sticks — without this the pending init resolved,
        // reassigned `meeting`, and reconnected the user with a hot mic AFTER
        // they left.
        let joinGen = 0;

        // Join timings, so "it feels slow" can be answered with numbers rather
        // than guesses. Visible in devtools (npm run dev).
        const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
        function mark(what, from) {
            try { console.info('[voice] ' + what + ': ' + Math.round(now() - from) + 'ms'); } catch (e) {}
        }

        async function join() {
            if (joined || joining) return;
            joining = true;
            const gen = joinGen;
            const tStart = now();
            pushState();

            try {
                // TOGETHER, not one after the other. The SDK is 647 KB read off
                // disk and parsed; the token is a round trip to the board and,
                // behind that, to Cloudflare's API. Neither needs anything from
                // the other, and running them in series simply added the two
                // waits together.
                //
                // (The SDK is fetched on first use rather than at startup —
                // 647 KB parsed before the window can appear, for a feature
                // plenty of sessions never touch. By the time this runs,
                // voice.js and noise.js have long since installed their
                // RTCPeerConnection / getDisplayMedia / getUserMedia patches.
                // ScarmLazy caches, so a warmed SDK resolves instantly here —
                // see the hover warm-up in app.js.)
                const tSdk = now();
                const [SDK, res] = await Promise.all([
                    window.ScarmLazy.realtimekit(),
                    window.lounge.voiceToken({
                        clientId: settings.clientId,
                        name: settings.displayName || 'Anonymous'
                    })
                ]);
                mark('sdk+token', tSdk);
                if (gen !== joinGen) return;   // left while we awaited
                if (!SDK) throw new Error('RealtimeKit SDK failed to load');
                if (!res || !res.success || !res.token) {
                    throw new Error((res && res.error) || 'could not get a voice token');
                }

                const audioCfg = {
                    echoCancellation: settings.echoCancellation !== false,
                    autoGainControl: !!settings.autoGainControl,
                    // The SDK reads the MISSPELLED getUserMedia key (one 's').
                    // Pass both so today's build and any future fix both work.
                    //
                    // Chromium's own suppressor is turned OFF when RNNoise is
                    // doing the job: cascading two of them is the classic cause
                    // of pumping and chewed-up consonants, and the browser's runs
                    // upstream so the model only ever sees an already-mangled
                    // signal. Every ML-suppression product does the same.
                    noiseSupression: browserNoiseSuppression(),
                    noiseSuppression: browserNoiseSuppression(),
                    enableHighBitrate: true
                };
                // 'ideal', not 'exact': a saved mic that has since been unplugged
                // made the WHOLE join fail with OverconstrainedError instead of
                // quietly falling back to the default device.
                if (settings.micDeviceId) audioCfg.deviceId = { ideal: settings.micDeviceId };

                const tInit = now();
                const m = await SDK.init({
                    authToken: res.token,
                    defaults: {
                        // In push-to-talk, start with the mic off so joining never
                        // leaks a moment of audio before the gate is applied.
                        audio: settings.voiceMode !== 'ptt',
                        video: false,
                        mediaConfiguration: {
                            audio: audioCfg,
                            // Permissive upper bound only. The active tier+motion is
                            // re-applied per share by tuneLocalShare(), so 1440p/60
                            // must not be pre-capped here.
                            screenshare: {
                                width: { max: 2560 },
                                height: { max: 1440 },
                                frameRate: { ideal: 30, max: 60 }
                            }
                        }
                    }
                });

                mark('sdk.init', tInit);
                if (gen !== joinGen) {
                    // Left while init was pending — discard the fresh meeting.
                    try { if (m.leave) m.leave(); else if (m.leaveRoom) m.leaveRoom(); } catch (_) {}
                    return;
                }
                meeting = m;

                meetingRef = m;

                wire(meeting);
                const joinFn = meeting.join || meeting.joinRoom;
                const tJoin = now();
                await joinFn.call(meeting);
                mark('room join', tJoin);
                if (gen !== joinGen) {
                    try { if (m.leave) m.leave(); else if (m.leaveRoom) m.leaveRoom(); } catch (_) {}
                    if (meeting === m) meeting = null;
                    return;
                }

                joined = true;
                joining = false;
                muted = false;
                lastTransmit = null;

                // YOU ARE IN THE CALL HERE. Audio is flowing, so the UI is told
                // now — everything below is tuning, and none of it changes that.
                //
                // It used to be told at the END, after selectSavedMic(), which
                // enumerates devices and can re-acquire the microphone. So the
                // "Connecting..." state outlived the connection by however long
                // that took, and joining felt seconds slower than it was.

                // Speaking meters read 0.0 forever if the shared context is
                // suspended when the analysers are built.
                try { if (window.ScarmAudio) window.ScarmAudio.resume(); } catch (e) {}
                // Stays ahead of the paint: this is the difference between an
                // open microphone and a closed one, not a matter of tuning.
                applyTransmit();
                applyAllLocalAudio();
                watchLocal();
                render();
                pushState();
                mark('TOTAL to connected', tStart);

                startRtt();

                // ---- everything past here is tuning, off the critical path ---
                //
                // The saved microphone has to be selected THROUGH THE SDK. The
                // deviceId in mediaConfiguration.audio above is never read for
                // device selection — the SDK takes the device as an argument to
                // its constraints builder, sourced only from self.setDevice() —
                // so without this the call silently used audioInputDevices[0]
                // while the Settings meter dutifully metered the chosen one.
                //
                // Device enumeration is slow, which is precisely why it is no
                // longer awaited in front of the UI. selectSavedMic re-checks
                // the generation internally, because a session expiring during
                // it would otherwise resume and call setDevice() on a meeting
                // leave() had already discarded — re-opening the microphone
                // behind the login gate.
                selectSavedMic(gen).then(() => {
                    if (gen !== joinGen) return;
                    // Bandwidth priority: without this, audio and a multi-megabit
                    // screen share compete as equals on the same bundle, and
                    // voice is what breaks up when the uplink saturates. After
                    // the mic swap, because that replaces the sender it applies to.
                    applyStreamPriorities();
                }).catch(() => {});

                // Remote participants arrive shortly after join; re-render so the
                // roster reflects who is actually peered rather than just present.
                setTimeout(render, 4000);
            } catch (e) {
                if (gen !== joinGen) return;   // leave() already cleaned up
                joining = false;
                joined = false;
                // wire() ran before joinFn, so a join that throws leaves this
                // meeting's handlers attached — and leave() cannot collect them
                // later because it returns early on (!joined && !joining), which
                // the two lines above have just made true. They close over the
                // live audioEls/sharers maps, so a late event from the abandoned
                // meeting would detach a NEXT session's participant: someone
                // still in the call, silenced by a listener from a failed one.
                unwire();
                try { if (meeting && meeting.leave) meeting.leave(); } catch (_) {}
                meeting = null;

                meetingRef = null;
                pushState();
                fail('join', e);
                throw e;
            }
        }

        // Point the SDK at the microphone the user picked in Settings.
        //
        // Best-effort by design: an unplugged or renamed device just leaves the
        // SDK on its default rather than failing the join.
        //
        // `gen` is the caller's join generation. Both awaits below outlive a
        // leave(), and `self` is captured BEFORE them — so nulling `meeting` in
        // leave() does not stop this function; only the generation check does.
        // setDevice() acquires the microphone, so running it after teardown is
        // the hot-mic-behind-the-login-gate case joinGen exists to prevent.
        async function selectSavedMic(gen) {
            const want = settings.micDeviceId;
            if (!want || !meeting || !meeting.self) return;
            try {
                const self = meeting.self;
                if (typeof self.getAudioDevices !== 'function' || typeof self.setDevice !== 'function') return;
                const devices = await self.getAudioDevices();
                if (gen !== joinGen) return;
                const match = (devices || []).find((d) => d && d.deviceId === want);
                if (!match) {
                    console.warn('[voice] saved microphone is not present — staying on the default');
                    return;
                }
                const current = self.audioTrack && self.audioTrack.getSettings
                    ? self.audioTrack.getSettings().deviceId : null;
                if (current === want) return;      // already on it
                await self.setDevice(match);
                console.info('[voice] microphone set to', match.label || want);
            } catch (e) {
                console.warn('[voice] could not select the saved microphone:', e && e.message);
            }
        }

        // Tell Chromium which stream to protect when the uplink is congested.
        // Audio is the one that must survive; a screen share degrading is
        // recoverable, a chopped voice call is not.
        function applyStreamPriorities() {
            prunePCS();
            const shareId = SHARE_TRACK_ID;
            PCS.forEach((pc) => {
                if (!pc || typeof pc.getSenders !== 'function') return;
                let senders;
                try { senders = pc.getSenders(); } catch (e) { return; }
                senders.forEach((sender) => {
                    if (!sender || !sender.track) return;
                    const isAudio = sender.track.kind === 'audio';
                    const isShare = shareId && sender.track.id === shareId;
                    if (!isAudio && !isShare) return;     // leave the camera alone
                    try {
                        const p = sender.getParameters();
                        // setParameters rejects an encodings array of a different
                        // length than getParameters returned, so never fabricate one.
                        if (!p.encodings || !p.encodings.length) return;
                        p.encodings.forEach((enc) => {
                            enc.networkPriority = isAudio ? 'high' : 'low';
                            enc.priority = isAudio ? 'high' : 'low';
                        });
                        Promise.resolve(sender.setParameters(p)).catch(() => {});
                    } catch (e) { /* unsupported here — the default stands */ }
                });
            });
        }

        // Analyse our own published track so the local speaking dot is honest
        // about what everyone else actually receives.
        function watchLocal() {
            if (!meeting || !meeting.self) return;
            let track = meeting.self.audioTrack;
            if (!track && typeof meeting.self.getAudioTracks === 'function') {
                const arr = meeting.self.getAudioTracks();
                if (arr && arr.length) track = arr[0];
            }
            const cid = cidOf(meeting.self);
            if (!track || !cid) return;
            try { watchSpeaking(cid, new MediaStream([track]), true); } catch (e) {}
        }

        function leave() {
            if (!joined && !joining) return;
            joinGen++;   // invalidate any join() still in flight
            // Detach before leaving: the SDK keeps emitting during its own async
            // teardown, and those handlers close over module state with no
            // generation check — a late audioUpdate or screenShareUpdate would
            // rebuild the very hidden <audio> elements and share entries this
            // function is clearing, and they would then survive until the next
            // leave.
            unwire();
            try {
                if (meeting) {
                    if (meeting.leave) meeting.leave();
                    else if (meeting.leaveRoom) meeting.leaveRoom();
                }
            } catch (e) { /* leaving is best-effort */ }

            meeting = null;


            meetingRef = null;
            // Peer connections from this session are closed now; dropping them
            // here keeps the registry from growing across join/leave cycles that
            // never screen-share (the only path that used to prune it).
            prunePCS();
            SHARE_TRACK_ID = null;
            SHARE_GEN++;
            stopRtt();
            // Re-armed so the next join logs its SFU peer diagnostic even if the
            // roster comes back identical.
            lastRosterSig = '';
            joined = false;
            joining = false;
            muted = false;
            deafened = false;
            mutedBeforeDeafen = false;
            pttHeld = false;
            lastTransmit = null;
            localSharing = false;
            sharers.clear();
            camStreams.clear();
            Object.keys(shareAudioEls).forEach(detachShareAudio);
            on.onShares([]);
            // Cameras are torn down with the meeting; without this the tiles (and
            // the stage entries that follow them) would linger after leaving.
            on.onCams([]);

            stopAllSpeaking();
            Object.keys(audioEls).forEach((cid) => {
                dropGain(cid);
                try { audioEls[cid].srcObject = null; audioEls[cid].remove(); } catch (e) {}
                delete audioEls[cid];
                delete audioTrackIds[cid];
            });

            on.onParticipants([]);
            pushState();
        }

        // ---- public API --------------------------------------------------

        return {
            join,
            leave,
            state,
            roster,
            micTestConstraints,

            startShare,
            stopShare,
            isSharing: () => localSharing,
            shares: shareList,

            enableCam,
            disableCam,
            isCamOn,
            toggleCam: () => (isCamOn() ? disableCam() : enableCam()),
            cams: camList,

            // Changing tier/motion mid-share re-applies capture + encoder params
            // without interrupting the stream.
            setShareQuality(q) {
                if (!SHARE_TIERS[q]) return;
                shareQuality = q;
                if (localSharing) tuneLocalShare();
                pushState();
            },
            setShareMotion(m) {
                if (m !== 'sharp' && m !== 'smooth') return;
                shareMotion = m;
                if (localSharing) tuneLocalShare();
                pushState();
            },

            setSettings(next) {
                const prevSpeaker = settings.speakerDeviceId;
                settings = Object.assign({}, next || {});
                if (SHARE_TIERS[settings.shareQuality]) shareQuality = settings.shareQuality;
                if (settings.shareMotion === 'smooth' || settings.shareMotion === 'sharp') {
                    shareMotion = settings.shareMotion;
                }
                if (settings.speakerDeviceId !== prevSpeaker) {
                    Object.values(audioEls).forEach(applySinkId);
                    Object.values(shareAudioEls).forEach(applySinkId);
                    // Boosted participants play through the shared context, not
                    // through their <audio> element, so it needs the same sink —
                    // otherwise turning someone above 100% moved them to the
                    // system default output.
                    window.ScarmAudio.setSinkId(settings.speakerDeviceId);
                }
                applyAllLocalAudio();
                applyTransmit();
            },

            setMuted(v) {
                muted = !!v;
                // Unmuting while deafened also undeafens (what every voice
                // client does) — the old behaviour let you transmit while
                // unable to hear anyone, then undeafen silently re-muted you
                // from the stale saved state.
                if (!muted && deafened) {
                    deafened = false;
                    mutedBeforeDeafen = false;
                    applyAllLocalAudio();
                }
                applyTransmit();
                render();
                pushState();
            },
            toggleMuted() { this.setMuted(!muted); return muted; },

            setDeafened(v) {
                const next = !!v;
                if (next === deafened) return;
                // Deafening also stops you transmitting — what every other voice
                // client does. Undeafening restores whatever mute state you had.
                if (next) { mutedBeforeDeafen = muted; muted = true; }
                else muted = mutedBeforeDeafen;
                deafened = next;
                applyTransmit();
                applyAllLocalAudio();
                render();
                pushState();
            },
            toggleDeafened() { this.setDeafened(!deafened); return deafened; },

            // Push-to-talk gate. Driven by the global hook (main process) or by
            // in-window key events, whichever fires first.
            setPttHeld(v) {
                if (pttHeld === !!v) return;
                pttHeld = !!v;
                applyTransmit();
            },

            setLocalVolume(cid, vol) {
                if (!settings.localVolumes) settings.localVolumes = {};
                settings.localVolumes[cid] = vol;
                applyLocalAudio(cid);
                applyShareAudio(cid);
            },
            setLocalMuted(cid, v) {
                if (!settings.localMuted) settings.localMuted = {};
                if (v) settings.localMuted[cid] = true; else delete settings.localMuted[cid];
                applyLocalAudio(cid);
                applyShareAudio(cid);
                render();
            },

            isJoined: () => joined,
            // The last sample, or null. Read live by the panel's tooltip so the
            // number under the pointer is the freshest one taken.
            rtt: () => rttMs,

            // Everything the details panel shows. The average is over the
            // samples we actually took — gaps are skipped rather than counted
            // as zero, which would drag it down every time a sample failed.
            connection() {
                const taken = rttHistory.filter((v) => v !== null);
                const avg = taken.length
                    ? Math.round(taken.reduce((a, b) => a + b, 0) / taken.length) : null;
                return {
                    rtt: rttMs,
                    avgRtt: avg,
                    history: rttHistory.slice(),
                    samples: taken.length,
                    lossPct: conn ? conn.lossPct : null,
                    candidate: conn ? conn.candidate : null,
                    protocol: conn ? conn.protocol : null,
                    remote: conn ? conn.remote : null,
                    codec: conn ? conn.codec : null,
                    peers: conn ? conn.peers : 0,
                    joined
                };
            },
            // A join in flight is neither joined nor idle. Callers that tear the
            // session down need to see this state, or the pending join resolves
            // after they've finished cleaning up and opens the mic behind them.
            isJoining: () => joining,
            isMuted: () => muted,
            isDeafened: () => deafened
        };
    }

    window.createVoice = createVoice;
})();
