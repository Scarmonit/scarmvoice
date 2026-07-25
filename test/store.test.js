// store.js — settings persistence, legacy-profile adoption, session encryption.
//
// The migration tests are the important ones: renaming the app from "The Lounge"
// to "ScarmVoice" moved userData, and copying session.bin *without* Chromium's
// per-profile "Local State" key produces a file the new profile cannot decrypt —
// which signs the user out silently, with no error anywhere in the UI.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { electronState as env } from './helpers/electron-state.js';
import { loadMain, resetMainModules } from './helpers/load.js';

let root;

// A fresh module instance per test — store.js caches settings at module scope.
async function loadStore() {
    resetMainModules();
    return loadMain('store.js');
}

function seedLegacy(files) {
    const dir = path.join(root, 'Roaming', 'The Lounge');
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), content);
    }
    return dir;
}

function seedCurrent(files) {
    fs.mkdirSync(env.userDataDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(env.userDataDir, name), content);
    }
}

const at = (name) => path.join(env.userDataDir, name);

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'scarmvoice-store-'));
    env.userDataDir = path.join(root, 'Roaming', 'ScarmVoice');
    env.encryptionAvailable = true;
});

afterEach(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* best effort */ }
});

describe('migrateLegacyProfile', () => {
    it('adopts settings, session AND Local State from the old app name', async () => {
        seedLegacy({
            'settings.json': JSON.stringify({ displayName: 'Scarm' }),
            'session.bin': 'ENC:old-session',
            'Local State': '{"os_crypt":{"encrypted_key":"abc"}}'
        });

        const store = await loadStore();
        store.migrateLegacyProfile();

        // Local State carries Chromium's OSCrypt key. Without it the copied
        // session.bin is undecryptable and the user is silently logged out.
        expect(fs.existsSync(at('settings.json'))).toBe(true);
        expect(fs.existsSync(at('session.bin'))).toBe(true);
        expect(fs.existsSync(at('Local State'))).toBe(true);
    });

    it('carries the session across intact, so the user stays signed in', async () => {
        seedLegacy({
            'settings.json': '{}',
            'session.bin': 'ENC:sb_auth_value',
            'Local State': '{}'
        });

        const store = await loadStore();
        store.migrateLegacyProfile();
        store.init();

        expect(store.readSession()).toBe('sb_auth_value');
    });

    it('never overwrites a profile that already exists', async () => {
        seedCurrent({ 'settings.json': JSON.stringify({ displayName: 'Current' }) });
        seedLegacy({
            'settings.json': JSON.stringify({ displayName: 'Legacy' }),
            'session.bin': 'ENC:legacy'
        });

        const store = await loadStore();
        store.migrateLegacyProfile();

        expect(JSON.parse(fs.readFileSync(at('settings.json'), 'utf8')).displayName).toBe('Current');
        expect(fs.existsSync(at('session.bin'))).toBe(false);
    });

    it('is a no-op on a fresh install with no legacy profile', async () => {
        const store = await loadStore();
        expect(() => store.migrateLegacyProfile()).not.toThrow();
        expect(fs.existsSync(at('settings.json'))).toBe(false);
    });

    it('copies what it can when the legacy profile is incomplete', async () => {
        seedLegacy({ 'settings.json': JSON.stringify({ displayName: 'Scarm' }) });

        const store = await loadStore();
        expect(() => store.migrateLegacyProfile()).not.toThrow();

        expect(fs.existsSync(at('settings.json'))).toBe(true);
        expect(fs.existsSync(at('session.bin'))).toBe(false);
    });
});

describe('settings', () => {
    it('merges saved settings over DEFAULTS so new keys reach existing users', async () => {
        // An old settings file written before newer keys existed.
        seedCurrent({ 'settings.json': JSON.stringify({ displayName: 'Scarm', channel: 'random' }) });

        const store = await loadStore();
        store.init();
        const s = store.get();

        expect(s.displayName).toBe('Scarm');
        expect(s.channel).toBe('random');
        expect(s.baseUrl).toBe(store.DEFAULTS.baseUrl);       // untouched key keeps its default
        expect(s.voiceSounds).toBe(store.DEFAULTS.voiceSounds);
    });

    it('falls back to DEFAULTS when settings.json is corrupt', async () => {
        seedCurrent({ 'settings.json': '{ this is not json' });

        const store = await loadStore();
        expect(() => store.init()).not.toThrow();
        expect(store.get().baseUrl).toBe(store.DEFAULTS.baseUrl);
    });

    it('persists a patch across a restart', async () => {
        const first = await loadStore();
        first.init();
        first.set({ displayName: 'Scarm', chatFontSize: 'large' });

        const second = await loadStore();
        second.init();

        expect(second.get().displayName).toBe('Scarm');
        expect(second.get().chatFontSize).toBe('large');
    });

    it('generates clientId once and keeps it stable across restarts', async () => {
        const first = await loadStore();
        first.init();
        const id = first.get().clientId;
        expect(id).toMatch(/^c/);

        const second = await loadStore();
        second.init();

        expect(second.get().clientId).toBe(id);
    });

    it('ignores a non-object patch', async () => {
        const store = await loadStore();
        store.init();
        const before = store.get().displayName;

        expect(() => store.set(null)).not.toThrow();
        expect(store.get().displayName).toBe(before);
    });
});

describe('session storage', () => {
    it('round-trips the cookie through safeStorage without writing plaintext', async () => {
        const store = await loadStore();
        store.init();
        store.writeSession('sb_auth_secret');

        const onDisk = fs.readFileSync(at('session.bin'), 'utf8');
        expect(onDisk).not.toBe('sb_auth_secret');       // it went through encryption
        expect(store.readSession()).toBe('sb_auth_secret');
    });

    it('round-trips as plaintext when encryption is unavailable', async () => {
        env.encryptionAvailable = false;

        const store = await loadStore();
        store.init();
        store.writeSession('sb_auth_secret');

        expect(store.readSession()).toBe('sb_auth_secret');
    });

    it('returns empty rather than throwing when the session cannot be decrypted', async () => {
        // Exactly the post-rename failure: a session file the current profile's
        // key cannot open. It must read as "signed out", not crash the app.
        const store = await loadStore();
        store.init();
        fs.writeFileSync(at('session.bin'), 'not-encrypted-by-this-profile');

        expect(store.readSession()).toBe('');
    });

    it('returns empty when there is no session at all', async () => {
        const store = await loadStore();
        store.init();
        expect(store.readSession()).toBe('');
    });

    it('writeSession("") clears the stored session', async () => {
        const store = await loadStore();
        store.init();
        store.writeSession('something');
        store.writeSession('');

        expect(fs.existsSync(at('session.bin'))).toBe(false);
    });

    it('clearSession is safe to call twice', async () => {
        const store = await loadStore();
        store.init();
        store.writeSession('something');

        expect(() => { store.clearSession(); store.clearSession(); }).not.toThrow();
        expect(store.readSession()).toBe('');
    });
});
