// ptt.js — which transport apply() actually hands the hotkeys to.
//
// apply()'s return value is not cosmetic: the Settings screen prints it, and
// whichever branch it takes is the ONLY one that registers anything. So a wrong
// answer here is not a wrong label, it is a hotkey that does nothing at all.
//
// The native hook is the interesting case because it can fail in two very
// different places — the module may not load, or it may load and then fail to
// start (a locked-down machine, another app already holding the low-level
// hook). Only the first of those used to be handled.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { electronState as env } from './helpers/electron-state.js';
import { loadMain, resetMainModules } from './helpers/load.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const UIOHOOK_STUB = path.join(here, 'stubs', 'uiohook.cjs');

// uiohook-napi IS installed here, and in a plain Node process it loads — so
// without this redirect these tests would install a real system-wide input
// hook, and start() could never be made to fail. Layered over setup.js's own
// patch rather than replacing it, so `electron` stays stubbed too.
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (request === 'uiohook-napi') return UIOHOOK_STUB;
    return originalResolve.call(this, request, ...rest);
};
afterAll(() => { Module._resolveFilename = originalResolve; });

// The same stub instances ptt.js gets: each resolves to one absolute path, so
// they share CommonJS's cache entry.
const require_ = createRequire(import.meta.url);
const { globalShortcut } = require_('electron');
const hookState = (globalThis.__UIOHOOK_STUB__ ||= { startThrows: false, started: false });

const realRegister = globalShortcut.register;
const realUnregister = globalShortcut.unregister;

let root;
let registered;      // accelerators, in registration order
let handlers;        // accelerator -> the callback globalShortcut would fire

// Fresh module instances per test: ptt.js caches the loaded hook module and its
// running state at module scope, and store.js caches settings there too.
function loadPtt(settings) {
    resetMainModules();
    const store = loadMain('store.js');
    store.init();
    store.set(settings);
    store.flush();      // otherwise a debounced write outlives the test's temp dir
    return loadMain('ptt.js');
}

const CTRL_V = { type: 'key', code: 'KeyV', ctrl: true };
const CTRL_SHIFT_M = { type: 'key', code: 'KeyM', ctrl: true, shift: true };
const CTRL_SHIFT_D = { type: 'key', code: 'KeyD', ctrl: true, shift: true };

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'scarmvoice-ptt-'));
    env.userDataDir = path.join(root, 'Roaming', 'ScarmVoice');
    hookState.startThrows = false;
    hookState.started = false;
    registered = [];
    handlers = new Map();
    globalShortcut.register = (accel, fn) => { registered.push(accel); handlers.set(accel, fn); return true; };
    globalShortcut.unregister = () => {};
});

afterEach(() => {
    globalShortcut.register = realRegister;
    globalShortcut.unregister = realUnregister;
    fs.rmSync(root, { recursive: true, force: true });
});

describe('apply() with a working native hook', () => {
    it('reports native mode and registers no accelerators', () => {
        const ptt = loadPtt({ pttBinding: CTRL_V, muteBinding: CTRL_SHIFT_M, deafenBinding: CTRL_SHIFT_D });
        expect(ptt.apply()).toEqual({ mode: 'native', bound: 'Ctrl + V' });
        expect(hookState.started).toBe(true);
        // Everything rides the hook, so none of it may also be swallowed
        // globally by an accelerator.
        expect(registered).toEqual([]);
    });
});

describe('apply() when the hook loads but fails to start', () => {
    beforeEach(() => { hookState.startThrows = true; });

    it('falls back to the toggle accelerator for push-to-talk', () => {
        const ptt = loadPtt({ pttBinding: CTRL_V });
        // Not 'native': there is no hook to hold the key down with, and saying
        // so is what makes Settings show the toggle wording.
        expect(ptt.apply()).toEqual({ mode: 'toggle', bound: 'CommandOrControl+V' });
        expect(registered).toContain('CommandOrControl+V');
    });

    it('registers the mute and deafen accelerators too', () => {
        const ptt = loadPtt({ pttBinding: CTRL_V, muteBinding: CTRL_SHIFT_M, deafenBinding: CTRL_SHIFT_D });
        const seen = [];
        ptt.onAction((a) => seen.push(a));
        ptt.apply();
        expect(registered).toContain('CommandOrControl+Shift+M');
        expect(registered).toContain('CommandOrControl+Shift+D');
        handlers.get('CommandOrControl+Shift+M')();
        expect(seen).toEqual(['toggleMute']);
    });

    it('drives push-to-talk from the fallback accelerator', () => {
        const ptt = loadPtt({ pttBinding: CTRL_V });
        const seen = [];
        ptt.onChange((down) => seen.push(down));
        ptt.apply();
        // Press-to-talk / press-to-stop, since globalShortcut has no key-up
        // event to end a hold with.
        const press = handlers.get('CommandOrControl+V');
        press(); press();
        expect(seen).toEqual([true, false]);
    });

    it('keeps mute and deafen even when PTT itself cannot be bound', () => {
        // A hook failure must not take the other two hotkeys down with it, and
        // a mode of 'none' has to mean nothing registered for PTT — not that
        // apply() gave up partway.
        const ptt = loadPtt({ pttBinding: null, pttKey: '', muteBinding: CTRL_SHIFT_M });
        expect(ptt.apply()).toEqual({ mode: 'none', bound: null });
        expect(registered).toEqual(['CommandOrControl+Shift+M']);
    });

    // A key that neither transport can carry — Pause, the Menu key,
    // IntlBackslash on an ISO keyboard — used to fall through to `pttKey`, the
    // never-user-visible default. The result was that recording one of those
    // silently registered Ctrl+Shift+Space system-wide, took it off every other
    // application, and made it a LATCHING open-mic toggle, while Settings went
    // on printing the key the user had actually pressed.
    it('registers nothing when the recorded key fits neither transport', () => {
        const ptt = loadPtt({
            pttBinding: { type: 'key', code: 'Pause' },
            pttKey: 'CommandOrControl+Shift+Space'
        });
        expect(ptt.apply()).toEqual({ mode: 'none', bound: null });
        expect(registered).toEqual([]);
    });

    it('still falls back to the default key when there is no binding at all', () => {
        // Backspace in the recorder CLEARS the binding on purpose, and that is
        // the one case the default is allowed to stand in for.
        const ptt = loadPtt({ pttBinding: null, pttKey: 'CommandOrControl+Shift+Space' });
        expect(ptt.apply()).toEqual({ mode: 'toggle', bound: 'CommandOrControl+Shift+Space' });
        expect(registered).toEqual(['CommandOrControl+Shift+Space']);
    });
});
