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
    // Opus DTX is stripped from every session description that passes through.
    //
    // The SDK's transport switches DTX on unconditionally: its handler defaults
    // enableDtx to TRUE, and its own config normalizer forwards only
    // enableStereo/enableHighBitrate from mediaConfiguration.audio — the flag is
    // dropped before it can reach the transport, so there is no configuration
    // that turns it off. The SDP is the one place left to say no.
    //
    // Why no: DTX stops sending packets whenever opus's voice-activity detector
    // decides you are silent. Behind RNNoise that detector is wrong a lot — the
    // suppressor strips the signal down so far that quiet word-endings, trailing
    // consonants and low talkers drop below the threshold mid-sentence, and the
    // stream cuts in and out around the edges of speech. What the other end
    // hears is the reported "voice randomly goes robotic": chopped tails,
    // metallic re-entry, comfort-noise glitches — coming and going with how
    // quietly the person happens to be speaking. The saving DTX buys is a few
    // kbps during silence; the mic track this app publishes is already mono
    // 64kbps, so the trade is all cost.
    function stripDtx(desc) {
        try {
            if (!desc || !desc.sdp || desc.sdp.indexOf('usedtx=1') === -1) return desc;
            // Both positions, so no dangling semicolon is left either way.
            const sdp = desc.sdp.replace(/;usedtx=1/g, '').replace(/usedtx=1;?/g, '');
            return { type: desc.type, sdp };
        } catch (e) { return desc; }
    }

    (function patchRTC() {
        try {
            const Native = window.RTCPeerConnection || window.webkitRTCPeerConnection;
            if (!Native || Native.__loungeWrapped) return;
            const Wrapped = function (cfg, con) {
                const pc = (arguments.length > 1) ? new Native(cfg, con) : new Native(cfg);
                try { PCS.push(pc); } catch (e) {}
                // Munged on BOTH descriptions: the local one governs what we
                // offer to send, the remote one what the far side believes was
                // agreed. Missing either lets DTX survive the negotiation.
                try {
                    const sld = pc.setLocalDescription.bind(pc);
                    // setLocalDescription() with no argument is legal (implicit
                    // rollback/answer) and must stay a no-argument call.
                    pc.setLocalDescription = (desc) =>
                        (desc === undefined ? sld() : sld(stripDtx(desc)));
                    const srd = pc.setRemoteDescription.bind(pc);
                    pc.setRemoteDescription = (desc) => srd(stripDtx(desc));
                } catch (e) { /* an SDP left alone still works — with DTX */ }
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
            // How many RTCPeerConnections are live — NOT how many people are in
            // the call. mediasoup opens one transport per direction, so this is
            // 2 for a call with one other person in it and 2 for a call with
            // eight. Named for what it counts, because it used to be read as a
            // participant count and used to decide a security claim.
            pcs: 0
        };
        for (const pc of PCS) {
            if (!pc || typeof pc.getStats !== 'function') continue;
            if (pc.connectionState === 'closed' || pc.connectionState === 'failed') continue;
            let stats;
            try { stats = await pc.getStats(); } catch (e) { continue; }
            out.pcs++;

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
        // What the SDK has actually been TOLD, as opposed to lastTransmit, which
        // is what we want. null = never told. See applyTransmit.
        let txSent = null;
        // enableAudio/disableAudio share one lock in the SDK and it is not a
        // queue — see applyTransmit. Everything goes through this chain instead.
        let txChain = Promise.resolve();
        // The saved microphone still has to be selected, but the mic is shut and
        // selecting it would open it — see the join path. Cleared the first time
        // the mic is legitimately open.
        let micPending = false;

        let localSharing = false;
        // Every live presenter, keyed by participant id. The SFU happily carries
        // several screen shares at once; which one you WATCH is a viewer-side
        // choice made in the UI, so the engine keeps them all published.
        const sharers = new Map();  // cid -> { id, name, isLocal, stream, sig }

        let settings = {};
        const audioEls = {};        // cid -> HTMLAudioElement
        const shareAudioEls = {};   // cid -> HTMLAudioElement carrying that share's audio
        const shareAudioIds = {};   // cid -> the track id currently attached to it
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
            // A join that fails INSIDE the automatic reconnect is narrated by
            // the reconnect itself — "reconnecting…", then one verdict at the
            // end. Toasting each failed attempt as well put three red errors
            // in front of somebody the app was actively fixing things for.
            if (rejoining && where === 'join') return;
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

        // '' is the VALID sinkId for "the system default output" — it is what
        // both the speaker popover and the Settings dropdown write for
        // "Windows Default". Skipping on a falsy id left every <audio> pinned
        // to whichever device had been chosen before, with no way back short of
        // picking a different explicit one.
        function applySinkId(el) {
            if (typeof el.setSinkId !== 'function') return;
            el.setSinkId(settings.speakerDeviceId || '').catch(() => {});
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
            // Guarded on track identity for the same reason attachAudio is: the
            // SDK re-fires screenShareUpdate for unrelated reasons, and the
            // video half already reuses its stream on an unchanged signature.
            // Rebuilding srcObject and re-play()ing on every one of those is an
            // audible drop in the presenter's audio for every listener, while
            // the picture stays perfectly smooth — which is why it read as a
            // network problem rather than a bug here.
            if (shareAudioIds[cid] === track.id) { applyShareAudio(cid); return; }
            try { el.srcObject = new MediaStream([track]); } catch (e) { return; }
            shareAudioIds[cid] = track.id;
            applyShareAudio(cid);
            el.play().catch(() => {});
        }

        function detachShareAudio(cid) {
            // Cleared even when there is no element, so a share that stops and
            // restarts on the same track id still rebuilds — see attachAudio's
            // matching delete for why a stale id is worse than none.
            delete shareAudioIds[cid];
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

            // THE ROOM DIED AND THE SDK GAVE UP. Everything above handles the
            // recoveries; this is the failure. When the room socket drops for
            // good the SDK emits roomLeft with state 'disconnected', and when
            // its own recovery fails it emits state 'failed' with "SDK
            // re-initialization is required" in the log — and then nothing.
            //
            // Nothing here listened. So `joined` stayed true, the presence
            // heartbeat went on announcing a call this client was no longer in,
            // and the person sat in everyone's roster greyed out behind the
            // warning triangle, hearing nothing, indefinitely — the reported
            // "random voice disconnect". The SDK told us; we just weren't
            // listening.
            //
            // A deliberate leave never reaches this handler: leave() unwires
            // every subscription before it calls meeting.leave(), so any
            // roomLeft that lands on a live handler is the SDK acting alone.
            bind(m.self, 'roomLeft', (d) => {
                const why = (d && d.state) || 'unknown';
                if (!joined) return;
                // Being removed is an answer, not an outage — rejoining would
                // fight the moderator who did it. The app's own kick flow
                // (voicekick over realtime) already tears down before this can
                // fire; this covers the SFU doing it directly.
                if (why === 'kicked' || why === 'rejected') {
                    leave();
                    fail('call', new Error('removed from the call'));
                    return;
                }
                // 'disconnected' / 'failed': re-initialization is required, so
                // that is exactly what happens — automatically.
                scheduleRejoin(why);
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

        // One call into sounds.js, guarded — a missing or failed sound must
        // never touch call state.
        function uiSound(kind) {
            try {
                if (window.loungeSounds && window.loungeSounds.playUi) window.loungeSounds.playUi(kind);
            } catch (e) {}
        }

        // `quiet` marks a share DISCOVERED rather than STARTED — one already
        // running when we arrived. The start sound announces the moment someone
        // begins sharing, and every client in the call plays its own copy off
        // this event, which is what scopes it to the call: nobody outside it
        // receives the event at all. The SDK re-fires screenShareUpdate for
        // unrelated reasons, so `prev` is what keeps one share to one sound.
        function setSharer(id, name, isLocal, tracks, quiet) {
            if (!id) return;
            const prev = sharers.get(id);
            const sig = trackSig(tracks);
            const stream = (prev && prev.sig === sig) ? prev.stream : buildShareStream(tracks);
            sharers.set(id, { id, name, isLocal, stream, sig });
            // Your own share's audio is already coming out of your speakers.
            if (!isLocal) attachShareAudio(id, tracks);
            if (!prev && !quiet) uiSound('share-start');
            pushShares();
        }

        function clearSharer(id) {
            if (!id || !sharers.delete(id)) return;
            detachShareAudio(id);
            // The delete above already answered "was there a share to end?", so
            // a re-fired disable event can never sound twice — and a sharer who
            // leaves the call mid-share ends their share as audibly as stopping
            // it would have.
            uiSound('share-stop');
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
            // Someone already sharing when they (or we) arrive. `quiet` — these
            // are shares being discovered, not started, and the start sound
            // marks the moment of starting.
            bind(pj, 'participantJoined', (p) => {
                if (p.screenShareEnabled) {
                    setSharer(cidOf(p), p.name || 'Someone', false, p.screenShareTracks, true);
                }
            });
            try {
                (pj.toArray ? pj.toArray() : []).forEach((p) => {
                    if (p.screenShareEnabled) {
                        setSharer(cidOf(p), p.name || 'Someone', false, p.screenShareTracks, true);
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
            // Held across the await: leaving the call nulls `meeting`, and
            // reading meeting.self afterwards would throw into the catch below
            // and put a raw TypeError in front of the user.
            const self = meeting.self;
            return Promise.resolve(self.enableScreenShare())
                .then(() => {
                    // A RESOLVED PROMISE IS NOT A STARTED SHARE.
                    //
                    // The SDK's LocalMediaHandler.enableScreenShare wraps
                    // getScreenShareTracks in `try { … } catch (i) {}` — an
                    // empty catch — so a denied or failed getDisplayMedia is
                    // swallowed whole. Self.enableScreenShare then guards its
                    // own work on `screenShareTracks.audio || …video`, so with
                    // no capture it skips the transport, skips the
                    // screenShareUpdate emit, and returns normally. The .catch
                    // below was therefore dead code for the exact case its
                    // comment described: startShare answered `true`, nothing
                    // was ever shared, localSharing stayed false (only the
                    // screenShareUpdate handler sets it) and the user got no
                    // picture, no error and no explanation.
                    //
                    // The same silent path covers a source that has since
                    // closed (main.js answers the request with `{}`) and a
                    // RealtimeKit preset whose canProduceScreenshare is
                    // NotAllowed. Ask the SDK what actually happened instead —
                    // this is the same test it gates its own emit on.
                    const t = self.screenShareTracks || {};
                    const ok = !!(self.screenShareEnabled || t.video || t.audio);
                    if (!ok) {
                        console.warn('[share] enableScreenShare resolved without a capture');
                        on.onError('could not start sharing — the screen capture did not start');
                    }
                    return ok;
                })
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

        // The one place the microphone is opened and closed.
        //
        // SERIALISED, and that is the whole point. meeting.self.enableAudio and
        // meeting.self.disableAudio share a single lock in the SDK
        // ("Self.toggleAudio"), and that lock is NOT a queue: a second call while
        // the first is outstanding throws UnsupportedConcurrentMethodExecution
        // SYNCHRONOUSLY, and the lock is held until the first one's promise
        // settles — through the real getUserMedia, the RNNoise worklet, the
        // soundboard mix and the publish to the SFU. That is hundreds of
        // milliseconds on the first acquisition of a session.
        //
        // A push-to-talk TAP is shorter than that. The press called enableAudio;
        // the release called disableAudio inside the lock window, the throw was
        // swallowed by the bare try/catch this used to have, and lastTransmit had
        // already been set to false — so the gate believed the microphone was
        // closed, refused every later attempt on the equality guard, and the mic
        // stayed OPEN and transmitting for the rest of the call under an idle
        // microphone icon. Pressing Mute in that same window failed the same way.
        //
        // So: one chain, and each step re-reads the CURRENT intent rather than
        // the one that queued it, so a release always runs after the acquisition
        // it is cancelling and a stale queued call is dropped instead of undoing
        // a newer decision. txSent tracks what the engine was actually told, so
        // nothing is sent twice.
        function applyTransmit() {
            const want = !muted && modeAllowsTransmit();
            if (want === lastTransmit) return;
            lastTransmit = want;
            txChain = txChain.then(() => {
                if (!meeting || !meeting.self) return null;
                const target = lastTransmit;
                // Not a boolean means an earlier call failed and the real state is
                // unknown; the next deliberate change drives it.
                if (typeof target !== 'boolean' || target === txSent) return null;
                const fn = target ? meeting.self.enableAudio : meeting.self.disableAudio;
                if (!fn) return null;
                // Called INSIDE the then-callback, so a synchronous throw rejects
                // the chain and reaches the recovery below instead of escaping to
                // a catch that could only ignore it.
                return Promise.resolve(fn.call(meeting.self)).then(() => { txSent = target; });
            }).then(() => {
                // The deferred device selection, from the PTT join above. Runs
                // the first time the microphone is actually open, and inside
                // this chain so it is ordered against enable/disable rather than
                // racing the SDK's toggleAudio lock. selectSavedMic swallows its
                // own failures, so it can never break the chain — and with the
                // track now reporting its real deviceId (see
                // ScarmLib.inheritDeviceId) it does nothing at all when the SDK
                // already landed on the saved microphone, which is the usual case
                // and what keeps the first press free of a device swap.
                if (!micPending || lastTransmit !== true) return null;
                micPending = false;
                return selectSavedMic(joinGen).then(() => applyStreamPriorities());
            }).catch((e) => {
                // Both directions can fail, and they fail into opposite states:
                // acquiring the mic (device unplugged, permission revoked) leaves
                // us silent, while failing to release it leaves audio still going
                // out. Reporting "idle" for the second one put a calm microphone
                // icon over a live mic. Either value below differs from `want`, so
                // the equality guard no longer blocks the retry.
                if (lastTransmit === want) lastTransmit = want ? null : true;
                fail('microphone', e);
                pushState();
            });
            pushState();
        }

        // ---- join / leave ------------------------------------------------

        // Bumped by every leave(). A join() re-checks it after each await so a
        // leave that raced an in-flight join (tray "Leave voice", session
        // expiry) actually sticks — without this the pending init resolved,
        // reassigned `meeting`, and reconnected the user with a hot mic AFTER
        // they left.
        let joinGen = 0;

        // A participant token, minted BEFORE the click.
        //
        // Measured: this round trip is a flat ~820ms of a ~2.2s join — the
        // single largest fixed cost, and identical on every join, because it is
        // not the SDK load (which caches) but the request behind it: the board,
        // and then Cloudflare's RealtimeKit API to add a participant. Only about
        // 110ms of that is the network from here.
        //
        // None of it needs the click. So it is fetched when somebody looks like
        // they are heading for a call, and the click spends it already in hand.
        const TOKEN_FRESH_MS = 120000;   // well inside the token's own lifetime
        let tokenAhead = null;           // { at, promise }

        function mintToken() {
            return window.lounge.voiceToken({
                clientId: settings.clientId,
                name: settings.displayName || 'Anonymous'
            });
        }

        // Idempotent and cheap to call: a token already in flight or recently
        // minted is reused, so hovering the voice channel repeatedly does not
        // mint a participant each time.
        function prefetchToken() {
            if (joined || joining) return;
            if (tokenAhead && (now() - tokenAhead.at) < TOKEN_FRESH_MS) return;
            const t = now();
            const entry = { at: t, promise: mintToken() };
            tokenAhead = entry;
            // Logged so the warm-up is checkable after the fact rather than
            // inferred from whether the join that followed happened to be fast.
            entry.promise.then(
                () => mark('warm token ready', t),
                () => { if (tokenAhead === entry) tokenAhead = null; }
            );
        }

        // The token to join with, and whether it was one we had lying about —
        // which is what decides whether a failed init is worth retrying.
        async function takeToken() {
            const held = tokenAhead;
            tokenAhead = null;
            if (held && (now() - held.at) < TOKEN_FRESH_MS) {
                try {
                    const res = await held.promise;
                    if (res && res.success && res.token) return { res, ahead: true };
                } catch (e) { /* fall through and mint a fresh one */ }
            }
            return { res: await mintToken(), ahead: false };
        }

        // Join timings, so "it feels slow" can be answered with numbers rather
        // than guesses. Visible in devtools (npm run dev).
        const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
        function mark(what, from) {
            const line = '[voice] ' + what + ': ' + Math.round(now() - from) + 'ms';
            try { console.info(line); } catch (e) {}
            // …and into the log file, so "joining feels slow" can be answered
            // from an installed build rather than only under `npm run dev`.
            try { window.lounge.app.log(line); } catch (e) {}
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
                const [SDK, tok] = await Promise.all([
                    window.ScarmLazy.realtimekit(),
                    takeToken()
                ]);
                mark('sdk+token', tSdk);
                if (gen !== joinGen) return;   // left while we awaited
                if (!SDK) throw new Error('RealtimeKit SDK failed to load');
                if (!tok.res || !tok.res.success || !tok.res.token) {
                    throw new Error((tok.res && tok.res.error) || 'could not get a voice token');
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
                // Built per attempt, because the retry below needs a fresh
                // token in the same shape.
                const initOpts = (authToken) => ({
                    authToken: authToken,
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

                let m;
                try {
                    m = await SDK.init(initOpts(tok.res.token));
                } catch (e) {
                    // A token minted ahead of the click is the one thing here
                    // that can have gone stale between minting and use. Anything
                    // else is a real failure and is rethrown untouched — but this
                    // is worth exactly one more try with a fresh token, because
                    // the alternative is an optimisation that can stop people
                    // joining at all.
                    if (!tok.ahead || gen !== joinGen) throw e;
                    console.warn('[voice] prefetched token rejected — minting a fresh one');
                    const fresh = await mintToken();
                    if (gen !== joinGen) return;
                    if (!fresh || !fresh.success || !fresh.token) throw e;
                    m = await SDK.init(initOpts(fresh.token));
                }

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
                txSent = null;              // a new engine has been told nothing
                micPending = false;         // decided a few lines below, per join

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
                // …but NOT while the microphone is meant to be shut.
                //
                // setDevice() is not a preference, it is an acquisition: the
                // vendored SDK's AudioMediaHandler.onSetDevice always runs a
                // fresh getUserMedia and merely hands back a track with
                // `enabled = false` when the track was disabled (its video
                // counterpart refuses the switch outright in that case; the
                // audio one has no such guard). So on a push-to-talk join —
                // where mediaConfiguration deliberately asks for audio:false and
                // applyTransmit() has just closed the mic — this reopened the
                // capture device and held it for the whole call. Somebody who
                // joined on PTT and never pressed the key still had the Windows
                // "microphone in use" indicator lit from join to leave.
                //
                // Deferred to the first time the mic is genuinely opened, in the
                // txChain below so it cannot race enable/disable.
                if (modeAllowsTransmit()) {
                    selectSavedMic(gen).then(() => {
                        if (gen !== joinGen) return;
                        // Bandwidth priority: without this, audio and a multi-megabit
                        // screen share compete as equals on the same bundle, and
                        // voice is what breaks up when the uplink saturates. After
                        // the mic swap, because that replaces the sender it applies to.
                        applyStreamPriorities();
                    }).catch(() => {});
                } else {
                    micPending = true;
                    applyStreamPriorities();
                }

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
            // A deferred mic selection belongs to the call that deferred it; left
            // set, the next enable in a LATER call would spend it on a join that
            // had already chosen for itself.
            micPending = false;
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
            txSent = null;
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

        // ---- self-healing: rejoin a call the transport dropped -----------

        // The SDK's own recovery handles blips; this handles the give-up (see
        // the roomLeft binding in wireReconnect). Strategy: tear the dead
        // meeting down completely — leave() is the one honest teardown, and it
        // also stops the presence heartbeat lying about a call we are not in —
        // then rejoin from scratch on a short backoff, exactly as if the user
        // had clicked the channel again, and put their mute/deafen state back.
        //
        // Three attempts. The first at ~1s catches the router hiccup; the last
        // at ~15s total catches a Wi-Fi reassociation. Past that the network is
        // genuinely down and retrying forever would mint tokens against a dead
        // link — the person gets told, and the channel is one click away.
        let rejoining = false;
        const REJOIN_DELAYS_MS = [1200, 4000, 10000];

        // A notice is not an error: onError paints the red toast and this is
        // the app fixing itself. Falls back so an older app.js still hears it.
        function notify(msg) {
            try { (on.onNotice || on.onError)(msg); } catch (e) {}
        }

        function scheduleRejoin(why) {
            if (rejoining) return;
            rejoining = true;
            // What they had chosen, captured before leave() resets all three.
            const prevMuted = muted;
            const prevDeafened = deafened;
            const prevMBD = mutedBeforeDeafen;
            const line = '[voice] room lost (' + why + ') — reconnecting automatically';
            try { console.warn(line); window.lounge.app.log(line); } catch (e) {}
            notify('connection lost — reconnecting…');
            leave();

            let attempt = 0;
            const tryJoin = () => {
                if (!rejoining) return;
                // The user beat the timer — clicked the channel themselves.
                // Their join is the fresh state they asked for; stand down.
                if (joined || joining) { rejoining = false; return; }
                join().then(() => {
                    rejoining = false;
                    // The same call resuming, not a user action: state is put
                    // back directly, with none of the action sounds.
                    if (prevMuted || prevDeafened) {
                        muted = prevMuted;
                        deafened = prevDeafened;
                        mutedBeforeDeafen = prevMBD;
                        applyTransmit();
                        applyAllLocalAudio();
                        render();
                        pushState();
                    }
                    try { window.lounge.app.log('[voice] reconnected after room loss'); } catch (e) {}
                    notify('reconnected');
                }).catch(() => {
                    attempt++;
                    if (attempt < REJOIN_DELAYS_MS.length) {
                        setTimeout(tryJoin, REJOIN_DELAYS_MS[attempt]);
                    } else {
                        rejoining = false;
                        try { window.lounge.app.log('[voice] could not reconnect after room loss'); } catch (e) {}
                        fail('reconnect', new Error('could not reconnect — rejoin when your connection is back'));
                    }
                });
            };
            setTimeout(tryJoin, REJOIN_DELAYS_MS[0]);
        }

        // ---- public API --------------------------------------------------

        return {
            join,
            leave,
            state,
            roster,
            micTestConstraints,
            // Mint the participant token ahead of the click. See prefetchToken.
            warm: prefetchToken,

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
                const was = muted;
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
                // Local by nature: the sound plays here and is never
                // transmitted, so only the person muting hears it. One sound
                // per actual change — and the unmute-that-undeafens above says
                // 'unmute', because that is the button that was pressed.
                if (muted !== was) uiSound(muted ? 'mute' : 'unmute');
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
                // Local, like the mute pair — and the only sound for this
                // action: the mute state changed inline above rather than
                // through setMuted, so deafening never plays two.
                uiSound(next ? 'deafen' : 'undeafen');
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
                    pcs: conn ? conn.pcs : 0,
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
