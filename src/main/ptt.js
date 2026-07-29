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
let listener = () => {};      // (down: boolean) => void — push-to-talk only
let actionListener = () => {}; // (action: string) => void — mute/deafen toggles
let held = false;
let binding = null;           // { type:'key'|'mouse', keycode|button, ctrl, shift, alt, meta }
// Global one-shot toggles (mute/deafen). Each: { action, binding, held }.
// `held` swallows uiohook's key-repeat so holding the key fires once.
let toggles = [];
let fallbackAccels = [];      // every accelerator registered in fallback mode
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

function bindingHit(ev, kind, b) {
    if (!b || b.type !== kind) return false;
    return kind === 'key' ? ev.keycode === b.keycode : ev.button === b.button;
}

function onDown(ev, kind) {
    if (bindingHit(ev, kind, binding) && modsMatch(ev, binding) && !held) {
        held = true;
        listener(true);
    }
    for (const t of toggles) {
        if (!bindingHit(ev, kind, t.binding) || !modsMatch(ev, t.binding)) continue;
        if (t.held) continue;               // key repeat while held — one toggle per press
        t.held = true;
        actionListener(t.action);
    }
}

function onUp(ev, kind) {
    if (held && bindingHit(ev, kind, binding)) {
        held = false;
        listener(false);
    }
    for (const t of toggles) {
        if (t.held && bindingHit(ev, kind, t.binding)) t.held = false;
    }
}

// Returns whether the hook is actually running. The module loading is not the
// same thing as the hook working: start() throws when the OS refuses the
// low-level input hook (locked-down policy, another app holding it), and the
// caller has to know so it can register the accelerator fallbacks instead.
function startHook() {
    const mod = loadHook();
    if (!mod) return false;
    if (hookRunning) return true;
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
    return hookRunning;
}

function clearFallbacks() {
    if (!globalShortcut) globalShortcut = require('electron').globalShortcut;
    fallbackAccels.forEach((a) => { try { globalShortcut.unregister(a); } catch (e) {} });
    fallbackAccels = [];
}

function registerAccel(accel, fn) {
    if (!accel) return false;
    try {
        const ok = globalShortcut.register(accel, fn);
        if (ok) fallbackAccels.push(accel);
        return ok;
    } catch (e) {
        return false;
    }
}

// Fallback: register the PTT accelerator as a toggle so PTT is still usable
// system-wide, just press-to-talk / press-to-stop instead of hold.
function registerFallback(accel) {
    return registerAccel(accel, () => {
        held = !held;
        listener(held);
    });
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
    clearFallbacks();

    // Mute/deafen toggles ride whichever transport PTT uses. In native-hook
    // mode they get real keydown/keyup; in fallback mode each becomes its own
    // globalShortcut (which is naturally a one-shot per press).
    const wanted = [
        { action: 'toggleMute', raw: s.muteBinding },
        { action: 'toggleDeafen', raw: s.deafenBinding }
    ].filter((t) => t.raw && t.raw.code);

    // PTT's transport is decided by the PTT binding ALONE. It used to ride on
    // "the hook is worth starting", which is also true when only a mute/deafen
    // binding resolved — and then PTT got no native hold, no fallback
    // accelerator either, yet apply() still reported a mode and a bound key, so
    // the Settings screen showed a hotkey that did nothing.
    const hookWanted = isAvailable() && (binding || wanted.some((t) => resolveBinding(t.raw)));
    // …and whether the hook can be TRUSTED is only known after start() returns.
    // This used to be decided before starting it, so a hook that loaded but
    // failed to start still reported 'native' and registered no accelerator at
    // all — every hotkey was silently dead until the next apply().
    const hookUsable = hookWanted && startHook();
    toggles = [];
    if (hookUsable) {
        toggles = wanted
            .map((t) => ({ action: t.action, binding: resolveBinding(t.raw), held: false }))
            .filter((t) => t.binding);
    }

    // Anything the hook can't carry (no hook at all, or a binding it couldn't
    // resolve) becomes a plain accelerator instead.
    wanted.forEach((t) => {
        if (hookUsable && resolveBinding(t.raw)) return;
        registerAccel(toAccelerator(t.raw), () => actionListener(t.action));
    });

    if (hookUsable && binding) {
        return { mode: 'native', bound: describe(s.pttBinding) };
    }

    // No native hold for PTT — fall back to the press-to-talk/press-to-stop
    // accelerator, and report only what actually registered.
    //
    // `s.pttKey` is the app's own default and is shown NOWHERE in the UI, so it
    // may only stand in when the user has no binding at all (Backspace in the
    // recorder clears one deliberately). It used to stand in whenever the
    // recorded key could be carried by neither transport — Pause, the Menu key,
    // IntlBackslash on an ISO keyboard — and the result was that recording one
    // of those silently grabbed Ctrl+Shift+Space system-wide, off every other
    // application, and made it a LATCHING open-mic toggle. Settings went on
    // printing the key the user actually pressed.
    const hasBinding = !!(s.pttBinding && s.pttBinding.code);
    const accel = toAccelerator(s.pttBinding) || (hasBinding ? null : s.pttKey);
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
function onAction(cb) { actionListener = cb || (() => {}); }

// Force the held/toggle state back to "up". The renderer discards PTT events
// while not in a call, so a fallback-mode toggle pressed outside voice would
// leave main's `held` inverted — the first press in the next call then does
// nothing. Called on every join/leave voice-state transition.
function reset() {
    if (held) { held = false; listener(false); }
}

function shutdown() {
    clearFallbacks();
    if (hookRunning && hook) {
        try { hook.uIOhook.stop(); } catch (e) {}
        hookRunning = false;
    }
}

module.exports = { apply, onChange, onAction, shutdown, isAvailable, describe, reset };
