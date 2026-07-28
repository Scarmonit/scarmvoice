// The correspondence map: one name, two ways to find it.
//
// This is the only part of the comparison that needs a person, and it only
// needs one once. Everything after it — colours, sizes, tooltips, hover
// behaviour, glyph geometry — falls out of the probe automatically, on both
// sides, forever.
//
// Discord's class names are hashed and change on every deploy, so its finders
// are written against geometry, text and roles instead. Ours are just
// selectors, because we own the markup.
//
// Adding a component to the sweep is two lines here.

(function () {
    'use strict';

    // ---- helpers for the Discord side --------------------------------------
    const all = (sel) => [...document.querySelectorAll(sel || '*')];
    const byText = (txt, within) => all(within || 'div,span,h1,h2,h3,button,a,li')
        .find((e) => (e.textContent || '').trim() === txt && e.children.length === 0);
    const byRect = (test) => all('div,nav,aside,section,main,header,form,ol,ul,li,button')
        .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4 && test(r, e); })
        // The deepest match wins: an outer wrapper usually has no fill of its own.
        .pop();
    const painted = (e) => e && getComputedStyle(e).backgroundColor !== 'rgba(0, 0, 0, 0)';

    window.__targets = {
        // ------------------------------------------------------------- shell
        discord: {
            rail: () => byRect((r) => r.x < 4 && r.width > 60 && r.width < 90 && r.height > innerHeight * 0.7),
            sidebar: () => byRect((r, e) => r.x > 60 && r.x < 90 && r.width > 240 && r.height > innerHeight * 0.7 && painted(e)),
            chat: () => byRect((r, e) => r.x > 300 && r.width > innerWidth * 0.4 && r.height > innerHeight * 0.7 && painted(e)),
            memberList: () => byRect((r, e) => r.x > innerWidth * 0.6 && r.width > 200 && r.width < 300 && r.height > innerHeight * 0.6 && painted(e)),
            channelHeader: () => byRect((r) => r.y < 60 && r.height > 40 && r.height < 60 && r.width > innerWidth * 0.5),
            userPanel: () => byRect((r, e) => r.y > innerHeight - 150 && r.x < 20 && r.width > 300 && r.height < 90 && painted(e)),
            composer: () => byRect((r, e) => r.y > innerHeight - 160 && r.width > innerWidth * 0.4 && r.height > 40 && r.height < 90 && painted(e)),

            // ------------------------------------------------------ sidebar
            categoryLabel: () => byText('Text Channels'),
            activeChannel: () => all('[data-list-item-id*="channels"]').find(painted),
            channelName: () => byText('general'),

            // ------------------------------------------------------ messages
            messageBody: () => [...document.querySelectorAll('[id^="message-content-"]')].pop(),
            messageAuthor: () => document.querySelector('[class*="username"]'),
            messageTime: () => document.querySelector('time'),
            daySeparator: () => all('div,span').find((e) => /^\w+ \d{1,2}, \d{4}$/.test((e.textContent || '').trim())
                && e.getBoundingClientRect().width < 220),

            // ------------------------------------------------------ controls
            muteButton: () => byRect((r, e) => r.y > innerHeight - 120 && r.width === 32 && r.height === 32
                && e.tagName === 'BUTTON' && r.x > 180 && r.x < 250)
        },

        app: {
            rail: '#rail',
            sidebar: '#sidebar',
            chat: '#main',
            memberList: '#members-panel',
            channelHeader: '#chan-head',
            userPanel: '#user-dock',
            composer: '.composer-row',

            categoryLabel: '#cat-text span',
            activeChannel: '.chan.active',
            channelName: '.chan.active .chan-name',

            messageBody: '.msg-text',
            messageAuthor: '.msg-author',
            messageTime: '.msg-time',
            daySeparator: '.day-sep span',

            muteButton: '#btn-mute'
        }
    };

    return Object.keys(window.__targets.app).length + ' targets';
}());
