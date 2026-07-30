// The only bridge between the sandboxed renderer and Node. Everything is an
// explicit, narrow method — the renderer gets no ipcRenderer, no require, and
// never sees the session cookie.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

function sub(channel, cb) {
    if (typeof cb !== 'function') return () => {};
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('lounge', {
    auth: {
        login: (password) => ipcRenderer.invoke('auth:login', password),
        logout: () => ipcRenderer.invoke('auth:logout'),
        status: () => ipcRenderer.invoke('auth:status')
    },

    // Generic proxy for /api/board/*
    board: (path, opts) => ipcRenderer.invoke('board:call', { path, opts }),

    // Board accounts. register/login run main-side so the account token (like
    // the session cookie) never reaches the renderer.
    account: {
        register: (username, password, email) => ipcRenderer.invoke('account:register', { username, password, email }),
        login: (username, password, totpCode) => ipcRenderer.invoke('account:login', { username, password, totpCode }),
        verify: (username, code) => ipcRenderer.invoke('account:verify', { username, code }),
        resend: (username) => ipcRenderer.invoke('account:resend', { username }),
        logout: () => ipcRenderer.invoke('account:logout'),
        me: () => ipcRenderer.invoke('account:me'),
        removal: (action, password, code) => ipcRenderer.invoke('account:removal', { action, password, code })
    },

    // Attachments. `data` is an ArrayBuffer of the raw file bytes. Pass an `id`
    // to receive upload:progress events tagged with it (see onUploadProgress).
    // Small payloads only — see uploadAttachment for the path that scales.
    uploadFile: (name, type, data, id) => ipcRenderer.invoke('board:upload', { name, type, data, id }),
    // The upload path for real files. `item` is { name, type, size, path } for
    // anything that exists on disk — main streams it straight to storage, so a
    // gigabyte never lands in the renderer's heap OR crosses IPC — or
    // { name, type, size, data } for the things that were only ever in memory
    // (a pasted screenshot, a finished voice recording).
    uploadAttachment: (item, id) => ipcRenderer.invoke('board:uploadAttachment', { item, id }),
    onUploadProgress: (cb) => sub('upload:progress', cb),
    // The real filesystem path behind a File from a drop or the picker.
    // `File.path` was REMOVED in Electron 32; webUtils is the replacement, and
    // it only works from the preload — the renderer cannot reach it. Returns ''
    // for a File with no path (a pasted blob), which is the signal to fall back
    // to sending the bytes.
    pathForFile: (file) => {
        try { return webUtils.getPathForFile(file) || ''; } catch (e) { return ''; }
    },
    // `url` is the fallback for images that aren't ours (link previews): pass a
    // key for an attachment, or a remote http(s) url, not both.
    saveAttachment: (key, name, url) => ipcRenderer.invoke('board:saveAttachment', { key, name, url }),
    downloadAttachment: (key, name, url) => ipcRenderer.invoke('board:downloadAttachment', { key, name, url }),
    copyImage: (key, url) => ipcRenderer.invoke('board:copyImage', { key, url }),
    revealFile: (filePath) => ipcRenderer.invoke('board:revealFile', filePath),

    // Open Graph metadata for a link, via the cookie-gated unfurl endpoint.
    unfurl: (url) => ipcRenderer.invoke('board:unfurl', url),
    // YouTube oEmbed (title / channel / thumbnail). Main-process only — the
    // endpoint sends no CORS headers.
    youtube: (videoId) => ipcRenderer.invoke('board:youtube', videoId),
    // Bytes for an image dragged in from another window (URL, not a file).
    fetchImage: (url) => ipcRenderer.invoke('board:fetchImage', url),

    // Screen sharing: pick a source here, then start the share in the SDK.
    share: {
        sources: () => ipcRenderer.invoke('share:sources'),
        select: (id, audio) => ipcRenderer.invoke('share:select', { id, audio }),
        cancel: () => ipcRenderer.invoke('share:cancel')
    },

    // Short-lived RealtimeKit participant JWT for the SFU.
    voiceToken: (payload) => ipcRenderer.invoke('voice:token', payload),

    rt: {
        start: () => ipcRenderer.invoke('rt:start'),
        stop: () => ipcRenderer.invoke('rt:stop'),
        wake: () => ipcRenderer.invoke('rt:wake'),
        send: (obj) => ipcRenderer.invoke('rt:send', obj),
        // `kind` is 'refresh' when the nudge only asks peers to refetch — an edit,
        // a delete, a reaction, a pin — rather than announcing a new message. A
        // peer reading another channel must not badge or notify for those.
        notifyPosted: (channel, mentions, kind) => ipcRenderer.invoke('rt:posted', { channel, mentions, kind }),
        sendTyping: (channel, stop) => ipcRenderer.invoke('rt:typing', { channel, stop }),
        sendVoice: (inVoice, muted, deafened) => ipcRenderer.invoke('rt:voice', { inVoice, muted, deafened }),
        onMessage: (cb) => sub('rt:message', cb),
        onStatus: (cb) => sub('rt:status', cb)
    },

    // Native editing commands + clipboard state, for the composer's menu.
    edit: {
        cut: () => ipcRenderer.invoke('edit:command', 'cut'),
        copy: () => ipcRenderer.invoke('edit:command', 'copy'),
        paste: () => ipcRenderer.invoke('edit:command', 'paste'),
        selectAll: () => ipcRenderer.invoke('edit:command', 'selectAll'),
        undo: () => ipcRenderer.invoke('edit:command', 'undo'),
        redo: () => ipcRenderer.invoke('edit:command', 'redo'),
        clipboard: () => ipcRenderer.invoke('edit:clipboard'),
        // Right-click in a text field. Pushed FROM main rather than read from a
        // DOM event, because the spellchecker's answers — the misspelled word and
        // what it should be — exist only on main's `context-menu` event, and
        // cancelling the DOM event to draw our own menu is what used to stop that
        // event ever firing. See the handler in main.js.
        onContext: (cb) => sub('edit:context', cb),
        // Replace the misspelling under the cursor with a chosen suggestion.
        replaceMisspelling: (word) => ipcRenderer.invoke('edit:replaceMisspelling', word),
        // Teach the spellchecker a word so it stops being underlined.
        addToDictionary: (word) => ipcRenderer.invoke('edit:addToDictionary', word)
    },

    settings: {
        get: () => ipcRenderer.invoke('settings:get'),
        set: (patch) => ipcRenderer.invoke('settings:set', patch)
    },

    ptt: {
        apply: () => ipcRenderer.invoke('ptt:apply'),
        available: () => ipcRenderer.invoke('ptt:available'),
        describe: (binding) => ipcRenderer.invoke('ptt:describe', binding),
        onChange: (cb) => sub('ptt:change', cb)
    },

    win: {
        minimize: () => ipcRenderer.invoke('win:minimize'),
        maximize: () => ipcRenderer.invoke('win:maximize'),
        close: () => ipcRenderer.invoke('win:close'),
        isFocused: () => ipcRenderer.invoke('win:focused'),
        onFocus: (cb) => sub('win:focus', cb),
        // "The window is in the tray or minimised." document.hidden cannot
        // answer this — backgroundThrottling:false freezes it at false — so the
        // main process is the only thing that knows. See main.js.
        onHidden: (cb) => sub('win:hidden', cb)
    },

    app: {
        version: () => ipcRenderer.invoke('app:version'),
        isElevated: () => ipcRenderer.invoke('app:isElevated'),
        // Opens the folder holding the rotating log file (see main/log.js).
        openLogs: () => ipcRenderer.invoke('app:openLogs'),
        // Put one line in that file from here. For the handful of things worth
        // knowing after the fact — see the app:log handler for why this is
        // opt-in rather than a console bridge.
        log: (line) => ipcRenderer.invoke('app:log', line),
        notify: (payload) => ipcRenderer.invoke('app:notify', payload),
        setVoiceState: (state) => ipcRenderer.invoke('app:voiceState', state),
        // `flash` is the taskbar-flashing setting, separate from the count.
        setBadge: (count, flash) => ipcRenderer.invoke('app:badge', count, flash),
        openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
        // Theme. The renderer decides dark/light/follow-Windows; main owns the
        // system answer and restyles the native caption buttons to match.
        systemTheme: () => ipcRenderer.invoke('app:systemTheme'),
        setTheme: (theme) => ipcRenderer.invoke('app:setTheme', theme),
        // Whole-interface zoom, 50-200. Applied in main because webFrame needs
        // node in the renderer; answers with the value that was actually set.
        setZoom: (percent) => ipcRenderer.invoke('app:setZoom', percent),
        // Restart in place — the hardware acceleration switch is the only setting
        // Chromium cannot be told about after start-up.
        relaunch: () => ipcRenderer.invoke('app:relaunch'),
        onThemeChange: (cb) => sub('app:themeChange', cb),
        // Tray / menu actions that need to drive the UI.
        onCommand: (cb) => sub('app:command', cb),
        // Fired when the window is restored / the machine wakes — the renderer
        // should verify realtime and pull any messages it missed.
        onResync: (cb) => sub('app:resync', cb)
    },

    startup: {
        get: () => ipcRenderer.invoke('startup:get'),
        set: (openAtLogin, openAsHidden) => ipcRenderer.invoke('startup:set', { openAtLogin, openAsHidden })
    },

    update: {
        getState: () => ipcRenderer.invoke('update:getState'),
        check: () => ipcRenderer.invoke('update:check'),
        download: () => ipcRenderer.invoke('update:download'),
        install: () => ipcRenderer.invoke('update:install'),
        setAuto: (on) => ipcRenderer.invoke('update:setAuto', on),
        postpone: () => ipcRenderer.invoke('update:postpone'),
        // The whole published history, parsed main-side into the same block
        // model the update banner renders.
        history: (force) => ipcRenderer.invoke('update:history', force),
        onState: (cb) => sub('update:state', cb)
    },

    // Attachment URL served by the lounge:// protocol handler, which proxies to
    // the cookie-gated /api/board/file endpoint.
    fileUrl: (key) => 'lounge://file/' + encodeURIComponent(key)
});
