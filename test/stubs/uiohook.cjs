// Stands in for `uiohook-napi` (see test/ptt-apply.test.js).
//
// The real package is a native addon: it loads fine in a plain Node process but
// start() reaches for a system-wide input hook, which a test must never install
// and — more to the point — must be able to make FAIL on demand. Whether
// start() throws is the whole subject of the fallback tests.
const state = (globalThis.__UIOHOOK_STUB__ ||= {
    startThrows: false,
    started: false
});

// Only the names ptt.js's codeToHookName() can produce for the bindings under
// test. An absent name resolves to undefined, which resolveBinding() treats as
// "this key cannot ride the hook" — the same as the real module.
const UiohookKey = {
    A: 30, V: 47, M: 50, D: 32,
    Backquote: 41, Space: 57,
    F13: 91, Ctrl: 29, Shift: 42, Alt: 56
};

const uIOhook = {
    on() { return uIOhook; },
    start() {
        if (state.startThrows) throw new Error('failed to register the global hook');
        state.started = true;
    },
    stop() { state.started = false; }
};

module.exports = { UiohookKey, uIOhook };
