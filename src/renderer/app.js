// ScarmVoice — renderer controller.
//
// Talks to the board exclusively through window.lounge (see main/preload.js);
// there is no direct network access from this context. Live signals arrive on
// the realtime socket, with HTTP polling kept as a fallback exactly like the
// website does — if the socket is down, everything still works, just slower.
(function () {
    'use strict';

    const L = window.lounge;
    const $ = (id) => document.getElementById(id);

    const POLL_ACTIVE_MS = 4000;    // socket down → poll this often
    const POLL_IDLE_MS = 15000;     // socket up → slow safety-net poll
    const PRESENCE_MS = 5000;       // voice presence heartbeat (server TTL is 12s)
    const TYPING_MS = 3000;
    const PAGE = 40;

    let settings = {};
    let channels = [];
    let channel = 'general';
    let posts = [];
    let hasMore = false;
    let reads = {};                 // channel -> last read post id
    let voicePresence = [];         // server-side "who is in voice", incl. web users
    let typingUsers = [];
    let rtConnected = false;
    let voice = null;
    let speaking = {};              // cid -> bool
    let pollTimer = null;
    let presenceTimer = null;
    let typingSentAt = 0;
    let windowFocused = true;
    let loading = false;
    let lastSoundId = 0;            // watermark so one message chimes exactly once
    let filterTimer = null;
    let filterScrollTop = null;      // scroll position to restore when filters clear
    // Active message filters. Types combine as OR; every other criterion is AND.
    const filter = {
        text: '',
        types: new Set(),           // 'links' | 'images' | 'videos' | 'audio' | 'files'
        pinned: false,
        mentions: false,
        edited: false,
        fromIds: null,              // every client_id belonging to the chosen person
        fromName: null
    };
    function filterActive() {
        return !!(filter.text || filter.types.size || filter.pinned ||
            filter.mentions || filter.edited || filter.fromIds);
    }

    // ---------- utilities -------------------------------------------------

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // Deterministic avatar colour from a name, so the same person is always the
    // same colour on every machine.
    function hueOf(str) {
        let h = 0;
        for (let i = 0; i < String(str).length; i++) h = (h * 31 + String(str).charCodeAt(i)) % 360;
        return h;
    }
    function avatarStyle(name) {
        const h = hueOf(name || '?');
        return `background:linear-gradient(135deg,hsl(${h},70%,62%),hsl(${(h + 40) % 360},75%,52%))`;
    }
    function initials(name) {
        const n = String(name || '?').trim();
        const parts = n.split(/\s+/).filter(Boolean);
        if (!parts.length) return '?';
        if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
        return (parts[0][0] + parts[1][0]).toUpperCase();
    }

    function timeStr(ms) {
        const d = new Date(ms);
        return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }
    function dayStr(ms) {
        const d = new Date(ms);
        const today = new Date();
        const yest = new Date(Date.now() - 86400000);
        const same = (a, b) => a.toDateString() === b.toDateString();
        if (same(d, today)) return 'Today';
        if (same(d, yest)) return 'Yesterday';
        return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
    }

    let toastTimer = null;
    function toast(msg, isError) {
        const el = $('toast');
        el.textContent = msg;
        el.classList.toggle('err', !!isError);
        el.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 5200 : 2600);
    }

    // Linkify + escape in one pass. Escaping happens first, so no markup from a
    // message body can ever reach the DOM.
    function renderText(body) {
        const safe = esc(body);
        return safe.replace(/https?:\/\/[^\s<]+/g, (url) =>
            `<a href="${url}" data-external="1">${url}</a>`);
    }

    // ---------- chat font size --------------------------------------------
    // One CSS variable drives the whole message body — text, names, timestamps
    // and avatars are all sized in em against it, so they scale together.

    const FONT_SIZES = [
        { key: 'small', px: 13, label: 'Small' },
        { key: 'medium', px: 15, label: 'Medium' },
        { key: 'large', px: 18, label: 'Large' },
        { key: 'xlarge', px: 21, label: 'Extra Large' }
    ];

    function fontSizeIndex(key) {
        const i = FONT_SIZES.findIndex((f) => f.key === key);
        return i === -1 ? 1 : i;                     // default to medium
    }

    function applyChatFontSize(key) {
        const f = FONT_SIZES[fontSizeIndex(key)];
        document.documentElement.style.setProperty('--chat-fs', f.px + 'px');
        const sel = $('set-font-size');
        if (sel) sel.value = f.key;
        return f;
    }

    // step: -1 smaller, +1 larger, 0 reset to medium.
    async function stepChatFontSize(step) {
        const current = fontSizeIndex(settings.chatFontSize);
        const next = step === 0
            ? fontSizeIndex('medium')
            : Math.max(0, Math.min(FONT_SIZES.length - 1, current + step));
        if (next === current && step !== 0) {
            return toast(`Already at ${FONT_SIZES[current].label}`);
        }
        const f = FONT_SIZES[next];
        await saveSettings({ chatFontSize: f.key });
        applyChatFontSize(f.key);
        toast(`Chat font: ${f.label}`);
    }

    // ---------- dialogs ---------------------------------------------------
    // Electron has no window.prompt(), and window.confirm() blocks the whole
    // renderer, so both are replaced with an in-app modal.

    let dialogDone = null;

    function openDialog({ title, message, value, ok, danger, withInput }) {
        return new Promise((resolve) => {
            dialogDone = resolve;
            $('dialog-title').textContent = title;
            const msg = $('dialog-msg');
            msg.textContent = message || '';
            msg.hidden = !message;
            const inp = $('dialog-input');
            inp.hidden = !withInput;
            inp.value = value || '';
            $('dialog-ok').textContent = ok || 'OK';
            $('dialog-ok').classList.toggle('danger', !!danger);
            $('dialog').hidden = false;
            if (withInput) { inp.focus(); inp.select(); } else $('dialog-ok').focus();
        });
    }

    function closeDialog(result) {
        $('dialog').hidden = true;
        const done = dialogDone;
        dialogDone = null;
        if (done) done(result);
    }

    // Resolves to the entered string, or null if cancelled.
    function askText(title, value, ok) {
        return openDialog({ title, value, ok, withInput: true });
    }
    // Resolves true/false.
    function askConfirm(title, message, ok, danger) {
        return openDialog({ title, message, ok, danger, withInput: false });
    }

    $('dialog-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const inp = $('dialog-input');
        closeDialog(inp.hidden ? true : inp.value);
    });
    $('dialog-cancel').addEventListener('click', () => closeDialog(inp_null()));
    function inp_null() { return $('dialog-input').hidden ? false : null; }
    $('dialog').addEventListener('mousedown', (e) => {
        if (e.target === $('dialog')) closeDialog(inp_null());
    });

    // ---------- settings --------------------------------------------------

    async function saveSettings(patch) {
        settings = await L.settings.set(patch);
        if (voice) voice.setSettings(settings);
        if (window.loungeSounds) window.loungeSounds.setSettings(settings);
        return settings;
    }

    // ---------- auth ------------------------------------------------------

    async function boot() {
        settings = await L.settings.get();
        $('login-base').value = settings.baseUrl || '';
        $('login-name').value = settings.displayName || '';
        $('set-version').textContent = 'ScarmVoice v' + (await L.app.version());

        const st = await L.auth.status();
        if (st.authed) {
            enterApp();
        } else {
            $('login').hidden = false;
            if (st.offline) $('login-sub').textContent = 'Could not reach the server — check the URL below.';
            $('login-pw').focus();
        }
    }

    $('login-advanced').addEventListener('click', () => {
        const box = $('login-advanced-box');
        box.hidden = !box.hidden;
    });

    $('login-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = $('login-btn');
        const err = $('login-error');
        const base = $('login-base').value.trim();
        const name = $('login-name').value.trim();

        err.textContent = '';
        btn.disabled = true;
        btn.textContent = 'Connecting…';

        if (base && base !== settings.baseUrl) await saveSettings({ baseUrl: base.replace(/\/+$/, '') });
        if (name) await saveSettings({ displayName: name });

        const res = await L.auth.login($('login-pw').value);
        btn.disabled = false;
        btn.textContent = 'Connect';

        if (res && res.success) {
            $('login-pw').value = '';
            $('login').hidden = true;
            enterApp();
            return;
        }
        err.textContent = (res && res.error) || 'Could not sign in.';
        $('login-form').classList.add('shake');
        setTimeout(() => $('login-form').classList.remove('shake'), 420);
        $('login-pw').value = '';
        $('login-pw').focus();
    });

    async function enterApp() {
        settings = await L.settings.get();
        if (!settings.displayName) {
            const n = ($('login-name').value || '').trim();
            if (n) await saveSettings({ displayName: n });
        }
        $('login').hidden = true;
        $('app').hidden = false;
        $('btn-send').disabled = true;

        channel = settings.channel || 'general';
        try { reads = JSON.parse(localStorage.getItem('lounge_reads') || '{}'); } catch (e) { reads = {}; }

        applyChatFontSize(settings.chatFontSize);
        warnIfElevated();
        window.loungeSounds.init(settings);
        setupVoice();
        renderMe();
        await L.rt.start();
        await loadChannels();
        await loadMessages(true);
        startPolling();
        await L.ptt.apply();
        refreshPttHint();

        if (settings.autoJoinVoice) joinVoice();
    }

    // ---------- channels --------------------------------------------------

    async function loadChannels(extra) {
        const body = Object.assign({ reads, clientId: settings.clientId }, extra || {});
        const res = await L.board('channels', { method: 'POST', body });
        if (res && res.needsAuth) return relogin();
        if (!res || !res.success) return;
        channels = res.channels || [];
        renderChannels();
    }

    function renderChannels() {
        const list = $('channel-list');
        list.innerHTML = '';
        channels.forEach((c) => {
            const b = document.createElement('button');
            b.className = 'chan' + (c.name === channel ? ' active' : '');
            b.dataset.channel = c.name;
            const unread = c.name === channel ? 0 : (c.unread || 0);
            b.innerHTML = `<span class="hash">#</span><span class="chan-name">${esc(c.name)}</span>` +
                (unread ? `<span class="unread">${unread > 99 ? '99+' : unread}</span>` : '');
            b.addEventListener('click', () => switchChannel(c.name));
            list.appendChild(b);
        });
    }

    async function switchChannel(name) {
        if (name === channel) return;
        channel = name;
        await saveSettings({ channel: name });
        $('chan-title').textContent = '# ' + name;
        $('composer-input').placeholder = 'Message #' + name;
        posts = [];
        following = true;
        seenTopId = 0;
        renderMessages();
        renderChannels();
        await loadMessages(true);
    }

    $('btn-add-channel').addEventListener('click', async () => {
        const name = await askText('Create a channel', '', 'Create');
        if (!name) return;
        await loadChannels({ create: name });
        const clean = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 24);
        if (clean) switchChannel(clean);
    });

    $('btn-rename-channel').addEventListener('click', async () => {
        if (channel === 'general') return toast('#general cannot be renamed', true);
        const name = await askText('Rename #' + channel, channel, 'Rename');
        if (!name || name === channel) return;
        const res = await L.board('channels', {
            method: 'POST', body: { rename: name, from: channel, clientId: settings.clientId, reads }
        });
        if (!res || !res.success) return toast((res && res.error) || 'Rename failed', true);
        channels = res.channels || channels;
        const clean = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 24);
        channel = clean;
        $('chan-title').textContent = '# ' + channel;
        renderChannels();
        loadMessages(true);
    });

    $('btn-delete-channel').addEventListener('click', async () => {
        if (channel === 'general') return toast('#general cannot be deleted', true);
        const yes = await askConfirm(
            `Delete #${channel}?`,
            'Every message and attachment in this channel will be permanently removed. This cannot be undone.',
            'Delete', true
        );
        if (!yes) return;
        const gone = channel;
        const res = await L.board('channels', {
            method: 'POST', body: { remove: gone, clientId: settings.clientId, reads }
        });
        if (!res || !res.success) return toast((res && res.error) || 'Delete failed', true);
        channels = res.channels || [];
        channel = 'general';
        $('chan-title').textContent = '# general';
        renderChannels();
        loadMessages(true);
    });

    // ---------- messages --------------------------------------------------

    async function loadMessages(scrollToEnd, before) {
        if (loading) return;
        loading = true;
        const res = await L.board('list', {
            query: { channel, limit: PAGE, before: before || null }
        });
        loading = false;

        if (res && res.needsAuth) return relogin();
        if (!res || !res.success) {
            if (res && res.network && !rtConnected) setRtStatus('disconnected');
            return;
        }

        // Watermark BEFORE the merge so we can tell which posts are genuinely new.
        const prevMax = posts.length ? posts[posts.length - 1].id : 0;

        if (before) {
            const seen = new Set(posts.map((p) => p.id));
            posts = (res.posts || []).filter((p) => !seen.has(p.id)).concat(posts);
        } else {
            // A refresh only speaks for the newest page. Older history someone
            // paged back to stays put — dropping it would yank them out of the
            // part of the conversation they're reading.
            const fresh = res.posts || [];
            const oldest = fresh.length ? fresh[0].id : Infinity;
            posts = posts.filter((p) => p.id < oldest).concat(fresh);
        }

        // Chime + notify for messages from other people, exactly where the
        // website does it. prevMax > 0 skips the very first load of a channel.
        if (!before && prevMax > 0) {
            const fresh = posts.filter((p) => p.id > prevMax && p.client_id !== settings.clientId);
            if (fresh.length) {
                // Poll and socket nudge can both see the same post as fresh;
                // the id watermark guarantees a single chime.
                const maxFreshId = fresh[fresh.length - 1].id;
                if (maxFreshId > lastSoundId) {
                    lastSoundId = maxFreshId;
                    window.loungeSounds.playMessage();
                }
                notifyForPosts(fresh);
            }
        }
        hasMore = !!res.hasMore;
        typingUsers = (res.typing || []).filter((t) => t.client_id !== settings.clientId);
        voicePresence = res.voice || [];

        if (res.maxId) {
            reads[channel] = res.maxId;
            try { localStorage.setItem('lounge_reads', JSON.stringify(reads)); } catch (e) {}
        }

        const box = $('messages');
        const prevHeight = box.scrollHeight;
        const prevTop = box.scrollTop;
        const anchor = scrollAnchor();

        renderMessages();
        renderTyping();
        renderVoiceRoster();

        if (before) {
            // Keep the reader anchored where they were when older history loads in.
            box.scrollTop = prevTop + (box.scrollHeight - prevHeight);
        } else if (scrollToEnd && !filterActive()) {
            // Never yank a filtered view to the bottom on a poll.
            box.scrollTop = box.scrollHeight;
            following = true;
        } else if (!restoreAnchor(anchor)) {
            // A re-render wipes the list, which resets scrollTop to 0. Someone
            // reading history must not be thrown to the top by a poll.
            box.scrollTop = prevTop;
        }
        settleScroll();
    }

    function nearBottom() {
        const box = $('messages');
        return box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    }

    // ---------- scroll position --------------------------------------------

    // Show the jump button only well clear of the bottom, so a stray wheel
    // notch can't make it flicker in and out.
    const JUMP_SHOW_PX = 400;
    // Past this, smooth-scrolling means watching thousands of messages blur by.
    const JUMP_INSTANT_PX = 4000;

    let following = true;       // is the view tracking new messages?
    let seenTopId = 0;          // newest post id the reader had caught up to
    let lastHeight = 0;         // content height, to spot late-loading images

    // The first message still visible, and where it sits — enough to put the
    // reader back after the list is rebuilt or something above it resizes.
    function scrollAnchor() {
        const box = $('messages');
        const top = box.getBoundingClientRect().top;
        for (const el of box.querySelectorAll('.msg')) {
            const r = el.getBoundingClientRect();
            if (r.bottom > top) return { id: el.dataset.id, offset: r.top - top };
        }
        return null;
    }

    function restoreAnchor(a) {
        if (!a) return false;
        const box = $('messages');
        const el = box.querySelector(`.msg[data-id="${a.id}"]`);
        if (!el) return false;
        box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - a.offset;
        return true;
    }

    function newestId() { return posts.length ? posts[posts.length - 1].id : 0; }

    // Record the height we settled at so image loads can be told apart from
    // ordinary scrolling, and refresh the button.
    function settleScroll() {
        lastHeight = $('messages').scrollHeight;
        updateJump();
    }

    function updateJump() {
        const box = $('messages');
        const btn = $('jump-latest');
        if (nearBottom()) seenTopId = newestId();       // caught up
        const away = box.scrollHeight - box.scrollTop - box.clientHeight > JUMP_SHOW_PX;

        const n = away
            ? posts.filter((p) => p.id > seenTopId && p.client_id !== settings.clientId).length
            : 0;
        const badge = $('jump-count');
        badge.textContent = n > 99 ? '99+' : String(n);
        badge.hidden = !n;

        btn.classList.toggle('show', away);
        btn.setAttribute('aria-hidden', away ? 'false' : 'true');
    }

    function jumpToLatest() {
        const box = $('messages');
        const far = box.scrollHeight - box.scrollTop - box.clientHeight > JUMP_INSTANT_PX;
        box.scrollTo({ top: box.scrollHeight, behavior: far ? 'auto' : 'smooth' });
        following = true;
        seenTopId = newestId();
        updateJump();
    }

    $('jump-latest').addEventListener('click', jumpToLatest);

    // Images and link previews have no height until they load, so one finishing
    // above the viewport shifts everything below it. Give the scroll back the
    // height it just gained — this is the classic "my place jumped" bug.
    $('messages').addEventListener('load', (e) => {
        const box = $('messages');
        if (!(e.target instanceof HTMLImageElement)) return;
        const grew = box.scrollHeight - lastHeight;
        lastHeight = box.scrollHeight;
        if (grew <= 0) return;

        if (following && !filterActive()) {
            box.scrollTop = box.scrollHeight;      // stay pinned to the newest
        } else if (e.target.getBoundingClientRect().top < box.getBoundingClientRect().top) {
            box.scrollTop += grew;                 // it grew above us
        }
        lastHeight = box.scrollHeight;
        updateJump();
    }, true);

    // Which type(s) a post satisfies, for filtering.
    function postMatchesFilter(p) {
        if (filter.fromIds && !filter.fromIds.includes(p.client_id)) return false;
        if (filter.pinned && !p.pinned) return false;
        if (filter.mentions && !mentionsMe(p.body)) return false;
        if (filter.edited && !p.edited_at) return false;
        if (filter.text) {
            const hay = ((p.body || '') + ' ' + (p.att_name || '')).toLowerCase();
            if (!hay.includes(filter.text.toLowerCase())) return false;
        }
        if (filter.types.size) {
            const kind = p.att_key ? attachmentKind(p) : null;
            let ok = false;
            if (filter.types.has('links') && extractUrls(p.body).length) ok = true;
            if (!ok && filter.types.has('files') && p.att_key) ok = true;
            if (!ok && filter.types.has('images') && kind === 'image') ok = true;
            if (!ok && filter.types.has('videos') && kind === 'video') ok = true;
            if (!ok && filter.types.has('audio') && kind === 'audio') ok = true;
            if (!ok) return false;
        }
        return true;
    }
    function displayedPosts() {
        return filterActive() ? posts.filter(postMatchesFilter) : posts;
    }

    let renderedSig = null;

    function renderMessages() {
        // A background poll must not rip the inline editor out from under
        // someone mid-sentence. The list resyncs when the edit finishes.
        if (editingId) return;

        const box = $('messages');
        const active = filterActive();
        const list = displayedPosts();

        // Most polls return exactly what's already on screen. Rebuilding it
        // anyway would reset the scroll, restart every image load and throw away
        // the previews — so when nothing changed, leave the DOM alone.
        const sig = JSON.stringify([channel, active, hasMore, list]);
        if (sig === renderedSig && box.firstChild) return;
        renderedSig = sig;

        box.classList.toggle('filtering', active);
        box.innerHTML = '';

        // Older history can still be pulled in to widen a filter's reach.
        if (hasMore) {
            const b = document.createElement('button');
            b.className = 'load-more';
            b.textContent = active ? 'Load earlier messages to widen results' : 'Load earlier messages';
            b.addEventListener('click', () => loadMessages(false, posts.length ? posts[0].id : null));
            box.appendChild(b);
        }

        if (active) updateFilterCount(list.length);

        if (!list.length) {
            const e = document.createElement('div');
            e.className = 'empty-state';
            e.textContent = active
                ? 'No loaded messages match these filters.' + (hasMore ? ' Load earlier messages to search further back.' : '')
                : `No messages in #${channel} yet — say something.`;
            box.appendChild(e);
            return;
        }

        let lastDay = '';
        let prev = null;
        list.forEach((p) => {
            const day = dayStr(p.created_at);
            if (day !== lastDay) {
                lastDay = day;
                const sep = document.createElement('div');
                sep.className = 'day-sep';
                sep.innerHTML = `<span>${esc(day)}</span>`;
                box.appendChild(sep);
                prev = null;
            }
            box.appendChild(renderMessage(p, prev));
            prev = p;
        });
    }

    function renderMessage(p, prev) {
        // Group consecutive messages from the same person within 5 minutes.
        const grouped = prev && prev.client_id === p.client_id && prev.name === p.name &&
            (p.created_at - prev.created_at) < 300000 && !p.quote;

        const el = document.createElement('div');
        el.className = 'msg' + (grouped ? ' grouped' : '') + (p.pinned ? ' pinned' : '');
        el.dataset.id = p.id;

        const parts = [];
        parts.push(`<div class="msg-avatar" style="${avatarStyle(p.name)}">${esc(initials(p.name))}</div>`);
        parts.push('<div class="msg-body">');

        if (p.quote) {
            parts.push('<div class="msg-quote">' +
                (p.quote.missing
                    ? '<em>original message deleted</em>'
                    : `<strong>${esc(p.quote.name)}</strong> ${esc(p.quote.body || p.quote.att_name || '')}`) +
                '</div>');
        }

        if (!grouped) {
            parts.push('<div class="msg-head">' +
                `<span class="msg-author">${esc(p.name)}</span>` +
                `<span class="msg-time">${esc(timeStr(p.created_at))}</span>` +
                (p.pinned ? '<span class="msg-pinned-tag">📌 pinned</span>' : '') +
                '</div>');
        } else if (p.pinned) {
            parts.push('<div class="msg-head"><span class="msg-pinned-tag">📌 pinned</span></div>');
        }

        if (p.body) {
            parts.push(`<div class="msg-text">${renderText(p.body)}` +
                (p.edited_at ? '<span class="msg-edited">(edited)</span>' : '') +
                '</div>');
        }

        if (p.att_key) {
            const url = L.fileUrl(p.att_key);
            const kind = attachmentKind(p);
            const label = esc(p.att_name || 'attachment') + (p.att_size ? ' · ' + fmtSize(p.att_size) : '');
            parts.push('<div class="msg-att">');
            // Audio is checked before image/video so an audio/webm clip gets a
            // player rather than a black video element.
            if (kind === 'audio') {
                parts.push(`<div class="au-mount" data-src="${esc(url)}" data-name="${esc(p.att_name || 'audio')}"></div>`);
            } else if (kind === 'image') {
                parts.push(`<img src="${esc(url)}" alt="${esc(p.att_name)}" loading="lazy" ` +
                    `data-lightbox="1" data-att-key="${esc(p.att_key)}" data-att-name="${esc(p.att_name || 'image')}">`);
            } else if (kind === 'video') {
                parts.push(`<video src="${esc(url)}" controls preload="metadata"></video>`);
            } else {
                parts.push(`<span class="msg-att-file">📎 ${esc(p.att_name || 'attachment')}</span>`);
            }
            // Download stays available whatever the kind.
            parts.push('<button class="att-save" ' +
                `data-att-key="${esc(p.att_key)}" data-att-name="${esc(p.att_name || 'attachment')}">` +
                `⤓ ${label}</button>`);
            parts.push('</div>');
        }

        // Filled in asynchronously by renderPreviews — never blocks the message.
        parts.push('<div class="msg-previews"></div>');

        if (p.reactions && p.reactions.length) {
            parts.push('<div class="msg-reactions">' + p.reactions.map((r) => {
                const mine = (r.who || []).includes(settings.clientId);
                return `<button class="reaction${mine ? ' mine' : ''}" data-emoji="${esc(r.emoji)}">${esc(r.emoji)} ${r.count}</button>`;
            }).join('') + '</div>');
        }

        if (p.reply_count) {
            parts.push(`<button class="msg-thread">${p.reply_count} ${p.reply_count === 1 ? 'reply' : 'replies'}</button>`);
        }

        parts.push('</div>');

        // Hover actions. Edit and delete are yours-only, so they're omitted
        // entirely on other people's messages rather than shown and rejected.
        const mine = p.client_id && p.client_id === settings.clientId;
        parts.push('<div class="msg-actions">' +
            `<button class="msg-act${p.pinned ? ' on' : ''}" data-act="pin" title="${p.pinned ? 'Unpin' : 'Pin'} this message">📌</button>` +
            '<button class="msg-act" data-act="copy" title="Copy text">⧉</button>' +
            (mine ? '<button class="msg-act" data-act="edit" title="Edit message">✎</button>' : '') +
            (mine ? '<button class="msg-act" data-act="delete" title="Delete message">🗑</button>' : '') +
            '</div>');

        el.innerHTML = parts.join('');

        const act = (name, fn) => {
            const b = el.querySelector(`[data-act="${name}"]`);
            if (b) b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
        };
        act('pin', () => pinPost(p.id, !p.pinned));
        act('copy', () => copyMessage(p));
        act('edit', () => startEdit(p, el));
        act('delete', () => deletePost(p));

        // Right-click anywhere on the message opens the message actions — except
        // on an image or a link, which get their own without having to be
        // expanded or opened first. Text beside either still gets the message
        // menu. Images win over links so a preview image's own actions aren't
        // shadowed by the url it came from.
        el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const ref = imageRef(e.target.closest('.msg-att img, img.link-image'));
            const url = ref ? null : linkTarget(e.target);
            const items = ref ? imageMenuItems(ref)
                : url ? linkMenuItems(url)
                    : messageMenuItems(p, el);
            openCtxMenu(items, e.clientX, e.clientY);
        });

        // Swap the audio placeholder for a real player (needs JS wiring, so it
        // can't be built as part of the innerHTML string).
        const mount = el.querySelector('.au-mount');
        if (mount) mount.replaceWith(audioPlayer(mount.dataset.src, mount.dataset.name));

        renderPreviews(el.querySelector('.msg-previews'), p);

        el.querySelectorAll('.reaction').forEach((b) => {
            b.addEventListener('click', () => react(p.id, b.dataset.emoji));
        });
        // Thread view isn't ported yet — say so rather than leaving a dead button.
        const thread = el.querySelector('.msg-thread');
        if (thread) {
            thread.addEventListener('click', () =>
                toast('Threads aren\'t in the desktop app yet — open this one on the website'));
        }
        return el;
    }

    async function react(postId, emoji) {
        const res = await L.board('react', {
            method: 'POST', body: { postId, emoji, clientId: settings.clientId }
        });
        if (res && res.success) loadMessages(false);
    }

    // Links open in the system browser. Attachments are saved through the
    // authenticated client — the browser has no way to fetch them itself.
    $('messages').addEventListener('click', async (e) => {
        const a = e.target.closest('a[data-external]');
        if (a) { e.preventDefault(); L.app.openExternal(a.getAttribute('href')); return; }

        const img = e.target.closest('img[data-lightbox]');
        if (img) { openLightbox(img.src, imageRef(img)); return; }

        const save = e.target.closest('.att-save');
        if (!save) return;
        save.disabled = true;
        const original = save.textContent;
        save.textContent = 'Saving…';
        await saveAttachment(save.dataset.attKey, save.dataset.attName);
        save.disabled = false;
        save.textContent = original;
    });

    $('messages').addEventListener('scroll', () => {
        const box = $('messages');
        following = nearBottom();
        lastHeight = box.scrollHeight;
        updateJump();
        if (box.scrollTop < 60 && hasMore && !loading && posts.length) {
            loadMessages(false, posts[0].id);
        }
    });

    // ---------- composer --------------------------------------------------

    const input = $('composer-input');

    function autosize() {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 180) + 'px';
    }

    input.addEventListener('input', () => {
        autosize();
        updateSendEnabled();
        const now = Date.now();
        if (input.value.trim() && now - typingSentAt > TYPING_MS) {
            typingSentAt = now;
            L.rt.sendTyping(channel, false);
            L.board('typing', { method: 'POST', body: { clientId: settings.clientId, name: settings.displayName } });
        }
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            $('composer').requestSubmit();
        }
    });

    $('composer').addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = input.value.trim();
        const attachments = validStaged();   // errored items are never sent
        if (!body && !attachments.length) return;

        input.value = '';
        autosize();
        $('btn-send').disabled = true;
        clearStaged();
        L.rt.sendTyping(channel, true);

        // With attachments, the text becomes the first one's caption so a
        // "here's the thing" message stays attached to the thing.
        if (attachments.length) {
            let ok = 0;
            for (let i = 0; i < attachments.length; i++) {
                if (await uploadOne(attachments[i], i === 0 ? body : '')) ok++;
            }
            if (ok) {
                L.rt.notifyPosted(channel);
                await loadMessages(true);
            } else if (body) {
                input.value = body;      // nothing sent — give the text back
                autosize();
            }
            return;
        }

        const res = await L.board('post', {
            method: 'POST',
            body: { body, name: settings.displayName || 'Anonymous', clientId: settings.clientId, channel }
        });

        if (res && res.needsAuth) return relogin();
        if (!res || !res.success) {
            toast((res && res.error) || 'Could not send', true);
            input.value = body;   // give the text back rather than losing it
            autosize();
            return;
        }
        L.rt.notifyPosted(channel);
        await loadMessages(true);
    });

    // ---------- attachments -----------------------------------------------
    // Uses the same two-step the website does — POST the bytes to
    // /api/board/upload, then POST the message carrying { key, name, type, size }
    // — so a desktop upload is indistinguishable from a browser one.

    const MAX_UPLOAD = 25 * 1048576;

    // Attachment precedence: audio → image → video → generic file. Types are
    // checked before extensions because .webm is legitimately either audio or
    // video, and the uploader's MIME type is the more reliable signal.
    const AUDIO_EXT = /\.(mp3|wav|ogg|oga|m4a|flac|aac|opus|weba)$/i;
    const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
    const VIDEO_EXT = /\.(mp4|webm|mov|mkv|avi|m4v)$/i;

    function attachmentKind(p) {
        const type = (p.att_type || '').toLowerCase();
        const name = (p.att_name || '').toLowerCase();
        if (type.startsWith('audio/') || (!type && AUDIO_EXT.test(name))) return 'audio';
        if (type.startsWith('image/') || (!type && IMAGE_EXT.test(name))) return 'image';
        if (type.startsWith('video/') || (!type && VIDEO_EXT.test(name))) return 'video';
        // A generic octet-stream upload still deserves the right player.
        if (AUDIO_EXT.test(name)) return 'audio';
        if (IMAGE_EXT.test(name)) return 'image';
        if (VIDEO_EXT.test(name)) return 'video';
        return 'file';
    }

    function fmtSize(b) {
        if (!b) return '';
        if (b < 1024) return b + ' B';
        if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
        return (b / 1048576).toFixed(1) + ' MB';
    }

    function addUploadRow(name, size) {
        const row = document.createElement('div');
        row.className = 'up-row';
        row.innerHTML =
            `<span class="up-name">${esc(name)}</span>` +
            `<span class="up-size">${esc(fmtSize(size))}</span>` +
            '<span class="up-bar"><i></i></span>';
        $('upload-list').appendChild(row);
        return row;
    }

    function failUploadRow(row, msg) {
        row.classList.add('err');
        row.querySelector('.up-name').textContent = msg;
        setTimeout(() => row.remove(), 6000);
    }

    // Uploads one staged item and posts it. `caption` rides on the first
    // attachment only, matching the website.
    async function uploadOne(item, caption) {
        const row = addUploadRow(item.name, item.size);

        let buf = item.bytes;
        if (!buf) {
            try {
                buf = await item.file.arrayBuffer();
            } catch (e) {
                failUploadRow(row, `Could not read ${item.name}`);
                return false;
            }
        }

        const up = await L.uploadFile(item.name, item.type || 'application/octet-stream', buf);
        if (up && up.needsAuth) { row.remove(); relogin(); return false; }
        if (!up || !up.success) {
            failUploadRow(row, (up && up.error) || `Upload of ${item.name} failed`);
            return false;
        }

        const res = await L.board('post', {
            method: 'POST',
            body: {
                body: caption || '',
                name: settings.displayName || 'Anonymous',
                clientId: settings.clientId,
                channel,
                attachment: { key: up.key, name: up.name, type: up.type, size: up.size }
            }
        });

        row.remove();
        if (res && res.needsAuth) { relogin(); return false; }
        if (!res || !res.success) {
            toast((res && res.error) || 'Could not post the attachment', true);
            return false;
        }
        return true;
    }

    // Running as administrator silently breaks drag-and-drop: Windows refuses to
    // pass drags from Explorer (medium integrity) to an elevated window, and the
    // events never reach us at all. Say so instead of looking broken.
    async function warnIfElevated() {
        try {
            if (!(await L.app.isElevated())) return;
            setTimeout(() => toast(
                'Running as administrator — Windows blocks drag-and-drop. ' +
                'Reopen ScarmVoice normally to drag files in.', true), 1500);
        } catch (e) { /* non-Windows or probe failed */ }
    }

    // ---------- attachment staging ----------------------------------------
    // The attach button, drag-and-drop and clipboard paste all funnel through
    // stageFiles(), so validation and behaviour are identical for all three.
    // Nothing uploads until the message is sent.

    const MAX_FILES = 10;
    // Each staged item: { id, name, type, size, file?, bytes?, error?, kind,
    //                     url?, poster?, duration?, prepared }
    let staged = [];
    let stageSeq = 0;

    const STAGE_IMG = /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif)$/i;
    const STAGE_VID = /\.(mp4|webm|mov|mkv|avi|m4v)$/i;
    const STAGE_AUD = /\.(mp3|wav|ogg|oga|m4a|flac|aac|opus|weba)$/i;

    function stageKind(item) {
        const t = (item.type || '').toLowerCase();
        const n = (item.name || '').toLowerCase();
        if (t.startsWith('image/') || STAGE_IMG.test(n)) return 'image';
        if (t.startsWith('video/') || STAGE_VID.test(n)) return 'video';
        if (t.startsWith('audio/') || STAGE_AUD.test(n)) return 'audio';
        return 'file';
    }
    function stageBlob(item) {
        return item.file || new Blob([item.bytes], { type: item.type || 'application/octet-stream' });
    }
    function validStaged() { return staged.filter((s) => !s.error); }
    function stagedTotal() { return validStaged().reduce((n, s) => n + s.size, 0); }

    function fmtDuration(sec) {
        if (!Number.isFinite(sec) || sec <= 0) return '';
        const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
        return m + ':' + String(s).padStart(2, '0');
    }

    // Truncate in the MIDDLE so the extension stays readable. Returns {head, tail}
    // where tail is the extension (+ a little context) and head ellipsizes in CSS.
    function splitName(name) {
        const s = String(name || '');
        const dot = s.lastIndexOf('.');
        if (dot > 0 && dot >= s.length - 8) {
            // keep the extension plus up to 2 trailing chars of the stem as the tail
            const tailStart = Math.max(dot - 2, 1);
            return { head: s.slice(0, tailStart), tail: s.slice(tailStart) };
        }
        return { head: s, tail: '' };
    }

    // ---- local thumbnails (no server round trip) -------------------------

    // Grab a poster from a video ~1s in (frame 0 is usually black) + its duration.
    function videoPoster(blob) {
        return new Promise((resolve) => {
            const v = document.createElement('video');
            v.muted = true; v.preload = 'metadata';
            const url = URL.createObjectURL(blob);
            let done = false;
            const finish = (r) => { if (done) return; done = true; URL.revokeObjectURL(url); resolve(r); };
            v.onloadedmetadata = () => {
                const dur = v.duration;
                const seekTo = Math.min(1, (dur || 2) / 2);
                v.onseeked = () => {
                    try {
                        const w = Math.min(v.videoWidth || 320, 320);
                        const h = Math.round(w * ((v.videoHeight / v.videoWidth) || 0.5625));
                        const c = document.createElement('canvas');
                        c.width = w; c.height = h;
                        c.getContext('2d').drawImage(v, 0, 0, w, h);
                        finish({ poster: c.toDataURL('image/jpeg', 0.7), duration: dur });
                    } catch (e) { finish({ duration: dur }); }
                };
                try { v.currentTime = seekTo; } catch (e) { finish({ duration: dur }); }
            };
            v.onerror = () => finish(null);
            setTimeout(() => finish(null), 5000);   // some containers (mkv/avi) won't decode
            v.src = url;
        });
    }
    function mediaDuration(tag, blob) {
        return new Promise((resolve) => {
            const el = document.createElement(tag);
            el.preload = 'metadata';
            const url = URL.createObjectURL(blob);
            const finish = (d) => { URL.revokeObjectURL(url); resolve(d); };
            el.onloadedmetadata = () => finish(el.duration);
            el.onerror = () => finish(null);
            setTimeout(() => finish(null), 5000);
            el.src = url;
        });
    }

    // Prepare a preview once, when an item is staged (never on every render).
    async function prepareStage(item) {
        item.kind = stageKind(item);
        if (item.error) { item.prepared = true; return; }
        const blob = stageBlob(item);
        try {
            if (item.kind === 'image') {
                // Object URL kept alive for the <img>; revoked when unstaged.
                item.url = URL.createObjectURL(blob);
            } else if (item.kind === 'video') {
                const r = await videoPoster(blob);
                if (r) { item.poster = r.poster; item.duration = r.duration; }
            } else if (item.kind === 'audio') {
                item.duration = await mediaDuration('audio', blob);
            }
        } catch (e) { /* fall back to an icon */ }
        item.prepared = true;
        renderStaged();
    }

    // Stage items. Anything that fails validation is kept and shown as errored
    // (not silently dropped); errored items are never uploaded.
    function stageFiles(items) {
        let added = 0;
        for (const it of items) {
            let error = null;
            if (it.size > MAX_UPLOAD) error = `Too large — ${fmtSize(it.size)} (max 25 MB)`;
            else if (!it.size) error = 'Empty file';
            else if (validStaged().length >= MAX_FILES) error = `Only ${MAX_FILES} files per message`;

            const item = {
                id: ++stageSeq, name: it.name, type: it.type, size: it.size,
                file: it.file, bytes: it.bytes, error
            };
            staged.push(item);
            if (!error) added++;
            prepareStage(item);   // async; re-renders when ready
        }
        renderStaged();
        return added;
    }

    function unstage(id) {
        const item = staged.find((s) => s.id === id);
        if (item && item.url) { try { URL.revokeObjectURL(item.url); } catch (e) {} }
        staged = staged.filter((s) => s.id !== id);
        renderStaged();
    }

    function clearStaged() {
        staged.forEach((s) => { if (s.url) { try { URL.revokeObjectURL(s.url); } catch (e) {} } });
        staged = [];
        renderStaged();
    }

    // Icon glyph for a non-media file, by extension.
    function fileGlyph(name) {
        const ext = (String(name).split('.').pop() || '').toLowerCase();
        const map = {
            pdf: '📕', doc: '📘', docx: '📘', xls: '📗', xlsx: '📗', ppt: '📙', pptx: '📙',
            zip: '🗜️', rar: '🗜️', '7z': '🗜️', gz: '🗜️', tar: '🗜️',
            txt: '📄', md: '📄', rtf: '📄', csv: '📊', json: '🧾', xml: '🧾',
            exe: '⚙️', msi: '⚙️', dmg: '💿', iso: '💿'
        };
        return map[ext] || '📎';
    }

    function stageCard(s) {
        const card = document.createElement('div');
        card.className = 'stage-card' + (s.error ? ' errored' : '') + ' kind-' + (s.kind || 'file');

        const { head, tail } = splitName(s.name);
        const nameHtml = `<span class="sc-name" title="${esc(s.name)}"><span class="sc-head">${esc(head)}</span><span class="sc-tail">${esc(tail)}</span></span>`;

        let thumb = '';
        if (s.error) {
            thumb = `<div class="sc-thumb sc-icon">${fileGlyph(s.name)}</div>`;
        } else if (s.kind === 'image' && s.url) {
            // A load error (e.g. HEIC that Chromium can't decode) swaps to an icon;
            // wired in JS below because CSP forbids inline onerror handlers.
            thumb = `<div class="sc-thumb"><img src="${esc(s.url)}" alt=""></div>`;
        } else if (s.kind === 'image') {
            thumb = `<div class="sc-thumb sc-icon">🖼️</div>`;
        } else if (s.kind === 'video' && s.poster) {
            thumb = `<div class="sc-thumb sc-video"><img src="${esc(s.poster)}" alt="">` +
                `<span class="sc-play">▶</span>` +
                (s.duration ? `<span class="sc-badge">${fmtDuration(s.duration)}</span>` : '') + '</div>';
        } else if (s.kind === 'video') {
            thumb = `<div class="sc-thumb sc-icon sc-video">🎬` +
                (s.duration ? `<span class="sc-badge">${fmtDuration(s.duration)}</span>` : '') + '</div>';
        } else if (s.kind === 'audio') {
            thumb = `<div class="sc-thumb sc-icon sc-audio"><svg viewBox="0 0 24 24" class="sc-wave" aria-hidden="true">` +
                '<rect x="3" y="9" width="2" height="6"/><rect x="7" y="6" width="2" height="12"/>' +
                '<rect x="11" y="3" width="2" height="18"/><rect x="15" y="7" width="2" height="10"/>' +
                '<rect x="19" y="10" width="2" height="4"/></svg></div>';
        } else {
            thumb = `<div class="sc-thumb sc-icon">${fileGlyph(s.name)}</div>`;
        }

        const meta = s.error
            ? `<span class="sc-err">${esc(s.error)}</span>`
            : `<span class="sc-meta">${esc(fmtSize(s.size))}${s.duration ? ' · ' + fmtDuration(s.duration) : ''}</span>`;

        card.innerHTML =
            thumb +
            `<div class="sc-body">${nameHtml}${meta}</div>` +
            '<button class="sc-x" type="button" title="Remove">✕</button>';
        card.querySelector('.sc-x').addEventListener('click', () => unstage(s.id));

        // Image decode failure → fall back to an icon (CSP-safe, no inline handler).
        const img = card.querySelector('.sc-thumb img');
        if (img && s.kind === 'image') {
            img.addEventListener('error', () => {
                const t = card.querySelector('.sc-thumb');
                if (t) { t.classList.add('sc-icon'); t.textContent = '🖼️'; }
            });
        }
        return card;
    }

    function renderStaged() {
        const box = $('upload-list');
        box.innerHTML = '';
        if (!staged.length) { updateSendEnabled(); return; }

        const grid = document.createElement('div');
        grid.className = 'stage-grid';
        staged.forEach((s) => grid.appendChild(stageCard(s)));
        box.appendChild(grid);

        const valid = validStaged();
        if (valid.length > 1) {
            const sum = document.createElement('div');
            sum.className = 'stage-sum';
            sum.textContent = `${valid.length} files · ${fmtSize(stagedTotal())} total — press Enter to send`;
            box.appendChild(sum);
        }
        updateSendEnabled();
    }

    function updateSendEnabled() {
        // An attachment alone is a valid message; errored items don't count.
        $('btn-send').disabled = !validStaged().length && !input.value.trim();
    }

    // ---- turning a drop / paste / picker into stageable items -------------

    function itemFromFile(file, name) {
        return { name: name || file.name, type: file.type || '', size: file.size, file };
    }

    // Recurse a dropped directory. Relative path is kept in the name so
    // "photos/holiday/a.png" stays distinguishable from "docs/a.png"; the
    // server sanitises the slashes when it stores the object.
    async function walkEntry(entry, prefix, out) {
        if (!entry || out.length >= MAX_FILES) return;
        if (entry.isFile) {
            const file = await new Promise((res) => entry.file(res, () => res(null)));
            if (file) out.push(itemFromFile(file, prefix ? `${prefix}/${file.name}` : file.name));
            return;
        }
        if (!entry.isDirectory) return;
        const dir = prefix ? `${prefix}/${entry.name}` : entry.name;
        const reader = entry.createReader();
        for (;;) {
            // readEntries yields at most 100 per call — keep going until empty.
            const batch = await new Promise((res) => reader.readEntries(res, () => res([])));
            if (!batch.length) break;
            for (const child of batch) {
                await walkEntry(child, dir, out);
                if (out.length >= MAX_FILES) return;
            }
        }
    }

    // A DataTransfer is only readable while the event handler is on the stack —
    // the moment we await, its store goes into "protected mode" and files,
    // items and getData() all come back empty. So snapshot EVERYTHING
    // synchronously here, then do the async work against the snapshot.
    function snapshotDataTransfer(dt) {
        const snap = { files: [], entries: [], url: '', types: [] };
        if (!dt) return snap;

        try { snap.types = Array.from(dt.types || []); } catch (e) {}
        // Plain file list first: this is the reliable path and works even when
        // the entry API is unavailable.
        try { snap.files = Array.from(dt.files || []); } catch (e) {}
        // Entries additionally let us expand dropped folders.
        try {
            for (const item of Array.from(dt.items || [])) {
                if (item.kind !== 'file') continue;
                const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
                if (entry) snap.entries.push(entry);
            }
        } catch (e) {}
        // An image dragged out of a browser arrives as a URL, not a file.
        try {
            const html = dt.getData('text/html') || '';
            const uri = (dt.getData('text/uri-list') || dt.getData('text/plain') || '').split('\n')[0].trim();
            snap.url = (html.match(/<img[^>]+src\s*=\s*["']([^"']+)["']/i) || [])[1] || uri || '';
        } catch (e) {}

        return snap;
    }

    async function itemsFromSnapshot(snap) {
        const out = [];

        // Folders can only come through the entry API, so prefer it when the
        // drop actually contains one.
        const hasDir = snap.entries.some((en) => en && en.isDirectory);
        if (hasDir) {
            for (const entry of snap.entries) {
                await walkEntry(entry, '', out);
                if (out.length >= MAX_FILES) break;
            }
            if (out.length) return out;
        }

        if (snap.files.length) return snap.files.slice(0, MAX_FILES).map((f) => itemFromFile(f));

        // Entry API only (no plain files) — expand whatever we got.
        for (const entry of snap.entries) {
            await walkEntry(entry, '', out);
            if (out.length >= MAX_FILES) break;
        }
        if (out.length) return out;

        // Nothing but a URL: fetch the image so we attach it, not its link text.
        if (!/^https?:\/\//i.test(snap.url)) return out;
        toast('Fetching image…');
        const res = await L.fetchImage(snap.url);
        if (!res || !res.success) {
            toast((res && res.error) || 'Could not fetch that image', true);
            return out;
        }
        out.push({ name: res.name, type: res.type, size: res.data.byteLength, bytes: res.data });
        return out;
    }

    // ---- inputs ----------------------------------------------------------

    $('btn-attach').addEventListener('click', () => $('file-input').click());

    $('file-input').addEventListener('change', (e) => {
        const files = Array.from(e.target.files || []).map((f) => itemFromFile(f));
        e.target.value = '';                 // allow re-picking the same file
        const before = staged.length;
        const wanted = files.length;
        stageFiles(files);
        if (wanted > MAX_FILES - before) toast(`Only ${MAX_FILES} files fit in one message`, true);
    });

    // Drag and drop. Every dragover/drop MUST preventDefault or Chromium
    // navigates the window to the dropped file (see will-navigate in main.js).
    let dragDepth = 0;

    function isFileDrag(dt) {
        const types = Array.from((dt && dt.types) || []);
        return types.includes('Files') || types.includes('text/uri-list') || types.includes('text/html');
    }
    function showDrop(on) { $('drop-hint').hidden = !on; }

    let loggedEnter = false;
    window.addEventListener('dragenter', (e) => {
        e.preventDefault();
        if (!loggedEnter) {
            loggedEnter = true;   // once per session, just to prove events arrive
            try {
                console.info('[drag] enter types=' + JSON.stringify(Array.from((e.dataTransfer && e.dataTransfer.types) || [])));
            } catch (err) {}
        }
        if ($('app').hidden || !isFileDrag(e.dataTransfer)) return;
        dragDepth++;
        showDrop(true);
    }, true);

    // dragover MUST preventDefault or the drop is never delivered — this is the
    // single most common reason drag-and-drop "does nothing" in Electron.
    // Registered in both phases and on document as well, because which one
    // actually fires has varied across Electron versions.
    function onDragOver(e) {
        e.preventDefault();
        if (e.dataTransfer) {
            try { e.dataTransfer.dropEffect = 'copy'; } catch (err) {}
        }
    }
    window.addEventListener('dragover', onDragOver, true);
    document.addEventListener('dragover', onDragOver, false);

    window.addEventListener('dragleave', (e) => {
        e.preventDefault();
        // Only a leave that exits the window counts; leaves between child
        // elements would otherwise flicker the overlay off.
        if (e.relatedTarget === null || --dragDepth <= 0) { dragDepth = 0; showDrop(false); }
    }, true);

    // NOTE: this handler is deliberately NOT async. Everything the DataTransfer
    // holds is snapshotted synchronously before any await; see
    // snapshotDataTransfer for why.
    function onDrop(e) {
        e.preventDefault();
        e.stopPropagation();
        dragDepth = 0;
        showDrop(false);
        if ($('app').hidden) return;

        const snap = snapshotDataTransfer(e.dataTransfer);
        console.info('[drop] types=' + JSON.stringify(snap.types) +
            ' files=' + snap.files.length +
            ' entries=' + snap.entries.length +
            ' url=' + (snap.url ? snap.url.slice(0, 80) : '(none)'));

        if (!snap.files.length && !snap.entries.length && !snap.url) {
            toast('Nothing droppable in that — try a file', true);
            return;
        }

        itemsFromSnapshot(snap).then((items) => {
            if (!items.length) { toast('Could not read the dropped file', true); return; }
            const n = stageFiles(items);
            if (n) { input.focus(); toast(`${n} file${n === 1 ? '' : 's'} ready — press Enter to send`); }
        }).catch((err) => {
            console.error('[drop] failed', err);
            toast('Drop failed: ' + (err && err.message ? err.message : 'unknown'), true);
        });
    }

    // Registered on both window (capture) and document (bubble): Electron has a
    // long history of drop events only arriving at one or the other depending on
    // version and how the page was loaded. `handled` keeps it to one run.
    let lastDropAt = 0;
    function onDropOnce(e) {
        const now = Date.now();
        if (now - lastDropAt < 50) return;   // same drop reaching us twice
        lastDropAt = now;
        onDrop(e);
    }
    window.addEventListener('drop', onDropOnce, true);
    document.addEventListener('drop', onDropOnce, false);

    // Paste an image straight from the clipboard.
    input.addEventListener('paste', (e) => {
        const items = [];
        for (const item of (e.clipboardData && e.clipboardData.items) || []) {
            if (item.kind !== 'file') continue;
            const f = item.getAsFile();
            if (f) items.push(itemFromFile(f, f.name || `pasted-${Date.now()}.png`));
        }
        if (!items.length) return;
        e.preventDefault();
        stageFiles(items);
    });

    // Right-click the composer for the standard editing actions. Electron ships
    // no context menu of its own, so without this the only way to paste is the
    // keyboard. The commands run in the main process as native editing commands
    // on the focused element — that's what makes Paste behave exactly like
    // Ctrl+V, image-on-the-clipboard included, instead of being a second
    // half-implementation of it.
    input.addEventListener('contextmenu', async (e) => {
        e.preventDefault();
        const selected = input.selectionStart !== input.selectionEnd;
        const clip = await L.edit.clipboard();
        const canPaste = !!(clip && (clip.text || clip.image));
        // The menu takes the click, so put the caret back before the command
        // runs — otherwise it lands on nothing.
        const on = (fn) => () => { input.focus(); fn(); };

        openCtxMenu([
            { label: 'Cut', icon: '✂', disabled: !selected, onClick: on(() => L.edit.cut()) },
            { label: 'Copy', icon: '⧉', disabled: !selected, onClick: on(() => L.edit.copy()) },
            { label: 'Paste', icon: '📋', disabled: !canPaste, onClick: on(() => L.edit.paste()) },
            'sep',
            { label: 'Select all', icon: '▤', disabled: !input.value.length, onClick: on(() => L.edit.selectAll()) }
        ], e.clientX, e.clientY);
    });

    // ---------- typing ----------------------------------------------------

    function renderTyping() {
        const el = $('typing-line');
        const names = typingUsers.map((t) => t.name || 'Someone');
        if (!names.length) { el.textContent = ''; return; }
        if (names.length === 1) el.textContent = `${names[0]} is typing…`;
        else if (names.length === 2) el.textContent = `${names[0]} and ${names[1]} are typing…`;
        else el.textContent = 'Several people are typing…';
    }

    // ---------- voice -----------------------------------------------------

    function setupVoice() {
        voice = window.createVoice({
            onState: (st) => {
                $('btn-join-voice').hidden = st.joined || st.joining;
                $('voice-live').hidden = !st.joined;
                $('btn-join-voice').disabled = st.joining;
                $('btn-join-voice').textContent = st.joining ? 'Connecting…' : 'Join Voice';

                $('btn-mute').setAttribute('aria-pressed', String(st.muted));
                $('btn-mute').title = st.muted ? 'Unmute microphone' : 'Mute microphone';
                toggleIcons('btn-mute', st.muted);

                $('btn-deafen').setAttribute('aria-pressed', String(st.deafened));
                $('btn-deafen').title = st.deafened ? 'Undeafen' : 'Deafen';
                toggleIcons('btn-deafen', st.deafened);

                let label = 'Voice connected';
                if (st.deafened) label = 'Deafened';
                else if (st.muted) label = 'Muted';
                else if (settings.voiceMode === 'ptt') label = st.transmitting ? 'Transmitting' : 'Push to talk';
                $('vl-label').textContent = label;

                // Share controls only make sense while connected.
                $('btn-share').hidden = !st.joined;
                $('btn-share').classList.toggle('on', st.sharing);
                $('btn-share-label').textContent = st.sharing ? 'Stop sharing' : 'Share screen';

                // Remote share audio has to follow the deafen state too.
                const sv = $('stage-video');
                if (sv) sv.muted = st.deafened || !!(st.sharer && st.sharer.isLocal);

                $('stage-quality').value = st.shareQuality;
                $('stage-motion').textContent = st.shareMotion === 'smooth' ? 'Smooth' : 'Sharp';

                L.app.setVoiceState({ inVoice: st.joined, muted: st.muted, deafened: st.deafened });
                L.rt.sendVoice(st.joined, st.muted);

                if (st.joined) startPresence(); else stopPresence();
            },
            onShare: (info) => renderStage(info),
            onParticipants: () => renderVoiceRoster(),
            onSpeaking: (cid, on) => {
                speaking[cid] = on;
                const el = document.querySelector(`.vp[data-cid="${CSS.escape(cid)}"]`);
                if (el) el.classList.toggle('speaking', on);
            },
            onError: (msg) => toast('Voice: ' + msg, true)
        });
        voice.setSettings(settings);
    }

    function toggleIcons(id, off) {
        const btn = $(id);
        const on = btn.querySelector('.ico:not(.ico-off)');
        const offIco = btn.querySelector('.ico-off');
        if (on) on.hidden = off;
        if (offIco) offIco.hidden = !off;
    }

    async function joinVoice() {
        try {
            await voice.join();
            toast('Connected to voice');
        } catch (e) {
            // voice.onError already surfaced the detail.
        }
    }

    function leaveVoice() {
        voice.leave();
        heartbeatPresence(true);
        toast('Left voice');
    }

    $('btn-join-voice').addEventListener('click', joinVoice);
    $('btn-leave-voice').addEventListener('click', leaveVoice);

    $('btn-mute').addEventListener('click', () => {
        if (!voice.isJoined()) return toast('Join voice first');
        voice.toggleMuted();
    });
    $('btn-deafen').addEventListener('click', () => {
        if (!voice.isJoined()) return toast('Join voice first');
        voice.toggleDeafened();
    });

    // ---------- screen share ----------------------------------------------

    function renderStage(info) {
        const stage = $('stage');
        const video = $('stage-video');

        if (!info) {
            try { video.srcObject = null; } catch (e) {}
            stage.hidden = true;
            return;
        }

        stage.hidden = false;
        try { video.srcObject = info.stream; } catch (e) {}
        // Never play your own share back — that's an instant feedback loop.
        video.muted = info.isLocal || (voice && voice.isDeafened());
        $('stage-title').textContent = info.isLocal
            ? 'You are sharing your screen'
            : `${info.name} is sharing their screen`;

        // Quality/motion/stop are the presenter's controls only.
        ['stage-quality', 'stage-motion', 'stage-stop'].forEach((id) => {
            $(id).hidden = !info.isLocal;
        });

        video.play().catch(() => {});
    }

    let pickerSources = [];
    let pickerTab = 'screen';
    let pickerSelected = null;

    async function openPicker() {
        pickerSelected = null;
        pickerTab = 'screen';
        $('picker-go').disabled = true;
        $('picker-audio').checked = settings.shareAudio !== false;
        $('picker-quality-hint').textContent =
            `${settings.shareQuality || '1080p'} · ${settings.shareMotion === 'smooth' ? 'smooth' : 'sharp'}`;
        $('picker').hidden = false;
        $('picker-grid').innerHTML = '<div class="empty-state">Looking for screens and windows…</div>';

        try {
            pickerSources = await L.share.sources();
        } catch (e) {
            pickerSources = [];
            toast('Could not list screens: ' + e.message, true);
        }
        renderPickerTabs();
        renderPicker();
    }

    function renderPickerTabs() {
        document.querySelectorAll('.picker-tab').forEach((t) => {
            t.classList.toggle('active', t.dataset.tab === pickerTab);
        });
    }

    function renderPicker() {
        const grid = $('picker-grid');
        const want = pickerTab === 'screen';
        const list = pickerSources.filter((s) => s.isScreen === want);

        grid.innerHTML = '';
        $('picker-empty').hidden = list.length > 0;

        list.forEach((s) => {
            const b = document.createElement('button');
            b.className = 'pick' + (pickerSelected === s.id ? ' sel' : '');
            b.type = 'button';
            b.innerHTML =
                (s.thumbnail ? `<img src="${esc(s.thumbnail)}" alt="">` : '<img alt="">') +
                '<span class="pick-name">' +
                (s.appIcon ? `<img src="${esc(s.appIcon)}" alt="">` : '') +
                `<span>${esc(s.name)}</span></span>`;
            b.addEventListener('click', () => {
                pickerSelected = s.id;
                $('picker-go').disabled = false;
                renderPicker();
            });
            b.addEventListener('dblclick', startPickedShare);
            grid.appendChild(b);
        });
    }

    document.querySelectorAll('.picker-tab').forEach((t) => {
        t.addEventListener('click', () => {
            pickerTab = t.dataset.tab;
            renderPickerTabs();
            renderPicker();
        });
    });

    function closePicker() {
        $('picker').hidden = true;
        L.share.cancel();
    }
    $('picker-close').addEventListener('click', closePicker);
    $('picker-cancel').addEventListener('click', closePicker);
    $('picker').addEventListener('mousedown', (e) => {
        if (e.target === $('picker')) closePicker();
    });

    // The source is registered with the main process BEFORE the SDK is told to
    // share, because enableScreenShare() calls getDisplayMedia immediately and
    // the display-media handler needs an answer ready.
    async function startPickedShare() {
        if (!pickerSelected) return;
        await saveSettings({ shareAudio: $('picker-audio').checked });
        await L.share.select(pickerSelected, $('picker-audio').checked);
        $('picker').hidden = true;
        const ok = await voice.startShare();
        if (!ok) await L.share.cancel();
    }
    $('picker-go').addEventListener('click', startPickedShare);

    $('btn-share').addEventListener('click', () => {
        if (!voice.isJoined()) return toast('Join voice first');
        if (voice.isSharing()) voice.stopShare();
        else openPicker();
    });

    $('stage-stop').addEventListener('click', () => voice.stopShare());

    $('stage-quality').addEventListener('change', async (e) => {
        await saveSettings({ shareQuality: e.target.value });
        voice.setShareQuality(e.target.value);
        toast('Sharing at ' + e.target.value);
    });

    $('stage-motion').addEventListener('click', async () => {
        const next = (settings.shareMotion === 'smooth') ? 'sharp' : 'smooth';
        await saveSettings({ shareMotion: next });
        voice.setShareMotion(next);
        toast(next === 'smooth'
            ? 'Smooth — 60fps, favours motion'
            : 'Sharp — 30fps, favours crisp text');
    });

    $('stage-full').addEventListener('click', () => {
        // Fullscreen the wrapper, not the bare <video>: it keeps the video
        // centred on black and, unlike the element, has no transform/overflow
        // quirks. Esc (handled natively by Chromium) exits and Chromium restores
        // the element to its inline position automatically.
        const target = $('stage-video-wrap') || $('stage-video');
        if (document.fullscreenElement) {
            document.exitFullscreen().catch(() => {});
            return;
        }
        const p = target.requestFullscreen ? target.requestFullscreen() : null;
        if (p && p.catch) {
            p.catch((e) => {
                console.warn('[stage] fullscreen rejected:', e && e.message);
                toast('Could not enter fullscreen: ' + ((e && e.message) || 'blocked'), true);
            });
        }
    });

    // Reflect fullscreen state on the button label.
    document.addEventListener('fullscreenchange', () => {
        const on = !!document.fullscreenElement;
        const btn = $('stage-full');
        if (btn) { btn.textContent = on ? 'Exit fullscreen' : 'Fullscreen'; btn.classList.toggle('on', on); }
    });

    $('stage-pip').addEventListener('click', async () => {
        const v = $('stage-video');
        try {
            if (document.pictureInPictureElement) await document.exitPictureInPicture();
            else await v.requestPictureInPicture();
        } catch (e) {
            toast('Pop-out unavailable for this stream', true);
        }
    });

    // The roster merges two sources: the SFU's live participant list (authoritative
    // when we're in the call) and the server's voice_presence table (so people who
    // haven't joined still see who is in there, including browser users).
    function renderVoiceRoster() {
        const ul = $('voice-roster');
        const inCall = voice && voice.isJoined();
        const live = inCall ? voice.roster() : [];
        const byId = new Map();

        live.forEach((p) => byId.set(p.id, p));
        voicePresence.forEach((p) => {
            if (!byId.has(p.client_id)) {
                byId.set(p.client_id, {
                    id: p.client_id,
                    name: p.name || 'Anonymous',
                    isMe: p.client_id === settings.clientId,
                    muted: !!p.muted,
                    remoteOnly: true
                });
            }
        });

        const list = Array.from(byId.values());
        $('voice-count').textContent = list.length ? String(list.length) : '';

        // Join / leave chimes. Gated on actually being in the call, so they are
        // never audible to someone who is only watching the roster.
        window.loungeSounds.voiceRoster(list, inCall, settings.clientId);

        ul.innerHTML = '';
        list.forEach((p) => {
            const li = document.createElement('li');
            li.className = 'vp' + (p.isMe ? ' me' : '') + (speaking[p.id] ? ' speaking' : '');
            li.dataset.cid = p.id;
            const localMuted = !p.isMe && settings.localMuted && settings.localMuted[p.id];
            // Someone listed in the shared presence table but absent from our SFU
            // peer list is in the room yet cannot exchange media with us — the
            // exact failure mode that hid a broken call behind a correct-looking
            // roster. Say so instead of showing them as a normal participant.
            const unreachable = inCall && p.remoteOnly && !p.isMe;
            if (unreachable) li.classList.add('unreachable');
            li.innerHTML =
                `<span class="av" style="${avatarStyle(p.name)}">${esc(initials(p.name))}</span>` +
                `<span class="vp-name">${esc(p.name)}${p.isMe ? ' (you)' : ''}</span>` +
                (unreachable ? '<span class="vp-flag" title="In voice, but not connected to you — they may need to reload the website">⚠</span>' : '') +
                (p.muted || localMuted ? '<span class="vp-flag">🔇</span>' : '');
            if (!p.isMe && inCall && !p.remoteOnly) {
                li.addEventListener('click', (e) => openPopover(p, e.currentTarget));
            }
            ul.appendChild(li);
        });
    }

    // ---------- per-participant popover -----------------------------------

    let popFor = null;

    function openPopover(p, anchor) {
        popFor = p.id;
        const pop = $('popover');
        $('pop-name').textContent = p.name;
        const vol = settings.localVolumes && settings.localVolumes[p.id] !== undefined
            ? Number(settings.localVolumes[p.id]) : 1;
        $('pop-vol').value = Math.round(vol * 100);
        $('pop-vol-val').textContent = Math.round(vol * 100) + '%';
        $('pop-mute').checked = !!(settings.localMuted && settings.localMuted[p.id]);

        const r = anchor.getBoundingClientRect();
        pop.hidden = false;
        pop.style.left = Math.min(r.right + 8, window.innerWidth - 232) + 'px';
        pop.style.top = Math.min(r.top, window.innerHeight - pop.offsetHeight - 12) + 'px';
    }

    function closePopover() { $('popover').hidden = true; popFor = null; }

    $('pop-vol').addEventListener('input', async (e) => {
        if (!popFor) return;
        const v = Number(e.target.value) / 100;
        $('pop-vol-val').textContent = e.target.value + '%';
        const volumes = Object.assign({}, settings.localVolumes || {});
        volumes[popFor] = v;
        await saveSettings({ localVolumes: volumes });
        voice.setLocalVolume(popFor, v);
    });

    $('pop-mute').addEventListener('change', async (e) => {
        if (!popFor) return;
        const muted = Object.assign({}, settings.localMuted || {});
        if (e.target.checked) muted[popFor] = true; else delete muted[popFor];
        await saveSettings({ localMuted: muted });
        voice.setLocalMuted(popFor, e.target.checked);
        renderVoiceRoster();
    });

    document.addEventListener('mousedown', (e) => {
        if ($('popover').hidden) return;
        if (!e.target.closest('#popover') && !e.target.closest('.vp')) closePopover();
    });

    // ---------- voice presence heartbeat ----------------------------------

    function startPresence() {
        stopPresence();
        heartbeatPresence(false);
        presenceTimer = setInterval(() => heartbeatPresence(false), PRESENCE_MS);
    }
    function stopPresence() {
        if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null; }
    }
    async function heartbeatPresence(leaving) {
        const res = await L.board('voice/presence', {
            method: 'POST',
            body: {
                clientId: settings.clientId,
                name: settings.displayName || 'Anonymous',
                muted: voice ? voice.isMuted() : false,
                leaving: !!leaving
            }
        });
        if (res && res.success && res.participants) {
            voicePresence = res.participants;
            renderVoiceRoster();
        }
    }

    // ---------- auto-update banner ----------------------------------------
    // Non-blocking bar under the title bar. Dismiss hides it for THIS session
    // only (dismissedVersion), so a new launch re-surfaces the same update
    // without nagging within a session.

    let dismissedVersion = null;

    function renderUpdate(s) {
        const banner = $('update-banner');
        const text = $('ub-text');
        const action = $('ub-action');
        const prog = $('ub-progress');
        const bar = $('ub-bar');
        const notesToggle = $('ub-notes-toggle');
        const notes = $('ub-notes');

        // Nothing to show for these states.
        const showable = ['available', 'downloading', 'ready'].includes(s.status);
        if (!showable || (s.version && s.version === dismissedVersion && s.status === 'available')) {
            banner.hidden = true;
            return;
        }
        banner.hidden = false;

        prog.hidden = s.status !== 'downloading';
        if (s.status === 'downloading') bar.style.width = (s.progress || 0) + '%';

        notesToggle.hidden = !s.notes;
        if (s.notes) notes.textContent = s.notes;

        if (s.status === 'available') {
            text.textContent = `ScarmVoice ${s.version} is available.`;
            action.textContent = 'Download';
            action.disabled = false;
        } else if (s.status === 'downloading') {
            text.textContent = `Downloading ScarmVoice ${s.version}…  ${s.progress || 0}%`;
            action.textContent = 'Downloading…';
            action.disabled = true;
        } else if (s.status === 'ready') {
            text.textContent = `ScarmVoice ${s.version} is ready to install.`;
            action.textContent = 'Restart to update';
            action.disabled = false;
        }
    }

    $('ub-action').addEventListener('click', async () => {
        const s = await L.update.getState();
        if (s.status === 'ready') L.update.install();
        else if (s.status === 'available') L.update.download();
    });
    $('ub-dismiss').addEventListener('click', async () => {
        const s = await L.update.getState();
        dismissedVersion = s.version || 'dismissed';   // suppress until next launch
        $('update-banner').hidden = true;
    });
    $('ub-notes-toggle').addEventListener('click', () => {
        const n = $('ub-notes');
        n.hidden = !n.hidden;
    });

    L.update.onState((s) => renderUpdate(s));
    // Replay whatever state main already reached before this listener attached.
    L.update.getState().then((s) => { if (s) renderUpdate(s); });

    // ---------- realtime + polling ----------------------------------------

    // Visible connection state: 'connected' | 'reconnecting' | 'disconnected'.
    function setRtStatus(state) {
        const dot = $('tb-dot');
        const conn = $('tb-conn');
        const live = state === 'connected';
        const off = state === 'disconnected';

        dot.classList.toggle('live', live);
        dot.classList.toggle('warn', state === 'reconnecting');
        dot.classList.toggle('err', off);
        dot.title = live ? 'Realtime connected'
            : off ? 'Disconnected — retrying'
                : 'Reconnecting…';

        // Only show the pill when something is wrong, so a healthy app is clean.
        conn.hidden = live;
        conn.textContent = off ? 'Disconnected' : (live ? '' : 'Reconnecting…');
        conn.classList.toggle('warn', state === 'reconnecting');
        conn.classList.toggle('err', off);
    }

    L.rt.onStatus(({ connected, state }) => {
        const was = rtConnected;
        rtConnected = connected;
        setRtStatus(state || (connected ? 'connected' : 'reconnecting'));
        startPolling();   // re-arm at the appropriate cadence
        // A fresh reconnection is exactly when to pull whatever we missed while
        // the socket was down, rather than waiting for the next live event.
        if (connected && !was) resyncNow();
    });

    // Verify realtime and reload the current view + channel list. Called on
    // reconnect, on window restore/wake, and when the tab becomes visible.
    let resyncing = false;
    async function resyncNow() {
        if (resyncing || $('app').hidden) return;
        resyncing = true;
        try {
            const stick = nearBottom();
            await loadMessages(stick);
            await loadChannels();
        } finally { resyncing = false; }
    }

    L.rt.onMessage((m) => {
        if (!m || !m.t) return;
        switch (m.t) {
            case 'posted':
                if (m.channel === channel) {
                    // loadMessages does the chime + notification once it has the
                    // real post bodies, so nothing to announce here.
                    const stick = nearBottom();
                    loadMessages(stick);
                } else {
                    bumpUnread(m.channel);
                    if (m.cid !== settings.clientId) notifyOtherChannel(m);
                }
                break;
            case 'typing':
                if (m.channel && m.channel !== channel) break;
                if (m.cid === settings.clientId) break;
                if (m.stop) typingUsers = typingUsers.filter((t) => t.client_id !== m.cid);
                else if (!typingUsers.some((t) => t.client_id === m.cid)) {
                    typingUsers.push({ client_id: m.cid, name: m.name });
                    setTimeout(() => {
                        typingUsers = typingUsers.filter((t) => t.client_id !== m.cid);
                        renderTyping();
                    }, 6000);
                }
                renderTyping();
                break;
            case 'voice':
                if (Array.isArray(m.list)) {
                    voicePresence = m.list.map((v) => ({
                        client_id: v.cid || v.client_id, name: v.name, muted: v.muted
                    }));
                    renderVoiceRoster();
                }
                break;
            case 'welcome':
                if (m.voice) {
                    voicePresence = (m.voice || []).map((v) => ({
                        client_id: v.cid || v.client_id, name: v.name, muted: v.muted
                    }));
                    renderVoiceRoster();
                }
                break;
        }
    });

    function bumpUnread(name) {
        const c = channels.find((x) => x.name === name);
        if (c) { c.unread = (c.unread || 0) + 1; renderChannels(); }
        else loadChannels();
    }

    // @mention of my display name, matching the website's matcher.
    function mentionsMe(body) {
        const me = (settings.displayName || '').toLowerCase();
        if (!me || me === 'anonymous') return false;
        try {
            return new RegExp('@' + me.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(body || '');
        } catch (e) { return false; }
    }

    // Rich notification for fresh posts in the CURRENT channel — the mention is
    // preferred over the newest message, same as the website.
    async function notifyForPosts(fresh) {
        if (!fresh.length || settings.notifications === false) return;
        if (windowFocused) return;   // you're already looking at it

        const mention = fresh.find((p) => mentionsMe(p.body));
        const p = mention || fresh[fresh.length - 1];
        const title = mention
            ? `${p.name || 'Someone'} mentioned you`
            : `${p.name || 'Someone'} · #${channel}`;
        const body = p.body
            ? p.body.slice(0, 140)
            : (p.att_name ? '📎 ' + p.att_name : 'New message');
        await L.app.notify({ title, body });
    }

    // A post landed in a channel we're not viewing. We don't have its body, so
    // this stays deliberately terse; the unread badge carries the rest.
    async function notifyOtherChannel(m) {
        if (settings.notifications === false) return;
        await L.app.notify({
            title: '#' + (m.channel || 'general'),
            body: m.name ? `${m.name} sent a message` : 'New message'
        });
    }

    function startPolling() {
        if (pollTimer) clearInterval(pollTimer);
        const every = rtConnected ? POLL_IDLE_MS : POLL_ACTIVE_MS;
        pollTimer = setInterval(async () => {
            if (document.hidden && rtConnected) return;
            const stick = nearBottom();
            await loadMessages(stick);
            await loadChannels();
        }, every);
    }

    async function relogin() {
        stopPolling();
        stopPresence();
        if (voice) voice.leave();
        $('app').hidden = true;
        $('login').hidden = false;
        $('login-error').textContent = 'Your session expired. Sign in again.';
        $('login-pw').focus();
    }

    function stopPolling() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    // ---------- push to talk ----------------------------------------------

    L.ptt.onChange(({ down }) => {
        if (settings.voiceMode !== 'ptt' || !voice || !voice.isJoined()) return;
        voice.setPttHeld(down);
    });

    // In-window PTT, so it works even when the native hook is unavailable.
    function inEditable(t) {
        return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    }
    function matchesPtt(e) {
        const b = settings.pttBinding;
        if (!b || b.type === 'mouse') return false;
        return e.code === b.code;
    }
    window.addEventListener('keydown', (e) => {
        if (recordingPtt) return;
        if (settings.voiceMode !== 'ptt' || !voice || !voice.isJoined()) return;
        if (!matchesPtt(e) || inEditable(e.target)) return;
        e.preventDefault();
        voice.setPttHeld(true);
    }, true);
    window.addEventListener('keyup', (e) => {
        if (recordingPtt) return;
        if (settings.voiceMode !== 'ptt' || !voice) return;
        if (!matchesPtt(e)) return;
        voice.setPttHeld(false);
    }, true);

    // ---------- tray commands ---------------------------------------------

    L.app.onCommand(({ cmd }) => {
        if (cmd === 'toggleMute' && voice.isJoined()) voice.toggleMuted();
        else if (cmd === 'toggleDeafen' && voice.isJoined()) voice.toggleDeafened();
        else if (cmd === 'joinVoice') joinVoice();
        else if (cmd === 'leaveVoice') leaveVoice();
    });

    L.win.onFocus((focused) => { windowFocused = focused; });

    // Restore-from-tray / wake-from-sleep: main verifies the socket (rt.wake)
    // and fires this so we pull anything missed while hidden.
    L.app.onResync(() => resyncNow());

    // The renderer's own view of visibility. When the tab/window becomes visible
    // again, nudge the socket and resync — belt-and-braces alongside the main
    // process 'restore'/'show' wiring.
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) return;
        L.rt.wake();
        resyncNow();
    });

    // ---------- identity --------------------------------------------------

    function renderMe() {
        const name = settings.displayName || 'Anonymous';
        $('me-name-text').textContent = name;
        $('me-avatar').textContent = initials(name);
        $('me-avatar').setAttribute('style', avatarStyle(name));
    }

    async function changeName() {
        const n = await askText('Display name', settings.displayName || '', 'Save');
        if (n === null) return;
        await saveSettings({ displayName: n.trim().slice(0, 40) });
        renderMe();
        $('set-name').value = settings.displayName;
    }
    $('btn-name').addEventListener('click', changeName);

    // ---------- settings modal --------------------------------------------

    let recordingPtt = false;

    async function openSettings() {
        settings = await L.settings.get();
        $('set-name').value = settings.displayName || '';
        $('set-base').value = settings.baseUrl || '';
        $('set-mode').value = settings.voiceMode || 'open';
        $('set-ec').checked = settings.echoCancellation !== false;
        $('set-ns').checked = settings.noiseSuppression !== false;
        $('set-agc').checked = !!settings.autoGainControl;
        $('set-tray').checked = settings.minimizeToTray !== false;
        $('set-autoupdate').checked = settings.autoUpdateOnLaunch === true;
        refreshUpdateStatus();
        // Read the login item's ACTUAL OS state, so the toggle is correct even
        // if the user changed it outside the app.
        try {
            const li = await L.startup.get();
            $('set-launch').checked = !!li.openAtLogin;
            $('set-launch-hidden').checked = !!li.openAsHidden;
        } catch (e) {
            $('set-launch').checked = !!settings.launchOnStartup;
            $('set-launch-hidden').checked = !!settings.startMinimized;
        }
        updateLaunchHiddenEnabled();
        $('set-notify').checked = settings.notifications !== false;
        $('set-notify-sound').checked = settings.notificationSound !== false;
        $('set-voice-sounds').checked = settings.voiceSounds !== false;
        $('set-autojoin').checked = !!settings.autoJoinVoice;
        $('set-outvol').value = Math.round((settings.outputVolume === undefined ? 1 : settings.outputVolume) * 100);
        $('set-outvol-val').textContent = $('set-outvol').value + '%';
        $('set-font-size').value = FONT_SIZES[fontSizeIndex(settings.chatFontSize)].key;
        $('set-share-quality').value = settings.shareQuality || '1080p';
        $('set-share-motion').value = settings.shareMotion || 'sharp';
        $('set-share-audio').checked = settings.shareAudio !== false;
        $('set-ptt').textContent = (await L.ptt.describe(settings.pttBinding)) || 'Click to set';
        $('row-ptt').style.display = settings.voiceMode === 'ptt' ? '' : 'none';
        await populateDevices();
        refreshPttHint();
        $('settings').hidden = false;
    }

    $('btn-settings').addEventListener('click', openSettings);
    $('settings-close').addEventListener('click', () => { $('settings').hidden = true; });
    $('settings').addEventListener('mousedown', (e) => {
        if (e.target === $('settings')) $('settings').hidden = true;
    });

    async function populateDevices() {
        // Labels are only populated once mic permission has been granted.
        let devices = [];
        try { devices = await navigator.mediaDevices.enumerateDevices(); } catch (e) { return; }

        const fill = (sel, kind, current) => {
            sel.innerHTML = '<option value="">System default</option>';
            devices.filter((d) => d.kind === kind).forEach((d) => {
                const o = document.createElement('option');
                o.value = d.deviceId;
                o.textContent = d.label || `${kind === 'audioinput' ? 'Microphone' : 'Speaker'} ${sel.length}`;
                sel.appendChild(o);
            });
            sel.value = current || '';
        };
        fill($('set-mic'), 'audioinput', settings.micDeviceId);
        fill($('set-speaker'), 'audiooutput', settings.speakerDeviceId);
    }

    function refreshPttHint() {
        L.ptt.available().then((ok) => {
            $('ptt-hint').textContent = ok
                ? 'works system-wide'
                : 'in-app only while the window is focused';
        });
    }

    $('set-name').addEventListener('change', async (e) => {
        await saveSettings({ displayName: e.target.value.trim().slice(0, 40) });
        renderMe();
    });
    $('set-base').addEventListener('change', async (e) => {
        await saveSettings({ baseUrl: e.target.value.trim().replace(/\/+$/, '') });
        toast('Server changed — sign out and back in to apply');
    });
    $('set-mic').addEventListener('change', async (e) => {
        await saveSettings({ micDeviceId: e.target.value });
        if (voice.isJoined()) toast('Rejoin voice to switch microphone');
    });
    $('set-speaker').addEventListener('change', async (e) => {
        await saveSettings({ speakerDeviceId: e.target.value });
    });
    $('set-outvol').addEventListener('input', async (e) => {
        $('set-outvol-val').textContent = e.target.value + '%';
        await saveSettings({ outputVolume: Number(e.target.value) / 100 });
    });
    $('set-mode').addEventListener('change', async (e) => {
        await saveSettings({ voiceMode: e.target.value });
        $('row-ptt').style.display = e.target.value === 'ptt' ? '' : 'none';
        if (voice) voice.setPttHeld(false);
        await L.ptt.apply();
    });
    ['ec', 'ns', 'agc'].forEach((k) => {
        const map = { ec: 'echoCancellation', ns: 'noiseSuppression', agc: 'autoGainControl' };
        $('set-' + k).addEventListener('change', async (e) => {
            await saveSettings({ [map[k]]: e.target.checked });
            if (voice.isJoined()) toast('Rejoin voice to apply audio processing changes');
        });
    });
    $('set-font-size').addEventListener('change', async (e) => {
        await saveSettings({ chatFontSize: e.target.value });
        applyChatFontSize(e.target.value);
    });
    $('set-share-quality').addEventListener('change', async (e) => {
        await saveSettings({ shareQuality: e.target.value });
        voice.setShareQuality(e.target.value);
    });
    $('set-share-motion').addEventListener('change', async (e) => {
        await saveSettings({ shareMotion: e.target.value });
        voice.setShareMotion(e.target.value);
    });
    $('set-share-audio').addEventListener('change', (e) => saveSettings({ shareAudio: e.target.checked }));

    // "Start minimized" only makes sense when launch-on-startup is on.
    function updateLaunchHiddenEnabled() {
        const on = $('set-launch').checked;
        const row = $('set-launch-hidden').closest('.row');
        if (row) row.classList.toggle('disabled', !on);
        $('set-launch-hidden').disabled = !on;
    }

    async function applyStartup() {
        const openAtLogin = $('set-launch').checked;
        const openAsHidden = openAtLogin && $('set-launch-hidden').checked;
        const li = await L.startup.set(openAtLogin, openAsHidden);
        // Keep the mirror in settings, and reuse startMinimized for the "open
        // hidden" behaviour so a manual launch behaves the same.
        await saveSettings({ launchOnStartup: !!li.openAtLogin, startMinimized: !!li.openAsHidden });
        $('set-launch').checked = !!li.openAtLogin;
        $('set-launch-hidden').checked = !!li.openAsHidden;
        updateLaunchHiddenEnabled();
    }

    $('set-launch').addEventListener('change', applyStartup);
    $('set-launch-hidden').addEventListener('change', applyStartup);

    // ---- auto-update settings ----
    function updateStatusText(s) {
        const map = {
            idle: "You're on the latest version.",
            checking: 'Checking for updates…',
            none: "You're on the latest version.",
            available: `Update ${s.version} available.`,
            downloading: `Downloading ${s.version}… ${s.progress || 0}%`,
            ready: `${s.version} ready — restart to install.`,
            error: 'Update check failed — try again.'
        };
        $('update-status').textContent = map[s.status] || map.idle;
    }
    async function refreshUpdateStatus() {
        try { updateStatusText(await L.update.getState()); } catch (e) {}
    }
    // Keep the settings line in sync while the panel is open.
    L.update.onState((s) => { if (!$('settings').hidden) updateStatusText(s); });

    $('set-autoupdate').addEventListener('change', async (e) => {
        await saveSettings({ autoUpdateOnLaunch: e.target.checked });
        await L.update.setAuto(e.target.checked);
    });
    $('btn-check-update').addEventListener('click', async () => {
        $('update-status').textContent = 'Checking for updates…';
        const r = await L.update.check();
        if (r && r.reason === 'dev') $('update-status').textContent = 'Updates are only available in the installed app.';
    });

    $('set-tray').addEventListener('change', (e) => saveSettings({ minimizeToTray: e.target.checked }));
    $('set-notify').addEventListener('change', (e) => saveSettings({ notifications: e.target.checked }));
    // Preview the sound on enable, so the toggle proves itself.
    $('set-notify-sound').addEventListener('change', async (e) => {
        await saveSettings({ notificationSound: e.target.checked });
        if (e.target.checked) window.loungeSounds.playMessage();
    });
    $('set-voice-sounds').addEventListener('change', async (e) => {
        await saveSettings({ voiceSounds: e.target.checked });
        if (e.target.checked) window.loungeSounds.playVoice('join');
    });
    $('set-autojoin').addEventListener('change', (e) => saveSettings({ autoJoinVoice: e.target.checked }));

    // PTT key recorder: captures the next key or mouse button pressed.
    $('set-ptt').addEventListener('click', () => {
        if (recordingPtt) return;
        recordingPtt = true;
        const btn = $('set-ptt');
        btn.classList.add('recording');
        btn.textContent = 'Press any key…';

        const finish = async (binding) => {
            recordingPtt = false;
            btn.classList.remove('recording');
            window.removeEventListener('keydown', onKey, true);
            window.removeEventListener('mousedown', onMouse, true);
            if (binding) {
                await saveSettings({ pttBinding: binding });
                await L.ptt.apply();
            }
            btn.textContent = (await L.ptt.describe(settings.pttBinding)) || 'Click to set';
            refreshPttHint();
        };

        const onKey = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === 'Escape') return finish(null);
            finish({
                type: 'key', code: e.code,
                ctrl: e.ctrlKey && !/^Control/.test(e.code),
                shift: e.shiftKey && !/^Shift/.test(e.code),
                alt: e.altKey && !/^Alt/.test(e.code),
                meta: e.metaKey && !/^Meta|^OS/.test(e.code)
            });
        };
        const onMouse = (e) => {
            // Only the extra side buttons — hijacking left/right click would make
            // the app unusable.
            if (e.button < 3) return;
            e.preventDefault();
            e.stopPropagation();
            finish({ type: 'mouse', code: 'Mouse' + e.button, button: e.button + 1 });
        };
        window.addEventListener('keydown', onKey, true);
        window.addEventListener('mousedown', onMouse, true);
    });

    $('btn-logout').addEventListener('click', async () => {
        if (voice.isJoined()) { heartbeatPresence(true); voice.leave(); }
        stopPolling();
        stopPresence();
        await L.auth.logout();
        await L.rt.stop();
        $('settings').hidden = true;
        $('app').hidden = true;
        $('login').hidden = false;
        $('login-error').textContent = '';
        $('login-pw').focus();
    });

    // ---------- inline audio player ---------------------------------------
    // Custom controls rather than <audio controls> so it matches the theme and
    // so we can enforce one-clip-at-a-time. Never autoplays.

    let playingAudio = null;   // the only <audio> allowed to be running

    function stopOtherAudio(except) {
        if (playingAudio && playingAudio !== except && !playingAudio.paused) {
            playingAudio.pause();
        }
        playingAudio = except;
    }

    function fmtTime(sec) {
        if (!Number.isFinite(sec) || sec < 0) return '0:00';
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return m + ':' + String(s).padStart(2, '0');
    }

    function audioPlayer(src, name) {
        const wrap = document.createElement('div');
        wrap.className = 'audio-card';
        wrap.innerHTML =
            `<div class="au-name" title="${esc(name || '')}">♪ ${esc(name || 'audio')}</div>` +
            '<div class="au-row">' +
            '<button class="au-play" type="button" title="Play"><svg viewBox="0 0 24 24" class="au-ico-play"><path d="M8 5v14l11-7z"/></svg>' +
            '<svg viewBox="0 0 24 24" class="au-ico-pause" hidden><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg></button>' +
            '<input class="au-seek" type="range" min="0" max="1000" value="0" step="1" title="Seek">' +
            '<span class="au-time">0:00 / 0:00</span>' +
            '<svg viewBox="0 0 24 24" class="au-vol-ico"><path d="M11 5L6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>' +
            '<input class="au-vol" type="range" min="0" max="100" value="100" step="1" title="Volume">' +
            '</div>';

        const audio = new Audio();
        audio.preload = 'metadata';        // duration without downloading it all
        audio.src = src;

        const playBtn = wrap.querySelector('.au-play');
        const icoPlay = wrap.querySelector('.au-ico-play');
        const icoPause = wrap.querySelector('.au-ico-pause');
        const seek = wrap.querySelector('.au-seek');
        const time = wrap.querySelector('.au-time');
        const vol = wrap.querySelector('.au-vol');

        let scrubbing = false;

        const paint = () => {
            const d = audio.duration;
            time.textContent = `${fmtTime(audio.currentTime)} / ${fmtTime(d)}`;
            if (!scrubbing && Number.isFinite(d) && d > 0) {
                seek.value = String(Math.round((audio.currentTime / d) * 1000));
            }
        };
        const setPlayingUI = (playing) => {
            icoPlay.hidden = playing;
            icoPause.hidden = !playing;
            playBtn.title = playing ? 'Pause' : 'Play';
            wrap.classList.toggle('playing', playing);
        };

        playBtn.addEventListener('click', () => {
            if (audio.paused) {
                stopOtherAudio(audio);        // only one clip at a time
                audio.play().catch(() => toast('Could not play that audio', true));
            } else {
                audio.pause();
            }
        });

        audio.addEventListener('play', () => { stopOtherAudio(audio); setPlayingUI(true); });
        audio.addEventListener('pause', () => setPlayingUI(false));
        audio.addEventListener('ended', () => { setPlayingUI(false); seek.value = '0'; paint(); });
        audio.addEventListener('loadedmetadata', paint);
        audio.addEventListener('timeupdate', paint);
        audio.addEventListener('error', () => {
            time.textContent = 'unavailable';
            playBtn.disabled = true;
        });

        seek.addEventListener('pointerdown', () => { scrubbing = true; });
        const commitSeek = () => {
            const d = audio.duration;
            if (Number.isFinite(d) && d > 0) audio.currentTime = (Number(seek.value) / 1000) * d;
            scrubbing = false;
        };
        seek.addEventListener('change', commitSeek);
        seek.addEventListener('input', () => {
            const d = audio.duration;
            if (Number.isFinite(d) && d > 0) {
                time.textContent = `${fmtTime((Number(seek.value) / 1000) * d)} / ${fmtTime(d)}`;
            }
        });

        vol.addEventListener('input', () => { audio.volume = Number(vol.value) / 100; });

        return wrap;
    }

    // ---------- context menu ----------------------------------------------

    function closeCtxMenu() { $('ctx-menu').hidden = true; }

    // items: [{ label, icon, danger, disabled, onClick } | 'sep']
    function openCtxMenu(items, x, y) {
        const menu = $('ctx-menu');
        menu.innerHTML = '';

        items.filter(Boolean).forEach((it) => {
            if (it === 'sep') {
                const s = document.createElement('div');
                s.className = 'ctx-sep';
                menu.appendChild(s);
                return;
            }
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'ctx-item' + (it.danger ? ' danger' : '');
            b.innerHTML = `<span>${esc(it.icon || '')}</span><span>${esc(it.label)}</span>`;
            // Greyed out rather than hidden: a Paste that would do nothing still
            // tells you the menu has a Paste.
            if (it.disabled) b.disabled = true;
            else b.addEventListener('click', () => { closeCtxMenu(); it.onClick(); });
            menu.appendChild(b);
        });

        // A menu should never steal focus — the composer's Cut/Copy/Paste act on
        // whatever was focused when it opened.
        menu.onmousedown = (ev) => ev.preventDefault();

        // Show off-screen first so the size is measurable, then clamp on-screen.
        menu.hidden = false;
        menu.style.left = '0px';
        menu.style.top = '0px';
        const w = menu.offsetWidth, h = menu.offsetHeight;
        menu.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px';
        menu.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + 'px';
    }

    document.addEventListener('mousedown', (e) => {
        if (!$('ctx-menu').hidden && !e.target.closest('#ctx-menu')) closeCtxMenu();
    });
    window.addEventListener('blur', closeCtxMenu);
    document.addEventListener('scroll', closeCtxMenu, true);

    function messageMenuItems(p, el) {
        const mine = p.client_id && p.client_id === settings.clientId;
        return [
            { label: 'Copy text', icon: '⧉', onClick: () => copyMessage(p) },
            p.att_key && { label: 'Save attachment…', icon: '⤓', onClick: () => saveAttachment(p.att_key, p.att_name) },
            { label: p.pinned ? 'Unpin' : 'Pin', icon: '📌', onClick: () => pinPost(p.id, !p.pinned) },
            mine && 'sep',
            mine && { label: 'Edit message', icon: '✎', onClick: () => startEdit(p, el) },
            mine && { label: 'Delete message', icon: '🗑', danger: true, onClick: () => deletePost(p) }
        ];
    }

    // ---------- links -------------------------------------------------------

    // Anything we might hand to the shell is parsed and scheme-checked first.
    // A message body is attacker-controlled, and openExternal on a file:// or a
    // registered custom protocol is a way to run code on this machine — so
    // anything that isn't plainly http(s) is not offered at all.
    function safeHttpUrl(raw) {
        const s = String(raw || '').trim();
        try {
            const u = new URL(s);
            return (u.protocol === 'http:' || u.protocol === 'https:') ? s : null;
        } catch (e) { return null; }
    }

    // The url behind whatever was right-clicked: a linkified url in the text, or
    // anywhere on a preview card (the whole card carries the url, so the
    // thumbnail and the padding work as well as the title).
    function linkTarget(el) {
        if (!el) return null;
        const a = el.closest('a[data-external]');
        if (a) return safeHttpUrl(a.getAttribute('href'));
        const card = el.closest('[data-link-url]');
        if (card) return safeHttpUrl(card.dataset.linkUrl);
        return null;
    }

    function linkMenuItems(url) {
        return [
            { label: 'Open link', icon: '↗', onClick: () => L.app.openExternal(url) },
            { label: 'Copy link address', icon: '🔗', onClick: () => copyLink(url) }
        ];
    }

    // ---------- images ------------------------------------------------------

    // Everything that acts on an image takes one of these: an attachment key
    // (ours) or a remote url (a link preview), plus a display name.
    function imageRef(el) {
        if (!el || el.tagName !== 'IMG') return null;
        if (el.dataset.attKey) return { key: el.dataset.attKey, name: el.dataset.attName || 'image' };
        if (/^https?:/i.test(el.src)) return { url: el.src, name: urlFileName(el.src) };
        return null;
    }

    function urlFileName(url) {
        try {
            const n = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
            return n || 'image';
        } catch (e) { return 'image'; }
    }

    // A link others can actually open: our attachments live behind the board's
    // gated file endpoint, link previews are already public urls.
    function shareableUrl(ref) {
        if (ref.url) return ref.url;
        if (!ref.key) return null;
        const base = (settings.baseUrl || 'https://scarmonit.com').replace(/\/+$/, '');
        return base + '/api/board/file?key=' + encodeURIComponent(ref.key);
    }

    // The one definition of the image actions. The inline image in chat and the
    // expanded lightbox both open this, so they can't drift apart.
    function imageMenuItems(ref) {
        const link = shareableUrl(ref);
        return [
            { label: 'Copy image', icon: '⧉', onClick: () => copyImage(ref) },
            { label: 'Save image as…', icon: '💾', onClick: () => saveImageAs(ref) },
            { label: 'Download image', icon: '⤓', onClick: () => downloadImage(ref) },
            link && 'sep',
            link && { label: 'Copy image link', icon: '🔗', onClick: () => copyLink(link) }
        ];
    }

    // ---------- image lightbox --------------------------------------------

    let lightboxImage = null;   // an imageRef

    function openLightbox(src, ref) {
        lightboxImage = ref;
        const name = ref && ref.name;
        const img = $('lb-image');
        img.src = src;
        setZoom(false);                       // always open fitted
        $('lb-caption').textContent = name || '';
        $('lightbox').hidden = false;
        // Only offer "actual size" when it would actually reveal more pixels.
        img.onload = () => {
            const stage = $('lb-stage');
            const bigger = img.naturalWidth > stage.clientWidth - 40 ||
                img.naturalHeight > stage.clientHeight - 40;
            $('lb-zoom').hidden = !bigger;
            $('lb-caption').textContent =
                (name || '') + (bigger ? ` · ${img.naturalWidth}×${img.naturalHeight}` : '');
        };
    }

    // fit = contained in the stage; actual = natural size with the stage scrolling.
    function setZoom(actual) {
        const img = $('lb-image');
        img.classList.toggle('actual', actual);
        img.classList.toggle('fit', !actual);
        $('lb-zoom').textContent = actual ? 'Fit to window' : 'Actual size';
        $('lb-zoom').title = actual ? 'Fit the image to the window' : 'Show at actual size';
        if (!actual) { $('lb-stage').scrollTop = 0; $('lb-stage').scrollLeft = 0; }
    }

    function toggleZoom() { setZoom(!$('lb-image').classList.contains('actual')); }

    function closeLightbox() {
        $('lightbox').hidden = true;
        $('lb-image').src = '';
        $('lb-image').onload = null;
        lightboxImage = null;
        closeCtxMenu();
    }

    $('lb-close').addEventListener('click', closeLightbox);
    $('lb-zoom').addEventListener('click', toggleZoom);
    $('lb-image').addEventListener('click', toggleZoom);

    // Backdrop click closes; clicks on the image or the tools must not.
    $('lightbox').addEventListener('click', (e) => {
        if (e.target.closest('#lb-image') || e.target.closest('.lb-tools')) return;
        closeLightbox();
    });

    $('lb-image').addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (!lightboxImage) return;
        openCtxMenu(imageMenuItems(lightboxImage), e.clientX, e.clientY);
    });

    async function downloadImage(ref) {
        const res = await L.downloadAttachment(ref.key, ref.name, ref.url);
        if (res && res.success) { toast('Saved to ' + res.path); L.revealFile(res.path); }
        else toast('Could not download: ' + ((res && res.error) || 'unknown error'), true);
    }

    async function copyImage(ref) {
        const res = await L.copyImage(ref.key, ref.url);
        toast(res && res.success ? 'Image copied' : 'Could not copy: ' + ((res && res.error) || 'unknown'), !(res && res.success));
    }

    function saveImageAs(ref) { return saveAttachment(ref.key, ref.name, ref.url); }

    function copyLink(url) {
        navigator.clipboard.writeText(url).then(
            () => toast('Link copied'),
            () => toast('Could not copy', true)
        );
    }

    async function saveAttachment(key, name, url) {
        const res = await L.saveAttachment(key, name, url);
        if (res && res.success) { toast('Saved to ' + res.path); L.revealFile(res.path); }
        else if (res && !res.canceled) toast('Could not save: ' + ((res && res.error) || 'unknown error'), true);
    }

    // ---------- message actions -------------------------------------------

    function copyMessage(p) {
        const text = p.body || p.att_name || '';
        navigator.clipboard.writeText(text).then(
            () => toast('Copied'),
            () => toast('Could not copy', true)
        );
    }

    // Inline editor: Enter saves, Shift+Enter newlines, Esc cancels.
    let editingId = null;

    function startEdit(p, el) {
        if (editingId) return;                       // one at a time
        const textEl = el.querySelector('.msg-text');
        if (!textEl) return;
        editingId = p.id;

        const original = textEl.innerHTML;
        const wrap = document.createElement('div');
        wrap.className = 'msg-edit';
        wrap.innerHTML =
            '<textarea maxlength="2000"></textarea>' +
            '<div class="msg-edit-hint"><b>Enter</b> to save · <b>Esc</b> to cancel</div>';
        const ta = wrap.querySelector('textarea');
        ta.value = p.body || '';

        textEl.replaceWith(wrap);
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';

        const restore = () => {
            editingId = null;
            const back = document.createElement('div');
            back.className = 'msg-text';
            back.innerHTML = original;
            wrap.replaceWith(back);
            renderMessages();      // resync anything the poll held back
        };

        ta.addEventListener('input', () => {
            ta.style.height = 'auto';
            ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
        });

        ta.addEventListener('keydown', async (e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); restore(); return; }
            if (e.key !== 'Enter' || e.shiftKey) return;
            e.preventDefault();

            const body = ta.value.trim();
            if (!body) { toast('Message is empty — use delete instead', true); return; }
            if (body === (p.body || '')) { restore(); return; }

            ta.disabled = true;
            const res = await L.board('edit', {
                method: 'POST', body: { id: p.id, clientId: settings.clientId, body }
            });

            if (res && res.needsAuth) { editingId = null; return relogin(); }
            if (!res || !res.success) {
                // Keep the editor open with their text intact so nothing is lost.
                ta.disabled = false;
                ta.focus();
                return toast((res && res.error) || 'Could not edit', true);
            }

            editingId = null;
            // The server stamps edited_at, so reload rather than guessing — that
            // makes the "(edited)" marker reflect real server state.
            await loadMessages(false);
            L.rt.notifyPosted(channel);
            toast('Message edited');
        });
    }

    async function deletePost(p) {
        if (p.client_id !== settings.clientId) return toast('You can only delete your own messages', true);

        const preview = (p.body || p.att_name || '').slice(0, 80);
        const ok = await askConfirm(
            'Delete this message?',
            preview ? `“${preview}${preview.length >= 80 ? '…' : ''}” will be permanently removed.`
                : 'This message will be permanently removed.',
            'Delete', true
        );
        if (!ok) return;

        const res = await L.board('delete', { method: 'POST', body: { id: p.id } });
        if (res && res.needsAuth) return relogin();
        if (!res || !res.success) return toast((res && res.error) || 'Could not delete', true);

        posts = posts.filter((x) => x.id !== p.id);
        renderMessages();
        await loadMessages(false);
        L.rt.notifyPosted(channel);
        toast('Message deleted');
    }

    // ---------- link previews ---------------------------------------------
    // Cache is url -> preview object | null (no metadata) | 'pending'. Fetches
    // are fire-and-forget: the message is already on screen, and the card is
    // grafted into its container when (and if) the metadata arrives.

    const previewCache = new Map();
    const youtubeCache = new Map();
    const URL_RE = /https?:\/\/[^\s<>"']+/g;
    const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)(\?[^\s]*)?$/i;

    function extractUrls(body) {
        const found = String(body || '').match(URL_RE) || [];
        // Trim trailing punctuation people type after a link.
        return [...new Set(found.map((u) => u.replace(/[),.;:!?\]]+$/, '')))].slice(0, 3);
    }

    // Pull an 11-character video id out of any of YouTube's URL shapes, ignoring
    // whatever tracking/timestamp/playlist params are hanging off the end.
    function youtubeId(raw) {
        let u;
        try { u = new URL(raw); } catch (e) { return null; }
        if (!/^https?:$/.test(u.protocol)) return null;

        const host = u.hostname.replace(/^(www|m|music)\./, '');
        const ok = (id) => (/^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : null);

        if (host === 'youtu.be') return ok(u.pathname.slice(1).split('/')[0]);
        if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
            if (u.pathname === '/watch') return ok(u.searchParams.get('v'));
            // /shorts/ID, /embed/ID, /v/ID, /live/ID
            const m = u.pathname.match(/^\/(?:shorts|embed|v|live)\/([^/?#]+)/);
            if (m) return ok(m[1]);
        }
        return null;
    }

    function youtubeCard(info) {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'yt-card';
        card.innerHTML =
            '<div class="yt-thumb">' +
            `<img src="${esc(info.thumbnail)}" alt="" loading="lazy">` +
            '<span class="yt-play" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></span>' +
            '</div>' +
            '<div class="yt-body">' +
            '<div class="yt-site">YouTube</div>' +
            `<div class="yt-title">${esc(info.title)}</div>` +
            (info.author ? `<div class="yt-author">${esc(info.author)}</div>` : '') +
            '</div>';
        card.title = 'Open on YouTube';
        // On the card, not just the title, so right-clicking the thumbnail or
        // the padding offers the link too.
        card.dataset.linkUrl = info.url;
        card.addEventListener('click', () => L.app.openExternal(info.url));
        const img = card.querySelector('img');
        // If the thumbnail 404s, fall back to the well-known static path.
        img.addEventListener('error', () => {
            const fallback = `https://img.youtube.com/vi/${info.id}/hqdefault.jpg`;
            if (img.src !== fallback) img.src = fallback; else card.remove();
        }, { once: false });
        return card;
    }

    function imageCard(url) {
        const img = document.createElement('img');
        img.className = 'link-image';
        img.src = url;
        img.loading = 'lazy';
        img.alt = '';
        img.addEventListener('click', () => openLightbox(url, imageRef(img)));
        // A hotlinked image that 404s shouldn't leave a broken icon behind.
        img.addEventListener('error', () => img.remove());
        return img;
    }

    function linkCard(preview) {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'link-card';
        card.innerHTML =
            '<div class="lc-body">' +
            (preview.site ? `<div class="lc-site">${esc(preview.site)}</div>` : '') +
            `<div class="lc-title">${esc(preview.title)}</div>` +
            (preview.description ? `<div class="lc-desc">${esc(preview.description)}</div>` : '') +
            '</div>' +
            (preview.image ? `<img class="lc-thumb" src="${esc(preview.image)}" alt="" loading="lazy">` : '');
        card.dataset.linkUrl = preview.url;
        card.addEventListener('click', () => L.app.openExternal(preview.url));
        const thumb = card.querySelector('.lc-thumb');
        if (thumb) thumb.addEventListener('error', () => thumb.remove());
        return card;
    }

    // Append a card to every live copy of this message, but only once per url —
    // the same message can be re-rendered while a fetch is still in flight.
    function graft(postId, url, build) {
        document.querySelectorAll(`.msg[data-id="${postId}"] .msg-previews`).forEach((c) => {
            if (c.querySelector(`[data-preview-url="${CSS.escape(url)}"]`)) return;
            const el = build();
            if (!el) return;
            el.dataset.previewUrl = url;
            c.appendChild(el);
        });
    }

    // Detection order per url: YouTube → direct image → generic OG preview.
    // A message with several links renders each independently.
    function renderPreviews(container, post) {
        if (!container || !post.body) return;

        extractUrls(post.body).forEach((url) => {
            const vid = youtubeId(url);

            if (vid) {
                const cached = youtubeCache.get(vid);
                if (cached === null) return;                    // private/deleted → plain link stands
                if (cached && cached !== 'pending') {
                    const el = youtubeCard(cached);
                    el.dataset.previewUrl = url;
                    container.appendChild(el);
                    return;
                }
                if (cached === 'pending') return;

                youtubeCache.set(vid, 'pending');
                L.youtube(vid).then((info) => {
                    youtubeCache.set(vid, info || null);
                    if (info) graft(post.id, url, () => youtubeCard(info));
                }).catch(() => youtubeCache.set(vid, null));
                return;
            }

            // A direct image link renders as the image itself — no round trip.
            if (IMAGE_RE.test(url)) {
                const el = imageCard(url);
                el.dataset.previewUrl = url;
                container.appendChild(el);
                return;
            }

            const cached = previewCache.get(url);
            if (cached === null) return;                                  // no metadata; plain link stands
            if (cached && cached !== 'pending') {
                const el = linkCard(cached);
                el.dataset.previewUrl = url;
                container.appendChild(el);
                return;
            }
            if (cached === 'pending') return;

            previewCache.set(url, 'pending');
            L.unfurl(url).then((res) => {
                const preview = (res && res.success && res.preview) ? res.preview : null;
                previewCache.set(url, preview);
                // Graft into the live node instead of re-rendering the list, so
                // the reader's scroll position is never disturbed.
                if (preview) graft(post.id, url, () => linkCard(preview));
            }).catch(() => previewCache.set(url, null));
        });
    }

    // ---------- filters + search -----------------------------------------
    // Filters the currently-loaded messages, live. Types (Links/Images/Videos/
    // Audio/Files) combine as OR; every other criterion (text, from-user,
    // pinned, mentions, edited) is AND. Clearing returns to the live view at the
    // same scroll position. Load-more widens the pool a filter searches over.

    function filterOpen() { return !$('filter-bar').hidden; }

    function toggleFilter(open) {
        $('filter-bar').hidden = !open;
        if (open) {
            $('pinned-panel').hidden = true;
            populateFromSelect();
            $('filter-input').focus();
            $('filter-input').select();
        } else {
            clearFilters();
            $('filter-menu').hidden = true;
        }
    }

    function clearFilters() {
        filter.text = '';
        filter.types.clear();
        filter.pinned = filter.mentions = filter.edited = false;
        filter.fromIds = filter.fromName = null;
        $('filter-input').value = '';
        const fs = $('filter-from'); if (fs) fs.value = '';
        applyFilter();
    }

    // The single entry point for any filter change: re-renders the (filtered)
    // list, refreshes the chips, and restores scroll when filters go inactive.
    function applyFilter() {
        const active = filterActive();
        if (active && filterScrollTop === null) filterScrollTop = $('messages').scrollTop;
        renderChips();
        syncMenuButtons();
        renderMessages();
        if (!active) {
            $('filter-count').textContent = '';
            if (filterScrollTop !== null) {
                const t = filterScrollTop; filterScrollTop = null;
                requestAnimationFrame(() => { $('messages').scrollTop = t; settleScroll(); });
            }
        }
        settleScroll();
    }

    function updateFilterCount(n) {
        $('filter-count').textContent = n + (n === 1 ? ' match' : ' matches');
    }

    const TYPE_LABELS = { links: '🔗 Links', images: '🖼️ Images', videos: '🎬 Videos', audio: '🎵 Audio', files: '📎 Files' };

    // Active filters as removable chips, plus a Clear all.
    function renderChips() {
        const box = $('filter-chips');
        box.innerHTML = '';
        const chips = [];
        filter.types.forEach((t) => chips.push({ label: TYPE_LABELS[t] || t, off: () => filter.types.delete(t) }));
        if (filter.pinned) chips.push({ label: '📌 Pinned', off: () => { filter.pinned = false; } });
        if (filter.mentions) chips.push({ label: '@ Mentions me', off: () => { filter.mentions = false; } });
        if (filter.edited) chips.push({ label: '✎ Edited', off: () => { filter.edited = false; } });
        if (filter.fromIds) chips.push({ label: 'From ' + (filter.fromName || 'user'), off: () => { filter.fromIds = filter.fromName = null; const fs = $('filter-from'); if (fs) fs.value = ''; } });
        if (filter.text) chips.push({ label: '“' + filter.text + '”', off: () => { filter.text = ''; $('filter-input').value = ''; } });

        box.hidden = chips.length === 0;
        chips.forEach((c) => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'fb-chip';
            chip.innerHTML = '<span>' + esc(c.label) + '</span><span class="fb-chip-x">✕</span>';
            chip.addEventListener('click', () => { c.off(); applyFilter(); });
            box.appendChild(chip);
        });
        if (chips.length > 1) {
            const clr = document.createElement('button');
            clr.type = 'button';
            clr.className = 'fb-clear';
            clr.textContent = 'Clear all';
            clr.addEventListener('click', () => clearFilters());
            box.appendChild(clr);
        }
    }

    // Reflect active state on the dropdown's toggle buttons.
    function syncMenuButtons() {
        document.querySelectorAll('#filter-menu .fb-opt').forEach((b) => {
            const t = b.dataset.type, f = b.dataset.flag;
            const on = (t && filter.types.has(t)) || (f && filter[f]);
            b.classList.toggle('on', !!on);
        });
    }

    // Populate the "From" dropdown from everyone seen in the loaded messages.
    function populateFromSelect() {
        const sel = $('filter-from');
        if (!sel) return;
        // Group by display name, not client_id: one person posting from two
        // devices is still one person, and every poster who never set a name
        // would otherwise get their own duplicate "Anonymous" row.
        const byName = new Map();
        posts.forEach((p) => {
            if (!p.client_id) return;
            const name = (p.client_id === settings.clientId) ? 'You' : (p.name || 'Anonymous');
            if (!byName.has(name)) byName.set(name, new Set());
            byName.get(name).add(p.client_id);
        });
        const cur = filter.fromIds ? filter.fromIds.join(',') : '';
        sel.innerHTML = '<option value="">anyone</option>';
        [...byName.entries()].sort((a, b) => a[0].localeCompare(b[0])).forEach(([name, ids]) => {
            const o = document.createElement('option');
            o.value = [...ids].join(',');
            o.textContent = name;
            sel.appendChild(o);
        });
        sel.value = cur;
    }

    $('btn-search').addEventListener('click', () => toggleFilter(!filterOpen()));
    $('filter-close').addEventListener('click', () => toggleFilter(false));

    $('filter-menu-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        $('filter-menu').hidden = !$('filter-menu').hidden;
    });
    document.addEventListener('mousedown', (e) => {
        if (!$('filter-menu').hidden && !e.target.closest('#filter-menu') && !e.target.closest('#filter-menu-btn')) {
            $('filter-menu').hidden = true;
        }
    });

    document.querySelectorAll('#filter-menu .fb-opt').forEach((b) => {
        b.addEventListener('click', () => {
            const t = b.dataset.type, f = b.dataset.flag;
            if (t) { filter.types.has(t) ? filter.types.delete(t) : filter.types.add(t); }
            else if (f) { filter[f] = !filter[f]; }
            applyFilter();
        });
    });

    $('filter-from').addEventListener('change', (e) => {
        filter.fromIds = e.target.value ? e.target.value.split(',') : null;
        filter.fromName = e.target.value ? e.target.options[e.target.selectedIndex].textContent : null;
        applyFilter();
    });

    $('filter-input').addEventListener('input', () => {
        clearTimeout(filterTimer);
        filterTimer = setTimeout(() => { filter.text = $('filter-input').value.trim(); applyFilter(); }, 200);
    });
    $('filter-input').addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); toggleFilter(false); }
    });

    // In a filtered view, clicking a matching message (not an interactive part)
    // clears the filters and jumps to it among its neighbours — full context.
    $('messages').addEventListener('click', (e) => {
        if (!filterActive()) return;
        if (e.target.closest('button, a, input, textarea, select, .reaction, .msg-actions, img[data-lightbox], .att-save, .yt-card, .link-card, audio, video')) return;
        const row = e.target.closest('.msg');
        if (!row) return;
        const id = parseInt(row.dataset.id, 10);
        const p = posts.find((x) => x.id === id);
        if (p) jumpToPost(p);
    });

    // Walk back through history until the post is loaded, then flash it.
    async function jumpToPost(target) {
        // Drop any active filters so the message shows among its neighbours, but
        // keep the filter bar open so the user can refine again. Forget the
        // saved pre-filter scroll position first: otherwise clearFilters queues
        // a restore that lands after — and undoes — the scroll to the target.
        if (filterActive()) { filterScrollTop = null; clearFilters(); }
        if (target.channel && target.channel !== channel) {
            await switchChannel(target.channel);
        }

        for (let page = 0; page < 6; page++) {
            if (posts.some((p) => p.id === target.id)) break;
            if (!hasMore) break;
            await loadMessages(false, posts.length ? posts[0].id : null);
        }

        const el = document.querySelector(`.msg[data-id="${target.id}"]`);
        if (!el) {
            toast('That message is further back than we can jump — try the website');
            return;
        }
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.classList.remove('flash');
        void el.offsetWidth;                 // restart the animation
        el.classList.add('flash');
    }

    // ---------- pinned ----------------------------------------------------

    async function pinPost(id, pinned) {
        const res = await L.board('pin', { method: 'POST', body: { id, pinned } });
        if (res && res.needsAuth) return relogin();
        if (!res || !res.success) return toast((res && res.error) || 'Could not pin', true);
        // Reflect immediately, then refresh from the server.
        const p = posts.find((x) => x.id === id);
        if (p) p.pinned = pinned ? 1 : 0;
        renderMessages();
        if (!$('pinned-panel').hidden) renderPinned();
        await loadMessages(false);
        toast(pinned ? 'Pinned' : 'Unpinned');
    }

    function togglePinned(open) {
        const panel = $('pinned-panel');
        panel.hidden = !open;
        if (open) { toggleFilter(false); renderPinned(); }
    }

    $('btn-pinned').addEventListener('click', () => togglePinned($('pinned-panel').hidden));
    $('pinned-close').addEventListener('click', () => togglePinned(false));

    function renderPinned() {
        const list = $('pinned-list');
        $('pinned-channel').textContent = channel;
        list.innerHTML = '';

        const pinned = posts.filter((p) => p.pinned);
        if (!pinned.length) {
            const e = document.createElement('div');
            e.className = 'pinned-empty';
            e.textContent = 'No pinned messages in this channel yet.';
            list.appendChild(e);
            return;
        }

        pinned.forEach((p) => {
            const item = document.createElement('div');
            item.className = 'pinned-item';
            const body = p.body || (p.att_name ? '📎 ' + p.att_name : '');
            item.innerHTML =
                '<div class="pinned-top">' +
                `<span class="pinned-name">${esc(p.name)}</span>` +
                `<span class="pinned-time">${esc(timeStr(p.created_at))}</span>` +
                '<button class="pinned-unpin" type="button">Unpin</button>' +
                '</div>' +
                `<div class="pinned-body">${esc(body.slice(0, 240))}</div>`;
            item.addEventListener('click', () => jumpToPost(p));
            item.querySelector('.pinned-unpin').addEventListener('click', (e) => {
                e.stopPropagation();
                pinPost(p.id, false);
            });
            list.appendChild(item);
        });
    }

    // ---------- window chrome ---------------------------------------------

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (!$('ctx-menu').hidden) closeCtxMenu();
            else if (!$('lightbox').hidden) closeLightbox();
            else if (!$('dialog').hidden) closeDialog(inp_null());
            else if (!$('picker').hidden) closePicker();
            else if (!$('popover').hidden) closePopover();
            else if (!$('settings').hidden) $('settings').hidden = true;
            else if (!$('filter-menu').hidden) $('filter-menu').hidden = true;
            else if (filterOpen()) toggleFilter(false);
            else if (!$('pinned-panel').hidden) togglePinned(false);
        }
        // Ctrl+F opens the filter/search bar, like every other chat client.
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && !$('app').hidden) {
            e.preventDefault();
            toggleFilter(true);
        }

        // Ctrl +/-/0 resize the chat text. Matching the browser/Discord muscle
        // memory means intercepting the same keys Chromium would zoom with.
        if ((e.ctrlKey || e.metaKey) && !e.altKey && !$('app').hidden) {
            // '=' and '+' share a key; the numpad reports 'Add'/'Subtract'.
            const up = e.key === '+' || e.key === '=' || e.code === 'NumpadAdd';
            const down = e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract';
            const reset = e.key === '0' || e.code === 'Numpad0';
            if (up || down || reset) {
                e.preventDefault();
                stepChatFontSize(up ? 1 : down ? -1 : 0);
            }
        }
    });

    // Leaving voice cleanly on quit keeps the presence row from lingering.
    window.addEventListener('beforeunload', () => {
        if (voice && voice.isJoined()) {
            heartbeatPresence(true);
            voice.leave();
        }
    });

    boot();
})();
