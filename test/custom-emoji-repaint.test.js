// @vitest-environment jsdom
//
// Removing a custom emoji has to repaint the messages that use it.
//
// renderMessages() diffs the list against the DOM by a per-message SIGNATURE
// and keeps any row whose signature has not moved — which is the whole reason
// scroll position, in-flight image loads and grafted link previews survive a
// poll. A custom emoji is not part of the post, so it was not in that
// signature: the renderMessages() sitting immediately after every mutation of
// the emoji map repainted precisely nothing.
//
// Removing an emoji deletes its R2 object, so every message already on screen
// went on pointing an <img> at a key that no longer resolves — a broken image
// in the conversation, for the rest of the session or until the channel was
// switched. Adding one had the mirror-image failure: `:name:` stayed as text.
import { describe, it, expect, vi } from 'vitest';
import { bootRenderer, $, settle } from './helpers/renderer.js';

const ME = { id: 1, username: 'Me', role: 'member' };

function boardRouter(state) {
    return vi.fn(async (p, opts) => {
        if (p === 'channels') return { success: true, channels: [{ name: 'general', unread: 0 }] };
        if (p === 'list') {
            return {
                success: true, hasMore: false, maxId: 5,
                posts: [{
                    id: 5, channel: 'general', client_id: 'them', user_id: 2,
                    name: 'Ann', body: 'nice :shrug:', created_at: 1700000000000,
                    pinned: 0, reply_count: 0, reactions: []
                }]
            };
        }
        if (p === 'emoji') {
            if (opts && opts.method === 'DELETE') { state.emoji = []; return { success: true }; }
            return { success: true, emoji: state.emoji };
        }
        if (p === 'avatars') return { success: true, avatars: {} };
        return { success: true };
    });
}

describe('custom emoji', () => {
    it('repaints loaded messages when one is removed', async () => {
        // Owned by this account, so the admin list offers the remove button.
        const state = { emoji: [{ name: 'shrug', key: 'e/shrug.png', user_id: 1, created_by: 'Me' }] };
        await bootRenderer({ board: boardRouter(state), user: ME });

        const msg = $('messages').querySelector('.msg .msg-text');
        expect(msg).toBeTruthy();
        expect(msg.querySelector('img.cemoji')).toBeTruthy();
        expect(msg.textContent).not.toContain(':shrug:');

        // Through the real flow: Settings → the emoji row's bin → confirm.
        $('btn-settings').dispatchEvent(new window.Event('click', { bubbles: true }));
        await settle();

        const del = $('set-emoji').querySelector('button.danger');
        expect(del).toBeTruthy();
        del.dispatchEvent(new window.Event('click', { bubbles: true }));
        await settle();

        expect($('dialog').hidden).toBe(false);
        $('dialog-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
        await settle();

        const after = $('messages').querySelector('.msg .msg-text');
        expect(after.querySelector('img.cemoji')).toBeNull();
        expect(after.textContent).toContain(':shrug:');
    });
});
