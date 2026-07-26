// Global push-to-talk.
//
// Electron's globalShortcut can only tell us a key was *pressed* — there is no
// key-up event — so it can't drive real push-to-talk on its own. When the
// optional native hook (uiohook-napi, prebuilt for win32-x64) is available we
// get true system-wide keydown/keyup and mouse buttons. When it isn't, we
// degrade to globalShortcut acting as a push-to-talk *toggle*, and in-window
// PTT still works from the renderer's own key events.
const store = require('./store');

let hook = null;              // uiohook-napi module, if loadable
let hookRunning = false;
let listener = () => {};      // (down: boolean) => void
let held = false;
let binding = null;           // { type:'key'|'mouse', keycode|button, ctrl, shift, alt, meta }
let fallbackAccel = null;
let globalShortcut = null;

// KeyboardEvent.code -> UiohookKey name. The renderer records a binding with
// event.code; this is the only place the two vocabularies meet.
function codeToHookName(code) {
    if (!code) return null;
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    const alias = {
        ControlLeft: 'Ctrl', ControlRight: 'CtrlRight',
        ShiftLeft: 'Shift', ShiftRight: 'ShiftRight',
        AltLeft: 'Alt', AltRight: 'AltRight',
        MetaLeft: 'Meta', MetaRight: 'MetaRight',
        OSLeft: 'Meta', OSRight: 'MetaRight',
        ContextMenu: null
    };
    if (Object.prototype.hasOwnProperty.call(alias, code)) return alias[code];
    return code; // Space, F1-F24, Backquote, Semicolon, Numpad*, Arrow*, … all match
}

function loadHook() {
    if (hook !== null) return hook;
    try {
        hook = require('uiohook-napi');
    } catch (e) {
        console.warn('[ptt] native hook unavailable (' + e.message + ') — falling back to a toggle hotkey.');
        hook = false;
    }
    return hook;
}

function isAvailable() {
    return !!loadHook();
}

// Translate a stored binding into concrete matcher fields.
function resolveBinding(b) {
    if (!b || !b.code) return null;
    const mod = loadHook();
    if (b.type === 'mouse') {
        return { type: 'mouse', button: b.button, ctrl: !!b.ctrl, shift: !!b.shift, alt: !!b.alt, meta: !!b.meta };
    }
    if (!mod) return null;
    const name = codeToHookName(b.code);
    const keycode = name && mod.UiohookKey[name];
    if (keycode === undefined || keycode === null) return null;
    return { type: 'key', keycode, ctrl: !!b.ctrl, shift: !!b.shift, alt: !!b.alt, meta: !!b.meta };
}

// A modifier used AS the trigger key must not also be required as a modifier —
// otherwise "Shift" as the PTT key would never match (the event reports
// shiftKey true, but the binding was recorded without it).
function modsMatch(ev, b) {
    return (!b.ctrl || ev.ctrlKey) && (!b.shift || ev.shiftKey) &&
           (!b.alt || ev.altKey) && (!b.meta || ev.metaKey);
}

function onDown(ev, kind) {
    if (!binding || binding.type !== kind) return;
    const hit = kind === 'key' ? ev.keycode === binding.keycode : ev.button === binding.button;
    if (!hit || !modsMatch(ev, binding)) return;
    if (held) return;
    held = true;
    listener(true);
}

function onUp(ev, kind) {
    if (!binding || binding.type !== kind || !held) return;
    const hit = kind === 'key' ? ev.keycode === binding.keycode : ev.button === binding.button;
    if (!hit) return;
    held = false;
    listener(false);
}

