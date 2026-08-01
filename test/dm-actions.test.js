// @vitest-environment jsdom
//
// What you can DO to a message inside a conversation, as opposed to inside a
// channel. Boots the real renderer signed in, opens a DM from the sidebar, and
// drives the resulting rows.
//
// THE POINT OF THIS FILE IS THAT THE TWO ANSWERS ARE THE SAME ANSWER.
//
// A DM is drawn with the CHANNEL message component, which is what gives it
// grouping, attachments and embeds for nothing. For a long time it also
// inherited a set of actions with no DM backing — react, reply, threads and
// pins all read and wrote the `posts` table — so the hover bar dropped the four
// of them and the right-click menu went on offering them one click away,
// answering "Not found". The fix was not to hide them in both places: it was to
// give dm_messages the columns and the endpoints (dm/react, dm/pin,
// dm/replies, reply_root_id, quote_id) that make all four real, so one
// component can offer one set of actions wherever it is drawn.
//
// So every test below that names an action asserts it is present in BOTH
// places, and the control block at the bottom is what catches the two drifting
// apart again. The one deliberate exception is moderation, which a private
// conversation does not have — see the last test.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RENDERER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');

const noop = () => {};
const unsub = () => noop;
const $ = (id) => document.getElementById(id);

const ME = { id: 1, username: 'Me', role: 'member' };
const THEM = { id: 2, username: 'Alice', role: 'member' };

const THREAD = {
    id: 40, title: 'Alice', isGroup: false,
    user: THEM, members: [ME, THEM], unread: 0
};

// One text message from them, one image attachment from me. Shaped the way
// /api/board/dm/list returns them now: the same decorations a channel post
// carries — pinned, reactions, reply counts — because that is what lets one
// renderer draw either.
const DM_MESSAGES = [
    {
        id: 501, from: THEM.id, body: 'have a look at this', created_at: 1700000000000,
        pinned: 0, reactions: [{ emoji: '👍', count: 1, who: ['dm-user-2'], users: [THEM.id] }],
        reply_count: 2, last_reply_at: 1700000090000
    },
    {
        id: 502, from: ME.id, body: '', created_at: 1700000060000,
        att_key: 'r2/pic.png', att_name: 'pic.png', att_type: 'image/png', att_size: 2048,
        pinned: 1, reactions: [], reply_count: 0
    }
];

// A channel message, as the control: everything dropped from the DM menu below
// has to still be on this one.
const POST = {
    id: 7, body: 'hello', name: 'Alice', client_id: 'alice', user_id: THEM.id,
    created_at: 1700000000000, reactions: [], pinned: 0
};
// …and one of MY OWN in the same channel. Pinning is admin-or-owner server-side
// (pin.js via mayModifyPost), so the two rows answer differently and the menu has
// to as well — see the pin tests below.
const MY_POST = {
    id: 8, body: 'mine', name: 'Me', client_id: 'me', user_id: ME.id,
    created_at: 1700000030000, reactions: [], pinned: 0
};

// Routes by path the way main.js's board bridge does, so the renderer's own
// call sites decide what it sees.
const board = vi.fn(async (p) => {
    if (p === 'dm/threads') return { success: true, threads: [THREAD] };
    if (p === 'dm/list') {
        return { success: true, thread: THREAD, messages: DM_MESSAGES };
    }
    if (p === 'dm/pins') return { success: true, thread: THREAD.id, pins: [] };
    if (p === 'dm/reply-threads') return { success: true, thread: THREAD.id, threads: [] };
    if (p === 'dm/replies') return { success: true, root: 501, thread: THREAD.id, posts: [DM_MESSAGES[0]] };
    if (p === 'list') {
        return { success: true, posts: [POST, MY_POST], typing: [], voice: [], hasMore: false, maxId: 8 };
    }
    if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
    // The roster knows which install belongs to which account. Block is
    // install-scoped, so this is what lets a conversation offer it at all —
    // see blockTargetFor.
    if (p === 'presence') {
        return { success: true, members: [{ client_id: 'alice', user_id: THEM.id, name: 'Alice', status: 'online' }] };
    }
    return { success: true };
});

