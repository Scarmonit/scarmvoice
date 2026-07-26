// Persisted settings + the session cookie.
//
// Settings are plain JSON in userData. The session cookie is a bearer-equivalent
// credential, so it goes through Electron's safeStorage (DPAPI on Windows) and
// is written to a separate file that never lands in a log or a settings dump.
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const DEFAULTS = {
    baseUrl: 'https://scarmonit.com',
    room: 'lounge',
    displayName: '',
    status: '',                 // free-text status shown beside your name
    clientId: '',
    channel: 'general',

    // Voice
    micDeviceId: '',
    speakerDeviceId: '',
    voiceMode: 'open',          // 'open' | 'ptt'
    // Recorded in the renderer from a KeyboardEvent/MouseEvent; see main/ptt.js.
    pttBinding: { type: 'key', code: 'Backquote', ctrl: false, shift: false, alt: false, meta: false },
    pttKey: 'CommandOrControl+Shift+Space',   // accelerator used only by the toggle fallback
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: false,     // AGC self-modulates level ("wobble") — off, as on the site
    inputVolume: 1,
    outputVolume: 1,
    autoJoinVoice: false,

    // Screen share — same tiers the website offers.
    shareQuality: '1080p',      // '720p' | '1080p' | '1440p'
    shareMotion: 'sharp',       // 'sharp' (crisp text) | 'smooth' (fluid motion)
    shareAudio: true,           // include system audio (Windows loopback)

    // Per-participant local prefs, keyed by clientId
    localVolumes: {},
    localMuted: {},

    // App
    minimizeToTray: true,
    startMinimized: false,       // also used as the login item's "open hidden"
    launchOnStartup: false,      // mirror of the OS login item; OS state is source of truth
    autoUpdateOnLaunch: false,   // check + download updates in the background at startup
    notifications: true,
    notificationSound: true,     // new-message chime + sound on OS notifications
    voiceSounds: true,           // join / leave chimes while in a call
    windowBounds: null,          // restored geometry (never the maximised rect)
    windowMaximized: false,
    chatFontSize: 'medium',      // small | medium | large | xlarge

    // Shell layout
    showMembers: true,           // right-hand members sidebar
    catTextOpen: true,           // "Text Channels" category expanded
    catVoiceOpen: true,          // "Voice Channels" category expanded

    // Appearance
    theme: 'dark',               // 'dark' | 'light' | 'system'
    density: 'cozy',             // 'cozy' | 'compact'

    // Notifications
    dnd: false,                  // do not disturb: silences every alert + sound
    mutedChannels: [],           // channel names that never notify

    // Privacy — local only; the board has no server-side block
    blocked: {},                 // clientId -> display name

    // RMS x100 above which you read as "speaking"; see voice.js
    speakThreshold: 6
};

// The app used to be called "The Lounge", and productName decides
// app.getPath('userData'). Renaming it would silently strand the old settings
// and session, signing everyone out — so adopt the old profile once.
const LEGACY_APP_NAMES = ['The Lounge'];

// Per-participant maps (localVolumes, localMuted, blocked) are keyed by client
// id and nothing ever removes an entry, so they grow for the life of the
// profile. Cap them at a size no real room approaches; oldest keys go first,
// which is the best proxy for "least recently relevant" without timestamps.
const MAX_PEER_ENTRIES = 500;

let settingsPath = null;
let sessionPath = null;
let cache = null;

function init() {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    settingsPath = path.join(dir, 'settings.json');
    sessionPath = path.join(dir, 'session.bin');
    cache = load();
    prunePeerMaps();
    if (!cache.clientId) {
        // Stable identity across restarts. Matches the website's client id shape
        // so the same person reads consistently in presence + per-user volume prefs.
        cache.clientId = 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        // Written immediately, not debounced: this is the identity everyone else
        // sees us by, and losing it to a crash in the first 250 ms would orphan
        // every per-user preference keyed against it.
        writeNow();
    }
}