function startHook() {
    const mod = loadHook();
    if (!mod || hookRunning) return;
    mod.uIOhook.on('keydown', (e) => onDown(e, 'key'));
    mod.uIOhook.on('keyup', (e) => onUp(e, 'key'));
    mod.uIOhook.on('mousedown', (e) => onDown(e, 'mouse'));
    mod.uIOhook.on('mouseup', (e) => onUp(e, 'mouse'));
    try {
        mod.uIOhook.start();
        hookRunning = true;
        console.log('[ptt] native global hook active');
    } catch (e) {
        console.warn('[ptt] failed to start native hook:', e.message);
        hook = false;
    }
}

// Fallback: register the accelerator as a toggle so PTT is still usable
// system-wide, just press-to-talk / press-to-stop instead of hold.
function registerFallback(accel) {
    if (!globalShortcut) globalShortcut = require('electron').globalShortcut;
    if (fallbackAccel) {
        try { globalShortcut.unregister(fallbackAccel); } catch (e) {}
        fallbackAccel = null;
    }
    if (!accel) return false;
    try {
        const ok = globalShortcut.register(accel, () => {
            held = !held;
            listener(held);
        });
        if (ok) fallbackAccel = accel;
        return ok;
    } catch (e) {
        return false;
    }
}

// Build an Electron accelerator from a recorded binding (fallback path only).
function toAccelerator(b) {
    if (!b || !b.code || b.type === 'mouse') return null;
    const parts = [];
    if (b.ctrl) parts.push('CommandOrControl');
    if (b.alt) parts.push('Alt');
    if (b.shift) parts.push('Shift');
    if (b.meta) parts.push('Super');
    let key = null;
    if (/^Key[A-Z]$/.test(b.code)) key = b.code.slice(3);
    else if (/^Digit[0-9]$/.test(b.code)) key = b.code.slice(5);
    else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(b.code)) key = b.code;
    else if (b.code === 'Space') key = 'Space';
    else if (b.code === 'Backquote') key = '`';
    else if (b.code.startsWith('Arrow')) key = b.code.slice(5);
    if (!key) return null;
    parts.push(key);
    // A bare key with no modifier would swallow that key globally — refuse it.
    return parts.length > 1 ? parts.join('+') : null;
}

// ---- public API ----------------------------------------------------------

function apply() {
    const s = store.get();
    binding = resolveBinding(s.pttBinding);
    if (held) { held = false; listener(false); }

    if (isAvailable() && binding) {
        startHook();
        registerFallback(null);   // native hook covers it; don't double-fire
        return { mode: 'native', bound: describe(s.pttBinding) };
    }
    const accel = toAccelerator(s.pttBinding) || s.pttKey;
    const ok = registerFallback(accel);
    return { mode: ok ? 'toggle' : 'none', bound: ok ? accel : null };
}

function describe(b) {
    if (!b || !b.code) return null;
    if (b.type === 'mouse') return `Mouse ${b.button}`;
    const parts = [];
    if (b.ctrl) parts.push('Ctrl');
    if (b.alt) parts.push('Alt');
    if (b.shift) parts.push('Shift');
    if (b.meta) parts.push('Win');
    let key = b.code;
    if (/^Key[A-Z]$/.test(key)) key = key.slice(3);
    else if (/^Digit[0-9]$/.test(key)) key = key.slice(5);
    if (!parts.includes(key)) parts.push(key);
    return parts.join(' + ');
}

function onChange(cb) { listener = cb || (() => {}); }

// Force the held/toggle state back to "up". The renderer discards PTT events
// while not in a call, so a fallback-mode toggle pressed outside voice would
// leave main's `held` inverted — the first press in the next call then does
// nothing. Called on every join/leave voice-state transition.
function reset() {
    if (held) { held = false; listener(false); }
}

function shutdown() {
    if (fallbackAccel && globalShortcut) {
        try { globalShortcut.unregister(fallbackAccel); } catch (e) {}
        fallbackAccel = null;
    }
    if (hookRunning && hook) {
        try { hook.uIOhook.stop(); } catch (e) {}
        hookRunning = false;
    }
}

module.exports = { apply, onChange, shutdown, isAvailable, describe, reset };
