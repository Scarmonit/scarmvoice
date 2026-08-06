// @vitest-environment jsdom
//
// The announcement voice catalog: two linked dropdowns — Voice Type filters
// the Voice list — over the aura-2 speakers VERIFIED on this account (the
// model schema's own enum, 2026-08-06). The chosen speaker is saved and rides
// the lounge://tts URL for real announcements, not just the preview.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootRenderer, $, settle } from './helpers/renderer.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', 'src', 'renderer', 'app.js');
// The server's allowlist lives in the sibling website repo. When both are
// checked out (they always are on the machine that ships releases), the two
// lists are held against each other so a voice can never exist in the UI
// that the endpoint would refuse.
const TTS = path.resolve(HERE, '..', '..', 'scarmonit-website', 'functions', 'api', 'board', 'tts.js');

let app;

function catalogFromAppSource() {
    const src = fs.readFileSync(APP, 'utf8');
    const start = src.indexOf('const ANNOUNCE_VOICES = {');
    const block = src.slice(start, src.indexOf('};', start));
    const ids = [...block.matchAll(/\['([a-z]+)', '/g)].map((m) => m[1]);
    return ids;
}

beforeAll(async () => {
    const board = vi.fn(async (p) => {
        const key = String(p).split('?')[0];
        if (key === 'list') return { success: true, posts: [], hasMore: false, typing: [], voice: [] };
        if (key === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
        if (key === 'presence') return { success: true, members: [] };
        if (key === 'dm/threads') return { success: true, threads: [] };
        return { success: true };
    });
    app = await bootRenderer({ board });
    await settle(30);
});

describe('the catalog', () => {
    it('is the verified aura-2 set: 40 voices, no duplicates', () => {
        const ids = catalogFromAppSource();
        expect(ids.length).toBe(40);
        expect(new Set(ids).size).toBe(40);
    });

    it.skipIf(!fs.existsSync(TTS))('matches the server allowlist exactly', () => {
        const server = fs.readFileSync(TTS, 'utf8');
        const start = server.indexOf('const SPEAKERS = new Set([');
        const block = server.slice(start, server.indexOf('])', start));
        const serverIds = [...block.matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort();
        expect(catalogFromAppSource().sort()).toEqual(serverIds);
    });
});

describe('the linked dropdowns', () => {
    const options = () => [...$('set-announce-speaker').options].map((o) => o.value);
    const labels = () => [...$('set-announce-speaker').options].map((o) => o.textContent);

    function pickType(v) {
        const el = $('set-announce-voice');
        el.value = v;
        el.dispatchEvent(new window.Event('change', { bubbles: true }));
        return settle(6);
    }

    it('Female lists the female voices, default first, each with a character', async () => {
        await pickType('female');
        expect(options()[0]).toBe('asteria');
        expect(options()).toContain('luna');
        expect(options()).not.toContain('orion');
        // "Name – character", so the list can be read without previewing.
        expect(labels()[0]).toBe('Asteria – clear, confident');
        expect(labels().every((l) => / – .+/.test(l))).toBe(true);
    });

    it('switching to Male repopulates the list and saves both halves', async () => {
        await pickType('male');
        expect(options()[0]).toBe('orion');
        expect(options()).toContain('zeus');
        expect(options()).not.toContain('asteria');
        expect(app.settings.announceVoice).toBe('male');
        // The default male speaker was saved with the switch — the two
        // settings can never point at different genders.
        expect(app.settings.announceSpeaker).toBe('orion');
    });

    it('choosing a specific voice saves it, and it survives a repaint', async () => {
        const sel = $('set-announce-speaker');
        sel.value = 'zeus';
        sel.dispatchEvent(new window.Event('change', { bubbles: true }));
        await settle(4);
        expect(app.settings.announceSpeaker).toBe('zeus');

        // Re-selecting the same type repaints the list; the saved choice
        // stays selected rather than snapping back to the default.
        await pickType('male');
        expect($('set-announce-speaker').value).toBe('zeus');
        expect(app.settings.announceSpeaker).toBe('zeus');
    });
});
