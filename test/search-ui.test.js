// @vitest-environment jsdom
//
// One search box, in the header, and a filters dropdown under it.
//
// It replaced a SECOND search UI — a row that dropped in under the channel
// header with its own input, its own scope toggle and its own filter menu.
// Two boxes filtering the same list in two different ways, neither aware of
// the other. The row is gone; these specs pin that it stays gone, because the
// easiest way to reintroduce it is to leave one handler pointing at it.
//
// The property that makes the rest work: the BOX IS THE STATE. Every row in
// the dropdown writes an operator into the string rather than setting a flag
// beside it, so clicking and typing produce the same thing by construction —
// which is the only way "typeable as well as selectable" can be true rather
// than merely claimed. The tests below check both routes reach the same place.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { bootRenderer, $, settle } from './helpers/renderer.js';

const NOW = 1700000000000;
const POSTS = [
    { id: 1, client_id: 'c1', user_id: 2, name: 'Parker', body: 'the logo http://example.com/a',
      created_at: NOW - 90000000, channel: 'general', reactions: [], reply_count: 0, pinned: 0 },
    { id: 2, client_id: 'c2', user_id: 3, name: 'XIAIX', body: 'hey @Me look at this',
      created_at: NOW - 80000, channel: 'general', reactions: [], reply_count: 0, pinned: 1 },
    { id: 3, client_id: 'me', user_id: 1, name: 'Me', body: 'sounds good to me',
      created_at: NOW - 4000, channel: 'general', reactions: [], reply_count: 0, pinned: 0 },
    // A day LATER than the others, and the only reason during:'s upper bound
    // can be tested at all — without something after that day, deleting the
    // bound changes no answer.
    { id: 4, client_id: 'c4', user_id: 4, name: 'Teebob', body: 'morning all',
      created_at: NOW + 90000000, channel: 'general', reactions: [], reply_count: 0, pinned: 0 }
];
const USERS = [
    { id: 1, username: 'Me', role: 'member' },
    { id: 2, username: 'Parker', role: 'member' },
    { id: 3, username: 'XIAIX', role: 'member' },
    { id: 4, username: 'Teebob', role: 'member' }
];

const box = () => $('search-input');
const pop = () => $('search-pop');
const popOpen = () => !pop().hidden;
const rowTitles = () => [...pop().querySelectorAll('.sp-title')].map((e) => e.textContent);
const rowNamed = (t) => [...pop().querySelectorAll('.sp-row')]
    .find((r) => (r.querySelector('.sp-title') || {}).textContent === t);
const shown = () => $('messages').querySelectorAll('.msg').length;

// Typing, as a person does it: the value changes and `input` fires, which is
// what the app listens for.
async function type(text) {
    box().value = text;
    box().setSelectionRange(text.length, text.length);
    box().dispatchEvent(new window.Event('input', { bubbles: true }));
    await settle(8);
}

async function focusBox() {
    box().dispatchEvent(new window.Event('focus'));
    await settle(4);
}

beforeAll(async () => {
    await bootRenderer({
        user: USERS[0],
        board: vi.fn(async (p) => {
            const key = String(p).split('?')[0];
            if (key === 'list') return { success: true, posts: POSTS, hasMore: false, typing: [], voice: [] };
            if (key === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }, { name: 'design', unread: 0 }] };
            if (key === 'account/users') return { success: true, users: USERS };
            if (key === 'presence') return { success: true, members: [] };
            if (key === 'dm/threads') return { success: true, threads: [] };
            if (key === 'search') return { success: true, results: [] };
            return { success: true };
        })
    });
    await settle(40);
});

describe('there is only one search', () => {
    it('has no filter row under the channel header any more', () => {
        // The whole point of the change. If this comes back, so does the class
        // of bug where two inputs disagree about what is being filtered.
        expect(document.getElementById('filter-bar')).toBeNull();
        expect(document.getElementById('filter-input')).toBeNull();
        expect(document.getElementById('filter-menu')).toBeNull();
        expect(document.getElementById('filter-chips')).toBeNull();
    });

    it('puts a real input in the header, not a button that opens one', () => {
        expect(box().tagName).toBe('INPUT');
    });
});

