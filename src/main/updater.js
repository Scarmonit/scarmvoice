// Auto-update via electron-updater against the GitHub Releases feed configured
// in package.json's build.publish. electron-updater reads latest.yml from the
// newest release and compares versions; we drive the UI and the download.
//
// Updates apply themselves. There is nothing to click.
//
// It used to take four deliberate actions to get an update that had already
// downloaded: open Settings, check for updates, close Settings, then click
// Restart. Every one of those was a place to stop, and an update nobody
// finished installing is an update that was never shipped.
//
// Now: check on launch and every few hours, download as soon as one exists,
// and install it. Two things decide WHEN the install happens, because
// "immediately" is wrong for a voice app:
//
//   • Never during a call. Restarting mid-conversation drops you out of it,
//     which is a worse interruption than any update is worth. main.js tells us
//     when voice state changes and the restart waits for the call to end.
//   • A short countdown, cancellable. Anyone typing gets a moment to say not
//     yet; ignoring it — the normal case — installs.
//
// Postponing only defers the restart, never the update: it is already
// downloaded and armed with autoInstallOnAppQuit, so closing the app applies
// it regardless. The escape hatch cannot leave anyone stranded on an old build.
//
// The renderer still gets every state change so it can show a non-blocking
// banner with version, notes, progress and the countdown.
const { app } = require('electron');
const store = require('./store');

let updater = null;       // the electron-updater autoUpdater (lazy-required)
let send = () => {};      // renderer bridge, set by init()
// An update is on disk and armed. Kept OUTSIDE `state.status`, because status is
// a single field that every later event overwrites — and "we already have the
// bytes" is a fact, not a phase. See the checking/error handlers.
let downloaded = false;
let state = {             // last-known state, replayed to a late-subscribing UI
    status: 'idle',       // idle|checking|available|downloading|ready|none|error
    version: null,
    notes: null,          // flattened text, for the one-line status in Settings
    noteBlocks: [],       // structured changelog, for the release-notes modal
    progress: 0,
    error: null,
    auto: true,
    restartIn: null,      // seconds left on the countdown, null when not running
    waitingFor: null,     // 'call' when a restart is held back by voice
    postponed: false      // "not now" — until the next launch, or the next quit
};

function emit(patch) {
    state = Object.assign(state, patch);
    send('update:state', state);
}

// Dev runs (unpackaged) have no update feed; skip cleanly so nothing errors.
function available() {
    return app.isPackaged;
}

function load() {
    if (updater) return updater;
    try {
        updater = require('electron-updater').autoUpdater;
    } catch (e) {
        console.error('[update] electron-updater unavailable:', e.message);
        return null;
    }

    // Both on, unconditionally. Downloading is free and silent, and arming the
    // quit-install means that even if every countdown below is dismissed, the
    // update lands the next time the app closes.
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.allowDowngrade = false;
    // A check does not un-download anything. This used to write 'checking' over
    // a 'ready' state, and scheduleAutoRestart() refuses to act unless the status
    // is exactly 'ready' — so an update that had downloaded and was being held
    // for the end of a call was permanently disarmed by anyone pressing "Check
    // for updates" in Settings while the call was still running. The promise the
    // banner had already made ("it will install when your call ends") then went
    // unkept until the next quit.
    updater.on('checking-for-update', () => emit({ status: downloaded ? 'ready' : 'checking', error: null }));
    updater.on('update-available', (info) => {
        const n = parseNotes(info.releaseNotes);
        checkedAtStartup = true;
        // A genuinely newer build invalidates the one already on disk; the same
        // version being re-announced does not.
        if (info && info.version && info.version !== state.version) downloaded = false;
        emit({ status: 'available', version: info.version, notes: n.text, noteBlocks: n.blocks });
        // The check is answered, so the gate stops timing THAT and starts timing
        // the download instead.
        gateFound(info.version);
        // autoDownload already started it; this only keeps the UI honest if the
        // event order surprises us.
        startDownload();
    });
    updater.on('update-not-available', () => {
        checkedAtStartup = true;
        emit({ status: 'none' });
        gateSettle('launch', 'already up to date');
    });
    updater.on('download-progress', (p) => {
        const pct = Math.round(p.percent || 0);
        emit({ status: 'downloading', progress: pct });
        gateSay('downloading', pct);
    });
    updater.on('update-downloaded', (info) => {
        // Usually already captured from update-available; re-parse in case this
        // is the only event that carried them.
        const n = parseNotes(info.releaseNotes);
        downloaded = true;
        emit({
            status: 'ready', version: info.version, progress: 100,
            notes: n.text || state.notes,
            noteBlocks: (n.blocks && n.blocks.length) ? n.blocks : state.noteBlocks
        });
        // Armed at load(), so quitting applies it no matter what happens next.
        try { updater.autoInstallOnAppQuit = true; } catch (e) {}
        // At startup this is the whole point of the gate: nothing has started
        // yet, so there is nothing to interrupt and no reason to wait.
        if (gateInstall()) return;
        scheduleAutoRestart();
    });
    updater.on('error', (err) => {
        console.error('[update] error:', err && err.message);
        // A download that died falls back to 'available' — but it must be
        // DISTINGUISHABLE from an available update that is about to download,
        // or the banner keeps saying "downloading" for something that stopped.
        // `stalled` is what the renderer reads to say so and to offer a retry;
        // nothing else was ever going to, because the next automatic attempt is
        // three hours away.
        const stalled = state.status === 'downloading';
        emit({
            // …and an error on a LATER check does not un-download the update we
            // already have. Reporting 'error' over 'ready' both hid a finished
            // update from the banner and stopped scheduleAutoRestart() ever
            // installing it, for a failure that had nothing to do with it.
            status: stalled ? 'available' : (downloaded ? 'ready' : 'error'),
            stalled,
            error: (err && err.message) || 'update failed'
        });
        // An update we cannot fetch must never be a launch we cannot make.
        gateSettle('launch', 'update error: ' + ((err && err.message) || 'unknown'));
    });
    return updater;
}

