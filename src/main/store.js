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
    // RNNoise. Both of these were written by the app and read all over it while
    // being absent from this list, so "the default" was whatever `undefined`
    // happened to mean at each call site.
    noiseSuppressionAI: false,
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
    // Downloading and installing are no longer optional — this only decides
    // whether the app restarts ITSELF once an update is ready, or waits until
    // you close it. Either way you end up on the new version.
    autoUpdateOnLaunch: true,
    autoRestartMigrated: false,  // set once by load(); see the note there
    notifications: true,
    notificationSound: true,     // new-message chime + sound on OS notifications
    voiceSounds: true,           // join / leave announcements while in a call
    // Spoken join/leave announcements ("X has joined the channel"). The texts
    // stand in for the USERNAME when set — letters and spaces only, 20 chars,
    // enforced at every layer that reads them. announceVoice picks which
    // installed speech voice reads them out, for this listener's own ears.
    greetText: '',               // spoken instead of the username on join
    farewellText: '',            // spoken instead of the username on leave
    announceVoice: 'female',     // 'female' | 'male' — the Voice Type filter
    // The specific aura speaker for MY announcements-as-heard-by-me. Empty
    // means "the gender's default" (asteria/orion), which the server picks —
    // so an old profile behaves exactly as before the catalog existed.
    announceSpeaker: '',
    windowBounds: null,          // restored geometry (never the maximised rect)
    windowMaximized: false,
    // The custom theme: { base: 'dark'|'light', colors: ['#rrggbb', …], intensity: 0-100 }.
    // Null until somebody opens the customizer; theme.js normalizes whatever
    // is read back, so a hand-edited file cannot break the renderer.
    customTheme: null,
    // One-shot, written by the process an update is replacing and consumed by
    // the one that comes back: "the window was on screen when they clicked
    // Restart Now, so put it back on screen" — even on a start-minimized
    // profile. See createWindow in main.js.
    updateResumeVisible: false,
    // Which version this profile is RUNNING, and the one it ran before that.
    //
    // Settings › About marks every release published after `previousVersion`
    // as new to this reader, which is only answerable if something remembers
    // where they were before the update — the feed knows what exists, not what
    // this person has already read. Written by main.js on the first launch of
    // a new version and left alone otherwise, so relaunching the same build
    // never erases the marker (see the note there).
    lastRunVersion: '',
    previousVersion: '',
    chatFontSize: 'medium',      // small | medium | large | xlarge

    // Shell layout
    showMembers: true,           // right-hand members sidebar
    // Panel widths, in CSS pixels, both draggable by their inner edge. Clamped by
    // the renderer against the window's actual width as well as against these
    // constants, so neither can be dragged over the message column — see
    // SIDEBAR_MIN/MAX in app.js. Defaults match the values the stylesheet shipped
    // with, so an existing profile looks identical until somebody drags something.
    sidebarWidth: 300,
    membersWidth: 264,
    catTextOpen: true,           // "Text Channels" category expanded
    catDmsOpen: true,            // "Direct Messages" category expanded
    catVoiceOpen: true,          // "Voice Channels" category expanded

    // Appearance
    theme: 'dark',               // 'dark' | 'ash' | 'onyx' | 'light' | 'system' | 'custom'
    density: 'cozy',             // 'cozy' | 'compact'

    // Presence you CHOOSE, as opposed to the one computed from window focus and
    // idle time. 'online' means "let the app decide" and is what auto-away hangs
    // off; the other three are overrides.
    //   online | idle | dnd | invisible
    // `dnd` below is kept in step with this so the Settings checkbox, and every
    // older build and test that reads the boolean, still agree with the picker.
    presence: 'online',

    // Notifications
    dnd: false,                  // do not disturb: silences every alert + sound
    mutedChannels: [],           // legacy binary mute; still written for older builds + the website
    channelAlerts: {},           // channel -> 'all' | 'mentions' | 'none' ('all' is implied by absence)
    // Muting a channel FOR A WHILE. A second axis from channelAlerts, which is
    // how the reference has it: the level says what a channel is normally worth
    // hearing about, and a mute says "not for the next three hours" without
    // throwing that away. channel -> epoch ms, or -1 for "until I turn it back
    // on"; absent means not muted.
    channelMuteUntil: {},
    // Flash the taskbar button when a message arrives while the window is not
    // focused. Separate from `notifications`: one is a toast, the other is the
    // button in the taskbar, and the reference offers them separately.
    taskbarFlash: true,
    // A chime for a message in the channel you are ALREADY READING. Off, like the
    // reference: you are looking at it.
    soundOwnChannel: false,
    // The master switch under all of them. Kept apart from `dnd`, which also
    // silences toasts and badges — this is sounds only.
    disableAllSounds: false,
    // The unread count drawn on the taskbar button (see main/badge.js).
    badgeUnread: true,

    // Accessibility
    // Chat text size in PIXELS. Replaces the old four-name scale (chatFontSize),
    // which is still read once to seed this — see load(). 12-24 to match the
    // reference's slider.
    chatFontPx: 16,
    underlineLinks: false,       // links always underlined, not only on hover
    uiDensity: 'default',        // 'compact' | 'default' | 'spacious' — sidebar + member list
    msgGroupGap: 16,             // px between message groups, 0-24
    zoomLevel: 100,              // whole-interface zoom, 50-200 (Ctrl +/-/0 also drives it)
    saturation: 100,             // 0-100; a filter over the app, not over media
    highContrast: false,
    // A manual override for people whose OS setting is off but who still want it.
    // The prefers-reduced-motion rules already in styles.css are the other half.
    reducedMotion: false,
    // Make the message list an assertive live region so a screen reader reads new
    // messages out. Off by default: it is the right behaviour for somebody using
    // one and noise for everybody else.
    announceMessages: false,

    // System
    // Chromium's GPU compositing. Turning it off needs a restart, which the UI
    // says and offers — main.js reads this before app-ready.
    hardwareAcceleration: true,

    // Privacy — local only; the board has no server-side block
    blocked: {},                 // clientId -> display name

    // Soundboard clip level, 0–1. Clips are mixed into the outgoing mic, so
    // this is how loud everyone ELSE hears them, not just you.
    soundboardVolume: 0.8,

    // Input gain, 0-2. Applied to the microphone before it is published, so
    // this is how loud EVERYONE ELSE hears you, not a local monitor level.
    micVolume: 1,

    // RMS x100 above which you read as "speaking"; see voice.js
    speakThreshold: 6,

    // Edit Mode.
    //
    // A layout is a rectangle per element — x/y/w/h as FRACTIONS of the app box,
    // so an arrangement survives a resized window — plus a shown/hidden flag,
    // under a name. `activeLayout` names the one in force; 'default' is the CSS
    // grid the app has always drawn and is not in this list, cannot be edited in
    // place and cannot be deleted. Capped at 10 by the renderer, and the cap is
    // re-applied on read because this file outlives any one build.
    //
    // normalizeLayout() in app.js is what actually holds these to their shape: a
    // settings file is editable by hand, and a rectangle with a NaN in it is an
    // element drawn nowhere at all.
    layouts: [],
    activeLayout: 'default',
    // The editor's own controls, remembered between sessions the way the
    // reference remembers them: grid on/off, its pitch in pixels, whether
    // elements snap to each other, and where the panel was left.
    editorPrefs: { showGrid: true, gridSize: 24, snapGrid: true, snapElements: true },

    // Chat
    // Ctrl+Up / Ctrl+Down in the message box walks back through what you have
    // sent. On by default — it does nothing until the keys are pressed, and
    // those two chords do nothing else in a textarea.
    messageRecall: true,
    // Draw the Markdown in the message box as it is typed — bold actually bold,
    // the ** dimmed beside it. A view over the same textarea, never a different
    // document: what is sent is exactly what is in the box.
    richComposer: true,
    // Whether the formatting toolbar is remembered between sessions. Off, like
    // the reference's: the bar is a thing you open when you want it.
    formatBarOpen: false,
    // The last MESSAGE_HISTORY_MAX (25) message bodies, newest FIRST. Persisted
    // so the history survives a restart, and CLEARED BY teardownSession() the
    // way the drafts and the composer are: it is a record of what somebody
    // typed, and the next person to sign in on this machine must not be able to
    // press Ctrl+Up and read it.
    messageHistory: []
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

