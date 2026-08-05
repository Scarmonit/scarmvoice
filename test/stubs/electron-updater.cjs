// Stands in for electron-updater under test (see test/setup.js).
//
// The real one talks to GitHub and, on quitAndInstall, launches an installer and
// kills the process — neither of which a unit test can survive. This records the
// calls instead, so the module's DECISIONS (does it install, and when) are
// observable without anything actually happening.
const state = (globalThis.__UPDATER_STUB__ ||= {
    installs: [],
    checks: 0,
    downloads: 0,
    handlers: {},
    // Set to a message to make checkForUpdates() REJECT — offline, DNS failure,
    // a 500 from the feed. The rejection is a different path from the 'error'
    // event, and the startup gate has to survive both.
    checkFails: null
});

const autoUpdater = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowDowngrade: false,
    on(event, fn) {
        (state.handlers[event] ||= []).push(fn);
        return this;
    },
    // Let a test drive the real event sequence (update-downloaded etc.).
    emit(event, payload) {
        (state.handlers[event] || []).forEach((fn) => fn(payload));
    },
    checkForUpdates() {
        state.checks++;
        return state.checkFails
            ? Promise.reject(new Error(state.checkFails))
            : Promise.resolve(null);
    },
    downloadUpdate() { state.downloads++; return Promise.resolve([]); },
    // Recording this rather than quitting is itself one of the cases under test:
    // the real one replaces the process, so a stub that returns normally IS the
    // "installer never took over" scenario (see install-handover.test.js).
    // Set `installThrows` to a message for the other one — quitAndInstall
    // failing outright, which the real one does when it cannot spawn the
    // installer it downloaded.
    quitAndInstall(isSilent, isForceRunAfter) {
        state.installs.push({ isSilent, isForceRunAfter, at: Date.now() });
        if (state.installThrows) throw new Error(state.installThrows);
    }
};

module.exports = { autoUpdater, __state: state };
