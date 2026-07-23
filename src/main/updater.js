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
const { app, autoUpdater: _unused } = require('electron');
const store = require('./store');

let updater = null;       // the electron-updater autoUpdater (lazy-required)
let send = () => {};      // renderer bridge, set by init()
let state = {             // last-known state, replayed to a late-subscribing UI
    status: 'idle',       // idle|checking|available|downloading|ready|none|error
    version: null,
    notes: null,
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
        emit({ status: 'available', version: info.version, notes: normalizeNotes(info.releaseNotes) });
        // Background mode: fetch it quietly and install on quit.
        if (state.auto) startDownload();
    });
    updater.on('update-not-available', () => emit({ status: 'none' }));
    updater.on('download-progress', (p) => emit({ status: 'downloading', progress: Math.round(p.percent || 0) }));
    updater.on('update-downloaded', (info) => {
        emit({ status: 'ready', version: info.version, progress: 100 });
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

// Release notes can be a string or an array of {version, note}; flatten to text.
function normalizeNotes(notes) {
    if (!notes) return null;
    if (typeof notes === 'string') return notes.replace(/<[^>]+>/g, '').trim().slice(0, 2000) || null;
    if (Array.isArray(notes)) {
        return notes.map((n) => (n && n.note ? n.note : '')).join('\n').replace(/<[^>]+>/g, '').trim().slice(0, 2000) || null;
    }
    return null;
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
}

function getState() { return state; }

module.exports = { init, checkOnLaunch, checkNow, startDownload, installNow, setAuto, getState, available };
