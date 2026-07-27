// @vitest-environment jsdom
//
// The voice engine's presenter registry. The SFU carries as many screen shares
// as people care to start, so "who is presenting" is a set, not a slot — the
// bug this guards is the old behaviour where a second presenter silently
// replaced the first and there was no way back to them.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RENDERER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');

// A minimal event target in the shape the RealtimeKit SDK hands us.
function emitter() {
    const handlers = {};
    return {
        on(name, fn) { (handlers[name] ||= []).push(fn); },
        emit(name, arg) { (handlers[name] || []).forEach((fn) => fn(arg)); }
    };
}

function track(id, kind) { return { id, kind, readyState: 'live', addEventListener() {} }; }

function participant(cid, name) {
    return Object.assign(emitter(), {
        customParticipantId: cid, name,
        audioEnabled: true, videoEnabled: false, screenShareEnabled: false,
        screenShareTracks: {}
    });
}

let meeting;

function makeMeeting() {
    const joined = Object.assign(emitter(), { toArray: () => [] });
    const self = Object.assign(emitter(), {
        customParticipantId: 'me', name: 'Me',
        enableAudio() {}, disableAudio() {},
        enableScreenShare() {}, disableScreenShare() {},
        screenShareEnabled: false, screenShareTracks: {}
    });
    return { self, participants: { joined }, join: () => {}, leave: () => {} };
}

// Everything voice.js reaches for that jsdom does not provide. None of it is
// what these tests are about, so it is stubbed to the smallest thing that works.
beforeEach(async () => {
    document.body.innerHTML = '';

    let seq = 0;
    window.MediaStream = class {
        constructor(tracks) { this.id = 'ms' + (++seq); this.tracks = (tracks || []).slice(); }
        addTrack(t) { this.tracks.push(t); }
    };
    globalThis.MediaStream = window.MediaStream;
    window.HTMLMediaElement.prototype.play = () => Promise.resolve();

    window.ScarmAudio = {
        createMeter: () => null,          // speaking detection is out of scope here
        createGain: () => null,
        onTick: () => () => {},
        setSinkId: () => {}
    };

    meeting = makeMeeting();
    window.RealtimeKitClient = { init: vi.fn(async () => meeting) };
    // The SDK is fetched on the first join rather than shipped in index.html,
    // so the engine asks the lazy loader for it instead of reading the global.
    window.ScarmLazy = {
        realtimekit: vi.fn(async () => window.RealtimeKitClient),
        hljs: async () => null,
        qrcode: async () => null,
        has: (name) => !!window[name]
    };
    window.lounge = { voiceToken: vi.fn(async () => ({ success: true, token: 't' })) };

    const code = fs.readFileSync(path.join(RENDERER, 'voice.js'), 'utf8');
    // eslint-disable-next-line no-new-func
    new Function(code).call(window);
});

// Joins a call and returns the engine plus the share lists it emitted.
async function joinedVoice() {
    const shares = [];
    const voice = window.createVoice({ onShares: (list) => shares.push(list) });
    voice.setSettings({ clientId: 'me', displayName: 'Me', voiceMode: 'open' });
    await voice.join();
    return { voice, shares, last: () => shares[shares.length - 1] || [] };
}

// Drives the SDK event a remote presenter starting/stopping produces.
function remoteShare(p, on, tracks) {
    p.screenShareEnabled = on;
    p.screenShareTracks = on ? (tracks || { video: track('v-' + p.customParticipantId, 'video') }) : {};
    meeting.participants.joined.emit('screenShareUpdate', p);
}

describe('voice presenters', () => {
    it('keeps every presenter, not just the latest', async () => {
        const { voice, last } = await joinedVoice();
        const alice = participant('a', 'Alice');
        const bob = participant('b', 'Bob');

        remoteShare(alice, true);
        remoteShare(bob, true);

        expect(last().map((s) => s.name)).toEqual(['Alice', 'Bob']);
        expect(voice.shares()).toHaveLength(2);
        expect(voice.state().sharers.map((s) => s.id)).toEqual(['a', 'b']);
    });

    it('drops only the presenter who stopped', async () => {
        const { voice, last } = await joinedVoice();
        const alice = participant('a', 'Alice');
        const bob = participant('b', 'Bob');
        remoteShare(alice, true);
        remoteShare(bob, true);

        remoteShare(alice, false);

        expect(last().map((s) => s.name)).toEqual(['Bob']);
        expect(voice.shares()).toHaveLength(1);
    });

    it('drops a presenter who leaves the call', async () => {
        const { voice } = await joinedVoice();
        const alice = participant('a', 'Alice');
        remoteShare(alice, true);

        meeting.participants.joined.emit('participantLeft', alice);

        expect(voice.shares()).toEqual([]);
    });

    it('lists your own share alongside the others, never above them', async () => {
        const { voice } = await joinedVoice();
        remoteShare(participant('a', 'Alice'), true);
        meeting.self.screenShareEnabled = true;
        meeting.self.emit('screenShareUpdate', {
            screenShareEnabled: true, screenShareTracks: { video: track('v-me', 'video') }
        });

        const list = voice.shares();
        expect(list.map((s) => s.isLocal)).toEqual([false, true]);
        expect(voice.state().sharing).toBe(true);
    });

    it('reuses the stream while the tracks are unchanged', async () => {
        // A re-fired screenShareUpdate must not hand the UI a new MediaStream:
        // swapping srcObject flashes the video black mid-presentation.
        const { voice } = await joinedVoice();
        const alice = participant('a', 'Alice');
        const tracks = { video: track('v-a', 'video') };

        remoteShare(alice, true, tracks);
        const first = voice.shares()[0].stream;
        remoteShare(alice, true, tracks);
        expect(voice.shares()[0].stream).toBe(first);

        remoteShare(alice, true, { video: track('v-a2', 'video') });
        expect(voice.shares()[0].stream).not.toBe(first);
    });

    it('plays share audio on its own element so an unwatched presenter is still heard', async () => {
        const { voice } = await joinedVoice();
        const alice = participant('a', 'Alice');
        remoteShare(alice, true, { video: track('v-a', 'video'), audio: track('a-a', 'audio') });

        const els = document.querySelectorAll('#audio-sink audio');
        expect(els).toHaveLength(1);
        expect(els[0].muted).toBe(false);

        voice.setDeafened(true);
        expect(els[0].muted).toBe(true);
        voice.setDeafened(false);
        expect(els[0].muted).toBe(false);

        // Muting the person mutes their share too — one control, both streams.
        voice.setLocalMuted('a', true);
        expect(els[0].muted).toBe(true);

        remoteShare(alice, false);
        expect(document.querySelectorAll('#audio-sink audio')).toHaveLength(0);
    });

    it('clears every presenter on leave', async () => {
        const { voice, last } = await joinedVoice();
        remoteShare(participant('a', 'Alice'), true);

        voice.leave();

        expect(last()).toEqual([]);
        expect(voice.shares()).toEqual([]);
    });
});
