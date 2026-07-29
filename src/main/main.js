// ScarmVoice — desktop client for the scarmonit.com message board + voice room.
//
// Main-process responsibilities:
//   • window + tray lifecycle
//   • ALL authenticated network I/O (net.js, rt.js) — see net.js for why
//   • global push-to-talk (ptt.js)
//   • a lounge:// protocol that proxies cookie-gated attachments to the renderer
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const {
    app, BrowserWindow, Tray, Menu, ipcMain, shell, protocol, session, Notification, nativeImage,
    desktopCapturer, dialog, clipboard, screen, powerMonitor, nativeTheme
} = require('electron');

const log = require('./log');
const badge = require('./badge');
const store = require('./store');
const net = require('./net');
const boardpath = require('./boardpath');
const rt = require('./rt');
const ptt = require('./ptt');
const updater = require('./updater');

const DEV = process.argv.includes('--dev');
const ICON = path.join(__dirname, '..', '..', 'build', 'icon.ico');

let win = null;
let tray = null;
let quitting = false;
let voiceState = { inVoice: false, muted: false, deafened: false };
let pendingShareSource = null;   // { id, audio, at } chosen in the renderer's picker
// A pick the SDK never consumed must not satisfy some later request — see the
// display-media handler.
const SHARE_PICK_TTL_MS = 60000;
const youtubeCache = new Map();  // videoId -> { value, until }
const YOUTUBE_CACHE_MAX = 500;
let isElevated = false;          // see the app:isElevated handler

// Elevation matters because Windows silently blocks drag-and-drop from Explorer
// into an elevated window, so we warn about it.
//
// Listing %SystemRoot%\System32\config requires administrator rights, which
// makes it a reliable probe costing one syscall (~0.1 ms). This replaced
// `child_process.exec('net session')`, which shelled through cmd.exe and spawned
// conhost + net + net1 on every launch — wasteful, and a GUI app invoking
// net.exe at startup is exactly the recon pattern EDR heuristics flag.
//
// Do NOT "simplify" this to fs.accessSync(dir, R_OK): on Windows that returns
// success for a NON-elevated process too, so it reports everyone as elevated.
// Verified both ways — readdir throws EPERM unelevated, succeeds elevated.
//
// Synchronous on purpose: the old async probe left a window where the renderer
// could ask app:isElevated before the answer existed and get a wrong `false`.
function detectElevation() {
    if (process.platform !== 'win32') return;
    try {
        fs.readdirSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'config'));
        isElevated = true;
        console.warn('[app] running elevated — Windows will block drag-and-drop from Explorer');
    } catch (e) {
        isElevated = false;
    }
}

// Single instance: a second launch focuses the running window instead of
// opening a duplicate that would fight over the mic and the voice presence row.
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    // A second launch can arrive before `whenReady` resolves (double-clicked
    // shortcut, login item + manual launch); creating a BrowserWindow then
    // throws. Pre-ready there is nothing to focus yet — startup will show the
    // window itself — so only act once ready.
    app.on('second-instance', () => { if (app.isReady()) showWindow(); });
}

// Before anything else, so the console output of startup itself is captured and
// so the crash reporter is armed ahead of the first window.
log.install();

// Adopt the previous app name's profile before Electron touches the user data
// directory — see store.migrateLegacyProfile for why the timing matters.
store.migrateLegacyProfile();

// Chromium blocks audio until the page sees a user gesture. That rule exists to
// stop web pages autoplaying at you; in a desktop chat client it just means the
// first join/message chime is silently dropped. Must be set before app ready.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Grayscale antialiasing instead of subpixel (ClearType). The CSS property for
// this — -webkit-font-smoothing — is a no-op on Windows in Chromium, which is
// why setting it on <body> changed nothing: the switch is the only lever here.
// Subpixel rendering fringes every glyph edge with colour (measured: a channel
// spread of 86 across the user panel's own name, against 1 in the reference),
// which on a dark theme reads as a faint rainbow along the type.
app.commandLine.appendSwitch('disable-lcd-text');

// Must be registered before the app is ready.
protocol.registerSchemesAsPrivileged([{
    scheme: 'lounge',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false }
}]);

// ---- window --------------------------------------------------------------

const DEFAULT_SIZE = { width: 1180, height: 760 };

// A saved position is only usable if it still lands on a display that exists.
// Unplugging a monitor or changing resolution would otherwise restore the window
// somewhere unreachable, which looks exactly like the app failing to start.
function usableBounds(saved) {
    if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return null;
    if (!Number.isFinite(saved.width) || !Number.isFinite(saved.height)) return null;

    const displays = screen.getAllDisplays();
    // Require a decent overlap, not a single pixel, so a sliver hanging onto a
    // screen edge still counts as lost.
    const MIN_VISIBLE = 80;
    const onScreen = displays.some((d) => {
        const a = d.workArea;
        const overlapX = Math.min(saved.x + saved.width, a.x + a.width) - Math.max(saved.x, a.x);
        const overlapY = Math.min(saved.y + saved.height, a.y + a.height) - Math.max(saved.y, a.y);
        return overlapX >= MIN_VISIBLE && overlapY >= MIN_VISIBLE;
    });
    return onScreen ? saved : null;
}

