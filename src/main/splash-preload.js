// The bridge for the startup update screen, and nothing else.
//
// Deliberately NOT preload.js. That one exposes the whole app — the board API,
// the session-backed uploads, voice, settings — and the update screen exists
// precisely because none of that has started yet. Handing it the full surface
// would let a window whose entire job is "wait" reach everything the gate is
// holding back.
//
// One direction, one channel: main pushes progress, the page draws it.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('scarmUpdate', {
    // cb({ phase: 'checking' | 'downloading' | 'installing', percent, version })
    onProgress: (cb) => {
        if (typeof cb !== 'function') return;
        ipcRenderer.on('update:gate', (_event, payload) => cb(payload));
    }
});
