// @vitest-environment jsdom
//
// "Alice is typing…" that never stops.
//
// Who is typing reaches the renderer down two pipes. The SOCKET is authoritative
// while it is up: it carries an explicit stop, and every entry it introduces
// gets a 6 second expiry that each keystroke refreshes. The HTTP POLL is the
// fallback while the socket is down, and it is a snapshot with neither — so the
// poll's answer is only allowed to overwrite the live set when the socket is
// actually down (otherwise a refetch resurrects people the socket has already
// retired, most visibly whoever just posted).
//
// Those two rules were both right and left a hole between them. An entry the
// POLL introduced got no expiry, and once the socket came back:
//
//   • no socket 'stop' would ever arrive for it — the server's HTTP typing row
//     just ages out server-side, it is not replayed over the socket, and
//   • the poll branch that would have overwritten it is skipped, because that
//     only runs while the socket is down.
//
// So the line sat there for the rest of the session. Switching channels was the
// only way to clear it — and reading the channel is exactly when it is on screen.
//
// The fix: a polled entry gets the same expiry a socket event would arm. The
// poll re-arms it every few seconds for as long as they really are typing, so
// nothing is cut short.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { bootRenderer, settle, $ } from './helpers/renderer.js';

const ME = { id: 1, username: 'Me', role: 'member' };

const POST = {
    id: 1, body: 'hello', name: 'Me', client_id: 'me', user_id: 1,
    created_at: 1700000000000, reactions: [], pinned: 0, reply_count: 0
};

// Who the POLL reports as typing. A test moves this the way the server would.
let polled = [];

const board = vi.fn(async (p) => {
    if (p === 'list') {
        return {
            success: true, posts: [POST], typing: polled, voice: [],
            hasMore: false, maxId: 1
        };
    }
    if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
    if (p === 'presence') return { success: true, members: [] };
    if (p === 'dm/threads') return { success: true, threads: [] };
    return { success: true };
});

const ALICE = { client_id: 'alice', name: 'Alice' };

const line = () => ($('typing-line').textContent || '').trim();

let app;
beforeEach(async () => {
    polled = [];
    board.mockClear();
    app = await bootRenderer({ board, user: ME });
    // The socket is down: this is the state the poll is the fallback for.
    app.rtStatus(false);
    await settle();
});

describe('a typist the poll introduced', () => {
    it('is shown while the poll keeps reporting them', async () => {
        polled = [ALICE];
        app.resync();                      // forces a list fetch
        await settle(20);
        expect(line()).toContain('Alice');
    });

    it('goes away on its own once the poll stops reporting them', async () => {
        vi.useFakeTimers();
        try {
            polled = [ALICE];
            app.resync();
            await vi.advanceTimersByTimeAsync(50);
            expect(line()).toContain('Alice');

            // Alice stopped. Nothing else happens — no further poll, no socket.
            await vi.advanceTimersByTimeAsync(7000);
            expect(line()).toBe('');
        } finally {
            vi.useRealTimers();
        }
    });

    it('goes away after the socket comes back, which used to strand it forever', async () => {
        vi.useFakeTimers();
        try {
            polled = [ALICE];
            app.resync();
            await vi.advanceTimersByTimeAsync(50);
            expect(line()).toContain('Alice');

            // The socket reconnects, and Alice stopped typing while it was down.
            // From here there is nothing that can report her stopping: the socket
            // will not replay a row it never sent, and the poll's answer is no
            // longer allowed to overwrite the live set.
            polled = [];
            app.rtStatus(true);
            await vi.advanceTimersByTimeAsync(7000);

            expect(line(), 'Alice is typing, forever').toBe('');
        } finally {
            vi.useRealTimers();
        }
    });

    it('is not cut short while they are still typing', async () => {
        vi.useFakeTimers();
        try {
            polled = [ALICE];
            app.resync();
            await vi.advanceTimersByTimeAsync(50);

            // Still typing four seconds later, and the poll says so again —
            // which has to re-arm the expiry rather than let it lapse.
            app.resync();
            await vi.advanceTimersByTimeAsync(4000);
            app.resync();
            await vi.advanceTimersByTimeAsync(4000);

            expect(line()).toContain('Alice');
        } finally {
            vi.useRealTimers();
        }
    });
});
