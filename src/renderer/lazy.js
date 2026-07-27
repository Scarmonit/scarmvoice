// On-demand loading for the three big vendor bundles.
//
// They used to sit in index.html as blocking <script> tags — hljs (350 KB),
// qrcode (57 KB) and the RealtimeKit SDK (647 KB), just over a megabyte parsed
// and executed before `ready-to-show` let main.js display the window. None of
// them can be needed at first paint: highlighting waits for a message with a
// code fence, the QR generator is only reachable from 2FA enrolment, and the
// SDK is only touched when you join voice. Most sessions never load two of them.
//
// Each bundle is a classic script that assigns a global (`var hljs`,
// `var qrcode`, `var RealtimeKitClient`), so injecting a <script> is the correct
// loader — a dynamic import() would not create the global. Injection also keeps
// the SDK evaluating after voice.js and noise.js, which is the ordering its
// RTCPeerConnection / getDisplayMedia / getUserMedia patches depend on.
(function () {
    'use strict';

    // url -> Promise, so N concurrent callers share one network request and one
    // evaluation, and a resolved entry makes later calls a no-op.
    const inflight = new Map();

    function loadScript(url) {
        let p = inflight.get(url);
        if (p) return p;
        p = new Promise((resolve, reject) => {
            const el = document.createElement('script');
            el.src = url;
            el.async = false;               // preserve execution order if several are queued
            el.addEventListener('load', () => resolve(true), { once: true });
            el.addEventListener('error', () => {
                // Let a later attempt retry rather than caching the failure
                // forever — a transient failure here is a missing feature, not
                // a broken app.
                inflight.delete(url);
                reject(new Error('failed to load ' + url));
            }, { once: true });
            document.head.appendChild(el);
        });
        inflight.set(url, p);
        return p;
    }

    // Resolves to the global the bundle defines, or null if it could not load.
    // Callers all degrade gracefully, so this never rejects.
    function ensure(url, globalName) {
        if (window[globalName]) return Promise.resolve(window[globalName]);
        return loadScript(url).then(
            () => window[globalName] || null,
            (e) => {
                console.warn('[lazy] ' + globalName + ' unavailable:', e.message);
                return null;
            }
        );
    }

    window.ScarmLazy = {
        hljs: () => ensure('vendor/hljs.js', 'hljs'),
        qrcode: () => ensure('vendor/qrcode.js', 'qrcode'),
        realtimekit: () => ensure('vendor/realtimekit.js', 'RealtimeKitClient'),

        // True once the bundle is resident, for callers that want to avoid
        // kicking off a fetch from inside a render pass.
        has: (globalName) => !!window[globalName]
    };
})();
