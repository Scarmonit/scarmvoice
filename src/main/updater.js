// Auto-update via electron-updater against the GitHub Releases feed configured
// in package.json's build.publish. electron-updater reads latest.yml from the
// newest release and compares versions; we drive the UI and the download.
//
// Two modes, chosen by the `autoUpdateOnLaunch` setting:
//   • ON  — check on launch, download in the BACKGROUND, install on next quit
//           (autoInstallOnAppQuit) rather than interrupting the session.
//   • OFF — check on launch and surface an "update available" prompt, but do
//           nothing until the user clicks Download.
//
// Either way the renderer gets events so it can show a non-blocking banner with
// version, notes, progress, and a Restart action.
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
    auto: false
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

    updater.autoDownload = false;            // we decide when to download
    updater.autoInstallOnAppQuit = false;    // toggled on for background mode
    updater.allowDowngrade = false;
    updater.on('checking-for-update', () => emit({ status: 'checking', error: null }));
    updater.on('update-available', (info) => {
        const n = parseNotes(info.releaseNotes);
        emit({ status: 'available', version: info.version, notes: n.text, noteBlocks: n.blocks });
        // Background mode: fetch it quietly and install on quit.
        if (state.auto) startDownload();
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
        if (state.auto) {
            // Don't yank the session away; install silently on the next quit.
            try { updater.autoInstallOnAppQuit = true; } catch (e) {}
        }
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

function init(bridge) {
    if (bridge) send = bridge;
    state.auto = store.get().autoUpdateOnLaunch === true;
}

// Called shortly after the window is ready.
function checkOnLaunch() {
    if (!available()) { emit({ status: 'idle' }); return; }
    const u = load();
    if (!u) { emit({ status: 'idle' }); return; }
    state.auto = store.get().autoUpdateOnLaunch === true;
    u.checkForUpdates().catch((e) => emit({ status: 'error', error: e.message }));
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
    // isSilent=true (silent install), isForceRunAfter=true (relaunch app).
    setImmediate(() => { try { u.quitAndInstall(true, true); } catch (e) { console.error('[update] install failed', e.message); } });
    return { ok: true };
}

function setAuto(on) {
    state.auto = !!on;
    // If we already know an update is waiting, honour the new mode immediately.
    if (on && state.status === 'available') startDownload();
    if (on && state.status === 'ready' && updater) {
        try { updater.autoInstallOnAppQuit = true; } catch (e) {}
    }
    // Turning auto OFF must also cancel a silent install that a background
    // download already armed — otherwise the update installs on quit anyway,
    // contradicting the toggle the user just set.
    if (!on && updater) {
        try { updater.autoInstallOnAppQuit = false; } catch (e) {}
    }
}

function getState() { return state; }

module.exports = { init, checkOnLaunch, checkNow, startDownload, installNow, setAuto, getState, available, parseNotes };