describe('the filters dropdown', () => {
    it('opens on focus, with the four the reference offers', async () => {
        await focusBox();
        expect(popOpen()).toBe(true);
        expect(rowTitles()).toEqual([
            'From a specific user',
            'Includes a specific type of data',
            'Mentions a specific user',
            'More filters'
        ]);
    });

    it('shows each one with the operator that types it', async () => {
        await focusBox();
        const hints = [...pop().querySelectorAll('.sp-hint')].map((e) => e.textContent);
        // The hint IS the feature: read it once and the menu is optional.
        expect(hints).toEqual([
            'from: user', 'has: link, embed or file', 'mentions: user',
            'dates, author type, and more'
        ]);
    });

    it('opens onto dates and the rest under More filters', async () => {
        await focusBox();
        rowNamed('More filters').click();
        await settle(4);
        const titles = rowTitles();
        expect(titles).toContain('In a specific channel');
        expect(titles).toContain('Pinned messages');
        expect(titles).toContain('Before a date');
        expect(titles).toContain('After a date');
        expect(titles).toContain('On a specific day');
        expect(titles).not.toContain('More filters');
    });
});

describe('picking a filter is a shortcut for typing it', () => {
    it('writes the operator into the box, then offers its values', async () => {
        await type('');
        await focusBox();
        rowNamed('From a specific user').click();
        await settle(6);

        // Not a flag held somewhere else — the string itself changed.
        expect(box().value).toBe('from:');
        // And the menu moved on to the question that follows.
        expect(rowTitles()).toEqual(['Parker', 'Me', 'Teebob', 'XIAIX'].sort());
    });

    it('completes to a person, and narrows the messages to them', async () => {
        await type('from:');
        rowNamed('Parker').click();
        await settle(8);

        expect(box().value).toBe('from:Parker ');
        expect(shown(), 'only Parker').toBe(1);
        expect($('messages').textContent).toContain('the logo');
    });

    it('offers the has: kinds by name', async () => {
        await type('has:');
        expect(rowTitles()).toEqual(['Links', 'Embeds', 'Any file', 'Images', 'Videos', 'Audio']);
    });

    it('offers the channels for in:', async () => {
        await type('in:');
        expect(rowTitles()).toEqual(['#general', '#design']);
    });
});

describe('typing the operators directly', () => {
    it('reaches the same place clicking does', async () => {
        await type('from:Parker');
        expect(shown()).toBe(1);
        expect($('messages').textContent).toContain('the logo');
    });

    it('narrows by content type on its own', async () => {
        // has: as the ONLY discriminator, so it is provably the thing working.
        // One of these four posts carries a link.
        await type('has:link');
        expect(shown()).toBe(1);
        expect($('messages').textContent).toContain('the logo');

        await type('has:image');
        expect(shown(), 'none of them is an image').toBe(0);
    });

    it('combines them, and counts what survived', async () => {
        await type('from:Parker has:link logo');
        expect(shown()).toBe(1);
        expect($('search-box').dataset.count).toBe('1 match');

        // Same operators, a word that is not in it: nothing.
        await type('from:Parker has:link zzzz');
        expect(shown()).toBe(0);
    });

    it('filters by who was mentioned, not only by who wrote it', async () => {
        await type('mentions:Me');
        expect(shown()).toBe(1);
        expect($('messages').textContent).toContain('look at this');
    });

    it('filters by pinned', async () => {
        await type('pinned:true');
        expect(shown()).toBe(1);
        expect($('messages').textContent).toContain('look at this');
    });

    it('filters by date, with during: meaning the whole of that day', async () => {
        const day = new Date(NOW - 4000);
        const iso = day.getFullYear() + '-' +
            String(day.getMonth() + 1).padStart(2, '0') + '-' +
            String(day.getDate()).padStart(2, '0');
        await type('during:' + iso);
        // Two posts are that day. Parker's is the day before and Teebob's the
        // day after, so BOTH bounds have to hold for this to be two.
        expect(shown()).toBe(2);
        expect($('messages').textContent).not.toContain('the logo');
        expect($('messages').textContent).not.toContain('morning all');
    });

    it('leaves a colon that is not an operator alone', async () => {
        // `16:9` must search for itself rather than vanish into a filter.
        await type('16:9');
        expect(shown(), 'nothing in these posts says 16:9').toBe(0);
        await type('logo');
        expect(shown()).toBe(1);
    });
});

describe('clearing', () => {
    it('puts every message back', async () => {
        await type('from:Parker');
        expect(shown()).toBe(1);

        $('search-clear').click();
        await settle(8);
        expect(box().value).toBe('');
        expect(shown()).toBe(POSTS.length);
        expect($('search-box').dataset.count).toBe('');
    });
});
