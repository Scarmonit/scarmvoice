// @vitest-environment jsdom
//
// What you can DO to a message inside a conversation, as opposed to inside a
// channel. Boots the real renderer signed in, opens a DM from the sidebar, and
// drives the resulting rows.
//
// Both halves of this exist because a DM is drawn with the CHANNEL message
// component — which is what gives it grouping, attachments and embeds for
// nothing, and is also how it inherits behaviour that has no DM backing:
//
//   • the actions the component's own hover bar drops for a DM were still on
//     the right-click menu, one click away, answering "Not found";
//   • the actions that are delegated rather than per-row (open the image, save
//     the attachment) were bound to #messages alone, so in a conversation they
//     were bound to nothing at all.
//
// Neither is visible to a test that only ever looks at a channel.
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

// One text message from them, one image attachment from me.
const DM_MESSAGES = [
    { id: 501, from: THEM.id, body: 'have a look at this', created_at: 1700000000000 },
    {
        id: 502, from: ME.id, body: '', created_at: 1700000060000,
        att_key: 'r2/pic.png', att_name: 'pic.png', att_type: 'image/png', att_size: 2048
    }
];

// A channel message, as the control: everything dropped from the DM menu below
// has to still be on this one.
const POST = {
    id: 7, body: 'hello', name: 'Alice', client_id: 'alice', user_id: THEM.id,
    created_at: 1700000000000, reactions: [], pinned: 0
};

// Routes by path the way main.js's board bridge does, so the renderer's own
// call sites decide what it sees.
const board = vi.fn(async (p) => {
    if (p === 'dm/threads') return { success: true, threads: [THREAD] };
    if (p === 'dm/list') {
        return { success: true, thread: THREAD, messages: DM_MESSAGES };
    }
    if (p === 'list') {
        return { success: true, posts: [POST], typing: [], voice: [], hasMore: false, maxId: 7 };
    }
    if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
    if (p === 'presence') return { success: true, members: [] };
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
            clipboard: vi.fn(async () => ({ text: false, image: false }))
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
            isFocused: vi.fn(async () => true), onFocus: unsub
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

    it('offers nothing on right-click that a DM has no backing for', () => {
        rightClick(rowFor($('dm-messages'), 501));
        const labels = menuLabels();
        // Every one of these reads or writes the posts table. The hover bar
        // already dropped them; the menu was still handing them out.
        expect(labels).not.toContain('Reply');
        expect(labels).not.toContain('Reply in thread');
        expect(labels).not.toContain('React…');
        expect(labels).not.toContain('Pin');
        expect(labels).not.toContain('Unpin');
        // …and blocking, which would have filed the synthetic 'dm-user-2' id
        // that nothing else in the app ever compares against.
        expect(labels.some((l) => l.startsWith('Block'))).toBe(false);
    });

    it('still offers what a DM really can do', () => {
        rightClick(rowFor($('dm-messages'), 501));
        expect(menuLabels()).toContain('Copy text');

        // My own message: edit and delete both have a DM endpoint.
        rightClick(rowFor($('dm-messages'), 502));
        const mine = menuLabels();
        expect(mine).toContain('Edit message');
        expect(mine).toContain('Delete message');
        expect(mine).toContain('Save attachment…');
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
        $('rail-dms').click();
        await settle();
    });

    it('keeps every action the conversation dropped', () => {
        rightClick(rowFor($('messages'), 7));
        const labels = menuLabels();
        expect(labels).toContain('Reply');
        expect(labels).toContain('Reply in thread');
        expect(labels).toContain('React…');
        expect(labels).toContain('Pin');
        expect(labels.some((l) => l.startsWith('Block'))).toBe(true);
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
