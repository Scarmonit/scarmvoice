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
//
// ---- scenes -------------------------------------------------------------
// The shell is what is on screen at rest, and it was always the cheap part:
// seven components, described once. The expensive part is everything that is
// NOT on screen — menus, popovers, tooltips, modals, the settings tree — which
// is why those are the ones that have only ever been described in prose.
//
// Those live in SCENES, keyed by whatever opens them: scenes.cjs drives the
// reference, window.scene drives the harness. A scene's targets are merged
// over the shell's by __targets.for(), so both sides always sweep the same
// names.

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

    // Anything scrolled out of the viewport measures fine and means nothing.
    // messageAuthor used a plain querySelector, which returns the FIRST match
    // in the DOM — in a scrolled channel that was a name 3504px above the top
    // of the window. It came back with a box, a colour and a font like any
    // other row, and not one of those numbers described anything visible.
    const inView = (e) => {
        if (!e) return false;
        const r = e.getBoundingClientRect();
        return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth
            && r.width > 0 && r.height > 0;
    };
    // The last one still on screen — nearest the composer, which is the message
    // someone is looking at when they describe it.
    const lastVisible = (sel) => all(sel).filter(inView).pop() || null;

    // Discord portals every transient layer to the end of <body>. The role is
    // the stable part; the class beside it is hashed and rotates on deploy.
    const layer = (role) => all('[role="' + role + '"]')
        .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 20 && r.height > 20; })
        .pop();

    const labelled = (rx) => all('[aria-label]')
        .find((e) => rx.test(e.getAttribute('aria-label') || '') && inView(e));

    // ---- the shell, as it sits at rest -------------------------------------
    const discord = {
        rail: () => byRect((r) => r.x < 4 && r.width > 60 && r.width < 90 && r.height > innerHeight * 0.7),
        sidebar: () => byRect((r, e) => r.x > 60 && r.x < 90 && r.width > 240 && r.height > innerHeight * 0.7 && painted(e)),
        chat: () => byRect((r, e) => r.x > 300 && r.width > innerWidth * 0.4 && r.height > innerHeight * 0.7 && painted(e)),
        // Widened from 200-300. Whether the panel is OPEN is a different
        // question from whether the finder can see it — run the members scene
        // first, or a collapsed panel reports identically to a broken finder.
        memberList: () => byRect((r, e) => r.x > innerWidth * 0.6 && r.width > 180 && r.width < 340
            && r.height > innerHeight * 0.5 && painted(e)),
        channelHeader: () => byRect((r) => r.y < 60 && r.height > 40 && r.height < 60 && r.width > innerWidth * 0.5),
        userPanel: () => byRect((r, e) => r.y > innerHeight - 150 && r.x < 20 && r.width > 300 && r.height < 90 && painted(e)),
        composer: () => byRect((r, e) => r.y > innerHeight - 160 && r.width > innerWidth * 0.4 && r.height > 40 && r.height < 90 && painted(e)),

        // ------------------------------------------------------------- rail
        railServerActive: () => all('[data-list-item-id*="guildsnav"]').filter(inView)
            .find((e) => e.querySelector('[class*="pill"], [class*="item"]')) || null,
        railHome: () => labelled(/^Direct Messages$|^Home$/),
        railAddServer: () => labelled(/^Add a Server$/),

        // ---------------------------------------------------------- sidebar
        categoryLabel: () => byText('Text Channels'),
        activeChannel: () => all('[data-list-item-id*="channels"]').filter(inView).find(painted),
        channelName: () => byText('general'),
        channelIcon: () => {
            const row = all('[data-list-item-id*="channels"]').filter(inView).find(painted);
            return row ? row.querySelector('svg') : null;
        },

        // --------------------------------------------------------- messages
        // The viewport filter and .pop() together: the newest message that is
        // actually on screen.
        messageBody: () => lastVisible('[id^="message-content-"]'),
        messageAuthor: () => lastVisible('[class*="username"]'),
        messageTime: () => lastVisible('time'),
        messageAvatar: () => lastVisible('img[class*="avatar"]'),
        messageGroup: () => lastVisible('li[id^="chat-messages-"]'),
        daySeparator: () => all('div,span').filter(inView)
            .find((e) => /^\w+ \d{1,2}, \d{4}$/.test((e.textContent || '').trim())
                && e.getBoundingClientRect().width < 220),
        reaction: () => lastVisible('[class*="reaction"][role="button"]'),
        link: () => lastVisible('[id^="message-content-"] a'),
        codeBlock: () => lastVisible('[id^="message-content-"] code'),
        mention: () => lastVisible('[class*="mention"]'),

        // --------------------------------------------------------- controls
        // Anchored to the accessible name rather than an absolute x, which
        // moved the moment the sidebar width changed.
        muteButton: () => labelled(/^Mute$|^Unmute$/),
        deafenButton: () => labelled(/^Deafen$|^Undeafen$/),
        settingsButton: () => labelled(/^User Settings$/),
        pinnedButton: () => labelled(/^Pinned Messages$/),
        membersButton: () => labelled(/Member List$/),
        searchButton: () => all('input[placeholder*="Search" i], [role="combobox"]').filter(inView).pop(),

        // --------------------------------------------------------- composer
        composerInput: () => all('[role="textbox"]').filter(inView).pop(),
        attachButton: () => labelled(/^Upload a File$|attach/i),
        emojiButton: () => labelled(/^Select emoji$|^Emoji$/)
    };

    const app = {
        rail: '#rail',
        sidebar: '#sidebar',
        chat: '#main',
        memberList: '#members-panel',
        channelHeader: '#chan-head',
        userPanel: '#user-dock',
        composer: '.composer-row',

        railServerActive: '.rail-server.active, .rail-server',
        railHome: '.rail-btn',
        railAddServer: '#btn-add-channel',

        categoryLabel: '#cat-text span',
        activeChannel: '.chan.active',
        channelName: '.chan.active .chan-name',
        channelIcon: '.chan.active svg',

        messageBody: '.msg-text',
        messageAuthor: '.msg-author',
        messageTime: '.msg-time',
        messageAvatar: '.msg-avatar',
        messageGroup: '.msg',
        daySeparator: '.day-sep span',
        reaction: '.reaction',
        link: '.msg-text a',
        codeBlock: '.msg-code',
        mention: '.msg-text .mention',

        muteButton: '#btn-mute',
        deafenButton: '#btn-deafen',
        settingsButton: '#btn-settings',
        pinnedButton: '#btn-pinned',
        membersButton: '#btn-members',
        searchButton: '#btn-search',

        composerInput: '#composer-input',
        attachButton: '#btn-attach',
        emojiButton: '#btn-emoji'
    };

    // ---- scenes ------------------------------------------------------------
    // Each of these has to be opened before it can be measured. That is the
    // entire reason they have been described by hand until now.
    const scenes = {
        members: {
            discord: {
                memberRow: () => all('[class*="member"][role="listitem"], [class*="memberInner"]').filter(inView).find(painted),
                memberName: () => {
                    const row = all('[class*="member"][role="listitem"]').filter(inView)[0];
                    return row ? row.querySelector('[class*="name"]') : null;
                },
                memberAvatar: () => all('[class*="member"] img[class*="avatar"]').filter(inView)[0] || null,
                roleHeader: () => all('h3,[class*="membersGroup"]').filter(inView)[0] || null
            },
            app: {
                memberRow: '#members-panel li.vp',
                memberName: '#members-panel li.vp .vl-face, #members-panel li.vp .name',
                memberAvatar: '#members-panel li.vp .avatar-img',
                roleHeader: '#members-panel .cat-head, #members-panel h3'
            }
        },

        contextMenu: {
            discord: {
                contextMenu: () => layer('menu'),
                contextMenuItem: () => {
                    const m = layer('menu');
                    return m ? m.querySelector('[role="menuitem"]') : null;
                },
                contextMenuDanger: () => {
                    const m = layer('menu');
                    if (!m) return null;
                    // The destructive entry is the one painted red. Finding it
                    // by its wording breaks the first time the wording changes.
                    return [...m.querySelectorAll('[role="menuitem"]')]
                        .find((i) => { const c = getComputedStyle(i).color; return /rgb\(2[0-9]{2},\s*[0-9]{1,2},/.test(c); }) || null;
                }
            },
            app: {
                contextMenu: '#ctx-menu',
                contextMenuItem: '#ctx-menu .ctx-item',
                contextMenuDanger: '#ctx-menu .ctx-item.danger'
            }
        },

        messageActions: {
            discord: {
                messageToolbar: () => labelled(/^Message Actions$/) || layer('group'),
                messageToolbarButton: () => {
                    const t = labelled(/^Message Actions$/);
                    return t ? t.querySelector('[role="button"],button') : null;
                }
            },
            app: {
                messageToolbar: '.msg-actions',
                messageToolbarButton: '.msg-actions .msg-act'
            }
        },

        userCard: {
            discord: {
                userCard: () => layer('dialog'),
                userCardName: () => {
                    const d = layer('dialog');
                    return d ? d.querySelector('h1,h2,[class*="nickname"],[class*="username"]') : null;
                },
                userCardAvatar: () => {
                    const d = layer('dialog');
                    return d ? d.querySelector('img[class*="avatar"]') : null;
                }
            },
            app: {
                userCard: '.popover, .me-pop',
                userCardName: '.pop-name',
                userCardAvatar: '.pop-avatar'
            }
        },

        tooltip: {
            discord: { tooltip: () => layer('tooltip') },
            app: { tooltip: '.tip' }
        },

        pinned: {
            discord: {
                pinnedPopout: () => layer('dialog') || layer('menu'),
                pinnedEmpty: () => {
                    const d = layer('dialog') || layer('menu');
                    return d ? d.querySelector('[class*="empty"], [class*="placeholder"]') : null;
                }
            },
            app: {
                pinnedPopout: '#pinned-pop, .popover',
                pinnedEmpty: '#pinned-pop .empty, .popover .empty'
            }
        },

        settings: {
            discord: {
                settingsSidebar: () => all('[role="tablist"][aria-orientation="vertical"], [class*="sidebarRegion"]').filter(inView).pop(),
                settingsTab: () => all('[role="tab"]').filter(inView)[0] || null,
                settingsTabActive: () => all('[role="tab"][aria-selected="true"]').filter(inView)[0] || null,
                settingsHeader: () => all('h1,h2').filter(inView)[0] || null
            },
            app: {
                settingsSidebar: '#set-nav, .set-nav',
                settingsTab: '.set-tab, .set-nav button',
                settingsTabActive: '.set-tab.active, .set-nav button.active',
                settingsHeader: '#set-body h2, .set-group > h2'
            }
        },

        emojiPicker: {
            discord: {
                emojiPicker: () => all('[class*="emojiPicker"]').filter(inView).pop() || layer('dialog'),
                emojiCategoryBar: () => {
                    const p = all('[class*="emojiPicker"]').filter(inView).pop() || layer('dialog');
                    return p ? p.querySelector('[role="tablist"]') : null;
                }
            },
            app: {
                emojiPicker: '#emoji-pop, .picker',
                emojiCategoryBar: '.picker-tabs, #emoji-pop .picker-tab'
            }
        }
    };

    window.__targets = { discord, app, scenes };

    // The shell, plus whatever a scene adds. Both capture scripts go through
    // this, so neither side can drift into sweeping a different set of names.
    window.__targets.for = function (side, scene) {
        const base = window.__targets[side] || {};
        const extra = (scene && window.__targets.scenes[scene] && window.__targets.scenes[scene][side]) || {};
        return Object.assign({}, base, extra);
    };

    return Object.keys(app).length + ' shell targets, ' + Object.keys(scenes).length + ' scenes';
}());