// ---- the startup gate ----------------------------------------------------
//
// An update used to land ON a running app: it started normally, checked a few
// seconds later, downloaded in the background and then restarted out from under
// whatever you were doing. Everything about that is correct except the order —
// by the time the update applies you are signed in, in a channel, possibly
// typing, and the restart throws all of it away to give you a version you would
// have been perfectly happy to wait four seconds for at launch.
//
// So the check now happens BEFORE the app exists. `main.js` awaits this and
// creates no window, no tray, no socket and no session until it answers. Two
// answers only:
//
//   'launch'      nothing to do (or nothing we could do) — start normally
//   'installing'  the update is downloaded and quitAndInstall is running; this
//                 process is going away and the caller must do nothing further
//
// The one rule that matters more than updating is that the app must always
// start. Every failure — offline, a feed that never answers, a download that
// stalls, an error mid-stream — resolves 'launch' on a deadline, and nothing is
// lost by doing so: autoInstallOnAppQuit is already armed and the in-app flow
// picks the same update up on its own. A gate that can strand someone outside
// their own app is worse than an update that waits for the next launch.
const GATE_CHECK_MS = 15000;             // "is there one?" — a feed round trip
const GATE_DOWNLOAD_MS = 5 * 60 * 1000;  // and then fetching it

let gate = null;                 // { resolve, timer } while the gate is open
// Set only when the feed actually ANSWERED, so checkOnLaunch doesn't ask twice
// for something we already know — but does ask when the gate gave up on a
// timeout or an error, rather than leaving the app three hours from its next
// look at a check that never landed.
let checkedAtStartup = false;

// Tell the splash where we are. Deliberately its own channel rather than the
// `update:state` the in-app banner reads: that state machine describes an update
// arriving beside a running app, and this one describes the app not existing yet.
function gateSay(phase, percent) {
    if (!gate) return;
    send('update:gate', {
        phase,
        percent: typeof percent === 'number' ? percent : 0,
        version: state.version || null
    });
}

function gateArm(ms, why) {
    clearTimeout(gate.timer);
    gate.timer = setTimeout(() => gateSettle('launch', why), ms);
}

function gateSettle(how, why) {
    if (!gate) return false;
    const g = gate;
    gate = null;                 // before resolve(), so nothing re-enters
    clearTimeout(g.timer);
    console.info('[update] startup gate -> ' + how + ' (' + why + ')');
    g.resolve(how);
    return true;
}

// An update exists: stop timing the check and start timing the download.
function gateFound(version) {
    if (!gate) return;
    gateArm(GATE_DOWNLOAD_MS, 'the download took too long');
    gateSay('downloading', 0);
    console.info('[update] holding startup for ' + version);
}

