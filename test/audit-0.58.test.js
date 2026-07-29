// @vitest-environment jsdom
//
// Regressions found by the 0.58 audit pass. One describe per defect, each named
// after what the user saw rather than after the code that was wrong.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { bootRenderer, $, settle, type } from './helpers/renderer.js';

const POST = (over = {}) => Object.assign({
    id: 1, body: 'hello', name: 'Alice', client_id: 'alice', user_id: 2,
    created_at: 1700000000000, reactions: [], pinned: 0
}, over);

function router(over = {}) {
    return vi.fn(async (p, opts) => {
        if (over[p]) return over[p](opts);
        if (p === 'list') return { success: true, posts: [POST()], typing: [], voice: [], hasMore: false, maxId: 1 };
        if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }, { name: 'random', unread: 0 }] };
        if (p === 'presence') return { success: true, members: [] };
        if (p === 'account/users') return { success: true, users: [{ id: 1, username: 'Me', role: 'member' }] };
        if (p === 'dm/threads') return { success: true, threads: [] };
        return { success: true };
    });
}

beforeEach(() => {
    localStorage.clear();
});

// A message SENT still said its author was typing.
//
// The start of a typing signal goes out on both transports — the socket and the
// HTTP row the poll reads back — and only the socket stop was sent. So the
// server's row survived the send, and the refetch the post triggers on every peer
// overwrote the live set from the poll's answer, which still returned that row for
// its six-second lifetime. "Alice is typing…" reappeared underneath Alice's
// delivered message with no expiry timer behind it.
describe('sending a message stops the typing indicator', () => {
    it('clears the server row, not just the socket', async () => {
        const board = router();
        await bootRenderer({ board });

        type('hello there');
        await settle();
        board.mockClear();

        $('composer').requestSubmit();
        await settle();

        const typingCalls = board.mock.calls.filter((c) => c[0] === 'typing');
        expect(typingCalls.length).toBe(1);
        expect(typingCalls[0][1].body).toEqual({ clientId: 'me', stop: true });
    });

    it('does not swallow the next start behind the 3-second throttle', async () => {
        const board = router();
        const { lounge } = await bootRenderer({ board });

        type('first');
        await settle();
        $('composer').requestSubmit();
        await settle();

        // Straight into a second message. Without resetting the throttle the
        // start is dropped and nobody sees this one being typed either.
        lounge.rt.sendTyping.mockClear();
        type('second');
        await settle();
        expect(lounge.rt.sendTyping).toHaveBeenCalledWith('general', false);
    });

    it('does not let the poll resurrect somebody the socket retired', async () => {
        const board = router({
            // The poll still carries Alice's row, as it does for six seconds
            // after she sends.
            list: async () => ({
                success: true, posts: [POST()], voice: [], hasMore: false, maxId: 1,
                typing: [{ client_id: 'alice', name: 'Alice' }]
            })
        });
        const h = await bootRenderer({ board });

        // The socket is up and has said she stopped.
        h.rt({ t: 'status', connected: true });
        h.rt({ t: 'typing', channel: 'general', cid: 'alice', name: 'Alice', stop: true });
        await settle();

        // A refetch — the one the delivered message triggers.
        h.rt({ t: 'posted', channel: 'general', cid: 'alice', name: 'Alice' });
        await settle();

        expect($('typing-line').textContent).not.toContain('Alice');
    });
});

// A queued message went out under the NEXT person to sign in.
describe('the outbox belongs to whoever wrote it', () => {
    it('stamps the author on a queued message', async () => {
        const board = router({ post: async () => ({ success: false, network: true }) });
        await bootRenderer({ board, user: { id: 7, username: 'Alice', role: 'member' } });

        type('a private line');
        await settle();
        $('composer').requestSubmit();
        await settle();

        const queued = JSON.parse(localStorage.getItem('lounge_outbox') || '[]');
        expect(queued).toHaveLength(1);
        expect(queued[0].userId).toBe(7);
    });

    it('refuses to send another account\'s queued message', async () => {
        localStorage.setItem('lounge_outbox', JSON.stringify([{
            seq: 1, id: 'out:1', channel: 'general', body: 'Alice wrote this',
            userId: 7, created_at: 1700000000000, sending: false, failed: false
        }]));

        const board = router();
        // Bob signs in on the same machine.
        await bootRenderer({ board, user: { id: 8, username: 'Bob', role: 'member' } });
        await settle();

        expect(board.mock.calls.filter((c) => c[0] === 'post')).toHaveLength(0);
        expect(JSON.parse(localStorage.getItem('lounge_outbox'))).toEqual([]);
    });

    it('still sends its own', async () => {
        localStorage.setItem('lounge_outbox', JSON.stringify([{
            seq: 1, id: 'out:1', channel: 'general', body: 'mine, from before the crash',
            userId: 7, created_at: 1700000000000, sending: false, failed: false
        }]));

        const board = router();
        await bootRenderer({ board, user: { id: 7, username: 'Alice', role: 'member' } });
        await settle();

        const posts = board.mock.calls.filter((c) => c[0] === 'post');
        expect(posts).toHaveLength(1);
        expect(posts[0][1].body.body).toBe('mine, from before the crash');
    });
});

