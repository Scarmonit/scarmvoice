// ScarmVoice — desktop client for the scarmonit.com message board + voice room.
//
// Main-process responsibilities:
//   • window + tray lifecycle
//   • ALL authenticated network I/O (net.js, rt.js) — see net.js for why
//   • global push-to-talk (ptt.js)
//   • a lounge:// protocol that proxies cookie-gated attachments to the renderer
const path = require('path');
const fsp = require('fs/promises');
const {
    app, BrowserWindow, Tray, Menu, ipcMain, shell, protocol, session, Notification, nativeImage,
    desktopCapturer, dialog, clipboard, screen, powerMonitor
} = require('electron');

const store = require('./store');
const net = require('./net');
const rt = require('./rt');
const ptt = require('./ptt');
const updater = require('./updater');

const DEV = process.argv.includes('--dev');
const ICON = path.join(__dirname, '..', '..', 'build', 'icon.ico');

let win = null;
let tray = null;
let quitting = false;
let voiceState = { inVoice: false, muted: false, deafened: false };
let pendingShareSource = null;   // { id, audio } chosen in the renderer's picker
const youtubeCache = new Map();  // videoId -> { value, until }
let isElevated = false;          // see the app:isElevated handler

// `net session` needs administrator rights, so its exit code is a reliable
// elevation probe on Windows. Async so it never delays startup.
function detectElevation() {
    if (process.platform !== 'win32') return;
    require('child_process').exec('net session', { windowsHide: true }, (err) => {
        isElevated = !err;
        if (isElevated) {
            console.warn('[app] running elevated — Windows will block drag-and-drop from Explorer');
        }
    });
}

// Single instance: a second launch focuses the running window instead of
// opening a duplicate that would fight over the mic and the voice presence row.
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => showWindow());
}

// Adopt the previous app name's profile before Electron touches the user data
// directory — see store.migrateLegacyProfile for why the timing matters.
store.migrateLegacyProfile();

// Chromium blocks audio until the page sees a user gesture. That rule exists to
// stop web pages autoplaying at you; in a desktop chat client it just means the
// first join/message chime is silently dropped. Must be set before app ready.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

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

