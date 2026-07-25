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

let settingsPath = null;
let sessionPath = null;
let cache = null;

function init() {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    settingsPath = path.join(dir, 'settings.json');
    sessionPath = path.join(dir, 'session.bin');
    cache = load();
    if (!cache.clientId) {
        // Stable identity across restarts. Matches the website's client id shape
        // so the same person reads consistently in presence + per-user volume prefs.
        cache.clientId = 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        save();
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

function save() {
    try {
        fs.writeFileSync(settingsPath, JSON.stringify(cache, null, 2));
    } catch (e) {
        console.error('[store] failed to save settings:', e.message);
    }
}

function get() {
    return Object.assign({}, cache);
}

function set(patch) {
    if (!patch || typeof patch !== 'object') return get();
    Object.assign(cache, patch);
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
        fs.writeFileSync(sessionPath, data);
    } catch (e) {
        console.error('[store] failed to save session:', e.message);
    }
}

function clearSession() {
    try { fs.unlinkSync(sessionPath); } catch (e) { /* already gone */ }
}

module.exports = {
    init, get, set, readSession, writeSession, clearSession,
    migrateLegacyProfile, DEFAULTS
};
