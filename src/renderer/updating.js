// The startup update screen. Draws whatever the gate in main/updater.js pushes
// and does nothing else — no state of its own, no polling, no way to affect the
// update it is reporting on.
//
// This window is the only thing on screen while an update applies, so the one
// job that matters is never looking frozen: every phase either moves a real
// percentage or sweeps, and the copy says what is happening and what happens
// next rather than making the reader guess.
(function () {
    'use strict';

    const $ = (id) => document.getElementById(id);

    const COPY = {
        checking: {
            phase: 'Checking for updates…',
            detail: () => ''
        },
        downloading: {
            phase: 'Downloading update',
            // The version is the useful half — "42%" alone says nothing about
            // what you are getting.
            detail: (s) => (s.version ? 'Version ' + s.version : '')
        },
        installing: {
            phase: 'Installing update…',
            detail: (s) => (s.version ? 'Version ' + s.version + ' — restarting' : 'Restarting')
        }
    };

    function paint(s) {
        const step = COPY[s && s.phase] || COPY.checking;
        const pct = Math.max(0, Math.min(100, Math.round((s && s.percent) || 0)));
        // Only a download has a number worth showing. Percent is appended to the
        // phase rather than sat beside it so the line reads as one sentence.
        const determinate = s && s.phase === 'downloading' && pct > 0;

        $('phase').textContent = step.phase + (determinate ? ' ' + pct + '%' : '');
        $('detail').textContent = step.detail(s || {});

        document.body.classList.toggle('indeterminate', !determinate);
        $('bar').style.width = determinate ? pct + '%' : '';

        const track = $('track');
        if (determinate) {
            track.setAttribute('aria-valuenow', String(pct));
            track.setAttribute('aria-valuemin', '0');
            track.setAttribute('aria-valuemax', '100');
        } else {
            // A progressbar with no value is the correct way to say "working,
            // duration unknown"; leaving a stale number there would lie.
            track.removeAttribute('aria-valuenow');
        }
    }

    // Closing quits: the window is standing in front of the app, so there is
    // nothing behind it to return to.
    $('close').addEventListener('click', () => window.close());

    if (window.scarmUpdate) window.scarmUpdate.onProgress(paint);
})();