const rowFor = (box, id) => box.querySelector(`.msg[data-id="${id}"]`);
const menuLabels = () =>
    Array.from($('ctx-menu').querySelectorAll('.ctx-label')).map((s) => s.textContent);

function rightClick(el) {
    el.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
}

async function settle(n = 12) {
    for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeAll(async () => {
    const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
    document.documentElement.innerHTML = html
        .replace(/<script[\s\S]*?<\/script>/g, '')
        .replace(/^[\s\S]*?<body>/, '<head></head><body>')
        .replace(/<\/body>[\s\S]*$/, '</body>');

    window.lounge = {
        auth: {
            status: vi.fn(async () => ({ authed: true })),
            login: vi.fn(async () => ({ success: true })), logout: noop
        },
        account: {
            register: vi.fn(async () => ({ success: false })),
            login: vi.fn(async () => ({ success: false })),
            logout: vi.fn(async () => ({ success: true })),
            verify: vi.fn(async () => ({ success: false })),
            resend: vi.fn(async () => ({ success: false })),
            removal: vi.fn(async () => ({ success: false })),
            me: vi.fn(async () => ({ success: true, user: ME }))
        },
        board,
        uploadFile: vi.fn(async () => ({ success: true })),
        uploadAttachment: vi.fn(async () => ({ success: true })),
        onUploadProgress: unsub,
        pathForFile: () => '',
        saveAttachment: vi.fn(async () => ({ success: true, path: 'C:/x/pic.png' })),
        downloadAttachment: vi.fn(async () => ({ success: true, path: 'C:/x/pic.png' })),
        copyImage: vi.fn(async () => ({ success: true })),
        revealFile: noop,
        unfurl: vi.fn(async () => null),
        youtube: vi.fn(async () => null),
        fetchImage: vi.fn(async () => ({ success: false })),
        share: { sources: vi.fn(async () => []), select: noop, cancel: noop },
        voiceToken: vi.fn(async () => ({ success: false })),
        rt: {
            start: vi.fn(async () => ({ connected: false })),
            stop: vi.fn(async () => ({ connected: false })),
            wake: vi.fn(async () => ({ connected: false })),
            send: noop, notifyPosted: noop,
            sendTyping: vi.fn(), sendVoice: noop,
            onMessage: unsub, onStatus: unsub
        },
        edit: {
            cut: noop, copy: noop, paste: noop, selectAll: noop,
            clipboard: vi.fn(async () => ({ text: false, image: false })),
            // The editable-field context menu is opened by main now, not by a DOM
            // handler here — see main.js's context-menu listener.
            onContext: unsub,
            replaceMisspelling: vi.fn(async () => true),
            addToDictionary: vi.fn(async () => true)
        },
        settings: {
            get: vi.fn(async () => ({
                baseUrl: 'https://scarmonit.com', room: 'lounge', clientId: 'me',
                displayName: 'Me', channel: 'general', theme: 'dark', density: 'cozy',
                chatFontSize: 'medium', showMembers: true, catTextOpen: true,
                catDmsOpen: true, catVoiceOpen: true,
                localVolumes: {}, localMuted: {}, blocked: {}, mutedChannels: [],
                voiceMode: 'open', pttBinding: { type: 'key', code: 'Backquote' }
            })),
            set: vi.fn(async (p) => p)
        },
        ptt: {
            apply: vi.fn(async () => ({ mode: 'native' })),
            available: vi.fn(async () => true),
            describe: vi.fn(async () => 'Backquote'), onChange: unsub
        },
        win: {
            minimize: noop, maximize: noop, close: noop,
            isFocused: vi.fn(async () => true), onFocus: unsub, onHidden: unsub
        },
        app: {
            version: vi.fn(async () => '0.0.0-test'), isElevated: vi.fn(async () => false),
            openLogs: vi.fn(async () => true), notify: vi.fn(async () => false),
            setVoiceState: vi.fn(async () => ({})), setBadge: vi.fn(async () => true),
            openExternal: vi.fn(async () => true), systemTheme: vi.fn(async () => ({ dark: true })),
            setTheme: vi.fn(async () => true), onThemeChange: unsub, onCommand: unsub, onResync: unsub
        },
        startup: {
            get: vi.fn(async () => ({ openAtLogin: false, openAsHidden: false })),
            set: vi.fn(async () => ({ openAtLogin: false, openAsHidden: false }))
        },
        update: {
            getState: vi.fn(async () => ({ status: 'idle', noteBlocks: [] })),
            check: noop, download: noop, install: noop, setAuto: noop,
            postpone: noop, onState: unsub
        },
        fileUrl: (k) => 'lounge://file/' + encodeURIComponent(k)
    };

    window.hljs = { highlightElement: noop };
    window.HTMLMediaElement.prototype.play = () => Promise.resolve();
    window.matchMedia = window.matchMedia ||
        (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || noop;
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 404 }));
    globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((f) => setTimeout(f, 0));

    const run = (f) => new Function(fs.readFileSync(path.join(RENDERER, f), 'utf8')).call(window);
    run('lib.js');
    run('audio.js');
    run('noise.js');
    run('sounds.js');
    run('icons.js');
    // Voice is not what this file is about; stand in for it.
    window.createVoice = () => ({
        join: async () => {}, leave: noop, roster: () => [], shares: () => [],
        state: () => ({ joined: false, shareQuality: '1080p', shareMotion: 'sharp' }),
        setSettings: noop, setMuted: noop, setDeafened: noop, setPttHeld: noop,
        setLocalVolume: noop, setLocalMuted: noop,
        setShareQuality: noop, setShareMotion: noop,
        startShare: async () => false, stopShare: noop, isSharing: () => false,
        enableCam: async () => false, disableCam: async () => false,
        isCamOn: () => false, toggleCam: noop, cams: () => [],
        isJoined: () => false, isMuted: () => false, isDeafened: () => false
    });
    run('app.js');

    await settle();
    // Open the conversation the way a person does — from its row in the list.
    const row = $('dm-list').querySelector('.dm-row');
    expect(row).toBeTruthy();
    row.click();
    await settle();
});

