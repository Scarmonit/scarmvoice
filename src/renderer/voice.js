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
    const SPEAK_HANG_MS = 220;       // hold the indicator briefly so it doesn't strobe

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
    function shareVideoTrackId() { return SHARE_TRACK_ID; }

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
        const shareTrackId = shareVideoTrackId();
        let found = 0;
        PCS.forEach((pc) => {
            if (!pc || typeof pc.getSenders !== 'function') return;
            let senders;
            try { senders = pc.getSenders(); } catch (e) { return; }
            senders.forEach((sender) => {
                if (!sender || !sender.track || sender.track.kind !== 'video') return;
                // No share track id yet (the sender can appear first) → fall back
                // to tuning any video sender, which is the old behaviour.
                if (shareTrackId && sender.track.id !== shareTrackId) return;
                found++;
                try { sender.track.contentHint = prof.contentHint; } catch (e) {}
                try {
                    const p = sender.getParameters();
                    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
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

    // The producer/sender appears asynchronously after enableScreenShare.
    function forceScreenQualityRetry() {
        let tries = 0;
        const hadId = !!SHARE_TRACK_ID;
        (function go() {
            // If the share stopped while this loop was still running, the id is
            // nulled and forceScreenQuality's "tune any video sender" fallback
            // would apply share encoder params (16 Mbps, maintain-resolution)
            // to the CAMERA. Stop instead.
            if (hadId && !SHARE_TRACK_ID) return;
            const found = forceScreenQuality();
            if (tries === 0) console.info('[share] video senders found:', found, 'across', PCS.length, 'peer connections');
            if (++tries < 6) setTimeout(go, tries * 500);
        })();
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

        function state() {
            return {
                joined, joining, muted, deafened,
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
                g.set(effective);
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
                if (!gated && meter.rms() > threshold) rec.until = now + SPEAK_HANG_MS;
                const nowSpeaking = !gated && now < rec.until;

                if (nowSpeaking !== rec.speaking) {
                    rec.speaking = nowSpeaking;
                    on.onSpeaking(cid, nowSpeaking);
                }
            });
        }

        function stopSpeaking(cid) {
            const rec = analysers[cid];
            if (!rec) return;
            if (rec.off) rec.off();
            rec.meter.stop();
            delete analysers[cid];
            if (rec.speaking) on.onSpeaking(cid, false);
        }

        function stopAllSpeaking() {
            Object.keys(analysers).forEach(stopSpeaking);
        }

        // ---- remote audio attach/detach ----------------------------------

        function attachAudio(p) {
            const cid = cidOf(p);
            if (!cid || !p.audioTrack) return;
            ensureSink();

            let el = audioEls[cid];
            if (!el) {
                el = document.createElement('audio');
                el.autoplay = true;
                el.setAttribute('playsinline', '');
                sink.appendChild(el);
                audioEls[cid] = el;
                applySinkId(el);
            }
            let stream;
            try {
                stream = new MediaStream([p.audioTrack]);
                el.srcObject = stream;
            } catch (e) { return; }

            dropGain(cid);            // stream changed — rebuild any boost graph
            applyLocalAudio(cid);
            watchSpeaking(cid, stream, false);
            el.play().catch(() => {});
        }

        function detachAudio(p) {
            const cid = cidOf(p);
            if (!cid) return;
            dropGain(cid);
            stopSpeaking(cid);
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
                        muted
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
                        muted: !!(settings.localMuted && settings.localMuted[cid]),
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

        function wire(m) {
            // Re-run watchLocal on every self audioUpdate: mute/PTT replaces the
            // published track (disableAudio really stops it), so a meter bound
            // once at join goes dark after the first cycle — and in PTT mode the
            // track doesn't exist until the first transmit at all.
            try { if (m.self && m.self.on) m.self.on('audioUpdate', () => { watchLocal(); render(); }); } catch (e) {}
            const pj = m.participants && m.participants.joined;
            if (pj && pj.on) {
                pj.on('participantJoined', (p) => { attachAudio(p); render(); pushCams(); });
                pj.on('participantLeft', (p) => { detachAudio(p); render(); pushCams(); });
                pj.on('audioUpdate', (p) => { attachAudio(p); render(); });
                pj.on('videoUpdate', () => pushCams());
                try { (pj.toArray ? pj.toArray() : []).forEach(attachAudio); } catch (e) {}
            }
            try { if (m.self && m.self.on) m.self.on('videoUpdate', () => pushCams()); } catch (e) {}
            wireShare(m);
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
                    v.addEventListener('ended', () => stopShare(), { once: true });
                }
                if (meeting && meeting.self && typeof meeting.self.updateScreenshareConstraints === 'function') {
                    Promise.resolve(meeting.self.updateScreenshareConstraints(cap)).catch(() => {});
                }
                forceScreenQualityRetry();
                setTimeout(() => {
                    try {
                        const v2 = meeting.self.screenShareTracks && meeting.self.screenShareTracks.video;
                        if (v2) v2.contentHint = shareProfile().contentHint;
                    } catch (e) {}
                }, 1500);
                setTimeout(() => reportShareStats('t+5s'), 5000);
            } catch (e) {}
        }

        function wireShare(m) {
            try {
                if (m.self && m.self.on) {
                    m.self.on('screenShareUpdate', (d) => {
                        if (d && d.screenShareEnabled) {
                            localSharing = true;
                            const tracks = d.screenShareTracks || m.self.screenShareTracks || {};
                            SHARE_TRACK_ID = (tracks.video && tracks.video.id) || null;
                            tuneLocalShare();
                            setSharer(selfCid(), m.self.name || settings.displayName || 'You', true, tracks);
                        } else {
                            localSharing = false;
                            SHARE_TRACK_ID = null;
                            clearSharer(selfCid());
                            pushState();
                        }
                    });
                }
            } catch (e) {}

            const pj = m.participants && m.participants.joined;
            if (!pj || !pj.on) return;

            pj.on('screenShareUpdate', (p) => {
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
            pj.on('participantLeft', (p) => clearSharer(cidOf(p)));
            // Someone already sharing when they (or we) arrive.
            pj.on('participantJoined', (p) => {
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

        function stopShare() {
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
                    if (want && meeting.self.enableAudio) meeting.self.enableAudio();
                    else if (!want && meeting.self.disableAudio) meeting.self.disableAudio();
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

        async function join() {
            if (joined || joining) return;
            joining = true;
            const gen = joinGen;
            pushState();

            try {
                if (!window.RealtimeKitClient) throw new Error('RealtimeKit SDK failed to load');

                const res = await window.lounge.voiceToken({
                    clientId: settings.clientId,
                    name: settings.displayName || 'Anonymous'
                });
                if (gen !== joinGen) return;   // leave() ran while we awaited
                if (!res || !res.success || !res.token) {
                    throw new Error((res && res.error) || 'could not get a voice token');
                }

                const audioCfg = {
                    echoCancellation: settings.echoCancellation !== false,
                    autoGainControl: !!settings.autoGainControl,
                    // The SDK reads the MISSPELLED getUserMedia key (one 's').
                    // Pass both so today's build and any future fix both work.
                    noiseSupression: settings.noiseSuppression !== false,
                    noiseSuppression: settings.noiseSuppression !== false,
                    enableHighBitrate: true
                };
                if (settings.micDeviceId) audioCfg.deviceId = { exact: settings.micDeviceId };

                const m = await window.RealtimeKitClient.init({
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

                if (gen !== joinGen) {
                    // Left while init was pending — discard the fresh meeting.
                    try { if (m.leave) m.leave(); else if (m.leaveRoom) m.leaveRoom(); } catch (_) {}
                    return;
                }
                meeting = m;

                wire(meeting);
                const joinFn = meeting.join || meeting.joinRoom;
                await joinFn.call(meeting);
                if (gen !== joinGen) {
                    try { if (m.leave) m.leave(); else if (m.leaveRoom) m.leaveRoom(); } catch (_) {}
                    if (meeting === m) meeting = null;
                    return;
                }

                joined = true;
                joining = false;
                muted = false;
                lastTransmit = null;

                // In push-to-talk we must start silent; in open mic, start live.
                applyTransmit();
                applyAllLocalAudio();
                watchLocal();
                render();
                pushState();
                // Remote participants arrive shortly after join; re-render so the
                // roster reflects who is actually peered rather than just present.
                setTimeout(render, 4000);
            } catch (e) {
                if (gen !== joinGen) return;   // leave() already cleaned up
                joining = false;
                joined = false;
                try { if (meeting && meeting.leave) meeting.leave(); } catch (_) {}
                meeting = null;
                pushState();
                fail('join', e);
                throw e;
            }
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
            try {
                if (meeting) {
                    if (meeting.leave) meeting.leave();
                    else if (meeting.leaveRoom) meeting.leaveRoom();
                }
            } catch (e) { /* leaving is best-effort */ }

            meeting = null;
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
            isMuted: () => muted,
            isDeafened: () => deafened
        };
    }

    window.createVoice = createVoice;
})();
