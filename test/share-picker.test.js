// @vitest-environment jsdom
//
// The screen-share picker: categories across the top, a grid of labelled
// sources, and the SD/HD tier beside them.
//
// Electron on Windows has no system picker, so this one is the whole chooser —
// the source it hands to the main process is what getDisplayMedia will be
// answered with. Two of the rules below are not obvious from reading it:
//
//   * HD is NOT "set 1080p". The app supports 1440p, which SD/HD cannot
//     express, so pressing the tier you are already on must not quietly move
//     you down to 1080p.
//   * a selection belongs to the category it was made in. Carrying it across a
//     tab switch means Share can send a window while the grid shows screens,
//     with nothing on screen saying which one is armed.
//
// ONE boot for the whole file, as the other renderer specs do: bootRenderer
// leaves the previous instance's timers running and its listeners bound to the
// same document, which shows up here as a click landing twice.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { bootRenderer, $, settle } from './helpers/renderer.js';

const SOURCES = [
    { id: 'screen:0', name: 'Entire screen', isScreen: true, thumbnail: 'data:image/png;base64,AA', appIcon: null },
    { id: 'window:1', name: 'Claude', isScreen: false, thumbnail: 'data:image/png;base64,AA', appIcon: 'data:image/png;base64,BB' },
    { id: 'window:2', name: 'Visual Studio Code', isScreen: false, thumbnail: null, appIcon: null }
];

let app;
let selected;

const tiles = () => [...$('picker-grid').querySelectorAll('.pick')];
const names = () => tiles().map((t) => t.querySelector('.pick-name span').textContent);
const tab = (which) => document.querySelector(`.picker-tab[data-tab="${which}"]`);

async function openPicker() {
    $('btn-share').click();
    await settle(20);
}

beforeAll(async () => {
    app = await bootRenderer({
        board: vi.fn(async (p) => {
            const key = String(p).split('?')[0];
            if (key === 'list') return { success: true, posts: [], hasMore: false, typing: [], voice: [] };
            if (key === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
            if (key === 'presence') return { success: true, members: [] };
            if (key === 'dm/threads') return { success: true, threads: [] };
            return { success: true };
        }),
        // The picker's entry point is gated on being in a call.
        voice: { isJoined: () => true, isSharing: () => false, startShare: async () => true }
    });
    await settle(30);

    app.lounge.share.sources = vi.fn(async () => SOURCES);
    app.lounge.share.select = vi.fn(async (id, audio) => { selected = { id, audio }; return true; });
    app.lounge.share.cancel = vi.fn();
});

beforeEach(async () => {
    selected = undefined;
    // Back to a known tier between assertions; the picker reads it on open.
    await app.lounge.settings.set({ shareQuality: '1080p', shareMotion: 'sharp' });
    if (!$('picker').hidden) $('picker-cancel').click();
    await settle(4);
});

describe('the categories', () => {
    it('opens on Applications, and lists only windows there', async () => {
        await openPicker();
        expect(tab('window').classList.contains('active')).toBe(true);
        expect(tab('window').getAttribute('aria-selected')).toBe('true');
        expect(names()).toEqual(['Claude', 'Visual Studio Code']);
    });

    it('lists only screens under Entire Screen', async () => {
        await openPicker();
        tab('screen').click();
        await settle(4);
        expect(tab('screen').classList.contains('active')).toBe(true);
        expect(names()).toEqual(['Entire screen']);
    });

    it('forgets the selection when the category changes', async () => {
        await openPicker();
        tiles()[0].click();
        await settle(4);
        expect($('picker-go').disabled).toBe(false);

        tab('screen').click();
        await settle(4);
        // Otherwise Share is armed with a window while the grid shows screens.
        expect($('picker-go').disabled, 'Share is re-armed by the new category').toBe(true);
        expect($('picker-chosen-name').textContent).toBe('Nothing selected');
    });

    it('draws a real box for a source with no thumbnail', async () => {
        await openPicker();
        // An <img> with no src renders as a BROKEN image — a torn-page glyph
        // and a stray outline in the middle of the grid.
        const vscode = tiles()[1];
        expect(vscode.querySelector('img')).toBeNull();
        expect(vscode.querySelector('.pick-blank')).toBeTruthy();
    });
});

describe('what is about to be shared', () => {
    it('names the choice and describes how it will look', async () => {
        await openPicker();
        expect($('picker-chosen-name').textContent).toBe('Nothing selected');

        tiles()[0].click();
        await settle(4);
        expect($('picker-chosen-name').textContent).toBe('Claude');
        expect($('picker-chosen-sub').textContent).toBe('Sharper text · 1080p · 30fps');
    });

    it('hands the main process the id it was shown, with the audio choice', async () => {
        await openPicker();
        tiles()[0].click();
        await settle(4);
        $('picker-audio').checked = true;
        $('picker-go').click();
        await settle(10);

        expect(selected).toEqual({ id: 'window:1', audio: true });
        expect($('picker').hidden, 'the picker closes once it has answered').toBe(true);
    });
});

describe('the SD / HD tier', () => {
    it('shows HD for a 1080p setting and SD for 720p', async () => {
        await openPicker();
        expect($('pq-hd').classList.contains('active')).toBe(true);
        expect($('pq-sd').classList.contains('active')).toBe(false);

        $('pq-sd').click();
        await settle(6);
        expect($('pq-sd').classList.contains('active')).toBe(true);
        expect(app.settings.shareQuality).toBe('720p');
        expect($('picker-chosen-sub').textContent).toContain('720p');
    });

    it('raises 720p to 1080p when HD is pressed', async () => {
        await app.lounge.settings.set({ shareQuality: '720p' });
        await openPicker();
        expect($('pq-sd').classList.contains('active')).toBe(true);

        $('pq-hd').click();
        await settle(6);
        expect(app.settings.shareQuality).toBe('1080p');
    });

    it('does NOT drag 1440p down to 1080p when HD is pressed', async () => {
        // The whole reason the two buttons are asymmetric. 1440p is already HD;
        // writing 1080p unconditionally would downgrade somebody every time
        // they pressed the tier they were already on.
        await app.lounge.settings.set({ shareQuality: '1440p' });
        await openPicker();
        expect($('pq-hd').classList.contains('active'), '1440p reads as HD').toBe(true);

        $('pq-hd').click();
        await settle(6);
        expect(app.settings.shareQuality).toBe('1440p');
        expect($('picker-chosen-sub').textContent).toContain('1440p');
    });

    it('says 60fps for smooth motion', async () => {
        await app.lounge.settings.set({ shareMotion: 'smooth' });
        await openPicker();
        expect($('picker-chosen-sub').textContent).toBe('Smoother video · 1080p · 60fps');
    });
});
