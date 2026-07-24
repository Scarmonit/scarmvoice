// The only bridge between the sandboxed renderer and Node. Everything is an
// explicit, narrow method — the renderer gets no ipcRenderer, no require, and
// never sees the session cookie.
const { contextBridge, ipcRenderer } = require('electron');

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

    // Attachments. `data` is an ArrayBuffer of the raw file bytes.
    uploadFile: (name, type, data) => ipcRenderer.invoke('board:upload', { name, type, data }),
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
        notifyPosted: (channel) => ipcRenderer.invoke('rt:posted', channel),
        sendTyping: (channel, stop) => ipcRenderer.invoke('rt:typing', { channel, stop }),
        sendVoice: (inVoice, muted) => ipcRenderer.invoke('rt:voice', { inVoice, muted }),
        onMessage: (cb) => sub('rt:message', cb),
        onStatus: (cb) => sub('rt:status', cb)
    },

    // Native editing commands + clipboard state, for the composer's menu.
    edit: {
        cut: () => ipcRenderer.invoke('edit:command', 'cut'),
        copy: () => ipcRenderer.invoke('edit:command', 'copy'),
        paste: () => ipcRenderer.invoke('edit:command', 'paste'),
        selectAll: () => ipcRenderer.invoke('edit:command', 'selectAll'),
        clipboard: () => ipcRenderer.invoke('edit:clipboard')
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
        onFocus: (cb) => sub('win:focus', cb)
    },

    app: {
        version: () => ipcRenderer.invoke('app:version'),
        isElevated: () => ipcRenderer.invoke('app:isElevated'),
        notify: (payload) => ipcRenderer.invoke('app:notify', payload),
        setVoiceState: (state) => ipcRenderer.invoke('app:voiceState', state),
        setBadge: (count) => ipcRenderer.invoke('app:badge', count),
        openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
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
        onState: (cb) => sub('update:state', cb)
    },

    // Attachment URL served by the lounge:// protocol handler, which proxies to
    // the cookie-gated /api/board/file endpoint.
    fileUrl: (key) => 'lounge://file/' + encodeURIComponent(key)
});