// Accepts anything parseable whose scheme+host is allow-listed. This is the
// test net.js applies to a RESOLVED request url — which legitimately carries a
// path, a query and sometimes a fragment — so it deliberately looks at nothing
// but the origin.
function isAllowedOrigin(value) {
    let u;
    try { u = new URL(String(value || '')); } catch (e) { return false; }
    // ws:/wss: are the same origins reached by rt.js's socket.
    const scheme = u.protocol === 'wss:' ? 'https:' : (u.protocol === 'ws:' ? 'http:' : u.protocol);
    return ALLOWED_ORIGINS.includes(scheme + '//' + u.hostname);
}

// …which is exactly why the STORED baseUrl has to be held to a stricter rule.
// net.js concatenates a path onto it, so any path, query or fragment left on
// the stored value is a splice point: a baseUrl of
// "https://scarmonit.com/api/board/account/login#" turns a request for
// "/api/board/list" into "…/account/login#/api/board/list", whose real path is
// the account endpoint while every guard upstream — which resolves the caller's
// path against the origin — sees an innocuous "list". That reaches any endpoint
// on the host with both credentials attached and hands the reply back verbatim.
//
// So a base url is accepted only when it is a BARE ORIGIN, and what gets stored
// is the parsed origin rather than the caller's string. There is nothing to
// splice onto.
function normalizeBaseUrl(value) {
    let u;
    try { u = new URL(String(value || '')); } catch (e) { return null; }
    if (!isAllowedOrigin(u.href)) return null;
    if (u.username || u.password) return null;
    if (u.pathname !== '/' && u.pathname !== '') return null;
    if (u.search || u.hash) return null;
    // Keeps the port, which the loopback dev server needs.
    return u.origin;
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
    // "Genuinely new" is not "settings.json is missing".
    //
    // writeNow() saves by rotating settings.json to settings.json.bak and then
    // renaming the temp file over it, and its own comment names the state in
    // between: no settings.json, a complete .bak. That state is not
    // hypothetical on Windows and does not need a crash to reach — the second
    // rename fails outright when an antivirus scanner or the search indexer
    // still holds a handle on the file just written, and the catch there
    // unlinks the temp copy. It is also where a hard kill lands, which is
    // exactly how this process ends when the update installer takes over.
    // load() is built to recover from it, and does.
    //
    // Testing only for settings.json handed that profile to this function
    // first, which read it as a first run and copied a long-abandoned "The
    // Lounge" profile straight over the live one: settings.json — so load()
    // never saw the .bak that still held the real settings, and the next save
    // rotated it away for good — plus session.bin and Local State, which is
    // Chromium's OSCrypt key. account.bin is not in that list, so it was left
    // encrypted under a key that no longer existed: readSecret() returned
    // nothing and the user was signed out of the account this app has required
    // since v0.9.1. Every setting silently reverted at the same time. All of it
    // from one failed rename, in a function whose contract above is that it
    // "never overwrites existing settings".
    //
    // Any of these means this app has already run here, and nothing may be
    // adopted over it. Local State is deliberately not among them — Chromium
    // writes that one itself.
    for (const mine of ['settings.json', 'settings.json.bak', 'session.bin', 'account.bin']) {
        if (fs.existsSync(path.join(dir, mine))) return;
    }

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
    // Held outside the try because the migrations below have to distinguish "the
    // file did not have this key" from "the default happens to equal it".
    let raw = null;
    try {
        raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (e) {
        // Falling straight back to DEFAULTS here is a full, silent reset of
        // every setting the user has — and the failure is not always "the file
        // is gone": an empty file after a power cut, or a transient read error
        // in the first seconds after logon (exactly when the login item starts
        // us, with an antivirus scan and every other autostart hammering the
        // disk), read the same as a fresh install. writeNow() rotates the
        // previous good file to .bak on every save, so that copy is at worst
        // one debounce window stale — recover from it instead.
        if (e.code !== 'ENOENT') {
            console.error(`[store] settings.json unreadable (${e.message}) — trying the backup copy`);
        }
        try {
            raw = JSON.parse(fs.readFileSync(settingsPath + '.bak', 'utf8'));
            console.warn('[store] settings restored from the backup copy');
        } catch (e2) {
            if (e.code === 'ENOENT' && e2.code === 'ENOENT') {
                console.log('[store] no stored settings — first run');
            } else {
                console.error('[store] settings unrecoverable — starting from defaults');
            }
            return Object.assign({}, DEFAULTS);
        }
    }
    // Merged key by key for the same reason set() is: Object.assign writes
    // through the setter, so a "__proto__" key in a hand-edited (or
    // corrupted) settings.json would re-point this object's prototype.
    merged = Object.assign({}, DEFAULTS);
    for (const key of Object.keys(raw || {})) {
        if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
        if (UNSAFE_KEYS.includes(key)) {
            console.warn('[store] ignored a prototype-polluting key in settings.json: ' + key);
            continue;
        }
        merged[key] = raw[key];
    }
    // autoUpdateOnLaunch changed meaning. It used to gate whether updates were
    // downloaded at all and shipped OFF, so nearly every existing profile has a
    // stored `false` that was never a decision — it was the default. It now
    // only chooses whether the app restarts itself, and defaults ON.
    //
    // Carrying the old false forward would leave people on a build we have
    // already fixed for exactly the reason the setting no longer exists. One
    // migration, marked so it cannot run twice and undo a real preference.
    if (!merged.autoRestartMigrated) {
        merged.autoUpdateOnLaunch = true;
        merged.autoRestartMigrated = true;
    }

    // Chat text size went from a four-name scale to a pixel value, because the
    // reference's control is a 12-24px slider and four names cannot express it.
    // A profile that had picked one of those names keeps that size rather than
    // being reset to the middle — the sizes are the ones FONT_SIZES shipped with.
    if (raw && raw.chatFontPx === undefined && typeof raw.chatFontSize === 'string') {
        const px = { small: 14, medium: 16, large: 18, xlarge: 21 }[raw.chatFontSize];
        if (px) merged.chatFontPx = px;
    }

    // A hand-edited (or previously written) settings.json is just as capable of
    // aiming the credentials somewhere else as the renderer is, so the file is
    // held to the same rule.
    const base = normalizeBaseUrl(merged.baseUrl);
    if (!base) {
        console.warn(`[store] stored baseUrl "${merged.baseUrl}" is not an allowed origin — using the default`);
        merged.baseUrl = DEFAULTS.baseUrl;
    } else {
        merged.baseUrl = base;
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
        // The outgoing file becomes the backup load() recovers from when the
        // real one reads back broken. Rotated by rename, so it costs no extra
        // write; the ENOENT on the very first save is the only acceptable
        // failure. A crash between the two renames leaves no settings.json but
        // a complete .bak — which is exactly the case load() handles.
        try { fs.renameSync(settingsPath, settingsPath + '.bak'); }
        catch (e) { if (e.code !== 'ENOENT') console.warn('[store] could not rotate the settings backup:', e.message); }
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
        if (key === 'baseUrl') {
            const base = normalizeBaseUrl(patch[key]);
            if (!base) {
                console.warn(`[store] refused baseUrl "${patch[key]}" — not a bare allowed origin`);
                continue;
            }
            cache[key] = base;
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

// Signing out has to actually destroy the credential. unlinkSync's catch can't
// tell "already gone" (ENOENT, fine) from "couldn't delete it" (EPERM/EBUSY — a
// virus scanner or a file lock), and on the latter the next launch reads the
// blob straight back and silently signs the user in again. So a failure that
// isn't ENOENT falls back to overwriting the file with nothing, which leaves
// unreadable garbage rather than a live credential.
function destroySecret(p, label) {
    if (!p) return;
    try {
        fs.unlinkSync(p);
        return;
    } catch (e) {
        if (e && e.code === 'ENOENT') return;
        console.warn(`[store] could not delete the ${label} file (${e.message}) — blanking it instead`);
    }
    try {
        fs.writeFileSync(p, '');
    } catch (e) {
        console.error(`[store] the ${label} file could not be cleared: ${e.message}`);
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
    destroySecret(sessionPath, 'session');
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
    destroySecret(accountPath, 'account token');
}

module.exports = {
    init, get, set, flush, readSession, writeSession, clearSession,
    readAccountToken, writeAccountToken, clearAccountToken,
    migrateLegacyProfile, isAllowedOrigin, normalizeBaseUrl, DEFAULTS
};