// forceShow is set when the window is being created *in response to* the user
// asking for it (tray click, second launch). Without it, the startMinimized /
// --openAsHidden rule below would build the window and immediately leave it
// hidden — so the click would appear to do nothing.
function createWindow(forceShow) {
    const saved = store.get().windowBounds;
    const bounds = usableBounds(saved);
    if (saved && !bounds) {
        console.log('[window] saved position is off-screen — centring instead');
    }

    win = new BrowserWindow({
        width: (bounds && bounds.width) || DEFAULT_SIZE.width,
        height: (bounds && bounds.height) || DEFAULT_SIZE.height,
        // undefined lets Electron centre the window.
        x: bounds ? bounds.x : undefined,
        y: bounds ? bounds.y : undefined,
        minWidth: 900,
        minHeight: 560,
        show: false,
        backgroundColor: '#101218',
        icon: ICON,
        autoHideMenuBar: true,
        // Native window buttons drawn over our own title bar. The colour must
        // track the renderer's title bar (--rail) or the caption buttons sit on a
        // visible patch of the wrong shade.
        titleBarStyle: 'hidden',
        // Height and colour both track --tb / --side in styles.css: Windows
        // draws the caption buttons over our bar, so a mismatch leaves a notch.
        titleBarOverlay: { color: '#131316', symbolColor: '#e9ebf0', height: 31 },
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            spellcheck: true,
            // Keep the renderer's timers (the polling fallback, presence
            // heartbeat) running at full rate while hidden in the tray. Chromium
            // otherwise throttles background timers to ~once/minute, which — with
            // a stale socket — is why a tray-idle window stopped updating.
            backgroundThrottling: false
        }
    });

    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

    win.once('ready-to-show', () => {
        // Stay hidden in the tray if the user asked to start minimized, or if
        // Windows auto-launched us as a hidden login item (--openAsHidden).
        const startHidden = !forceShow &&
            (store.get().startMinimized || process.argv.includes('--openAsHidden'));
        if (!startHidden) win.show();
    });

    if (DEV) win.webContents.openDevTools({ mode: 'detach' });

    win.on('focus', () => win.webContents.send('win:focus', true));
    win.on('blur', () => {
        win.webContents.send('win:focus', false);
        // Nothing about the app's lifetime is guaranteed after this point — an
        // update, a crash, a kill — and a debounced settings write is 250ms of
        // exposure for something the user just chose. Only writes when one is
        // pending, so alt-tabbing costs nothing.
        store.flush();
    });
    win.on('hide', () => store.flush());

    // Whether the window is actually on screen — which the RENDERER cannot work
    // out for itself. `backgroundThrottling: false` (above) keeps its timers
    // running at full rate in the tray, and the price of that is that Chromium
    // also stops updating `document.hidden`: it reads `false` through both a
    // hide to the tray and a minimize, and `visibilitychange` never fires at
    // all. Every "skip this while nobody is looking" guard in the renderer was
    // written against that flag and so has never once run. Verified in this
    // Electron build, both ways.
    //
    // Sent separately from the resume wiring below, which is rate-limited to
    // one event per 5s: a fast hide/show/hide/show would otherwise leave the
    // renderer believing it is still put away during a call the user is
    // watching.
    const sendVisibility = () => {
        if (!win || win.isDestroyed()) return;
        win.webContents.send('win:hidden', !win.isVisible() || win.isMinimized());
    };
    ['hide', 'show', 'minimize', 'restore'].forEach((e) => win.on(e, sendVisibility));

    // Coming back from the tray / a minimize is exactly when a socket that died
    // while hidden needs to be checked and revived — verify the connection and
    // tell the renderer to resync any messages it missed while it was away.
    //
    // Rate-limited because one alt-tab can fire 'restore', 'show' AND 'focus',
    // and each of those costs a socket probe plus a full refetch in the
    // renderer. A few seconds of coalescing loses nothing: the heartbeat covers
    // anything that dies in between.
    const RESUME_COOLDOWN_MS = 5000;
    let lastResume = 0;
    const onResume = () => {
        const now = Date.now();
        if (now - lastResume < RESUME_COOLDOWN_MS) return;
        lastResume = now;
        rt.wake();
        if (win) win.webContents.send('app:resync');
    };
    win.on('restore', onResume);
    win.on('show', onResume);
    win.on('focus', onResume);

    // Resize/move fire continuously while dragging, so debounce rather than
    // writing settings.json on every pixel.
    let boundsTimer = null;
    const persistBounds = () => {
        clearTimeout(boundsTimer);
        boundsTimer = setTimeout(saveWindowState, 400);
    };
    win.on('resize', persistBounds);
    win.on('move', persistBounds);
    // Maximise/restore are discrete — record them straight away.
    win.on('maximize', saveWindowState);
    win.on('unmaximize', saveWindowState);
    // Flush on the way out so the last drag isn't lost to the debounce.
    win.on('close', () => { clearTimeout(boundsTimer); saveWindowState(); });

    if (store.get().windowMaximized) win.maximize();

    // Closing hides to tray while you're in voice (or if configured), so the
    // call doesn't drop because someone hit the X.
    win.on('close', (e) => {
        if (quitting) return;
        if (store.get().minimizeToTray || voiceState.inVoice) {
            e.preventDefault();
            win.hide();
        }
    });

    // Without this, a destroyed window (X with tray-hide off) leaves `win`
    // pointing at a dead object and the tray/showWindow paths throw
    // "Object has been destroyed" in the gap before quit.
    win.on('closed', () => { win = null; });

    // External links open in the real browser, never in-app.
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/.test(url)) openExternal(url);
        return { action: 'deny' };
    });
    // The app is a single page and never navigates itself, so allow only a
    // reload of the current URL and block everything else.
    //
    // This previously allowed ANY file:// URL, which meant dropping a file on
    // the window navigated the renderer to file:///C:/…/dropped.png — the whole
    // UI was replaced, so drag-and-drop looked like it silently did nothing.
    win.webContents.on('will-navigate', (e, url) => {
        if (url === win.webContents.getURL()) return;      // reload of ourselves
        e.preventDefault();
        if (/^https?:/.test(url)) openExternal(url);
    });
}

// shell.openExternal returns a promise that rejects when nothing is registered
// to handle the url. Unhandled, those land in the global rejection trap in
// log.js as anonymous noise; named here they say which url failed.
function openExternal(url) {
    return Promise.resolve(shell.openExternal(url)).then(() => true, (e) => {
        console.warn('[app] could not open externally:', url, e && e.message);
        return false;
    });
}

// Keeps the *restored* geometry, not the maximised rectangle — otherwise
// un-maximising later would snap the window to full-screen size.
function saveWindowState() {
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    const maximized = win.isMaximized();
    const patch = { windowMaximized: maximized };
    if (!maximized) patch.windowBounds = win.getNormalBounds();
    store.set(patch);
}

function showWindow() {
    // While the startup update gate is open there is no app window yet, and
    // creating one here would be exactly the partial startup the gate exists to
    // prevent — a second launch, or a tray click, would build the whole session
    // behind an update that is still applying. Point at the update screen
    // instead; the app window follows on its own the moment the gate answers.
    // …but the ask has to be REMEMBERED, not just deflected. On a
    // start-minimized install splashWanted is false, so no splash is ever built
    // and focusSplash() is a no-op — and startApp() then created the window
    // hidden. Two deliberate launches, and the user got a tray icon and nothing
    // else, with nothing anywhere recording that they had asked twice.
    if (updater.gateOpen()) { showOnStart = true; focusSplash(); return; }
    if (!win || win.isDestroyed()) { createWindow(true); return; }
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
}

// ---- the startup update screen -------------------------------------------
//
// A separate, tiny window rather than a state inside the app's own: the app
// window IS the thing being held back, so anything drawn in it would mean
// loading index.html, running the renderer and letting boot() start asking the
// board who we are — the startup this is supposed to come before.
//
// It is created LAZILY, and that is the whole reason launching does not feel
// slower. The common answer is "you are up to date" and it arrives in a few
// hundred milliseconds, in which case this window is never built at all and the
// app window appears as it always did. It is only summoned when there is
// genuinely something to look at: an update being fetched, or a check slow
// enough (see SPLASH_AFTER_MS) that silence would read as a failure to launch.

let splash = null;
let splashWanted = false;        // false for a hidden login-item launch
// Somebody asked for the window while the gate still had it. Only a genuine
// second launch can set this — the tray and notifications do not exist yet —
// so honouring it later cannot defeat the start-minimized rule on an ordinary
// login-item launch. See showWindow() and startApp().
let showOnStart = false;
let gateStep = { phase: 'checking', percent: 0, version: null };

// The window changes underneath the user with no interaction from them, so its
// content is pushed on every step rather than polled.
function paintSplash() {
    if (splash && !splash.isDestroyed() && !splash.webContents.isLoading()) {
        splash.webContents.send('update:gate', gateStep);
    }
}

