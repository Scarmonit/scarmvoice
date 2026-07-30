// @vitest-environment jsdom
//
// The header's Threads button and its popout.
//
// The app has had threads since v0.4.0 — they hang off a message and open in a
// drawer — but there was no way to see what threads a channel HAD. This is the
// reference's panel for that: a title, a search box, Create, and either the list
// or an empty state.
//
// Two things in it are worth pinning:
//
//   * the list comes from /api/board/threads, not from the loaded page. Both
//     clients can half-derive it locally (a root carries reply_count), but only
//     for the page they happen to hold — so a thread nobody had scrolled back to
//     was missing from a panel whose whole claim is to list them all. The local
//     derivation survives as the OFFLINE fallback, and that path is tested too.
//   * Create is ADAPTED rather than copied. A thread here needs a message to hang
//     off, so Create asks for the opening message and posts it — real, rather
//     than a button that cannot do anything.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { bootRenderer, $, settle } from './helpers/renderer.js';

const ROOT = {
    id: 5, body: 'the beans thread\nsecond line', name: 'Alice', client_id: 'alice',
    user_id: 2, created_at: 1700000000000, reactions: [], pinned: 0,
    channel: 'general', reply_count: 3, last_reply_at: 1700000900000
};
const PLAIN = {
    id: 6, body: 'no replies here', name: 'Bob', client_id: 'bob', user_id: 3,
    created_at: 1700000100000, reactions: [], pinned: 0, channel: 'general', reply_count: 0
};

// What /api/board/threads answers with. `null` stands for an endpoint that is not
// there (an older server) or a request that failed.
let served = [
    { id: 5, name: 'Alice', user_id: 2, title: 'the beans thread', reply_count: 3, last_reply_at: 1700000900000 },
    { id: 9, name: 'Bob', user_id: 3, title: 'another conversation', reply_count: 1, last_reply_at: 1700000500000 }
];
let posted = null;

function router() {
    return vi.fn(async (p, opts) => {
        if (p === 'list') {
            return { success: true, posts: [ROOT, PLAIN], typing: [], voice: [], hasMore: false, maxId: 6 };
        }
        if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
        if (p === 'presence') return { success: true, members: [] };
        if (p === 'dm/threads') return { success: true, threads: [] };
        if (p === 'pins') return { success: true, pins: [] };
        if (p === 'thread') return { success: true, root: 5, posts: [ROOT] };
        if (p === 'threads') {
            if (served === null) return { success: false, network: true };
            return { success: true, channel: 'general', threads: served };
        }
        if (p === 'post') { posted = opts && opts.body; return { success: true, id: 77 }; }
        return { success: true };
    });
}

const popup = () => $('threads-pop');
const rows = () => Array.from($('threads-body').querySelectorAll('.tp-item'));
const names = () => rows().map((r) => r.querySelector('.tp-item-name').textContent);
const empty = () => $('threads-body').querySelector('.tp-empty');

let h;
beforeAll(async () => {
    localStorage.clear();
    h = await bootRenderer({ board: router() });
    await settle();
});

beforeEach(async () => {
    posted = null;
    served = [
        { id: 5, name: 'Alice', user_id: 2, title: 'the beans thread', reply_count: 3, last_reply_at: 1700000900000 },
        { id: 9, name: 'Bob', user_id: 3, title: 'another conversation', reply_count: 1, last_reply_at: 1700000500000 }
    ];
    while (!popup().hidden) {
        document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await settle();
    }
});

async function open() {
    $('btn-threads').click();
    await settle();
}

describe('the button', () => {
    it('sits to the left of the bell in the header', () => {
        const ids = Array.from(document.querySelectorAll('.chan-actions button')).map((b) => b.id);
        expect(ids.indexOf('btn-threads')).toBeLessThan(ids.indexOf('btn-chan-alerts'));
    });

    it('opens and closes the panel', async () => {
        expect(popup().hidden).toBe(true);
        await open();
        expect(popup().hidden).toBe(false);
        expect($('btn-threads').getAttribute('aria-expanded')).toBe('true');
        await open();
        expect(popup().hidden).toBe(true);
    });

    it('closes on Escape and on a click outside', async () => {
        await open();
        document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await settle();
        expect(popup().hidden).toBe(true);

        await open();
        $('messages').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
        await settle();
        expect(popup().hidden).toBe(true);
    });
});

describe('the list', () => {
    it('lists what the server returned, most recently active first', async () => {
        await open();
        expect(names()).toEqual(['the beans thread', 'another conversation']);
        // The reply count and the author, which is what makes a row worth reading.
        expect(rows()[0].querySelector('.tp-item-meta').textContent).toContain('Alice');
        expect(rows()[0].querySelector('.tp-item-meta').textContent).toContain('3 replies');
        expect(rows()[1].querySelector('.tp-item-meta').textContent).toContain('1 reply');
    });

    it('asks the server for the whole channel, not the loaded page', async () => {
        await open();
        expect(h.board).toHaveBeenCalledWith('threads', { query: { channel: 'general' } });
        // id 9 is not in the loaded page at all, which is the point.
        expect(names()).toContain('another conversation');
    });

    it('opens the thread drawer on a row, and closes the panel', async () => {
        await open();
        rows()[0].click();
        await settle();
        expect(popup().hidden).toBe(true);
        expect($('thread-panel').hidden).toBe(false);
    });

    it('filters by name as you type', async () => {
        await open();
        $('threads-search').value = 'beans';
        $('threads-search').dispatchEvent(new window.Event('input', { bubbles: true }));
        await settle();
        expect(names()).toEqual(['the beans thread']);
    });

    it('says nothing matched, without offering to create one called that', async () => {
        await open();
        $('threads-search').value = 'zzzz';
        $('threads-search').dispatchEvent(new window.Event('input', { bubbles: true }));
        await settle();
        expect(empty().textContent).toContain('No threads found');
        // "Create Thread" here would read as "create one called zzzz".
        expect(empty().querySelector('.tp-create')).toBe(null);
    });

    it('falls back to the loaded page when the endpoint is unreachable', async () => {
        served = null;
        await open();
        // ROOT has replies and PLAIN does not, so only one of them is a thread.
        expect(names()).toEqual(['the beans thread']);
    });
});

describe('the empty state', () => {
    it('matches the reference, and offers Create Thread', async () => {
        served = [];
        await open();
        expect(empty().querySelector('.tp-empty-title').textContent).toBe('There are no threads.');
        expect(empty().textContent).toContain('Stay focused on a conversation with a thread');
        expect(empty().querySelector('.tp-create').textContent).toBe('Create Thread');
        expect(rows()).toHaveLength(0);
    });
});

describe('Create', () => {
    it('asks for the opening message, posts it, and opens its thread', async () => {
        await open();
        $('threads-create').click();
        await settle();

        // A thread hangs off a message here, so this says so rather than asking
        // for a bare name it could not use.
        expect($('dialog').hidden).toBe(false);
        expect($('dialog-msg').textContent).toContain('hangs off a message');

        $('dialog-input').value = 'a brand new thread';
        $('dialog-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
        await settle(20);

        expect(posted).toBeTruthy();
        expect(posted.body).toBe('a brand new thread');
        expect(posted.channel).toBe('general');
        expect(popup().hidden).toBe(true);
        expect($('thread-panel').hidden).toBe(false);
    });

    it('does nothing if the dialog is cancelled', async () => {
        await open();
        $('threads-create').click();
        await settle();
        $('dialog-cancel').click();
        await settle(20);
        expect(posted).toBe(null);
    });
});
