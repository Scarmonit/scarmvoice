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

// baseUrl decides which host receives the sb_auth cookie AND the account token,
// both bearer-equivalent credentials. Left as free text it is a one-field
// account takeover ("point the app at this mirror"), in cleartext if the value
// is http:. So only origins we actually ship may be set, plus loopback for
// running against a local `wrangler pages dev`. Compared by scheme + hostname so
// a dev server on any port still works.
const ALLOWED_ORIGINS = [
    'https://scarmonit.com',
    'http://localhost',
    'http://127.0.0.1'
];

// Keys that reach Object.prototype if they are ever assigned through a plain
// property write — a renderer-supplied patch must never be able to re-point the
// settings cache's prototype.
const UNSAFE_KEYS = ['__proto__', 'constructor', 'prototype'];

// Accepts anything parseable whose scheme+host is allow-listed; used both to
// validate what the renderer asks us to store and (in net.js) to decide whether
// a resolved request URL may carry credentials.
function isAllowedOrigin(value) {
    let u;
    try { u = new URL(String(value || '')); } catch (e) { return false; }
    // ws:/wss: are the same origins reached by rt.js's socket.
    const scheme = u.protocol === 'wss:' ? 'https:' : (u.protocol === 'ws:' ? 'http:' : u.protocol);
    return ALLOWED_ORIGINS.includes(scheme + '//' + u.hostname);
}

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
let accountPath = null;
let cache = null;

function init() {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    settingsPath = path.join(dir, 'settings.json');
    sessionPath = path.join(dir, 'session.bin');
    accountPath = path.join(dir, 'account.bin');
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
    let merged;
    try {
        const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        merged = Object.assign({}, DEFAULTS, raw);
    } catch (e) {
        return Object.assign({}, DEFAULTS);
    }
    // A hand-edited (or previously written) settings.json is just as capable of
    // aiming the credentials somewhere else as the renderer is, so the file is
    // held to the same rule.
    if (!isAllowedOrigin(merged.baseUrl)) {
        console.warn(`[store] stored baseUrl "${merged.baseUrl}" is not an allowed origin — using the default`);
        merged.baseUrl = DEFAULTS.baseUrl;
    }
    return merged;
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

// Every value here arrives from the renderer over IPC, so the patch is applied
// key by key rather than with Object.assign: assign honours a "__proto__" key
// (it writes through the setter) and would re-point the cache's prototype, and
// it has no place to reject a value the app must not act on.
function set(patch) {
    if (!patch || typeof patch !== 'object') return get();
    for (const key of Object.keys(patch)) {
        if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
        if (UNSAFE_KEYS.includes(key)) {
            console.warn('[store] refused a prototype-polluting settings key: ' + key);
            continue;
        }
        if (key === 'baseUrl' && !isAllowedOrigin(patch[key])) {
            console.warn(`[store] refused baseUrl "${patch[key]}" — not an allowed origin`);
            continue;
        }
        cache[key] = patch[key];
    }
    prunePeerMaps();
    save();
    return get();
}

// ---- credential blobs ------------------------------------------------------
// safeStorage is not guaranteed to be available on every launch — a broken
// keyring on Linux, a profile copied to another machine, an OSCrypt key that
// went missing — and the mode can therefore differ between the write and the
// read. Unmarked, that is silent corruption in both directions: a plaintext blob
// read as ciphertext throws and reads as "signed out", and an encrypted blob
// read as plaintext hands back binary garbage that is then sent as a credential.
// So each blob records the mode it was written in and the reader dispatches on
// it. Files written before the marker existed carry no prefix and keep the old
// best-effort handling.
const BLOB_MAGIC = Buffer.from('SV');    // "written by this scheme"
const BLOB_ENCRYPTED = 0x01;
const BLOB_PLAINTEXT = 0x00;

// Returns null when there is no file at all, '' when it exists but is unusable.
function readSecret(file, label) {
    let buf;
    try { buf = fs.readFileSync(file); } catch (e) { return null; }

    const marked = buf.length >= 3 && buf[0] === BLOB_MAGIC[0] && buf[1] === BLOB_MAGIC[1] &&
        (buf[2] === BLOB_ENCRYPTED || buf[2] === BLOB_PLAINTEXT);
    if (marked) {
        const payload = buf.subarray(3);
        if (buf[2] === BLOB_PLAINTEXT) return payload.toString('utf8');
        if (!safeStorage.isEncryptionAvailable()) {
            console.error(`[store] the stored ${label} is encrypted but safeStorage is unavailable here`);
            return '';
        }
        try {
            return safeStorage.decryptString(payload);
        } catch (e) {
            console.error(`[store] could not decrypt the stored ${label}: ` + e.message);
            return '';
        }
    }

    try {
        if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(buf);
        console.log(`[store] safeStorage unavailable — reading the ${label} as plaintext`);
        return buf.toString('utf8');
    } catch (e) {
        console.error(`[store] could not decrypt the stored ${label}: ` + e.message);
        return '';
    }
}

// Atomic for the same reason settings.json is: a crash mid-write would leave a
// truncated blob that fails to decrypt and silently signs the user out on the
// next launch. The temp file is removed when the rename fails, or a readable
// credential is left lying around in a path nothing ever cleans up.
function writeSecret(file, token, label) {
    const encrypted = safeStorage.isEncryptionAvailable();
    if (!encrypted) {
        console.warn(`[store] safeStorage unavailable — the ${label} is being written as PLAINTEXT`);
    }
    const tmp = file + '.tmp';
    try {
        const body = encrypted ? safeStorage.encryptString(token) : Buffer.from(token, 'utf8');
        const data = Buffer.concat([
            BLOB_MAGIC,
            Buffer.from([encrypted ? BLOB_ENCRYPTED : BLOB_PLAINTEXT]),
            Buffer.from(body)
        ]);
        fs.writeFileSync(tmp, data);
        fs.renameSync(tmp, file);
    } catch (e) {
        console.error(`[store] failed to save the ${label}:`, e.message);
        try { fs.unlinkSync(tmp); } catch (_) { /* nothing to clean up */ }
    }
}

// ---- session cookie ------------------------------------------------------

function readSession() {
    const s = readSecret(sessionPath, 'session');
    if (s === null) { console.log('[store] no stored session'); return ''; }
    if (s) console.log('[store] session restored (' + s.length + ' chars)');
    return s;
}

function writeSession(token) {
    if (!token) { clearSession(); return; }
    writeSecret(sessionPath, token, 'session');
}

function clearSession() {
    try { fs.unlinkSync(sessionPath); } catch (e) { /* already gone */ }
}

// ---- board account token ---------------------------------------------------
// Same treatment as the session cookie: safeStorage-encrypted, atomic write.

function readAccountToken() {
    const s = readSecret(accountPath, 'account token');
    return s === null ? '' : s;
}

function writeAccountToken(token) {
    if (!token) { clearAccountToken(); return; }
    writeSecret(accountPath, token, 'account token');
}

function clearAccountToken() {
    try { fs.unlinkSync(accountPath); } catch (e) { /* already gone */ }
}

module.exports = {
    init, get, set, flush, readSession, writeSession, clearSession,
    readAccountToken, writeAccountToken, clearAccountToken,
    migrateLegacyProfile, isAllowedOrigin, DEFAULTS
};