function ensureSplash() {
    if (!splashWanted) return;
    if (splash && !splash.isDestroyed()) { paintSplash(); return; }

    splash = new BrowserWindow({
        width: 380,
        height: 264,
        show: false,
        center: true,
        // No chrome: there is nothing to minimise, maximise or navigate, and the
        // page draws its own quit button. Resizing a fixed message is noise.
        frame: false,
        resizable: false,
        maximizable: false,
        minimizable: false,
        fullscreenable: false,
        backgroundColor: '#0c0c0e',
        icon: ICON,
        // It is the only window at this point, so it must be findable in the
        // taskbar like any other app that is starting.
        skipTaskbar: false,
        title: 'ScarmVoice',
        webPreferences: {
            preload: path.join(__dirname, 'splash-preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            spellcheck: false
        }
    });

    splash.loadFile(path.join(__dirname, '..', 'renderer', 'updating.html'));
    // Painted on both: 'did-finish-load' is what guarantees the page's listener
    // exists, and 'ready-to-show' is when it is safe to reveal.
    splash.webContents.on('did-finish-load', paintSplash);
    splash.once('ready-to-show', () => {
        if (!splash || splash.isDestroyed()) return;
        splash.show();
        paintSplash();
    });
    splash.on('closed', () => { splash = null; });
}

function focusSplash() {
    if (!splash || splash.isDestroyed()) return;
    if (!splash.isVisible()) splash.show();
    splash.focus();
}

function closeSplash() {
    if (!splash || splash.isDestroyed()) { splash = null; return; }
    const s = splash;
    splash = null;                 // before close(), so 'closed' finds nothing to do
    try { s.destroy(); } catch (e) { /* already gone */ }
}

// The taskbar unread badge is drawn in badge.js (pixel work, no Electron).
let lastBadge = 0;              // so the taskbar only flashes on a real increase

// ---- tray ----------------------------------------------------------------

function trayTooltip() {
    if (!voiceState.inVoice) return 'ScarmVoice';
    const bits = [];
    if (voiceState.muted) bits.push('muted');
    if (voiceState.deafened) bits.push('deafened');
    return 'ScarmVoice — in voice' + (bits.length ? ` (${bits.join(', ')})` : '');
}

function buildTrayMenu() {
    return Menu.buildFromTemplate([
        { label: 'Open ScarmVoice', click: () => showWindow() },
        { type: 'separator' },
        {
            label: voiceState.muted ? 'Unmute microphone' : 'Mute microphone',
            enabled: voiceState.inVoice,
            click: () => win && win.webContents.send('app:command', { cmd: 'toggleMute' })
        },
        {
            label: voiceState.deafened ? 'Undeafen' : 'Deafen',
            enabled: voiceState.inVoice,
            click: () => win && win.webContents.send('app:command', { cmd: 'toggleDeafen' })
        },
        {
            label: voiceState.inVoice ? 'Leave voice' : 'Join voice',
            click: () => {
                // Joining needs a signed-in renderer with a voice engine. Before
                // that — a fresh launch closed to the tray, or an expired
                // session — the command reached a null `voice`, threw inside the
                // renderer's own try/catch and produced absolutely nothing: no
                // window, no toast, no sound. Show the window first, so at worst
                // the user lands on the screen that explains why.
                if (!voiceState.inVoice) showWindow();
                if (win) win.webContents.send('app:command', { cmd: voiceState.inVoice ? 'leaveVoice' : 'joinVoice' });
            }
        },
        { type: 'separator' },
        { label: 'Quit', click: () => { quitting = true; app.quit(); } }
    ]);
}

function createTray() {
    let image = nativeImage.createFromPath(ICON);
    if (!image.isEmpty()) image = image.resize({ width: 16, height: 16 });
    tray = new Tray(image);
    tray.setToolTip(trayTooltip());
    tray.setContextMenu(buildTrayMenu());
    // Hide only when the window is genuinely the thing in front of you.
    // isVisible() alone is true for a window sitting behind a browser AND for a
    // minimized one (WS_VISIBLE survives minimize on Windows), so clicking the
    // tray icon to bring ScarmVoice forward put it away instead, and getting it
    // back took a second click.
    tray.on('click', () => {
        const up = win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.isFocused();
        if (up) win.hide(); else showWindow();
    });
}

function refreshTray() {
    if (!tray) return;
    tray.setToolTip(trayTooltip());
    tray.setContextMenu(buildTrayMenu());
}

// ---- lounge:// attachment proxy ------------------------------------------
// <img src="lounge://file/<encoded r2 key>"> — the handler fetches the bytes
// from the cookie-gated endpoint so the renderer never needs the credential.

function registerProtocol() {
    protocol.handle('lounge', async (request) => {
        // Parsing and decoding are inside the try because a malformed escape
        // (lounge://file/%E0%A4%A) makes decodeURIComponent throw a URIError —
        // which would reject the handler's promise instead of answering. CSP
        // allows lounge: in img-src, so message content can reach this.
        try {
            const url = new URL(request.url);
            if (url.hostname !== 'file') return new Response('Not found', { status: 404 });
            let key;
            try {
                key = decodeURIComponent(url.pathname.replace(/^\//, ''));
            } catch (e) {
                return new Response('Malformed key', { status: 400 });
            }
            if (!key) return new Response('Missing key', { status: 400 });
            const upstream = await net.fileStream(key);
            return new Response(upstream.body, {
                status: upstream.status,
                // No Content-Length: fetch already decompressed the body, but
                // the upstream header still counts the COMPRESSED bytes, so
                // forwarding it truncates any attachment Cloudflare gzips
                // (SVG, text). Chromium streams chunked responses fine.
                headers: {
                    'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
                    'Cache-Control': 'private, max-age=3600'
                }
            });
        } catch (e) {
            return new Response('Upstream error: ' + e.message, { status: 502 });
        }
    });
}

// ---- permissions ---------------------------------------------------------

function configurePermissions() {
    const ses = session.defaultSession;

    // The renderer is our own bundled page; grant exactly what voice needs and
    // deny the rest rather than accepting whatever is asked for.
    const ALLOWED = new Set([
        'media', 'audioCapture', 'videoCapture', 'display-capture',
        'notifications', 'clipboard-sanitized-write',
        // HTML element fullscreen (the screen-share stage's Fullscreen button) is
        // gated as a permission in Electron — without this, requestFullscreen()
        // is silently denied and the button appears to do nothing.
        'fullscreen', 'pointerLock', 'keyboardLock'
    ]);
    ses.setPermissionRequestHandler((_wc, permission, callback) => {
        callback(ALLOWED.has(permission));
    });
    ses.setPermissionCheckHandler((_wc, permission) => ALLOWED.has(permission));

    // Screen sharing. Chromium's own picker doesn't exist in Electron on Windows,
    // so the renderer shows its own picker FIRST and records the choice here;
    // by the time the RealtimeKit SDK calls getDisplayMedia there is already a
    // pending selection to hand back. Selecting up front (rather than answering
    // this handler live) keeps the flow deterministic and cancellable.
    ses.setDisplayMediaRequestHandler(async (_request, callback) => {
        const pending = pendingShareSource;
        pendingShareSource = null;
        if (!pending) { callback({}); return; }   // empty object = request denied

        // If the SDK never called getDisplayMedia (join failed, the user left,
        // an SDK error), the selection would sit here indefinitely and satisfy
        // the NEXT share — silently sharing a window picked in some earlier
        // session with no picker ever shown.
        if (Date.now() - pending.at > SHARE_PICK_TTL_MS) {
            console.warn('[share] ignoring a stale source selection');
            callback({});
            return;
        }

        try {
            const sources = await desktopCapturer.getSources({
                types: ['screen', 'window'],
                // Only `s.id` is read below, and the object handed to callback()
                // carries no image. The default here captures a thumbnail of
                // every screen and every open window — measured at ~150ms on
                // the share's critical path — and throws all of them away. The
                // picker (share:sources) still asks for real thumbnails,
                // because it actually draws them.
                thumbnailSize: { width: 0, height: 0 }
            });
            // Still looked up rather than reconstructed from pending.id: a
            // selection can be a minute old (SHARE_PICK_TTL_MS), and this is
            // what turns "the window you picked has since closed" into a clean
            // denial instead of Chromium capturing a dead HWND.
            const source = sources.find((s) => s.id === pending.id);
            if (!source) { callback({}); return; }
            // 'loopback' captures system audio on Windows so shared video/music
            // is heard by everyone else in the call.
            callback(pending.audio ? { video: source, audio: 'loopback' } : { video: source });
        } catch (e) {
            console.error('[share] source lookup failed:', e.message);
            callback({});
        }
    }, { useSystemPicker: false });
}

// ---- outbound url safety -------------------------------------------------
// Remote image URLs arrive from message content, so they are chosen by whoever
// posted the message. Fetching one from the main process — no CORS, no browser
// sandbox, on this machine's network — is an SSRF primitive: without a host
// check it reaches loopback services, the router, and cloud metadata endpoints
// that nothing on the internet can see.

const PRIVATE_V4 = [
    /^0\./, /^10\./, /^127\./, /^169\.254\./, /^192\.168\./,
    /^172\.(1[6-9]|2[0-9]|3[01])\./,
    /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./   // CGNAT
];

function isPrivateHost(hostname) {
    const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (!h) return true;
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') ||
        h.endsWith('.internal') || h.endsWith('.home.arpa')) return true;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return PRIVATE_V4.some((re) => re.test(h));
    if (h.includes(':')) {
        // IPv6: loopback, unique-local (fc00::/7) and link-local (fe80::/10).
        if (h === '::1' || h === '::') return true;
        if (/^f[cd]/.test(h) || /^fe[89ab]/.test(h)) return true;
        // ::ffff:127.0.0.1 and friends.
        const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(h);
        if (v4) return PRIVATE_V4.some((re) => re.test(v4[1]));
    }
    return false;
}

// Our own board is allowed whatever scheme it is configured with (a local
// wrangler dev server is http://localhost, which the private-host rule would
// otherwise refuse); everything else must be https: and publicly routable.
function boardOrigin() {
    try { return new URL(net.baseUrl()).origin; } catch (e) { return null; }
}

function safeRemoteUrl(raw) {
    let u;
    try { u = new URL(String(raw || '')); } catch (e) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.origin === boardOrigin()) return u;
    if (u.protocol !== 'https:') return null;
    if (isPrivateHost(u.hostname)) return null;
    return u;
}

// Redirects are followed by hand so every hop is re-checked — otherwise a
// public https: URL that 302s to http://169.254.169.254 walks straight past the
// check above.
async function fetchRemoteImage(raw) {
    let target = safeRemoteUrl(raw);
    if (!target) throw new Error('unsupported url');

    for (let hop = 0; ; hop++) {
        const res = await fetch(target.href, {
            signal: AbortSignal.timeout(20000),
            redirect: 'manual'
        });
        if (res.status < 300 || res.status > 399) return res;
        // Every exit from here abandons this response, and an unconsumed body
        // pins its keep-alive connection until GC — so the cancel has to happen
        // on the throwing paths too, not just the one that loops.
        try {
            if (hop >= 3) throw new Error('Too many redirects');
            const location = res.headers.get('location');
            // A 30x with no Location would resolve to target.href and refetch
            // the same URL until the hop limit.
            if (!location) throw new Error('Redirect without a location');
            const next = safeRemoteUrl(new URL(location, target.href).href);
            if (!next) throw new Error('unsupported url');
            target = next;
        } finally {
            try { await res.body?.cancel(); } catch (e) { /* already gone */ }
        }
    }
}

// A remote URL is chosen by whoever posted the message, so "whatever that host
// sends" must never be buffered unbounded into the main process — a multi-GB
// image/png would take down the whole app, not just a tab.
async function boundedBuffer(res, limit) {
    // The limit is the caller's, and they do not all pass the same one — the
    // message has to quote the one actually being enforced rather than a
    // number that was true of one caller when this was written.
    const tooBig = () => new Error(
        'That file is larger than ' + Math.round(limit / (1024 * 1024)) + ' MB');
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > limit) {
        try { await res.body?.cancel(); } catch (e) { /* already gone */ }
        throw tooBig();
    }
    if (!res.body) return Buffer.alloc(0);

    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.length;
            // Content-Length can lie or be absent, so the running total is the
            // check that actually holds.
            if (total > limit) throw tooBig();
            chunks.push(value);
        }
    } finally {
        try { await reader.cancel(); } catch (e) { /* already finished */ }
    }
    return Buffer.concat(chunks, total);
}