// One-time adoption of a previous app name's profile. Only runs when this
// profile is genuinely new — it never overwrites existing settings.
//
// MUST run before Electron initialises, which is why main.js calls this at
// module scope rather than inside app.whenReady(). "Local State" holds
// Chromium's OSCrypt key, and safeStorage encrypts with a key unique to each
// profile — copying session.bin without it yields a file the new profile
// cannot decrypt, silently signing the user out.
function migrateLegacyProfile() {
    const dir = app.getPath('userData');
    if (fs.existsSync(path.join(dir, 'settings.json'))) return;

    const parent = path.dirname(dir);
    for (const legacy of LEGACY_APP_NAMES) {
        const from = path.join(parent, legacy);
        if (!fs.existsSync(path.join(from, 'settings.json'))) continue;

        fs.mkdirSync(dir, { recursive: true });
        const copied = [];
        for (const file of ['settings.json', 'session.bin', 'Local State']) {
            const src = path.join(from, file);
            if (!fs.existsSync(src)) continue;
            try { fs.copyFileSync(src, path.join(dir, file)); copied.push(file); }
            catch (e) { console.error('[store] could not migrate ' + file + ':', e.message); }
        }
        console.log(`[store] adopted ${copied.join(', ')} from the previous "${legacy}" profile`);
        return;
    }
}

function load() {
    try {
        const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        return Object.assign({}, DEFAULTS, raw);
    } catch (e) {
        return Object.assign({}, DEFAULTS);
    }
}

// Writes are ATOMIC: a full file is written to a sibling temp path and then
// renamed over the real one, which is atomic on NTFS. The old code wrote in
// place, so a crash or power loss mid-write left a truncated settings.json —
// and load() silently falls back to DEFAULTS, so the symptom was "every setting
// reset itself", including the clientId that identifies you to everyone else.
function writeNow() {
    if (!settingsPath) return;
    const tmp = settingsPath + '.tmp';
    try {
        fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
        fs.renameSync(tmp, settingsPath);
    } catch (e) {
        console.error('[store] failed to save settings:', e.message);
        try { fs.unlinkSync(tmp); } catch (_) { /* nothing to clean up */ }
    }
}

// …and DEBOUNCED, because the renderer's sliders (per-user volume, output
// volume, the speaking threshold) persist on every 'input' event. Dragging one
// used to mean ~60 synchronous whole-file writes per second on the main
// process's main thread, which blocks the UI and the IPC queue with it.
const SAVE_DEBOUNCE_MS = 250;
let saveTimer = null;

function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; writeNow(); }, SAVE_DEBOUNCE_MS);
}

// Called on quit so the last change in a debounce window is never lost.
function flush() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    writeNow();
}

// Drop the oldest entries from the unbounded per-peer maps. Insertion order is
// preserved by JSON.parse and by Object.assign, so the first keys really are
// the ones written longest ago.
function prunePeerMaps() {
    ['localVolumes', 'localMuted', 'blocked'].forEach((key) => {
        const map = cache[key];
        if (!map || typeof map !== 'object') return;
        const keys = Object.keys(map);
        if (keys.length <= MAX_PEER_ENTRIES) return;
        keys.slice(0, keys.length - MAX_PEER_ENTRIES).forEach((k) => delete map[k]);
        console.log(`[store] pruned ${key} to ${MAX_PEER_ENTRIES} entries`);
    });
}

function get() {
    return Object.assign({}, cache);
}

function set(patch) {
    if (!patch || typeof patch !== 'object') return get();
    Object.assign(cache, patch);
    prunePeerMaps();
    save();
    return get();
}

// ---- session cookie ------------------------------------------------------

function readSession() {
    let buf;
    try {
        buf = fs.readFileSync(sessionPath);
    } catch (e) {
        console.log('[store] no stored session');
        return '';
    }
    try {
        if (safeStorage.isEncryptionAvailable()) {
            const s = safeStorage.decryptString(buf);
            console.log('[store] session restored (' + s.length + ' chars)');
            return s;
        }
        console.log('[store] safeStorage unavailable — reading session as plaintext');
        return buf.toString('utf8');
    } catch (e) {
        console.error('[store] could not decrypt the stored session: ' + e.message);
        return '';
    }
}

function writeSession(token) {
    try {
        if (!token) { clearSession(); return; }
        const data = safeStorage.isEncryptionAvailable()
            ? safeStorage.encryptString(token)
            : Buffer.from(token, 'utf8');
        // Atomic for the same reason settings.json is: a crash mid-write would
        // leave a truncated blob that fails to decrypt and silently signs the
        // user out on next launch.
        const tmp = sessionPath + '.tmp';
        fs.writeFileSync(tmp, data);
        fs.renameSync(tmp, sessionPath);
    } catch (e) {
        console.error('[store] failed to save session:', e.message);
    }
}

function clearSession() {
    try { fs.unlinkSync(sessionPath); } catch (e) { /* already gone */ }
}

module.exports = {
    init, get, set, flush, readSession, writeSession, clearSession,
    migrateLegacyProfile, DEFAULTS
};
