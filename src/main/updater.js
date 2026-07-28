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
    updater.on('checking-for-update', () => emit({ status: 'checking', error: null }));
    updater.on('update-available', (info) => {
        const n = parseNotes(info.releaseNotes);
        emit({ status: 'available', version: info.version, notes: n.text, noteBlocks: n.blocks });
        // autoDownload already started it; this only keeps the UI honest if the
        // event order surprises us.
        startDownload();
    });
    updater.on('update-not-available', () => emit({ status: 'none' }));
    updater.on('download-progress', (p) => emit({ status: 'downloading', progress: Math.round(p.percent || 0) }));
    updater.on('update-downloaded', (info) => {
        // Usually already captured from update-available; re-parse in case this
        // is the only event that carried them.
        const n = parseNotes(info.releaseNotes);
        emit({
            status: 'ready', version: info.version, progress: 100,
            notes: n.text || state.notes,
            noteBlocks: (n.blocks && n.blocks.length) ? n.blocks : state.noteBlocks
        });
        // Armed at load(), so quitting applies it no matter what happens next.
        try { updater.autoInstallOnAppQuit = true; } catch (e) {}
        scheduleAutoRestart();
    });
    updater.on('error', (err) => {
        console.error('[update] error:', err && err.message);
        emit({ status: state.status === 'downloading' ? 'available' : 'error', error: (err && err.message) || 'update failed' });
    });
    return updater;
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

const RECHECK_MS = 3 * 60 * 60 * 1000;   // a long session should still see updates

let busy = false;                // in a call — never restart through one
let recheck = null;              // periodic check timer

// Kept as a no-op shape so the two callers below read the same as before.
function clearCountdown() { /* there is no countdown any more */ }

// Apply a downloaded update. There is no longer a delay in front of this.
//
// It used to count ten seconds down with a "Not now" button under it, which
// meant every update waited on someone either ignoring it or missing it. An
// update that has already downloaded is not a proposal — the app is going to
// restart into it either way, and doing that at once is both faster and more
// honest than a timer that mostly runs out anyway.
//
// The ONE thing still allowed to hold it back is a call in progress. Restarting
// mid-conversation drops you out of it, which is a worse interruption than any
// update is worth, and the wait is bounded by the length of the call — setBusy()
// applies it the moment the call ends.
function scheduleAutoRestart() {
    if (state.status !== 'ready') return;

    if (busy) {
        // Not an error and not a failure — just later. Saying so is better than
        // a silent non-event that looks like the update stalled.
        emit({ restartIn: null, waitingFor: 'call' });
        return;
    }

    emit({ restartIn: null, waitingFor: null });
    installNow();
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
    if (was && !busy) scheduleAutoRestart();   // call ended — resume
    else if (!was && busy) { clearCountdown(); if (state.status === 'ready') emit({ restartIn: null, waitingFor: 'call' }); }
}

function init(bridge) {
    if (bridge) send = bridge;
    state.auto = true;
    state.postponed = false;
}

// Called shortly after the window is ready.
function checkOnLaunch() {
    if (!available()) { emit({ status: 'idle' }); return; }
    const u = load();
    if (!u) { emit({ status: 'idle' }); return; }
    u.checkForUpdates().catch((e) => emit({ status: 'error', error: e.message }));
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

// Quit and install now (user clicked Restart to update).
function installNow() {
    const u = load();
    if (!u) return { ok: false };
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
    postpone, setBusy, getState, available, parseNotes, history
};
