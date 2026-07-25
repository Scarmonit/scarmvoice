// ptt.js — push-to-talk binding formatting.
//
// Only describe() is exercised here: it's pure, and it's what the Settings
// screen shows the user. The rest of the module reaches for the native hook or
// globalShortcut, which needs a real Electron process.
import { describe, it, expect } from 'vitest';
import { loadMain } from './helpers/load.js';

const ptt = loadMain('ptt.js');

describe('describe', () => {
    it('strips the Key/Digit prefix', () => {
        expect(ptt.describe({ type: 'key', code: 'KeyA' })).toBe('A');
        expect(ptt.describe({ type: 'key', code: 'Digit5' })).toBe('5');
    });

    it('keeps named keys as-is', () => {
        expect(ptt.describe({ type: 'key', code: 'Backquote' })).toBe('Backquote');
        expect(ptt.describe({ type: 'key', code: 'Space' })).toBe('Space');
        expect(ptt.describe({ type: 'key', code: 'F13' })).toBe('F13');
    });

    it('renders modifiers in a stable order', () => {
        expect(ptt.describe({ type: 'key', code: 'KeyV', ctrl: true, shift: true })).toBe('Ctrl + Shift + V');
        expect(ptt.describe({ type: 'key', code: 'KeyQ', alt: true, meta: true })).toBe('Alt + Win + Q');
    });

    it('does not repeat a key that is also its own modifier', () => {
        // "Shift + Shift" would be nonsense in the Settings UI.
        expect(ptt.describe({ type: 'key', code: 'Shift', shift: true })).toBe('Shift');
        expect(ptt.describe({ type: 'key', code: 'Ctrl', ctrl: true })).toBe('Ctrl');
    });

    it('labels mouse buttons', () => {
        expect(ptt.describe({ type: 'mouse', code: 'Mouse4', button: 4 })).toBe('Mouse 4');
    });

    it('returns null for an unset binding', () => {
        expect(ptt.describe(null)).toBeNull();
        expect(ptt.describe({})).toBeNull();
        expect(ptt.describe({ type: 'key' })).toBeNull();
    });
});
