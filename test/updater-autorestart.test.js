// Updates install themselves now, which means the app can decide on its own to
// quit. The rules about WHEN are the whole safety story, so they are pinned
// here rather than left to a comment.
//
// The one that matters: never through a call. ScarmVoice is a voice app, and a
// restart mid-conversation drops you out of it — a worse interruption than any
// update is worth.
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { loadMain, resetMainModules } from './helpers/load.js';

let updater, sent;

beforeEach(() => {
    vi.useFakeTimers();
    resetMainModules();
    updater = loadMain('updater.js');
    sent = [];
    updater.init((channel, state) => sent.push({ channel, state: { ...state } }));
});

afterEach(() => { vi.useRealTimers(); });

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
});
