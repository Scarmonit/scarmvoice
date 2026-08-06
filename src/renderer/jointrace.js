// Join tracing — where a voice join's time actually goes.
//
// The coarse marks in voice.js (sdk+token / sdk.init / room join) said WHICH
// phase was slow but not WHY: "room join" covers the signaling round trip, the
// SFU transport allocation, ICE gathering, the STUN/TURN checks, the DTLS
// handshake and the first produced packet, all under one number. This file
// splits that number.
//
// It wraps fetch, WebSocket, getUserMedia and RTCPeerConnection, and while a
// trace is armed it timestamps every network operation and every ICE/DTLS
// state transition relative to the moment the join started. Disarmed (the
// steady state), the wrappers are pass-throughs; nothing is logged, nothing is
// buffered, and the only cost is one `if` per call.
//
// Load order matters and is deliberate: this file loads AFTER noise.js,
// soundboard.js and voice.js, so its wrappers are the OUTERMOST layer.
// getUserMedia measured here therefore includes the RNNoise worklet and the
// soundboard mix — the real cost of opening the microphone, not the raw
// device time. The SDK loads later still (lazily), so every peer connection
// it creates passes through here.
(function () {
    'use strict';

    const now = () => performance.now();

    let t0 = null;        // armed at join start; null = disarmed
    let gen = 0;          // bumped per trace, so late async logs from a previous join drop out
    let pollTimers = [];

    function line(msg) {
        if (t0 === null) return;
        // console.info is forwarded to the main-process log file, so a trace
        // from an installed build survives to be read the next day.
        try { console.info('[jointrace] +' + Math.round(now() - t0) + 'ms ' + msg); } catch (e) {}
    }

    function arm() {
        disarm();
        gen++;
        t0 = now();
        line('=== join trace armed ===');
    }

    function disarm() {
        t0 = null;
        pollTimers.forEach(clearTimeout);
        pollTimers = [];
    }

    // A settle timer instead of an immediate disarm: the join() promise
    // resolves before the first audio packet moves, and the whole point is to
    // see how far behind "connected" the actual audio is.
    function armDone() {
        const g = gen;
        pollTimers.push(setTimeout(() => { if (g === gen) disarm(); }, 20000));
    }

    window.JoinTrace = { arm, disarm, done: armDone };

    // ---- fetch ------------------------------------------------------------
    (function patchFetch() {
        if (!window.fetch || window.fetch.__joinTraceWrapped) return;
        const orig = window.fetch.bind(window);
        let n = 0;
        const wrapped = function (input, init) {
            if (t0 === null) return orig(input, init);
            const id = ++n;
            let url = '';
            try { url = String((input && input.url) || input); } catch (e) {}
            // Host + path only — a token in a query string must not reach a log.
            let short = url;
            try { const u = new URL(url); short = u.host + u.pathname; } catch (e) {}
            const t = now();
            line('fetch#' + id + ' -> ' + ((init && init.method) || 'GET') + ' ' + short);
            const p = orig(input, init);
            p.then(
                (r) => line('fetch#' + id + ' <- ' + r.status + ' (' + Math.round(now() - t) + 'ms)'),
                (e) => line('fetch#' + id + ' <- FAILED ' + (e && e.message) + ' (' + Math.round(now() - t) + 'ms)')
            );
            return p;
        };
        wrapped.__joinTraceWrapped = true;
        window.fetch = wrapped;
    })();

    // ---- WebSocket --------------------------------------------------------
    (function patchWS() {
        const Native = window.WebSocket;
        if (!Native || Native.__joinTraceWrapped) return;
        let n = 0;
        const Wrapped = function (url, protocols) {
            const ws = (protocols !== undefined) ? new Native(url, protocols) : new Native(url);
            if (t0 !== null) {
                const id = ++n;
                let short = String(url);
                try { const u = new URL(url); short = u.host + u.pathname; } catch (e) {}
                const t = now();
                line('ws#' + id + ' connecting ' + short);
                // The first few frames each way, with sizes. This is what
                // splits "the client sat on the request" from "the server sat
                // on the reply" when a silent gap shows up mid-join.
                let msgs = 0;
                let sends = 0;
                try {
                    ws.addEventListener('open', () => line('ws#' + id + ' open (' + Math.round(now() - t) + 'ms)'));
                    ws.addEventListener('message', (ev) => {
                        msgs++;
                        if (msgs > 12) return;
                        let size = '?';
                        try {
                            const d = ev.data;
                            size = typeof d === 'string' ? d.length
                                : (d && d.byteLength !== undefined) ? d.byteLength
                                : (d && d.size !== undefined) ? d.size : '?';
                        } catch (e) {}
                        line('ws#' + id + ' recv #' + msgs + ' (' + size + 'B)');
                    });
                    ws.addEventListener('close', (ev) => line('ws#' + id + ' closed code=' + ev.code));
                    ws.addEventListener('error', () => line('ws#' + id + ' error'));
                    const origSend = ws.send.bind(ws);
                    ws.send = function (data) {
                        if (t0 !== null) {
                            sends++;
                            if (sends <= 12) {
                                let size = '?';
                                try {
                                    size = typeof data === 'string' ? data.length
                                        : (data && data.byteLength !== undefined) ? data.byteLength
                                        : (data && data.size !== undefined) ? data.size : '?';
                                } catch (e) {}
                                line('ws#' + id + ' send #' + sends + ' (' + size + 'B)');
                            }
                        }
                        return origSend(data);
                    };
                } catch (e) {}
            }
            return ws;
        };
        Wrapped.prototype = Native.prototype;
        try { Object.setPrototypeOf(Wrapped, Native); } catch (e) {}
        // Statics (CONNECTING/OPEN/…) come via the prototype chain above.
        Wrapped.__joinTraceWrapped = true;
        window.WebSocket = Wrapped;
    })();

    // ---- getUserMedia -----------------------------------------------------
    // Outermost wrapper (see the load-order note up top): this duration is the
    // WHOLE cost of opening the mic, RNNoise worklet and soundboard included.
    (function patchGUM() {
        const md = navigator.mediaDevices;
        if (!md || !md.getUserMedia || md.getUserMedia.__joinTraceWrapped) return;
        const orig = md.getUserMedia.bind(md);
        const wrapped = async function (constraints) {
            if (t0 === null) return orig(constraints);
            const t = now();
            const kinds = [];
            try {
                if (constraints && constraints.audio) kinds.push('audio');
                if (constraints && constraints.video) kinds.push('video');
            } catch (e) {}
            line('getUserMedia(' + kinds.join('+') + ') start');
            try {
                const s = await orig(constraints);
                line('getUserMedia(' + kinds.join('+') + ') done (' + Math.round(now() - t) + 'ms)');
                return s;
            } catch (e) {
                line('getUserMedia FAILED ' + (e && e.name) + ' (' + Math.round(now() - t) + 'ms)');
                throw e;
            }
        };
        wrapped.__joinTraceWrapped = true;
        md.getUserMedia = wrapped;
    })();

    // ---- enumerateDevices -------------------------------------------------
    (function patchEnum() {
        const md = navigator.mediaDevices;
        if (!md || !md.enumerateDevices || md.enumerateDevices.__joinTraceWrapped) return;
        const orig = md.enumerateDevices.bind(md);
        const wrapped = function () {
            if (t0 === null) return orig();
            const t = now();
            const p = orig();
            p.then(() => line('enumerateDevices (' + Math.round(now() - t) + 'ms)'), () => {});
            return p;
        };
        wrapped.__joinTraceWrapped = true;
        md.enumerateDevices = wrapped;
    })();

    // ---- RTCPeerConnection ------------------------------------------------
    // Wraps whatever is installed already (voice.js's DTX-stripping wrapper),
    // so the SDK sees this one and this one delegates inward.
    (function patchPC() {
        const Native = window.RTCPeerConnection;
        if (!Native || Native.__joinTraceWrapped) return;
        let n = 0;

        // "typ host/srflx/relay" out of a candidate line — which of the ICE
        // paths (direct / STUN-derived / TURN) each candidate is.
        function candType(c) {
            const m = /typ ([a-z]+)/.exec((c && c.candidate) || '');
            return m ? m[1] : '?';
        }

        function describeIce(cfg) {
            try {
                const urls = [];
                ((cfg && cfg.iceServers) || []).forEach((s) => {
                    const u = s && s.urls;
                    (Array.isArray(u) ? u : [u]).forEach((x) => { if (x) urls.push(String(x).split('?')[0]); });
                });
                return urls.join(' ') || 'none';
            } catch (e) { return '?'; }
        }

        const Wrapped = function (cfg, con) {
            const pc = (arguments.length > 1) ? new Native(cfg, con) : new Native(cfg);
            if (t0 === null) return pc;
            const id = ++n;
            const g = gen;
            const t = now();
            line('pc#' + id + ' created  iceServers: ' + describeIce(cfg) +
                (cfg && cfg.iceTransportPolicy ? '  policy=' + cfg.iceTransportPolicy : ''));

            try {
                pc.addEventListener('icegatheringstatechange', () =>
                    line('pc#' + id + ' iceGathering -> ' + pc.iceGatheringState));
                let candCount = 0;
                pc.addEventListener('icecandidate', (ev) => {
                    if (ev.candidate) {
                        candCount++;
                        line('pc#' + id + ' candidate #' + candCount + ' ' + candType(ev.candidate) +
                            '/' + (ev.candidate.protocol || '?'));
                    } else {
                        line('pc#' + id + ' end-of-candidates (' + candCount + ' total)');
                    }
                });
                pc.addEventListener('iceconnectionstatechange', () =>
                    line('pc#' + id + ' ice -> ' + pc.iceConnectionState));
                pc.addEventListener('connectionstatechange', () => {
                    line('pc#' + id + ' connection -> ' + pc.connectionState +
                        ' (t+' + Math.round(now() - t) + 'ms since pc created)');
                    if (pc.connectionState === 'connected') firstPacketWatch(pc, id, g);
                });
                pc.addEventListener('signalingstatechange', () =>
                    line('pc#' + id + ' signaling -> ' + pc.signalingState));
            } catch (e) {}

            // SDP negotiation timing — each call is a hop in the handshake.
            ['createOffer', 'createAnswer', 'setLocalDescription', 'setRemoteDescription'].forEach((fn) => {
                try {
                    const orig = pc[fn].bind(pc);
                    pc[fn] = function (...args) {
                        if (t0 === null || g !== gen) return orig(...args);
                        const tt = now();
                        const p = orig(...args);
                        Promise.resolve(p).then(
                            () => line('pc#' + id + ' ' + fn + ' (' + Math.round(now() - tt) + 'ms)'),
                            () => line('pc#' + id + ' ' + fn + ' FAILED (' + Math.round(now() - tt) + 'ms)')
                        );
                        return p;
                    };
                } catch (e) {}
            });

            return pc;
        };

        // When did media actually start moving? "connected" is a transport
        // state; audio is only real when RTP packets are counted. Poll fast
        // and briefly — the answer lands within a second of DTLS finishing.
        function firstPacketWatch(pc, id, g) {
            let sawOut = false;
            let sawIn = false;
            let tries = 0;
            const poll = () => {
                if (g !== gen || t0 === null || (sawOut && sawIn) || ++tries > 100) return;
                pc.getStats().then((stats) => {
                    if (g !== gen || t0 === null) return;
                    stats.forEach((r) => {
                        if (!sawOut && r.type === 'outbound-rtp' && r.kind === 'audio' && r.packetsSent > 0) {
                            sawOut = true;
                            line('pc#' + id + ' FIRST AUDIO OUT (packetsSent=' + r.packetsSent + ')');
                        }
                        if (!sawIn && r.type === 'inbound-rtp' && r.kind === 'audio' && r.packetsReceived > 0) {
                            sawIn = true;
                            line('pc#' + id + ' FIRST AUDIO IN (packetsReceived=' + r.packetsReceived + ')');
                        }
                        // DTLS is inside connectionState 'connecting'; the stats
                        // record is the only place its own state is visible.
                        if (r.type === 'transport' && r.dtlsState && !poll['dtls' + r.id]) {
                            poll['dtls' + r.id] = true;
                            line('pc#' + id + ' dtlsState=' + r.dtlsState +
                                (r.selectedCandidatePairId ? ' (pair selected)' : ''));
                        }
                    });
                    if (!(sawOut && sawIn)) pollTimers.push(setTimeout(poll, 100));
                }).catch(() => {});
            };
            poll();
        }

        Wrapped.prototype = Native.prototype;
        try { Object.setPrototypeOf(Wrapped, Native); } catch (e) {}
        Wrapped.__joinTraceWrapped = true;
        window.RTCPeerConnection = Wrapped;
    })();
})();
