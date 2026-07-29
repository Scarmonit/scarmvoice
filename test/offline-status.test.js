// @vitest-environment jsdom
//
// Four statuses, one vocabulary, and the people who are NOT here.
//
// The presence table can only ever answer "who is present". An offline person
// has no row in it, which is exactly why the member list could not show them:
// the answer has to come from the other direction — the account directory,
// minus whoever is currently present.
//
// The other half is a naming problem that was real rather than cosmetic. The
// wire says `away`; this app calls it Idle, as the client it is modelled on
// does. The wire CANNOT be renamed — that table is shared with the website,
// both clients write it and both read each other's rows — so the translation
// happens once, on the way in, and nothing past it may use the old word: not a
// label, not a class, not a sort key. These specs pin that boundary from both
// sides.
//
// ONE boot for the whole file, as the other renderer specs do, and the tests
// below run in order: each one leaves the world it built for the next.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { bootRenderer, $, settle } from './helpers/renderer.js';

// Present, and what the SERVER calls their status.
let presenceRows = [
    { client_id: 'me', user_id: 1, name: 'Me', status: 'online', custom: '' },
    { client_id: 'c-alice', user_id: 2, name: 'Alice', status: 'away', custom: '' },
    { client_id: 'c-bob', user_id: 3, name: 'Bob', status: 'dnd', custom: 'shipping' }
];
// Everyone with an account. Carla and Dan have never appeared in presence, so
// they are the offline half; Erin is banned and belongs in neither list.
const USERS = [
    { id: 1, username: 'Me', role: 'member' },
    { id: 2, username: 'Alice', role: 'member' },
    { id: 3, username: 'Bob', role: 'member' },
    { id: 4, username: 'Carla', role: 'member' },
    { id: 5, username: 'Dan', role: 'member' },
    { id: 6, username: 'Erin', role: 'member', banned: 1 }
];

const DM_ALICE = { id: 40, title: 'Alice', isGroup: false, user: USERS[1], members: [USERS[0], USERS[1]], unread: 0 };
const DM_BOB = { id: 41, title: 'Bob', isGroup: false, user: USERS[2], members: [USERS[0], USERS[2]], unread: 0 };

// The app's clock, under this file's control. Two things read it and both
// matter here: the idle rule (five minutes since the last keypress) and
// refreshPresenceSoon's two-second debounce, which would otherwise swallow the
// second and third time a spec asks the app to republish.
//
// It only ever moves FORWARD. Winding it back would strand `presenceRefreshAt`
// in the future and debounce every later republish for as long as the jump.
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;

let app;

// Clicking back into the window republishes presence. A real path — it is what
// a person does when they come back — rather than a poke at an internal.
async function republish() {
    skew += 3000;                 // clear the debounce
    app.focus(false);
    app.focus(true);
    await settle(40);
}

// Opened the way a person opens one: by clicking the row in the sidebar.
async function openDm(nth) {
    const list = $('dm-list').querySelectorAll('.dm-row');
    if (!list[nth]) throw new Error('no DM row at ' + nth);
    list[nth].click();
    await settle(30);
}

const groups = () => [...$('members-list').querySelectorAll('.mp-group')].map((g) => g.textContent);
const rows = () => [...$('members-list').querySelectorAll('.vp')];
const rowFor = (name) => rows().find((li) => li.querySelector('.vp-name').textContent === name);
const namesInOrder = () => rows().map((li) => li.querySelector('.vp-name').textContent);