// Unread watermarks were shared by everyone who used the machine.
describe('unread watermarks are per account', () => {
    it('keys them by account id', async () => {
        const board = router();
        await bootRenderer({ board, user: { id: 7, username: 'Alice', role: 'member' } });
        await settle();
        expect(localStorage.getItem('lounge_reads:7')).toBeTruthy();
    });

    it('does not hand one account\'s watermarks to another', async () => {
        localStorage.setItem('lounge_reads:7', JSON.stringify({ general: 999 }));
        const board = router();
        await bootRenderer({ board, user: { id: 8, username: 'Bob', role: 'member' } });
        await settle();

        expect(JSON.parse(localStorage.getItem('lounge_reads:8')).general).toBe(1);
        // …and Alice's are left exactly as they were.
        expect(JSON.parse(localStorage.getItem('lounge_reads:7')).general).toBe(999);
    });

    it('adopts the pre-update unkeyed value once, then removes it', async () => {
        localStorage.setItem('lounge_reads', JSON.stringify({ random: 42 }));
        const board = router();
        await bootRenderer({ board, user: { id: 7, username: 'Alice', role: 'member' } });
        await settle();

        expect(JSON.parse(localStorage.getItem('lounge_reads:7')).random).toBe(42);
        expect(localStorage.getItem('lounge_reads')).toBeNull();
    });
});

// A reaction in another channel raised an unread badge and a "New message"
// desktop notification for a message nobody had written.
describe('a refetch nudge is not a new message', () => {
    it('does not badge or notify for one', async () => {
        const board = router();
        const h = await bootRenderer({ board });
        h.hidden(true);                     // notifications only fire off-focus
        await settle();
        h.lounge.app.notify.mockClear();

        h.rt({ t: 'posted', channel: 'random', cid: 'alice', kind: 'refresh' });
        await settle();

        expect(h.lounge.app.notify).not.toHaveBeenCalled();
        const badge = document.querySelector('.chan[data-channel="random"] .unread');
        expect(badge).toBeNull();
    });

    it('still badges a real message', async () => {
        const board = router();
        const h = await bootRenderer({ board });
        await settle();

        h.rt({ t: 'posted', channel: 'random', cid: 'alice' });
        await settle();

        expect(document.querySelector('.chan[data-channel="random"] .unread')).not.toBeNull();
    });

    // The nudge carries the sender's account name now, so a message written on
    // another device does not notify its own author.
    it('knows a nudge naming me is mine', async () => {
        const board = router();
        const h = await bootRenderer({ board, user: { id: 1, username: 'Me', role: 'member' } });
        h.hidden(true);
        await settle();
        h.lounge.app.notify.mockClear();

        h.rt({ t: 'posted', channel: 'random', cid: 'my-phone', name: 'Me' });
        await settle();

        expect(h.lounge.app.notify).not.toHaveBeenCalled();
    });
});

// A url inside a code fence was still fetched and drawn as a preview card.
describe('a link inside a code fence is code', () => {
    it('is not unfurled', async () => {
        const board = router({
            list: async () => ({
                success: true, voice: [], typing: [], hasMore: false, maxId: 1,
                posts: [POST({ body: 'look at this:\n```\ncurl https://example.com/secret\n```' })]
            })
        });
        const h = await bootRenderer({ board });
        await settle();
        expect(h.lounge.unfurl).not.toHaveBeenCalled();
    });

    it('is still unfurled outside one', async () => {
        const board = router({
            list: async () => ({
                success: true, voice: [], typing: [], hasMore: false, maxId: 1,
                posts: [POST({ body: 'look at https://example.com/page' })]
            })
        });
        const h = await bootRenderer({ board });
        await settle();
        expect(h.lounge.unfurl).toHaveBeenCalledWith('https://example.com/page');
    });
});

// A failed archive search closed the panel, so a dead connection looked exactly
// like "there is nothing in the archive about that".
describe('a failed archive search says so', () => {
    it('keeps the panel open with the reason and a retry', async () => {
        const board = router({ search: async () => ({ success: false, network: true }) });
        await bootRenderer({ board });

        $('search-input').value = 'anything';
        $('search-input').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await settle();

        expect($('search-panel').hidden).toBe(false);
        expect($('search-summary').textContent).toMatch(/could not/i);
        expect($('search-results').querySelector('button')).not.toBeNull();
    });

    it('still reports a genuinely empty result as empty', async () => {
        const board = router({ search: async () => ({ success: true, results: [] }) });
        await bootRenderer({ board });

        $('search-input').value = 'anything';
        $('search-input').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await settle();

        expect($('search-summary').textContent).toMatch(/nothing in the archive/i);
    });
});

