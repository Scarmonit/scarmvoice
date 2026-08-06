// @vitest-environment jsdom
//
// The two marks on the rail, and which of them a message is allowed to light.
//
// The rail is TWO PLACES. The @ button is where conversations live; the server
// icon is where channels do. Each badge names the place under it, so a message
// belongs to exactly one of them — which is also how the reference behaves: a
// direct message badges the button that opens direct messages, and a server
// icon carries only what happened inside that server.
//
// The DM count used to be added to both, so one message from one person put a
// red 1 on the @ AND a red 1 on ScarmVoice — for a server in which nothing had
// been posted. Clicking through to find out what it wanted showed a channel
// list with nothing unread in it, and the mark stayed up until the conversation
// was read.
//
// The TASKBAR badge is the one total that still counts everything: it answers
// "is there anything here for me" for a window with no rail on screen at all.
import { describe, it, expect, vi } from 'vitest';
import { bootRenderer, settle, $ } from './helpers/renderer.js';

const ME = { id: 1, username: 'Me', role: 'member' };
const THEM = { id: 2, username: 'Alice', role: 'member' };

const dmThread = (unread) => ({
    id: 40, title: 'Alice', isGroup: false, user: THEM, members: [ME, THEM], unread
});

// `channels` are what the server reports; the OPEN channel always reads as 0,
// so anything unread has to live in another one.
function boot({ channelUnread = 0, dmUnread = 0 } = {}) {
    return bootRenderer({
        board: vi.fn(async (p) => {
            if (p === 'list') return { success: true, posts: [], typing: [], voice: [], hasMore: false };
            if (p === 'channels') {
                return {
                    success: true,
                    channels: [
                        { name: 'general', unread: 0 },
                        { name: 'random', unread: channelUnread }
                    ]
                };
            }
            if (p === 'presence') return { success: true, members: [] };
            if (p === 'dm/threads') {
                return { success: true, threads: dmUnread ? [dmThread(dmUnread)] : [] };
            }
            return { success: true };
        })
    });
}

const serverBadge = () => $('rail-badge');
const dmBadge = () => $('rail-dm-badge');
// What main was last told to draw on the Windows taskbar button.
const taskbar = (app) => {
    const calls = app.lounge.app.setBadge.mock.calls;
    return calls.length ? calls[calls.length - 1][0] : null;
};

describe('a direct message and nothing else', () => {
    it('marks the button that opens it', async () => {
        await boot({ dmUnread: 1 });
        await settle();
        expect(dmBadge().hidden).toBe(false);
        expect(dmBadge().textContent).toBe('1');
    });

    it('leaves the server icon alone', async () => {
        await boot({ dmUnread: 1 });
        await settle();
        expect(serverBadge().hidden).toBe(true);
    });

    // The window can be minimised or in the tray, where there is no rail to
    // divide — so the taskbar's one number still counts it.
    it('still reaches the taskbar', async () => {
        const app = await boot({ dmUnread: 1 });
        await settle();
        expect(taskbar(app)).toBe(1);
    });
});

describe('an unread channel and nothing else', () => {
    it('marks the server icon', async () => {
        await boot({ channelUnread: 2 });
        await settle();
        expect(serverBadge().hidden).toBe(false);
        expect(serverBadge().textContent).toBe('2');
    });

    it('leaves the conversations button alone', async () => {
        await boot({ channelUnread: 2 });
        await settle();
        expect(dmBadge().hidden).toBe(true);
    });
});

describe('both at once', () => {
    it('gives each mark only what belongs to it', async () => {
        await boot({ channelUnread: 2, dmUnread: 3 });
        await settle();
        expect(serverBadge().textContent).toBe('2');
        expect(dmBadge().textContent).toBe('3');
    });

    it('adds them up for the taskbar, which has one number for the lot', async () => {
        const app = await boot({ channelUnread: 2, dmUnread: 3 });
        await settle();
        expect(taskbar(app)).toBe(5);
    });
});

describe('nothing unread anywhere', () => {
    it('draws neither mark', async () => {
        await boot({});
        await settle();
        expect(serverBadge().hidden).toBe(true);
        expect(dmBadge().hidden).toBe(true);
    });
});