beforeAll(async () => {
    app = await bootRenderer({
        user: USERS[0],
        board: vi.fn(async (path, opts) => {
            const key = String(path).split('?')[0];
            if (key === 'presence') return { success: true, members: presenceRows };
            if (key === 'account/users') return { success: true, users: USERS };
            if (key === 'list') return { success: true, posts: [], hasMore: false, typing: [], voice: [] };
            if (key === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
            if (key === 'dm/threads') return { success: true, threads: [DM_ALICE, DM_BOB] };
            if (key === 'dm/list') {
                const want = (opts && opts.query && opts.query.thread) === DM_BOB.id ? DM_BOB : DM_ALICE;
                return { success: true, thread: want, messages: [], hasMore: false };
            }
            return { success: true };
        })
    });
    await settle(40);
});

describe('the member list', () => {
    it('gives the absent a section of their own, under everyone who is here', () => {
        // Idle and DND sit INSIDE Online — they are here, just busy or away
        // from the keyboard — exactly as the reference groups them. Only
        // offline is separated out.
        expect(groups()).toEqual(['Online — 3', 'Offline — 2']);
        // You appear under Online as you always have. What you never appear as
        // is offline, which is what being invisible would otherwise look like
        // in your own copy of the list.
        expect(namesInOrder()).toEqual(['Alice', 'Bob', 'Me', 'Carla', 'Dan']);
    });

    it('leaves a banned account out of the directory entirely', () => {
        expect(namesInOrder()).not.toContain('Erin');
    });

    it('marks the absent so they can be skimmed past, not read', () => {
        const carla = rowFor('Carla');
        expect(carla.classList.contains('offline')).toBe(true);
        expect(carla.querySelector('.presence').classList.contains('offline')).toBe(true);
        // The heading already said "Offline". Repeating it on every row is the
        // noise that made this read as a wall rather than as people.
        expect(carla.querySelector('.vp-sub')).toBeNull();
    });

    it('does not fade the people who are merely idle', () => {
        // Fading somebody idle says the opposite of what their yellow dot says.
        const alice = rowFor('Alice');
        expect(alice.classList.contains('idle')).toBe(true);
        expect(alice.classList.contains('offline')).toBe(false);
    });

    it('translates the wire word exactly once', () => {
        // The server said `away`. Nothing on screen may.
        const alice = rowFor('Alice');
        expect(alice.className).not.toContain('away');
        expect(alice.querySelector('.presence').className).not.toContain('away');
        expect(alice.querySelector('.vp-sub').textContent.trim()).toBe('Idle');
        expect($('members-list').textContent).not.toContain('Away');
    });

    it('gives do-not-disturb the red dot, and keeps their words over ours', () => {
        const bob = rowFor('Bob');
        expect(bob.querySelector('.presence').classList.contains('dnd')).toBe(true);
        // A custom status outranks the generic label — it is the more specific
        // answer to the same question.
        expect(bob.querySelector('.vp-sub').textContent.trim()).toBe('shipping');
    });
});

describe('the direct-message profile panel', () => {
    it('says whether they are there, in a dot and in words', async () => {
        await openDm(0);                       // Alice — present, and idle
        expect($('dm-profile').hidden).toBe(false);
        expect($('dm-prof-dot').className).toContain('idle');
        expect($('dm-prof-status-text').textContent).toBe('Idle');
        // And on the face, where you are already looking.
        expect($('dm-prof-face').querySelector('.presence').className).toContain('idle');
    });

    it('carries their custom line beside the status when they set one', async () => {
        await openDm(1);                       // Bob — do not disturb, with a note
        expect($('dm-prof-dot').className).toContain('dnd');
        expect($('dm-prof-status-text').textContent).toBe('Do Not Disturb — shipping');
    });
});

describe('my own dot', () => {
    it('turns yellow when the idle rule fires, without me choosing anything', async () => {
        expect($('me-presence').className).not.toContain('idle');

        // Five minutes with nothing touched. Nothing fires an event to say so —
        // that is the whole difficulty — so the clock is what moves. Auto-idle
        // reached everyone ELSE on the heartbeat long before this change; what
        // it never reached was your own dot.
        skew += 6 * 60 * 1000;
        await republish();

        expect($('me-presence').className).toContain('idle');
        expect($('me-status-text').textContent).toBe('Idle');
        // The CHOICE is untouched — the picker still says Online, because that
        // is what you chose. Only what you ARE moved.
        expect(app.settings.presence === undefined || app.settings.presence === 'online').toBe(true);
    });

    it('goes green again the moment the keyboard is touched', async () => {
        window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a' }));
        await republish();
        expect($('me-presence').className).not.toContain('idle');
        expect($('me-status-text').textContent).toBe('Online');
    });
});

describe('a person who leaves', () => {
    it('moves to Offline in the member list AND in the open conversation', async () => {
        await openDm(0);                       // Alice's conversation, still open
        const faceBefore = $('dm-prof-face').innerHTML;
        expect(rowFor('Alice').classList.contains('offline')).toBe(false);

        // Closing the app retires the row (main.js does it on quit). From every
        // other client's side that is simply a name which stops coming back.
        presenceRows = presenceRows.filter((m) => m.name !== 'Alice');
        await republish();

        expect(groups()).toEqual(['Online — 2', 'Offline — 3']);
        expect(rowFor('Alice').classList.contains('offline'), 'in the list').toBe(true);
        expect($('dm-prof-status-text').textContent, 'and in the panel').toBe('Offline');
        expect($('dm-prof-dot').className).toContain('offline');

        // The avatar markup must NOT be rewritten to change a status: doing so
        // restarts the image load, which flashes the face three times a minute
        // for as long as the conversation stays open.
        const strip = (h) => h.replace(/presence [a-z]+/, 'presence');
        expect(strip($('dm-prof-face').innerHTML)).toBe(strip(faceBefore));
    });
});

describe('going invisible', () => {
    it('does not list ME under Offline in my own copy of the list', async () => {
        // Invisible works by retiring your presence row — you are, to the
        // server and to everyone reading it, indistinguishable from absent.
        // Which means your own client would find you in the account directory
        // and nowhere in presence, and file you under Offline: the setting
        // working, rendered as the app being broken.
        presenceRows = presenceRows.filter((m) => m.name !== 'Me');
        await republish();

        expect(namesInOrder()).not.toContain('Me');
        expect(groups()).toEqual(['Online — 1', 'Offline — 3']);
    });
});