function createWindow() {
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
        backgroundColor: '#0a0a0f',
        icon: ICON,
        autoHideMenuBar: true,
        // Native window buttons drawn over our own title bar.
        titleBarStyle: 'hidden',
        titleBarOverlay: { color: '#0d0d14', symbolColor: '#e8e8f0', height: 38 },
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
        const startHidden = store.get().startMinimized || process.argv.includes('--openAsHidden');
        if (!startHidden) win.show();
    });

    if (DEV) win.webContents.openDevTools({ mode: 'detach' });

    win.on('focus', () => win.webContents.send('win:focus', true));
    win.on('blur', () => win.webContents.send('win:focus', false));

    // Coming back from the tray / a minimize is exactly when a socket that died
    // while hidden needs to be checked and revived — verify the connection and
    // tell the renderer to resync any messages it missed while it was away.
    const onResume = () => { rt.wake(); if (win) win.webContents.send('app:resync'); };
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

    // External links open in the real browser, never in-app.
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/.test(url)) shell.openExternal(url);
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
        if (/^https?:/.test(url)) shell.openExternal(url);
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
    if (!win) { createWindow(); return; }
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
}

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
            click: () => win && win.webContents.send('app:command', { cmd: voiceState.inVoice ? 'leaveVoice' : 'joinVoice' })
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
    tray.on('click', () => (win && win.isVisible() ? win.hide() : showWindow()));
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
        const url = new URL(request.url);
        if (url.hostname !== 'file') return new Response('Not found', { status: 404 });
        const key = decodeURIComponent(url.pathname.replace(/^\//, ''));
        if (!key) return new Response('Missing key', { status: 400 });
        try {
            const upstream = await net.fileStream(key);
            return new Response(upstream.body, {
                status: upstream.status,
                headers: {
                    'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
                    'Content-Length': upstream.headers.get('content-length') || '',
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

        try {
            const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
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

// ---- IPC -----------------------------------------------------------------

function registerIpc() {
    ipcMain.handle('auth:login', async (_e, password) => {
        const res = await net.login(password);
        if (res.success) rt.start(emitRt);
        return res;
    });

    ipcMain.handle('auth:logout', async () => {
        rt.stop();
        return net.logout();
    });

    ipcMain.handle('auth:status', async () => {
        const res = await net.status();
        if (res.authed) rt.start(emitRt);
        return res;
    });

    ipcMain.handle('board:call', async (_e, { path: p, opts }) => {
        return net.board(String(p || ''), opts || {});
    });

    ipcMain.handle('voice:token', async (_e, payload) => {
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

    ipcMain.handle('board:upload', async (_e, { name, type, data }) => {
        return net.upload(name, type, data);
    });

    // Save an attachment to disk. The bytes have to come through the
    // authenticated client, so the renderer can't just download the URL.
    ipcMain.handle('board:saveAttachment', async (_e, { key, name }) => {
        const target = await dialog.showSaveDialog(win, {
            defaultPath: name || 'attachment',
            title: 'Save attachment'
        });
        if (target.canceled || !target.filePath) return { success: false, canceled: true };
        try {
            const res = await net.fileStream(key);
            if (!res.ok) return { success: false, error: `Server returned ${res.status}` };
            await fsp.writeFile(target.filePath, Buffer.from(await res.arrayBuffer()));
            return { success: true, path: target.filePath };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('board:revealFile', (_e, filePath) => {
        if (filePath) shell.showItemInFolder(filePath);
    });

    // Straight to the Downloads folder, no dialog. Never silently clobbers an
    // existing file — it disambiguates with " (2)", " (3)", …
    ipcMain.handle('board:downloadAttachment', async (_e, { key, name }) => {
        try {
            const res = await net.fileStream(key);
            if (!res.ok) return { success: false, error: `Server returned ${res.status}` };
            const buf = Buffer.from(await res.arrayBuffer());

            const dir = app.getPath('downloads');
            const safe = (name || 'attachment').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
            const ext = path.extname(safe);
            const stem = ext ? safe.slice(0, -ext.length) : safe;

            let target = path.join(dir, safe);
            for (let n = 2; ; n++) {
                try { await fsp.access(target); } catch (e) { break; }   // free
                target = path.join(dir, `${stem} (${n})${ext}`);
            }
            await fsp.writeFile(target, buf);
            return { success: true, path: target };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // Put the actual image on the clipboard (not just its URL), so it can be
    // pasted straight into another app.
    ipcMain.handle('board:copyImage', async (_e, { key }) => {
        try {
            const res = await net.fileStream(key);
            if (!res.ok) return { success: false, error: `Server returned ${res.status}` };
            const img = nativeImage.createFromBuffer(Buffer.from(await res.arrayBuffer()));
            if (img.isEmpty()) return { success: false, error: 'Not a decodable image' };
            clipboard.writeImage(img);
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // Link previews. Proxied because /api/board/unfurl is cookie-gated; the
    // server does the fetching, parsing and 7-day caching.
    ipcMain.handle('board:unfurl', async (_e, url) => {
        return net.board('unfurl', { query: { url } });
    });

    // Dragging an image out of a browser gives us a URL, not a file. Fetch the
    // bytes here so the drop can attach the actual image instead of its link
    // text — and because an arbitrary remote host won't send CORS headers.
    ipcMain.handle('board:fetchImage', async (_e, url) => {
        try {
            if (!/^https?:\/\//i.test(url)) return { success: false, error: 'unsupported url' };
            const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
            if (!res.ok) return { success: false, error: `Server returned ${res.status}` };

            const type = (res.headers.get('content-type') || '').split(';')[0].trim();
            if (!type.startsWith('image/')) return { success: false, error: 'That link is not an image' };

            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length > net.MAX_UPLOAD) {
                return { success: false, error: 'That image is larger than 25 MB' };
            }

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
    ipcMain.handle('board:youtube', async (_e, videoId) => {
        if (!/^[A-Za-z0-9_-]{11}$/.test(String(videoId || ''))) return null;

        const hit = youtubeCache.get(videoId);
        if (hit && Date.now() < hit.until) return hit.value;

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

        // Cache misses briefly so a dead video isn't re-fetched on every render,
        // but still recovers if it was a transient failure.
        youtubeCache.set(videoId, {
            value,
            until: Date.now() + (value ? 24 * 3600 * 1000 : 5 * 60 * 1000)
        });
        return value;
    });

    // ---- screen share ----

    ipcMain.handle('share:sources', async () => {
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

    ipcMain.handle('share:select', (_e, { id, audio }) => {
        pendingShareSource = { id, audio: !!audio };
        return true;
    });

    ipcMain.handle('share:cancel', () => { pendingShareSource = null; });

    ipcMain.handle('rt:start', () => { rt.start(emitRt); return { connected: rt.isConnected() }; });
    ipcMain.handle('rt:stop', () => { rt.stop(); return { connected: false }; });
    ipcMain.handle('rt:wake', () => { rt.wake(); return { connected: rt.isConnected() }; });
    ipcMain.handle('rt:send', (_e, obj) => rt.send(obj));
    ipcMain.handle('rt:posted', (_e, channel) => rt.notifyPosted(channel));
    ipcMain.handle('rt:typing', (_e, { channel, stop }) => rt.sendTyping(channel, stop));
    ipcMain.handle('rt:voice', (_e, { inVoice, muted }) => rt.sendVoice(inVoice, muted));

    ipcMain.handle('settings:get', () => store.get());
    ipcMain.handle('settings:set', (_e, patch) => store.set(patch));

    ipcMain.handle('ptt:apply', () => ptt.apply());
    ipcMain.handle('ptt:available', () => ptt.isAvailable());
    ipcMain.handle('ptt:describe', (_e, binding) => ptt.describe(binding));

    ipcMain.handle('win:minimize', () => win && win.minimize());
    ipcMain.handle('win:maximize', () => {
        if (!win) return;
        win.isMaximized() ? win.unmaximize() : win.maximize();
    });
    ipcMain.handle('win:close', () => win && win.close());
    ipcMain.handle('win:focused', () => !!(win && win.isFocused()));

    ipcMain.handle('app:version', () => app.getVersion());

    // Windows blocks drag-and-drop from a medium-integrity process (Explorer)
    // into a high-integrity one (an elevated app) — UIPI drops the messages
    // before they ever reach us, so no amount of renderer code can fix it.
    // Detect it so we can explain rather than appear broken.
    ipcMain.handle('app:isElevated', () => isElevated);

    // Launch-on-startup. get reads the OS's actual state so the toggle reflects
    // reality even if it was changed outside the app.
    ipcMain.handle('startup:get', () => getLoginItem());
    ipcMain.handle('startup:set', (_e, { openAtLogin, openAsHidden }) =>
        setLoginItem(openAtLogin, openAsHidden));

    // Auto-update.
    ipcMain.handle('update:getState', () => updater.getState());
    ipcMain.handle('update:check', () => updater.checkNow());
    ipcMain.handle('update:download', () => updater.startDownload());
    ipcMain.handle('update:install', () => updater.installNow());
    ipcMain.handle('update:setAuto', (_e, on) => { updater.setAuto(on); return { ok: true }; });

    ipcMain.handle('app:notify', (_e, payload) => {
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

    ipcMain.handle('app:voiceState', (_e, state) => {
        voiceState = Object.assign(voiceState, state || {});
        refreshTray();
        return voiceState;
    });

    ipcMain.handle('app:badge', (_e, count) => {
        if (!win) return;
        // Windows has no dock badge; overlay the taskbar icon instead.
        if (!count) { win.setOverlayIcon(null, ''); return; }
        win.flashFrame(!win.isFocused());
    });

    ipcMain.handle('app:openExternal', (_e, url) => {
        if (/^https?:/.test(url)) shell.openExternal(url);
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

app.whenReady().then(() => {
    // Drop the default menu. Its roles bind Ctrl +/-/0 to page zoom, which would
    // swallow the chat font-size shortcuts (and zooming the whole UI is not what
    // those keys should do here). Clipboard keys are handled natively regardless.
    Menu.setApplicationMenu(null);

    detectElevation();
    store.init();
    net.init();
    registerProtocol();
    configurePermissions();
    registerIpc();
    createWindow();
    createTray();

    ptt.onChange((down) => {
        if (win && !win.isDestroyed()) win.webContents.send('ptt:change', { down });
    });
    ptt.apply();

    // Auto-update: bridge events to the renderer and check shortly after the
    // window is up (so the banner has somewhere to render).
    updater.init((channel, payload) => {
        if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    });
    setTimeout(() => updater.checkOnLaunch(), 4000);

    // Waking from sleep/hibernate almost always leaves the socket half-open —
    // verify and revive it, and have the renderer pull anything it missed.
    try {
        powerMonitor.on('resume', () => {
            rt.wake();
            if (win && !win.isDestroyed()) win.webContents.send('app:resync');
        });
    } catch (e) { /* powerMonitor unavailable on this platform */ }

    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => { ptt.shutdown(); rt.stop(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
