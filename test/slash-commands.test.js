// @vitest-environment jsdom
//
// SLASH COMMANDS, and the guardrail that matters more than they do.
//
// A slash is an ordinary character. It is in every URL, every POSIX path, every
// date written the short way and most regular expressions — so the question a
// command system has to answer correctly is not "does /mute work" but "does
// everything that merely CONTAINS a slash still reach the channel exactly as it
// was typed". Both halves are pinned here, the second one harder than the first.
//
// The rule: the '/' must be the first character of the whole box, the box must
// be one line, and what follows must be a single bare word (optionally then a
// space and an argument). "/home/user" fails on the second slash; "and/or"
// fails on the first character; a fenced code block can never qualify because
// it opens with backticks.
//
// The menu itself is the @mention popup — same element, same keys, same
// styling — with commands filling it instead of names.
import { describe, it, expect, vi } from 'vitest';
import { bootRenderer, settle, type, cmEditor, $ } from './helpers/renderer.js';

const ME = { id: 1, username: 'Me', role: 'member' };
const ALICE = { id: 2, username: 'Alice', role: 'member' };

const router = () => vi.fn(async (route) => {
    const p = String(route).split('?')[0];
    if (p === 'list') return { success: true, posts: [], typing: [], voice: [], hasMore: false };
    if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
    if (p === 'presence') {
        return { success: true, members: [{ client_id: 'alice', user_id: 2, name: 'Alice', status: 'online', custom: '' }] };
    }
    if (p === 'account/users') return { success: true, users: [ME, ALICE] };
    if (p === 'dm/threads') return { success: true, threads: [] };
    if (p === 'dm/create') return { success: true, thread: { id: 7, title: 'Alice', members: [ME, ALICE], isGroup: false, user: ALICE } };
    if (p === 'dm/list') return { success: true, thread: { id: 7, members: [ME, ALICE], isGroup: false }, messages: [] };
    return { success: true };
});

// A voice double that records the toggles, since the shared one has neither.
// State in a CLOSURE, not on the object: bootRenderer merges this over its own
// double, so `this` inside a method is the merged copy and a field set on the
// original afterwards would never be seen.
const voiceDouble = () => {
    const calls = [];
    let joined = false;
    return {
        calls,
        join: () => { joined = true; },
        isJoined: () => joined,
        toggleMuted() { calls.push('mute'); },
        toggleDeafened() { calls.push('deafen'); },
        leave() { calls.push('leave'); }
    };
};

// Type into the composer the way a person does. NOT setValue: that leaves the
// caret wherever CodeMirror decides, and the mention half of the popup is a
// question about the text in front of the caret. An insert carrying the '+input'
// origin is what a keystroke looks like from the app's side, and it leaves the
// caret after what was typed.
function put(text) {
    const cm = cmEditor();
    cm.setValue('');
    cm.replaceRange(String(text), { line: 0, ch: 0 }, null, '+input');
    return cm;
}

const popOpen = () => {
    const pop = document.querySelector('.mention-pop');
    return !!(pop && !pop.hidden);
};
const popLabels = () => Array.from(document.querySelectorAll('.mention-pop .mention-title'))
    .map((s) => s.textContent);

const sent = (board) => board.mock.calls
    .filter((c) => c[0] === 'post')
    .map((c) => c[1].body.body);

// Enter in the message box — which is what runs a command, because the menu is
// open and the menu owns Enter. Dispatched on CodeMirror's own input field, the
// element every keystroke in this composer actually lands on.
async function pressEnter() {
    cmEditor().getInputField().dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle(4);
}

describe('the command menu', () => {
    it('opens on a bare slash in an empty box, listing every command', async () => {
        await bootRenderer({ user: ME, board: router() });

        put('/');
        await settle(2);

        expect(popOpen()).toBe(true);
        expect(popLabels()).toEqual(expect.arrayContaining([
            '/profile', '/settings', '/dm [user]', '/mute', '/deafen', '/leave', '/theme', '/shrug'
        ]));
    });

    it('filters as the command is typed', async () => {
        await bootRenderer({ user: ME, board: router() });

        put('/set');
        await settle(2);

        expect(popLabels()).toEqual(['/settings']);
    });

    it('shows the command and its description', async () => {
        await bootRenderer({ user: ME, board: router() });

        put('/shr');
        await settle(2);

        const sub = document.querySelector('.mention-pop .mention-sub');
        expect(sub.textContent).toContain('¯\\_(ツ)_/¯');
    });

    it('closes when nothing matches, so Enter can send the line', async () => {
        await bootRenderer({ user: ME, board: router() });

        put('/notacommand');
        await settle(2);

        expect(popOpen()).toBe(false);
    });
});

