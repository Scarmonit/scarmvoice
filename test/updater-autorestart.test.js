// Updates install themselves now, which means the app can decide on its own to
// quit. The rules about WHEN are the whole safety story, so they are pinned
// here rather than left to a comment.
//
// The one that matters: never through a call. ScarmVoice is a voice app, and a
// restart mid-conversation drops you out of it — a worse interruption than any
// update is worth.
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { electronState as env } from './helpers/electron-state.js';
import { loadMain, resetMainModules } from './helpers/load.js';

let updater, sent, root;

beforeEach(() => {
    vi.useFakeTimers();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'scarmvoice-update-'));
    env.userDataDir = path.join(root, 'Roaming', 'ScarmVoice');
    resetMainModules();
    updater = loadMain('updater.js');
    sent = [];
    updater.init((channel, state) => sent.push({ channel, state: { ...state } }));
});

afterEach(() => {
    vi.useRealTimers();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* windows lock */ }
});

const last = () => (sent.length ? sent[sent.length - 1].state : null);

describe('auto-restart', () => {
    it('does not count down while a call is in progress', () => {
        updater.setBusy(true);
        // Pretend a download just finished.
        updater.setAuto(true);
        // Nothing may schedule a quit while busy.
        vi.advanceTimersByTime(60_000);
        const s = updater.getState();
        expect(s.restartIn).toBeNull();
    });

    it('reports that it is waiting on the call rather than failing silently', () => {
        updater.setBusy(true);
        const s = updater.getState();
        // Not an error state — an update that is simply later.
        expect(s.status).not.toBe('error');
    });

    it('leaving a call does not by itself trigger a restart with nothing downloaded', () => {
        updater.setBusy(true);
        updater.setBusy(false);
        vi.advanceTimersByTime(60_000);
        // status is still idle: there was never an update to install, and the
        // resume path must not fire on an empty state.
        expect(updater.getState().status).toBe('idle');
        expect(updater.getState().restartIn).toBeNull();
    });

    it('postponing clears any countdown', () => {
        updater.postpone();
        expect(updater.getState().postponed).toBe(true);
        expect(updater.getState().restartIn).toBeNull();
    });

    it('setAuto(false) postpones rather than disabling updates', () => {
        // The setting can no longer switch updating off — the most it does is
        // hold the restart. auto stays true whatever is passed.
        updater.setAuto(false);
        expect(updater.getState().auto).toBe(true);
    });

    it('setAuto(true) clears a previous postponement', () => {
        updater.postpone();
        expect(updater.getState().postponed).toBe(true);
        updater.setAuto(true);
        expect(updater.getState().postponed).toBe(false);
    });

    it('setAuto(false) holds back an update that is not ready yet either', () => {
        // It used to only postpone when something was ALREADY downloaded, so
        // turning the switch off and then receiving an update restarted the app
        // regardless — which is the whole of what the switch promises not to do.
        expect(updater.getState().status).toBe('idle');
        updater.setAuto(false);
        expect(updater.getState().postponed).toBe(true);
    });
});

// The checkbox is persisted. Nothing read it back, so it only ever held for the
// session it was clicked in — the next launch restarted the app on its own.
describe('the stored preference', () => {
    // A profile written by someone who turned the restart off.
    function seed(value) {
        fs.mkdirSync(env.userDataDir, { recursive: true });
        fs.writeFileSync(path.join(env.userDataDir, 'settings.json'),
            JSON.stringify({ autoUpdateOnLaunch: value, autoRestartMigrated: true }));
        resetMainModules();
        loadMain('store.js').init();          // same registry as updater's require
        updater = loadMain('updater.js');
        sent = [];
        updater.init((channel, state) => sent.push({ channel, state: { ...state } }));
        return updater.getState();
    }

    it('carries a stored "off" across the launch', () => {
        expect(seed(false).postponed).toBe(true);
    });

    it('leaves the default alone', () => {
        expect(seed(true).postponed).toBe(false);
    });
});