// "40 results in the archive" was a claim the response could not support.
describe('a full page of search results does not claim to be all of them', () => {
    it('says it is showing the newest', async () => {
        const results = Array.from({ length: 40 }, (_, i) => ({
            id: i + 1, name: 'Alice', channel: 'general', body: 'match ' + i,
            created_at: 1700000000000, client_id: 'alice'
        }));
        const board = router({ search: async () => ({ success: true, results }) });
        await bootRenderer({ board });

        $('search-input').value = 'match';
        $('search-input').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await settle();

        expect($('search-summary').textContent).toMatch(/newest 40/i);
    });
});

// navigator.mediaDevices, installed AFTER the renderer has loaded.
//
// The order matters: noise.js and soundboard.js each wrap getUserMedia at load
// time, and a wrapped call reaches into the returned stream (getAudioTracks, the
// AudioContext) — none of which is what these specs are about. jsdom provides no
// mediaDevices, so leaving it absent until after boot means neither patch attaches
// and startRecording gets exactly what it asked for.
//
// opts.hold keeps each call pending so a test can decide when it lands.
function installMediaDevices({ hold = false } = {}) {
    const resolvers = [];
    const stopped = [];
    const stream = (tag) => {
        const t = { kind: 'audio', stop() { stopped.push(tag); }, addEventListener() {}, removeEventListener() {} };
        return { getTracks: () => [t], getAudioTracks: () => [t], getVideoTracks: () => [] };
    };
    const getUserMedia = vi.fn(() => hold
        ? new Promise((r) => resolvers.push(r))
        : Promise.resolve(stream('only')));

    navigator.mediaDevices = { getUserMedia, enumerateDevices: async () => [] };
    window.MediaRecorder = class {
        constructor() { this.state = 'inactive'; }
        start() { this.state = 'recording'; }
        stop() { this.state = 'inactive'; if (this.onstop) this.onstop(); }
    };
    window.MediaRecorder.isTypeSupported = () => false;

    return { getUserMedia, stopped, resolve: (i, tag) => resolvers[i](stream(tag)) };
}

// A voice message was recorded from the system default microphone.
describe('a voice message uses the microphone you chose', () => {
    it('asks for the saved device', async () => {
        const board = router();
        await bootRenderer({
            board,
            settings: { micDeviceId: 'headset-1' },
            // The real engine builds the constraints; the double answers the same
            // way micTestConstraints() does.
            voice: { micTestConstraints: () => ({ audio: { deviceId: { exact: 'headset-1' } } }) }
        });
        const { getUserMedia } = installMediaDevices();

        $('btn-mic').click();
        await settle();

        expect(getUserMedia).toHaveBeenCalledTimes(1);
        expect(getUserMedia.mock.calls[0][0]).toEqual({ audio: { deviceId: { exact: 'headset-1' } } });
    });

    it('does not keep a second microphone open on a double click', async () => {
        const board = router();
        await bootRenderer({ board, voice: { micTestConstraints: () => ({ audio: true }) } });
        // Held open, so both clicks land inside the acquisition window.
        const md = installMediaDevices({ hold: true });

        // Nothing on screen has changed yet — showRecBar runs after the await — so
        // this is an ordinary impatient double-click rather than a contrived one.
        $('btn-mic').click();
        $('btn-mic').click();
        await settle();
        expect(md.getUserMedia).toHaveBeenCalledTimes(2);

        md.resolve(0, 'a');
        await settle();
        expect($('voice-rec').hidden).toBe(false);       // the first one is recording

        md.resolve(1, 'b');
        await settle();

        // The loser's tracks are released. It used to overwrite the winner instead:
        // its stream stayed open for the session (the OS microphone indicator lit,
        // the shared AudioContext never freed) and even signing out could not
        // reach it, because teardown only ever knew about the survivor.
        expect(md.stopped).toEqual(['b']);
    });
});

// A transient failure to reach account/me demanded a full re-sign-in, with the
// error line deliberately blanked so nothing said why.
describe('a server that did not answer is not a missing account', () => {
    it('says the sign-in is still saved instead of a blank form', async () => {
        await bootRenderer({
            board: router(),
            // What board() answers for an edge 502 or a Worker exception page: a
            // returned failure, not a throw.
            accountMe: async () => ({ success: false, network: true })
        });
        await settle();

        expect($('login').hidden).toBe(false);
        expect($('app').hidden).toBe(true);
        const said = $('login-sub').textContent + ' ' + $('login-error').textContent;
        expect(said).toMatch(/could not reach/i);
        expect(said).toMatch(/still saved/i);
    });

    it('still asks for an account when there genuinely is none', async () => {
        await bootRenderer({
            board: router(),
            accountMe: async () => ({ success: false, error: 'no account' })
        });
        await settle();

        expect($('login-acct').hidden).toBe(false);
        expect($('login-sub').textContent).toMatch(/step 2 of 2/i);
        // …and no false reassurance about a sign-in that is not saved.
        expect($('login-error').textContent).toBe('');
    });
});
