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

    it('opens the filters form, rather than growing into one', async () => {
        await focusBox();
        expect($('filters-modal').hidden).toBe(true);
        rowNamed('More filters').click();
        await settle(6);

        // The dropdown gets out of the way; the form takes over.
        expect(popOpen()).toBe(false);
        expect($('filters-modal').hidden).toBe(false);
        expect(document.querySelector('#filters-modal h2').textContent).toBe('Filters');
    });
});

describe('the filters form', () => {
    const field = (id) => $(id);
    const open = async () => {
        await focusBox();
        rowNamed('More filters').click();
        await settle(6);
    };

    it('names every field, and says what each one does', async () => {
        await open();
        const labels = [...document.querySelectorAll('#filters-modal .fm-label')].map((e) => e.textContent);
        expect(labels).toEqual(['From', 'In', 'Has', 'Mentions', 'Date', 'Author Type', 'Pinned']);
        const hints = [...document.querySelectorAll('#filters-modal .fm-hint')].map((e) => e.textContent);
        expect(hints).toEqual([
            'Sent by any of the selected users',
            'Sent in any of the selected channels',
            'Includes any of the selected types of data',
            'Mentions any of the selected users',
            'When the message was sent',
            'Sent by any of the selected types of author',
            'If the message is pinned or not'
        ]);
        $('fm-cancel').click();
        await settle(4);
    });

    it('offers the real people and the real channels', async () => {
        await open();
        expect([...field('fm-from').options].map((o) => o.textContent))
            .toEqual(['Anyone', 'Me', 'Parker', 'Teebob', 'XIAIX']);
        expect([...field('fm-in').options].map((o) => o.textContent))
            .toEqual(['Any channel', '#general', '#design']);
        // Has defaults to the reference's wording for "no filter".
        expect(field('fm-has').options[0].textContent).toBe('Any content');
        $('fm-cancel').click();
        await settle(4);
    });

    it('starts the date as a button, not an empty field', async () => {
        await open();
        expect($('fm-date-add').hidden).toBe(false);
        expect($('fm-date-row').hidden).toBe(true);
        $('fm-date-add').click();
        await settle(2);
        expect($('fm-date-row').hidden).toBe(false);
        $('fm-cancel').click();
        await settle(4);
    });

    it('reads the operators already in the box', async () => {
        await type('from:Parker in:design has:link pinned:true lunch');
        await open();
        expect(field('fm-from').value).toBe('Parker');
        expect(field('fm-in').value).toBe('design');
        expect(field('fm-has').value).toBe('link');
        expect(field('fm-pinned').value).toBe('true');
        $('fm-cancel').click();
        await settle(4);
        // Cancel changed nothing.
        expect(box().value).toBe('from:Parker in:design has:link pinned:true lunch');
    });

    it('writes them back on apply, and combines them', async () => {
        await type('');
        await open();
        field('fm-from').value = 'Parker';
        field('fm-has').value = 'link';
        $('fm-apply').click();
        await settle(10);

        expect($('filters-modal').hidden).toBe(true);
        // The box IS the state — applying the form types into it.
        expect(box().value).toContain('from:Parker');
        expect(box().value).toContain('has:link');
        expect(shown(), 'both criteria at once').toBe(1);
        expect($('messages').textContent).toContain('the logo');
    });

    it('keeps the words being searched for', async () => {
        // The form owns the operators; it does not own the query. Applying it
        // must not eat the thing you were actually looking for.
        //
        // The words go LAST here on purpose: with the caret inside `from:Parker`
        // the dropdown is showing people, not the filter list, which is correct
        // and means there is no "More filters" row to click.
        await type('from:Parker logo');
        await open();
        field('fm-has').value = 'link';
        $('fm-apply').click();
        await settle(10);

        expect(box().value).toContain('logo');
        expect(box().value).toContain('has:link');
        // The From the form was opened with is still applied — it was read out
        // of the box and written straight back.
        expect(box().value).toContain('from:Parker');
        expect(shown()).toBe(1);
    });

    it('applies a date, with On meaning the whole of that day', async () => {
        await type('');
        await open();
        $('fm-date-add').click();
        const d = new Date(NOW - 4000);
        const iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
            '-' + String(d.getDate()).padStart(2, '0');
        field('fm-date-mode').value = 'during';
        field('fm-date-value').value = iso;
        $('fm-apply').click();
        await settle(10);

        expect(box().value).toContain('during:' + iso);
        expect(shown()).toBe(2);
    });

    it('Clear Filters empties the fields without touching the search', async () => {
        await type('from:Parker logo');
        await open();
        expect(field('fm-from').value).toBe('Parker');

        $('fm-clear').click();
        await settle(2);
        expect(field('fm-from').value).toBe('');
        // Nothing is applied until Apply is pressed, so the search is untouched
        // and Cancel still leaves it exactly as it was.
        expect(box().value).toBe('from:Parker logo');

        $('fm-cancel').click();
        await settle(4);
        expect(box().value).toBe('from:Parker logo');
    });

    it('leaves the caret where the filter list is still reachable', async () => {
        // Apply keeps the trailing space writeOp leaves, and that is the whole
        // reason you can open the form twice. Trimmed, the caret lands INSIDE
        // `from:Parker`, the dropdown quite correctly offers people instead of
        // filters, and there is no "More filters" row to click — no way back
        // without typing a space nobody would think to type.
        await type('');
        await open();
        field('fm-from').value = 'Parker';
        $('fm-apply').click();
        await settle(10);

        box().setSelectionRange(box().value.length, box().value.length);
        await focusBox();
        expect(rowTitles(), 'the filter list, not the people list')
            .toContain('More filters');
    });

    it('Clear then Apply really does clear the search', async () => {
        await type('from:Parker logo');
        await open();
        $('fm-clear').click();
        $('fm-apply').click();
        await settle(10);
        // The words stay — Clear Filters clears FILTERS — and Parker does not.
        expect(box().value).toBe('logo');
        expect(shown()).toBe(1);
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
