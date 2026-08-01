// @vitest-environment jsdom
//
// Compact message display, in all THREE lists that draw .msg rows.
//
// The setting has one meaning — "a timestamp and a name on every line" — and it
// is delivered by two halves that have to agree:
//
//   • the stylesheet hides the gutter (the avatar, and the hover timestamp a
//     GROUPED row keeps there), and lays the head out inline;
//   • the renderer stops grouping, because a grouped row has no .msg-head at
//     all — so with the gutter gone it would have nothing identifying it.
//
// renderMessages() has both. The conversation column and the thread drawer had
// neither and one respectively, which is two separate bugs with one symptom:
//
//   • #dm-messages has carried `.compact` since a direct message became the
//     same row as a channel post — applyDensity()'s own comment says it is
//     there to stop the conversation staying cozy while the channel goes
//     compact — and the stylesheet never named it, so Compact did nothing at
//     all in direct messages.
//   • #thread-list IS styled for compact, and grouped anyway. Its gutter is
//     display:none, so a run of replies from one person drew as naked text
//     with no author and no time on any line but the first.
//
// Neither is visible to a test that only looks at #messages, and neither is
// visible in jsdom's layout (it has none) — so this asks the two things that
// ARE observable: which rows the renderer grouped, and whether the stylesheet
// names the list at all.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootRenderer, settle, $ } from './helpers/renderer.js';

const RENDERER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');

const ME = { id: 1, username: 'Me', role: 'member' };
const ALICE = { id: 2, username: 'Alice', role: 'member' };

const THREAD = { id: 40, title: 'Alice', isGroup: false, user: ALICE, members: [ME, ALICE], unread: 0 };

// Two messages from ONE person a minute apart, in each of the three lists.
// That is exactly what the grouping rule matches (same author, under five
// minutes, no quote), so a list that groups produces one .grouped row and a
// list that does not produces none.
const post = (id, ms) => ({
    id, body: 'line ' + id, name: 'Alice', client_id: 'alice', user_id: ALICE.id,
    created_at: 1700000000000 + ms, reactions: [], pinned: 0, reply_count: 0
});
// The root carries a reply count so the chip that opens the drawer is drawn,
// and sits ten minutes after the pair above it so it does NOT join their group
// — one grouped row in the channel, whichever way the drawer behaves.
const ROOT = Object.assign(post(21, 600000), { reply_count: 2 });
const CHANNEL_POSTS = [post(11, 0), post(12, 60000), ROOT];
const THREAD_POSTS = [ROOT, post(22, 660000), post(23, 720000)];
const DM_MESSAGES = [
    { id: 31, from: ALICE.id, body: 'first', created_at: 1700000000000 },
    { id: 32, from: ALICE.id, body: 'second', created_at: 1700000060000 }
];

const board = vi.fn(async (p) => {
    if (p === 'list') {
        return {
            success: true, posts: CHANNEL_POSTS,
            typing: [], voice: [], hasMore: false, maxId: 21
        };
    }
    if (p === 'thread') return { success: true, posts: THREAD_POSTS };
    if (p === 'dm/threads') return { success: true, threads: [THREAD] };
    if (p === 'dm/list') return { success: true, thread: THREAD, messages: DM_MESSAGES };
    if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
    if (p === 'presence') return { success: true, members: [] };
    return { success: true };
});

// What a row says about itself, kept rather than held by reference: the three
// lists cannot all be on screen at once — a CHANNEL thread's drawer belongs to
// the column behind #dm-panel, so openThread() closes the conversation and
// openDm() closes the drawer — so each is read while it is the one painted.
const snapshot = (id) => [...$(id).querySelectorAll('.msg')].map((r) => ({
    grouped: r.classList.contains('grouped'),
    named: !!r.querySelector('.msg-author'),
    timed: !!r.querySelector('.msg-time')
}));

async function paintAll(density) {
    await bootRenderer({ board, user: ME, settings: { density } });
    // The conversation first, and read before the drawer replaces it.
    $('dm-list').querySelector('.dm-row').click();
    await settle();
    const dm = snapshot('dm-messages');
    document.querySelector(`.msg[data-id="${ROOT.id}"] .msg-thread`).click();
    await settle();
    return { channel: snapshot('messages'), thread: snapshot('thread-list'), dm };
}

const groupedCount = (list) => list.filter((r) => r.grouped).length;

// What compact promises, asked of the DOM rather than of the layout: every row
// carries its own author and its own timestamp.
function expectEveryRowNamed(list, where) {
    expect(list.length, where + ' drew no messages').toBeGreaterThan(1);
    list.forEach((row, i) => {
        expect(row.named, `${where}: row ${i} has no author`).toBe(true);
        expect(row.timed, `${where}: row ${i} has no timestamp`).toBe(true);
    });
}

