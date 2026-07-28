// @vitest-environment jsdom
//
// Every prompt in this app shares ONE input (#dialog-input), and it is
// type=text with maxlength=60 unless the caller says otherwise. openDialog()
// resets both on every open for exactly that reason — "a password type left
// behind by the last caller would silently turn the next rename into dots".
//
// The reset cuts both ways, and three callers that ask for an ACCOUNT PASSWORD
// never said otherwise:
//
//   • setting up two-factor
//   • turning two-factor off
//   • an admin resetting someone else's password
//
// So each of them put the password on screen in plain text — in an application
// whose main feature is sharing your screen with the room — and truncated it at
// 60 characters, which is inside the range a password manager generates. The
// server then rejected a password that had been typed correctly, with nothing
// on screen to say why. runAccountRemoval() passes inputType/maxLength and gets
// both right, which is what these three were measured against.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { bootRenderer, settle, $ } from './helpers/renderer.js';

const ME = { id: 1, username: 'Me', role: 'admin', totp: false };
const OTHER = { id: 2, username: 'Alice', role: 'member' };

// bcrypt stops reading at 72 bytes, which is the cap the account-removal dialog
// already uses; anything shorter silently discards characters the user typed.
const PASSWORD_MAX = 72;

const board = vi.fn(async (p) => {
    if (p === 'account/users') return { success: true, users: [ME, OTHER] };
    if (p === 'account/twofactor') {
        return { success: true, secret: 'ABCDEF', otpauth: 'otpauth://totp/x' };
    }
    if (p === 'list') return { success: true, posts: [], typing: [], voice: [], hasMore: false };
    if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
    if (p === 'presence') return { success: true, members: [] };
    if (p === 'dm/threads') return { success: true, threads: [] };
    return { success: true };
});

const dialogOpen = () => !$('dialog').hidden;
const dialogTitle = () => $('dialog-title').textContent;

function submitDialog(value) {
    $('dialog-input').value = value;
    $('dialog-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}

function cancelDialog() {
    $('dialog-cancel').click();
}

// Every password prompt has to agree on both, or one of them is the odd one out
// again next time somebody adds a fourth.
function expectPasswordField() {
    expect(dialogOpen()).toBe(true);
    expect($('dialog-input').hidden).toBe(false);
    expect($('dialog-input').type).toBe('password');
    expect($('dialog-input').maxLength).toBe(PASSWORD_MAX);
}

beforeAll(async () => {
    await bootRenderer({ board, user: ME });
    $('btn-settings').click();
    await settle();
});

describe('setting up two-factor', () => {
    it('asks for the account password as a password', async () => {
        $('btn-acct-2fa').click();
        await settle();
        expect(dialogTitle()).toBe('Confirm your password');
        expectPasswordField();
        cancelDialog();
        await settle();
    });
});

describe('turning two-factor off', () => {
    beforeAll(async () => {
        // Get the account into the 2FA-on state the way the UI does, so the
        // disable branch is reachable without reaching into the closure.
        $('btn-acct-2fa').click();
        await settle();
        submitDialog('correct horse battery staple');   // the setup password
        await settle();
        $('acct-2fa-code').value = '123456';
        $('btn-acct-2fa-confirm').click();
        await settle();
    });

    it('asks for the authenticator code as ordinary text', async () => {
        $('btn-acct-2fa').click();
        await settle();
        expect(dialogTitle()).toBe('Turn off two-factor?');
        // A six-digit code that is about to be typed from a phone screen is not
        // a secret to hide from its owner, and hiding it only causes typos.
        expect($('dialog-input').type).toBe('text');
    });

    it('then asks for the account password as a password', async () => {
        submitDialog('123456');
        await settle();
        expect(dialogTitle()).toBe('Confirm your password');
        expectPasswordField();
        cancelDialog();
        await settle();
    });
});

describe('an admin resetting a member password', () => {
    it('does not put the new password on screen', async () => {
        const row = Array.from($('member-admin-list').querySelectorAll('.ma-row'))
            .find((r) => r.textContent.includes(OTHER.username));
        expect(row).toBeTruthy();
        const reset = Array.from(row.querySelectorAll('button'))
            .find((b) => b.textContent === 'Reset password');
        expect(reset).toBeTruthy();

        reset.click();
        await settle();
        expect(dialogTitle()).toBe(`New password for ${OTHER.username}`);
        expectPasswordField();
        cancelDialog();
        await settle();
    });
});

describe('a prompt that is not a password', () => {
    it('still gets a plain text field, so the reset works both ways', async () => {
        // The same field, one caller later. If openDialog stopped resetting,
        // renaming a channel would be typed into dots.
        $('btn-add-channel').click();
        await settle();
        expect(dialogTitle()).toBe('Create a channel');
        expect($('dialog-input').type).toBe('text');
        expect($('dialog-input').maxLength).toBe(60);
        cancelDialog();
        await settle();
    });
});