// Downloaded while the gate is open — apply it instead of launching. Returns
// true when it took ownership, so the normal path knows to stand down.
function gateInstall() {
    if (!gate) return false;
    gateSay('installing', 100);
    gateSettle('installing', 'downloaded at startup');
    // A beat, so "Installing update…" is actually on screen rather than a frame
    // nobody sees before the window disappears. installNow() flushes settings
    // and hands over to the NSIS installer, which relaunches us.
    setTimeout(installNow, 500);
    return true;
}

// True while startup is being held. main.js asks so that a second launch (or
// the tray) cannot conjure the app window out from under the gate.
function gateOpen() { return !!gate; }

function startupGate() {
    // Unpackaged has no feed, and a missing electron-updater is not a reason to
    // refuse to start.
    if (!available()) return Promise.resolve('launch');
    const u = load();
    if (!u) return Promise.resolve('launch');

    return new Promise((resolve) => {
        gate = { resolve, timer: null };
        gateArm(GATE_CHECK_MS, 'the update check took too long');
        gateSay('checking', 0);
        try {
            u.checkForUpdates().catch((e) =>
                gateSettle('launch', 'check failed: ' + ((e && e.message) || 'unknown')));
        } catch (e) {
            gateSettle('launch', 'check threw: ' + ((e && e.message) || 'unknown'));
        }
    });
}

// ---- release notes -------------------------------------------------------
//
// The GitHub feed carries the release body as rendered HTML, and electron-updater
// hands it over as either a string or an array of { version, note }. The old
// version stripped every tag and produced one unreadable paragraph, so this
// parses it into a small block model instead:
//
//   { t: 'h',  text }            a section heading
//   { t: 'ul', items: [text] }   a bullet list
//   { t: 'p',  text }            prose
//
// Deliberately structure-only, never markup: the renderer builds these with
// createElement + textContent, so nothing from a remote feed can ever be
// interpreted as HTML in the window.

const ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    mdash: '—', ndash: '–', hellip: '…', bull: '•', middot: '·', rsquo: '’', lsquo: '‘'
};

function decode(s) {
    return String(s).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, ent) => {
        if (ent[0] === '#') {
            const n = (ent[1] === 'x' || ent[1] === 'X')
                ? parseInt(ent.slice(2), 16)
                : parseInt(ent.slice(1), 10);
            try { return Number.isFinite(n) ? String.fromCodePoint(n) : m; } catch (e) { return m; }
        }
        const key = ent.toLowerCase();
        return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : m;
    });
}

// Tags out, entities decoded, leftover markdown emphasis unwrapped.
function clean(s) {
    return decode(String(s).replace(/<[^>]+>/g, ''))
        .replace(/\*\*([\s\S]+?)\*\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1')
        .replace(/[ \t]+/g, ' ')
        .trim();
}

const BULLET = /^(?:[-*•–·]|\d+[.)])\s+/;
const ALL_BOLD = /^(?:\*\*[\s\S]+\*\*|<(?:strong|b)\b[^>]*>[\s\S]+<\/(?:strong|b)>)\s*:?$/i;

// GitHub emits "<br>\n" between the lines of a paragraph. Treating the tag and
// the newline as two separators would put an empty line between every bullet,
// which flushes the list and turns each item into a list of its own — so a <br>
// swallows the whitespace around it and counts once.
function splitRawLines(s) {
    return String(s).split(/\s*<br\s*\/?>\s*|\r?\n/i);
}

