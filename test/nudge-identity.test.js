// @vitest-environment jsdom
//
// The other half of own-message-identity.test.js.
//
// That spec pins the messages the POLL brings back: a row carrying my account
// id is silent whichever install stamped it (wroteByMe). The realtime nudge for
// a channel you are not looking at goes down a different path and had never
// been given the same treatment — it carries no account id at all, only the
// sender's install id and their name, and the guard on it was
// `m.cid !== settings.clientId`.
//
// A client_id is per-install, so that answers "not you" for everything you post
// from the phone or the website. The desktop, sitting in the tray, then popped a
// notification for a message its owner had just finished typing somewhere else,
// with their own name on it.
//
// The name is what answers it here, and it is safe to resolve on for the same
// reason renderTyping() already does: the display name IS the account username,
// derived by the server from the credential rather than accepted from the
// client, so nobody else can be wearing it.
import { describe, it, expect, vi } from 'vitest';
import { bootRenderer, settle } from './helpers/renderer.js';

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

// A post landing in a channel that is NOT on screen, which is the only case
// that notifies from the socket.
const nudge = (over) => Object.assign({ t: 'posted', channel: 'random', cid: 'c-elsewhere' }, over);

describe('a realtime nudge about my own message', () => {
    it('does not notify when I sent it from another device', async () => {
        const { lounge, rt } = await bootRenderer({
            user: ME, board: board(), settings: { displayName: 'Me', clientId: 'c-this-machine' }
        });
        lounge.app.notify.mockClear();

        // My account, a different install — exactly what the phone or the web
        // board publishes.
        rt(nudge({ name: 'Me' }));
        await settle(4);

        expect(lounge.app.notify).not.toHaveBeenCalled();
    });

    it('still notifies for somebody else', async () => {
        const { lounge, rt } = await bootRenderer({
            user: ME, board: board(), settings: { displayName: 'Me', clientId: 'c-this-machine' }
        });
        lounge.app.notify.mockClear();

        rt(nudge({ name: 'Alice' }));
        await settle(4);

        expect(lounge.app.notify).toHaveBeenCalledTimes(1);
        expect(lounge.app.notify.mock.calls[0][0].title).toBe('#random');
    });

    it('still notifies when the nudge carries no name at all', async () => {
        // An older server, or a build that never sent one. The install check is
        // all that is left, and it must keep working on its own.
        const { lounge, rt } = await bootRenderer({
            user: ME, board: board(), settings: { displayName: 'Me', clientId: 'c-this-machine' }
        });
        lounge.app.notify.mockClear();

        rt(nudge({}));
        await settle(4);

        expect(lounge.app.notify).toHaveBeenCalledTimes(1);
    });
});
