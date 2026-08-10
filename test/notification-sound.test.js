// @vitest-environment jsdom
//
// THE CUSTOM CHIME, NOT THE WINDOWS DING.
//
// Reported from a real session: window minimised, a message arrives, and what
// plays is the standard Windows notification sound instead of this app's own
// chime. Two independent defects produced it, and either one on its own is
// enough to reproduce it.
//
//   1. main.js raised the desktop toast with `silent: !notificationSound`. A
//      Windows toast that is not silent plays the OS default sound — so with
//      the chime switch ON (the default) the app asked Windows to make a noise
//      of its own, and a toast only ever appears when the window is NOT
//      focused. That is pinned in the main-source spec at the bottom.
//   2. A post in a channel you are not reading raised the toast and NOTHING
//      else. Every other arrival chimes — the open channel from loadMessages, a
//      DM from the DM notifier — but this path never called playMessage, so the
//      OS ding was the entire sound. That is the first half below.
//
// The chime is spied on AFTER boot: app.js reaches window.loungeSounds at call
// time, so replacing the method afterwards is what a real chime would go
// through.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootRenderer, settle } from './helpers/renderer.js';

const MAIN = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main', 'main.js');

const ME = { id: 7, username: 'Me', role: 'member' };

const board = () => vi.fn(async (p) => {
    if (p === 'list') return { success: true, posts: [], typing: [], voice: [], hasMore: false };
    if (p === 'channels') {
        return { success: true, channels: [{ name: 'general', unread: 0 }, { name: 'random', unread: 0 }] };
    }
    if (p === 'presence') return { success: true, members: [] };
    if (p === 'dm/threads') return { success: true, threads: [] };
    return { success: true };
});

// A post landing in a channel that is not on screen — the case the socket
// notifies about, and the one somebody with the app in the tray hits most.
const nudge = (over) => Object.assign(
    { t: 'posted', channel: 'random', cid: 'c-elsewhere', name: 'Alice' }, over);

async function bootWithChime(settings) {
    const out = await bootRenderer({
        user: ME, board: board(),
        settings: Object.assign({ displayName: 'Me', clientId: 'c-this-machine' }, settings || {})
    });
    out.lounge.app.notify.mockClear();
    out.chime = vi.spyOn(window.loungeSounds, 'playMessage').mockImplementation(() => {});
    return out;
}

describe('a message in a channel I am not reading', () => {
    it('plays the app chime, not just a desktop toast', async () => {
        const { rt, chime, lounge } = await bootWithChime();

        rt(nudge());
        await settle(4);

        expect(chime).toHaveBeenCalledTimes(1);
        expect(lounge.app.notify).toHaveBeenCalledTimes(1);
    });

    it('still chimes when desktop notifications are switched off', async () => {
        // That switch is about toasts. Turning it off is not a request for the
        // app to go silent — the sound has its own settings, which sounds.js
        // reads for itself.
        const { rt, chime, lounge } = await bootWithChime({ notifications: false });

        rt(nudge());
        await settle(4);

        expect(chime).toHaveBeenCalledTimes(1);
        expect(lounge.app.notify).not.toHaveBeenCalled();
    });

    it('stays silent for a muted channel', async () => {
        const { rt, chime, lounge } = await bootWithChime({ mutedChannels: ['random'] });

        rt(nudge());
        await settle(4);

        expect(chime).not.toHaveBeenCalled();
        expect(lounge.app.notify).not.toHaveBeenCalled();
    });

    it('stays silent for my own message from another device', async () => {
        const { rt, chime } = await bootWithChime();

        rt(nudge({ name: 'Me' }));
        await settle(4);

        expect(chime).not.toHaveBeenCalled();
    });
});

// The other half, and the reason the chime above is audible at all: if the
// toast still carried a sound, Windows would play its stock ding over the top.
describe('the desktop toast', () => {
    const src = fs.readFileSync(MAIN, 'utf8');
    const notify = src.slice(src.indexOf("handle('app:notify'"));
    const body = notify.slice(0, notify.indexOf('});'));

    it('is always raised silent', () => {
        expect(body).toMatch(/silent:\s*true/);
    });

    it('never asks Windows for a sound based on the chime setting', () => {
        // The regression, exactly as it was written: `silent: !notificationSound`
        // means "chime on -> let the OS make its own noise too".
        expect(body).not.toMatch(/silent:\s*!/);
        expect(body).not.toMatch(/notificationSound/);
    });
});