// ---- IPC -----------------------------------------------------------------

// Every handler registered through this is reachable only from our own top
// frame. There are no iframes or webviews in the renderer today, so this is
// defence in depth — but it is the layer that contains a renderer compromise,
// and the sender check costs nothing.
function fromMainFrame(event) {
    if (!win || win.isDestroyed()) return false;
    if (event.sender !== win.webContents) return false;
    let frame;
    // senderFrame throws if the frame has already gone away; the sender check
    // above has already established this came from our window.
    try { frame = event.senderFrame; } catch (e) { return true; }
    return !frame || frame === win.webContents.mainFrame;
}

function handle(channel, fn) {
    ipcMain.handle(channel, (event, ...args) => {
        if (!fromMainFrame(event)) {
            console.warn(`[ipc] refused ${channel} from an unexpected sender`);
            return null;
        }
        return fn(event, ...args);
    });
}

function registerIpc() {
    // NEITHER of these opens the socket any more, and that is the whole point.
    //
    // The upgrade carries this install's id, and the server will only honour it
    // once the id is BOUND to the account (account_clients). Binding happens in
    // account/me, which the renderer calls from enterApp() — after this. So a
    // socket opened here presented an unbound id, the server refused to take the
    // client's word for it and substituted a random one, and rt.start() from
    // enterApp() is a no-op while a socket already exists: the substitute then
    // stuck for the entire session.
    //
    // Everything downstream keys off that id. The realtime voice roster and the
    // typing feed came back under the random id while the HTTP ones came back
    // under the real one, so one person arrived as two — a voice participant who
    // joined and left every few seconds as the two sources took turns, and
    // "X and X are typing". Signing out or quitting never helped, because the
    // next launch opened the socket in exactly the same order.
    //
    // enterApp() is now the only thing that starts it, and it does so after
    // refreshAccount() — which is what its own comment there always claimed.
    handle('auth:login', async (_e, password) => net.login(password));

    handle('auth:logout', async () => {
        rt.stop();
        return net.logout();
    });

    // startApp() put these two on the wire while the window was still being
    // built (see net.prefetchSession). If that answer is here, hand it over
    // instead of asking again — it is the same call, made by the same code.
    // One shot each: `pendingMe` is nulled on read and the preflight slot is
    // emptied by takePreflight, so a re-login or any later refresh is always a
    // real request.
    // A PROMISE, not an answer: account:me awaits it when it is asked, so a
    // slow account/me delays only the question it is the answer to.
    let pendingMe = null;
    handle('auth:status', async () => {
        const pre = await net.takePreflight();
        if (!pre) return net.status();
        const st = await pre.st;
        if (!st) return net.status();
        pendingMe = pre.me;
        return st;
    });

    handle('board:call', async (_e, { path: p, opts }) => {
        // register/login/verify responses all carry the account token, so the
        // whole namespace is denied except the read-only paths the UI needs.
        // See boardpath.js for why this decides on the RESOLVED path.
        const resolved = boardpath.resolveBoardPath(p, net.baseUrl());
        if (!resolved) return { success: false, error: 'bad path' };
        if (boardpath.needsAccountBridge(resolved.key)) {
            return { success: false, error: 'use the account bridge' };
        }
        return net.board(resolved.path, opts || {});
    });

    // ---- board accounts ----
    handle('account:register', async (_e, { username, password, email }) => {
        return net.accountRegister(String(username || ''), String(password || ''), String(email || ''), store.get().clientId);
    });
    handle('account:login', async (_e, { username, password, totpCode }) => {
        return net.accountLogin(String(username || ''), String(password || ''), store.get().clientId, String(totpCode || ''));
    });
    handle('account:verify', async (_e, { username, code }) => {
        return net.accountVerify(String(username || ''), String(code || ''), store.get().clientId);
    });
    handle('account:resend', async (_e, { username }) => {
        return net.accountResend(String(username || ''));
    });
    handle('account:logout', async () => net.accountLogout());
    handle('account:me', async () => {
        const p = pendingMe;
        pendingMe = null;
        if (!p) return net.accountMe();
        // Still in flight is the normal case — the renderer asks for this
        // within a millisecond of asking for the status.
        const me = await p;
        return me || net.accountMe();
    });
    handle('account:removal', async (_e, { action, password, code }) => net.accountRemoval(action, password, code));

    handle('voice:token', async (_e, payload) => {
        const s = store.get();
        return net.board('voice/token', {
            method: 'POST',
            body: {
                clientId: (payload && payload.clientId) || s.clientId,
                name: (payload && payload.name) || s.displayName || 'Anonymous'
            }
        });
    });

    // ---- attachments ----

    // `id` ties the progress events below back to the composer row that started
    // this upload, so several files uploading at once each move their own bar.
    // Throttled: the stream reports every chunk, which for a large file is
    // thousands of events. One a frame is more than enough to animate a bar.
    function uploadProgress(id) {
        if (!id) return null;
        let lastSent = 0;
        return (sent, total) => {
            const now = Date.now();
            if (sent < total && now - lastSent < 100) return;
            lastSent = now;
            if (win && !win.isDestroyed()) {
                win.webContents.send('upload:progress', { id, sent, total });
            }
        };
    }

    handle('board:upload', async (_e, { name, type, data, id }) => {
        return net.upload(name, type, data, uploadProgress(id));
    });

    // The path that scales. `item.path` is a real file: net.uploadAttachment
    // streams it from disk into a presigned PUT, so the bytes are never held in
    // memory here, in the renderer, or in a Worker.
    handle('board:uploadAttachment', async (_e, { item, id }) => {
        const it = item || {};
        // A path arriving over IPC is renderer-supplied, and the renderer is the
        // one part of this app that runs content other people wrote. It only
        // ever gets one from webUtils.getPathForFile — a file the USER chose in
        // a picker or dropped on the window — so anything else is a bug or an
        // attempt, and either way this process should not read it. Requiring an
        // absolute path is not the check; the check is that we only ever read it
        // to upload it, and the user is the one who named it.
        const clean = {
            name: String(it.name || 'file'),
            type: String(it.type || 'application/octet-stream'),
            size: Number(it.size) || 0,
            path: it.path ? String(it.path) : null,
            bytes: it.data || null
        };
        if (!clean.path && !clean.bytes) return { success: false, error: 'Nothing to upload' };
        return net.uploadAttachment(clean, uploadProgress(id));
    });

    // Bytes for an image the renderer can name two ways: by attachment key
    // (ours, cookie-gated) or by remote URL (a link preview). Everything that
    // saves or copies an image goes through here so both kinds work the same.
    // Everything an attachment can be fetched from, as a Response.
    async function attachmentResponse({ key, url }) {
        if (key) {
            const res = await net.fileStream(key);
            if (!res.ok) throw new Error(`Server returned ${res.status}`);
            return res;
        }
        // Host-restricted (see safeRemoteUrl) and content-type checked, exactly
        // like board:fetchImage: everything reaching here saves to disk or goes
        // on the clipboard, so "whatever that URL returns" is not good enough.
        const res = await fetchRemoteImage(url);
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        const type = (res.headers.get('content-type') || '').split(';')[0].trim();
        if (!type.startsWith('image/')) throw new Error('That link is not an image');
        return res;
    }

    // Straight from the socket to the file, never through memory. Attachments
    // can be a gigabyte now, and "save this file" must not also mean "hold this
    // entire file in the main process first".
    async function streamToFile(ref, destPath) {
        const res = await attachmentResponse(ref);
        if (!res.body) { await fsp.writeFile(destPath, Buffer.alloc(0)); return; }
        try {
            await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destPath));
        } catch (e) {
            // pipeline destroys the streams but leaves what it wrote. A
            // half-transferred file sitting at the name the user chose is worse
            // than no file: the toast that says it failed is gone in seconds,
            // and what is left looks exactly like a download that worked. The
            // no-dialog path even disambiguates the retry to "name (2)", so the
            // broken one stays as the obvious one.
            try { await fsp.unlink(destPath); } catch (_) { /* never existed */ }
            throw e;
        }
    }

    // The clipboard is the one consumer that genuinely needs the bytes in hand.
    // It is also images only, so it keeps a modest ceiling of its own rather
    // than inheriting the 1 GB attachment limit.
    const MAX_CLIPBOARD_IMAGE = 64 * 1024 * 1024;

    async function imageBytes({ key, url }) {
        if (key) {
            const res = await net.fileStream(key);
            if (!res.ok) throw new Error(`Server returned ${res.status}`);
            return boundedBuffer(res, MAX_CLIPBOARD_IMAGE);
        }
        // Host-restricted (see safeRemoteUrl) and content-type checked, exactly
        // like board:fetchImage: everything reaching here saves to disk or goes
        // on the clipboard, so "whatever that URL returns" is not good enough.
        const res = await fetchRemoteImage(url);
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        const type = (res.headers.get('content-type') || '').split(';')[0].trim();
        if (!type.startsWith('image/')) throw new Error('That link is not an image');
        return boundedBuffer(res, MAX_CLIPBOARD_IMAGE);
    }

    // Only paths this process actually wrote may be revealed. The renderer hands
    // back the path it was given, but the channel accepts any string, so without
    // this an Explorer window can be opened on any file on the machine.
    const revealable = new Set();
    const MAX_REVEALABLE = 100;

    function rememberRevealable(filePath) {
        if (revealable.size >= MAX_REVEALABLE) {
            revealable.delete(revealable.values().next().value);
        }
        revealable.add(path.resolve(filePath));
    }

    // Save an attachment to disk. The bytes have to come through the
    // authenticated client, so the renderer can't just download the URL.
    handle('board:saveAttachment', async (_e, { key, name, url }) => {
        const target = await dialog.showSaveDialog(win, {
            defaultPath: name || 'attachment',
            title: 'Save attachment'
        });
        if (target.canceled || !target.filePath) return { success: false, canceled: true };
        try {
            await streamToFile({ key, url }, target.filePath);
            rememberRevealable(target.filePath);
            return { success: true, path: target.filePath };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    handle('board:revealFile', (_e, filePath) => {
        if (!filePath) return false;
        // The save dialog's destination is wherever the user chose, so the rule
        // is "a file we just produced", not a fixed directory.
        if (!revealable.has(path.resolve(String(filePath)))) {
            console.warn('[app] refused to reveal a path this process did not write');
            return false;
        }
        shell.showItemInFolder(path.resolve(String(filePath)));
        return true;
    });

    // Straight to the Downloads folder, no dialog. Never silently clobbers an
    // existing file — it disambiguates with " (2)", " (3)", …
    handle('board:downloadAttachment', async (_e, { key, name, url }) => {
        try {
            const dir = app.getPath('downloads');
            const safe = (name || 'attachment').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
            const ext = path.extname(safe);
            const stem = ext ? safe.slice(0, -ext.length) : safe;

            let target = path.join(dir, safe);
            for (let n = 2; ; n++) {
                try { await fsp.access(target); } catch (e) { break; }   // free
                target = path.join(dir, `${stem} (${n})${ext}`);
            }
            await streamToFile({ key, url }, target);
            rememberRevealable(target);
            return { success: true, path: target };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // Put the actual image on the clipboard (not just its URL), so it can be
    // pasted straight into another app.
    handle('board:copyImage', async (_e, { key, url }) => {
        try {
            const img = nativeImage.createFromBuffer(await imageBytes({ key, url }));
            if (img.isEmpty()) return { success: false, error: 'Not a decodable image' };
            clipboard.writeImage(img);
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // Link previews. Proxied because /api/board/unfurl is cookie-gated; the
    // server does the fetching, parsing and 7-day caching.
    handle('board:unfurl', async (_e, url) => {
        return net.board('unfurl', { query: { url } });
    });

    // Dragging an image out of a browser gives us a URL, not a file. Fetch the
    // bytes here so the drop can attach the actual image instead of its link
    // text — and because an arbitrary remote host won't send CORS headers.
    handle('board:fetchImage', async (_e, url) => {
        try {
            // Same host restriction as imageBytes — a dragged image URL is no
            // more trustworthy than one embedded in a message.
            const res = await fetchRemoteImage(url);
            if (!res.ok) return { success: false, error: `Server returned ${res.status}` };

            const type = (res.headers.get('content-type') || '').split(';')[0].trim();
            if (!type.startsWith('image/')) return { success: false, error: 'That link is not an image' };

            // Capped while streaming rather than after buffering, so an
            // oversized image is refused without ever being held in memory.
            const buf = await boundedBuffer(res, net.MAX_UPLOAD);

            // Name it from the URL path, falling back to the mime subtype.
            let name = '';
            try {
                name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
            } catch (e) { /* keep empty */ }
            if (!/\.[a-z0-9]{2,5}$/i.test(name)) {
                name = (name || 'image') + '.' + (type.split('/')[1] || 'png').replace('jpeg', 'jpg');
            }
            return { success: true, name, type, data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
        } catch (e) {
            return { success: false, error: e.name === 'TimeoutError' ? 'Timed out fetching that image' : e.message };
        }
    });

    // YouTube title/channel/thumbnail via oEmbed — no API key needed.
    // This runs here rather than in the renderer because the endpoint sends no
    // Access-Control-Allow-Origin, so a browser-side fetch is blocked by CORS.
    handle('board:youtube', async (_e, videoId) => {
        if (!/^[A-Za-z0-9_-]{11}$/.test(String(videoId || ''))) return null;

        const hit = youtubeCache.get(videoId);
        if (hit) {
            if (Date.now() < hit.until) return hit.value;
            youtubeCache.delete(videoId);   // expired — drop it rather than overwrite
        }

        let value = null;
        try {
            const target = 'https://www.youtube.com/oembed?url=' +
                encodeURIComponent('https://www.youtube.com/watch?v=' + videoId) + '&format=json';
            const res = await fetch(target, { signal: AbortSignal.timeout(8000) });
            // 401/404 here means private, deleted, or embedding disabled.
            if (res.ok) {
                const d = await res.json();
                if (d && d.title) {
                    value = {
                        id: videoId,
                        title: String(d.title).slice(0, 200),
                        author: String(d.author_name || '').slice(0, 100),
                        thumbnail: d.thumbnail_url || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
                        url: 'https://www.youtube.com/watch?v=' + videoId
                    };
                }
            }
        } catch (e) { /* offline or timeout — fall through to null */ }

        // Bounded: this process lives for weeks in the tray, so an uncapped map
        // grows with every distinct video ever scrolled past. Map iteration is
        // insertion-ordered, so this drops the oldest entry.
        if (youtubeCache.size >= YOUTUBE_CACHE_MAX) {
            youtubeCache.delete(youtubeCache.keys().next().value);
        }
        // Cache misses briefly so a dead video isn't re-fetched on every render,
        // but still recovers if it was a transient failure.
        youtubeCache.set(videoId, {
            value,
            until: Date.now() + (value ? 24 * 3600 * 1000 : 5 * 60 * 1000)
        });
        return value;
    });

    // ---- screen share ----

    handle('share:sources', async () => {
        const sources = await desktopCapturer.getSources({
            types: ['screen', 'window'],
            thumbnailSize: { width: 320, height: 200 },
            fetchWindowIcons: true
        });
        // Serialise the NativeImages; the renderer only needs data URLs.
        return sources
            .filter((s) => s.name !== 'ScarmVoice')   // sharing ourselves is a hall of mirrors
            .map((s) => ({
                id: s.id,
                name: s.name,
                isScreen: s.id.startsWith('screen:'),
                thumbnail: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : null,
                appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null
            }));
    });

    handle('share:select', (_e, { id, audio }) => {
        pendingShareSource = { id, audio: !!audio, at: Date.now() };
        return true;
    });

    handle('share:cancel', () => { pendingShareSource = null; });

    handle('rt:start', () => { rt.start(emitRt); return { connected: rt.isConnected() }; });
    handle('rt:stop', () => { rt.stop(); return { connected: false }; });
    handle('rt:wake', () => { rt.wake(); return { connected: rt.isConnected() }; });
    handle('rt:send', (_e, obj) => rt.send(obj));
    handle('rt:posted', (_e, arg) => {
        // Older renderers passed the channel as a bare string; the object form
        // carries the @mention hint alongside it.
        if (arg && typeof arg === 'object') return rt.notifyPosted(arg.channel, arg.mentions);
        return rt.notifyPosted(arg);
    });
    handle('rt:typing', (_e, { channel, stop }) => rt.sendTyping(channel, stop));
    handle('rt:voice', (_e, { inVoice, muted, deafened }) => rt.sendVoice(inVoice, muted, deafened));

    handle('settings:get', () => store.get());
    handle('settings:set', (_e, patch) => store.set(patch));

    handle('ptt:apply', () => ptt.apply());
    handle('ptt:available', () => ptt.isAvailable());
    handle('ptt:describe', (_e, binding) => ptt.describe(binding));

    handle('win:minimize', () => win && win.minimize());
    handle('win:maximize', () => {
        if (!win) return;
        win.isMaximized() ? win.unmaximize() : win.maximize();
    });
    handle('win:close', () => win && win.close());
    handle('win:focused', () => !!(win && win.isFocused()));

    handle('app:version', () => app.getVersion());

    // Everything the app logs goes to a file (see log.js); this is how someone
    // reporting a bug gets at it without knowing where userData lives.
    handle('app:openLogs', () => log.openFolder());

    // A line from the RENDERER, into that same file.
    //
    // log.js wraps the console of the MAIN process only, so everything the
    // renderer logs — which is most of what there is to know about voice, the
    // roster and the message list — vanished the moment it was written. Asking
    // somebody to reproduce a bug under `npm run dev` with devtools open is not
    // a diagnostic route for an installed app, and the packaged build has no
    // devtools at all (the fuses turn them off).
    //
    // Deliberately NOT a general console bridge: the renderer logs plenty that
    // is only interesting live, and piping all of it would bury the file. Call
    // sites opt in, one line at a time.
    handle('app:log', (_e, line) => {
        console.info('[renderer] ' + String(line == null ? '' : line).slice(0, 500));
        return true;
    });

    // Windows blocks drag-and-drop from a medium-integrity process (Explorer)
    // into a high-integrity one (an elevated app) — UIPI drops the messages
    // before they ever reach us, so no amount of renderer code can fix it.
    // Detect it so we can explain rather than appear broken.
    handle('app:isElevated', () => isElevated);

    // Launch-on-startup. get reads the OS's actual state so the toggle reflects
    // reality even if it was changed outside the app.
    handle('startup:get', () => getLoginItem());
    handle('startup:set', (_e, { openAtLogin, openAsHidden }) =>
        setLoginItem(openAtLogin, openAsHidden));

    // Auto-update.
    handle('update:getState', () => updater.getState());
    handle('update:check', () => updater.checkNow());
    handle('update:download', () => updater.startDownload());
    handle('update:install', () => updater.installNow());
    handle('update:setAuto', (_e, on) => { updater.setAuto(on); return { ok: true }; });
    handle('update:postpone', () => updater.postpone());
    // Every published release, for the history in Settings > About. `force`
    // re-fetches past the session cache, which is what the Retry there does.
    handle('update:history', (_e, force) => updater.history(!!force));

    handle('app:notify', (_e, payload) => {
        if (!store.get().notifications) return false;
        if (win && win.isFocused()) return false;         // you're already looking at it
        if (!Notification.isSupported()) return false;
        const n = new Notification({
            title: (payload && payload.title) || 'ScarmVoice',
            body: (payload && payload.body) || '',
            icon: ICON,
            silent: !store.get().notificationSound
        });
        n.on('click', () => showWindow());
        n.show();
        return true;
    });

    handle('app:voiceState', (_e, state) => {
        const wasInVoice = voiceState.inVoice;
        // Copied field by field rather than Object.assign'd: assign uses [[Set]],
        // so an own '__proto__' key surviving structured clone would re-point
        // this object's prototype, and any unrelated key would be merged in.
        const s = state || {};
        voiceState = {
            inVoice: 'inVoice' in s ? !!s.inVoice : voiceState.inVoice,
            muted: 'muted' in s ? !!s.muted : voiceState.muted,
            deafened: 'deafened' in s ? !!s.deafened : voiceState.deafened
        };
        // Joining or leaving voice invalidates any PTT toggle state that
        // accumulated while the renderer was ignoring hotkey events.
        if (voiceState.inVoice !== wasInVoice) ptt.reset();
        // An update that restarts the app mid-call drops you out of the
        // conversation. Leaving a call is also the moment a held-back restart
        // becomes safe, so both edges are reported.
        try { updater.setBusy(voiceState.inVoice); } catch (e) {}
        refreshTray();
        return voiceState;
    });

    // Unread count on the taskbar button. Windows has no dock badge, so this is
    // setOverlayIcon with an image we draw ourselves.
    //
    // This used to clear the overlay when the count was zero and otherwise only
    // flash the frame, so the badge was never actually drawn — and nothing in
    // the renderer called it at all.
    handle('app:badge', (_e, count) => {
        if (!win || win.isDestroyed()) return false;
        const n = Math.max(0, Math.floor(Number(count) || 0));

        if (!n) {
            try {
                win.setOverlayIcon(null, '');
                // Clearing the badge has to stop the taskbar flash too, or the
                // button keeps pulsing for a count that is already gone.
                win.flashFrame(false);
            } catch (e) {
                console.warn('[badge] clearing the overlay failed:', e.message);
            }
            lastBadge = 0;
            return true;
        }
        try {
            win.setOverlayIcon(badge.badgeIcon(badge.badgeLabel(n)),
                `${n} unread message${n === 1 ? '' : 's'}`);
        } catch (e) {
            console.warn('[badge] overlay failed:', e.message);
        }
        // Flash only when the count actually goes up, so a re-render can't make
        // the taskbar button strobe.
        if (n > lastBadge && !win.isFocused()) win.flashFrame(true);
        lastBadge = n;
        return true;
    });

    // Handing an arbitrary url to the shell is how a message from someone else
    // gets to run code on this machine, so the scheme is parsed, not pattern
    // matched: only real http(s) urls are ever opened.
    // ---- theme ----
    // The renderer owns the choice (dark / light / follow Windows) and asks us
    // for the system answer. Repainting titleBarOverlay matters: the caption
    // buttons are drawn by Windows over our title bar, so a light theme with a
    // dark overlay leaves a black notch in the corner.
    // Both shades track --side in styles.css, and the height tracks --tb, for
    // the same reason the window's own titleBarOverlay does.
    //
    // These were left behind when the title bar shrank from 38px to 31px and
    // changed shade. The renderer calls app:setTheme during boot — before the
    // first paint — so the corrected overlay the window is CREATED with was
    // overwritten within milliseconds on every single launch, and the notch the
    // constructor's values exist to prevent was there the whole time: seven
    // pixels of caption-button plate hanging below the bar, in the wrong colour.
    const OVERLAY = {
        dark: { color: '#131316', symbolColor: '#e9ebf0' },
        light: { color: '#eeeeef', symbolColor: '#31343b' }
    };

    handle('app:systemTheme', () => ({ dark: nativeTheme.shouldUseDarkColors }));

    handle('app:setTheme', (_e, theme) => {
        const o = OVERLAY[theme === 'light' ? 'light' : 'dark'];
        if (!win || win.isDestroyed()) return false;
        try {
            win.setTitleBarOverlay(Object.assign({ height: 31 }, o));
            win.setBackgroundColor(theme === 'light' ? '#f4f5f7' : '#101218');
        } catch (e) { /* not supported on this platform */ }
        return true;
    });

    nativeTheme.on('updated', () => {
        if (win && !win.isDestroyed()) {
            win.webContents.send('app:themeChange', { dark: nativeTheme.shouldUseDarkColors });
        }
    });

    handle('app:openExternal', async (_e, url) => {
        let u;
        try { u = new URL(String(url)); } catch (e) { return false; }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
        // Awaited so the answer reflects whether it actually opened.
        return openExternal(u.href);
    });

    // Editing commands for the in-app context menu on the composer. These run
    // as native edit commands on the focused element, so they behave exactly
    // like Ctrl+X/C/V — including firing the renderer's own paste handler when
    // there's an image on the clipboard.
    handle('edit:command', (_e, name) => {
        if (!win) return false;
        const wc = win.webContents;
        if (name === 'cut') wc.cut();
        else if (name === 'copy') wc.copy();
        else if (name === 'paste') wc.paste();
        else if (name === 'selectAll') wc.selectAll();
        else return false;
        return true;
    });

    // What's on the clipboard, so the menu can grey out Paste rather than
    // offering an action that does nothing.
    handle('edit:clipboard', () => {
        const formats = clipboard.availableFormats();
        return {
            text: clipboard.readText().length > 0,
            image: formats.some((f) => f.startsWith('image/'))
        };
    });
}

function emitRt(kind, payload) {
    if (!win || win.isDestroyed()) return;
    win.webContents.send(kind === 'status' ? 'rt:status' : 'rt:message', payload);
}

// ---- launch on startup ---------------------------------------------------
// Uses Electron's setLoginItemSettings (which drives the OS mechanism) rather
// than poking the registry ourselves. openAsHidden asks Windows to pass
// --openAsHidden when it auto-starts us, so "launch minimized to tray" works.

// The portable build self-extracts to a random %TEMP% dir every launch, so
// process.execPath is not a stable target for a login item — it would be dead
// on the next boot. electron-builder exposes the real .exe location in
// PORTABLE_EXECUTABLE_FILE; use it for both reading and writing the login item.
function loginItemPath() {
    return process.env.PORTABLE_EXECUTABLE_FILE || undefined;
}

function getLoginItem() {
    // On Windows, getLoginItemSettings matches the entry by path AND args, so a
    // login item written with args:[] (visible) does NOT match a query with
    // args:['--openAsHidden'] and vice-versa. Query both signatures and merge:
    // openAtLogin is true if either matches; openAsHidden means the hidden
    // variant is the one that's registered.
    const p = loginItemPath();
    const read = (args) => {
        try {
            const opts = p ? { path: p, args } : { args };
            return app.getLoginItemSettings(opts);
        } catch (e) { return {}; }
    };
    const hidden = read(['--openAsHidden']);
    const visible = read([]);
    return {
        openAtLogin: !!(hidden.openAtLogin || visible.openAtLogin),
        openAsHidden: !!hidden.openAtLogin
    };
}

function setLoginItem(openAtLogin, openAsHidden) {
    try {
        const opts = {
            openAtLogin: !!openAtLogin,
            openAsHidden: !!openAsHidden,
            args: openAsHidden ? ['--openAsHidden'] : []
        };
        const p = loginItemPath();
        if (p) opts.path = p;
        app.setLoginItemSettings(opts);
    } catch (e) {
        console.error('[startup] setLoginItemSettings failed:', e.message);
    }
    return getLoginItem();
}


// ---- boot ----------------------------------------------------------------

// How long a check may run before the silence needs explaining. Under this and
// nobody ever sees the update screen; over it and they see "Checking for
// updates…" instead of a shortcut that appeared to do nothing.
const SPLASH_AFTER_MS = 700;

// Everything the app is, once the gate has agreed it may exist.
function startApp() {
    // BEFORE createWindow, not after: creating the window is synchronous store
    // reads plus BrowserWindow construction, and the renderer then spends about
    // 280ms coming up before it can ask us anything. Both of the calls it opens
    // with go out during that, so the answers are already here when it asks.
    // Deliberately after the update gate resolved 'launch' — a process the
    // installer is about to replace still opens no session.
    net.prefetchSession();
    // forceShow when a launch arrived while the gate held the window back: the
    // user asked for it, and "start minimized" describes an automatic launch,
    // not one they performed by hand.
    createWindow(showOnStart);
    createTray();

    // The update screen stays up until the real window is ready to paint, so
    // there is never a frame with nothing on screen — and it is torn down only
    // AFTER the app window exists, or 'window-all-closed' would fire in the gap
    // between them and quit the app we are in the middle of starting.
    if (splash) {
        win.once('ready-to-show', closeSplash);
        // A window that never becomes ready must not leave the update screen up
        // for the rest of the session.
        setTimeout(closeSplash, 15000);
    }

    ptt.onChange((down) => {
        if (win && !win.isDestroyed()) win.webContents.send('ptt:change', { down });
    });
    // Global mute/deafen hotkeys ride the same command channel the tray menu
    // uses, so the renderer-side guards (in voice? joined?) apply unchanged.
    ptt.onAction((action) => {
        if (win && !win.isDestroyed()) win.webContents.send('app:command', { cmd: action });
    });
    ptt.apply();

    // The launch check already happened, in front of this window rather than
    // four seconds behind it — this arms the periodic recheck for a session
    // left open for days. See updater.checkOnLaunch.
    updater.checkOnLaunch();

    // Waking from sleep/hibernate almost always leaves the socket half-open —
    // verify and revive it, and have the renderer pull anything it missed.
    try {
        powerMonitor.on('resume', () => {
            rt.wake();
            if (win && !win.isDestroyed()) win.webContents.send('app:resync');
        });
    } catch (e) { /* powerMonitor unavailable on this platform */ }

    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(true); });
}

app.whenReady().then(async () => {
    // Drop the default menu. Its roles bind Ctrl +/-/0 to page zoom, which would
    // swallow the chat font-size shortcuts (and zooming the whole UI is not what
    // those keys should do here). Clipboard keys are handled natively regardless.
    Menu.setApplicationMenu(null);

    // Windows groups taskbar buttons, jump lists and toast notifications by
    // AppUserModelID. electron-builder stamps build.appId onto every shortcut
    // the installer writes, but the RUNNING process was answering to Electron's
    // default template (electron.app.ScarmVoice) — two different identities for
    // one app. A pinned shortcut therefore got a second taskbar button beside
    // it when the app launched, notifications appeared under a name with no
    // registered shortcut, and the uninstaller cleaned up an id we never used.
    if (process.platform === 'win32') {
        try { app.setAppUserModelId('com.scarmonit.scarmvoice'); } catch (e) { /* not fatal */ }
    }

    detectElevation();
    store.init();
    net.init();
    registerProtocol();
    configurePermissions();
    registerIpc();

    // A login-item launch is meant to be invisible. Popping a window at the
    // user because Windows started us at sign-in would be worse than the update
    // it is reporting — so the gate still runs and still updates first, it just
    // does it without drawing anything.
    splashWanted = !(store.get().startMinimized || process.argv.includes('--openAsHidden'));

    // update:gate drives the startup screen; update:state is the in-app banner,
    // which has nowhere to render until the app window exists.
    updater.init((channel, payload) => {
        if (channel === 'update:gate') {
            gateStep = payload;
            // Anything past "checking" means an update is genuinely being
            // applied, and that always deserves a window — however fast it is.
            if (payload.phase !== 'checking') ensureSplash();
            paintSplash();
            return;
        }
        if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    });

    // Nothing starts until the feed has been asked. The app must ALWAYS start
    // eventually, so every failure inside the gate resolves 'launch' on a
    // deadline — see updater.startupGate.
    const slowCheck = setTimeout(ensureSplash, SPLASH_AFTER_MS);
    let verdict = 'launch';
    try {
        verdict = await updater.startupGate();
    } catch (e) {
        console.error('[update] startup gate threw, launching anyway:', e && e.message);
    } finally {
        clearTimeout(slowCheck);
    }

    // The update is applying and this process is being replaced. Building the
    // app now would open the mic, the socket and the session for the two
    // seconds before the installer kills us.
    if (verdict === 'installing') return;

    startApp();
});

// Retire the voice-presence row before the process goes away.
//
// The row lives for twelve seconds past its last heartbeat, so quitting mid-call
// leaves the whole room — and this machine, on its next launch — believing you
// are still in it for that long. An UPDATE is the case that matters: it restarts
// the app out from under you, and the new process came back up, polled, and drew
// you into a call you had just been restarted out of.
//
// The renderer already asks on 'beforeunload', but that is a page being torn
// down: the IPC hop and the request behind it are not guaranteed to outlive it,
// and on an update-restart they reliably do not. Main outlives the renderer, so
// this is the one place that can both know the answer and still be running to
// send it.
// The same argument applies to the TEXT presence row, which is what puts you in
// everybody's member list. It also ages out on its own, but until it does you
// are shown as here — under Online, with a green dot — by an app that is not
// running. Retired alongside the voice row, on the same budget, because the two
// requests are independent and can go out together.
let presenceRetired = false;

async function retirePresence() {
    if (presenceRetired) return;
    presenceRetired = true;
    const s = store.get();
    // BEFORE the await, always. This defers the quit, and on an update the NSIS
    // installer is already counting down to `taskkill` — so anything still
    // sitting in the settings debounce has to be on disk before we start
    // waiting on a network round trip that might not finish.
    try { store.flush(); } catch (e) { /* best effort */ }
    try {
        // Bounded, and deliberately shorter than the ~1s of grace the installer
        // allows before it starts killing: a lost presence row ages out on its
        // own in twelve seconds, where a process killed mid-quit loses whatever
        // else the quit was going to do.
        // Both rows at once. They are separate tables and separate requests,
        // so racing them together costs one budget rather than two — and the
        // voice one is skipped entirely when there was no call, because a
        // `leaving` for a row that does not exist is a round trip spent to
        // change nothing.
        const going = [
            net.board('presence', {
                method: 'POST',
                body: {
                    clientId: s.clientId,
                    name: s.displayName || 'Anonymous',
                    status: 'online',      // ignored; `leaving` is what this says
                    custom: s.status || '',
                    leaving: true
                }
            })
        ];
        if (voiceState.inVoice) {
            going.push(net.board('voice/presence', {
                method: 'POST',
                body: {
                    clientId: s.clientId,
                    name: s.displayName || 'Anonymous',
                    muted: !!voiceState.muted,
                    leaving: true
                }
            }));
        }
        await Promise.race([
            Promise.all(going),
            new Promise((resolve) => setTimeout(resolve, 800))
        ]);
    } catch (e) { /* going away regardless */ }
    voiceState.inVoice = false;
}

app.on('before-quit', (e) => {
    quitting = true;
    // will-quit flushes too, but it is the LAST thing to run and does not run
    // at all if something kills the process first. This one costs a single
    // synchronous write and only when a write is actually pending.
    store.flush();
    // Now runs for a signed-in quit, not only a mid-call one: leaving the app
    // has to take you out of the member list too, and that row exists whether
    // or not you were ever in a call. No session means no rows to retire and
    // nothing worth deferring the quit for.
    if (presenceRetired || !net.hasSession()) return;
    // Deferred, not blocked: quit again once the rows are gone. The second pass
    // returns above, so this can only ever happen once.
    e.preventDefault();
    retirePresence().then(() => app.quit(), () => app.quit());
});
// store.flush() matters here: settings saves are debounced, so the last change
// before quitting (window geometry, a slider you just released) is still
// pending in a timer that quitting would otherwise discard.
app.on('will-quit', () => { ptt.shutdown(); rt.stop(); store.flush(); log.close(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