describe('a message inside a conversation', () => {
    it('renders with the channel component, attachment and all', () => {
        const box = $('dm-messages');
        expect(rowFor(box, 501)).toBeTruthy();
        const att = rowFor(box, 502);
        expect(att).toBeTruthy();
        expect(att.querySelector('img[data-lightbox]')).toBeTruthy();
        expect(att.querySelector('.att-save')).toBeTruthy();
    });

    it('opens an attached image in the lightbox', () => {
        // Delegated, not per-row: bound to #messages alone this did nothing at
        // all in a conversation, and the only way to see the picture larger was
        // the right-click menu.
        expect($('lightbox').hidden).toBe(true);
        rowFor($('dm-messages'), 502).querySelector('img[data-lightbox]').click();
        expect($('lightbox').hidden).toBe(false);
        $('lb-close').click();
        expect($('lightbox').hidden).toBe(true);
    });

    it('saves an attachment from the button under it', async () => {
        window.lounge.saveAttachment.mockClear();
        rowFor($('dm-messages'), 502).querySelector('.att-save').click();
        await settle();
        expect(window.lounge.saveAttachment).toHaveBeenCalledWith(
            'r2/pic.png', 'pic.png', undefined);
    });

    it('offers every message action a channel offers, on right-click', () => {
        rightClick(rowFor($('dm-messages'), 501));
        const labels = menuLabels();
        // The four that used to be dropped here because they read and wrote the
        // posts table. Each has a /api/board/dm/* endpoint behind it now.
        expect(labels).toContain('Reply');
        expect(labels).toContain('Reply in thread');
        expect(labels).toContain('React…');
        expect(labels).toContain('Pin');
        expect(labels).toContain('Copy text');
        // …and blocking, which used to be dropped because a DM row's client_id
        // is the synthetic 'dm-user-2'. blockTargetFor resolves the real install
        // off the roster instead.
        expect(labels.some((l) => l.startsWith('Block'))).toBe(true);
    });

    it('offers the same actions on the hover bar as the menu', () => {
        const row = rowFor($('dm-messages'), 501);
        expect(row.querySelector('[data-act="react"]')).not.toBeNull();
        expect(row.querySelector('[data-act="reply"]')).not.toBeNull();
        expect(row.querySelector('[data-act="pin"]')).not.toBeNull();
        expect(row.querySelector('[data-act="copy"]')).not.toBeNull();
    });

    it('says Unpin on a message that is already pinned', () => {
        rightClick(rowFor($('dm-messages'), 502));
        expect(menuLabels()).toContain('Unpin');
        expect(rowFor($('dm-messages'), 502).classList.contains('pinned')).toBe(true);
    });

    it('pins through the DM endpoint, not the channel one', async () => {
        board.mockClear();
        rowFor($('dm-messages'), 501).querySelector('[data-act="pin"]').click();
        await settle();
        const call = board.mock.calls.find((c) => c[0] === 'dm/pin');
        expect(call).toBeTruthy();
        expect(call[1].body).toMatchObject({ id: 501, pinned: true });
        // The channel endpoint would have been asked to update a post with that
        // id, and told — correctly — that there is no such thing.
        expect(board.mock.calls.some((c) => c[0] === 'pin')).toBe(false);
    });

    it('reacts through the DM endpoint, keyed by account', async () => {
        board.mockClear();
        // The existing reaction chip, which the shared renderer drew from the
        // payload — proof the summary shape survives the DM path.
        const chip = rowFor($('dm-messages'), 501).querySelector('.reaction');
        expect(chip).toBeTruthy();
        chip.click();
        await settle();
        const call = board.mock.calls.find((c) => c[0] === 'dm/react');
        expect(call).toBeTruthy();
        expect(call[1].body).toMatchObject({ id: 501, emoji: '👍' });
        expect(board.mock.calls.some((c) => c[0] === 'react')).toBe(false);
    });

    it('opens a thread on a DM message, in the same drawer', async () => {
        board.mockClear();
        // The reply-count chip the shared renderer draws from reply_count.
        const chip = rowFor($('dm-messages'), 501).querySelector('.msg-thread');
        expect(chip).toBeTruthy();
        chip.click();
        await settle();
        expect($('thread-panel').hidden).toBe(false);
        // Inside the conversation, not behind it — the drawer is MOVED rather
        // than duplicated, and living in #main it opened invisibly under the
        // DM panel.
        expect($('thread-panel').parentElement.id).toBe('dm-main');
        expect(board.mock.calls.some((c) => c[0] === 'dm/replies')).toBe(true);
        expect(board.mock.calls.some((c) => c[0] === 'thread')).toBe(false);
        $('thread-close').click();
        await settle();
        expect($('thread-panel').hidden).toBe(true);
    });

    it("puts the header's three buttons in the conversation header", () => {
        // The same element, moved. A copy would need copies of every listener
        // and would be missing a feature within a month — which is the bug this
        // whole change exists to remove.
        expect($('conv-actions').closest('#dm-head')).not.toBeNull();
        expect($('btn-pinned').closest('#dm-head')).not.toBeNull();
        expect($('btn-threads').closest('#dm-head')).not.toBeNull();
        expect($('btn-chan-alerts').closest('#dm-head')).not.toBeNull();
    });

    it('opens the pinned panel against the conversation', async () => {
        board.mockClear();
        $('btn-pinned').click();
        await settle();
        expect($('pinned-panel').hidden).toBe(false);
        const call = board.mock.calls.find((c) => c[0] === 'dm/pins');
        expect(call).toBeTruthy();
        expect(call[1].query).toMatchObject({ thread: THREAD.id });
        expect(board.mock.calls.some((c) => c[0] === 'pins')).toBe(false);
        $('btn-pinned').click();
        await settle();
    });

    it('opens the threads panel against the conversation', async () => {
        board.mockClear();
        $('btn-threads').click();
        await settle();
        expect($('threads-pop').hidden).toBe(false);
        const call = board.mock.calls.find((c) => c[0] === 'dm/reply-threads');
        expect(call).toBeTruthy();
        expect(call[1].query).toMatchObject({ thread: THREAD.id });
        expect(board.mock.calls.some((c) => c[0] === 'threads')).toBe(false);
        $('btn-threads').click();
        await settle();
    });

    it('opens notification settings for the conversation, not the channel behind it', () => {
        $('btn-chan-alerts').click();
        expect($('notif-pop').hidden).toBe(false);
        // Named for what it acts on. Silencing a conversation must not silence
        // #general, and the label is the only thing that says which it will do.
        expect($('np-mute-label').textContent).toContain('Conversation');
        $('btn-chan-alerts').click();
    });

    it('still offers what it always could', () => {
        // My own message: edit and delete both have a DM endpoint.
        rightClick(rowFor($('dm-messages'), 502));
        const mine = menuLabels();
        expect(mine).toContain('Edit message');
        expect(mine).toContain('Delete message');
        expect(mine).toContain('Save attachment…');
    });

    // The ONE thing a conversation deliberately does not inherit. Moderation is
    // a power over a shared space; two people talking privately is not one, and
    // a board admin able to rewrite what was said there would be a worse bug
    // than any missing button. dm/message.js enforces the same rule server-side.
    it('does not offer moderator edit or delete', () => {
        rightClick(rowFor($('dm-messages'), 501));
        const labels = menuLabels();
        expect(labels).not.toContain('Edit (moderator)');
        expect(labels).not.toContain('Delete (moderator)');
    });

    it('does not tell a channel you are typing in a conversation', async () => {
        // The composer is one element, moved into the DM. Typing in it used to
        // broadcast into whatever channel sat behind the drawer — to everyone
        // in that channel, over the socket and the HTTP fallback both.
        window.lounge.rt.sendTyping.mockClear();
        board.mockClear();
        const input = $('composer-input');
        input.value = 'typing at alice';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        await settle();
        expect(window.lounge.rt.sendTyping).not.toHaveBeenCalled();
        expect(board.mock.calls.some((c) => c[0] === 'typing')).toBe(false);
    });
});