describe('cozy — the control', () => {
    let painted;
    beforeAll(async () => { painted = await paintAll('cozy'); });

    it('groups consecutive messages in all three lists', () => {
        expect(groupedCount(painted.channel)).toBe(1);
        expect(groupedCount(painted.thread)).toBe(2);
        expect(groupedCount(painted.dm)).toBe(1);
    });
});

describe('compact — a name and a time on every line', () => {
    let painted;
    beforeAll(async () => { painted = await paintAll('compact'); });

    it('marks all three lists, so the stylesheet can reach them', () => {
        expect($('messages').classList.contains('compact')).toBe(true);
        expect($('thread-list').classList.contains('compact')).toBe(true);
        expect($('dm-messages').classList.contains('compact')).toBe(true);
    });

    it('groups nothing in the channel column', () => {
        expect(groupedCount(painted.channel)).toBe(0);
        expectEveryRowNamed(painted.channel, 'messages');
    });

    it('groups nothing in the thread drawer', () => {
        expect(groupedCount(painted.thread)).toBe(0);
        expectEveryRowNamed(painted.thread, 'thread-list');
    });

    it('groups nothing in the conversation column', () => {
        expect(groupedCount(painted.dm)).toBe(0);
        expectEveryRowNamed(painted.dm, 'dm-messages');
    });
});

// The gesture somebody actually performs: the setting is flipped while the
// thing it changes is ON SCREEN. That is a different code path from booting
// into a density — applyDensity() toggles the class, and only the channel
// column has a caller that repaints it afterwards. The other two rebuild
// wholesale from a poll that returns early on an unchanged payload, so left to
// themselves they keep the grouping they were drawn with while wearing the new
// class: rows with the gutter hidden and no .msg-head to replace it.
describe('flipping the setting with the lists already open', () => {
    async function flipToCompact() {
        const box = document.querySelector('input[name="set-msgdisplay"][value="compact"]');
        box.checked = true;
        box.dispatchEvent(new window.Event('change', { bubbles: true }));
        await settle();
    }

    it('regroups the conversation column at once', async () => {
        await bootRenderer({ board, user: ME, settings: { density: 'cozy' } });
        $('dm-list').querySelector('.dm-row').click();
        await settle();
        expect(groupedCount(snapshot('dm-messages'))).toBe(1);   // as drawn, cozy

        await flipToCompact();
        const after = snapshot('dm-messages');
        expect(groupedCount(after)).toBe(0);
        expectEveryRowNamed(after, 'dm-messages');
    });

    it('regroups the thread drawer at once', async () => {
        await bootRenderer({ board, user: ME, settings: { density: 'cozy' } });
        document.querySelector(`.msg[data-id="${ROOT.id}"] .msg-thread`).click();
        await settle();
        expect(groupedCount(snapshot('thread-list'))).toBe(2);   // as drawn, cozy

        await flipToCompact();
        const after = snapshot('thread-list');
        expect(groupedCount(after)).toBe(0);
        expectEveryRowNamed(after, 'thread-list');
    });
});

describe('the stylesheet names every list that carries the class', () => {
    let rules = '';
    beforeAll(() => {
        rules = fs.readFileSync(path.join(RENDERER, 'styles.css'), 'utf8')
            .replace(/\r\n/g, '\n')
            // Comments out: this block's own prose quotes the selectors it is
            // about, so a rule matched against the raw text would be satisfied
            // by an explanation of the bug rather than by the fix.
            .replace(/\/\*[\s\S]*?\*\//g, ' ');
    });

    // The gutter rule is the one that makes compact compact: it is what removes
    // the avatar, and it is the reason nothing may group. A list carrying the
    // class with no rule behind it is the whole of the DM bug.
    it('hides the gutter in the conversation column as well', () => {
        expect(rules).toMatch(/#dm-messages\.compact\s+\.msg-gutter/);
    });

    // Every property compact sets on the channel column has to reach the other
    // two, or the conversation half-compacts — which is harder to notice than
    // not compacting at all.
    it('applies the same declarations to all three lists', () => {
        const parts = ['.msg', '.msg-gutter', '.msg-head', '.msg-time', '.msg-text', '.msg-quote'];
        parts.forEach((sel) => {
            const esc = sel.replace(/[.]/g, '\\.');
            ['#messages', '#thread-list', '#dm-messages'].forEach((list) => {
                expect(rules, `${list}.compact ${sel} is missing`)
                    .toMatch(new RegExp(list + '\\.compact\\s+' + esc + '[\\s,{]'));
            });
        });
    });

    // The drawer has no day separators; the two lists that draw them both need
    // the tightened spacing.
    it('tightens the day separator in both lists that have one', () => {
        expect(rules).toMatch(/#messages\.compact\s+\.day-sep/);
        expect(rules).toMatch(/#dm-messages\.compact\s+\.day-sep/);
    });
});