describe('the literal-slash guardrail', () => {
    const cases = [
        ['a URL', 'see https://example.com/x'],
        ['a URL on its own', 'https://example.com/mute'],
        ['a POSIX path', '/home/user/notes.txt'],
        ['an etc path', '/etc/hosts'],
        ['a Windows path', 'C:\\Users\\scarm'],
        ['a slash mid-sentence', 'and/or, 24/7'],
        ['a date', '10/08/2026'],
        ['a fenced code block', '```\n/mute\n```'],
        ['a multi-line message that opens with a slash', '/mute\nis a command i wish i had']
    ];

    for (const [what, text] of cases) {
        it('leaves ' + what + ' alone', async () => {
            const board = router();
            await bootRenderer({ user: ME, board });

            put(text);
            await settle(2);
            expect(popOpen(), 'the menu opened over ' + what).toBe(false);

            board.mockClear();
            $('composer').requestSubmit();
            await settle(4);
            expect(sent(board)).toEqual([text]);
        });
    }

    it('sends /something that is not a command as an ordinary message', async () => {
        const board = router();
        await bootRenderer({ user: ME, board });

        put('/notacommand please');
        await settle(2);
        board.mockClear();
        $('composer').requestSubmit();
        await settle(4);

        expect(sent(board)).toEqual(['/notacommand please']);
    });
});

describe('running a command', () => {
    it('runs it instead of sending it, and empties the box', async () => {
        const board = router();
        await bootRenderer({ user: ME, board });

        put('/settings');
        await settle(2);
        board.mockClear();
        await pressEnter();

        expect(sent(board)).toEqual([]);
        expect($('settings').hidden).toBe(false);
        expect(cmEditor().getValue()).toBe('');
    });

    it('/profile opens your own profile card', async () => {
        await bootRenderer({ user: ME, board: router() });

        put('/profile');
        await settle(2);
        await pressEnter();

        expect($('profile-card').hidden).toBe(false);
        expect($('pc-name').textContent).toBe('Me');
    });

    it('/shrug leaves the shrug in the box rather than sending it', async () => {
        const board = router();
        await bootRenderer({ user: ME, board });

        put('/shrug');
        await settle(2);
        board.mockClear();
        await pressEnter();

        expect(sent(board)).toEqual([]);
        expect(cmEditor().getValue()).toBe('¯\\_(ツ)_/¯');
    });

    it('/mute and /deafen toggle the microphone, once in a call', async () => {
        const voice = voiceDouble();
        await bootRenderer({ user: ME, board: router(), voice });
        voice.join();

        put('/mute');
        await settle(2);
        await pressEnter();

        put('/deafen');
        await settle(2);
        await pressEnter();

        expect(voice.calls).toEqual(['mute', 'deafen']);
    });

    it('says so rather than doing nothing when there is no call', async () => {
        const voice = voiceDouble();      // isJoined() -> false
        await bootRenderer({ user: ME, board: router(), voice });

        put('/mute');
        await settle(2);
        await pressEnter();

        expect(voice.calls).toEqual([]);
        expect($('toast').textContent).toContain('Join voice first');
    });

    it('/dm names a member and opens the conversation', async () => {
        const board = router();
        await bootRenderer({ user: ME, board });

        put('/dm Alice');
        await settle(2);
        // With an argument typed, the menu offers exactly the one command.
        expect(popLabels()).toEqual(['/dm [user]']);

        await pressEnter();
        await settle(4);

        const opened = board.mock.calls.filter((c) => c[0] === 'dm/create');
        expect(opened).toHaveLength(1);
        expect(sent(board)).toEqual([]);
    });

    it('/dm with a name nobody has says so', async () => {
        const board = router();
        await bootRenderer({ user: ME, board });

        put('/dm nobody');
        await settle(2);
        await pressEnter();

        expect($('toast').textContent).toContain('No member called');
        expect(sent(board)).toEqual([]);
    });
});

describe('@mentions', () => {
    it('still work, in the popup the commands now share', async () => {
        await bootRenderer({ user: ME, board: router() });
        await settle(4);

        put('@Ali');
        await settle(2);

        expect(popOpen()).toBe(true);
        expect(popLabels()).toEqual(['Alice']);
    });
});