describe('the same message in a channel', () => {
    beforeAll(async () => {
        $('dm-close').click();
        // Back out of the DM view entirely, so the composer is the channel's.
        // The server mark, not the DM button — that one only ever goes TO DMs.
        $('rail-home').click();
        await settle();
    });

    it('offers exactly the same actions', () => {
        rightClick(rowFor($('messages'), 7));
        const labels = menuLabels();
        expect(labels).toContain('Reply');
        expect(labels).toContain('Reply in thread');
        expect(labels).toContain('React…');
        expect(labels).toContain('Copy text');
        expect(labels.some((l) => l.startsWith('Block'))).toBe(true);
    });

    it("takes the header's three buttons back with it", () => {
        expect($('conv-actions').closest('#chan-head')).not.toBeNull();
        expect($('btn-pinned').closest('#dm-head')).toBeNull();
    });

    // Pinning is admin-or-owner server-side, and the menu used to offer it on
    // every message to everybody: a member clicking it on somebody else's post got
    // "Only admins can pin other people's messages" from the server, every time.
    // An action that cannot succeed is not an action.
    it('does not offer a member Pin on somebody else\'s message', () => {
        rightClick(rowFor($('messages'), 7));
        expect(menuLabels()).not.toContain('Pin');
        expect(rowFor($('messages'), 7).querySelector('[data-act="pin"]')).toBeNull();
    });

    it('still offers Pin on your own message', () => {
        rightClick(rowFor($('messages'), 8));
        expect(menuLabels()).toContain('Pin');
        expect(rowFor($('messages'), 8).querySelector('[data-act="pin"]')).not.toBeNull();
    });

    it('announces typing again', async () => {
        window.lounge.rt.sendTyping.mockClear();
        const input = $('composer-input');
        input.value = 'typing in general';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        await settle();
        expect(window.lounge.rt.sendTyping).toHaveBeenCalledWith('general', false);
    });
});