function linesToBlocks(rawLines, out) {
    let para = [];
    let items = [];
    const flushPara = () => { if (para.length) { out.push({ t: 'p', text: para.join(' ') }); para = []; } };
    const flushItems = () => { if (items.length) { out.push({ t: 'ul', items }); items = []; } };

    rawLines.forEach((raw) => {
        const rawTrim = String(raw).trim();
        const line = clean(rawTrim);
        if (!line) { flushItems(); flushPara(); return; }

        const md = /^(#{1,6})\s+([\s\S]*)$/.exec(line);
        if (md) { flushItems(); flushPara(); out.push({ t: 'h', text: md[2].trim() }); return; }

        // A line that is entirely bold is a section label — which is exactly how
        // this app's own release notes are written.
        if (ALL_BOLD.test(rawTrim)) {
            flushItems(); flushPara();
            out.push({ t: 'h', text: line.replace(/:$/, '') });
            return;
        }

        if (BULLET.test(line)) { flushPara(); items.push(line.replace(BULLET, '').trim()); return; }

        flushItems();
        para.push(line);
    });

    flushItems();
    flushPara();
}

function htmlToBlocks(html, out) {
    const re = /<(h[1-6]|ul|ol|p|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi;
    let m;
    let matched = false;
    while ((m = re.exec(html)) !== null) {
        matched = true;
        const tag = m[1].toLowerCase();
        const inner = m[2];
        if (/^h[1-6]$/.test(tag)) {
            const t = clean(inner);
            if (t) out.push({ t: 'h', text: t });
        } else if (tag === 'ul' || tag === 'ol') {
            const items = [];
            const lire = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
            let li;
            while ((li = lire.exec(inner)) !== null) {
                const t = clean(li[1]);
                if (t) items.push(t);
            }
            if (items.length) out.push({ t: 'ul', items });
        } else {
            // A <p> can still hold <br>-separated bullet lines.
            linesToBlocks(splitRawLines(inner), out);
        }
    }
    return matched;
}

function addNotes(body, out) {
    if (!body) return;
    const s = String(body);
    if (/<(p|ul|ol|li|h[1-6]|br)\b/i.test(s) && htmlToBlocks(s, out)) return;
    linesToBlocks(splitRawLines(s), out);
}

function blocksToText(blocks) {
    return blocks.map((b) => {
        if (b.t === 'h') return b.text;
        if (b.t === 'ul') return b.items.map((i) => '• ' + i).join('\n');
        return b.text;
    }).join('\n').trim();
}

function parseNotes(raw) {
    const blocks = [];
    if (!raw) return { text: null, blocks: [] };

    if (Array.isArray(raw)) {
        // Several releases skipped at once: one section per version.
        raw.forEach((n) => {
            if (!n) return;
            const body = typeof n === 'string' ? n : n.note;
            if (n.version) blocks.push({ t: 'h', text: 'Version ' + n.version });
            addNotes(body, blocks);
        });
    } else if (typeof raw === 'string') {
        addNotes(raw, blocks);
    } else {
        return { text: null, blocks: [] };
    }

    const trimmed = blocks.slice(0, 150);
    const text = blocksToText(trimmed).slice(0, 4000);
    return { text: text || null, blocks: text ? trimmed : [] };
}

// ---- applying it --------------------------------------------------------

// THE FALLBACK, not the mechanism. A release now pushes a `release` event down
// the board's realtime socket the moment it goes live (see scripts/
// publish-release.js -> /api/board/release -> the BoardRoom broadcast), and the
// renderer turns that straight into checkNow() — so the normal case is seconds,
// not minutes.
//
// This is what covers the cases the push cannot: a client that was asleep,
// offline or not signed in when the broadcast went out, a socket on the HTTP
// fallback, and a release published by something that never called the endpoint.
// It was three HOURS, which for an app people leave open all day meant the
// update usually arrived at the next launch and the "check for updates" button
// in Settings was the only way to find out sooner.
//
// Five minutes is cheap: the feed is a ~400-byte latest.yml served from release
// storage, not a GitHub API call, so this is not rate-limited and does not
// count against anything.
const RECHECK_MS = 5 * 60 * 1000;

let busy = false;                // in a call — never restart through one
let recheck = null;              // periodic check timer
// "The user has asked for this update." Set by installNow() when the bytes are
// not down yet, so one click means one click: the install runs by itself the
// moment the download finishes rather than needing a second press.
let installWhenReady = false;

// Kept as a no-op shape so the two callers below read the same as before.
function clearCountdown() { /* there is no countdown any more */ }

// A downloaded update, MID-SESSION. (At startup the gate installs it before the
// app exists — see gateInstall — and never reaches here.)
//
// This used to call installNow() outright: the app restarted itself out from
// under whatever you were doing, and the banner's job was to narrate a restart
// that was already happening. The startup gate exists precisely because that is
// the wrong moment to do it — by then you are signed in, in a channel, possibly
// mid-sentence — and the same argument applies to an update that lands an hour
// into a session.
//
// So mid-session the update WAITS, with the bytes already on disk, and says so
// on a pill at the top of the window. One click installs and restarts. Nothing
// is lost by waiting: autoInstallOnAppQuit is armed at load(), so closing the
// app applies it regardless of whether the pill was ever clicked.
//
// `waitingFor` says WHO it is waiting for, which is what the pill reads to
// decide what to offer:
//   'call'  a call is in progress — restarting drops you out of it, and that is
//           a worse interruption than any update is worth. setBusy() comes back
//           here the moment the call ends.
//   'user'  nothing is in the way; it is waiting to be clicked.
function scheduleAutoRestart() {
    if (state.status !== 'ready') return;

    // Asked for while it was still downloading: that click has already been
    // made and does not need making again.
    if (installWhenReady && !busy) {
        installWhenReady = false;
        emit({ restartIn: null, waitingFor: null });
        installNow();
        return;
    }

    emit({ restartIn: null, waitingFor: busy ? 'call' : 'user' });
}

// There is no longer anything to postpone: a ready update installs at once,
// and the only thing that holds it is a call in progress. Kept callable so the
// IPC surface is unchanged, and honest about doing nothing rather than
// reporting a deferral it cannot deliver.
function postpone() {
    return { ok: false, forced: true };
}

// main.js calls this when voice state changes.
function setBusy(inVoice) {
    const was = busy;
    busy = !!inVoice;
    // Call ended. If the update was asked for while the call was running,
    // scheduleAutoRestart installs it now; otherwise it flips 'call' to 'user'
    // and the pill stops saying it is waiting on something that has finished.
    if (was && !busy) scheduleAutoRestart();
    else if (!was && busy) { clearCountdown(); if (state.status === 'ready') emit({ restartIn: null, waitingFor: 'call' }); }
}

function init(bridge) {
    if (bridge) send = bridge;
    state.auto = true;
    state.postponed = false;
}

// Called once the window is up. Its real job now is arming the periodic
// recheck: the startup gate has already asked the feed, and its answer is what
// let this window exist at all, so asking again seconds later is a wasted round
// trip against a rate-limited API. It still checks when the gate never ran —
// unpackaged, or an electron-updater that would not load.
function checkOnLaunch() {
    if (!available()) { emit({ status: 'idle' }); return; }
    const u = load();
    if (!u) { emit({ status: 'idle' }); return; }
    if (!checkedAtStartup) {
        u.checkForUpdates().catch((e) => emit({ status: 'error', error: e.message }));
    }
    // An app left open for days used to check exactly once, at launch, and
    // then never again — so the longer it ran the more out of date it got.
    if (!recheck) {
        recheck = setInterval(() => {
            if (state.status === 'ready' || state.status === 'downloading') return;
            u.checkForUpdates().catch(() => {});
        }, RECHECK_MS);
    }
}

// Manual check (from the settings panel / a menu).
function checkNow() {
    if (!available()) { emit({ status: 'none' }); return { ok: false, reason: 'dev' }; }
    const u = load();
    if (!u) return { ok: false, reason: 'unavailable' };
    u.checkForUpdates().catch((e) => emit({ status: 'error', error: e.message }));
    return { ok: true };
}

function startDownload() {
    const u = load();
    if (!u) return { ok: false };
    if (state.status === 'downloading' || state.status === 'ready') return { ok: true };
    emit({ status: 'downloading', progress: state.progress || 0 });
    u.downloadUpdate().catch((e) => emit({ status: 'available', error: e.message }));
    return { ok: true };
}

// Quit and install now (the user clicked the update pill).
//
// It also answers for an update that has NOT finished downloading, because the
// pill appears the moment one is available and a click at that moment means the
// same thing it means ten seconds later. Rather than a disabled button and a
// second press once the bytes land, the intent is remembered and
// update-downloaded acts on it — one click is one click.
function installNow() {
    const u = load();
    if (!u) return { ok: false };
    if (state.status !== 'ready') {
        installWhenReady = true;
        // autoDownload usually has this running already; this covers a download
        // that errored back to 'available' and is sitting there stalled.
        startDownload();
        // Said out loud so the pill can show it is working rather than looking
        // like a click that did nothing.
        emit({ waitingFor: 'download' });
        return { ok: true, pending: true };
    }
    // Settings are written on a 250ms debounce, and the NSIS updater gives the
    // running app about a second before `taskkill`, then force-kills it — and a
    // force-kill runs no 'will-quit', so the pending write is simply lost. That
    // is how a setting changed shortly before an update came back as its
    // default. Flush at the moment we decide to replace the app, so nothing
    // downstream has to be quick enough.
    try { store.flush(); } catch (e) { /* the quit path flushes again */ }
    // isSilent=true (silent install), isForceRunAfter=true (relaunch app).
    setImmediate(() => { try { u.quitAndInstall(true, true); } catch (e) { console.error('[update] install failed', e.message); } });
    return { ok: true };
}

// Nothing left to switch. Updates download and install themselves, and the
// Settings checkbox that used to call this is gone — a control that cannot
// change the outcome is worse than no control. Kept callable so the IPC surface
// is unchanged for an older renderer talking to this main process mid-update.
function setAuto() {
    state.auto = true;
    scheduleAutoRestart();
    return { ok: true, forced: true };
}

function getState() { return state; }

// ---- the whole release history ------------------------------------------
//
// The update feed only ever describes ONE release: the one being offered. So
// "what changed in the version I am running", let alone in the five before it,
// was not answerable inside the app at all — you had to go and find the repo.
//
// This asks GitHub for the published releases and runs each body through the
// same parseNotes() the update banner uses, so the history renders through the
// same block model and the same createElement/textContent path. Nothing from a
// remote feed is ever handed to the DOM as markup, here or there.
//
// It lives in the MAIN process for the reason every other remote fetch in this
// app does: the renderer is a file:// page, so its origin is null and it is at
// the mercy of whatever CORS headers the far end sends.

// Read from the same place electron-updater takes the feed from, so the history
// and the updates can never point at two different repositories.
function releasesUrl() {
    let owner = 'Scarmonit';
    let repo = 'scarmvoice';
    try {
        const pub = require('../../package.json').build.publish;
        if (pub && pub.owner && pub.repo) { owner = pub.owner; repo = pub.repo; }
    } catch (e) { /* the constants above are the same values */ }
    return `https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`;
}

// Kept for the life of the process. The list changes when we ship, which is
// also when the app restarts itself, so a session-long cache cannot go stale in
// any way the user would see — and unauthenticated api.github.com allows 60
// requests an hour per address, which a settings panel should not be spending.
let historyCache = null;

function versionKey(v) {
    // Sortable, so 0.9.0 cannot outrank 0.10.0 the way a string compare does.
    const p = String(v || '').split('.').map((n) => parseInt(n, 10) || 0);
    return (p[0] || 0) * 1e6 + (p[1] || 0) * 1e3 + (p[2] || 0);
}

async function history(force) {
    if (historyCache && !force) return historyCache;

    let res;
    try {
        res = await fetch(releasesUrl(), {
            signal: AbortSignal.timeout(15000),
            headers: {
                Accept: 'application/vnd.github+json',
                // GitHub's REST API refuses a request without one.
                'User-Agent': 'ScarmVoice/' + app.getVersion()
            }
        });
    } catch (e) {
        return { ok: false, error: e.name === 'TimeoutError' ? 'timed out' : 'could not reach GitHub', releases: [] };
    }
    if (!res.ok) {
        // 403 here is almost always the hourly rate limit rather than anything
        // being wrong, and it says so rather than blaming the network.
        const why = res.status === 403 || res.status === 429
            ? 'GitHub is rate limiting this connection — try again later'
            : `GitHub returned ${res.status}`;
        try { await res.body?.cancel(); } catch (e) { /* already gone */ }
        return { ok: false, error: why, releases: [] };
    }

    let raw;
    try { raw = await res.json(); } catch (e) { return { ok: false, error: 'unreadable response', releases: [] }; }
    if (!Array.isArray(raw)) return { ok: false, error: 'unexpected response', releases: [] };

    const releases = raw
        // A draft is not published, and nobody running this build can have it.
        .filter((r) => r && !r.draft && r.tag_name)
        .map((r) => {
            const version = String(r.tag_name).replace(/^v/i, '');
            const n = parseNotes(r.body);
            return {
                version,
                // The title is the version again on releases published before
                // the notes were written by hand; the UI drops it when so.
                title: String(r.name || '').trim(),
                date: r.published_at || r.created_at || null,
                prerelease: !!r.prerelease,
                blocks: n.blocks
            };
        })
        .sort((a, b) => versionKey(b.version) - versionKey(a.version));

    historyCache = { ok: true, releases, error: null };
    return historyCache;
}

// ---- exports -------------------------------------------------------------

module.exports = {
    init, checkOnLaunch, checkNow, startDownload, installNow, setAuto,
    postpone, setBusy, getState, available, parseNotes, history,
    startupGate, gateOpen
};
