// @vitest-environment jsdom
//
// The renderer half of the 0.92.7 audit pass.
//
// Five defects. The thread running through most of them is an answer computed
// carefully by one piece of code and thrown away by another that did not know
// what it was for.
import { describe, it, expect, vi } from 'vitest';
import { bootRenderer, settle, composerInput, $ } from './helpers/renderer.js';

const ME = { id: 1, username: 'Me', role: 'member' };
const THEM = { id: 2, username: 'Alice', role: 'member' };

function router(extra) {
    return vi.fn(async (p, opts) => {
        if (extra) {
            const hit = extra(p, opts);
            if (hit) return hit;
        }
        if (p === 'list') return { success: true, posts: [], typing: [], voice: [], hasMore: false };
        if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
        if (p === 'presence') return { success: true, members: [] };
        if (p === 'dm/threads') return { success: true, threads: [] };
        return { success: true };
    });
}

// ---------------------------------------------------------------------------
// ONE MESSAGE COULD WEDGE THE CHANNEL FOR EVERYONE.
//
// Blocks nest, and the nesting is recursion — so the depth has to be bounded by
// something other than the message. `"> "` repeated is depth proportional to
// LENGTH: the composer has no maxlength and the server takes 250,000
// characters, so one pasted line recursed thousands of frames and threw
// RangeError out of renderBody, past renderMessages, into the poll. The row
// never appeared, neither did any row after it (the forEach aborts), and every
// later repaint threw at the same place.
//
// This is the defect renderFormatted() was fixed for in 0.75 (see
// audit-0.75.test.js) appearing in the block path, which never got the ceiling.
describe('a message whose block nesting is its own length', () => {
    // Deep enough to blow an unbounded stack, short enough to render fast.
    const DEEP = 4000;

    async function post(body) {
        await bootRenderer({
            board: router((p) => (p === 'list'
                ? {
                    success: true, typing: [], voice: [], hasMore: false, maxId: 7,
                    posts: [{
                        id: 7, body, name: 'Alice', client_id: 'alice', user_id: 2,
                        created_at: 1700000000000, reactions: [], pinned: 0
                    }]
                }
                : null))
        });
        await settle();
    }

    const row = () => $('messages').querySelector('.msg[data-id="7"]');

    it('renders a `> ` chain instead of throwing out of the poll', async () => {
        await post('> '.repeat(DEEP) + 'boo');
        expect(row(), 'the message drew at all').toBeTruthy();
        // Everything typed is still readable — the markers past the ceiling are
        // shown as text rather than eaten.
        expect(row().textContent).toContain('boo');
    });

    it('renders a `>>>` chain the same way', async () => {
        await post('>>>'.repeat(DEEP) + ' boo');
        expect(row()).toBeTruthy();
        expect(row().textContent).toContain('boo');
    });

    it('caps how deeply the quotes actually nest', async () => {
        await post('> '.repeat(DEEP) + 'boo');
        let deepest = 0;
        for (const bq of row().querySelectorAll('blockquote')) {
            let d = 0;
            for (let n = bq; n; n = n.parentElement) if (n.tagName === 'BLOCKQUOTE') d++;
            deepest = Math.max(deepest, d);
        }
        expect(deepest).toBeGreaterThan(0);
        expect(deepest).toBeLessThanOrEqual(12);
    });

    // …and a list that indents on every line, which recurses through the same
    // pair of functions.
    it('renders a list that nests on every line', async () => {
        const lines = [];
        for (let i = 0; i < 1200; i++) lines.push(' '.repeat(i) + '- x');
        await post(lines.join('\n') + '\nboo');
        expect(row()).toBeTruthy();
    });

    // The ceiling must be invisible in anything anybody writes on purpose.
    it('leaves ordinary quoting exactly as it was', async () => {
        await post('> quoted\n> still quoted\nplain');
        const bqs = row().querySelectorAll('blockquote');
        expect(bqs.length).toBe(1);
        expect(bqs[0].textContent).toContain('quoted');
        expect(row().textContent).toContain('plain');
    });

    it('still nests a quote inside a quote', async () => {
        await post('> outer\n> > inner');
        expect(row().querySelectorAll('blockquote blockquote').length).toBe(1);
    });

    it('still draws a list inside a quote', async () => {
        await post('> - one\n> - two');
        const list = row().querySelector('blockquote ul');
        expect(list).toBeTruthy();
        expect(list.querySelectorAll('li').length).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// A DM EDITOR LEFT OPEN FROZE THE CHANNEL LIST.
//
// renderMessages() refuses to repaint while a .msg-edit node exists ANYWHERE in
// the document — a background poll must not pull the box out from under
// somebody mid-sentence. Every other surface that can be torn down with one
// open cleans up after itself: resetChannelView() calls cancelEdit(),
// closeThread() clears editingId when the thread list holds one. closeDm() did
// neither, and renderDmMessages() cannot help because it carries the same guard
// and returns without touching anything.
//
// So: edit a DM, close the conversation, and the channel behind it stopped
// repainting for the rest of the session.
describe('closing a conversation with its editor open', () => {
    const MINE = {
        id: 501, body: 'mine', from: ME.id, fromMe: true,
        created_at: 1700000000000, reactions: [], reply_count: 0
    };
    const THREAD = {
        id: 40, title: 'Alice', isGroup: false, user: THEM, members: [ME, THEM], unread: 0
    };

    async function openDmAndEdit() {
        const app = await bootRenderer({
            board: router((p) => {
                if (p === 'dm/threads') return { success: true, threads: [THREAD] };
                if (p === 'dm/list') return { success: true, thread: THREAD, messages: [MINE], hasMore: false };
                return null;
            })
        });
        $('rail-dms').click();
        await settle();
        const listRow = $('dm-list').querySelector('.dm-row');
        expect(listRow, 'the conversation list drew a row').toBeTruthy();
        listRow.click();
        await settle();

        const msg = $('dm-messages').querySelector('.msg[data-id="501"]');
        expect(msg, 'the conversation drew a message').toBeTruthy();
        msg.dispatchEvent(new window.MouseEvent('contextmenu', {
            bubbles: true, cancelable: true, clientX: 10, clientY: 10
        }));
        const edit = [...$('ctx-menu').querySelectorAll('.ctx-label')]
            .map((l) => l.closest('button'))
            .find((b) => b && /^Edit/.test(b.textContent.trim()));
        expect(edit, 'the row offers Edit').toBeTruthy();
        edit.click();
        await settle();
        expect($('dm-messages').querySelector('.msg-edit'), 'the editor opened').toBeTruthy();
        return app;
    }

    it('takes the editor with it', async () => {
        await openDmAndEdit();
        $('dm-close').click();
        await settle();
        expect(document.querySelector('.msg-edit')).toBeNull();
    });

    it('leaves the channel list able to repaint again', async () => {
        const app = await openDmAndEdit();
        $('dm-close').click();
        $('rail-home').click();
        await settle();
        expect(document.querySelector('.msg-edit')).toBeNull();

        // A message arriving in the channel now draws. Before the fix
        // renderMessages() returned at the orphaned node and nothing ever did.
        app.rt({ t: 'posted', channel: 'general' });
        await settle();
        expect(document.querySelector('.msg-edit')).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// THE COMPOSER HANDED THE PREVIOUS ACCOUNT'S MESSAGE TO THE NEXT PERSON.
//
// An upload can run for minutes, and losing the credential during one is an
// ordinary way for it to fail. uploadOne() calls authGone(), which tears the
// session down — clearing the composer, the staged files and the reply chip, by
// design, so the next person to sign in cannot find them — and then returns
// false like any other failure. The submit handler then put all of it back: the
// failed files re-staged, and the caption written into the box, over the login
// card. enterApp() resets neither.
describe('a send that fails because the session ended', () => {
    function dropFile(name) {
        const file = new window.File(['x'], name, { type: 'image/png' });
        const ev = new window.Event('drop', { bubbles: true, cancelable: true });
        ev.dataTransfer = {
            types: ['Files'], files: [file], items: [], getData: () => ''
        };
        document.dispatchEvent(ev);
    }

    async function sendAndLoseSession() {
        const app = await bootRenderer({ board: router() });
        // Every board call answers "signed out" from here on, which is what
        // authGone() acts on.
        app.lounge.uploadAttachment = vi.fn(async () => ({ success: false, needsAuth: true }));

        const input = composerInput();
        input.value = 'here are the payroll numbers';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        dropFile('payroll.png');
        await settle();
        expect($('upload-list').textContent, 'the file staged').toContain('payroll');

        $('composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
        await settle();
        return { app, input };
    }

    it('ends the session, as it always did', async () => {
        await sendAndLoseSession();
        expect($('login').hidden).toBe(false);
    });

    it('leaves the caption out of the composer the next person sees', async () => {
        const { input } = await sendAndLoseSession();
        expect(input.value).toBe('');
    });

    it('leaves the files out of it too', async () => {
        await sendAndLoseSession();
        expect($('upload-list').textContent).not.toContain('payroll');
    });
});

// ---------------------------------------------------------------------------
// A FAILED SEND OVERWROTE WHAT WAS TYPED WHILE IT WAS IN FLIGHT.
//
// The field is cleared at submit and the sent text handed back on failure. That
// restore was an assignment, and the failure can land a long time later — the
// presigned PUT behind an attachment has no timeout and this app advertises
// 1 GB attachments. Whatever had been typed meanwhile was destroyed, with no
// way back: message recall only remembers what was SENT. The re-staging of
// failed files a few lines above already accounts for the same window and says
// so; the caption never did.
describe('a send the server rejected', () => {
    const rejecting = () => bootRenderer({
        board: router((p) => (p === 'post'
            ? { success: false, error: 'Channel is read-only' } : null))
    });

    it('gives the text back without eating what was typed since', async () => {
        await rejecting();
        const input = composerInput();
        input.value = 'clip from last night';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        await settle();

        // Submit, then type something else before the answer lands.
        $('composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
        input.value = 'brb 5 min';
        await settle();

        expect(input.value).toContain('brb 5 min');
        expect(input.value).toContain('clip from last night');
    });

    it('still restores into an empty box exactly as it did', async () => {
        await rejecting();
        const input = composerInput();
        input.value = 'hello';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        await settle();
        $('composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
        await settle();
        expect(input.value).toBe('hello');
    });
});

// ---------------------------------------------------------------------------
// THE REALTIME SOCKET CAME BACK AFTER THE SESSION IT BELONGED TO ENDED.
//
// enterApp() is a ten-await function whose caller does not await it, so its
// session-generation guard exists precisely because a teardown can land in the
// middle. `await L.rt.start()` — an acquisition of exactly the same class as
// the timers the tail is guarded for — sat between two guards with none of its
// own. rt.start() clears manualClose and reconnects whenever the board cookie
// survives, which two of the three teardown exits leave in place deliberately:
// a fresh authenticated socket carrying the OUTGOING account's token, opened
// behind the sign-in card, which nothing afterwards ever tore down.
//
// The reachable window is the sign-in-by-password path, where refreshAccount()
// makes the real account/me call (the gate's fast-path flag is only set when
// the gate itself asked) — a call net.js retries for up to twenty seconds,
// with the shell already on screen and Switch Accounts one click away.
describe('a session that ends while the shell is still starting', () => {
    it('does not open a socket for the account that just left', async () => {
        let releaseMe = null;
        let meCalls = 0;
        const app = await bootRenderer({
            board: router(),
            // First call is the account gate's: fail it, so the app shows the
            // account step and the sign-in below takes the slow path.
            accountMe: () => {
                meCalls++;
                if (meCalls === 1) return Promise.resolve({ success: false, network: true });
                return new Promise((r) => { releaseMe = r; });
            }
        });
        expect($('login-acct').hidden, 'the account step is on screen').toBe(false);

        app.lounge.account.login = vi.fn(async () => ({ success: true, user: ME }));
        $('login-acct-user').value = 'Me';
        $('login-acct-pw').value = 'hunter2';
        $('login-acct-signin').click();
        await settle();

        // The shell is up and refreshAccount()'s account/me is still in flight.
        expect($('app').hidden).toBe(false);
        expect(releaseMe, 'account/me is being awaited').toBeTruthy();
        app.lounge.rt.start.mockClear();

        // Switch Accounts. teardownSession() ends with rt.stop().
        $('mep-switch').click();
        await settle();

        releaseMe({ success: true, user: ME });
        await settle();

        expect(app.lounge.rt.start).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// AN EXTENSION CHOSEN BY THE SENDER WAS LOOKED UP ON Object.prototype.
//
// The same hazard SEARCH_OPS and HAS_KINDS in the same file are built
// prototype-free for. `constructor` and `__proto__` both survive
// .toLowerCase(), so a plain object literal answered for them: truthy, so it
// was returned instead of falling through to 'file', and the icon set then
// stringified it, missed, and drew nothing at all.
describe('the icon for an attachment', () => {
    it('falls back to the generic glyph for a prototype key', async () => {
        await bootRenderer({ board: router() });
        const lib = window.ScarmLib;
        expect(lib.fileIcon('notes.constructor')).toBe('file');
        expect(lib.fileIcon('x.__proto__')).toBe('file');
        expect(lib.fileIcon('anything.wat')).toBe('file');
    });

    it('still knows the extensions it always knew', async () => {
        await bootRenderer({ board: router() });
        const lib = window.ScarmLib;
        expect(lib.fileIcon('a.pdf')).toBe('doc');
        expect(lib.fileIcon('a.zip')).toBe('archive');
        expect(lib.fileIcon('a.7z')).toBe('archive');
        expect(lib.fileIcon('a.iso')).toBe('disc');
    });
});

// ---------------------------------------------------------------------------
// A FULLY PAGED-BACK CONVERSATION GREW ITS "LOAD EARLIER" BUTTON BACK.
//
// `hasMore` answers "is there anything older than THIS page", and
// loadDmMessages() always asks for the newest one — so for any conversation
// past a page long the answer is true forever, whatever the client already
// holds. It was assigned unconditionally, above the signature early-return so
// that every poll ran it, which undid the `false` a completed loadOlderDms()
// walk had established.
//
// The button came back over a conversation whose whole history was loaded and
// would not go away, and the "beginning of your direct message history" block
// disappeared with it.
describe('a conversation paged back to its beginning', () => {
    const THREAD = {
        id: 40, title: 'Alice', isGroup: false, user: THEM, members: [ME, THEM], unread: 0
    };
    const msg = (id) => ({
        id, body: 'm' + id, from: THEM.id, created_at: 1700000000000 + id,
        reactions: [], reply_count: 0
    });
    // The newest page, and the one behind it. The newest page's `hasMore` is
    // true and STAYS true — there really is older history than the page it
    // describes, whatever the client has since fetched.
    const NEWEST = [msg(502), msg(503)];
    const OLDER = [msg(500), msg(501)];

    function dmRouter(olderPage) {
        return router((p, opts) => {
            if (p === 'dm/threads') return { success: true, threads: [THREAD] };
            if (p === 'dm/list') {
                if (opts && opts.query && opts.query.before) {
                    return { success: true, thread: THREAD, messages: olderPage, hasMore: false };
                }
                return { success: true, thread: THREAD, messages: NEWEST, hasMore: true };
            }
            return null;
        });
    }

    async function openAndPageBack(olderPage) {
        const app = await bootRenderer({ board: dmRouter(olderPage) });
        $('rail-dms').click();
        await settle();
        $('dm-list').querySelector('.dm-row').click();
        await settle();
        const btn = $('dm-messages').querySelector('.dm-load-older');
        expect(btn, 'there is more history to ask for').toBeTruthy();
        btn.click();
        await settle();
        return app;
    }

    it('does not grow the button back on the next refresh', async () => {
        const app = await openAndPageBack(OLDER);
        expect($('dm-messages').querySelector('.dm-load-older')).toBeNull();

        app.resync();      // what the twelve-second poll does
        await settle();
        expect($('dm-messages').querySelector('.dm-load-older')).toBeNull();
    });

    it('keeps the start-of-history block that goes with it', async () => {
        const app = await openAndPageBack(OLDER);
        app.resync();
        await settle();
        expect($('dm-messages').querySelector('.dm-intro')).toBeTruthy();
    });

    // The walk can also come back with nothing — a message deleted between the
    // two queries, or a page boundary that moved. Returning without a repaint
    // left the button on screen having visibly done nothing.
    it('takes the button away even when the walk comes back empty', async () => {
        await openAndPageBack([]);
        expect($('dm-messages').querySelector('.dm-load-older')).toBeNull();
    });

    // …and a conversation that genuinely has more still offers it.
    it('still offers the button while there is history left', async () => {
        await bootRenderer({ board: dmRouter(OLDER) });
        $('rail-dms').click();
        await settle();
        $('dm-list').querySelector('.dm-row').click();
        await settle();
        expect($('dm-messages').querySelector('.dm-load-older')).toBeTruthy();
        expect($('dm-messages').querySelector('.dm-intro')).toBeNull();
    });
});
