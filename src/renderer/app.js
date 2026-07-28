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
    // Every control glyph comes from the one icon set (see icons.js). Emoji are
    // reserved for content — reactions, the picker, and message text.
    const I = (name, cls) => window.ScarmIcons.markup(name, cls || 'ico');

    const POLL_ACTIVE_MS = 4000;    // socket down → poll this often
    // Socket up → this is a SAFETY NET, not the delivery mechanism: the Durable
    // Object pushes every post, rt.js runs a 20s ping/pong liveness check, and
    // reconnecting triggers a full resync. At 15s it was re-fetching the page
    // and the channel list 8 times a minute to re-learn what the socket had
    // already told us.
    const POLL_IDLE_MS = 60000;
    const PRESENCE_MS = 5000;       // voice presence heartbeat (server TTL is 12s)
    const TYPING_MS = 3000;
    const PAGE = 40;
    // Ceiling on retained history. Deep enough that ordinary scrolling back
    // never hits it, shallow enough that a long session can't accumulate
    // thousands of live DOM nodes and the arrays that back them.
    const MAX_POSTS = 400;

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
    // Assume NOT focused until the main process says otherwise.
    //
    // This used to start `true` and only ever move on a 'focus'/'blur' event —
    // and a window that is never shown emits neither. So launching straight to
    // the tray ("start with Windows, minimized", or --openAsHidden) left this
    // stuck at true for the whole session: notifyForPosts() and the DM notifier
    // both bail on `if (windowFocused) return`, so the one configuration where
    // notifications are the ONLY way to learn about a message was the one
    // configuration that never raised any. It also reported you as "online" in
    // everyone's member list while the window had never been opened.
    //
    // Starting false is the safe direction: main.js re-checks win.isFocused()
    // before it will show a notification, so a stale false can never produce
    // one you shouldn't get. boot() asks for the real answer either way.
    let windowFocused = false;
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
        // The chosen person as an IDENTITY — { label, names, userIds } — not as
        // a list of install ids. See postFrom() in lib.js.
        from: null,
        fromName: null
    };
    function filterActive() {
        return !!(filter.text || filter.types.size || filter.pinned ||
            filter.mentions || filter.edited || filter.from);
    }

    // ---------- utilities -------------------------------------------------

    // The pure half of the renderer lives in lib.js so it can be unit-tested;
    // these are local names for the parts used here.
    const {
        esc, avatarStyle, bannerStyle, initials, isOnlyEmoji,
        timeStr, dayStr, fmtSize, fmtDuration, splitName,
        attachmentKind, fileIcon,
        extractUrls, safeHttpUrl, urlFileName, youtubeId,
        FONT_SIZES, fontSizeIndex, matchesPttBinding
    } = window.ScarmLib;

    let toastTimer = null;
    function toast(msg, isError) {
        const el = $('toast');
        el.textContent = msg;
        el.classList.toggle('err', !!isError);
        el.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 5200 : 2600);
    }

    // ---------- message formatting ----------------------------------------
    // Ported from the website's board.js so the same message reads identically
    // in both clients. Every piece of user text lands via textContent and every
    // element is built with createElement — no HTML string ever carries a
    // message body, so adding formatting adds no injection path.

    // Names seen in this session, for @mention matching and autocomplete.
    const rosterSet = new Set();
    function addRosterName(name) {
        const n = String(name || '').trim();
        if (!n || n.toLowerCase() === 'anonymous') return;
        rosterSet.add(n);
    }
    // Longest first, so greedy matching prefers "Ann Marie" over "Ann".
    function getRoster() {
        return [...rosterSet].sort((a, b) => b.length - a.length);
    }

    function appendLink(container, raw) {
        // Trailing punctuation people type after a link is not part of it —
        // the same trim extractUrls applies, so the anchor and the preview
        // card underneath agree on the URL instead of the anchor 404ing.
        const url = raw.replace(/[),.;:!?\]]+$/, '');
        const a = document.createElement('a');
        a.href = url;
        a.dataset.external = '1';        // opened in the browser by the click handler
        a.textContent = url;
        container.appendChild(a);
        if (url.length < raw.length) {
            container.appendChild(document.createTextNode(raw.slice(url.length)));
        }
    }

    function appendTextWithLinks(container, text) {
        const re = /https?:\/\/[^\s<>"']+/g;
        let last = 0, m;
        while ((m = re.exec(text)) !== null) {
            if (m.index > last) container.appendChild(document.createTextNode(text.slice(last, m.index)));
            appendLink(container, m[0]);
            last = m.index + m[0].length;
        }
        if (last < text.length) container.appendChild(document.createTextNode(text.slice(last)));
    }

    // Longest roster name that begins `rest` at a word boundary.
    function matchRosterName(rest, roster) {
        let best = null;
        for (const nm of roster) {
            if (rest.length < nm.length) continue;
            if (rest.slice(0, nm.length).toLowerCase() !== nm.toLowerCase()) continue;
            const after = rest.charAt(nm.length);
            if (after && /[A-Za-z0-9]/.test(after)) continue;
            if (!best || nm.length > best.length) best = rest.slice(0, nm.length);
        }
        return best;
    }

    // ---- custom emoji -------------------------------------------------------
    // name -> { name, url }, filled from /api/board/emoji at boot and after any
    // add/remove. Shared with the website and the phone app, which read the same
    // table, so `:shrug:` means the same picture everywhere.
    const customEmoji = new Map();

    // Emits `text` into `container`, turning `:name:` into the image it names.
    //
    // An unknown `:name:` stays literal text on purpose: it is far more often
    // ordinary punctuation ("10:30:00", a URL already carved out above, a
    // ratio) than a typo'd emoji, and silently eating it would be worse than
    // showing it. Code spans never reach here — renderInline splits on
    // backticks before any of this runs — so `:name:` in code stays literal too.
    function appendTextWithEmoji(container, text) {
        if (!text) return;
        if (!customEmoji.size || text.indexOf(':') === -1) {
            container.appendChild(document.createTextNode(text));
            return;
        }
        const re = /:([a-z0-9_]{2,32}):/g;
        let last = 0, m;
        while ((m = re.exec(text)) !== null) {
            const em = customEmoji.get(m[1]);
            if (!em) continue;                 // not ours — leave it as text
            if (m.index > last) container.appendChild(document.createTextNode(text.slice(last, m.index)));
            container.appendChild(emojiImg(em));
            last = m.index + m[0].length;
        }
        if (last < text.length) container.appendChild(document.createTextNode(text.slice(last)));
    }

    function emojiImg(em, big) {
        const img = document.createElement('img');
        img.className = 'cemoji' + (big ? ' cemoji-lg' : '');
        img.src = em.url;
        img.alt = ':' + em.name + ':';
        img.title = ':' + em.name + ':';
        // These are chat-sized and already capped server-side; loading them
        // lazily keeps a long scrollback from firing hundreds of requests.
        img.loading = 'lazy';
        img.draggable = false;
        return img;
    }

    // A reaction as HTML, for the one place messages are built as a string
    // rather than as nodes (renderMessages' innerHTML pass). Unknown tokens and
    // plain glyphs fall through as escaped text, so a reaction left behind by a
    // deleted emoji shows as `:name:` instead of a broken image.
    function reactionGlyph(token) {
        const m = /^:([a-z0-9_]{2,32}):$/.exec(String(token || ''));
        const em = m && customEmoji.get(m[1]);
        if (!em) return esc(token);
        return `<img class="cemoji" src="${esc(em.url)}" alt="${esc(token)}" loading="lazy" draggable="false">`;
    }

    // Mention chips within a segment that is already known to be URL-free.
    function appendMentionSegment(container, text, ctx) {
        let i = 0;
        while (i < text.length) {
            const at = text.indexOf('@', i);
            if (at === -1) { appendTextWithEmoji(container, text.slice(i)); break; }
            if (at > i) appendTextWithEmoji(container, text.slice(i, at));
            const rest = text.slice(at + 1);
            let matched = matchRosterName(rest, ctx.roster);
            if (!matched) { const g = /^[A-Za-z0-9_]+/.exec(rest); if (g) matched = g[0]; }
            if (matched) {
                const chip = document.createElement('span');
                chip.className = 'mention' +
                    (ctx.me && matched.toLowerCase() === ctx.me ? ' mention-self' : '');
                chip.textContent = '@' + matched;
                container.appendChild(chip);
                i = at + 1 + matched.length;
            } else {
                container.appendChild(document.createTextNode('@'));
                i = at + 1;
            }
        }
    }

    // Fetches the shared set. Failure is not fatal anywhere: an empty map means
    // `:name:` renders as the text it already was.
    async function loadCustomEmoji() {
        try {
            const res = await L.board('emoji');
            if (!res || !res.success || !Array.isArray(res.emoji)) return;
            customEmoji.clear();
            res.emoji.forEach((e) => {
                if (!e || !e.name || !e.key) return;
                // The server's `url` is site-relative (/api/board/file?key=…),
                // which is correct for the website and meaningless here — this
                // renderer's origin is the app bundle, not scarmonit.com, and
                // the endpoint is cookie-gated besides. lounge:// is the proxy
                // that fetches those bytes with the credential held in main.
                customEmoji.set(e.name, Object.assign({}, e, { url: L.fileUrl(e.key) }));
            });
        } catch (e) { /* offline — the picker just shows the built-in set */ }
    }

    // ---- profile images -------------------------------------------------------
    // account id -> R2 key, from /api/board/avatars. ONE map serves every
    // surface that already resolves a person to a user_id: messages, both
    // member lists, the voice roster, the popover, the name pill. Nothing else
    // in the app had to learn that profile images exist.
    //
    // Keys, not URLs: the server's URL is site-relative and means nothing from
    // a file:// renderer, so it goes through L.fileUrl → lounge:// exactly like
    // attachments and custom emoji do.
    let avatarMap = {};
    // `account` is assigned much later in this file; both of these are only ever
    // called from render paths, long after it is set.
    function myUserId() { return (account && account.id) || 0; }
    // The SFU only ever knows install ids. Presence is what maps one back to an
    // account, which is whose picture to draw.
    function uidForClient(cid) {
        if (!cid) return 0;
        const m = members.find((x) => x.client_id === cid && x.user_id);
        if (m) return m.user_id;
        const v = voicePresence.find((x) => x.client_id === cid && x.user_id);
        return (v && v.user_id) || 0;
    }
    function avatarSrc(uid) {
        const key = uid && avatarMap[uid];
        return key ? L.fileUrl(key) : '';
    }
    // Most avatars in this app are built inside an innerHTML string, so the
    // picture is markup. The initials and the generated gradient stay
    // UNDERNEATH it: they show while it loads, and remain if it 404s.
    function avatarImgHtml(uid) {
        const src = avatarSrc(uid);
        return src ? `<img class="avatar-img" src="${esc(src)}" alt="" loading="lazy" draggable="false">` : '';
    }
    function avatarCls(uid) { return avatarSrc(uid) ? ' has-img' : ''; }
    // A picture that fails to load takes itself off, which puts the letters back.
    function wireAvatarFallback(root) {
        if (!root) return;
        root.querySelectorAll('img.avatar-img').forEach((img) => {
            img.addEventListener('error', () => {
                const holder = img.parentElement;
                img.remove();
                if (holder) holder.classList.remove('has-img');
            });
        });
    }
    // The DOM-built ones (the me-bar, the popover, the settings card).
    function paintAvatarEl(el, name, uid) {
        if (!el) return el;
        el.textContent = initials(name);
        el.setAttribute('style', avatarStyle(name));
        el.classList.remove('has-img');
        const src = avatarSrc(uid);
        if (!src) return el;
        const img = document.createElement('img');
        img.className = 'avatar-img';
        img.alt = ''; img.loading = 'lazy'; img.draggable = false;
        img.addEventListener('error', () => { img.remove(); el.classList.remove('has-img'); });
        img.src = src;
        el.appendChild(img);
        el.classList.add('has-img');
        return el;
    }

    function sameAvatars(a, b) {
        const ka = Object.keys(a), kb = Object.keys(b);
        if (ka.length !== kb.length) return false;
        return ka.every((k) => a[k] === b[k]);
    }
    async function loadAvatars() {
        try {
            const res = await L.board('avatars');
            if (!res || !res.success || !res.avatars) return false;
            if (sameAvatars(avatarMap, res.avatars)) return false;
            avatarMap = res.avatars;
            return true;
        } catch (e) { return false; }
    }
    function repaintAvatars() {
        renderMessages();          // the picture is part of each row's signature
        renderVoiceRoster();
        renderMe();
        renderAccountCard();
        if (threadOpen()) renderThread();
    }
    async function refreshAvatars() {
        if (await loadAvatars()) repaintAvatars();
    }

    function appendTextWithMentions(container, text, ctx) {
        // URLs are carved out FIRST: splitting on '@' before linkifying used
        // to cut https://youtube.com/@handle into a half-link plus a bogus
        // mention chip.
        const re = /https?:\/\/[^\s<>"']+/g;
        let last = 0, m;
        while ((m = re.exec(text)) !== null) {
            if (m.index > last) appendMentionSegment(container, text.slice(last, m.index), ctx);
            appendLink(container, m[0]);
            last = m.index + m[0].length;
        }
        if (last < text.length) appendMentionSegment(container, text.slice(last), ctx);
    }

    // Inline: **bold**, *italic*, ~~strike~~, ||spoiler|| (recursive).
    const FMT = [
        { re: /\|\|([\s\S]+?)\|\|/, kind: 'spoiler' },
        { re: /\*\*([\s\S]+?)\*\*/, kind: 'strong' },
        { re: /~~([\s\S]+?)~~/, kind: 'del' },
        { re: /\*([\s\S]+?)\*/, kind: 'em' }
    ];

    function renderFormatted(container, text, ctx) {
        let best = null;
        for (const f of FMT) {
            const m = f.re.exec(text);
            if (m && (!best || m.index < best.m.index)) best = { f, m };
        }
        if (!best) { appendTextWithMentions(container, text, ctx); return; }
        const { m } = best;
        if (m.index > 0) appendTextWithMentions(container, text.slice(0, m.index), ctx);
        if (best.f.kind === 'spoiler') {
            const sp = document.createElement('span');
            sp.className = 'spoiler';
            sp.setAttribute('role', 'button');
            sp.setAttribute('tabindex', '0');
            sp.title = 'Click to reveal spoiler';
            sp.addEventListener('click', () => sp.classList.add('revealed'));
            sp.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sp.classList.add('revealed'); }
            });
            renderFormatted(sp, m[1], ctx);
            container.appendChild(sp);
        } else {
            const el = document.createElement(best.f.kind);
            renderFormatted(el, m[1], ctx);
            container.appendChild(el);
        }
        const after = text.slice(m.index + m[0].length);
        if (after) renderFormatted(container, after, ctx);
    }

    // `code` spans first, so formatting characters inside them stay literal.
    function renderInline(container, text, ctx) {
        text.split('`').forEach((seg, j) => {
            if (j % 2 === 1) {
                const c = document.createElement('code');
                c.className = 'inline-code';
                c.textContent = seg;
                container.appendChild(c);
            } else if (seg) {
                renderFormatted(container, seg, ctx);
            }
        });
    }

    // Blocks within a non-code segment: lists, blockquotes, paragraphs.
    function renderTextBlock(text, container, ctx) {
        const lines = text.split('\n');
        let i = 0, para = null;
        const flush = () => { if (para) { container.appendChild(para); para = null; } };
        const startPara = () => {
            if (!para) { para = document.createElement('span'); para.className = 'msg-para'; }
            else para.appendChild(document.createElement('br'));
        };

        while (i < lines.length) {
            const line = lines[i];
            const isUL = /^\s*[-*+]\s+(.*)$/.test(line);
            const isOL = /^\s*\d+[.)]\s+(.*)$/.test(line);
            const bq = /^\s*>\s?(.*)$/.exec(line);

            if (isUL || isOL) {
                flush();
                const ordered = isOL && !isUL;
                const listEl = document.createElement(ordered ? 'ol' : 'ul');
                listEl.className = 'msg-list';
                while (i < lines.length) {
                    const lm = ordered
                        ? /^\s*\d+[.)]\s+(.*)$/.exec(lines[i])
                        : /^\s*[-*+]\s+(.*)$/.exec(lines[i]);
                    if (!lm) break;
                    const li = document.createElement('li');
                    renderInline(li, lm[1], ctx);
                    listEl.appendChild(li);
                    i++;
                }
                container.appendChild(listEl);
                continue;
            }
            if (bq) {
                flush();
                // .msg-bq, not .msg-quote — that class is the reply quote box here.
                const q = document.createElement('blockquote');
                q.className = 'msg-bq';
                let first = true;
                while (i < lines.length) {
                    const qm = /^\s*>\s?(.*)$/.exec(lines[i]);
                    if (!qm) break;
                    if (!first) q.appendChild(document.createElement('br'));
                    renderInline(q, qm[1], ctx);
                    first = false;
                    i++;
                }
                container.appendChild(q);
                continue;
            }
            if (line === '') { flush(); i++; continue; }
            startPara();
            renderInline(para, line, ctx);
            i++;
        }
        flush();
    }

    // Fenced ```code``` blocks split the body; everything else is prose.
    function renderBody(raw, container) {
        const ctx = { roster: getRoster(), me: (settings.displayName || '').toLowerCase() };
        String(raw || '').split('```').forEach((part, i) => {
            if (i % 2 === 1) {
                let content = part, lang = '';
                const nl = content.indexOf('\n');
                if (nl !== -1) {
                    const first = content.slice(0, nl).trim();
                    if (first && /^[a-zA-Z0-9+#._-]{1,20}$/.test(first)) {
                        lang = first.toLowerCase();
                        content = content.slice(nl + 1);
                    }
                }
                content = content.replace(/^\n/, '').replace(/\n+$/, '');
                const pre = document.createElement('pre');
                pre.className = 'msg-code';
                const code = document.createElement('code');
                if (lang) code.className = 'language-' + lang;
                code.textContent = content;
                pre.appendChild(code);
                container.appendChild(pre);
            } else if (part) {
                renderTextBlock(part, container, ctx);
            }
        });
    }

    // highlight.js is vendored and already loaded, so this is synchronous —
    // unlike the website, which lazy-loads it from a CDN.
    function highlightCodeBlocks(container) {
        if (!container) return;
        const pending = container.querySelectorAll('pre.msg-code code:not([data-hl])');
        if (!pending.length) return;

        // hljs is fetched on first use rather than at startup. Until it lands
        // the code block renders as plain monospace text, which is exactly what
        // it looked like before highlighting was added — so nothing waits on it.
        if (!window.hljs) {
            window.ScarmLazy.hljs().then((hl) => {
                if (hl) highlightCodeBlocks(container);
            });
            return;
        }
        pending.forEach((code) => {
            code.setAttribute('data-hl', '1');
            try { window.hljs.highlightElement(code); } catch (e) { /* leave it plain */ }
        });
    }

    // ---------- chat font size --------------------------------------------
    // One CSS variable drives the whole message body — text, names, timestamps
    // and avatars are all sized in em against it, so they scale together.

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

    // ---------- modal focus management -------------------------------------
    //
    // Every overlay in this app was a plain div: assistive technology had no way
    // to know a dialog had opened, Tab walked straight out of it into the
    // message list behind, and closing one left focus on whatever the browser
    // happened to pick rather than the control that opened it.
    //
    // trapFocus() fixes all three for any element, so each overlay needs one
    // call rather than its own keyboard handling.

    const FOCUSABLE = [
        'a[href]', 'button:not([disabled])', 'input:not([disabled])',
        'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])'
    ].join(',');

    // Only what the user can actually reach: a control inside a hidden section
    // of the settings sheet must not be a tab stop.
    function focusableIn(root) {
        return Array.from(root.querySelectorAll(FOCUSABLE))
            .filter((el) => !el.hasAttribute('hidden') && !el.closest('[hidden]') &&
                (el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement));
    }

    const trapped = new Map();      // element -> { handler, returnTo }

    function trapFocus(el, { label, initial } = {}) {
        if (!el || trapped.has(el)) return;

        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-modal', 'true');
        if (label) el.setAttribute('aria-label', label);

        // Remembered so Escape / Close puts the caret back where it came from,
        // rather than dumping it at the top of the document.
        const returnTo = document.activeElement;

        const handler = (e) => {
            if (e.key !== 'Tab') return;
            const items = focusableIn(el);
            if (!items.length) { e.preventDefault(); return; }
            const first = items[0];
            const last = items[items.length - 1];
            // Focus outside the modal entirely (a click on the backdrop) still
            // has to come back in, so both edges are handled explicitly.
            if (!el.contains(document.activeElement)) {
                e.preventDefault();
                (e.shiftKey ? last : first).focus();
            } else if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        };

        el.addEventListener('keydown', handler);
        trapped.set(el, { handler, returnTo });

        const target = initial || focusableIn(el)[0];
        if (target) target.focus();
    }

    function releaseFocus(el) {
        const rec = trapped.get(el);
        if (!rec) return;
        el.removeEventListener('keydown', rec.handler);
        trapped.delete(el);
        el.removeAttribute('aria-modal');
        // Only restore if focus is still inside (or nowhere) — if the user has
        // already clicked elsewhere, yanking it back would be worse.
        const active = document.activeElement;
        if (rec.returnTo && rec.returnTo.isConnected &&
            (!active || active === document.body || el.contains(active))) {
            rec.returnTo.focus();
        }
    }

    function openDialog({ title, message, value, ok, danger, withInput, label2, value2, placeholder }) {
        return new Promise((resolve) => {
            // A second dialog opening over the first used to overwrite
            // dialogDone, so the first promise never settled and whatever was
            // awaiting it (a delete confirmation, a rename) was abandoned
            // mid-flight. Reachable from the tray and the keyboard shortcuts,
            // which can fire while a dialog is already up.
            if (dialogDone) {
                const stale = dialogDone;
                dialogDone = null;
                stale(null);
            }
            dialogDone = resolve;
            $('dialog-title').textContent = title;
            const msg = $('dialog-msg');
            msg.textContent = message || '';
            msg.hidden = !message;
            const inp = $('dialog-input');
            inp.hidden = !withInput;
            inp.value = value || '';
            inp.placeholder = placeholder || '';
            // Optional second field (the name editor uses it for the status).
            const lab2 = $('dialog-label2'), inp2 = $('dialog-input2');
            lab2.textContent = label2 || '';
            lab2.hidden = !label2;
            inp2.hidden = !label2;
            inp2.value = value2 || '';
            $('dialog-ok').textContent = ok || 'OK';
            $('dialog-ok').classList.toggle('danger', !!danger);
            $('dialog').hidden = false;
            trapFocus($('dialog'), {
                label: title,
                initial: withInput ? inp : $('dialog-ok')
            });
            if (withInput) inp.select();
        });
    }

    function closeDialog(result) {
        releaseFocus($('dialog'));
        $('dialog').hidden = true;
        const done = dialogDone;
        dialogDone = null;
        if (done) done(result);
    }

    // Resolves to the entered string, or null if cancelled.
    function askText(title, value, ok) {
        return openDialog({ title, value, ok, withInput: true });
    }
    // Resolves { name, status } or null.
    // Status only. This dialog used to edit the display name alongside it,
    // which is exactly the impersonation route that had to go: the name
    // everyone sees is the account username, and nothing in the UI changes it.
    function askStatus(status) {
        return openDialog({
            title: 'Your status', value: status, ok: 'Save', withInput: true,
            placeholder: "What you're up to"
        }).then((v) => (v === null || v === false ? null : v));
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
        if (window.ScarmMic) window.ScarmMic.setGain(settings.micVolume === undefined ? 1 : settings.micVolume);
        return settings;
    }

    // ---------- auth ------------------------------------------------------

    async function boot() {
        // The real focus state, once. A 'focus' event fired before this file
        // attached its listener is lost, and a window that starts hidden in the
        // tray never fires one at all — see the note on `windowFocused`.
        try { windowFocused = !!(await L.win.isFocused()); } catch (e) { /* keep false */ }
        settings = await L.settings.get();
        $('login-base').value = settings.baseUrl || '';
        $('set-version').textContent = 'ScarmVoice v' + (await L.app.version());

        const st = await L.auth.status();
        if (st.authed) {
            if (await accountGate()) enterApp();
        } else {
            $('login').hidden = false;
            if (st.offline) $('login-sub').textContent = 'Could not reach the server — check the URL below.';
            $('login-pw').focus();
        }
    }

    // ---- mandatory account step -------------------------------------------
    // The shared board password only unlocks the API; using THIS app also
    // requires a personal account, so every message, DM and moderation action
    // has a real identity behind it. A stored token skips the step.

    async function accountGate() {
        try {
            const res = await L.account.me();
            if (res && res.success && res.user) { account = res.user; return true; }
        } catch (e) { /* fall through to the step */ }
        showAccountStep();
        return false;
    }

    // Is the card waiting on a CODE the user has to go and fetch?
    //
    // This is the one state nothing may interrupt. The email step asks for six
    // digits that live in another application, so the user is gone — for a
    // minute, or ten — and the step has to still be there when they come back.
    // Losing it means losing a half-created account, which is what happened:
    // the screen was replaced with "Your session expired" while its owner was
    // reading their email, and the registration had to start over.
    function holdingCode() {
        return !$('login').hidden && (!$('login-verify').hidden || !$('login-totp').hidden);
    }

    // Any step-2 panel. A weaker claim than holdingCode(): it stops background
    // work from re-entering a panel that is already up (which is what yanked
    // focus back to the username field mid-password), but a genuinely dead
    // board session may still rewind past it, because from the sign-in panel
    // that costs the user nothing but a re-typed password.
    function holdingLogin() {
        return holdingCode() || (!$('login').hidden &&
            (!$('login-acct').hidden || !$('login-create').hidden));
    }

    // Focus a login field WITHOUT stealing it from one the user is already
    // typing in. Re-entering a step used to call focus() unconditionally, so a
    // background refresh that re-showed the sign-in panel yanked the caret out
    // of the password field and back up to the username — mid-word.
    //
    // The test is specifically "a still-visible INPUT has focus". Guarding on
    // anything focused inside the card is too strong: switching panels happens
    // by clicking a button that is itself inside the card, and that transition
    // SHOULD land the caret in the new panel's first field. An input that the
    // transition just hid isn't being typed into either.
    function focusLogin(id) {
        const active = document.activeElement;
        const typing = active && active.tagName === 'INPUT' &&
            $('login').contains(active) && !active.closest('[hidden]');
        if (typing) return;
        $(id).focus();
    }

    // The step-2 panels are mutually exclusive; one function owns which is up so
    // they can't both be visible (or both hidden) after a transition.
    function showLoginStep(which) {
        $('login').hidden = false;
        $('login-pw').hidden = true;
        $('login-pw-hint').hidden = true;
        $('login-btn').hidden = true;
        $('login-advanced').hidden = true;
        $('login-advanced-box').hidden = true;
        $('login-acct').hidden = which !== 'signin';
        $('login-create').hidden = which !== 'create';
        $('login-verify').hidden = which !== 'verify';
        $('login-totp').hidden = which !== 'totp';
    }

    function showAccountStep() {
        showLoginStep('signin');
        $('login-sub').textContent = 'Step 2 of 2 — sign into your account';
        $('login-error').textContent = '';
        focusLogin('login-acct-user');
    }

    function showCreateStep() {
        showLoginStep('create');
        $('login-sub').textContent = 'Create your ScarmVoice account';
        $('login-error').textContent = '';
        focusLogin('login-new-user');
    }

    function hideAccountStep() {
        $('login-pw').hidden = false;
        $('login-pw-hint').hidden = false;
        $('login-btn').hidden = false;
        $('login-advanced').hidden = false;
        $('login-acct').hidden = true;
        $('login-create').hidden = true;
        $('login-verify').hidden = true;
        $('login-totp').hidden = true;
        $('login-sub').textContent = 'Step 1 of 2 — the shared password for ScarmVoice itself';
    }

    $('login-goto-create').addEventListener('click', showCreateStep);
    $('login-goto-signin').addEventListener('click', showAccountStep);

    // The name everyone else sees IS the account username — always, not just on
    // a fresh install. It used to be a free-text field seeded from the username
    // only when blank, which meant anyone could set it to somebody else's name
    // and sit in a channel wearing it. There is no display name to impersonate
    // now; the only way to change what people see is to change the account.
    //
    // Called on EVERY successful sign-in, so an account renamed elsewhere (or a
    // profile carried over from an older build) is corrected on the way in.
    async function adoptAccountName() {
        if (!account || !account.username) return;
        if (settings.displayName === account.username) return;
        await saveSettings({ displayName: account.username });
    }

    // ---- 2FA challenge at sign-in ----
    // The username+password we already collected, replayed with the code.
    let pendingTotp = null;    // { username, password }

    function showTotpStep(username, password) {
        pendingTotp = { username, password };
        showLoginStep('totp');
        $('login-sub').textContent = 'Two-factor is on — enter the code from your authenticator app';
        $('login-totp-code').value = '';
        $('login-totp-code').focus();
    }

    function backToAccountStep() {
        pendingTotp = null;
        pendingVerifyUser = null;
        showAccountStep();
    }

    async function totpLoginSubmit() {
        const btn = $('login-totp-btn');
        if (btn.disabled) return;          // a submit is already in flight
        const err = $('login-error');
        // The step can outlive its state (a stale overlay, a back-and-forth):
        // replaying a sign-in with no credentials would throw here.
        if (!pendingTotp) return backToAccountStep();
        const code = $('login-totp-code').value.trim();
        if (!/^\d{6}$/.test(code)) { err.textContent = 'Enter the 6-digit code from your app.'; return; }
        err.textContent = '';
        btn.disabled = true;
        try {
            const res = await L.account.login(pendingTotp.username, pendingTotp.password, code);
            if (!res || !res.success) {
                err.textContent = (res && res.error) || 'Could not sign in.';
                $('login-totp-code').value = '';
                $('login-totp-code').focus();
                return;
            }
            account = res.user;
            pendingTotp = null;
            await adoptAccountName();
            hideAccountStep();
            $('login').hidden = true;
            enterApp();
        } finally {
            btn.disabled = false;
        }
    }

    $('login-totp-btn').addEventListener('click', totpLoginSubmit);
    $('login-totp-back').addEventListener('click', backToAccountStep);
    $('login-totp-code').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); totpLoginSubmit(); }
    });

    // The username whose emailed code we're waiting on.
    let pendingVerifyUser = null;

    function showVerifyStep(username) {
        pendingVerifyUser = username;
        showLoginStep('verify');
        $('login-sub').textContent = `We emailed a 6-digit code for "${username}" — enter it to finish`;
        $('login-error').textContent = '';
        $('login-code').value = '';
        $('login-code').focus();
    }

    async function verifySubmit() {
        const btn = $('login-verify-btn');
        if (btn.disabled) return;          // a submit is already in flight
        const err = $('login-error');
        const code = $('login-code').value.trim();
        if (!/^\d{6}$/.test(code)) { err.textContent = 'Enter the 6-digit code from the email.'; return; }
        err.textContent = '';
        btn.disabled = true;
        try {
            const res = await L.account.verify(pendingVerifyUser, code);
            if (!res || !res.success) {
                err.textContent = (res && res.error) || 'Could not verify.';
                return;
            }
            account = res.user;
            pendingVerifyUser = null;
            await adoptAccountName();
            if (account.role === 'admin') toast('Account verified — you are the board admin');
            else toast('Account verified — welcome, ' + account.username);
            hideAccountStep();
            $('login').hidden = true;
            enterApp();
        } finally {
            btn.disabled = false;
        }
    }

    $('login-verify-btn').addEventListener('click', verifySubmit);
    $('login-verify-back').addEventListener('click', backToAccountStep);
    $('login-code').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); verifySubmit(); }
    });
    $('login-resend').addEventListener('click', async () => {
        const res = await L.account.resend(pendingVerifyUser);
        $('login-error').textContent = (res && res.success) ? '' : ((res && res.error) || 'Could not resend.');
        if (res && res.success) toast('Code sent — check your email');
    });

    async function loginAcctSubmit(mode) {
        // Each panel owns its own fields and its own button, so a submit only
        // ever needs to lock the one it came from.
        const register = mode === 'register';
        const btn = register ? $('login-create-btn') : $('login-acct-signin');
        if (btn.disabled) return;          // a submit is already in flight
        const err = $('login-error');
        const username = $(register ? 'login-new-user' : 'login-acct-user').value.trim();
        const password = $(register ? 'login-new-pw' : 'login-acct-pw').value;
        const email = register ? $('login-new-email').value.trim() : '';
        if (!username || !password) { err.textContent = 'Enter a username and a password.'; return; }
        if (register && !email) { err.textContent = 'Enter your email — new accounts must verify one.'; return; }
        err.textContent = '';
        btn.disabled = true;

        try {
            const res = mode === 'register'
                ? await L.account.register(username, password, email)
                : await L.account.login(username, password);
            // A new registration (or an unverified sign-in) moves to the code step.
            if (res && (res.pendingVerification || res.needsVerify)) {
                showVerifyStep(res.username || username);
                return;
            }
            // 2FA account: ask for the authenticator code and replay the sign-in.
            if (res && res.needsTotp) {
                showTotpStep(res.username || username, password);
                return;
            }
            if (!res || !res.success) {
                err.textContent = (res && res.error) || 'Could not sign in.';
                $('login-form').classList.add('shake');
                setTimeout(() => $('login-form').classList.remove('shake'), 420);
                return;
            }
            account = res.user;
            $('login-acct-pw').value = '';
            $('login-new-pw').value = '';
            await adoptAccountName();
            if (register && account.role === 'admin') {
                toast('Account created — you are the board admin');
            }
            hideAccountStep();
            $('login').hidden = true;
            enterApp();
        } finally {
            btn.disabled = false;
        }
    }

    $('login-acct-signin').addEventListener('click', () => loginAcctSubmit('login'));
    $('login-create-btn').addEventListener('click', () => loginAcctSubmit('register'));
    // Every account field swallows Enter. Without this the keypress reached the
    // enclosing #login-form and submitted the BOARD PASSWORD step with an empty
    // password, answering the account step with "Incorrect password". Each
    // field submits the panel it belongs to.
    ['login-acct-user', 'login-acct-pw'].forEach((id) => {
        $(id).addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); loginAcctSubmit('login'); }
        });
    });
    ['login-new-user', 'login-new-pw', 'login-new-email'].forEach((id) => {
        $(id).addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); loginAcctSubmit('register'); }
        });
    });

    $('login-advanced').addEventListener('click', () => {
        const box = $('login-advanced-box');
        box.hidden = !box.hidden;
    });

    $('login-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = $('login-btn');
        const err = $('login-error');
        const base = $('login-base').value.trim();

        err.textContent = '';
        btn.disabled = true;
        btn.textContent = 'Connecting…';

        if (base && base !== settings.baseUrl) await saveSettings({ baseUrl: base.replace(/\/+$/, '') });

        const res = await L.auth.login($('login-pw').value);
        btn.disabled = false;
        btn.textContent = 'Connect';

        if (res && res.success) {
            $('login-pw').value = '';
            // Password accepted — the account step decides whether we're in.
            if (await accountGate()) {
                $('login').hidden = true;
                enterApp();
            }
            return;
        }
        err.textContent = (res && res.error) || 'Could not sign in.';
        $('login-form').classList.add('shake');
        setTimeout(() => $('login-form').classList.remove('shake'), 420);
        $('login-pw').value = '';
        $('login-pw').focus();
    });

    // Five call sites reach enterApp() and none of them awaited it, so a throw
    // from any of the ten awaits below used to surface as an unhandled rejection
    // with #app already unhidden — a visible shell with no messages, no polling
    // and no explanation. Everything past the reveal is guarded, and the guard
    // also stops two overlapping entries (boot + a sign-in that raced it) from
    // starting two sets of timers.
    let entered = false;

    // Bumped by every teardownSession(). The same job joinGen does inside
    // voice.js: anything holding a stream or a timer across an await compares
    // the generation it started in against this, so a session that ended while
    // it was suspended does not get to finish its work in the next one. It
    // matters most for the microphone — teardown's stopRecording()/stopMicTest()
    // are no-ops while the OS permission prompt is still up, so without this the
    // stream is assigned AFTER the teardown that was supposed to release it and
    // the mic indicator stays lit behind the login gate.
    let sessionGen = 0;

    async function enterApp() {
        if (entered) return;
        entered = true;
        try {
            settings = await L.settings.get();
            // Belt and braces: whatever route got us here, the name on screen is
            // the account username. A stored token that skipped the sign-in
            // panels never passed through adoptAccountName() otherwise.
            await adoptAccountName();
            $('login').hidden = true;
            $('app').hidden = false;
            $('btn-send').disabled = true;

            channel = settings.channel || 'general';
            try { reads = JSON.parse(localStorage.getItem('lounge_reads') || '{}'); } catch (e) { reads = {}; }
            // Anything left queued by a previous session goes out as soon as the
            // first successful poll proves we're online.
            loadOutbox();

            applyChatFontSize(settings.chatFontSize);
            applyChrome();
            setChannelTitle(channel);
            warnIfElevated();
            window.loungeSounds.init(settings);
            window.ScarmNoise.setEnabled(!!settings.noiseSuppressionAI);
            window.ScarmNoise.onFailure(handleNoiseFailure);
            setupVoice();
            renderMe();
            // BEFORE the socket opens: this registers the install against the
            // account, and the realtime upgrade resolves that mapping server-side
            // to merge your devices. A socket opened first would carry no identity.
            await refreshAccount();
            await L.rt.start();
            // Before the first render. A message drawn without the emoji set
            // shows `:shrug:` as text and nothing redraws it; a face drawn
            // without the avatar map falls back to initials for the same reason.
            await loadCustomEmoji();
            await loadAvatars();
            // renderMe() and the account card ran before the map existed (they
            // are part of the shell, drawn as soon as settings load), so they
            // need the repaint the message list gets for free by rendering after
            // this point.
            renderMe();
            renderAccountCard();
            await loadChannels();
            await loadMessages(true);
            startPolling();
            startTextPresence();
            loadDmThreads();
            startDmPolling();
            await L.ptt.apply();
            refreshPttHint();
            flushOutbox();

            // Somebody else changing their picture is not worth a poll of its
            // own — it happens about as often as people change their haircut.
            // Your own change repaints immediately; this catches everyone else's.
            setInterval(refreshAvatars, 5 * 60 * 1000);

            if (settings.autoJoinVoice) joinVoice();
        } catch (e) {
            console.error('[app] could not open the board:', e);
            // Whatever did start has to be unwound, or the half-loaded session
            // keeps heartbeating from behind the login overlay.
            try { await teardownSession(); } catch (e2) { /* going back to login regardless */ }
            $('app').hidden = true;
            $('login').hidden = false;
            $('login-error').textContent = 'Could not load the board. Try again.';
            toast('Could not load the board — ' + ((e && e.message) || 'unknown error'), true);
        }
    }

    // ---------- channels --------------------------------------------------

    async function loadChannels(extra) {
        const body = Object.assign({ reads, clientId: settings.clientId }, extra || {});
        const res = await L.board('channels', { method: 'POST', body });
        // The response is returned so callers that ASKED for a change (create)
        // can tell whether it happened; a plain refresh still ignores it.
        if (authGone(res)) return res;
        if (!res || !res.success) return res;
        channels = res.channels || [];
        renderChannels();
        return res;
    }

    function renderChannels() {
        const list = $('channel-list');
        list.innerHTML = '';
        let total = 0;
        let alerting = 0;       // the same count minus muted channels
        channels.forEach((c) => {
            const b = document.createElement('button');
            const unread = c.name === channel ? 0 : (c.unread || 0);
            total += unread;
            if (!channelQuieted(c.name)) alerting += unread;
            b.className = 'chan' + (c.name === channel ? ' active' : '') +
                (unread ? ' unread' : '') + (channelQuieted(c.name) ? ' muted' : '');
            b.dataset.channel = c.name;
            // A <button> cannot contain buttons, so the row's own controls are
            // spans with a role — nested interactive content is invalid markup
            // and the inner click never reaches the right handler.
            b.innerHTML = `<span class="hash">#</span><span class="chan-name">${esc(c.name)}</span>` +
                (unread ? `<span class="unread">${unread > 99 ? '99+' : unread}</span>` : '') +
                '<span class="chan-acts">' +
                `<span class="chan-act" role="button" tabindex="0" data-act="alerts" data-tip="Notification Settings">${I('bell')}</span>` +
                (isAdmin() ? `<span class="chan-act" role="button" tabindex="0" data-act="edit" data-tip="Edit Channel">${I('gear')}</span>` : '') +
                '</span>';
            b.addEventListener('click', (e) => {
                const act = e.target.closest && e.target.closest('.chan-act');
                if (!act) return switchChannel(c.name);
                e.stopPropagation();
                const r = act.getBoundingClientRect();
                if (act.dataset.act === 'edit') {
                    // Straight to the rename, which is what "edit channel" means
                    // here: everything else about a channel is on the menu.
                    switchChannel(c.name).then(renameChannel);
                    return;
                }
                openChannelMenu(c.name, r.left, r.bottom + 4);
            });
            list.appendChild(b);
        });
        // The rail's server icon carries the total, the way Discord badges a
        // server you aren't currently looking at.
        // DMs count toward both badges — a DM is never "muted".
        const dmN = dmUnreadTotal();
        total += dmN;
        alerting += dmN;

        const badge = $('rail-badge');
        badge.textContent = total > 99 ? '99+' : String(total);
        badge.hidden = !total;

        setTaskbarBadge(alerting);
    }

    // The same total, drawn onto the Windows taskbar button so unread messages
    // are visible when the window is minimised or hidden in the tray. Muted
    // channels are excluded — they are muted precisely so they don't nag.
    let lastTaskbarBadge = -1;
    function setTaskbarBadge(total) {
        const n = isDnd() ? 0 : Math.max(0, total | 0);
        if (n === lastTaskbarBadge) return;     // don't re-flash on every render
        lastTaskbarBadge = n;
        L.app.setBadge(n);
    }

    // Channel name only — the '#' is a separate glyph in the header.
    function setChannelTitle(name) {
        const box = document.getElementById('ch-search-text');
        if (box) box.textContent = 'Search ' + (document.querySelector('#server-head .sh-name') || {}).textContent;
        $('chan-title').textContent = name;
        $('composer-input').placeholder = 'Message #' + name;
    }

    // Everything that has to be forgotten when the conversation on screen is
    // replaced. Rename and delete used to skip all of it and just reassign
    // `channel`, which left the old channel's posts in `posts` — and since post
    // ids are global, the refresh merge kept every one of them that was older
    // than the new channel's newest page, rendering them inline as ghosts.
    function resetChannelView() {
        posts = [];
        following = true;
        seenTopId = 0;
        hasMore = true;
        clearReply();            // the quoted message lives in the old channel
        cancelEdit();            // an editor left open would freeze renderMessages()
        if (threadOpen()) closeThread();
    }

    async function switchChannel(name) {
        if (name === channel) return;
        channel = name;
        await saveSettings({ channel: name });
        setChannelTitle(name);
        resetChannelView();
        renderMessages();
        renderChannels();
        await loadMessages(true);
    }

    // Our best guess at the slug the server will produce. Only ever a FALLBACK:
    // the authoritative answer is whichever name comes back in res.channels,
    // because collision handling and trimming are the server's rules, not ours.
    function slugifyChannel(name) {
        return String(name || '').toLowerCase()
            .replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-')
            .replace(/^-+|-+$/g, '').slice(0, 24);
    }

    // The entry that appeared in the list as a result of this call. Falls back
    // to the local slug when the server's answer is ambiguous.
    function channelAddedBy(before, guess) {
        const added = channels.map((c) => c.name).filter((n) => !before.includes(n));
        if (added.length === 1) return added[0];
        const clean = slugifyChannel(guess);
        return channels.some((c) => c.name === clean) ? clean : '';
    }

    $('btn-add-channel').addEventListener('click', async () => {
        const name = await askText('Create a channel', '', 'Create');
        if (!name) return;
        const before = channels.map((c) => c.name);
        const res = await loadChannels({ create: name });
        // loadChannels swallows failures, so without this an offline create
        // still switched the UI to a channel that was never made.
        if (!res || !res.success) return toast((res && res.error) || 'Could not create that channel', true);
        const created = res.channel || channelAddedBy(before, name);
        if (created) switchChannel(created);
    });

    // The server header. A chevron has to open something, or it is decoration.
    $('server-menu').addEventListener('click', (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        e.currentTarget.setAttribute('aria-expanded', 'true');
        openCtxMenu([
            { label: 'Invite People', icon: 'user-add', onClick: copyServerLink },
            { label: 'Notification Settings', icon: 'bell',
                onClick: () => openSettings().then(() => showSettingsPane(settingsPaneByTitle('Notifications'))) },
            { label: 'Server Settings', icon: 'gear', onClick: () => openSettings() },
            'sep',
            { label: 'Copy Server Link', icon: 'link', onClick: copyServerLink }
        ], r.left, r.bottom + 4);
    });
    // The menu closes on the next press wherever it lands, so the chevron's
    // state follows the same event rather than a callback the menu does not have.
    document.addEventListener('mousedown', () => {
        $('server-menu').setAttribute('aria-expanded', 'false');
    }, true);
    $('btn-invite').addEventListener('click', copyServerLink);

    async function copyServerLink() {
        const url = (settings.baseUrl || 'https://scarmonit.com').replace(/\/+$/, '') + '/messageboard/';
        try {
            await navigator.clipboard.writeText(url);
            toast('Invite link copied — ' + url);
        } catch (e) {
            toast('Could not copy the link', true);
        }
    }

    async function renameChannel() {
        if (channel === 'general') return toast('#general cannot be renamed', true);
        const name = await askText('Rename #' + channel, channel, 'Rename');
        if (!name || name === channel) return;
        const before = channels.map((c) => c.name);
        const res = await L.board('channels', {
            method: 'POST', body: { rename: name, from: channel, clientId: settings.clientId, reads }
        });
        if (!res || !res.success) return toast((res && res.error) || 'Rename failed', true);
        channels = res.channels || channels;
        channel = res.channel || channelAddedBy(before, name) || channel;
        // Persisted, or a restart reopens a channel name that no longer exists.
        await saveSettings({ channel });
        setChannelTitle(channel);
        // The renamed channel is a different conversation as far as the view is
        // concerned; without this the old posts stayed in `posts` and the
        // refresh merge kept every one older than the new newest page.
        resetChannelView();
        renderMessages();
        renderChannels();
        loadMessages(true);
    }

    async function deleteChannel() {
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
        await saveSettings({ channel });
        setChannelTitle('general');
        // Post ids are global, so the deleted channel's messages would otherwise
        // survive the refresh merge and render inline in #general as ghosts.
        resetChannelView();
        renderMessages();
        renderChannels();
        loadMessages(true);
    }

    // ---------- messages --------------------------------------------------

    // Every realtime 'posted' event used to trigger its own full page refetch, so
    // a burst of messages meant a burst of identical 40-message requests — and
    // the `loading` guard silently DROPPED the overlapping ones, which meant the
    // last message of a burst could be missed until the next poll.
    //
    // Instead: while a refresh is in flight, remember that another was asked for
    // and run exactly one more when it lands. Paged history requests (`before`)
    // are never coalesced — each asks for a different page.
    const REFRESH_COALESCE_MS = 250;
    let refreshTimer = null;
    let refreshPending = false;
    let refreshStick = false;

    function scheduleRefresh(scrollToEnd) {
        refreshStick = refreshStick || !!scrollToEnd;
        if (refreshTimer) return;
        refreshTimer = setTimeout(() => {
            refreshTimer = null;
            const stick = refreshStick;
            refreshStick = false;
            loadMessages(stick);
        }, REFRESH_COALESCE_MS);
    }

    async function loadMessages(scrollToEnd, before) {
        // Pinned at entry: a `before` cursor is an id from THIS channel's
        // history. If the user switches channels while we wait for the slot,
        // running the stale cursor against the new channel would splice an
        // arbitrary older page into it (post ids are global).
        const forChannel = channel;
        if (loading) {
            // Don't lose the request — replay it once the in-flight one returns.
            if (!before) { refreshPending = true; refreshStick = refreshStick || !!scrollToEnd; return; }
            // A paging request (Load earlier / jumpToPost) must not be silently
            // dropped just because a poll happened to be in flight — wait
            // briefly for the slot instead.
            for (let i = 0; i < 40 && loading; i++) await new Promise((r) => setTimeout(r, 50));
            if (channel !== forChannel) return;
            if (loading) {
                // Two seconds and the slot never freed. Say so — silently
                // dropping it made the "Load earlier" button look dead.
                toast('Still loading — try that again in a moment', true);
                return;
            }
        }
        loading = true;
        try {
            await loadMessagesOnce(scrollToEnd, before);
        } finally {
            loading = false;
        }
        // Exactly one replay, however many requests arrived while we were busy.
        if (refreshPending) {
            refreshPending = false;
            const stick = refreshStick;
            refreshStick = false;
            await loadMessages(stick);
        }
    }

    async function loadMessagesOnce(scrollToEnd, before) {
        // Pin the channel this request is FOR. The user can switch channels
        // while the request is in flight; merging the response then would
        // interleave the old channel's posts into the new one and stamp the
        // wrong channel's read watermark.
        const forChannel = channel;
        const res = await L.board('list', {
            query: { channel: forChannel, limit: PAGE, before: before || null }
        });
        if (forChannel !== channel) return;   // stale — a switch happened mid-flight

        if (authGone(res)) return;
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
            if (!fresh.length) {
                // Nothing came back (every message deleted, or an empty
                // channel). The old `oldest = Infinity` kept the entire stale
                // list forever, so deletions never showed up.
                posts = [];
            } else {
                const kept = posts.filter((p) => p.id < fresh[0].id);
                // The retained history and this page are adjacent only if what
                // we already had reached INTO the page — prevMax is the id of
                // the newest post we held. If it falls short, more messages
                // arrived than one page holds (asleep, or a long spell in the
                // tray) and the two runs have a hole between them. Concatenating
                // renders that as one seamless conversation with messages
                // silently missing, and "Load earlier" pages below posts[0], so
                // the hole is unreachable forever. Keeping only the fresh page
                // puts the missing range back within reach.
                const contiguous = !kept.length || prevMax >= fresh[0].id;
                posts = contiguous ? kept.concat(fresh) : fresh.slice();
                if (!contiguous) {
                    console.warn('[messages] dropped stale history — a gap opened above the newest page');
                }
            }
        }

        // Chime + notify for messages from other people, exactly where the
        // website does it. prevMax > 0 skips the very first load of a channel.
        if (!before && prevMax > 0) {
            // Blocked authors chime and notify for a message that is never
            // drawn, which is the opposite of what blocking promises.
            const fresh = posts.filter((p) => p.id > prevMax &&
                !wroteByMe(p) && !isBlocked(p.client_id));
            if (fresh.length) {
                // Poll and socket nudge can both see the same post as fresh;
                // the id watermark guarantees a single chime.
                const maxFreshId = fresh[fresh.length - 1].id;
                if (maxFreshId > lastSoundId) {
                    lastSoundId = maxFreshId;
                    // A mentions-only channel still chimes for an actual
                    // mention — the whole point of the middle setting.
                    const hasMention = fresh.some((p) => mentionsMe(p.body));
                    if (alertsAllowed(channel, hasMention)) window.loungeSounds.playMessage();
                }
                notifyForPosts(fresh);
            }
        }
        hasMore = !!res.hasMore;

        // Cap the retained history. Paging back far enough used to grow `posts`
        // without limit for the life of the session, and every render walks the
        // whole array. Trimming is only safe while the reader is following the
        // bottom and has no filter applied — otherwise we'd yank away the older
        // messages they deliberately loaded, or the ones a filter is matching.
        if (!before && following && !filterActive() && posts.length > MAX_POSTS) {
            const dropped = posts.length - MAX_POSTS;
            posts = posts.slice(dropped);
            hasMore = true;     // the trimmed page is now reachable via Load earlier
            console.info(`[messages] trimmed ${dropped} message(s) from retained history`);
        }

        // Names seen in history feed @mention matching and autocomplete.
        posts.forEach((p) => addRosterName(p.name));
        typingUsers = (res.typing || []).filter((t) => t.client_id !== settings.clientId);
        typingUsers.forEach((t) => addRosterName(t.name));
        voicePresence = keepKnownUids(res.voice || []);

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
        // The "From" list is built from the loaded messages, so paging back —
        // which the filtered empty state explicitly invites — can reveal people
        // who were not in the dropdown when it was opened.
        if (filterOpen()) populateFromSelect();

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

    // ---------- keyboard navigation of the message list --------------------
    //
    // The list was reachable only with a mouse: every action on a message lived
    // behind hover or right-click. Tab from the composer now lands on the list,
    // arrows walk it, Enter opens the same menu right-click does, and Escape
    // returns to the composer so the keyboard never gets stranded there.

    function focusMessage(el) {
        if (!el) return;
        const box = $('messages');
        box.querySelectorAll('.msg.kb').forEach((m) => m.classList.remove('kb'));
        el.classList.add('kb');
        el.focus({ preventScroll: true });
        // Keep it in view without the jump a default scrollIntoView gives.
        const r = el.getBoundingClientRect();
        const b = box.getBoundingClientRect();
        if (r.top < b.top) box.scrollTop += r.top - b.top - 8;
        else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom + 8;
    }

    $('messages').addEventListener('keydown', (e) => {
        // Never swallow keys aimed at a control inside a message (a reaction
        // button, the inline editor, a link).
        if (inEditable(e.target)) return;

        const box = $('messages');
        const items = Array.from(box.querySelectorAll('.msg'));
        if (!items.length) return;
        const current = e.target.closest ? e.target.closest('.msg') : null;
        const idx = current ? items.indexOf(current) : -1;

        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const step = e.key === 'ArrowDown' ? 1 : -1;
            // Entering the list from the container itself starts at the newest
            // message going up, and the oldest going down.
            const next = idx === -1
                ? (step === 1 ? 0 : items.length - 1)
                : Math.min(items.length - 1, Math.max(0, idx + step));
            focusMessage(items[next]);
        } else if (e.key === 'Home' || e.key === 'End') {
            e.preventDefault();
            focusMessage(e.key === 'Home' ? items[0] : items[items.length - 1]);
        } else if ((e.key === 'Enter' || e.key === ' ') && current) {
            // The message menu, anchored on the message rather than the pointer.
            e.preventDefault();
            const r = current.getBoundingClientRect();
            const p = posts.find((x) => String(x.id) === current.dataset.id);
            if (p) openCtxMenu(messageMenuItems(p, current), r.left + 24, r.top + 12);
        } else if (e.key === 'Escape') {
            // Stopped here so the document-level Escape handler doesn't also
            // close the thread panel on the way past.
            e.preventDefault();
            e.stopPropagation();
            box.querySelectorAll('.msg.kb').forEach((m) => m.classList.remove('kb'));
            $('composer-input').focus();
        }
    });

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
            // Queued messages have no server id to anchor to; skip them.
            if (!el.dataset.id) continue;
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

        // Counted over what is actually DRAWN: counting raw `posts` included
        // blocked authors and anything the active filter hides, so the badge
        // promised messages that jumping to the bottom would never reveal.
        const n = away
            ? displayedPosts().filter((p) => p.id > seenTopId && !wroteByMe(p)).length
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
    const postMatchesFilter = (p) =>
        window.ScarmLib.postMatchesFilter(p, filter, settings.displayName);
    function displayedPosts() {
        // A blocked author's messages are hidden here rather than deleted, so
        // unblocking brings them straight back without a reload.
        const base = Object.keys(blockedMap()).length
            ? posts.filter((p) => !isBlocked(p.client_id))
            : posts;
        return filterActive() ? base.filter(postMatchesFilter) : base;
    }

    // Everything that can change how one message draws. Two posts with equal
    // signatures produce byte-identical DOM, so the existing node is kept.
    // `grouped` is in here because it depends on the message BEFORE this one:
    // deleting a message can re-group its neighbour without that neighbour
    // itself changing.
    function messageSig(p, grouped, compact) {
        return JSON.stringify([
            p.id, p.body, p.edited_at, p.pinned, p.reply_count, p.name,
            avatarSrc(p.user_id),
            p.att_key, p.att_name, p.att_size, p.created_at,
            p.quote ? [p.quote.name, p.quote.body, p.quote.att_name, p.quote.missing] : 0,
            p.reactions || 0,
            grouped, compact
        ]);
    }

    // The list is diffed against the DOM by key rather than rebuilt.
    //
    // It used to be `box.innerHTML = ''` followed by a full re-render, guarded by
    // a signature over the whole page — so a single new message threw away every
    // node on screen. That restarted every image and video load, dropped the
    // link previews that had been fetched asynchronously (renderPreviews had to
    // refetch and re-graft them), and reset scroll position, which the code then
    // had to painstakingly restore. Reusing nodes makes all of that unnecessary.
    function renderMessages() {
        // A background poll must not rip the inline editor out from under
        // someone mid-sentence. The list resyncs when the edit finishes.
        // But if the editor's node has been destroyed by something else (the
        // thread panel rebuilding, the list being wiped), waiting for its
        // handlers to clear editingId would block rendering forever.
        if (editingId) {
            if (document.querySelector('.msg-edit')) return;
            editingId = null;
        }

        const box = $('messages');
        const active = filterActive();
        const list = displayedPosts();
        const compact = compactMode();

        box.classList.toggle('filtering', active);
        if (active) updateFilterCount(list.length);

        // Build the desired sequence of rows: each is a key, a signature, and a
        // factory that is only called when the row has to be (re)built.
        const rows = [];

        if (hasMore) {
            const label = active ? 'Load earlier messages to widen results' : 'Load earlier messages';
            rows.push({
                key: 'load-more', sig: label, make: () => {
                    const b = document.createElement('button');
                    b.className = 'load-more';
                    b.textContent = label;
                    b.addEventListener('click', () => loadMessages(false, posts.length ? posts[0].id : null));
                    return b;
                }
            });
        }

        // The top of the channel, whenever we are actually at the top of it —
        // not only when it is empty. This is scrollback: it stays above the
        // first message forever rather than vanishing the moment one arrives.
        if (!hasMore && !active) {
            rows.push({
                key: 'intro', sig: channel + '|' + String(isAdmin()), make: () => {
                    const e = document.createElement('div');
                    e.className = 'chan-intro';
                    e.innerHTML =
                        '<span class="ci-mark" aria-hidden="true">#</span>' +
                        `<h2 class="ci-title">Welcome to #${esc(channel)}!</h2>` +
                        `<p class="ci-sub">This is the start of the #${esc(channel)} channel.</p>`;
                    // Only offered to somebody who can actually do it: reshaping
                    // a channel is admin-only server-side.
                    if (isAdmin()) {
                        const b = document.createElement('button');
                        b.type = 'button';
                        b.className = 'ci-btn';
                        b.innerHTML = I('pencil') + '<span>Edit Channel</span>';
                        b.addEventListener('click', renameChannel);
                        e.appendChild(b);
                    }
                    return e;
                }
            });
        }

        if (!list.length && active) {
            // A filtered list that came back empty is a result, not a beginning:
            // one line is the right answer to "nothing matched".
            const text = 'No loaded messages match these filters.'
                + (hasMore ? ' Load earlier messages to search further back.' : '');
            rows.push({
                key: 'empty', sig: text, make: () => {
                    const e = document.createElement('div');
                    e.className = 'empty-state';
                    e.textContent = text;
                    return e;
                }
            });
        }
        if (list.length) {
            let lastDay = '';
            let prev = null;
            list.forEach((p) => {
                const day = dayStr(p.created_at);
                if (day !== lastDay) {
                    lastDay = day;
                    rows.push({
                        key: 'day:' + day, sig: day, make: () => {
                            const sep = document.createElement('div');
                            sep.className = 'day-sep';
                            sep.innerHTML = `<span>${esc(day)}</span>`;
                            return sep;
                        }
                    });
                    prev = null;
                }
                // Compact shows a timestamp and name on every line, so nothing groups.
                const before = compact ? null : prev;
                const grouped = !!(before && before.client_id === p.client_id && before.name === p.name &&
                    (p.created_at - before.created_at) < 300000 && !p.quote);
                rows.push({
                    key: 'msg:' + p.id,
                    sig: messageSig(p, grouped, compact),
                    make: () => renderMessage(p, before)
                });
                prev = p;
            });
        }

        // Queued messages sit after everything real, in the order they were
        // typed. Hidden while a filter is on: they aren't on the server yet, so
        // "matching" them would be a promise the search can't keep.
        if (!active) {
            outboxFor(channel).forEach((entry) => {
                rows.push({
                    key: 'out:' + entry.seq,
                    sig: JSON.stringify([entry.body, entry.sending, entry.failed, entry.error || '']),
                    make: () => renderPending(entry)
                });
            });
        }

        // Index what is already on screen so a node can be found wherever it sits.
        // Anything unkeyed is left over from an older render path; drop it so the
        // cursor walk below only ever sees rows it owns.
        const existing = new Map();
        Array.from(box.children).forEach((node) => {
            if (node.dataset && node.dataset.key) existing.set(node.dataset.key, node);
            else node.remove();
        });

        let cursor = box.firstElementChild;
        const keep = new Set();

        rows.forEach((row) => {
            let node = existing.get(row.key);
            if (node && node.dataset.sig !== row.sig) {
                // Same message, different content — rebuild just this one.
                const fresh = row.make();
                fresh.dataset.key = row.key;
                fresh.dataset.sig = row.sig;
                // Step the cursor past the node first: replaceChild detaches it,
                // and a cursor pointing at a detached node makes the insertBefore
                // below throw.
                if (node === cursor) cursor = cursor.nextElementSibling;
                box.replaceChild(fresh, node);
                existing.set(row.key, fresh);
                node = fresh;
            } else if (!node) {
                node = row.make();
                node.dataset.key = row.key;
                node.dataset.sig = row.sig;
                existing.set(row.key, node);
            }
            keep.add(row.key);

            if (node === cursor) {
                cursor = cursor.nextElementSibling;  // already in the right place
            } else {
                box.insertBefore(node, cursor);      // moves it if it was elsewhere
            }
        });

        // Whatever is left over is gone from the list (deleted, filtered out, or
        // scrolled off the retained history).
        for (const [key, node] of existing) {
            if (!keep.has(key)) node.remove();
        }
    }

    // A queued message. Deliberately not run through renderMessage: it has no
    // server id, so reactions, pinning, threads, editing and deleting all have
    // nothing to act on, and offering them would be a lie.
    function renderPending(entry) {
        const el = document.createElement('div');
        el.className = 'msg pending' + (entry.failed ? ' failed' : '');

        el.innerHTML =
            '<div class="msg-gutter">' +
            `<div class="msg-avatar${avatarCls(myUserId())}" style="${avatarStyle(settings.displayName)}">` +
            `${esc(initials(settings.displayName || 'You'))}${avatarImgHtml(myUserId())}</div></div>` +
            '<div class="msg-body">' +
            '<div class="msg-head">' +
            `<span class="msg-author">${esc(settings.displayName || 'You')}</span>` +
            `<span class="msg-time">${esc(timeStr(entry.created_at))}</span>` +
            '</div>' +
            '<div class="msg-text"></div>' +
            '<div class="pending-note"></div>' +
            '</div>';

        wireAvatarFallback(el);
        renderBody(entry.body, el.querySelector('.msg-text'));

        const note = el.querySelector('.pending-note');
        if (entry.sending) {
            note.textContent = 'Sending…';
        } else if (entry.failed) {
            note.append(entry.error || 'Not sent — waiting for a connection', ' ');
            const retry = document.createElement('button');
            retry.type = 'button';
            retry.className = 'pending-retry';
            retry.textContent = 'Retry';
            retry.addEventListener('click', () => { entry.failed = false; entry.rejected = false; flushOutbox(); });
            const cancel = document.createElement('button');
            cancel.type = 'button';
            cancel.className = 'pending-retry';
            cancel.textContent = 'Discard';
            cancel.addEventListener('click', () => dropOutbox(entry.id));
            note.append(retry, ' ', cancel);
        } else {
            note.textContent = 'Queued — will send when you\'re back online';
        }
        return el;
    }

    function renderMessage(p, prev) {
        // Group consecutive messages from the same person within 5 minutes.
        const grouped = prev && prev.client_id === p.client_id && prev.name === p.name &&
            (p.created_at - prev.created_at) < 300000 && !p.quote;

        const el = document.createElement('div');
        el.className = 'msg' + (grouped ? ' grouped' : '') + (p.pinned ? ' pinned' : '');
        el.dataset.id = p.id;

        const parts = [];
        // The gutter holds the avatar, and — on a grouped message — the timestamp
        // that takes its place on hover.
        parts.push('<div class="msg-gutter">' +
            `<div class="msg-avatar${avatarCls(p.user_id)}" style="${avatarStyle(p.name)}">${esc(initials(p.name))}${avatarImgHtml(p.user_id)}</div>` +
            (grouped ? `<span class="msg-gutter-time">${esc(timeStr(p.created_at))}</span>` : '') +
            '</div>');
        parts.push('<div class="msg-body">');

        if (p.quote) {
            parts.push('<div class="msg-quote">' +
                (p.quote.missing
                    ? '<em>original message deleted</em>'
                    : `<strong>${esc(p.quote.name)}</strong> ${esc(p.quote.body || p.quote.att_name || '')}`) +
                '</div>');
        }

        const pinTag = '<span class="msg-pinned-tag">' + I('pin', 'ico tag-ico') + 'pinned</span>';
        if (!grouped) {
            parts.push('<div class="msg-head">' +
                `<span class="msg-author">${esc(p.name)}</span>` +
                `<span class="msg-time">${esc(timeStr(p.created_at))}</span>` +
                (p.pinned ? pinTag : '') +
                '</div>');
        } else if (p.pinned) {
            parts.push('<div class="msg-head">' + pinTag + '</div>');
        }

        // Filled in after innerHTML by renderBody, which builds nodes rather
        // than markup.
        if (p.body) parts.push('<div class="msg-text' + (isOnlyEmoji(p.body) ? ' jumbo' : '') + '"></div>');

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
                // decoding="async" keeps image decode off the main thread, so a
                // big attachment scrolling into view can't stall the UI.
                parts.push(`<img src="${esc(url)}" alt="${esc(p.att_name)}" loading="lazy" decoding="async" ` +
                    `data-lightbox="1" data-att-key="${esc(p.att_key)}" data-att-name="${esc(p.att_name || 'image')}">`);
            } else if (kind === 'video') {
                parts.push(`<video src="${esc(url)}" controls preload="metadata"></video>`);
            } else {
                parts.push('<span class="msg-att-file">' + I(fileIcon(p.att_name), 'ico') +
                    `<span>${esc(p.att_name || 'attachment')}</span></span>`);
            }
            // Download stays available whatever the kind.
            parts.push('<button class="att-save" ' +
                `data-att-key="${esc(p.att_key)}" data-att-name="${esc(p.att_name || 'attachment')}">` +
                I('download', 'ico') + `<span>${label}</span></button>`);
            parts.push('</div>');
        }

        // Filled in asynchronously by renderPreviews — never blocks the message.
        parts.push('<div class="msg-previews"></div>');

        if (p.reactions && p.reactions.length) {
            parts.push('<div class="msg-reactions">' + p.reactions.map((r) => {
                const mine = (r.who || []).includes(settings.clientId);
                return `<button class="reaction${mine ? ' mine' : ''}" data-emoji="${esc(r.emoji)}">` +
                    `<span class="rx-emoji">${reactionGlyph(r.emoji)}</span><span class="rx-n">${r.count}</span></button>`;
            }).join('') + '</div>');
        }

        if (p.reply_count) {
            parts.push(`<button class="msg-thread">${p.reply_count} ${p.reply_count === 1 ? 'reply' : 'replies'}</button>`);
        }

        parts.push('</div>');

        // Hover actions. Edit and delete are yours-only, so they're omitted
        // entirely on other people's messages rather than shown and rejected.
        const mine = ownsPost(p);
        parts.push('<div class="msg-actions">' +
            '<button class="msg-act" data-act="react" title="Add a reaction">' + I('smile') + '</button>' +
            '<button class="msg-act" data-act="reply" title="Reply">' + I('reply') + '</button>' +
            `<button class="msg-act${p.pinned ? ' on' : ''}" data-act="pin" title="${p.pinned ? 'Unpin' : 'Pin'} this message">` + I('pin') + '</button>' +
            '<button class="msg-act" data-act="copy" title="Copy text">' + I('copy') + '</button>' +
            (mine ? '<button class="msg-act" data-act="edit" title="Edit message">' + I('pencil') + '</button>' : '') +
            (mine ? '<button class="msg-act danger" data-act="delete" title="Delete message">' + I('trash') + '</button>' : '') +
            '</div>');

        el.innerHTML = parts.join('');
        wireAvatarFallback(el);

        // Each message is a stop for keyboard navigation of the list, and an
        // article so it is announced as a unit rather than a run of loose text.
        el.tabIndex = -1;
        el.setAttribute('role', 'article');
        el.setAttribute('aria-label',
            `${p.name || 'Someone'} at ${timeStr(p.created_at)}: ` +
            (p.body || p.att_name || 'attachment'));

        // The hover actions are icon-only, so they need names (see icons.js).
        window.ScarmIcons.labelIconButtons(el);

        // The body is DOM, not markup: bold/italic/code/lists/quotes/mentions.
        const textEl = el.querySelector('.msg-text');
        if (textEl) {
            renderBody(p.body, textEl);
            if (p.edited_at) {
                const ed = document.createElement('span');
                ed.className = 'msg-edited';
                ed.textContent = '(edited)';
                textEl.appendChild(ed);
            }
            highlightCodeBlocks(textEl);
        }

        const act = (name, fn) => {
            const b = el.querySelector(`[data-act="${name}"]`);
            if (b) b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
        };
        act('react', () => openEmojiPicker(el.querySelector('[data-act="react"]'), (em) => react(p.id, em)));
        // Inside the thread panel, replying means the thread composer.
        act('reply', () => {
            if (el.closest('#thread-list')) $('thread-input').focus();
            else setReplyTarget(p);
        });
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
        const thread = el.querySelector('.msg-thread');
        if (thread) thread.addEventListener('click', (e) => { e.stopPropagation(); openThread(p.id); });
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
        // The label lives in a span beside the icon — writing textContent on the
        // button itself would delete the icon along with it.
        const lab = save.querySelector('span');
        save.disabled = true;
        const original = lab.textContent;
        lab.textContent = 'Saving…';
        await saveAttachment(save.dataset.attKey, save.dataset.attName);
        save.disabled = false;
        lab.textContent = original;
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
            // The channel matters here too: without it the server files the
            // signal under its default, so on the HTTP fallback — which is
            // exactly when the socket is down — everyone saw "X is typing…"
            // against #general no matter where X was actually typing.
            L.board('typing', {
                method: 'POST',
                body: { channel, clientId: settings.clientId, name: settings.displayName }
            });
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
        if (mentionPopOpen()) return;        // Enter is the autocomplete's
        const body = input.value.trim();
        const attachments = validStaged();   // errored items are never sent
        if (!body && !attachments.length) return;

        // Captured before the chip is cleared, and sent with the post the same
        // way the website does it. The channel is pinned too: the user can
        // switch channels while the request is in flight, and a failure path
        // reading the module-level `channel` after the await would queue the
        // message into the wrong channel.
        const quoteId = replyTarget ? replyTarget.id : null;
        const forChannel = channel;

        input.value = '';
        autosize();
        $('btn-send').disabled = true;
        clearStaged();
        clearReply();
        L.rt.sendTyping(channel, true);

        // With attachments, the text becomes the first one's caption so a
        // "here's the thing" message stays attached to the thing.
        if (attachments.length) {
            // The caption rides on the first attachment that actually makes it,
            // not blindly on index 0 — otherwise "#1 failed, #2 succeeded"
            // silently lost the typed text.
            let ok = 0;
            let bodyPosted = false;
            for (let i = 0; i < attachments.length; i++) {
                const carryBody = !bodyPosted;
                if (await uploadOne(attachments[i], carryBody ? body : '', carryBody ? quoteId : null, forChannel)) {
                    ok++;
                    if (carryBody) bodyPosted = true;
                }
            }
            if (ok) {
                announcePosted(forChannel, body);
                await loadMessages(true);
            }
            if (!bodyPosted && body) {
                input.value = body;      // the caption never went out — give it back
                autosize();
                updateSendEnabled();
            }
            return;
        }

        const res = await L.board('post', {
            method: 'POST',
            body: { body, name: settings.displayName || 'Anonymous', clientId: settings.clientId, channel: forChannel, quoteId }
        });

        if (authGone(res)) return;
        if (!res || !res.success) {
            // A network failure is not the user's problem to solve — queue it
            // and retry when the connection comes back. Anything the server
            // actively rejected is handed back, because retrying won't fix it.
            if (!res || res.network) {
                queueOutbox(body, quoteId, forChannel);
                return;
            }
            toast(res.error || 'Could not send', true);
            input.value = body;   // give the text back rather than losing it
            autosize();
            updateSendEnabled();  // the button was disabled at submit — re-enable it
            return;
        }
        announcePosted(forChannel, body);
        await loadMessages(true);
    });

    // ---------- outbox ------------------------------------------------------
    //
    // A message typed while the connection is down used to be handed straight
    // back to the composer with an error toast, so the only recovery was to
    // notice, wait, and press Enter again. Instead it is queued, shown in the
    // conversation greyed out, and retried automatically when realtime comes
    // back — the behaviour every other chat client has.
    //
    // Persisted, because "the app crashed and ate my message" is the worst
    // possible outcome for something the user has already pressed send on.
    // Attachments are deliberately NOT queued: the bytes can be hundreds of
    // megabytes and localStorage is not the place for them.

    const OUTBOX_KEY = 'lounge_outbox';
    const OUTBOX_MAX = 50;
    let outbox = [];
    let outboxSeq = 0;
    let flushingOutbox = false;

    function loadOutbox() {
        try {
            const raw = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]');
            outbox = Array.isArray(raw) ? raw.slice(-OUTBOX_MAX) : [];
        } catch (e) { outbox = []; }
        outbox.forEach((o) => { outboxSeq = Math.max(outboxSeq, Number(o.seq) || 0); });
    }

    function saveOutbox() {
        try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox.slice(-OUTBOX_MAX))); } catch (e) {}
    }

    function queueOutbox(body, quoteId, chan) {
        const entry = {
            seq: ++outboxSeq,
            id: 'out:' + outboxSeq,
            channel: chan || channel,
            body,
            quoteId: quoteId || null,
            created_at: Date.now(),
            sending: false,
            failed: false
        };
        outbox.push(entry);
        if (outbox.length > OUTBOX_MAX) outbox = outbox.slice(-OUTBOX_MAX);
        saveOutbox();
        renderMessages();
        settleScroll();
        return entry;
    }

    function dropOutbox(id) {
        outbox = outbox.filter((o) => o.id !== id);
        saveOutbox();
        renderMessages();
    }

    function outboxFor(chan) {
        return outbox.filter((o) => o.channel === chan);
    }

    // Sends every queued message for every channel, oldest first, stopping at
    // the first network failure so a long queue doesn't hammer a dead link.
    async function flushOutbox() {
        if (flushingOutbox || !outbox.length || $('app').hidden) return;
        flushingOutbox = true;
        try {
            // A copy: entries are removed from `outbox` as they succeed.
            for (const entry of outbox.slice()) {
                if (!outbox.includes(entry)) continue;      // dropped meanwhile
                // A server-rejected entry only goes out again via its Retry
                // button — auto-retrying it on every poll re-POSTs a message
                // the server already said no to, forever.
                if (entry.rejected) continue;
                entry.sending = true;
                entry.failed = false;
                renderMessages();

                const res = await L.board('post', {
                    method: 'POST',
                    body: {
                        body: entry.body,
                        name: settings.displayName || 'Anonymous',
                        clientId: settings.clientId,
                        channel: entry.channel,
                        quoteId: entry.quoteId
                    }
                });

                if (authGone(res)) { entry.sending = false; return; }

                if (res && res.success) {
                    outbox = outbox.filter((o) => o !== entry);
                    saveOutbox();
                    announcePosted(entry.channel, entry.body);
                    continue;
                }

                entry.sending = false;
                if (res && res.network) {
                    // Still offline — leave the rest queued and try again later.
                    entry.failed = true;
                    renderMessages();
                    return;
                }
                // A real rejection from the server (too long, bad channel).
                // Retrying forever would never help, so surface it and stop.
                entry.failed = true;
                entry.rejected = true;
                entry.error = (res && res.error) || 'The server rejected this message';
                saveOutbox();
                renderMessages();
            }
        } finally {
            flushingOutbox = false;
            renderMessages();
        }
    }

    // ---------- attachments -----------------------------------------------
    // Uses the same two-step the website does — POST the bytes to
    // /api/board/upload, then POST the message carrying { key, name, type, size }
    // — so a desktop upload is indistinguishable from a browser one.

    // 1 GiB. Only meaningful because the bytes go straight from disk to
    // storage now — see uploadOne and main/net.js uploadAttachment.
    const MAX_UPLOAD = 1024 * 1048576;

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

    // ---- upload progress ----
    // The main process reports bytes handed to the socket, tagged with the id
    // the renderer generated for this upload (see main/net.js). Until the first
    // event lands the bar keeps its indeterminate animation, so a fast upload on
    // a fast link never flickers through a bar that's already full.
    let uploadSeq = 0;
    const uploadRows = new Map();       // id -> { row, size }

    L.onUploadProgress(({ id, sent, total }) => {
        const entry = uploadRows.get(id);
        if (!entry || !total) return;
        const pct = Math.min(100, Math.round((sent / total) * 100));
        entry.row.classList.add('determinate');
        entry.row.querySelector('.up-bar i').style.width = pct + '%';
        // At 100% the bytes are out but the server hasn't answered yet, so say
        // so rather than showing a full bar next to a row that isn't finished.
        entry.row.querySelector('.up-size').textContent = pct >= 100
            ? 'processing…'
            : `${pct}% of ${fmtSize(entry.size)}`;
    });

    function failUploadRow(row, msg) {
        row.classList.add('err');
        row.querySelector('.up-name').textContent = msg;
        setTimeout(() => row.remove(), 6000);
    }

    // Uploads one staged item and posts it. `caption` rides on the first
    // attachment only, matching the website. `chan` is pinned by the caller:
    // an upload can take minutes, and reading the live channel after it would
    // post the attachment into whatever channel the user switched to.
    async function uploadOne(item, caption, quoteId, chan) {
        const row = addUploadRow(item.name, item.size);

        // A file that exists on disk is sent BY PATH: main streams it straight
        // into storage, so nothing ever holds it — not this renderer, not the
        // IPC channel, not a Worker. Reading it into an ArrayBuffer here (which
        // is what this used to do unconditionally) is fine for a screenshot and
        // fatal for a gigabyte.
        const payload = { name: item.name, type: item.type || 'application/octet-stream', size: item.size };
        if (item.path) {
            payload.path = item.path;
        } else {
            let buf = item.bytes;
            if (!buf) {
                try {
                    buf = await item.file.arrayBuffer();
                } catch (e) {
                    failUploadRow(row, `Could not read ${item.name}`);
                    return false;
                }
            }
            payload.data = buf;
            payload.size = buf.byteLength || item.size;
        }

        const uploadId = 'u' + (++uploadSeq);
        uploadRows.set(uploadId, { row, size: payload.size });
        let up;
        try {
            up = await L.uploadAttachment(payload, uploadId);
        } finally {
            uploadRows.delete(uploadId);
        }
        if (isAuthLoss(up)) { row.remove(); authGone(up); return false; }
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
                channel: chan || channel,
                quoteId: quoteId || null,
                attachment: { key: up.key, name: up.name, type: up.type, size: up.size }
            }
        });

        row.remove();
        if (authGone(res)) return false;
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
            if (it.size > MAX_UPLOAD) error = `Too large — ${fmtSize(it.size)} (max ${fmtSize(MAX_UPLOAD)})`;
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

    // Icon name for a non-media file, by extension. Names resolve against the
    // one icon set, so a staged .pdf and a posted .pdf draw the same glyph.
    function stageCard(s) {
        const card = document.createElement('div');
        card.className = 'stage-card' + (s.error ? ' errored' : '') + ' kind-' + (s.kind || 'file');

        const { head, tail } = splitName(s.name);
        const nameHtml = `<span class="sc-name" title="${esc(s.name)}"><span class="sc-head">${esc(head)}</span><span class="sc-tail">${esc(tail)}</span></span>`;

        let thumb = '';
        if (s.error) {
            thumb = '<div class="sc-thumb sc-icon">' + I(fileIcon(s.name), 'ico sc-glyph') + '</div>';
        } else if (s.kind === 'image' && s.url) {
            // A load error (e.g. HEIC that Chromium can't decode) swaps to an icon;
            // wired in JS below because CSP forbids inline onerror handlers.
            thumb = `<div class="sc-thumb"><img src="${esc(s.url)}" alt=""></div>`;
        } else if (s.kind === 'image') {
            thumb = '<div class="sc-thumb sc-icon">' + I('image', 'ico sc-glyph') + '</div>';
        } else if (s.kind === 'video' && s.poster) {
            thumb = `<div class="sc-thumb sc-video"><img src="${esc(s.poster)}" alt="">` +
                '<span class="sc-play">' + I('play', 'ico') + '</span>' +
                (s.duration ? `<span class="sc-badge">${fmtDuration(s.duration)}</span>` : '') + '</div>';
        } else if (s.kind === 'video') {
            thumb = '<div class="sc-thumb sc-icon sc-video">' + I('video', 'ico sc-glyph') +
                (s.duration ? `<span class="sc-badge">${fmtDuration(s.duration)}</span>` : '') + '</div>';
        } else if (s.kind === 'audio') {
            thumb = '<div class="sc-thumb sc-icon sc-audio">' + I('music', 'ico sc-glyph') + '</div>';
        } else {
            thumb = '<div class="sc-thumb sc-icon">' + I(fileIcon(s.name), 'ico sc-glyph') + '</div>';
        }

        const meta = s.error
            ? `<span class="sc-err">${esc(s.error)}</span>`
            : `<span class="sc-meta">${esc(fmtSize(s.size))}${s.duration ? ' · ' + fmtDuration(s.duration) : ''}</span>`;

        card.innerHTML =
            thumb +
            `<div class="sc-body">${nameHtml}${meta}</div>` +
            '<button class="sc-x" type="button" title="Remove">' + I('x') + '</button>';
        card.querySelector('.sc-x').addEventListener('click', () => unstage(s.id));

        // Image decode failure → fall back to an icon (CSP-safe, no inline handler).
        const img = card.querySelector('.sc-thumb img');
        if (img && s.kind === 'image') {
            img.addEventListener('error', () => {
                const t = card.querySelector('.sc-thumb');
                if (t) { t.classList.add('sc-icon'); t.innerHTML = I('image', 'ico sc-glyph'); }
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
        // The path is what lets main stream the file from disk instead of the
        // renderer reading a gigabyte into an ArrayBuffer and pushing it across
        // IPC. Empty for a File that has no path — a pasted screenshot, a
        // recorded clip — which is the signal to send the bytes instead.
        let path = '';
        try { path = L.pathForFile(file) || ''; } catch (e) { /* older preload */ }
        return { name: name || file.name, type: file.type || '', size: file.size, file, path };
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
        // The cap inside stageFiles counts VALID staged items, so measuring
        // against the raw length made this warn when everything actually fit
        // (and stay quiet when it didn't) as soon as an errored chip was staged.
        const before = validStaged().length;
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
            { label: 'Cut', icon: 'scissors', disabled: !selected, onClick: on(() => L.edit.cut()) },
            { label: 'Copy', icon: 'copy', disabled: !selected, onClick: on(() => L.edit.copy()) },
            { label: 'Paste', icon: 'clipboard', disabled: !canPaste, onClick: on(() => L.edit.paste()) },
            'sep',
            { label: 'Select all', icon: 'list', disabled: !input.value.length, onClick: on(() => L.edit.selectAll()) }
        ], e.clientX, e.clientY);
    });

    // ---------- composer emoji, mentions, reply ---------------------------

    function insertAtCursor(el, text) {
        const start = el.selectionStart || 0, end = el.selectionEnd || 0;
        el.value = el.value.slice(0, start) + text + el.value.slice(end);
        const caret = start + text.length;
        el.setSelectionRange(caret, caret);
        el.focus();
        autosize();
        updateSendEnabled();
    }

    $('btn-emoji').addEventListener('click', () => {
        openEmojiPicker($('btn-emoji'), (em) => insertAtCursor(input, em));
    });

    // @mention autocomplete over the names seen this session.
    let mentionPop = null, mentionItems = [], mentionActive = 0, mentionStart = -1;

    function mentionPopOpen() { return !!(mentionPop && !mentionPop.hidden); }

    function closeMentionPop() {
        if (mentionPop) mentionPop.hidden = true;
        mentionItems = [];
        mentionStart = -1;
    }

    function updateMentionPop() {
        const pos = input.selectionStart || 0;
        const before = input.value.slice(0, pos);
        const m = /(^|\s)@([^@\s]{0,30})$/.exec(before);
        if (!m) { closeMentionPop(); return; }

        mentionStart = pos - m[2].length - 1;     // index of the '@'
        const q = m[2].toLowerCase();
        const me = (settings.displayName || '').toLowerCase();
        const matches = getRoster()
            .filter((nm) => nm.toLowerCase() !== me)
            .filter((nm) => !q || nm.toLowerCase().includes(q))
            .slice(0, 8);
        if (!matches.length) { closeMentionPop(); return; }

        if (!mentionPop) {
            mentionPop = document.createElement('div');
            mentionPop.className = 'mention-pop';
            mentionPop.hidden = true;
            document.body.appendChild(mentionPop);
        }
        mentionItems = matches;
        mentionPop.innerHTML = '';
        matches.forEach((nm, i) => {
            const it = document.createElement('button');
            it.type = 'button';
            it.className = 'mention-item' + (i === 0 ? ' active' : '');
            const av = document.createElement('span');
            av.className = 'mention-av';
            av.setAttribute('style', avatarStyle(nm));
            av.textContent = initials(nm);
            const t = document.createElement('span');
            t.textContent = nm;
            it.appendChild(av);
            it.appendChild(t);
            // mousedown, not click: the composer must not lose the caret.
            it.addEventListener('mousedown', (e) => { e.preventDefault(); chooseMention(i); });
            mentionPop.appendChild(it);
        });
        mentionActive = 0;

        // Above the composer — there's nothing but the input below it.
        mentionPop.hidden = false;
        const r = input.getBoundingClientRect();
        const h = mentionPop.offsetHeight;
        mentionPop.style.left = Math.max(8, r.left) + 'px';
        mentionPop.style.top = Math.max(8, r.top - h - 6) + 'px';
    }

    function setMentionActive(i) {
        if (!mentionItems.length) return;
        mentionActive = (i + mentionItems.length) % mentionItems.length;
        [...mentionPop.children].forEach((c, idx) => c.classList.toggle('active', idx === mentionActive));
    }

    function chooseMention(i) {
        if (!mentionItems.length || mentionStart < 0) { closeMentionPop(); return; }
        const nm = mentionItems[i] || mentionItems[0];
        const pos = input.selectionStart || 0;
        const v = input.value;
        input.value = v.slice(0, mentionStart) + '@' + nm + ' ' + v.slice(pos);
        const caret = mentionStart + nm.length + 2;
        closeMentionPop();
        input.focus();
        input.setSelectionRange(caret, caret);
        autosize();
        updateSendEnabled();
    }

    // Capture on the document so this beats the composer's own Enter handler —
    // on the input itself, listener order would decide it, which is fragile.
    document.addEventListener('keydown', (e) => {
        if (e.target !== input || !mentionPopOpen()) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); setMentionActive(mentionActive + 1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setMentionActive(mentionActive - 1); }
        else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); chooseMention(mentionActive); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMentionPop(); }
    }, true);

    input.addEventListener('input', updateMentionPop);
    input.addEventListener('blur', () => setTimeout(closeMentionPop, 120));

    // Reply target, shown as a chip above the composer until sent or cancelled.
    let replyTarget = null;

    function setReplyTarget(p) {
        replyTarget = p;
        renderReplyChip();
        input.focus();
    }

    function clearReply() {
        replyTarget = null;
        renderReplyChip();
    }

    function renderReplyChip() {
        const chip = $('reply-chip');
        const txt = $('reply-chip-text');
        if (!replyTarget) { chip.hidden = true; txt.textContent = ''; return; }
        const snippet = (replyTarget.body || replyTarget.att_name || '').slice(0, 90);
        txt.textContent = '';
        const b = document.createElement('b');
        b.textContent = 'Replying to ' + (replyTarget.name || 'Anonymous');
        txt.appendChild(b);
        if (snippet) txt.appendChild(document.createTextNode(' — ' + snippet));
        chip.hidden = false;
    }

    $('reply-chip-cancel').addEventListener('click', clearReply);

    // ---------- voice messages --------------------------------------------
    // Record with MediaRecorder and stage the clip as an ordinary attachment —
    // same opus/webm the website produces, so both clients play each other's.

    const REC_MAX_MS = 5 * 60 * 1000;

    let mediaRec = null, recChunks = [], recStream = null, recStart = 0, recTimer = null, recSend = true;
    let recMaxTimer = null;     // the REC_MAX_MS cutoff, held so it can be cancelled

    function recording() { return !!mediaRec; }

    function showRecBar(on) {
        $('voice-rec').hidden = !on;
        // The button keeps its recording state even though the row it sits in is
        // swapped out, so the state is right the moment recording ends.
        $('btn-mic').classList.toggle('recording', on);
        document.querySelector('.composer-row').style.display = on ? 'none' : '';
    }

    function updateRecTime() {
        const s = Math.floor((Date.now() - recStart) / 1000);
        $('vrec-time').textContent = Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
    }

    async function startRecording() {
        if (recording()) return;
        const gen = sessionGen;
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (e) {
            toast(e && e.name === 'NotAllowedError'
                ? 'Microphone access is needed to record a voice message'
                : 'Could not open the microphone', true);
            return;
        }
        // The OS permission prompt can hold this await open for as long as the
        // user stares at it, and teardownSession()'s stopRecording() does
        // nothing while mediaRec is still null. Without this check the session
        // could end mid-prompt and we would then open the microphone anyway,
        // start a MediaRecorder nobody can see, and arm a five-minute timer that
        // tries to SEND the clip with the credential already gone.
        if (gen !== sessionGen) {
            try { stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
            return;
        }
        recStream = stream;
        recChunks = [];
        recSend = true;

        const mime = (window.MediaRecorder && MediaRecorder.isTypeSupported &&
            MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) ? 'audio/webm;codecs=opus' : '';
        try { mediaRec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
        catch (e) { mediaRec = new MediaRecorder(stream); }

        mediaRec.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
        mediaRec.onstop = finishRecording;
        mediaRec.start();

        recStart = Date.now();
        updateRecTime();
        showRecBar(true);
        recTimer = setInterval(updateRecTime, 250);
        // The max-duration cutoff must only ever stop the recording it was
        // armed for — a stale timer from a discarded recording used to fire
        // during a LATER one and auto-send it mid-sentence. The identity check
        // is what makes that safe; the handle is what makes it stop existing,
        // since an unheld five-minute timer outlives the clip that armed it and
        // the session that recorded it.
        const thisRec = mediaRec;
        recMaxTimer = setTimeout(() => { if (mediaRec === thisRec && recording()) stopRecording(true); }, REC_MAX_MS);
    }

    function stopRecording(send) {
        recSend = !!send;
        if (mediaRec && mediaRec.state !== 'inactive') { try { mediaRec.stop(); } catch (e) {} }
    }

    function finishRecording() {
        if (recTimer) { clearInterval(recTimer); recTimer = null; }
        if (recMaxTimer) { clearTimeout(recMaxTimer); recMaxTimer = null; }
        if (recStream) {
            try { recStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
            recStream = null;
        }
        showRecBar(false);

        const chunks = recChunks; recChunks = [];
        const rec = mediaRec; mediaRec = null;
        if (!recSend || !chunks.length) return;

        const type = (rec && rec.mimeType) || 'audio/webm';
        const blob = new Blob(chunks, { type });
        if (blob.size < 800) { toast('That recording was too short'); return; }   // a tap, not a message

        const ext = type.includes('ogg') ? 'ogg' : 'webm';
        const name = `voice-${Date.now()}.${ext}`;
        let file;
        try { file = new File([blob], name, { type }); }
        catch (e) { file = blob; file.name = name; }

        stageFiles([itemFromFile(file, name)]);
        $('composer').requestSubmit();     // send it, with whatever caption was typed
    }

    $('btn-mic').addEventListener('click', () => {
        if (recording()) stopRecording(true); else startRecording();
    });
    $('vrec-send').addEventListener('click', () => stopRecording(true));
    $('vrec-cancel').addEventListener('click', () => stopRecording(false));

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

    // How many of the four bars are lit, from the round trip the transport
    // measured. Unmeasured is NOT drawn as poor — before the first sample there
    // is no evidence either way, and the tooltip says so in words.
    function signalBars(rtt) {
        if (rtt === null || rtt === undefined) return 4;
        if (rtt <= 100) return 4;
        if (rtt <= 200) return 3;
        if (rtt <= 400) return 2;
        return 1;
    }

    function paintSignal(rtt) {
        const el = $('vl-signal');
        if (!el) return;
        el.setAttribute('data-bars', String(signalBars(rtt)));
        const text = (rtt === null || rtt === undefined) ? 'Measuring latency…' : rtt + ' ms';
        if (el.getAttribute('data-tip') !== text) {
            el.setAttribute('data-tip', text);
            refreshTip(el);
        }
    }

    let lastSelfMuted = null;
    let lastSelfDeafened = null;

    function setupVoice() {
        voice = window.createVoice({
            onState: (st) => {
                // The voice channel row is a channel, not a button that vanishes:
                // it stays put while connected and shows who is in it beneath.
                const vchan = $('btn-join-voice');
                vchan.classList.toggle('connected', !!st.joined);
                vchan.classList.toggle('connecting', !!st.joining);
                vchan.disabled = !!st.joining;
                vchan.title = st.joining ? 'Connecting…' : (st.joined ? 'You are in VoiceChat' : 'Join VoiceChat');
                $('voice-live').hidden = !st.joined;

                setTip($('btn-mute'), st.muted ? 'Unmute' : 'Mute');
                $('btn-mute').setAttribute('aria-pressed', String(st.muted));
                toggleIcons('btn-mute', st.muted);

                setTip($('btn-deafen'), st.deafened ? 'Undeafen' : 'Deafen');
                $('btn-deafen').setAttribute('aria-pressed', String(st.deafened));
                toggleIcons('btn-deafen', st.deafened);

                let label = 'Voice Connected';
                if (st.deafened) label = 'Deafened';
                else if (st.muted) label = 'Muted';
                else if (settings.voiceMode === 'ptt') label = st.transmitting ? 'Transmitting' : 'Push to talk';
                $('vl-label').textContent = label;
                // Green means the connection is healthy. Muted and deafened are
                // not that — they are states you chose that stop you being
                // heard or hearing, and painting them the same green as a good
                // connection says the opposite of what they mean.
                $('vl-status').classList.toggle('warn', !!(st.muted || st.deafened));
                // Your own row carries these two flags, and nothing else was
                // repainting it: muting changes your state, not the roster's
                // membership, so onParticipants never fires.
                if (st.muted !== lastSelfMuted || st.deafened !== lastSelfDeafened) {
                    lastSelfMuted = st.muted;
                    lastSelfDeafened = st.deafened;
                    renderVoiceRoster();
                }
                paintSignal(st.rtt);
                // Read off the sidebar's own labels, so the panel and the list
                // can never disagree about where you are.
                const chanName = document.querySelector('#btn-join-voice .vchan-name');
                const serverName = document.querySelector('#server-head .sh-name');
                const where = (chanName ? chanName.textContent : 'Voice') + ' / '
                    + (serverName ? serverName.textContent : 'ScarmVoice');
                $('vl-where').textContent = where;
                $('vl-where-2').textContent = where;

                // Share and camera controls only make sense while connected.
                $('btn-share').hidden = !st.joined;
                $('btn-share').classList.toggle('on', st.sharing);
                setTip($('btn-share'), st.sharing ? 'Stop Sharing Your Screen' : 'Share Your Screen');

                $('btn-cam').hidden = !st.joined;
                $('btn-cam').classList.toggle('on', !!st.cam);
                setTip($('btn-cam'), st.cam ? 'Turn Off Camera' : 'Turn On Camera');

                $('btn-soundboard').hidden = !st.joined;
                $('btn-nsai').hidden = !st.joined;
                $('btn-ptt').hidden = !st.joined;
                $('btn-ptt').classList.toggle('on', settings.voiceMode === 'ptt');
                setTip($('btn-ptt'), settings.voiceMode === 'ptt'
                    ? 'Push to Talk On' : 'Push to Talk Off');
                $('btn-nsai').classList.toggle('on', !!settings.noiseSuppressionAI);
                setTip($('btn-nsai'), settings.noiseSuppressionAI
                    ? 'Noise Suppression On' : 'Noise Suppression Off');
                if (st.joined) $('voice-panel').classList.remove('is-gone');
                // The user panel's second line reports the call, so it has to
                // follow joining and leaving.
                renderMe();
                // Leaving the call with the tray open would strand it above an
                // empty voice panel with nothing it can do.
                if (!st.joined) closeSoundboard();


                // Share audio rides its own elements in the voice engine (so a
                // presenter you aren't watching is still audible), and it
                // follows deafen there — the stage <video> is always silent.

                $('stage-quality').value = st.shareQuality;
                $('stage-motion').textContent = st.shareMotion === 'smooth' ? 'Smooth' : 'Sharp';

                L.app.setVoiceState({ inVoice: st.joined, muted: st.muted, deafened: st.deafened });
                L.rt.sendVoice(st.joined, st.muted);

                if (st.joined) startPresence(); else stopPresence();
            },
            onShares: (list) => { shareSources = list || []; renderStage(); },
            onCams: (list) => renderCams(list),
            onParticipants: () => renderVoiceRoster(),
            onSpeaking: (cid, on) => {
                speaking[cid] = on;
                // The same person is listed twice — under the voice channel and in
                // the members sidebar — so light every copy, not just the first.
                document.querySelectorAll(`.vp[data-cid="${CSS.escape(cid)}"]`)
                    .forEach((el) => el.classList.toggle('speaking', on));
                markCamSpeaking(cid, on);
            },
            onError: (msg) => toast('Voice: ' + msg, true)
        });
        voice.setSettings(settings);
    }

    // One place to change a label, so the accessible name and the visible tip
    // can never say different things — and the tip repaints if it is on screen.
    function setTip(el, text) {
        if (!el) return;
        el.setAttribute('data-tip', text);
        el.setAttribute('aria-label', text);
        refreshTip(el);
    }

    // toggleAttribute, not `.hidden`. These are <svg> elements once icons.js has
    // hydrated them, and `hidden` is defined on HTMLElement — SVGElement does not
    // have it, so `el.hidden = true` silently sets a property nobody reads and
    // the glyph never changes. That is why muting used to leave the mic looking
    // exactly like an unmuted mic.
    function toggleIcons(id, off) {
        const btn = $(id);
        const on = btn.querySelector('.ico:not(.ico-off)');
        const offIco = btn.querySelector('.ico-off');
        if (on) on.toggleAttribute('hidden', !!off);
        if (offIco) offIco.toggleAttribute('hidden', !off);
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

    // Clicking the channel you're already in is a no-op, as in Discord — leaving
    // is the disconnect button in the voice panel.
    $('btn-join-voice').addEventListener('click', () => {
        if (voice && voice.isJoined()) return;
        joinVoice();
    });
    $('vl-signal').addEventListener('pointerover', () => {
        if (voice && voice.rtt) paintSignal(voice.rtt());
    });

    $('btn-leave-voice').addEventListener('click', () => {
        // Before the await, not after: leaving is a network round trip, and an
        // exit that starts when the server answers is not an exit.
        $('voice-panel').classList.add('is-gone');
        leaveVoice();
    });

    $('btn-mute').addEventListener('click', () => {
        if (!voice.isJoined()) return toast('Join voice first');
        voice.toggleMuted();
    });
    $('btn-deafen').addEventListener('click', () => {
        if (!voice.isJoined()) return toast('Join voice first');
        voice.toggleDeafened();
    });

    // ---------- viewing stage ----------------------------------------------
    // Any number of people can present at once and any number of cameras can be
    // live, so "the stage" is no longer whoever shared last. Every watchable
    // stream — screen shares and cameras alike — becomes an entry in one list;
    // `watching` names the one playing large, and the strip under the head is
    // how you switch. The camera grid below still shows everybody.

    let shareSources = [];      // live screen shares, newest presenter last
    let watching = null;        // explicit pick: 'screen:<cid>' | 'cam:<cid>' | null
    let stageStreamId = null;   // what the <video> currently holds

    function stageSources() {
        const out = shareSources.map((s) => ({
            key: 'screen:' + s.id, kind: 'screen',
            id: s.id, name: s.name, isMe: !!s.isLocal, stream: s.stream
        }));
        camList.forEach((c) => out.push({
            key: 'cam:' + c.id, kind: 'cam',
            id: c.id, name: c.name, isMe: !!c.isMe, stream: c.stream
        }));
        return out;
    }

    // With nothing picked, the stage follows the screen shares — someone else's
    // first, since that's what you'd have opened it for. Cameras are NOT auto-
    // promoted: they have their own grid, and one person turning a webcam on
    // shouldn't take over half the window.
    function defaultSource(list) {
        return list.find((s) => s.kind === 'screen' && !s.isMe) ||
            list.find((s) => s.kind === 'screen') || null;
    }

    function sourceLabel(s, long) {
        if (s.kind === 'screen') {
            if (!long) return s.isMe ? 'Your screen' : `${s.name}'s screen`;
            return s.isMe ? 'You are sharing your screen' : `${s.name} is sharing their screen`;
        }
        return s.isMe ? 'Your camera' : `${s.name}'s camera`;
    }

    function renderStage() {
        const stage = $('stage');
        const video = $('stage-video');
        const list = stageSources();

        // An explicit choice is kept until that stream goes away; otherwise the
        // stage falls back to a screen share, or closes if there is none.
        let cur = list.find((s) => s.key === watching);
        if (!cur) { watching = null; cur = defaultSource(list); }

        if (!cur) {
            stageStreamId = null;
            try { video.srcObject = null; } catch (e) {}
            stage.hidden = true;
            renderStageSources([], null);
            markWatchedCam();
            return;
        }

        stage.hidden = false;
        const sid = cur.stream && cur.stream.id;
        if (sid !== stageStreamId) {
            stageStreamId = sid;
            try { video.srcObject = cur.stream; } catch (e) {}
            video.play().catch(() => {});
        }
        // Always silent: share audio plays through the voice engine's own
        // elements, so your own share can't feed back and a presenter you are
        // not watching stays audible.
        video.muted = true;
        video.classList.toggle('mirror', cur.kind === 'cam' && cur.isMe);

        $('stage-title').textContent = sourceLabel(cur, true);

        // Quality/motion/stop drive YOUR share, so they only apply while your
        // own share is the thing on screen.
        const mine = cur.kind === 'screen' && cur.isMe;
        ['stage-quality', 'stage-motion', 'stage-stop'].forEach((id) => {
            $(id).hidden = !mine;
        });

        renderStageSources(list, cur.key);
        markWatchedCam();
    }

    // The switcher. With a single source there is nothing to choose, so it
    // stays out of the way until a second one appears.
    function renderStageSources(list, activeKey) {
        const bar = $('stage-sources');
        bar.hidden = list.length < 2;
        bar.innerHTML = '';
        if (bar.hidden) return;

        list.forEach((s) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'stage-src' + (s.key === activeKey ? ' active' : '');
            b.setAttribute('role', 'tab');
            b.setAttribute('aria-selected', String(s.key === activeKey));
            b.title = 'Watch ' + sourceLabel(s, false);
            b.innerHTML = I(s.kind === 'screen' ? 'screen' : 'camera') +
                `<span>${esc(sourceLabel(s, false))}</span>`;
            b.addEventListener('click', () => watchSource(s.key));
            bar.appendChild(b);
        });
    }

    // Picking the source already on the stage puts it back: for a camera that
    // means closing the stage and going back to just the grid, the same
    // click-again-to-shrink the tiles have always had.
    function watchSource(key) {
        if (watching === key) {
            // Screen shares behave like radio buttons — re-picking the active
            // one changes nothing.
            if (!key.startsWith('cam:')) return;
            watching = null;
        } else {
            watching = key;
        }
        renderStage();
    }

    // Camera tiles. Kept keyed by participant so a re-render doesn't tear down
    // and re-attach a <video> that's already playing — that flashes black.
    const camTiles = new Map();
    let camList = [];              // last list, so speaking updates can re-lay-out

    // Balanced column count: 1→1, 2→2, 3-4→2, 5-6→3, 7-9→3, 10-12→4 …
    function camColumns(n) { return Math.max(1, Math.ceil(Math.sqrt(n))); }

    function buildCamTile(c) {
        const wrap = document.createElement('div');
        wrap.className = 'cam-tile';
        wrap.dataset.cid = c.id;

        const video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        video.muted = true;              // camera tiles carry no audio

        const label = document.createElement('span');
        label.className = 'cam-name';

        const tools = document.createElement('div');
        tools.className = 'cam-tools';
        const pip = document.createElement('button');
        pip.type = 'button';
        pip.className = 'cam-tool';
        pip.title = 'Pop out';
        pip.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11" width="7" height="6" rx="1" fill="currentColor" stroke="none"/></svg>';
        const full = document.createElement('button');
        full.type = 'button';
        full.className = 'cam-tool';
        full.title = 'Fullscreen';
        full.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';
        tools.appendChild(pip);
        tools.appendChild(full);

        // The tools act on the tile; they must not also trigger click-to-focus.
        pip.addEventListener('click', (e) => { e.stopPropagation(); togglePip(video); });
        full.addEventListener('click', (e) => { e.stopPropagation(); toggleFullscreen(wrap); });
        // A tile is a thumbnail of a source: clicking it moves that camera to
        // the big stage, the same choice the source strip offers.
        wrap.addEventListener('click', () => watchSource('cam:' + c.id));
        wrap.title = 'Watch on the stage';

        wrap.appendChild(video);
        wrap.appendChild(label);
        wrap.appendChild(tools);
        return { wrap, video, label, streamId: null };
    }

    function renderCams(list) {
        camList = list || [];
        const grid = $('cam-grid');
        const seen = new Set();

        camList.forEach((c) => {
            seen.add(c.id);
            let tile = camTiles.get(c.id);
            if (!tile) { tile = buildCamTile(c); camTiles.set(c.id, tile); grid.appendChild(tile.wrap); }

            tile.label.textContent = c.isMe ? 'You' : c.name;
            tile.wrap.classList.toggle('me', !!c.isMe);
            tile.wrap.classList.toggle('speaking', !!speaking[c.id]);

            const sid = c.stream && c.stream.id;
            if (sid !== tile.streamId) {
                tile.streamId = sid;
                try { tile.video.srcObject = c.stream; } catch (e) {}
                tile.video.play().catch(() => {});
            }
        });

        camTiles.forEach((tile, id) => {
            if (seen.has(id)) return;
            try { tile.video.srcObject = null; } catch (e) {}
            tile.wrap.remove();
            camTiles.delete(id);
        });

        grid.style.setProperty('--cols', String(camColumns(camTiles.size)));
        $('camera-stage').hidden = camTiles.size === 0;

        // Cameras are stage sources too, so the switcher has to follow them.
        renderStage();
    }

    // Ring the tile whose camera is currently on the stage.
    function markWatchedCam() {
        camTiles.forEach((tile, id) => {
            tile.wrap.classList.toggle('watching', watching === 'cam:' + id);
        });
    }

    // Keep the speaking ring on camera tiles in sync without a full re-render.
    function markCamSpeaking(cid, on) {
        const tile = camTiles.get(cid);
        if (tile) tile.wrap.classList.toggle('speaking', on);
    }

    $('btn-cam').addEventListener('click', () => { if (voice) voice.toggleCam(); });

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
        trapFocus($('picker'), { label: 'Share your screen', initial: $('picker-close') });
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
        releaseFocus($('picker'));
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
        // Released, not just hidden: trapFocus() early-returns for an element
        // it already holds, so skipping this left the trap installed and every
        // later open of the picker silently did no focus management at all.
        releaseFocus($('picker'));
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

    // Fullscreen a WRAPPER element, never the bare <video>: it keeps the video
    // centred on black and has no transform/overflow quirks. Requesting
    // fullscreen is gated behind the 'fullscreen' permission in Electron — it's
    // granted in main.js, without which requestFullscreen() silently no-ops and
    // the button appears dead. Esc (handled natively by Chromium) exits and
    // restores the element to its inline position. Shared by the share stage
    // and the camera tiles so the two can't drift.
    function toggleFullscreen(el) {
        if (!el) return;
        if (document.fullscreenElement === el) { document.exitFullscreen().catch(() => {}); return; }
        const p = el.requestFullscreen ? el.requestFullscreen() : null;
        if (p && p.catch) {
            p.catch((e) => {
                console.warn('[fullscreen] rejected:', e && e.message);
                toast('Could not enter fullscreen: ' + ((e && e.message) || 'blocked'), true);
            });
        }
    }

    // Pop a <video> into the OS picture-in-picture window: always-on-top,
    // resizable, aspect-preserving — the "pop out" the share stage already uses.
    async function togglePip(v) {
        if (!v) return;
        try {
            if (document.pictureInPictureElement === v) { await document.exitPictureInPicture(); return; }
            if (document.pictureInPictureElement) await document.exitPictureInPicture();
            await v.requestPictureInPicture();
        } catch (e) {
            toast('Pop-out unavailable for this stream', true);
        }
    }

    $('stage-full').addEventListener('click', () => toggleFullscreen($('stage-video-wrap') || $('stage-video')));
    $('stage-pip').addEventListener('click', () => togglePip($('stage-video')));

    // Reflect fullscreen state on the share stage's button label.
    document.addEventListener('fullscreenchange', () => {
        const on = document.fullscreenElement === $('stage-video-wrap');
        const btn = $('stage-full');
        if (btn) { btn.textContent = on ? 'Exit fullscreen' : 'Fullscreen'; btn.classList.toggle('on', on); }
    });

    // The roster merges two sources: the SFU's live participant list (authoritative
    // when we're in the call) and the server's voice_presence table (so people who
    // haven't joined still see who is in there, including browser users).
    // How long this call has been up. Started when the connection is reported
    // joined rather than when the click happens: the number has to be the length
    // of the CALL, not of the wait for it.
    let callStartedAt = 0;
    let callTimer = null;

    function paintCallTimer() {
        if (!callStartedAt) return;
        const secs = Math.max(0, Math.floor((Date.now() - callStartedAt) / 1000));
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60);
        const ss = String(secs % 60).padStart(2, '0');
        $('voice-timer').textContent = h
            ? h + ':' + String(m).padStart(2, '0') + ':' + ss
            : m + ':' + ss;
    }

    function setCallRunning(on) {
        if (on === !!callTimer) return;
        if (on) {
            callStartedAt = Date.now();
            paintCallTimer();
            callTimer = setInterval(paintCallTimer, 1000);
        } else {
            clearInterval(callTimer);
            callTimer = null;
            callStartedAt = 0;
            $('voice-timer').textContent = '';
        }
    }

    function renderVoiceRoster() {
        const inCall = voice && voice.isJoined();
        const live = inCall ? voice.roster() : [];
        const byId = new Map();

        // Install id -> account id. The SFU only knows installs, so this is how
        // a person signed in on two devices stays one row.
        const uidByCid = new Map();
        voicePresence.forEach((p) => { if (p.user_id) uidByCid.set(p.client_id, p.user_id); });

        live.forEach((p) => byId.set(p.id, Object.assign({}, p, { uid: uidByCid.get(p.id) || null })));
        voicePresence.forEach((p) => {
            if (!byId.has(p.client_id)) {
                byId.set(p.client_id, {
                    id: p.client_id,
                    uid: p.user_id || null,
                    name: p.name || 'Anonymous',
                    isMe: p.client_id === settings.clientId ||
                        !!(account && p.user_id && p.user_id === account.id),
                    muted: !!p.muted,
                    remoteOnly: true
                });
            }
        });

        const list = Array.from(byId.values());

        // Join / leave chimes. Gated on actually being in the call, so they are
        // never audible to someone who is only watching the roster. Fed the
        // per-INSTALL list: a chime tracks a connection arriving or going, not
        // a person.
        window.loungeSounds.voiceRoster(list, inCall, settings.clientId, !!settings.dnd);

        list.forEach((p) => addRosterName(p.name));

        // Everything shown to the user merges by account, the way the members
        // sidebar does — one person on two devices is one row and one head in
        // the count, not two.
        const keyOf = (uid, cid) => (uid ? 'u' + uid : 'c' + cid);
        const byKey = new Map();
        list.forEach((p) => {
            const key = keyOf(p.uid, p.id);
            const prev = byKey.get(key);
            // Keep the install we can actually reach — and our own over any
            // other device of ours — so the surviving row keeps its popover and
            // speaking highlight.
            if (!prev || (prev.remoteOnly && !p.remoteOnly) || p.id === settings.clientId) byKey.set(key, p);
        });
        const merged = Array.from(byKey.values());

        $('voice-count').textContent = merged.length ? String(merged.length) : '';
        // The head count is what decides whether you join. Once you have, how
        // long you have been in is the number worth the space — so they swap
        // rather than compete for it.
        setCallRunning(!!inCall);
        $('voice-count').hidden = !!inCall;
        $('voice-timer').hidden = !inCall;
        renderVoiceUsers(merged, inCall);
        renderMembers(merged, inCall);
    }

    // Who is in the call, listed under the voice channel in the sidebar. Rows
    // carry .vp so the speaking highlight and the per-person volume popover work
    // exactly as they do in the members sidebar.
    function renderVoiceUsers(list, inCall) {
        const ul = $('voice-users');
        ul.innerHTML = '';

        list.forEach((p) => {
            // "You" by account as well as by install — the merged row may carry
            // your other device's id.
            const isMe = p.id === settings.clientId || !!(account && p.uid && p.uid === account.id);
            const localMuted = !isMe && settings.localMuted && settings.localMuted[p.id];
            // In the room but absent from our SFU peer list: present, yet unable
            // to exchange media with us.
            const unreachable = !!(inCall && p.remoteOnly && !isMe);

            const li = document.createElement('li');
            li.className = 'vp vu' + (isMe ? ' me' : '') +
                (speaking[p.id] ? ' speaking' : '') +
                (unreachable ? ' unreachable' : '');
            li.dataset.cid = p.id;
            li.innerHTML =
                `<span class="av${avatarCls(p.uid)}" style="${avatarStyle(p.name)}">${esc(initials(p.name))}${avatarImgHtml(p.uid)}</span>` +
                // No "(you)" — the roster is short and your own avatar is in it.
                `<span class="vp-name">${esc(p.name)}</span>` +
                (unreachable ? '<span class="vp-flag warn" title="In voice, but not connected to you — they may need to reload the website">' + I('warning') + '</span>' : '') +
                // Muted and deafened are two different states and someone can be
                // in both. One glyph for the pair could only ever report one.
                (p.muted || localMuted ? '<span class="vp-flag" title="Muted">' + I('mic-off') + '</span>' : '') +
                (p.deafened ? '<span class="vp-flag" title="Deafened">' + I('headset-off') + '</span>' : '');

            wireAvatarFallback(li);
            if (!isMe && inCall && !p.remoteOnly) {
                li.addEventListener('click', (e) => openPopover(p, e.currentTarget));
            }
            ul.appendChild(li);
        });
    }

    // Everyone present, grouped online / away like Discord's members sidebar.
    // People in the call sort to the top of their group and keep the per-person
    // volume controls.
    function renderMembers(voiceList, inCall) {
        const ul = $('members-list');
        // Key by ACCOUNT where we know it: the same person signed in on the
        // website and the app is one member, not two.
        const keyOf = (uid, cid) => (uid ? 'u' + uid : 'c' + cid);
        // Indexed under BOTH keys. An account key alone breaks the moment one
        // side of the join is missing a user_id: the person is then keyed two
        // different ways and rendered twice — once from text presence with
        // their real status, once from the voice list forced to "online".
        const inVoice = new Map();
        voiceList.forEach((p) => {
            inVoice.set(keyOf(p.uid, p.id), p);
            if (p.id) inVoice.set('c' + p.id, p);
        });
        const seen = new Set();
        const seenClients = new Set();
        const rows = [];

        // Everyone the presence table knows about, plus anyone in the call who
        // hasn't heartbeated yet (a website user who only joined voice).
        members.forEach((m) => {
            const key = keyOf(m.user_id, m.client_id);
            if (seen.has(key)) return;
            seen.add(key);
            if (m.client_id) seenClients.add(m.client_id);
            rows.push({
                id: m.client_id,
                uid: m.user_id || null,
                name: m.name || 'Anonymous',
                status: (m.status === 'away' || m.status === 'dnd') ? m.status : 'online',
                custom: m.custom || '',
                voice: inVoice.get(key) || (m.client_id ? inVoice.get('c' + m.client_id) : null) || null
            });
        });
        voiceList.forEach((p) => {
            const key = keyOf(p.uid, p.id);
            // The install check is what makes this safe against a uid-less row:
            // the same install can never be two members.
            if (seen.has(key) || (p.id && seenClients.has(p.id))) return;
            seen.add(key);
            if (p.id) seenClients.add(p.id);
            rows.push({ id: p.id, uid: p.uid || null, name: p.name, status: 'online', custom: '', voice: p });
        });

        // Within a group, whoever is in the call comes first, then alphabetical.
        const byPresence = (a, b) =>
            (a.voice ? 0 : 1) - (b.voice ? 0 : 1) || a.name.localeCompare(b.name);
        const online = rows.filter((r) => r.status !== 'away').sort(byPresence);
        const away = rows.filter((r) => r.status === 'away').sort(byPresence);

        ul.innerHTML = '';
        if (!rows.length) {
            const e = document.createElement('div');
            e.className = 'members-empty';
            e.textContent = 'No one else here right now.';
            ul.appendChild(e);
            return;
        }

        const memberRow = (r) => {
            const p = r.voice;
            // "You" by account as well as by install — the merged row may carry
            // your other device's id.
            const isMe = r.id === settings.clientId || !!(account && r.uid && r.uid === account.id);
            const li = document.createElement('li');
            li.className = 'vp' + (isMe ? ' me' : '') +
                (r.status === 'away' ? ' away' : '') +
                (p && speaking[p.id] ? ' speaking' : '');
            li.dataset.cid = r.id;

            const localMuted = p && !isMe && settings.localMuted && settings.localMuted[p.id];
            // Someone listed in the shared presence table but absent from our SFU
            // peer list is in the room yet cannot exchange media with us — the
            // exact failure mode that hid a broken call behind a correct-looking
            // roster. Say so instead of showing them as a normal participant.
            const unreachable = !!(inCall && p && p.remoteOnly && !isMe);
            if (unreachable) li.classList.add('unreachable');

            const blocked = isBlocked(r.id);
            if (blocked) li.classList.add('blocked');
            // Being in the call is the most interesting thing a row can say, so
            // it takes the second line rather than being squeezed into an icon
            // at the far right where it reads as a decoration.
            const sub = blocked ? 'Blocked'
                : (p ? 'In voice'
                    : (r.custom || (r.status === 'away' ? 'Away' : (r.status === 'dnd' ? 'Do not disturb' : ''))));
            const dotClass = r.status === 'away' ? ' away' : (r.status === 'dnd' ? ' dnd' : '');
            li.innerHTML =
                '<span class="av-wrap">' +
                `<span class="av${avatarCls(r.uid)}" style="${avatarStyle(r.name)}">${esc(initials(r.name))}${avatarImgHtml(r.uid)}</span>` +
                `<i class="presence${dotClass}" aria-hidden="true"></i>` +
                '</span>' +
                // No "(you)": your own avatar is right there, and the suffix cost
                // the name the width it needed.
                '<span class="vp-body"><span class="vp-name">' + esc(r.name) + '</span>' +
                (sub
                    ? `<span class="vp-sub${p ? ' in-voice' : ''}">${p ? I('volume', 'ico vp-sub-ico') : ''}${esc(sub)}</span>`
                    : '') + '</span>' +
                (blocked ? '<span class="vp-flag" title="Blocked">' + I('ban') + '</span>' : '') +
                (unreachable ? '<span class="vp-flag warn" title="In voice, but not connected to you — they may need to reload the website">' + I('warning') + '</span>' : '') +
                (p && (p.muted || localMuted) ? '<span class="vp-flag" title="Muted">' + I('mic-off') + '</span>' : '') +
                (p && p.deafened ? '<span class="vp-flag" title="Deafened">' + I('headset-off') + '</span>' : '');

            wireAvatarFallback(li);
            if (p && !isMe && inCall && !p.remoteOnly) {
                li.addEventListener('click', (e) => openPopover(p, e.currentTarget));
            }
            return li;
        };

        const group = (label, list) => {
            if (!list.length) return;
            const head = document.createElement('li');
            head.className = 'mp-group';
            head.textContent = `${label} — ${list.length}`;
            ul.appendChild(head);
            list.forEach((r) => ul.appendChild(memberRow(r)));
        };
        group('Online', online);
        group('Away', away);
    }

    // ---------- per-participant popover -----------------------------------
    // Opened from either voice list. Same floating surface as the context menu,
    // but it needs a switch and a slider, which a menu of items cannot express.

    let popFor = null;
    // The ACCOUNT behind the open popover, when one is known — the admin
    // actions act on this, never on popFor (an install id).
    let popUid = null;
    // Matches --tb and titleBarOverlay's height: the popover is position:fixed,
    // so without this clamp it can slide under the native caption buttons.
    const POP_TITLEBAR = 38;

    // Flip to whichever side has room. This matters because the two lists that
    // open it sit on OPPOSITE window edges — the members sidebar is hard against
    // the right, so there the popover has to open leftwards.
    function placePopover(pop, anchor) {
        const r = anchor.getBoundingClientRect();
        const w = pop.offsetWidth;
        const h = pop.offsetHeight;
        const M = 10;

        let left = r.right + 8;
        if (left + w > window.innerWidth - M) left = r.left - 8 - w;
        left = Math.max(M, Math.min(left, window.innerWidth - w - M));

        let top = Math.min(r.top - 6, window.innerHeight - h - M);
        top = Math.max(POP_TITLEBAR + 6, top);

        pop.style.left = Math.round(left) + 'px';
        pop.style.top = Math.round(top) + 'px';
    }

    // 0-200 maps onto the track, so 100% lands dead centre and the accent fill
    // reads as "how far from normal".
    function paintPopVolume(pct) {
        $('pop-vol-val').textContent = pct + '%';
        $('pop-vol').style.setProperty('--fill', (pct / 2) + '%');
    }

    function openPopover(p, anchor) {
        const pop = $('popover');
        // Clicking the same person again closes it, like every other toggle.
        if (popFor === p.id && !pop.hidden) { closePopover(); return; }
        popFor = p.id;

        paintAvatarEl($('pop-avatar'), p.name, p.uid || uidForClient(p.id));
        $('pop-name').textContent = p.name;

        // The custom status lives in the presence list, not the SFU roster.
        const m = members.find((x) => x.client_id === p.id);
        const away = !!(m && m.status === 'away');
        const sub = (m && m.custom) || (p.muted ? 'Microphone muted' : (away ? 'Away' : ''));
        const st = $('pop-status');
        st.textContent = sub;
        st.hidden = !sub;
        $('pop-presence').className = 'pop-presence' + (away ? ' away' : '');

        const vol = settings.localVolumes && settings.localVolumes[p.id] !== undefined
            ? Number(settings.localVolumes[p.id]) : 1;
        const pct = Math.round(vol * 100);
        $('pop-vol').value = pct;
        paintPopVolume(pct);
        $('pop-mute').checked = !!(settings.localMuted && settings.localMuted[p.id]);

        const blocked = isBlocked(p.id);
        $('pop-block-label').textContent = blocked ? 'Unblock' : 'Block';
        $('pop-block').classList.toggle('danger', !blocked);

        // ---- admin actions ----
        // Both act on an ACCOUNT id, never an install id: an install is
        // published with every post, so acting on one would let anybody name
        // anybody. No account resolved (a pre-accounts row, or a person the
        // presence list hasn't caught up with) means nothing to act on, so the
        // buttons stay hidden rather than offering a request that must 400.
        popUid = p.uid || (m && m.user_id) || null;
        const isMe = p.id === settings.clientId || !!(account && popUid && popUid === account.id);
        const canModerate = isAdmin() && !!popUid && !isMe;
        // In voice right now? Only then is there a call to remove them from.
        const inVoice = canModerate && voicePresence.some((v) => v.user_id === popUid);
        $('pop-kick').hidden = !inVoice;
        $('pop-ban').hidden = !canModerate;
        $('pop-admin-sep').hidden = !canModerate;

        pop.hidden = false;              // shown before measuring, so it has a size
        placePopover(pop, anchor);
    }

    function closePopover() { $('popover').hidden = true; popFor = null; }

    $('pop-vol').addEventListener('input', async (e) => {
        if (!popFor) return;
        const v = Number(e.target.value) / 100;
        paintPopVolume(Number(e.target.value));
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

    $('pop-mention').addEventListener('click', () => {
        const name = $('pop-name').textContent;
        closePopover();
        if (name) insertAtCursor(input, '@' + name + ' ');
    });

    $('pop-block').addEventListener('click', () => {
        const cid = popFor;
        const name = $('pop-name').textContent;
        closePopover();
        if (!cid) return;
        if (isBlocked(cid)) unblockPerson(cid); else blockPerson(cid, name);
    });

    $('pop-kick').addEventListener('click', () => {
        const uid = popUid, name = $('pop-name').textContent;
        closePopover();
        if (uid) kickFromVoice(uid, name);
    });

    $('pop-ban').addEventListener('click', () => {
        const uid = popUid, name = $('pop-name').textContent;
        closePopover();
        if (uid) banMember(uid, name);
    });

    // Ending someone's call is loud but undoable — they may rejoin at once — so
    // it asks once and says so, rather than pretending to be permanent.
    async function kickFromVoice(userId, name) {
        const who = name || 'them';
        const ok = await askConfirm('Remove ' + who + ' from voice?',
            'They are dropped from the call immediately and told an admin removed ' +
            'them. Nothing stops them rejoining — ban them if it needs to stick.',
            'Remove', true);
        if (!ok) return;
        const res = await L.board('voice/kick', { method: 'POST', body: { userId } });
        if (authGone(res)) return;
        if (!res || !res.success) return toast((res && res.error) || 'Could not remove them', true);
        toast('Removed ' + who + ' from voice');
    }

    async function banMember(userId, name) {
        const who = name || 'them';
        const ok = await askConfirm('Ban ' + who + '?',
            'They are signed out everywhere and cannot sign in again. Their messages ' +
            'stay. You can lift this from Settings → Members.',
            'Ban', true);
        if (!ok) return;
        const res = await L.board('account/manage', { method: 'POST', body: { userId, action: 'ban' } });
        if (authGone(res)) return;
        if (!res || !res.success) return toast((res && res.error) || 'Could not ban them', true);
        toast('Banned ' + who);
        // Keep the Settings → Members list honest if it happens to be open.
        if (isAdmin()) renderMemberAdmin();
    }

    document.addEventListener('mousedown', (e) => {
        if ($('popover').hidden) return;
        if (!e.target.closest('#popover') && !e.target.closest('.vp')) closePopover();
    });

    // ---------- text presence (members + custom status) --------------------
    // Separate from the voice heartbeat below: this one says "I'm here in the
    // board", which is true whether or not you're in the call. Same endpoint,
    // cadence and away rule as the website, so both clients populate one list.

    const TEXT_PRESENCE_MS = 20000;
    const AWAY_AFTER_MS = 5 * 60 * 1000;

    let members = [];
    let textPresenceTimer = null;
    let lastActivity = Date.now();

    ['mousemove', 'keydown', 'pointerdown'].forEach((ev) => {
        window.addEventListener(ev, () => { lastActivity = Date.now(); }, { passive: true });
    });

    // The four things you can CHOOSE to be. 'online' is the only one that still
    // lets the app decide — it is what auto-away hangs off. The rest are
    // overrides and stay put.
    const PRESENCE_MODES = ['online', 'idle', 'dnd', 'invisible'];
    const PRESENCE_LABEL = {
        online: 'Online', idle: 'Idle', dnd: 'Do Not Disturb', invisible: 'Invisible'
    };
    // What each mode looks like to the presence table, and therefore to
    // everyone else's member list. 'invisible' has no wire value on purpose —
    // see sendTextPresence, which stops publishing entirely.
    const PRESENCE_WIRE = { idle: 'away', dnd: 'dnd' };

    function presenceMode() {
        const m = settings.presence;
        if (PRESENCE_MODES.includes(m)) return m;
        // A profile written before this setting existed: the boolean is the
        // only thing it can tell us.
        return settings.dnd ? 'dnd' : 'online';
    }
    function isInvisible() { return presenceMode() === 'invisible'; }
    // Everything that used to read settings.dnd asks this instead, so the
    // checkbox in Settings and the picker in the account panel can never
    // disagree about whether you are silenced.
    function isDnd() { return presenceMode() === 'dnd'; }

    async function setPresenceMode(mode) {
        if (!PRESENCE_MODES.includes(mode)) return;
        // `dnd` is written alongside so the Settings checkbox, older builds and
        // the existing tests all keep reading a value that matches.
        await saveSettings({ presence: mode, dnd: mode === 'dnd' });
        renderMe();
        renderChannels();          // the taskbar badge is suppressed while DND is on
        paintMePopover();
        const dndBox = $('set-dnd');
        if (dndBox) dndBox.checked = isDnd();
        // Publish it now rather than up to TEXT_PRESENCE_MS later.
        sendTextPresence(false);
    }

    function myPresenceStatus() {
        const mode = presenceMode();
        // An explicit choice outranks everything computed — that is what makes
        // it a choice.
        if (mode !== 'online') return PRESENCE_WIRE[mode] || 'online';
        if (document.hidden || !windowFocused) return 'away';
        if (Date.now() - lastActivity > AWAY_AFTER_MS) return 'away';
        return 'online';
    }
    // The dot class for a mode, shared by the me-bar, the panel and the menu.
    function presenceDotClass(mode) {
        if (mode === 'idle') return 'away';
        if (mode === 'dnd') return 'dnd';
        if (mode === 'invisible') return 'invisible';
        return '';
    }

    // Voice rows arriving from /api/board/list historically carried no user_id.
    // Dropping it re-keys that person from their account to their install, which
    // stops matching their text-presence row and renders them twice. Carry
    // forward any id we already know for the same install, from either source.
    function keepKnownUids(list) {
        if (!Array.isArray(list) || !list.length) return [];
        if (list.every((p) => p && p.user_id)) return list;
        const known = new Map();
        members.forEach((m) => { if (m && m.client_id && m.user_id) known.set(m.client_id, m.user_id); });
        voicePresence.forEach((p) => { if (p && p.client_id && p.user_id) known.set(p.client_id, p.user_id); });
        return list.map((p) => (
            (p && !p.user_id && known.has(p.client_id))
                ? Object.assign({}, p, { user_id: known.get(p.client_id) })
                : p
        ));
    }

    async function sendTextPresence(leaving) {
        // Invisible is not a status the server understands — it is the ABSENCE
        // of one. Publishing "invisible" would just render as an unknown state
        // in every other client, so instead we retire the row, exactly as
        // leaving does, and stay out of the member list entirely.
        const gone = !!leaving || isInvisible();
        const res = await L.board('presence', {
            method: 'POST',
            body: {
                clientId: settings.clientId,
                name: settings.displayName || 'Anonymous',
                status: myPresenceStatus(),
                custom: settings.status || '',
                leaving: gone
            }
        });
        if (res && res.success && res.members) {
            members = res.members;
            members.forEach((m) => addRosterName(m.name));
            renderVoiceRoster();
        }
    }

    function startTextPresence() {
        stopTextPresence();
        sendTextPresence(false);
        textPresenceTimer = setInterval(() => sendTextPresence(false), TEXT_PRESENCE_MS);
    }

    function stopTextPresence() {
        if (textPresenceTimer) { clearInterval(textPresenceTimer); textPresenceTimer = null; }
    }

    // myPresenceStatus() reports "away" while the window is blurred, so without
    // this your own row stays away for up to TEXT_PRESENCE_MS after you click
    // back in. Debounced because focus, show and restore can all fire together.
    let presenceRefreshAt = 0;
    function refreshPresenceSoon() {
        if (!textPresenceTimer) return;          // only while the heartbeat is running
        const now = Date.now();
        if (now - presenceRefreshAt < 2000) return;
        presenceRefreshAt = now;
        sendTextPresence(false);
    }

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

    // ---------- auto-update card + release notes ---------------------------
    //
    // A right-aligned card that slides in under the title bar. It stays IN the
    // layout flow rather than floating over a corner: in a three-column shell an
    // overlay would sit on either the composer's controls or the member list,
    // whereas stealing ~60px of height covers nothing at any window size.
    //
    // Dismissing hides it for this session only. "Ready to install" still breaks
    // through a dismissal made while it was merely available or downloading -
    // that is new information - and dismissing the ready card keeps it away until
    // the next launch.

    let dismissed = null;                    // { version, ready }
    let updateState = { status: 'idle' };
    let bannerTimer = null;

    function updateVersionKey(s) { return s && s.version ? s.version : '?'; }

    function bannerSuppressed(s) {
        if (!dismissed || dismissed.version !== updateVersionKey(s)) return false;
        return dismissed.ready || s.status !== 'ready';
    }

    function hasNotes(s) { return !!(s && s.noteBlocks && s.noteBlocks.length); }

    const UPDATE_COPY = {
        available: (s) => ({
            title: 'Update available',
            sub: 'ScarmVoice ' + (s.version || ''),
            action: 'Download'
        }),
        downloading: (s) => ({
            title: 'Downloading update',
            sub: 'ScarmVoice ' + (s.version || '') + ' \u00b7 ' + (s.progress || 0) + '%',
            action: 'Downloading\u2026'
        }),
        ready: (s) => ({
            title: 'Update ready',
            sub: 'ScarmVoice ' + (s.version || '') + ' — restart to install',
            action: 'Restart to update'
        })
    };

    function showBanner() {
        const b = $('update-banner');
        clearTimeout(bannerTimer);
        b.classList.remove('leaving');
        b.hidden = false;                    // removing [hidden] runs the entrance
    }

    // Let the exit animation finish before the card leaves the flow, so the app
    // doesn't snap upward under it.
    function hideBanner() {
        const b = $('update-banner');
        if (b.hidden) return;
        clearTimeout(bannerTimer);
        b.classList.add('leaving');
        bannerTimer = setTimeout(() => {
            b.hidden = true;
            b.classList.remove('leaving');
        }, 200);
    }

    function renderUpdate(s) {
        updateState = s || { status: 'idle' };
        const make = UPDATE_COPY[updateState.status];

        const notesBtn = $('btn-release-notes');
        if (notesBtn) notesBtn.hidden = !hasNotes(updateState);
        if (notesOpen()) paintNotes();

        if (!make || bannerSuppressed(updateState)) { hideBanner(); return; }

        const c = make(updateState);
        $('ub-text').textContent = c.title;
        $('ub-sub').textContent = c.sub;
        $('ub-sub').title = c.sub;
        $('ub-action').textContent = c.action;
        $('ub-action').disabled = updateState.status === 'downloading';
        $('ub-progress').hidden = updateState.status !== 'downloading';
        if (updateState.status === 'downloading') {
            $('ub-bar').style.width = (updateState.progress || 0) + '%';
        }
        $('ub-notes-toggle').hidden = !hasNotes(updateState);
        showBanner();
    }

    function applyUpdateAction() {
        if (updateState.status === 'ready') L.update.install();
        else if (updateState.status === 'available') L.update.download();
    }

    $('ub-action').addEventListener('click', applyUpdateAction);
    $('ub-dismiss').addEventListener('click', () => {
        dismissed = { version: updateVersionKey(updateState), ready: updateState.status === 'ready' };
        hideBanner();
    });

    // ---- release notes modal ----
    // The changelog comes straight from the update feed as a block model (see
    // main/updater.js), so this stays correct on every future release with no
    // per-version edit here. Built with createElement + textContent: nothing from
    // a remote feed is ever handed to the DOM as markup.

    function notesOpen() { return !$('notes').hidden; }

    function renderNoteBlocks(container, blocks) {
        container.innerHTML = '';
        if (!blocks || !blocks.length) {
            const e = document.createElement('div');
            e.className = 'empty-state';
            e.textContent = 'This release was published without notes.';
            container.appendChild(e);
            return;
        }
        blocks.forEach((b) => {
            if (b.t === 'h') {
                const h = document.createElement('h3');
                h.className = 'nm-h';
                h.textContent = b.text;
                container.appendChild(h);
            } else if (b.t === 'ul') {
                const ul = document.createElement('ul');
                ul.className = 'nm-list';
                (b.items || []).forEach((it) => {
                    const li = document.createElement('li');
                    li.textContent = it;
                    ul.appendChild(li);
                });
                container.appendChild(ul);
            } else {
                const para = document.createElement('p');
                para.className = 'nm-p';
                para.textContent = b.text;
                container.appendChild(para);
            }
        });
    }

    // Footer + title track the live update state, so finishing a download while
    // the modal is open swaps "Download" for "Restart to update" in place.
    function paintNotes() {
        const s = updateState;
        $('notes-title').textContent = 'ScarmVoice ' + (s.version || '');
        const act = $('notes-action');
        const ready = s.status === 'ready';
        const downloading = s.status === 'downloading';
        const offerable = ready || downloading || s.status === 'available';
        act.hidden = !offerable;
        act.disabled = downloading;
        act.textContent = ready ? 'Restart to update'
            : downloading ? 'Downloading\u2026' : 'Download update';
        $('notes-hint').textContent = downloading ? (s.progress || 0) + '% downloaded'
            : ready ? 'Downloaded and waiting.' : '';
    }

    async function openNotes() {
        const s = await L.update.getState();
        if (s) updateState = s;
        paintNotes();
        renderNoteBlocks($('notes-body'), updateState.noteBlocks);
        $('notes-body').scrollTop = 0;
        $('notes').hidden = false;
        trapFocus($('notes'), { label: 'Release notes', initial: $('notes-close') });
    }

    function closeNotes() {
        releaseFocus($('notes'));
        $('notes').hidden = true;
    }

    $('ub-notes-toggle').addEventListener('click', openNotes);
    $('notes-close').addEventListener('click', closeNotes);
    $('notes-later').addEventListener('click', closeNotes);
    $('notes-action').addEventListener('click', () => { closeNotes(); applyUpdateAction(); });
    $('notes').addEventListener('mousedown', (e) => { if (e.target === $('notes')) closeNotes(); });

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
        // Re-arm at the appropriate cadence — but only inside a session.
        // rt.start(), rt.stop() and a credential-less connect() all emit a
        // status event, so this fires while the login card is up too, and
        // startPolling() refuses those (see the note there).
        startPolling();
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
            // Back online is exactly when anything queued should go out.
            await flushOutbox();
        } finally { resyncing = false; }
    }

    // One expiry timer per typist, refreshed while they keep typing.
    const typingTimers = new Map();   // cid -> timeout id
    function armTypingExpiry(cid) {
        clearTypingExpiry(cid);
        typingTimers.set(cid, setTimeout(() => {
            typingTimers.delete(cid);
            typingUsers = typingUsers.filter((t) => t.client_id !== cid);
            renderTyping();
        }, 6000));
    }
    function clearTypingExpiry(cid) {
        const t = typingTimers.get(cid);
        if (t) { clearTimeout(t); typingTimers.delete(cid); }
    }

    L.rt.onMessage((m) => {
        if (!m || !m.t) return;
        switch (m.t) {
            case 'posted':
                if (m.channel === channel) {
                    // loadMessages does the chime + notification once it has the
                    // real post bodies, so nothing to announce here.
                    //
                    // Coalesced: several people posting at once (or one person
                    // pasting a few lines) is one refetch, not one per event.
                    scheduleRefresh(nearBottom());
                } else if (!isBlocked(m.cid)) {
                    // Blocking hides someone's messages from the list, so it has
                    // to keep them out of the badge and the notification too —
                    // otherwise a blocked person still lights up the app and
                    // pops their message body onto the desktop.
                    bumpUnread(m.channel);
                    if (m.cid !== settings.clientId) notifyOtherChannel(m);
                }
                break;
            // An admin ended our call. Unicast by account, so every device this
            // person has open leaves — otherwise the phone stays in the call
            // after the desktop is removed and the server keeps seeing them.
            //
            // Leaving is the half that actually matters: the server has already
            // cleared the voice_presence row, and the heartbeat would put it
            // straight back if the engine stayed connected.
            case 'voicekick':
                if (voice && voice.isJoined()) {
                    leaveVoice();
                    toast(m.by ? m.by + ' removed you from the call' : 'An admin removed you from the call', true);
                }
                break;
            case 'typing':
                if (m.channel && m.channel !== channel) break;
                if (m.cid === settings.clientId) break;
                if (m.stop) {
                    typingUsers = typingUsers.filter((t) => t.client_id !== m.cid);
                    clearTypingExpiry(m.cid);
                } else {
                    if (!typingUsers.some((t) => t.client_id === m.cid)) {
                        typingUsers.push({ client_id: m.cid, name: m.name });
                    }
                    // Refreshed on EVERY event: the old one-shot timer was armed
                    // once at first sight, so someone typing a long message
                    // vanished at the 6s mark and popped back on each keystroke.
                    armTypingExpiry(m.cid);
                }
                renderTyping();
                break;
            case 'voice':
                if (Array.isArray(m.list)) {
                    // user_id is what lets the roster treat one person's
                    // devices as one entry — keep it.
                    voicePresence = m.list.map((v) => ({
                        client_id: v.cid || v.client_id, user_id: v.user_id || null,
                        name: v.name, muted: v.muted
                    }));
                    renderVoiceRoster();
                }
                break;
            case 'dm':
                onDmEvent(m);
                break;
            case 'voiceTakeover':
                // The same account joined voice somewhere else — one voice
                // session per person, so this device steps aside. leave() is
                // called unconditionally (it self-guards) so a takeover that
                // lands mid-join still cancels the in-flight join rather than
                // letting it complete with a live mic afterwards.
                if (voice && (voice.isJoined() || voice.isJoining())) {
                    if (voice.isJoined()) heartbeatPresence(true);
                    voice.leave();
                    toast('You joined voice from another device — disconnected here');
                }
                break;
            case 'welcome':
                if (m.voice) {
                    voicePresence = (m.voice || []).map((v) => ({
                        client_id: v.cid || v.client_id, user_id: v.user_id || null,
                        name: v.name, muted: v.muted
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
    const mentionsMe = (body) => window.ScarmLib.mentionsMe(body, settings.displayName);

    // Which known people this text mentions.
    //
    // The realtime 'posted' nudge deliberately carries no message body, so a
    // reader whose channel is set to mentions-only had no way to tell an @you
    // from ordinary chatter in a channel they aren't looking at — the honest
    // answer was to stay silent, which made the setting useless anywhere but the
    // channel already on screen. Sending the matched NAMES instead of the body
    // fixes that without putting message text on the wire.
    //
    // It runs the same matcher the receiver would, once per known name, so the
    // two can never disagree about what counts as a mention. The roster is a
    // handful of people on this board; if it ever isn't, this is the line to
    // revisit.
    function mentionNamesIn(body) {
        if (!body) return [];
        try {
            return getRoster()
                .filter((nm) => window.ScarmLib.mentionsMe(body, nm))
                .slice(0, 16);
        } catch (e) { return []; }
    }

    // Tell everyone else a message landed. `body` is optional — edits and
    // deletes are refresh nudges, not new messages, and carry none.
    function announcePosted(channelName, body) {
        L.rt.notifyPosted(channelName, mentionNamesIn(body));
    }

    // Rich notification for fresh posts in the CURRENT channel — the mention is
    // preferred over the newest message, same as the website.
    async function notifyForPosts(all) {
        if (settings.notifications === false) return;
        if (windowFocused) return;   // you're already looking at it

        // Blocked authors are filtered out of the rendered list, so notifying
        // about them would announce a message the reader can't even see.
        const fresh = all.filter((p) => !isBlocked(p.client_id));
        if (!fresh.length) return;

        const mention = fresh.find((p) => mentionsMe(p.body));
        // Ordered after the mention scan, not before it: on 'mentions' the
        // answer depends on what these posts actually contain.
        if (!alertsAllowed(channel, !!mention)) return;

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
        const mentioned = namesIncludeMe(m && m.mentions);
        if (!alertsAllowed(m.channel, mentioned)) return;
        await L.app.notify({
            title: (mentioned ? '@you · #' : '#') + (m.channel || 'general'),
            body: m.name
                ? `${m.name} ${mentioned ? 'mentioned you' : 'sent a message'}`
                : (mentioned ? 'You were mentioned' : 'New message')
        });
    }

    // Does this list of mentioned names include me? Sent by the poster (see
    // mentionNamesIn); absent from an older client, which reads as "no", i.e.
    // exactly the behaviour before the hint existed.
    function namesIncludeMe(names) {
        if (!Array.isArray(names) || !names.length) return false;
        const me = String(settings.displayName || '').toLowerCase();
        if (!me || me === 'anonymous') return false;
        return names.some((n) => String(n || '').toLowerCase() === me);
    }

    function startPolling() {
        stopPolling();
        // NOTHING may poll outside a live session. The poll's first act is a
        // board call, and a board call without a credential comes back
        // needsAuth/needsAccount, which authGone() turns into "Your session
        // expired. Sign in again." on the login card.
        //
        // That is not hypothetical, it was a loop with no exit: rt.stop() ends
        // by emitting a status event, so teardownSession()'s stopPolling() was
        // undone a few lines later by its own L.rt.stop() — the onStatus
        // handler below re-armed the timer that had just been cleared. Four
        // seconds later the tick 401'd, called relogin(), and the whole thing
        // went round again, re-printing the expiry banner and yanking focus
        // back to the password field every POLL_ACTIVE_MS forever. The same
        // edge armed it at boot: auth:status starts the socket before the
        // account step, so its status event began polling from behind the
        // login card on every launch.
        if (!entered) return;
        const every = rtConnected ? POLL_IDLE_MS : POLL_ACTIVE_MS;
        const gen = sessionGen;
        pollTimer = setInterval(async () => {
            // A session that ended between ticks takes its timer with it, in
            // case anything ever arms one behind teardown again.
            if (!entered || gen !== sessionGen) { stopPolling(); return; }
            if (document.hidden && rtConnected) return;
            const stick = nearBottom();
            await loadMessages(stick);
            await loadChannels();
            // The poll is also the retry clock for anything queued while the
            // socket was down but before it reported itself as reconnected.
            await flushOutbox();
        }, every);
    }

    // Every way out of the app — expired session, account sign-out, full sign-out
    // — has to release the same things. Account sign-out used to release none of
    // them, so the timers kept polling, presence kept reporting you online and
    // the microphone stayed open behind the login gate.
    async function teardownSession() {
        entered = false;
        sessionGen++;
        if (voice && voice.isJoined()) heartbeatPresence(true);
        // Unconditional: leave() self-guards on (joined || joining), and calling
        // it only when isJoined() is true meant a session that expired DURING a
        // join never bumped voice.js's generation counter — so the in-flight
        // join resolved afterwards and reconnected the mic behind the login gate.
        if (voice) voice.leave();
        // Two more microphones, neither of them the call's: a voice message
        // still recording and the Settings mic test. Both hold their own
        // getUserMedia stream, so leaving the call releases neither and the OS
        // mic indicator stayed lit behind the login gate. The recording is
        // CANCELLED rather than stopped — its clip belongs to the session that
        // just ended, and nothing may be sent with the credential gone.
        stopRecording(false);
        if (recMaxTimer) { clearTimeout(recMaxTimer); recMaxTimer = null; }
        // Covered again by the closeSettings() below, but kept explicit: the
        // mic must be released whether or not the sheet was ever open.
        stopMicTest();
        // The thread poll runs on its own timer and would otherwise survive
        // teardown: with no credential every tick 401s and calls relogin(),
        // which re-focuses the password field every 2.5s while it's being typed.
        closeThread();
        // renderMessages() refuses to run while a .msg-edit node exists, so an
        // editor left open by the teardown does not just leak — it freezes the
        // message list for the whole of the next session.
        cancelEdit();
        // #settings is a SIBLING of #app, not a child, so hiding #app leaves it
        // on screen — and both are .overlay { z-index: 100 } with settings later
        // in the document, so an expired session painted the settings sheet over
        // the login card. Worse, closeSettings() is what calls releaseFocus():
        // without it the focus trap stayed armed and the password field could
        // not be reached at all.
        closeSettings();
        // Both of these are one-shot coalescing timeouts rather than intervals,
        // so each survives teardown by at most a quarter second — but each then
        // fires a request with no credential, 401s, and calls relogin() again,
        // which re-focuses the password field out from under someone already
        // typing into it.
        if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
        clearTimeout(filterTimer);
        filterTimer = null;
        // The DM drawer holds its own poll-independent state; leaving it open
        // means the next session starts with a stranger's conversation on screen.
        closeDm();
        stopDmPolling();
        stopPolling();
        stopPresence();
        // Awaited so the members list loses us now rather than on its next sweep.
        try { await sendTextPresence(true); } catch (e) { /* leaving either way */ }
        stopTextPresence();
        try { await L.rt.stop(); } catch (e) { /* socket is going away regardless */ }
    }

    async function relogin() {
        await teardownSession();
        $('app').hidden = true;
        // Never take away a code screen. relogin() is called from a dozen
        // places, all of them background work, and it used to slam the card
        // back to step 1 regardless — so one stale 401 wiped the verification
        // step while its owner was in their email client looking up the code,
        // and told them their session had expired. It hadn't: the board cookie
        // is good for thirty days, and the 401 was about the ACCOUNT (see
        // net.js). If the board session really has died, the code submit will
        // say so inline rather than throwing the flow away.
        if (holdingCode()) return;
        hideAccountStep();       // back to step 1 — the site password comes first
        $('login').hidden = false;
        $('login-error').textContent = 'Your session expired. Sign in again.';
        focusLogin('login-pw');
    }

    // A 401 that says "you need an account", not "your session died". The board
    // cookie is untouched, so this is a one-field hop back rather than the full
    // rewind relogin() performs — and it too leaves an in-progress step alone.
    async function requireAccount() {
        await teardownSession();
        account = null;
        $('app').hidden = true;
        if (holdingLogin()) return;
        showAccountStep();
    }

    // The two credentials fail differently and must be answered differently, so
    // every background call routes its 401 through here instead of assuming the
    // worse of the two. isAuthLoss() is the pure test, for callers that need to
    // clean up before the screen changes.
    function isAuthLoss(res) { return !!(res && (res.needsAuth || res.needsAccount)); }

    function authGone(res) {
        if (!isAuthLoss(res)) return false;
        if (res.needsAccount) requireAccount(); else relogin();
        return true;
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
    // Modifiers are checked exactly the way main/ptt.js checks them for the
    // global hook (the shared matcher lives in lib.js). Comparing only e.code
    // meant a binding of Ctrl+Q also opened the mic on a bare Q whenever the
    // window had focus.
    const matchesPtt = (e) => matchesPttBinding(e, settings.pttBinding);
    window.addEventListener('keydown', (e) => {
        if (recordingPtt) return;
        if (settings.voiceMode !== 'ptt' || !voice || !voice.isJoined()) return;
        if (!matchesPtt(e) || inEditable(e.target)) return;
        e.preventDefault();
        voice.setPttHeld(true);
    }, true);
    // Released on the key itself, ignoring modifier state: letting go of Ctrl
    // before Q would otherwise leave the mic open, because the keyup for Q no
    // longer satisfies the binding's modifier requirement.
    window.addEventListener('keyup', (e) => {
        if (recordingPtt) return;
        if (settings.voiceMode !== 'ptt' || !voice) return;
        const b = settings.pttBinding;
        if (!b || b.type === 'mouse' || e.code !== b.code) return;
        voice.setPttHeld(false);
    }, true);

    // Losing focus mid-hold means the keyup lands in whatever window took over,
    // so without this the mic stays open until you press and release the key
    // again — the classic "I alt-tabbed and kept broadcasting" bug.
    //
    // ONLY when the native hook is unavailable. With uiohook-napi loaded, PTT is
    // deliberately global: holding the key while working in another window is
    // the whole point, and releasing on blur would break it. The hook is an
    // optional dependency, so the in-window path is what ships whenever the
    // prebuilt binary didn't install.
    let pttHookAvailable = true;    // assume the safe answer until told otherwise
    L.ptt.available().then((ok) => { pttHookAvailable = !!ok; });

    window.addEventListener('blur', () => {
        if (pttHookAvailable) return;
        if (settings.voiceMode !== 'ptt' || !voice) return;
        voice.setPttHeld(false);
    });

    // ---------- tray commands ---------------------------------------------

    L.app.onCommand(({ cmd }) => {
        // voice is null until setupVoice() runs at entry, and a stale tray menu
        // can fire these before then — every other call site guards the same way.
        if (cmd === 'toggleMute' && voice && voice.isJoined()) voice.toggleMuted();
        else if (cmd === 'toggleDeafen' && voice && voice.isJoined()) voice.toggleDeafened();
        else if (cmd === 'joinVoice') joinVoice();
        else if (cmd === 'leaveVoice') leaveVoice();
    });

    L.win.onFocus((focused) => {
        const was = windowFocused;
        windowFocused = focused;
        // Clicking back in makes you "online" again — say so now rather than at
        // the next heartbeat, or the roster shows you away while you're typing.
        if (focused && !was) refreshPresenceSoon();
    });

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
        refreshPresenceSoon();
        // The thread and DM polls skip their ticks while hidden, so refresh
        // whichever panels are open now rather than leaving them stale until
        // their next interval.
        if (threadOpen()) loadThread(true);
        if (account) {
            loadDmThreads();
            if (dmOpen) loadDmMessages(true);
        }
    });

    // ---------- identity --------------------------------------------------

    function renderMe() {
        const name = settings.displayName || 'Anonymous';
        const mode = presenceMode();
        const label = PRESENCE_LABEL[mode];
        $('me-name-text').textContent = name;
        paintAvatarEl($('me-avatar'), name, myUserId());
        // The second line is never empty: your custom status if you wrote one,
        // and what you are otherwise. A blank line under the name is what made
        // this look like a label rather than an account.
        //
        // In a call it says so instead. "Online" is true of everyone reading
        // this and tells you nothing; being in voice is the fact worth the line,
        // and it is the one the reference puts there.
        const st = $('me-status');
        const voiceNow = !!(voice && voice.isJoined && voice.isJoined());
        const text = voiceNow ? 'In voice' : (settings.status || label);
        $('me-status-text').textContent = text;
        st.querySelector('.ms-voice').toggleAttribute('hidden', !voiceNow);
        st.title = settings.status ? `${label} — ${settings.status}` : label;
        st.hidden = false;
        const dot = $('me-presence');
        dot.className = 'me-presence ' + presenceDotClass(mode);
        dot.title = label;
        // Rename/delete are admin-only server-side; leaving the header buttons
        // up for a member is a control that can only ever return a 403.

    }

    // Name and status together, like the website's name pill — they're the two
    // things that describe you to everyone else.
    async function changeName() {
        const r = await askStatus(settings.status || '');
        if (r === null) return;
        await saveSettings({ status: r.trim().slice(0, 80) });
        renderMe();
        renderAccountCard();
        paintMePopover();
        $('set-status').value = settings.status || '';
        sendTextPresence(false);      // publish it now rather than up to 20s later
    }

    // ---------- connection details ------------------------------------------
    // Everything here is read off getStats(): the round trip the transport
    // measured, the loss the far end reported, and the candidate pair the media
    // is actually using. Nothing is estimated, and anything unmeasured is drawn
    // as "unknown" rather than as a plausible number.

    const CONN_W = 300;
    const CONN_H = 88;
    // The graph's ceiling. Fixed at 100ms until the samples exceed it, then it
    // grows — a fixed axis would flatten a 400ms spike into the top edge and a
    // free one would make 20ms of jitter look like a crisis.
    const CONN_FLOOR = 100;

    function connPopOpen() { return !$('conn-pop').hidden; }

    function connPlot(history) {
        const svg = $('cp-plot');
        svg.innerHTML = '';
        const taken = history.filter((v) => v !== null);
        if (!taken.length) return CONN_FLOOR;
        const top = Math.max(CONN_FLOOR, Math.ceil(Math.max.apply(null, taken) / 50) * 50);
        const NS = 'http://www.w3.org/2000/svg';
        // Two rules, at the axis labels. Drawn first so the trace is over them.
        [0.5, 1].forEach((f) => {
            const y = CONN_H - (CONN_H * f) / 2;
            const ln = document.createElementNS(NS, 'line');
            ln.setAttribute('x1', 0); ln.setAttribute('x2', CONN_W);
            ln.setAttribute('y1', y); ln.setAttribute('y2', y);
            ln.setAttribute('class', 'cp-rule');
            svg.appendChild(ln);
        });
        // One run per unbroken stretch of samples. A gap in the data is drawn as
        // a gap, not bridged — a line across a hole would claim measurements
        // nobody took.
        const step = history.length > 1 ? CONN_W / (history.length - 1) : CONN_W;
        let run = [];
        const flush = () => {
            if (run.length > 1) {
                const path = document.createElementNS(NS, 'polyline');
                path.setAttribute('points', run.join(' '));
                path.setAttribute('class', 'cp-line');
                svg.appendChild(path);
            }
            run = [];
        };
        history.forEach((v, i) => {
            if (v === null) { flush(); return; }
            const x = (i * step).toFixed(1);
            const y = (CONN_H - Math.min(1, v / top) * CONN_H).toFixed(1);
            run.push(x + ',' + y);
        });
        flush();
        return top;
    }

    function paintConnPop() {
        if (!connPopOpen()) return;
        const c = (voice && voice.connection) ? voice.connection() : null;
        const ms = (v) => (v === null || v === undefined ? 'unknown' : v + ' ms');

        const top = connPlot(c ? c.history : []);
        const axis = $('conn-pop').querySelectorAll('.cp-axis span');
        axis[0].textContent = String(top);
        axis[1].textContent = String(Math.round(top / 2));

        // Real clock times under the graph, spaced by the sampling interval —
        // labelling the axis with anything else would be decoration.
        const times = $('cp-times');
        times.innerHTML = '';
        const n = c ? c.history.length : 0;
        if (n > 1) {
            const spanMs = (n - 1) * 3000;
            for (let i = 0; i < 4; i++) {
                const t = new Date(Date.now() - spanMs + (spanMs * i) / 3);
                const el = document.createElement('span');
                el.textContent = timeStr(t.getTime());
                times.appendChild(el);
            }
        }

        $('cp-avg').textContent = ms(c && c.avgRtt);
        $('cp-last').textContent = ms(c && c.rtt);
        $('cp-loss').textContent = (c && c.lossPct !== null && c.lossPct !== undefined)
            ? c.lossPct.toFixed(1) + '%' : 'unknown';

        // What the route actually is, rather than a server name we do not have.
        // "relay" means a TURN server is forwarding; "srflx" and "host" are
        // direct. It is the honest version of the reference's region line.
        const ROUTE = { relay: 'Relayed (TURN)', srflx: 'Direct', prflx: 'Direct', host: 'Direct (local)' };
        const bits = [];
        if (c && c.candidate) bits.push(ROUTE[c.candidate] || c.candidate);
        if (c && c.protocol) bits.push(c.protocol.toUpperCase());
        if (c && c.remote) bits.push(c.remote);
        $('cp-route').textContent = bits.length ? bits.join(' · ') : 'Route unknown';

        // The honest encryption line. Media is DTLS-SRTP on every leg, but a
        // call through the SFU is decrypted and re-encrypted there — so it is
        // NOT end-to-end, and saying otherwise would be a lie about the one
        // thing nobody can check for themselves.
        const mesh = c && c.peers > 1;
        $('cp-crypt').textContent = mesh
            ? 'Encrypted peer-to-peer (DTLS-SRTP)'
            : 'Encrypted in transit (DTLS-SRTP) — relayed through the voice server';
    }

    let connTimer = null;

    function openConnPop() {
        const pop = $('conn-pop');
        const anchor = $('vl-status');
        pop.hidden = false;
        $('vl-status').setAttribute('aria-expanded', 'true');
        paintConnPop();
        const r = anchor.getBoundingClientRect();
        const h = pop.offsetHeight;
        let top = r.top - h - 10;
        if (top < POP_TITLEBAR + 6) top = POP_TITLEBAR + 6;
        pop.style.top = Math.round(top) + 'px';
        pop.style.left = Math.round(Math.max(8, r.left - 4)) + 'px';
        // Repainted on the same three-second beat the sampler runs on, so the
        // panel is never showing a number older than one sample.
        clearInterval(connTimer);
        connTimer = setInterval(paintConnPop, 3000);
    }

    function closeConnPop() {
        $('conn-pop').hidden = true;
        $('vl-status').setAttribute('aria-expanded', 'false');
        clearInterval(connTimer);
        connTimer = null;
    }

    $('vl-status').addEventListener('click', () => {
        if (connPopOpen()) closeConnPop(); else openConnPop();
    });
    document.addEventListener('mousedown', (e) => {
        if (!connPopOpen()) return;
        if (e.target.closest('#conn-pop') || e.target.closest('#vl-status')) return;
        closeConnPop();
    });

    $('cp-copy').addEventListener('click', async () => {
        const c = (voice && voice.connection) ? voice.connection() : {};
        const lines = [
            'ScarmVoice connection',
            'version: ' + ($('set-version').textContent || 'unknown'),
            'route: ' + $('cp-route').textContent,
            'codec: ' + (c.codec || 'unknown'),
            'peers: ' + (c.peers || 0),
            'last ping: ' + $('cp-last').textContent,
            'average ping: ' + $('cp-avg').textContent + ' over ' + (c.samples || 0) + ' samples',
            'outbound packet loss: ' + $('cp-loss').textContent,
            'voice mode: ' + (settings.voiceMode || 'open')
        ];
        try {
            await navigator.clipboard.writeText(lines.join('\n'));
            toast('Connection details copied');
        } catch (e) { toast('Could not copy', true); }
    });

    $('cp-logs').addEventListener('click', async () => {
        const ok = await L.app.openLogs();
        if (!ok) toast('No log folder yet', true);
    });

    // ---------- tooltips -----------------------------------------------------
    // `title` is the browser's, which means a delay measured in seconds, no
    // styling, and an OS bubble that ignores the theme. Anything carrying
    // data-tip gets this instead: one floating node, positioned above the
    // element with a little arrow, reused for every target.
    //
    // Delegated rather than bound per element, so a tip works on markup that is
    // rebuilt later without anything having to re-attach.

    let tipEl = null;
    let tipFor = null;

    function tipNode() {
        if (tipEl) return tipEl;
        tipEl = document.createElement('div');
        tipEl.className = 'tip';
        tipEl.hidden = true;
        tipEl.setAttribute('role', 'tooltip');
        document.body.appendChild(tipEl);
        return tipEl;
    }

    function showTip(target) {
        const text = target.getAttribute('data-tip');
        if (!text) return;
        const el = tipNode();
        tipFor = target;
        el.textContent = text;
        el.hidden = false;
        // Measured after it has text, then clamped into the window.
        const t = target.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        let left = t.left + (t.width - r.width) / 2;
        left = Math.max(6, Math.min(left, window.innerWidth - r.width - 6));
        // 6, not 9: the arrow is 5px, so a wider gap leaves it pointing across
        // empty space rather than at the thing it names.
        let top = t.top - r.height - 6;
        // No room above (the target is up against the title bar) — go below.
        const below = top < POP_TITLEBAR + 4;
        if (below) top = t.bottom + 6;
        el.classList.toggle('below', below);
        el.style.left = Math.round(left) + 'px';
        el.style.top = Math.round(top) + 'px';
        // The arrow tracks the TARGET's centre, not the tip's, so a tip that had
        // to be clamped sideways still points at the thing it describes.
        el.style.setProperty('--tip-arrow', Math.round(t.left + t.width / 2 - left) + 'px');
    }

    function hideTip() {
        if (!tipEl) return;
        tipEl.hidden = true;
        tipFor = null;
    }

    // Kept live: the mic button's label is "Mute" or "Unmute" depending on
    // state, and the state can change while the pointer is still on it.
    function refreshTip(target) {
        if (tipFor && tipFor === target && tipEl && !tipEl.hidden) showTip(target);
    }

    document.addEventListener('pointerover', (e) => {
        const t = e.target.closest && e.target.closest('[data-tip]');
        if (!t) { if (tipFor && !tipFor.contains(e.target)) hideTip(); return; }
        // Re-shown when the LABEL changed as well as when the target did: mute
        // and deafen rewrite theirs, and a stale word under the cursor is worse
        // than no word at all.
        if (t !== tipFor || (tipEl && tipEl.textContent !== t.getAttribute('data-tip'))) showTip(t);
    });
    document.addEventListener('pointerout', (e) => {
        const t = e.target.closest && e.target.closest('[data-tip]');
        if (t && t === tipFor && !t.contains(e.relatedTarget)) hideTip();
    });
    // A tip left hanging over a menu that has just opened is worse than none.
    document.addEventListener('mousedown', hideTip);
    document.addEventListener('scroll', hideTip, true);
    window.addEventListener('blur', hideTip);
    // Keyboard users get it on focus, which is the whole point of it not being
    // a `title`.
    document.addEventListener('focusin', (e) => {
        const t = e.target.closest && e.target.closest('[data-tip]');
        if (t) showTip(t);
    });
    document.addEventListener('focusout', hideTip);

    // ---------- account panel (the me-bar identity block) -------------------
    // Everything about you that isn't a setting: who you are, what you are
    // showing as, and the two account-level actions. Opened by clicking your
    // name, closed by anything else.

    function mePopoverOpen() { return !$('me-popover').hidden; }

    function paintMePopover() {
        if (!mePopoverOpen()) return;
        const name = settings.displayName || 'Anonymous';
        const mode = presenceMode();
        $('mep-name').textContent = name;
        // The handle is the account username. It is the same string as the
        // display name today — deliberately, it is what stops anyone wearing
        // someone else's name — so showing both is honest rather than
        // redundant: it says the name IS the account.
        // No @: the popover shows the bare username, and the sigil only ever
        // read as decoration here — there is nowhere else on this line for it
        // to be distinguishing.
        $('mep-handle').textContent = account ? account.username : 'not signed in';
        paintAvatarEl($('mep-avatar'), name, myUserId());
        // Tinted from the same hash the avatar is, so the panel is recognisably
        // yours without asking for a second image to upload.
        $('mep-banner').setAttribute('style', bannerStyle(name));
        $('mep-presence').className = 'mep-presence ' + presenceDotClass(mode);
        $('mep-status-dot').className = 'presence ' + presenceDotClass(mode);
        $('mep-status-label').textContent = PRESENCE_LABEL[mode];
        // Empty, it still says something: an invitation is the only way anyone
        // finds out the field is there.
        const custom = $('mep-custom');
        custom.classList.toggle('has-status', !!settings.status);
        $('mep-custom-text').textContent = settings.status || "What you're up to";
        custom.setAttribute('data-tip', settings.status ? 'Edit your status' : 'Set a custom status');
        // Nothing to switch to and no id to copy without an account, which
        // leaves that whole card with nothing in it.
        $('mep-menu-account').hidden = !account;
    }

    function openMePopover() {
        const pop = $('me-popover');
        const anchor = $('btn-name');
        pop.hidden = false;
        paintMePopover();
        // Measured after it is shown, then clamped. It is position:fixed so the
        // sidebar's own overflow can never clip it.
        const r = anchor.getBoundingClientRect();
        const h = pop.offsetHeight;
        const w = pop.offsetWidth;
        let top = r.top - h - 8;
        if (top < POP_TITLEBAR + 6) top = POP_TITLEBAR + 6;
        let left = r.left - 4;
        if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
        pop.style.top = Math.round(top) + 'px';
        pop.style.left = Math.round(Math.max(8, left)) + 'px';
        anchor.setAttribute('aria-expanded', 'true');
    }

    function closeMePopover() {
        $('me-popover').hidden = true;
        $('btn-name').setAttribute('aria-expanded', 'false');
    }

    function toggleMePopover() {
        if (mePopoverOpen()) closeMePopover(); else openMePopover();
    }

    $('btn-name').addEventListener('click', (e) => { e.stopPropagation(); toggleMePopover(); });

    document.addEventListener('mousedown', (e) => {
        if (!mePopoverOpen()) return;
        if (e.target.closest('#me-popover') || e.target.closest('#btn-name')) return;
        // The status picker is a context menu drawn OUTSIDE the panel, so a
        // click in it must not read as a click away from the panel.
        if (e.target.closest('#ctx-menu')) return;
        closeMePopover();
    });
    window.addEventListener('blur', closeMePopover);

    // The status picker. A context menu rather than a bespoke submenu: it is a
    // list of mutually exclusive options with a tick on the active one, which
    // is exactly what openCtxMenu already draws.
    $('mep-status').addEventListener('click', (e) => {
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        const mode = presenceMode();
        const item = (m, note) => ({
            label: PRESENCE_LABEL[m] + (note ? ' \u2014 ' + note : ''),
            dot: presenceDotClass(m),
            check: mode === m,
            onClick: () => setPresenceMode(m)
        });
        openCtxMenu([
            item('online'),
            item('idle'),
            item('dnd', 'no notifications'),
            item('invisible', 'appear offline'),
            'sep',
            { label: settings.status ? 'Edit custom status' : 'Set a custom status', icon: 'pencil',
                onClick: () => { closeMePopover(); changeName(); } },
            settings.status && { label: 'Clear custom status', icon: 'x',
                onClick: async () => {
                    await saveSettings({ status: '' });
                    renderMe(); renderAccountCard(); paintMePopover();
                    $('set-status').value = '';
                    sendTextPresence(false);
                } }
        ], r.right + 6, r.top - 4);
    });

    $('mep-edit').addEventListener('click', () => { closeMePopover(); openSettings(); });
    // The field already exists in Settings; this is the only place it is ever
    // offered. Straight there, with the caret in it.
    $('mep-custom').addEventListener('click', async () => {
        closeMePopover();
        await openSettings();
        $('set-status').focus();
        $('set-status').select();
    });

    $('mep-copy-id').addEventListener('click', () => {
        if (!account) return;
        navigator.clipboard.writeText(String(account.id)).then(
            () => { closeMePopover(); toast('User ID copied'); },
            () => toast('Could not copy', true)
        );
    });

    // The app holds one account at a time, so "switch" is sign out and back in.
    // The BOARD session is left alone — this is the one-field hop back that
    // Settings' own account sign-out does, not a full sign-out.
    $('mep-switch').addEventListener('click', async () => {
        closeMePopover();
        await teardownSession();
        await L.account.logout();
        account = null;
        dmThreads = [];
        closeDm();
        renderAccountCard();
        renderDmSection();
        closeSettings();
        $('app').hidden = true;
        showAccountStep();
    });

    // ---------- audio panels (the me-bar carets) -----------------------------
    // Two small panels rather than context menus: they carry sliders and a
    // checkbox, which a list of items cannot express. The DEVICE lists inside
    // them are still context menus, opened from the top row — a list of
    // mutually exclusive options with a tick is exactly what that engine draws.

    // Cache the last enumeration so a panel can name the current device the
    // instant it opens. enumerateDevices is a permission-gated round trip and
    // waiting on it would leave the row blank for a beat every single time.
    let deviceCache = [];
    async function refreshDeviceCache() {
        try { deviceCache = await navigator.mediaDevices.enumerateDevices(); }
        catch (e) { deviceCache = []; }
        return deviceCache;
    }

    function deviceLabel(kind, id) {
        const isMic = kind === 'audioinput';
        if (!id) return isMic ? 'Windows Default' : 'Windows Default';
        const d = deviceCache.find((x) => x.kind === kind && x.deviceId === id);
        // Labels stay blank until microphone permission has been granted at
        // least once, so a saved device we cannot name is still reported as
        // chosen rather than silently reading as the default.
        return (d && d.label) || 'Selected device';
    }

    // How the app's two noise-suppression switches read as one choice, which is
    // what the row actually is: off, the browser's own, or the AI model.
    function inputProfile() {
        if (settings.noiseSuppressionAI) return 'ai';
        return settings.noiseSuppression === false ? 'off' : 'standard';
    }
    const PROFILE_LABEL = { off: 'None', standard: 'Standard', ai: 'Clear Voice' };
    // The pane's three radios against the same two flags: Clear Voice is AI on,
    // Studio is everything off, and Custom is neither of those — whatever the
    // individual filters happen to say.
    const PANE_PROFILE = { ai: 'clear', off: 'studio', standard: 'custom' };

    // Paints the pane's radios and the Push to Talk switch from settings.
    function paintVoicePane() {
        const want = PANE_PROFILE[inputProfile()] || 'custom';
        document.querySelectorAll('#set-profile input[type="radio"]').forEach((r) => {
            r.checked = r.value === want;
        });
        const ptt = settings.voiceMode === 'ptt';
        $('set-ptt-toggle').setAttribute('aria-checked', String(ptt));
        $('row-ptt').style.display = ptt ? '' : 'none';
        const inv = settings.micVolume === undefined ? 1 : Number(settings.micVolume);
        $('set-invol').value = String(Math.round(inv * 100));
        paintRangeFill($('set-invol'));
        paintRangeFill($('set-outvol'));
        paintRangeFill($('set-vad'));
    }

    async function setInputProfile(mode) {
        const patch = mode === 'ai'
            ? { noiseSuppressionAI: true, noiseSuppression: true }
            : { noiseSuppressionAI: false, noiseSuppression: mode === 'standard' };
        await saveSettings(patch);
        window.ScarmNoise.setEnabled(!!settings.noiseSuppressionAI);
        $('set-ns').checked = settings.noiseSuppression !== false;
        $('set-nsai').checked = !!settings.noiseSuppressionAI;
        paintAudioPanels();
        paintVoicePane();
        if (voice && voice.isJoined()) toast('Rejoin voice to apply audio processing changes');
    }

    function audioPopOpen(id) { return !$(id).hidden; }
    function closeAudioPops() {
        $('mic-pop').hidden = true;
        $('spk-pop').hidden = true;
        stopApMeter();
    }

    // The track is painted by CSS from --fill, so the value has to be written
    // there as well as to the input.
    function paintRangeFill(el) {
        if (!el) return;
        const min = Number(el.min || 0);
        const max = Number(el.max || 100);
        const pct = max > min ? ((Number(el.value) - min) / (max - min)) * 100 : 0;
        el.style.setProperty('--fill', pct.toFixed(1) + '%');
    }

    // A live microphone level, open only while the input panel is. An open
    // capture is not something to leave running behind a closed menu.
    let apMeter = null;

    function stopApMeter() {
        if (!apMeter) return;
        apMeter.off();
        apMeter.meter.stop();
        try { apMeter.stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
        apMeter = null;
        const bar = $('ap-meter');
        if (bar) bar.style.setProperty('--level', '0%');
    }

    async function startApMeter() {
        if (apMeter) return;
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: settings.micDeviceId ? { deviceId: { exact: settings.micDeviceId } } : true
            });
        } catch (e) { return; }          // no permission, no meter — and no error either
        // Metered on the renderer's shared AudioContext, like the Settings one:
        // Chromium allows six contexts, and a call already holds several.
        const meter = window.ScarmAudio.createMeter(stream);
        if (!meter) {
            try { stream.getTracks().forEach((t) => t.stop()); } catch (e2) {}
            return;
        }
        const off = window.ScarmAudio.onTick(() => {
            if (!apMeter) return;
            const pct = Math.min(100, (meter.rms() / METER_MAX) * 100);
            $('ap-meter').style.setProperty('--level', pct.toFixed(1) + '%');
        });
        apMeter = { stream, meter, off };
    }

    function paintAudioPanels() {
        $('ap-input-device-value').textContent = deviceLabel('audioinput', settings.micDeviceId);
        $('ap-output-device-value').textContent = deviceLabel('audiooutput', settings.speakerDeviceId);
        $('ap-input-profile-value').textContent = PROFILE_LABEL[inputProfile()];
        const mic = settings.micVolume === undefined ? 1 : Number(settings.micVolume);
        const out = settings.outputVolume === undefined ? 1 : Number(settings.outputVolume);
        $('ap-input-volume').value = String(Math.round(mic * 100));
        $('ap-output-volume').value = String(Math.round(out * 100));
        $('ap-ptt').checked = settings.voiceMode === 'ptt';
        paintRangeFill($('ap-input-volume'));
        paintRangeFill($('ap-output-volume'));
    }

    // Opened UPWARD: these buttons sit at the very bottom of the window, so a
    // panel anchored below one would only ever be clamped against the edge.
    function openAudioPop(popId, anchorId) {
        closeAudioPops();
        const pop = $(popId);
        pop.hidden = false;
        paintAudioPanels();
        // Only the input panel has a meter, and only while it is open.
        if (popId === 'mic-pop') startApMeter();
        const r = $(anchorId).getBoundingClientRect();
        const h = pop.offsetHeight;
        const w = pop.offsetWidth;
        let top = r.top - h - 8;
        if (top < POP_TITLEBAR + 6) top = POP_TITLEBAR + 6;
        let left = r.left - Math.round(w / 2);
        if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
        pop.style.top = Math.round(top) + 'px';
        pop.style.left = Math.round(Math.max(8, left)) + 'px';
        // Refresh the device names behind the panel; it is already on screen,
        // so this only ever corrects a stale label rather than delaying it.
        refreshDeviceCache().then(() => { if (!pop.hidden) paintAudioPanels(); });
    }

    function toggleAudioPop(popId, anchorId) {
        if (audioPopOpen(popId)) closeAudioPops();
        else openAudioPop(popId, anchorId);
    }

    $('btn-mic-menu').addEventListener('click', (e) => { e.stopPropagation(); toggleAudioPop('mic-pop', 'btn-mic-menu'); });
    $('btn-spk-menu').addEventListener('click', (e) => { e.stopPropagation(); toggleAudioPop('spk-pop', 'btn-spk-menu'); });

    document.addEventListener('mousedown', (e) => {
        if ($('mic-pop').hidden && $('spk-pop').hidden) return;
        if (e.target.closest('.audio-pop') || e.target.closest('.me-ctl-caret')) return;
        // The device list is a context menu drawn OUTSIDE the panel, so a click
        // in it must not read as a click away from the panel.
        if (e.target.closest('#ctx-menu')) return;
        closeAudioPops();
    });
    window.addEventListener('blur', closeAudioPops);

    // The device list itself.
    async function openDeviceList(kind, anchor) {
        const isMic = kind === 'audioinput';
        const current = (isMic ? settings.micDeviceId : settings.speakerDeviceId) || '';
        const list = (await refreshDeviceCache()).filter((d) => d.kind === kind);

        const choose = async (deviceId) => {
            await saveSettings(isMic ? { micDeviceId: deviceId } : { speakerDeviceId: deviceId });
            if (voice) voice.setSettings(settings);
            $(isMic ? 'set-mic' : 'set-speaker').value = deviceId;
            paintAudioPanels();
            // Changing the microphone mid-call needs a rejoin — the published
            // track is already negotiated. The speaker is only an output sink
            // and takes effect at once, so only one of these warns.
            if (isMic && voice && voice.isJoined()) toast('Rejoin voice to switch microphone');
        };

        const items = [{
            label: 'Windows Default', icon: isMic ? 'mic' : 'headset',
            check: !current, onClick: () => choose('')
        }];
        list.forEach((d, i) => {
            items.push({
                label: d.label || `${isMic ? 'Microphone' : 'Speaker'} ${i + 1}`,
                icon: isMic ? 'mic' : 'headset',
                check: d.deviceId === current,
                onClick: () => choose(d.deviceId)
            });
        });
        if (!list.length) {
            items.push({ label: 'No devices found — allow microphone access', icon: 'warning', disabled: true, onClick: () => {} });
        }
        const r = anchor.getBoundingClientRect();
        openCtxMenu(items, r.right + 6, r.top);
    }

    $('ap-input-device').addEventListener('click', (e) => { e.stopPropagation(); openDeviceList('audioinput', e.currentTarget); });
    $('ap-output-device').addEventListener('click', (e) => { e.stopPropagation(); openDeviceList('audiooutput', e.currentTarget); });

    $('ap-input-profile').addEventListener('click', (e) => {
        e.stopPropagation();
        const cur = inputProfile();
        const r = e.currentTarget.getBoundingClientRect();
        openCtxMenu(['off', 'standard', 'ai'].map((m) => ({
            label: PROFILE_LABEL[m], icon: m === 'off' ? 'mic' : 'sliders',
            check: cur === m, onClick: () => setInputProfile(m)
        })), r.right + 6, r.top);
    });

    // Live while dragging: the gain node is updated in place, so this is
    // audible to the room immediately without republishing the track.
    $('ap-input-volume').addEventListener('input', async (e) => {
        paintRangeFill(e.target);
        await saveSettings({ micVolume: Number(e.target.value) / 100 });
    });
    $('ap-output-volume').addEventListener('input', async (e) => {
        paintRangeFill(e.target);
        const v = Number(e.target.value) / 100;
        await saveSettings({ outputVolume: v });
        $('set-outvol').value = String(Math.round(v * 100));
        $('set-outvol-val').textContent = Math.round(v * 100) + '%';
    });

    $('ap-ptt').addEventListener('change', async (e) => {
        await saveSettings({ voiceMode: e.target.checked ? 'ptt' : 'open' });
        $('set-mode').value = settings.voiceMode;
        $('row-ptt').style.display = settings.voiceMode === 'ptt' ? '' : 'none';
        if (voice) voice.setPttHeld(false);
        await L.ptt.apply();
    });

    // To the pane the row names, not to whatever pane opens first.
    const toVoiceSettings = async () => {
        closeAudioPops();
        await openSettings();
        if (showSettingsPane) showSettingsPane(settingsPaneByTitle('Voice & Audio'));
    };
    $('ap-input-settings').addEventListener('click', toVoiceSettings);
    $('ap-output-settings').addEventListener('click', toVoiceSettings);


    // ---------- layout chrome: rail, categories, members sidebar ----------

    function applyMembersPanel(show) {
        $('members-panel').hidden = !show;
        const btn = $('btn-members');
        btn.classList.toggle('on', show);
        btn.setAttribute('aria-pressed', String(show));
        setTip(btn, show ? 'Hide Member List' : 'Show Member List');
    }

    $('btn-members').addEventListener('click', async () => {
        const show = $('members-panel').hidden;      // toggling to
        applyMembersPanel(show);
        await saveSettings({ showMembers: show });
    });

    // Collapsible channel categories, remembered across launches.
    const CATS = {
        text: { sec: 'text-section', key: 'catTextOpen' },
        dms: { sec: 'dm-section', key: 'catDmsOpen' },
        voice: { sec: 'voice-section', key: 'catVoiceOpen' }
    };

    function applyCategory(which, open) {
        $(CATS[which].sec).classList.toggle('collapsed', !open);
        $('cat-' + which).setAttribute('aria-expanded', String(open));
    }

    Object.keys(CATS).forEach((which) => {
        $('cat-' + which).addEventListener('click', async () => {
            const open = $(CATS[which].sec).classList.contains('collapsed');   // toggling to
            applyCategory(which, open);
            await saveSettings({ [CATS[which].key]: open });
        });
    });

    // The rail's server mark: back to the live end of the conversation.
    $('rail-home').addEventListener('click', () => { jumpToLatest(); input.focus(); });
    // The rail no longer carries a settings button. There were two gears within
    // an inch of each other at the bottom-left — the rail's and the user
    // panel's — doing the same thing. The user panel's is the one Discord has
    // and the one that sits where people look, so the rail's is gone.

    // Everything about the shell that comes out of saved settings.
    function applyChrome() {
        applyMembersPanel(settings.showMembers !== false);
        applyCategory('text', settings.catTextOpen !== false);
        applyCategory('dms', settings.catDmsOpen !== false);
        applyCategory('voice', settings.catVoiceOpen !== false);
        applyTheme();
        applyDensity();
        // The host is no longer a second line under the name — it is on the
        // header's own tooltip, where it answers "which server is this" without
        // spending a line on an answer nobody reads twice.
        $('server-menu').setAttribute('data-tip', serverHost());
    }

    function serverHost() {
        try { return new URL(settings.baseUrl || 'https://scarmonit.com').host; }
        catch (e) { return settings.baseUrl || 'scarmonit.com'; }
    }

    // ---------- theme ------------------------------------------------------
    // Three states: force dark, force light, or follow Windows. The main process
    // owns the system answer and pushes changes, and it also restyles the native
    // caption buttons so they don't sit on a patch of the old theme.

    let systemDark = true;

    function effectiveTheme() {
        const t = settings.theme || 'dark';
        if (t === 'system') return systemDark ? 'dark' : 'light';
        return t === 'light' ? 'light' : 'dark';
    }

    function applyTheme() {
        const t = effectiveTheme();
        document.documentElement.dataset.theme = t;
        L.app.setTheme(t);
    }

    L.app.systemTheme().then((s) => {
        if (s && typeof s.dark === 'boolean') { systemDark = s.dark; applyTheme(); }
    }).catch(() => {});
    L.app.onThemeChange((s) => {
        if (!s || typeof s.dark !== 'boolean') return;
        systemDark = s.dark;
        if ((settings.theme || 'dark') === 'system') applyTheme();
    });

    // ---------- message density -------------------------------------------

    function compactMode() { return settings.density === 'compact'; }

    function applyDensity() {
        const on = compactMode();
        $('messages').classList.toggle('compact', on);
        $('thread-list').classList.toggle('compact', on);
    }

    // ---------- do not disturb, muted channels, blocked people -------------

    // Per-channel alert level. 'all' is the default and needs no stored entry,
    // so a fresh profile and a profile that has never touched this setting are
    // the same thing.
    //
    // `mutedChannels` is the old binary form and is still read here: a profile
    // written by an older build has its muted list honoured as 'none' rather
    // than silently reverting to 'all' on upgrade. Writes go to channelAlerts
    // AND keep mutedChannels in step, because downgrading to an older build (or
    // the website, which still reads the binary list) must not resurrect a
    // channel someone deliberately silenced.
    const ALERT_MODES = ['all', 'mentions', 'none'];

    function channelAlertMode(name) {
        if (!name) return 'all';
        const m = (settings.channelAlerts || {})[name];
        if (ALERT_MODES.includes(m)) return m;
        return channelMuted(name) ? 'none' : 'all';
    }

    // One place decides whether anything is allowed to make a noise or a toast.
    // `isMention` is what separates 'mentions' from 'none'; callers that cannot
    // know (a terse cross-channel nudge carries no body) pass false, which is
    // the quiet answer — see notifyOtherChannel.
    function alertsAllowed(channelName, isMention) {
        if (isDnd()) return false;
        const mode = channelAlertMode(channelName);
        if (mode === 'none') return false;
        if (mode === 'mentions') return !!isMention;
        return true;
    }

    function channelMuted(name) {
        return Array.isArray(settings.mutedChannels) && settings.mutedChannels.includes(name);
    }

    // True when the channel is anything other than fully alerting — this is what
    // dims the row and keeps it out of the taskbar badge, so 'mentions' looks
    // calm without looking dead.
    function channelQuieted(name) { return channelAlertMode(name) !== 'all'; }

    async function setChannelAlertMode(name, mode) {
        if (!ALERT_MODES.includes(mode)) return;
        const alerts = Object.assign({}, settings.channelAlerts || {});
        if (mode === 'all') delete alerts[name];
        else alerts[name] = mode;

        // Keep the legacy list in step for older builds and the website.
        const list = (settings.mutedChannels || []).filter((c) => c !== name);
        if (mode === 'none') list.push(name);

        await saveSettings({ channelAlerts: alerts, mutedChannels: list });
        renderChannels();
        renderMutedChannels();
    }

    function blockedMap() { return settings.blocked || {}; }
    function isBlocked(cid) { return !!(cid && blockedMap()[cid]); }

    // Local only: the board has no server-side block, so this hides their
    // messages here and silences them in voice. Nothing is sent anywhere.
    async function blockPerson(cid, name) {
        if (!cid || cid === settings.clientId) return;
        const who = name || 'this person';
        const ok = await askConfirm('Block ' + who + '?',
            'Their messages will be hidden and they will be silenced in voice, on this ' +
            'computer only. They are not told, and nothing is sent to the server.',
            'Block', true);
        if (!ok) return;

        const blocked = Object.assign({}, blockedMap());
        blocked[cid] = name || 'Someone';
        const muted = Object.assign({}, settings.localMuted || {});
        muted[cid] = true;
        await saveSettings({ blocked, localMuted: muted });
        if (voice) voice.setLocalMuted(cid, true);
        renderMessages();
        renderVoiceRoster();
        renderBlocked();
        toast('Blocked ' + who);
    }

    async function unblockPerson(cid) {
        const blocked = Object.assign({}, blockedMap());
        const name = blocked[cid];
        delete blocked[cid];
        const muted = Object.assign({}, settings.localMuted || {});
        delete muted[cid];
        await saveSettings({ blocked, localMuted: muted });
        if (voice) voice.setLocalMuted(cid, false);
        renderMessages();
        renderVoiceRoster();
        renderBlocked();
        toast('Unblocked ' + (name || 'them'));
    }

    // Everything you can do to a channel, in one place — reached by right-click
    // and by the bell on the row, so neither is the only way in.
    function openChannelMenu(name, x, y) {
        const mode = channelAlertMode(name);
        // Three radio-ish items rather than one toggle: the middle setting is
        // the whole point, and a toggle cannot express it. `check` marks the
        // active one so the menu shows the current state instead of an action
        // whose meaning depends on state you have to remember.
        openCtxMenu([
            { label: 'All messages', icon: 'bell', check: mode === 'all',
                onClick: () => setChannelAlertMode(name, 'all') },
            { label: 'Only @mentions', icon: 'at', check: mode === 'mentions',
                onClick: () => setChannelAlertMode(name, 'mentions') },
            { label: 'Nothing', icon: 'bell-off', check: mode === 'none',
                onClick: () => setChannelAlertMode(name, 'none') },
            // Reshaping a channel is admin-only server-side — deleting one drops
            // every message in it, its reactions and its attachments. Offering
            // the item to a member just produces a 403 toast.
            ...(isAdmin() ? [
                'sep',
                { label: 'Rename channel', icon: 'pencil', disabled: name === 'general',
                    onClick: () => { switchChannel(name).then(renameChannel); } },
                { label: 'Delete channel', icon: 'trash', danger: true, disabled: name === 'general',
                    onClick: () => { switchChannel(name).then(deleteChannel); } }
            ] : [])
        ], x, y);
    }

    $('channel-list').addEventListener('contextmenu', (e) => {
        const row = e.target.closest('.chan');
        if (!row) return;
        e.preventDefault();
        openChannelMenu(row.dataset.channel, e.clientX, e.clientY);
    });

    // ---------- settings modal --------------------------------------------

    let recordingPtt = false;

    async function openSettings() {
        settings = await L.settings.get();
        $('acct-members').hidden = !isAdmin();
        if (isAdmin()) renderMemberAdmin();
        $('set-name').value = settings.displayName || '';
        $('set-base').value = settings.baseUrl || '';
        $('set-mode').value = settings.voiceMode || 'open';
        $('set-ec').checked = settings.echoCancellation !== false;
        $('set-ns').checked = settings.noiseSuppression !== false;
        $('set-nsai').checked = !!settings.noiseSuppressionAI;
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
        $('set-mute-key').textContent = (await L.ptt.describe(settings.muteBinding)) || 'Click to set';
        $('set-deafen-key').textContent = (await L.ptt.describe(settings.deafenBinding)) || 'Click to set';
        $('row-ptt').style.display = settings.voiceMode === 'ptt' ? '' : 'none';

        // Account / notifications / appearance / privacy
        $('set-status').value = settings.status || '';
        $('set-dnd').checked = isDnd();
        $('set-theme').value = settings.theme || 'dark';
        $('set-density').value = settings.density || 'cozy';
        $('set-vad').value = String(vadValue());
        paintThreshold();
        paintVoicePane();
        renderAccountCard();
        renderMutedChannels();
        renderBlocked();
        // Refetched rather than drawn from cache: someone else may have added
        // one since this client booted, and Settings is where you'd look.
        loadCustomEmoji().then(renderEmojiAdmin);

        await populateDevices();
        refreshPttHint();
        if ($('set-search').value) {
            $('set-search').value = '';
            $('set-search').dispatchEvent(new Event('input'));
        }
        paintSettingsMe();
        paintVoicePane();
        if (showSettingsPane) showSettingsPane(null);
        $('settings').hidden = false;
        trapFocus($('settings'), { label: 'Settings', initial: $('settings-close') });
    }

    // Closing has to stop the mic test, whichever way it happens.
    function closeSettings() {
        stopMicTest();
        releaseFocus($('settings'));
        $('settings').hidden = true;
    }

    $('btn-settings').addEventListener('click', openSettings);
    $('settings-close').addEventListener('click', closeSettings);
    $('btn-open-logs').addEventListener('click', async () => {
        const ok = await L.app.openLogs();
        if (!ok) toast('No log folder yet', true);
    });

    // ---- account card ----
    function renderAccountCard() {
        const name = settings.displayName || 'Anonymous';
        paintAvatarEl($('set-avatar'), name, myUserId());
        $('set-avatar-name').textContent = name;
        const sub = $('set-avatar-status');
        sub.textContent = settings.status || '';
        sub.hidden = !settings.status;

        syncAvatarButtons();
        $('acct-signed').hidden = !account;
        $('acct-forms').hidden = !!account;
        // Both sub-panels belong to a state that has just ended: a stray verify
        // form under a signed-in account, or — worse — the PREVIOUS account's
        // TOTP secret still on screen for the next person who signs in.
        $('acct-verify').hidden = true;
        $('acct-2fa-setup').hidden = true;
        $('acct-2fa-secret').textContent = '';
        if (account) {
            $('acct-user').textContent = account.username;
            $('acct-role').textContent = (account.role === 'admin' ? '(admin)' : '') +
                (account.totp ? ' · 2FA on' : '');
            $('btn-acct-2fa').textContent = account.totp ? 'Turn off 2FA' : 'Enable 2FA';
        }
    }

    // ---- profile picture ----
    // 512 KB, matching the server. Checked here too so an obviously-too-big
    // photo is refused instantly rather than after a base64 round trip.
    const AVATAR_MAX_BYTES = 512 * 1024;

    function avatarHint(msg, isErr) {
        const el = $('avatar-hint');
        if (!el) return;
        if (!avatarHint.def) avatarHint.def = el.textContent;
        el.textContent = msg || avatarHint.def;
        el.classList.toggle('err', !!(msg && isErr));
    }

    function syncAvatarButtons() {
        const clear = $('btn-avatar-clear');
        if (clear) clear.hidden = !avatarSrc(myUserId());
    }

    // Applies the server's answer to the one map everything else reads, then
    // repaints every surface that draws a face.
    function adoptMyAvatar(key) {
        const uid = myUserId();
        if (uid) {
            if (key) avatarMap[uid] = key; else delete avatarMap[uid];
        }
        if (account) account.avatar = key || null;
        repaintAvatars();
        syncAvatarButtons();
    }

    $('btn-avatar-pick').addEventListener('click', () => $('avatar-input').click());

    $('avatar-input').addEventListener('change', async (e) => {
        const file = (e.target.files || [])[0];
        e.target.value = '';                       // allow re-picking the same file
        if (!file) return;
        if (file.size > AVATAR_MAX_BYTES) {
            return avatarHint(`That image is ${fmtSize(file.size)} — 512 KB is the limit.`, true);
        }
        avatarHint('Uploading…');
        $('btn-avatar-pick').disabled = true;
        try {
            const b64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
            const res = await L.board('account/avatar', { method: 'POST', body: { dataBase64: b64 } });
            if (authGone(res)) return;
            if (!res || !res.success) return avatarHint((res && res.error) || 'Could not set that image.', true);
            adoptMyAvatar(res.avatar);
            avatarHint('');
            toast('Profile picture updated');
        } catch (err) {
            avatarHint('Could not read that image.', true);
        } finally {
            $('btn-avatar-pick').disabled = false;
        }
    });

    $('btn-avatar-clear').addEventListener('click', async () => {
        const btn = $('btn-avatar-clear');
        btn.disabled = true;
        try {
            const res = await L.board('account/avatar', { method: 'DELETE' });
            if (authGone(res)) return;
            if (!res || !res.success) return avatarHint((res && res.error) || 'Could not remove it.', true);
            adoptMyAvatar(null);
            avatarHint('');
            toast('Profile picture removed');
        } finally {
            btn.disabled = false;
        }
    });

    // ---- two-factor auth (TOTP) ----

    // The generator is fetched on demand — 2FA enrolment is the only thing that
    // has ever needed it, and most accounts never run it.
    async function drawQr(container, text) {
        container.innerHTML = '';
        container.textContent = 'Drawing QR code…';
        const gen = await window.ScarmLazy.qrcode();
        if (!gen) {
            container.textContent = 'Could not load the QR generator — use the key below.';
            return;
        }
        try {
            // Type 0 = auto-size for the payload; 'M' error correction.
            const qr = gen(0, 'M');
            qr.addData(text);
            qr.make();
            container.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 8, scalable: true });
        } catch (e) {
            container.textContent = 'Could not draw the QR code — use the key below.';
        }
    }

    async function start2faSetup() {
        // The server re-authenticates with the password before it will bind a
        // new authenticator — a session token alone must not be enough to lock
        // the real owner out of their own account.
        const pw = await openDialog({
            title: 'Confirm your password',
            message: 'Enter your account password to set up two-factor authentication.',
            ok: 'Continue', withInput: true
        });
        if (pw === null || pw === false) return;
        const res = await L.board('account/twofactor', { method: 'POST', body: { action: 'setup', password: String(pw) } });
        if (!res || !res.success) return toast((res && res.error) || 'Could not start 2FA setup', true);
        // A success without the payload would paint the literal word "undefined"
        // as the key someone is about to type into their authenticator.
        if (!res.secret || !res.otpauth) return toast('2FA setup came back incomplete — try again', true);
        $('acct-2fa-secret').textContent = res.secret;
        drawQr($('acct-2fa-qr'), res.otpauth);
        $('acct-2fa-setup').hidden = false;
        $('acct-2fa-code').value = '';
        $('acct-2fa-code').focus();
    }

    $('btn-acct-2fa').addEventListener('click', async () => {
        if (!account) return;
        if (!account.totp) return start2faSetup();
        // Turning it off needs BOTH a live code and the password, so neither a
        // borrowed session nor a glimpsed code is enough on its own.
        const code = await openDialog({
            title: 'Turn off two-factor?',
            message: 'Enter a current code from your authenticator app to confirm.',
            ok: 'Next', withInput: true, danger: true
        });
        if (code === null || code === false) return;
        const pw = await openDialog({
            title: 'Confirm your password',
            message: 'Enter your account password to turn two-factor off.',
            ok: 'Turn off', withInput: true, danger: true
        });
        if (pw === null || pw === false) return;
        const res = await L.board('account/twofactor', {
            method: 'POST', body: { action: 'disable', code: String(code).trim(), password: String(pw) }
        });
        if (!res || !res.success) return toast((res && res.error) || 'Could not turn 2FA off', true);
        account.totp = false;
        renderAccountCard();
        toast('Two-factor authentication is off');
    });

    $('btn-acct-2fa-confirm').addEventListener('click', async () => {
        const code = $('acct-2fa-code').value.trim();
        if (!/^\d{6}$/.test(code)) return toast('Enter the 6-digit code from your app', true);
        const res = await L.board('account/twofactor', { method: 'POST', body: { action: 'enable', code } });
        if (!res || !res.success) return toast((res && res.error) || 'Could not turn 2FA on', true);
        account.totp = true;
        $('acct-2fa-setup').hidden = true;
        renderAccountCard();
        toast('Two-factor authentication is on — you\'ll need your app to sign in');
    });
    $('btn-acct-2fa-cancel').addEventListener('click', () => { $('acct-2fa-setup').hidden = true; });

    // ---- board account (username + role on top of the shared password) ----

    let account = null;               // { id, username, role } | null
    const isAdmin = () => !!(account && account.role === 'admin');

    // Did I write this post? Mirrors the author half of _authz.js mayModifyPost
    // on the server, and has to stay mirrored: the affordance and the rule that
    // enforces it disagreeing is how you end up with an Edit button that 403s.
    //
    // Authorship is posts.user_id. It is NOT client_id — that is published with
    // every post in the listing, so it identifies an install to everyone rather
    // than proving anything, and it used to be what this test asked. Rows
    // written before accounts existed carry no user_id and no way to recover
    // one, so the server reserves them for admins; their real author sees no
    // Edit button rather than one that cannot work. (Admins still get the
    // separate "Delete (admin)" entry on anything that isn't theirs.)
    function ownsPost(p) {
        return !!(p && p.user_id && account && p.user_id === account.id);
    }

    // "Did I write this?" — the cosmetic question, as opposed to ownsPost's
    // "may I change this". Broader on purpose: a message you sent from the web
    // board or another install is still yours, so it must not chime at you or
    // count as unread here. `settings.clientId` alone answered no to all of
    // those, because a client_id is per-install and the server hands out a
    // fresh one when the id a device holds already belongs to someone else.
    function wroteByMe(p) {
        if (!p) return false;
        if (p.user_id && account) return p.user_id === account.id;
        return p.client_id === settings.clientId;
    }

    async function refreshAccount() {
        try {
            const res = await L.account.me();
            account = (res && res.success && res.user) || null;
        } catch (e) {
            account = null;
        }
        renderAccountCard();
        renderDmSection();
        // The role decides which channel controls exist, and this is the point
        // it becomes known — enterApp() renders the shell before it resolves.
        renderMe();
    }

    // Signing in mid-session: the socket was opened without an account, so
    // reopen it to pick up the identity that merges this device with the others.
    async function rebindRealtime() {
        try { await L.rt.stop(); await L.rt.start(); } catch (e) { /* it will retry on its own */ }
    }

    function acctError(msg) {
        const el = $('acct-error');
        el.textContent = msg || '';
        el.hidden = !msg;
    }

    async function acctSubmit(mode) {
        const username = $('acct-username').value.trim();
        const password = $('acct-password').value;
        const email = $('acct-email').value.trim();
        if (!username || !password) return acctError('Enter a username and password.');
        if (mode === 'register' && !email) return acctError('Enter your email — new accounts must verify one.');
        acctError('');
        const res = mode === 'register'
            ? await L.account.register(username, password, email)
            : await L.account.login(username, password);
        if (res && (res.pendingVerification || res.needsVerify)) {
            pendingVerifyUser = res.username || username;
            $('acct-verify').hidden = false;
            acctError('Check your email for the 6-digit code, then enter it above.');
            $('acct-code').focus();
            return;
        }
        if (!res || !res.success) return acctError((res && res.error) || 'Could not sign in.');
        account = res.user;
        $('acct-password').value = '';
        renderAccountCard();
        renderDmSection();
        rebindRealtime();
        loadDmThreads();
        toast(mode === 'register'
            ? `Account created — welcome, ${account.username}` +
              (account.role === 'admin' ? '. You are the admin.' : '')
            : `Signed in as ${account.username}`);
    }

    // ---- member management (admin only) --------------------------------
    // Lives in Settings > Account. Every action round-trips through
    // /api/board/account/manage, which re-checks the admin role server-side.

    async function manageMember(body, confirmText) {
        if (confirmText) {
            const ok = await askConfirm(confirmText.title, confirmText.message, confirmText.ok, confirmText.danger);
            if (!ok) return;
        }
        const res = await L.board('account/manage', { method: 'POST', body });
        if (!res || !res.success) return toast((res && res.error) || 'Could not update that member', true);
        toast('Done');
        renderMemberAdmin();
    }

    async function renderMemberAdmin() {
        const box = $('member-admin-list');
        box.textContent = 'Loading…';
        const res = await L.board('account/users');
        if (!res || !res.success) { box.textContent = (res && res.error) || 'Could not load members.'; return; }
        box.innerHTML = '';

        const others = (res.users || []).filter((u) => !account || u.id !== account.id);
        if (!others.length) {
            box.textContent = 'No other members yet — accounts show up here as people register.';
            return;
        }

        others.forEach((u) => {
            const row = document.createElement('div');
            row.className = 'ma-row' + (u.banned ? ' banned' : '');

            const who = document.createElement('span');
            who.className = 'ma-who';
            who.innerHTML = `<b>${esc(u.username)}</b>` +
                `<em class="hint">${u.role === 'admin' ? 'admin' : 'member'}${u.banned ? ' · banned' : ''}</em>`;
            row.appendChild(who);

            const btn = (label, danger, fn) => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'keycap' + (danger ? ' danger' : '');
                b.textContent = label;
                b.addEventListener('click', fn);
                row.appendChild(b);
            };

            btn(u.role === 'admin' ? 'Make member' : 'Make admin', false, () =>
                manageMember({ action: 'setRole', userId: u.id, role: u.role === 'admin' ? 'member' : 'admin' },
                    u.role === 'admin' ? null : {
                        title: `Make ${u.username} an admin?`,
                        message: 'Admins can delete and pin anyone\'s messages and manage members — including you.',
                        ok: 'Make admin'
                    }));

            btn(u.banned ? 'Unban' : 'Ban', !u.banned, () =>
                manageMember({ action: u.banned ? 'unban' : 'ban', userId: u.id },
                    u.banned ? null : {
                        title: `Ban ${u.username}?`,
                        message: 'They are signed out everywhere immediately and cannot sign back in until unbanned.',
                        ok: 'Ban', danger: true
                    }));

            btn('Reset password', false, async () => {
                const pw = await openDialog({
                    title: `New password for ${u.username}`,
                    message: 'They are signed out everywhere and sign back in with this. Tell them privately.',
                    ok: 'Reset', withInput: true
                });
                if (pw === null || pw === false) return;
                if (String(pw).length < 8) return toast('Password must be at least 8 characters', true);
                manageMember({ action: 'resetPassword', userId: u.id, password: String(pw) });
            });

            // The only way back from a lost authenticator: disabling 2FA
            // normally requires a current code, which is exactly what they
            // no longer have.
            btn('Clear 2FA', false, () =>
                manageMember({ action: 'clearTotp', userId: u.id }, {
                    title: `Clear two-factor for ${u.username}?`,
                    message: 'Use this when they have lost their authenticator. They are signed out everywhere and can sign in with just their password afterwards.',
                    ok: 'Clear 2FA'
                }));

            btn('Delete', true, () =>
                manageMember({ action: 'delete', userId: u.id }, {
                    title: `Delete ${u.username}'s account?`,
                    message: 'Their account and direct messages are removed permanently. Board messages they posted stay.',
                    ok: 'Delete', danger: true
                }));

            box.appendChild(row);
        });
    }

    $('btn-acct-login').addEventListener('click', () => acctSubmit('login'));
    $('btn-acct-register').addEventListener('click', () => acctSubmit('register'));
    $('btn-acct-verify').addEventListener('click', async () => {
        const code = $('acct-code').value.trim();
        if (!/^\d{6}$/.test(code)) return acctError('Enter the 6-digit code from the email.');
        const res = await L.account.verify(pendingVerifyUser, code);
        if (!res || !res.success) return acctError((res && res.error) || 'Could not verify.');
        account = res.user;
        pendingVerifyUser = null;
        $('acct-verify').hidden = true;
        $('acct-code').value = '';
        $('acct-password').value = '';
        acctError('');
        renderAccountCard();
        renderDmSection();
        rebindRealtime();
        loadDmThreads();
        toast('Account verified — signed in as ' + account.username);
    });
    $('btn-acct-resend').addEventListener('click', async () => {
        const res = await L.account.resend(pendingVerifyUser);
        acctError((res && res.success) ? 'Code sent — check your email.' : ((res && res.error) || 'Could not resend.'));
    });
    $('acct-password').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); acctSubmit('login'); }
    });
    $('btn-acct-logout').addEventListener('click', async () => {
        await teardownSession();
        await L.account.logout();
        account = null;
        dmThreads = [];
        closeDm();
        renderAccountCard();
        renderDmSection();
        // Accounts are mandatory: without one, back to the gate (the board
        // session itself stays valid, so it's a one-field hop back in).
        closeSettings();
        $('app').hidden = true;
        showAccountStep();
        toast('Signed out of your board account');
    });

    // ---- muted channels ----
    function renderMutedChannels() {
        const box = $('set-muted-channels');
        box.innerHTML = '';
        if (!channels.length) {
            box.innerHTML = '<span class="hint">No channels loaded yet.</span>';
            return;
        }
        channels.forEach((c) => {
            const mode = channelAlertMode(c.name);
            const row = document.createElement('div');
            row.className = 'chan-mute';
            // The icon tracks the level, so the list is readable at a glance
            // without parsing three dropdowns.
            row.innerHTML = I(mode === 'all' ? 'bell' : mode === 'mentions' ? 'at' : 'bell-off', 'ico') +
                `<span>#${esc(c.name)}</span>`;
            const sel = document.createElement('select');
            [['all', 'All messages'], ['mentions', 'Only @mentions'], ['none', 'Nothing']]
                .forEach(([v, label]) => {
                    const o = document.createElement('option');
                    o.value = v; o.textContent = label;
                    if (v === mode) o.selected = true;
                    sel.appendChild(o);
                });
            sel.addEventListener('change', () => setChannelAlertMode(c.name, sel.value));
            row.appendChild(sel);
            box.appendChild(row);
        });
    }

    // ---------- soundboard --------------------------------------------------
    // The engine lives in soundboard.js (it has to patch getUserMedia before the
    // SDK loads); this is only the tray.

    let soundboardBuilt = false;

    function buildSoundboard() {
        if (soundboardBuilt) return;
        soundboardBuilt = true;
        const grid = $('sb-grid');
        window.ScarmBoard.sounds().forEach((s) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'sb-btn';
            b.textContent = s.label;
            b.title = s.label;
            b.addEventListener('click', async () => {
                // Flashed immediately rather than on success: the fetch+decode
                // of a first play is long enough that an unacknowledged click
                // reads as a dead button and gets pressed again.
                b.classList.add('playing');
                setTimeout(() => b.classList.remove('playing'), 350);
                const ok = await window.ScarmBoard.play(s.id);
                if (!ok) toast('Could not play ' + s.label, true);
            });
            grid.appendChild(b);
        });
    }

    function closeSoundboard() { $('soundboard').hidden = true; }

    $('btn-soundboard').addEventListener('click', () => {
        const el = $('soundboard');
        if (!el.hidden) { closeSoundboard(); return; }
        buildSoundboard();
        window.ScarmBoard.setBaseUrl(settings.baseUrl);
        const vol = settings.soundboardVolume === undefined ? 0.8 : Number(settings.soundboardVolume);
        window.ScarmBoard.setVolume(vol);
        $('sb-volume').value = String(Math.round(vol * 100));
        el.hidden = false;
    });

    $('sb-volume').addEventListener('input', async (e) => {
        const v = Number(e.target.value) / 100;
        window.ScarmBoard.setVolume(v);
        await saveSettings({ soundboardVolume: v });
    });

    $('sb-stop').addEventListener('click', () => window.ScarmBoard.stopAll());

    document.addEventListener('mousedown', (e) => {
        if ($('soundboard').hidden) return;
        if (!e.target.closest('#soundboard') && !e.target.closest('#btn-soundboard')) closeSoundboard();
    });

    // ---- custom emoji admin ----
    // Anyone may add; you may remove your own, an admin may remove any. The
    // server enforces both — this only decides what to draw.

    const EMOJI_MAX_BYTES = 256 * 1024;

    function renderEmojiAdmin() {
        const box = $('set-emoji');
        if (!box) return;
        box.innerHTML = '';
        if (!customEmoji.size) {
            box.innerHTML = '<span class="hint">No custom emoji yet — add one below.</span>';
            return;
        }
        customEmoji.forEach((em) => {
            const row = document.createElement('div');
            row.className = 'emoji-row';
            row.appendChild(emojiImg(em, true));

            const nm = document.createElement('span');
            nm.className = 'emoji-row-name';
            nm.textContent = ':' + em.name + ':';
            row.appendChild(nm);

            const by = document.createElement('span');
            by.className = 'emoji-row-by';
            by.textContent = em.created_by ? 'by ' + em.created_by : '';
            row.appendChild(by);

            const mine = !!(account && em.user_id && em.user_id === account.id);
            if (mine || isAdmin()) {
                const del = document.createElement('button');
                del.type = 'button';
                del.className = 'icon-btn danger';
                del.title = 'Remove :' + em.name + ':';
                del.innerHTML = I('trash', 'ico');
                del.addEventListener('click', () => removeCustomEmoji(em.name));
                row.appendChild(del);
            }
            box.appendChild(row);
        });
    }

    async function removeCustomEmoji(name) {
        const ok = await askConfirm('Remove :' + name + '?',
            'Messages that already use it will show :' + name + ': as text.', 'Remove', true);
        if (!ok) return;
        // `query`, not a hand-built string: boardpath.js rejects a path
        // carrying anything but lowercase words and slashes.
        const res = await L.board('emoji', { method: 'DELETE', query: { name } });
        if (authGone(res)) return;
        if (!res || !res.success) return toast((res && res.error) || 'Could not remove it', true);
        customEmoji.delete(name);
        renderEmojiAdmin();
        renderMessages();
        toast('Removed :' + name + ':');
    }

    $('set-emoji-add').addEventListener('click', () => {
        const name = ($('set-emoji-name').value || '').trim().toLowerCase();
        // Checked before the file dialog rather than after: picking an image and
        // only then being told the name is wrong wastes the whole interaction.
        if (!/^[a-z0-9_]{2,32}$/.test(name)) {
            return toast('Give it a name first — 2–32 letters, numbers or _', true);
        }
        if (customEmoji.has(name)) return toast(':' + name + ': already exists', true);
        $('emoji-input').click();
    });

    $('emoji-input').addEventListener('change', async (e) => {
        const file = (e.target.files || [])[0];
        e.target.value = '';                  // allow re-picking the same file
        if (!file) return;
        const name = ($('set-emoji-name').value || '').trim().toLowerCase();
        if (!/^[a-z0-9_]{2,32}$/.test(name)) return;

        if (file.size > EMOJI_MAX_BYTES) {
            return toast('That image is too big — 256 KB max', true);
        }
        let b64;
        try {
            b64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
        } catch (err) {
            return toast('Could not read that image', true);
        }

        const res = await L.board('emoji', { method: 'POST', body: { name, dataBase64: b64 } });
        if (authGone(res)) return;
        if (!res || !res.success) return toast((res && res.error) || 'Could not add it', true);

        // Through L.fileUrl, exactly as loadCustomEmoji does. The server's `url`
        // is site-relative (/api/board/file?key=…), which is right for the
        // website and meaningless here — this renderer's origin is the app
        // bundle, so a relative path resolves to file:///api/board/file… and the
        // emoji you just added rendered as a broken image everywhere (the admin
        // list, the picker, any message using it) until Settings was reopened.
        customEmoji.set(res.emoji.name, Object.assign({}, res.emoji, { url: L.fileUrl(res.emoji.key) }));
        $('set-emoji-name').value = '';
        renderEmojiAdmin();
        renderMessages();
        toast('Added :' + res.emoji.name + ':');
    });

    // Chunked so a 256 KB image can't blow the argument limit of String
    // .fromCharCode the way `apply(null, wholeArray)` does.
    function bytesToBase64(bytes) {
        let bin = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        return btoa(bin);
    }

    // ---- blocked people ----
    function renderBlocked() {
        const box = $('set-blocked');
        box.innerHTML = '';
        const entries = Object.entries(blockedMap());
        if (!entries.length) {
            box.innerHTML = '<span class="hint">You haven\'t blocked anyone.</span>';
            return;
        }
        entries.forEach(([cid, name]) => {
            const row = document.createElement('div');
            row.className = 'blocked-row';
            row.innerHTML =
                `<span class="av" style="${avatarStyle(name)}">${esc(initials(name))}</span>` +
                `<span class="blocked-name">${esc(name)}</span>` +
                '<button type="button" class="keycap">Unblock</button>';
            row.querySelector('button').addEventListener('click', () => unblockPerson(cid));
            box.appendChild(row);
        });
    }

    // ---- microphone test + speaking threshold ----
    // The meter runs off its own short-lived capture, so it works whether or not
    // you are in a call and never touches the published track.

    let micTest = null;

    function vadValue() { return Number(settings.speakThreshold) || 6; }
    function vadRms() { return vadValue() / 100; }
    const METER_MAX = 0.3;      // full-scale RMS, shared by the bar and the marker

    function paintThreshold() {
        $('set-vad-val').textContent = String(vadValue());
        $('mic-meter-mark').style.left = Math.min(100, (vadRms() / METER_MAX) * 100) + '%';
    }

    function stopMicTest() {
        if (!micTest) return;
        micTest.off();
        micTest.meter.stop();
        try { micTest.stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
        micTest = null;
        $('btn-mic-test').textContent = 'Mic Test';
        $('btn-mic-test').classList.remove('recording');
        $('mic-meter-bar').style.width = '0%';
        $('mic-meter-bar').classList.remove('over');
    }

    async function startMicTest() {
        stopMicTest();
        const gen = sessionGen;
        let stream;
        try {
            // The SAME processing chain the call uses. Testing with plain
            // `{audio:true}` meant the meter saw browser defaults — AGC ON,
            // where the call runs AGC off by design — so the speaking threshold
            // was calibrated against a levelled signal and then applied to an
            // unlevelled one. Quiet talkers tested fine and went unheard.
            stream = await navigator.mediaDevices.getUserMedia(
                voice ? voice.micTestConstraints()
                    : { audio: settings.micDeviceId ? { deviceId: { exact: settings.micDeviceId } } : true });
        } catch (e) {
            toast(e && e.name === 'NotAllowedError'
                ? 'Microphone access is needed to test your mic'
                : 'Could not open the microphone', true);
            return;
        }
        // Same race as startRecording(): teardown's stopMicTest() is a no-op
        // while micTest is still null, so a session ending during the permission
        // prompt would leave this stream open behind the login gate.
        if (gen !== sessionGen) {
            try { stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
            return;
        }

        // Metered on the renderer's shared AudioContext (audio.js). Opening one
        // here used to compete with the per-participant analysers for Chromium's
        // six-context limit, so testing your mic during a call could break the
        // speaking indicators.
        const meter = window.ScarmAudio.createMeter(stream);
        if (!meter) {
            try { stream.getTracks().forEach((t) => t.stop()); } catch (e2) {}
            return toast('Could not read the microphone level', true);
        }

        const off = window.ScarmAudio.onTick(() => {
            if (!micTest) return;
            const rms = meter.rms();
            const bar = $('mic-meter-bar');
            bar.style.width = Math.min(100, (rms / METER_MAX) * 100).toFixed(1) + '%';
            bar.classList.toggle('over', rms >= vadRms());
        });

        micTest = { stream, meter, off };
        $('btn-mic-test').textContent = 'Stop Test';
        $('btn-mic-test').classList.add('recording');
    }

    $('btn-mic-test').addEventListener('click', () => {
        if (micTest) stopMicTest(); else startMicTest();
    });

    // Section nav down the left of the settings screen, built from the sections'
    // own markup so adding one needs no wiring here. One section is shown at a
    // time rather than all of them in a single scroll: the whole point of the
    // nav is that you can see where you are, which a scroll position cannot
    // tell you once a section is longer than the window.
    let showSettingsPane = null;

    // The section whose heading reads like this, for the callers that want to
    // land somewhere specific rather than on the first pane.
    // The identity block at the top of the settings nav.
    function paintSettingsMe() {
        const av = document.getElementById('set-me-av');
        if (!av) return;
        const name = settings.displayName || 'Anonymous';
        document.getElementById('set-me-name').textContent = name;
        paintAvatarEl(av, name, myUserId());
    }

    function settingsPaneByTitle(title) {
        return [...document.querySelectorAll('#settings-body .set-group')]
            .find((g) => {
                const h = g.querySelector('h3');
                return h && h.textContent.trim() === title;
            }) || null;
    }

    (function buildSettingsNav() {
        const modal = document.querySelector('#settings .modal');
        const body = $('settings-body');
        const nav = document.createElement('nav');
        nav.className = 'set-nav';
        const inner = document.createElement('div');
        inner.className = 'set-nav-in';
        nav.appendChild(inner);

        // Who you are, at the top of your own settings — and a way straight to
        // the pane that changes it.
        const me = document.createElement('button');
        me.type = 'button';
        me.className = 'set-me';
        me.id = 'set-me';
        me.innerHTML =
            '<span class="set-me-av" id="set-me-av"></span>' +
            '<span class="set-me-text">' +
            '<span class="set-me-name" id="set-me-name">Anonymous</span>' +
            '<span class="set-me-sub">Edit Profile' + I('pencil') + '</span>' +
            '</span>';
        me.addEventListener('click', () => showPane(settingsPaneByTitle('Account')));
        inner.appendChild(me);

        const searchWrap = document.createElement('div');
        searchWrap.className = 'set-search-wrap';
        searchWrap.innerHTML = I('search');

        const search = document.createElement('input');
        search.type = 'search';
        search.id = 'set-search';
        search.className = 'set-search';
        search.placeholder = 'Search';
        search.setAttribute('aria-label', 'Search settings');
        searchWrap.appendChild(search);
        inner.appendChild(searchWrap);

        // Grouped by data-nav-group, in the order each group is FIRST mentioned,
        // so the divider order is decided by the markup and not by a second list
        // here that could drift away from it.
        const order = [];
        const byGroup = new Map();
        body.querySelectorAll('.set-group').forEach((g) => {
            const h = g.querySelector('h3');
            if (!h) return;                      // a section with no heading is not a destination
            const key = g.dataset.navGroup || '';
            if (!byGroup.has(key)) { byGroup.set(key, []); order.push(key); }
            byGroup.get(key).push({ g, h });
        });

        const items = [];
        const heads = [];

        order.forEach((key) => {
            let head = null;
            if (key) {
                head = document.createElement('div');
                head.className = 'set-nav-head';
                head.textContent = key;
                inner.appendChild(head);
            }
            const mine = [];
            byGroup.get(key).forEach(({ g, h }) => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'set-nav-item';
                if (g.dataset.navIcon) {
                    const ic = document.createElement('span');
                    ic.className = 'ico';
                    ic.dataset.icon = g.dataset.navIcon;
                    b.appendChild(ic);
                }
                const label = document.createElement('span');
                label.className = 'set-nav-label';
                label.textContent = h.textContent;
                b.appendChild(label);
                b.addEventListener('click', () => showPane(g));
                inner.appendChild(b);
                const it = { g, b, key: (h.textContent + ' ' + g.textContent).toLowerCase() };
                items.push(it);
                mine.push(it);
            });
            if (head) heads.push({ head, mine });
        });

        window.ScarmIcons.hydrate(nav);
        // Painted here as well as on open: the nav is built once, and the panel
        // has to be right the first time it is shown.
        paintSettingsMe();
        modal.insertBefore(nav, modal.firstChild);

        // The section that owns the mic meter. Leaving it has to release the
        // capture, or the mic light stays on while you read About.
        const voiceGroup = $('btn-mic-test') && $('btn-mic-test').closest('.set-group');

        function showPane(g) {
            const target = g || (items[0] && items[0].g);
            if (!target) return;
            if (micTest && target !== voiceGroup) stopMicTest();
            items.forEach((it) => {
                it.g.hidden = it.g !== target;
                it.b.classList.toggle('on', it.g === target);
            });
            const h = target.querySelector('h3');
            $('settings-title').textContent = h ? h.textContent : 'Settings';
            body.scrollTop = 0;
        }

        search.addEventListener('input', () => {
            const q = search.value.trim().toLowerCase();
            let first = null;
            items.forEach((it) => {
                // Matched against the section's whole text, not just its title:
                // "tray" should find Behaviour without anyone having to know
                // which section the tray toggle lives in.
                const hit = !q || it.key.indexOf(q) >= 0;
                it.b.hidden = !hit;
                if (hit && !first) first = it;
            });
            // A divider with nothing under it is worse than no divider.
            heads.forEach((h) => { h.head.hidden = !h.mine.some((it) => !it.b.hidden); });
            if (q && first) showPane(first.g);
        });
        // Esc inside the box clears the filter; only an empty box closes the
        // screen, which is the same bargain every other search field makes.
        search.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && search.value) {
                e.stopPropagation();
                search.value = '';
                search.dispatchEvent(new Event('input'));
            }
        });

        showSettingsPane = showPane;
        showPane(null);
    })();

    // ---- new settings controls ----
    $('set-status').addEventListener('change', async (e) => {
        await saveSettings({ status: e.target.value.trim().slice(0, 80) });
        renderMe();
        renderAccountCard();
        sendTextPresence(false);        // publish it now rather than up to 20s later
    });
    $('set-dnd').addEventListener('change', async (e) => {
        // Through setPresenceMode, so the checkbox and the account panel's
        // picker can never end up saying different things. Unticking returns to
        // Online rather than to whatever override was set before — the checkbox
        // has no way to express "back to Idle", so it must not pretend to.
        await setPresenceMode(e.target.checked ? 'dnd' : 'online');
        toast(e.target.checked ? 'Do not disturb on — everything is silenced' : 'Do not disturb off');
    });
    $('set-theme').addEventListener('change', async (e) => {
        await saveSettings({ theme: e.target.value });
        applyTheme();
    });
    $('set-density').addEventListener('change', async (e) => {
        await saveSettings({ density: e.target.value });
        applyDensity();
        // Density is part of every row's signature, so the diff rebuilds the
        // affected messages on its own — no cache to invalidate.
        renderMessages();
    });
    $('set-vad').addEventListener('input', async (e) => {
        await saveSettings({ speakThreshold: Number(e.target.value) });
        if (voice) voice.setSettings(settings);
        paintThreshold();
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

    // #set-name is readonly: the display name IS the account username, so there
    // is nothing to listen for. It stays in the sheet because that is where
    // people look for their name — it just shows rather than asks.
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
    // The radios, the switch and the fold — the pane's own controls.
    document.querySelectorAll('#set-profile input[type="radio"]').forEach((r) => {
        r.addEventListener('change', () => {
            if (!r.checked) return;
            // Custom keeps whatever the individual filters already say, so it
            // only has to stop forcing one of the other two.
            if (r.value === 'custom') return setInputProfile('standard');
            setInputProfile(r.value === 'clear' ? 'ai' : 'off');
        });
    });

    $('set-ptt-toggle').addEventListener('click', async () => {
        const next = settings.voiceMode === 'ptt' ? 'open' : 'ptt';
        await saveSettings({ voiceMode: next });
        $('set-mode').value = next;
        if (voice) voice.setSettings(settings);
        paintVoicePane();
        paintAudioPanels();
    });

    $('set-voice-more').addEventListener('click', (e) => {
        const open = e.currentTarget.getAttribute('aria-expanded') !== 'true';
        e.currentTarget.setAttribute('aria-expanded', String(open));
        $('set-voice-advanced').hidden = !open;
    });

    // The pane's own microphone slider, the same setting the caret menu holds.
    $('set-invol').addEventListener('input', async (e) => {
        paintRangeFill(e.target);
        await saveSettings({ micVolume: Number(e.target.value) / 100 });
        paintAudioPanels();
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
    // The same setting the checkbox in Settings drives, reachable from the call
    // it affects — which is where anyone actually decides they want it.
    $('btn-nsai').addEventListener('click', async () => {
        const next = !settings.noiseSuppressionAI;
        await saveSettings({ noiseSuppressionAI: next });
        $('set-nsai').checked = next;
        window.ScarmNoise.setEnabled(next);
        $('btn-nsai').classList.toggle('on', next);
        setTip($('btn-nsai'), next ? 'Noise Suppression On' : 'Noise Suppression Off');
        if (voice.isJoined()) toast('Rejoin voice to apply AI noise suppression');
    });

    // The same setting the Voice & Audio dropdown drives, from the call it
    // changes. Two modes, so a button can express it where a dropdown could not
    // be reached without leaving the call.
    $('btn-ptt').addEventListener('click', async () => {
        const next = settings.voiceMode === 'ptt' ? 'open' : 'ptt';
        await saveSettings({ voiceMode: next });
        $('set-mode').value = next;
        $('row-ptt').style.display = next === 'ptt' ? '' : 'none';
        if (voice) voice.setSettings(settings);
        $('btn-ptt').classList.toggle('on', next === 'ptt');
        setTip($('btn-ptt'), next === 'ptt' ? 'Push to Talk On' : 'Push to Talk Off');
    });

    $('set-nsai').addEventListener('change', async (e) => {
        await saveSettings({ noiseSuppressionAI: e.target.checked });
        window.ScarmNoise.setEnabled(e.target.checked);
        if (voice.isJoined()) toast('Rejoin voice to apply AI noise suppression');
    });

    // RNNoise REPLACES the browser's own noise suppression rather than stacking
    // on it (voice.js switches that off while the AI toggle is on), so a failed
    // RNNoise means the mic runs with no suppression at all. Turning the toggle
    // back off is what restores the ordinary filter; leaving it on would keep
    // the user in the one state that is worse than either setting. Silent in the
    // console-only form this used to take: nothing on screen ever changed.
    async function handleNoiseFailure(why) {
        console.warn('[app] AI noise suppression is not running:', why);
        if (!settings.noiseSuppressionAI) return;
        await saveSettings({ noiseSuppressionAI: false });   // also re-pushes to voice.js
        window.ScarmNoise.setEnabled(false);
        $('set-nsai').checked = false;
        toast('AI noise suppression could not start — using standard noise suppression instead', true);
    }
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
        try {
            const s = await L.update.getState();
            updateStatusText(s);
            // Keep the notes entry point honest even if no state event has fired
            // since the last render.
            if (s) { updateState = s; $('btn-release-notes').hidden = !hasNotes(s); }
        } catch (e) {}
    }

    $('btn-release-notes').addEventListener('click', openNotes);
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

    // Hotkey recorder: captures the next key or mouse button pressed. Shared
    // by push-to-talk and the mute/deafen toggles — one recorder at a time,
    // guarded by the same recordingPtt flag the in-window PTT handlers respect.
    function bindKeyRecorder(btnId, settingKey, afterSave) {
        $(btnId).addEventListener('click', () => {
            if (recordingPtt) return;
            recordingPtt = true;
            const btn = $(btnId);
            btn.classList.add('recording');
            btn.textContent = 'Press any key…';

            const finish = async (binding, clear) => {
                recordingPtt = false;
                btn.classList.remove('recording');
                window.removeEventListener('keydown', onKey, true);
                window.removeEventListener('mousedown', onMouse, true);
                if (binding || clear) {
                    await saveSettings({ [settingKey]: binding });
                    await L.ptt.apply();
                }
                btn.textContent = (await L.ptt.describe(settings[settingKey])) || 'Click to set';
                if (afterSave) afterSave();
            };

            const onKey = (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (e.key === 'Escape') return finish(null, false);
                // Backspace/Delete clears the binding entirely (the toggles are
                // optional; PTT falls back to its default key).
                if (e.key === 'Backspace' || e.key === 'Delete') return finish(null, true);
                finish({
                    type: 'key', code: e.code,
                    ctrl: e.ctrlKey && !/^Control/.test(e.code),
                    shift: e.shiftKey && !/^Shift/.test(e.code),
                    alt: e.altKey && !/^Alt/.test(e.code),
                    meta: e.metaKey && !/^Meta|^OS/.test(e.code)
                });
            };
            const onMouse = (e) => {
                // Only the extra side buttons — hijacking left/right click would
                // make the app unusable.
                if (e.button < 3) return;
                e.preventDefault();
                e.stopPropagation();
                finish({ type: 'mouse', code: 'Mouse' + e.button, button: e.button + 1 });
            };
            window.addEventListener('keydown', onKey, true);
            window.addEventListener('mousedown', onMouse, true);
        });
    }
    bindKeyRecorder('set-ptt', 'pttBinding', refreshPttHint);
    bindKeyRecorder('set-mute-key', 'muteBinding');
    bindKeyRecorder('set-deafen-key', 'deafenBinding');

    $('btn-logout').addEventListener('click', async () => {
        await teardownSession();
        // "Sign out" means out of EVERYTHING — board session and account —
        // so the next sign-in walks both steps again.
        await L.account.logout();
        account = null;
        dmThreads = [];
        closeDm();
        await L.auth.logout();
        closeSettings();
        $('app').hidden = true;
        hideAccountStep();       // fresh sign-in starts at the password step
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
            `<div class="au-name" title="${esc(name || '')}">` + I('music', 'ico au-note') +
            `<span>${esc(name || 'audio')}</span></div>` +
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
            // Attribute, not property: these are <svg>, and `hidden` is an
            // HTMLElement thing. Setting the property here left the play
            // triangle showing for the whole track.
            icoPlay.toggleAttribute('hidden', playing);
            icoPause.toggleAttribute('hidden', !playing);
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
        // The row this player sits in can be rebuilt or removed out from under
        // us (message signature change, channel switch). The Audio element is
        // not in the DOM, so it would keep playing with no visible controls —
        // stop it as soon as its card is detached.
        audio.addEventListener('timeupdate', () => {
            if (!wrap.isConnected && !audio.paused) audio.pause();
        });
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
        // A range input only fires 'change' when the value actually moved, so
        // pressing the thumb without dragging left scrubbing stuck on and the
        // slider stopped tracking playback for the rest of this card's life.
        seek.addEventListener('pointerup', () => { scrubbing = false; });
        seek.addEventListener('pointercancel', () => { scrubbing = false; });
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

    // Where the last menu was opened, so an action that opens a popup of its own
    // (React…) can anchor it at the cursor after the menu has closed.
    let lastMenuAt = { x: 0, y: 0 };

    // items: [{ label, icon, danger, disabled, onClick } | 'sep']
    function openCtxMenu(items, x, y) {
        lastMenuAt = { x, y };
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
            b.className = 'ctx-item' + (it.danger ? ' danger' : '') + (it.check ? ' checked' : '');
            // `dot` is for the presence picker: the thing being chosen IS a
            // colour, so a line icon would say less than the swatch does.
            if (it.dot !== undefined) {
                b.innerHTML = `<i class="presence ctx-dot ${esc(it.dot)}"></i>` +
                    `<span class="ctx-label">${esc(it.label)}</span>` +
                    (it.check ? I('check', 'ico ctx-check') : '');
                if (it.check) b.setAttribute('aria-checked', 'true');
                if (it.disabled) b.disabled = true;
                else b.addEventListener('click', () => { closeCtxMenu(); it.onClick(); });
                menu.appendChild(b);
                return;
            }
            // it.icon is a name in the icon set, never a glyph.
            // A `check` item is one option of a set (per-channel alerts), so it
            // carries a tick on the trailing edge showing the current choice
            // rather than an action label that flips meaning.
            b.innerHTML = (it.icon ? I(it.icon, 'ico ctx-ico') : '<span class="ctx-ico"></span>') +
                `<span class="ctx-label">${esc(it.label)}</span>` +
                (it.check ? I('check', 'ico ctx-check') : '');
            if (it.check) b.setAttribute('aria-checked', 'true');
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
        const mine = ownsPost(p);
        // In a thread, "Reply" means the thread composer — quoting a reply back
        // into the same thread would just be noise.
        const inThread = !!el.closest('#thread-list');
        return [
            inThread
                ? { label: 'Reply', icon: 'reply', onClick: () => $('thread-input').focus() }
                : { label: 'Reply', icon: 'reply', onClick: () => setReplyTarget(p) },
            !inThread && { label: 'Reply in thread', icon: 'thread', onClick: () => openThread(p.id) },
            // Anchored at the cursor, since the menu itself is gone by then.
            { label: 'React…', icon: 'smile', onClick: () => openEmojiPicker(pointAnchor(lastMenuAt.x, lastMenuAt.y), (em) => react(p.id, em)) },
            'sep',
            { label: 'Copy text', icon: 'copy', onClick: () => copyMessage(p) },
            p.att_key && { label: 'Save attachment…', icon: 'download', onClick: () => saveAttachment(p.att_key, p.att_name) },
            { label: p.pinned ? 'Unpin' : 'Pin', icon: 'pin', onClick: () => pinPost(p.id, !p.pinned) },
            mine && 'sep',
            mine && { label: 'Edit message', icon: 'pencil', onClick: () => startEdit(p, el) },
            mine && { label: 'Delete message', icon: 'trash', danger: true, onClick: () => deletePost(p) },
            !mine && isAdmin() && 'sep',
            !mine && isAdmin() && { label: 'Delete (admin)', icon: 'trash', danger: true, onClick: () => deletePost(p) },
            !mine && p.client_id && 'sep',
            !mine && p.client_id && {
                label: 'Block ' + (p.name || 'this person'), icon: 'ban', danger: true,
                onClick: () => blockPerson(p.client_id, p.name)
            }
        ];
    }

    // ---------- emoji picker ------------------------------------------------
    // Same set and order as the website, so the reactions people pick match
    // across clients.

    const EMOJIS = {
        Smileys: ['😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇', '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😋', '😜', '🤪', '😎', '🤩', '🥳', '😏', '🙄', '😴', '🤔', '🤗', '🤭', '😬', '😭', '🥺'],
        Gestures: ['👍', '👎', '👏', '🙌', '👋', '🤝', '✊', '👊', '🤞', '✌️', '🤟', '👌', '🤌', '🙏', '💪', '👀', '🫶', '🤙'],
        Hearts: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💖', '💗', '💕', '💞', '💔', '❣️'],
        Fun: ['🔥', '✨', '🎉', '🚀', '💯', '⭐', '🌟', '💥', '⚡', '🌈', '🎯', '🏆', '🎈', '👑', '💎', '🍻', '🎮', '🍕'],
        Symbols: ['💬', '📌', '📎', '✅', '❌', '⚠️', '💡', '🔑', '🔒', '🔔', '➡️', '⬆️', '⭐']
    };

    // Search keywords. Without these the picker can only be browsed, which for a
    // grid this size means scanning every glyph to find the one you want.
    // Multiple words per emoji so both the obvious name and how people actually
    // refer to it will find it ("joy" and "crying laughing" both hit 😂).
    const EMOJI_WORDS = {
        '😀': 'grin smile happy', '😃': 'smile happy open', '😄': 'smile happy eyes',
        '😁': 'beam grin teeth', '😆': 'laugh squint haha', '😅': 'sweat laugh nervous',
        '😂': 'joy laugh crying tears lol', '🤣': 'rofl rolling laughing lmao',
        '😊': 'blush smile happy', '😇': 'angel halo innocent', '🙂': 'slight smile',
        '🙃': 'upside down silly', '😉': 'wink', '😌': 'relieved calm',
        '😍': 'heart eyes love', '🥰': 'love hearts adore', '😘': 'kiss blow love',
        '😋': 'yum tongue tasty', '😜': 'wink tongue silly', '🤪': 'zany crazy wild',
        '😎': 'cool sunglasses', '🤩': 'star struck excited wow', '🥳': 'party celebrate birthday',
        '😏': 'smirk sly', '🙄': 'eye roll annoyed', '😴': 'sleep tired zzz',
        '🤔': 'think hmm consider', '🤗': 'hug', '🤭': 'oops giggle hand',
        '😬': 'grimace awkward yikes', '😭': 'sob cry loudly', '🥺': 'pleading puppy eyes beg',

        '👍': 'thumbs up yes approve like ok', '👎': 'thumbs down no disapprove dislike',
        '👏': 'clap applause bravo', '🙌': 'raise hands praise celebrate', '👋': 'wave hello bye hi',
        '🤝': 'handshake deal agree', '✊': 'fist raised solidarity', '👊': 'fist bump punch',
        '🤞': 'fingers crossed luck hope', '✌️': 'peace victory two', '🤟': 'love you rock',
        '👌': 'ok perfect nice', '🤌': 'pinched chef italian', '🙏': 'pray thanks please',
        '💪': 'muscle strong flex', '👀': 'eyes look watching', '🫶': 'heart hands love',
        '🤙': 'call me shaka hang loose',

        '❤️': 'red heart love', '🧡': 'orange heart', '💛': 'yellow heart',
        '💚': 'green heart', '💙': 'blue heart', '💜': 'purple heart',
        '🖤': 'black heart', '🤍': 'white heart', '💖': 'sparkling heart',
        '💗': 'growing heart', '💕': 'two hearts love', '💞': 'revolving hearts',
        '💔': 'broken heart sad', '❣️': 'heart exclamation',

        '🔥': 'fire lit hot flame', '✨': 'sparkles shiny magic', '🎉': 'party popper celebrate congrats',
        '🚀': 'rocket launch ship fast', '💯': 'hundred perfect score', '⭐': 'star',
        '🌟': 'glowing star shine', '💥': 'boom explosion collision', '⚡': 'lightning bolt zap fast',
        '🌈': 'rainbow pride', '🎯': 'target bullseye direct hit', '🏆': 'trophy win award',
        '🎈': 'balloon party', '👑': 'crown king queen best', '💎': 'gem diamond',
        '🍻': 'beers cheers drink', '🎮': 'game controller gaming', '🍕': 'pizza food',

        '💬': 'speech bubble comment chat', '📌': 'pin pinned', '📎': 'paperclip attachment',
        '✅': 'check done yes tick complete', '❌': 'cross no wrong fail',
        '⚠️': 'warning caution alert', '💡': 'idea bulb light', '🔑': 'key access',
        '🔒': 'lock locked private secure', '🔔': 'bell notification alert',
        '➡️': 'right arrow next', '⬆️': 'up arrow'
    };

    // Recents are per-machine UI state, not a setting worth syncing, so they live
    // in localStorage next to the read markers.
    const EMOJI_RECENT_KEY = 'lounge_emoji_recent';
    const EMOJI_RECENT_MAX = 16;

    function recentEmojis() {
        try {
            const arr = JSON.parse(localStorage.getItem(EMOJI_RECENT_KEY) || '[]');
            return Array.isArray(arr) ? arr.filter((e) => typeof e === 'string').slice(0, EMOJI_RECENT_MAX) : [];
        } catch (e) { return []; }
    }

    function noteEmojiUsed(em) {
        const next = [em].concat(recentEmojis().filter((e) => e !== em)).slice(0, EMOJI_RECENT_MAX);
        try { localStorage.setItem(EMOJI_RECENT_KEY, JSON.stringify(next)); } catch (e) {}
    }

    // A stored recent is a token: a unicode glyph, or `:name:`. Resolves back to
    // what button() wants. A `:name:` whose emoji has since been deleted returns
    // null so it drops out of the row rather than rendering a broken image.
    function resolveEmojiToken(tok) {
        const m = /^:([a-z0-9_]{2,32}):$/.exec(String(tok || ''));
        if (!m) return tok || null;
        return customEmoji.get(m[1]) || null;
    }

    // Matches on the keywords above and, so an unlisted emoji is still findable,
    // on its category name. Custom emoji match on their name.
    function searchEmojis(query) {
        const q = String(query || '').trim().toLowerCase();
        if (!q) return null;
        const terms = q.split(/\s+/);
        const out = [];
        customEmoji.forEach((em) => {
            const hay = em.name + ' custom';
            if (terms.every((t) => hay.includes(t))) out.push(em);
        });
        Object.keys(EMOJIS).forEach((cat) => {
            EMOJIS[cat].forEach((em) => {
                const hay = (EMOJI_WORDS[em] || '') + ' ' + cat.toLowerCase();
                if (terms.every((t) => hay.includes(t))) out.push(em);
            });
        });
        return out;
    }

    let emojiPop = null;
    let emojiCb = null;

    // Lets a popup be positioned at a bare cursor position.
    function pointAnchor(x, y) {
        return { getBoundingClientRect: () => ({ top: y, bottom: y, left: x, right: x, width: 0, height: 0 }) };
    }

    function buildEmojiPop() {
        const pop = document.createElement('div');
        pop.className = 'emoji-pop';
        pop.hidden = true;

        const search = document.createElement('input');
        search.type = 'text';
        search.className = 'emoji-search';
        search.placeholder = 'Search emoji';
        search.setAttribute('aria-label', 'Search emoji');
        pop.appendChild(search);

        const grid = document.createElement('div');
        grid.className = 'emoji-grid';
        pop.appendChild(grid);

        // `em` is either a unicode glyph or a custom-emoji record. Both flow
        // through the same callback as a STRING — a glyph, or `:name:` — so
        // every consumer (composer insert, reaction) stays unchanged and the
        // stored reaction is portable to the website and phone.
        function button(em) {
            const b = document.createElement('button');
            b.type = 'button';
            const custom = typeof em !== 'string';
            const token = custom ? ':' + em.name + ':' : em;
            if (custom) {
                b.appendChild(emojiImg(em));
                b.title = token;
            } else {
                b.textContent = em;
                b.title = EMOJI_WORDS[em] ? EMOJI_WORDS[em].split(' ')[0] : '';
            }
            b.addEventListener('click', () => {
                const cb = emojiCb;
                noteEmojiUsed(token);
                closeEmojiPop();
                if (cb) cb(token);
            });
            return b;
        }

        function heading(text) {
            const c = document.createElement('div');
            c.className = 'emoji-cat';
            c.textContent = text;
            return c;
        }

        // Rebuilt on every keystroke. The whole set is ~110 glyphs, so this is
        // far cheaper than maintaining per-button visibility.
        function paint() {
            grid.innerHTML = '';
            const hits = searchEmojis(search.value);

            if (hits) {
                if (!hits.length) {
                    const none = document.createElement('div');
                    none.className = 'emoji-none';
                    none.textContent = 'No emoji match that';
                    grid.appendChild(none);
                    return;
                }
                grid.appendChild(heading('Results'));
                hits.forEach((em) => grid.appendChild(button(em)));
                return;
            }

            const recent = recentEmojis().map(resolveEmojiToken).filter(Boolean);
            if (recent.length) {
                grid.appendChild(heading('Frequently used'));
                recent.forEach((em) => grid.appendChild(button(em)));
            }
            // Custom first: it is the short, board-specific list people are
            // actually reaching for, and burying it under 110 unicode glyphs
            // would mean scrolling past everything to find it every time.
            if (customEmoji.size) {
                grid.appendChild(heading('Custom'));
                customEmoji.forEach((em) => grid.appendChild(button(em)));
            }
            Object.keys(EMOJIS).forEach((cat) => {
                grid.appendChild(heading(cat));
                EMOJIS[cat].forEach((em) => grid.appendChild(button(em)));
            });
        }

        search.addEventListener('input', paint);
        // Enter picks the first result, so a search can be completed without
        // reaching for the mouse.
        search.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const first = grid.querySelector('button');
            if (first) first.click();
        });

        pop.repaint = paint;
        pop.searchField = search;

        // Keep the composer's caret where it was when picking for insertion. The
        // search field is exempt: it has to be able to take focus to be typed in.
        pop.addEventListener('mousedown', (e) => {
            if (e.target !== search) e.preventDefault();
        });
        document.body.appendChild(pop);
        paint();
        return pop;
    }

    // Below the anchor, flipped above when there's no room.
    function positionPop(pop, anchor) {
        const r = anchor.getBoundingClientRect();
        pop.hidden = false;
        const w = pop.offsetWidth, h = pop.offsetHeight;
        let left = Math.min(r.left, window.innerWidth - w - 8);
        let top = r.bottom + 6;
        if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
        pop.style.left = Math.max(8, left) + 'px';
        pop.style.top = top + 'px';
    }

    function openEmojiPicker(anchor, cb) {
        if (!anchor) return;
        closeCtxMenu();
        if (!emojiPop) emojiPop = buildEmojiPop();
        emojiCb = cb;
        // Always opens clean: a leftover search from last time would hide the
        // recents row and look like the picker had lost most of its emoji.
        emojiPop.searchField.value = '';
        emojiPop.repaint();
        emojiPop.scrollTop = 0;
        positionPop(emojiPop, anchor);
        emojiPop.searchField.focus();
    }

    function closeEmojiPop() {
        if (emojiPop) emojiPop.hidden = true;
        emojiCb = null;
    }

    function emojiPopOpen() { return !!(emojiPop && !emojiPop.hidden); }

    // The picker's own scrollbar and its scrolling list are part of the picker,
    // so "outside" has to be measured against the element — including for scroll
    // events, whose target is the grid rather than a clicked node.
    function insideEmojiPop(node) {
        return !!(emojiPop && node && emojiPop.contains(node));
    }

    document.addEventListener('mousedown', (e) => {
        if (emojiPopOpen() && !insideEmojiPop(e.target)) closeEmojiPop();
    });

    // Dismiss when the PAGE scrolls, because the picker is positioned against an
    // anchor that has just moved out from under it.
    //
    // Scroll events do not bubble, but a capture listener on document still sees
    // every one of them — so this used to fire for the picker scrolling its own
    // emoji list and close it the instant you touched the wheel or the scrollbar.
    // Scrolls originating inside the picker are not the page moving.
    document.addEventListener('scroll', (e) => {
        if (!emojiPopOpen() || insideEmojiPop(e.target)) return;
        closeEmojiPop();
    }, true);

    // Whole-window blur only — the scrollbar never takes focus off the window.
    window.addEventListener('blur', closeEmojiPop);

    // ---------- links -------------------------------------------------------

    // Anything we might hand to the shell is parsed and scheme-checked first.
    // A message body is attacker-controlled, and openExternal on a file:// or a
    // registered custom protocol is a way to run code on this machine — so
    // anything that isn't plainly http(s) is not offered at all.
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
            { label: 'Open link', icon: 'external', onClick: () => L.app.openExternal(url) },
            { label: 'Copy link address', icon: 'link', onClick: () => copyLink(url) }
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
            { label: 'Copy image', icon: 'copy', onClick: () => copyImage(ref) },
            { label: 'Save image as…', icon: 'save', onClick: () => saveImageAs(ref) },
            { label: 'Download image', icon: 'download', onClick: () => downloadImage(ref) },
            link && 'sep',
            link && { label: 'Copy image link', icon: 'link', onClick: () => copyLink(link) }
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
        trapFocus($('lightbox'), { label: name ? 'Image: ' + name : 'Image viewer', initial: $('lb-close') });
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
        releaseFocus($('lightbox'));
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
    let editingRestore = null;   // the open editor's teardown, for cancelEdit()

    // Abandon an open editor from OUTSIDE its own closure. A channel switch or a
    // session teardown replaces everything the editor was anchored to, and
    // renderMessages() refuses to run while a .msg-edit node exists anywhere in
    // the document — so an orphaned one freezes the message list permanently.
    function cancelEdit() {
        const fn = editingRestore;
        editingRestore = null;
        editingId = null;
        if (!fn) return;
        // The node may already be detached (the thread list was cleared), in
        // which case there is nothing left to put back.
        try { fn(); } catch (e) { /* already gone */ }
    }

    function startEdit(p, el) {
        if (editingId) return;                       // one at a time
        const textEl = el.querySelector('.msg-text');
        if (!textEl) return;
        editingId = p.id;

        const wrap = document.createElement('div');
        wrap.className = 'msg-edit';
        wrap.innerHTML =
            '<textarea maxlength="2000"></textarea>' +
            '<div class="msg-edit-hint"><b>Enter</b> to save · <b>Esc</b> to cancel</div>';
        const ta = wrap.querySelector('textarea');
        ta.value = p.body || '';

        // HIDE the rendered body and put the editor beside it, rather than
        // stashing textEl.innerHTML and re-parsing it on cancel. innerHTML
        // round-trips the markup but not the LISTENERS renderBody attached, and
        // a spoiler's click-to-reveal is one of those — so cancelling an edit on
        // a message containing ||spoiler|| left it permanently unclickable
        // (renderMessages keeps the node, because the message itself never
        // changed). Keeping the original node keeps its behaviour. Same approach
        // the web board's editor uses.
        const prevDisplay = textEl.style.display;
        textEl.style.display = 'none';
        textEl.after(wrap);
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';

        const restore = () => {
            editingId = null;
            editingRestore = null;
            wrap.remove();                       // no-op if the row is already gone
            textEl.style.display = prevDisplay;
            renderMessages();      // resync anything the poll held back
        };
        editingRestore = restore;

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

            // restore(), NOT a bare state reset. Clearing editingRestore first
            // is what made this unrecoverable: relogin() calls teardownSession()
            // which calls cancelEdit(), and cancelEdit's whole job is to invoke
            // the handle this line had just thrown away. The .msg-edit node then
            // outlived the session with its textarea still disabled, and
            // renderMessages() bails whenever one exists — so the next session
            // opened onto a message list frozen at the moment the token expired.
            if (isAuthLoss(res)) { restore(); authGone(res); return; }
            if (!res || !res.success) {
                // Keep the editor open with their text intact so nothing is lost.
                ta.disabled = false;
                ta.focus();
                return toast((res && res.error) || 'Could not edit', true);
            }

            editingId = null;
            editingRestore = null;
            // The server stamps edited_at, so reload rather than guessing — that
            // makes the "(edited)" marker reflect real server state.
            await loadMessages(false);
            L.rt.notifyPosted(channel);
            toast('Message edited');
        });
    }

    async function deletePost(p) {
        if (!isAdmin() && !ownsPost(p)) return toast('You can only delete your own messages', true);

        const preview = (p.body || p.att_name || '').slice(0, 80);
        const ok = await askConfirm(
            'Delete this message?',
            preview ? `“${preview}${preview.length >= 80 ? '…' : ''}” will be permanently removed.`
                : 'This message will be permanently removed.',
            'Delete', true
        );
        if (!ok) return;

        // clientId lets the server enforce ownership for signed-in members.
        const res = await L.board('delete', { method: 'POST', body: { id: p.id, clientId: settings.clientId } });
        if (authGone(res)) return;
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

    // Bounded. Both are keyed by url / video id and the app can sit in the tray
    // for days, so without a cap they retain every link ever scrolled past —
    // title, description and thumbnail strings included. Map iteration is
    // insertion-ordered, so trimming from the front drops the oldest.
    const PREVIEW_CACHE_MAX = 400;
    const previewCache = new Map();
    const youtubeCache = new Map();

    function cachePut(map, key, value) {
        if (!map.has(key) && map.size >= PREVIEW_CACHE_MAX) {
            map.delete(map.keys().next().value);
        }
        map.set(key, value);
    }

    // A preview's image url comes from a page the poster chose, so it is no more
    // trustworthy than the message body. esc() stops it breaking out of the
    // attribute, but the url itself still has to be a real http(s) one: img-src
    // allows 'self', and on a file:// renderer that means a file:/// url here
    // would render a local file into the conversation.
    function safeImageSrc(u) {
        return window.ScarmLib.safeHttpUrl(u) ? u : '';
    }

    const isImageUrl = window.ScarmLib.isImageUrl;

    function youtubeCard(info) {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'yt-card';
        card.innerHTML =
            '<div class="yt-thumb">' +
            `<img src="${esc(safeImageSrc(info.thumbnail))}" alt="" loading="lazy">` +
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
            // Also the recovery path when the oEmbed thumbnail was rejected by
            // safeImageSrc and the src came through empty.
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
            (safeImageSrc(preview.image) ? `<img class="lc-thumb" src="${esc(preview.image)}" alt="" loading="lazy">` : '');
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

                cachePut(youtubeCache, vid, 'pending');
                L.youtube(vid).then((info) => {
                    cachePut(youtubeCache, vid, info || null);
                    if (info) graft(post.id, url, () => youtubeCard(info));
                }).catch(() => cachePut(youtubeCache, vid, null));
                return;
            }

            // A direct image link renders as the image itself — no round trip.
            if (isImageUrl(url)) {
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

            cachePut(previewCache, url, 'pending');
            L.unfurl(url).then((res) => {
                const preview = (res && res.success && res.preview) ? res.preview : null;
                cachePut(previewCache, url, preview);
                // Graft into the live node instead of re-rendering the list, so
                // the reader's scroll position is never disturbed.
                if (preview) graft(post.id, url, () => linkCard(preview));
            }).catch(() => cachePut(previewCache, url, null));
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
            hideSearchResults();
        }
    }

    function clearFilters() {
        filter.text = '';
        filter.types.clear();
        filter.pinned = filter.mentions = filter.edited = false;
        filter.from = filter.fromName = null;
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

    // [icon name, label] — icons resolve against the one icon set.
    const TYPE_LABELS = {
        links: ['link', 'Links'], images: ['image', 'Images'], videos: ['video', 'Videos'],
        audio: ['music', 'Audio'], files: ['paperclip', 'Files']
    };

    // Active filters as removable chips, plus a Clear all.
    function renderChips() {
        const box = $('filter-chips');
        box.innerHTML = '';
        const chips = [];
        filter.types.forEach((t) => {
            const d = TYPE_LABELS[t] || ['file', t];
            chips.push({ icon: d[0], label: d[1], off: () => filter.types.delete(t) });
        });
        if (filter.pinned) chips.push({ icon: 'pin', label: 'Pinned', off: () => { filter.pinned = false; } });
        if (filter.mentions) chips.push({ icon: 'at', label: 'Mentions me', off: () => { filter.mentions = false; } });
        if (filter.edited) chips.push({ icon: 'pencil', label: 'Edited', off: () => { filter.edited = false; } });
        if (filter.from) chips.push({ icon: 'users', label: 'From ' + (filter.fromName || 'user'), off: () => { filter.from = filter.fromName = null; const fs = $('filter-from'); if (fs) fs.value = ''; } });
        if (filter.text) chips.push({ icon: 'search', label: filter.text, off: () => { filter.text = ''; $('filter-input').value = ''; } });

        box.hidden = chips.length === 0;
        chips.forEach((c) => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'fb-chip';
            chip.innerHTML = (c.icon ? I(c.icon, 'ico chip-ico') : '') +
                '<span>' + esc(c.label) + '</span>' + I('x', 'ico fb-chip-x');
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
    // The people the "From" dropdown offers, keyed by the label it shows.
    // Rebuilt whenever the dropdown is populated; the SELECTED entry is held on
    // `filter.from`, so it survives a repopulate.
    let fromChoices = new Map();

    function populateFromSelect() {
        const sel = $('filter-from');
        if (!sel) return;
        // Group by display name — one person posting from two devices is still
        // one person — and collect the ACCOUNT ids seen under that name. The
        // option used to carry a list of client_ids instead, which is a list of
        // installs: it missed the person's other devices, missed rows written
        // before their install id was rotated, and skipped rows with no install
        // id at all (`if (!p.client_id) return`). See postFrom() in lib.js.
        const byLabel = new Map();
        posts.forEach((p) => {
            const name = p.name || 'Anonymous';
            const label = wroteByMe(p) ? 'You' : name;
            if (!byLabel.has(label)) byLabel.set(label, { label, names: new Set(), userIds: new Set() });
            const e = byLabel.get(label);
            e.names.add(name);
            if (p.user_id) e.userIds.add(p.user_id);
        });
        fromChoices = byLabel;

        // Repopulating must not silently drop a filter that is still applied —
        // the old code compared a joined id list, so one new install id for the
        // selected person reset the dropdown to "anyone" while the list stayed
        // filtered. The label is stable, so the selection survives.
        const cur = filter.from ? filter.from.label : '';
        sel.innerHTML = '<option value="">anyone</option>';
        [...byLabel.values()].sort((a, b) => a.label.localeCompare(b.label)).forEach((c) => {
            const o = document.createElement('option');
            o.value = c.label;
            o.textContent = c.label;
            sel.appendChild(o);
        });
        // A selected person whose messages are no longer loaded still belongs in
        // the list, or the filter and the dropdown disagree.
        if (cur && !byLabel.has(cur)) {
            const o = document.createElement('option');
            o.value = cur;
            o.textContent = cur;
            sel.appendChild(o);
            fromChoices.set(cur, filter.from);
        }
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
        const chosen = e.target.value ? fromChoices.get(e.target.value) : null;
        filter.from = chosen || null;
        filter.fromName = chosen ? chosen.label : null;
        applyFilter();
    });

    $('filter-input').addEventListener('input', () => {
        clearTimeout(filterTimer);
        filterTimer = setTimeout(() => {
            filter.text = $('filter-input').value.trim();
            applyFilter();
            runSearch(filter.text);      // the archive, not just what's loaded
        }, 200);
    });

    // ---------- archive search --------------------------------------------
    // The filter above narrows the messages already on screen; this asks the
    // server about everything ever posted, the same endpoint and scopes the
    // website uses. Both run off the one Ctrl+F box.

    let searchScope = 'channel';
    let searchSeq = 0;

    $('filter-scope').addEventListener('click', () => {
        searchScope = searchScope === 'channel' ? 'all' : 'channel';
        $('filter-scope').textContent = searchScope === 'all' ? 'All channels' : 'This channel';
        runSearch(filter.text);
    });

    function hideSearchResults() {
        // Invalidates any reply still in flight. Without this, clearing the box
        // (or closing the panel) left the previous query's seq current, so its
        // response passed the staleness check and re-opened the results panel
        // over an empty search.
        searchSeq++;
        $('search-results').hidden = true;
        $('search-results').innerHTML = '';
    }

    async function runSearch(q) {
        q = (q || '').trim();
        if (q.length < 2) { hideSearchResults(); return; }

        // Only the newest query gets to render — a slow reply must not overwrite
        // results for what's now in the box.
        const seq = ++searchSeq;
        const res = await L.board('search', {
            query: { q, channel, scope: searchScope, limit: 40 }
        });
        if (seq !== searchSeq) return;
        if (authGone(res)) return;
        if (!res || !res.success) { hideSearchResults(); return; }
        renderSearchResults(res.results || [], q);
    }

    function searchTime(ts) {
        const d = new Date(ts);
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + timeStr(ts);
    }

    // The matched term in context, marked — built as nodes, never markup.
    function highlightSnippet(text, q) {
        const frag = document.createDocumentFragment();
        const idx = text.toLowerCase().indexOf(q.toLowerCase());
        if (idx === -1) { frag.appendChild(document.createTextNode(text.slice(0, 160))); return frag; }
        const start = Math.max(0, idx - 40);
        if (start > 0) frag.appendChild(document.createTextNode('…'));
        frag.appendChild(document.createTextNode(text.slice(start, idx)));
        const mark = document.createElement('mark');
        mark.textContent = text.slice(idx, idx + q.length);
        frag.appendChild(mark);
        frag.appendChild(document.createTextNode(text.slice(idx + q.length, idx + q.length + 80)));
        return frag;
    }

    function renderSearchResults(list, q) {
        const box = $('search-results');
        box.innerHTML = '';

        const head = document.createElement('div');
        head.className = 'sr-head';
        head.textContent = list.length
            ? `${list.length} result${list.length === 1 ? '' : 's'} in the archive` +
              (searchScope === 'all' ? ' (all channels)' : ` (#${channel})`)
            : 'Nothing in the archive matches that';
        box.appendChild(head);

        list.forEach((r) => {
            const it = document.createElement('button');
            it.type = 'button';
            it.className = 'search-result';

            const top = document.createElement('div');
            top.className = 'sr-top';
            const nm = document.createElement('span');
            nm.className = 'sr-name';
            nm.textContent = wroteByMe(r) ? 'You' : (r.name || 'Anonymous');
            const ch = document.createElement('span');
            ch.className = 'sr-ch';
            ch.textContent = '#' + r.channel + (r.thread_root_id ? ' · thread' : '');
            const tm = document.createElement('span');
            tm.className = 'sr-time';
            tm.textContent = searchTime(r.created_at);
            top.appendChild(nm); top.appendChild(ch); top.appendChild(tm);

            const bd = document.createElement('div');
            bd.className = 'sr-body';
            // An attachment-only hit gets its file icon rather than a stray emoji.
            if (!r.body && r.att_name) bd.insertAdjacentHTML('beforeend', I(fileIcon(r.att_name), 'ico inline-ico'));
            bd.appendChild(highlightSnippet(r.body || r.att_name || '', q));

            it.appendChild(top);
            it.appendChild(bd);
            it.addEventListener('click', () => {
                hideSearchResults();
                $('filter-input').value = '';
                filter.text = '';
                // A reply lives in its thread, not the main list.
                if (r.thread_root_id) openThread(r.thread_root_id, r.channel);
                else jumpToPost(r);
            });
            box.appendChild(it);
        });

        box.hidden = false;
    }
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

    // ---------- threads ----------------------------------------------------
    // The server already models these: a reply carries parentId and the root's
    // thread_root_id, and /api/board/thread returns root + replies oldest-first.
    // The panel polls while open, like the website's.

    const THREAD_POLL_MS = 2500;

    let threadRootId = 0;
    let threadPosts = [];
    let threadTimer = null;
    let threadSig = '';

    async function openThread(rootId, chan) {
        if (!rootId) return;
        // A result from another channel: switch first so replies post to the
        // right place and closing the thread lands somewhere sensible.
        if (chan && chan !== channel) await switchChannel(chan);

        // Both drawers occupy the same slot at the same z-index, and #dm-panel
        // is later in the DOM — so with a DM open the thread would open
        // invisibly underneath it and "Reply in thread" looked like a no-op.
        // (openDm already does the reverse.)
        if (dmPanelOpen()) closeDm();

        threadRootId = rootId;
        threadSig = '';
        threadPosts = [];
        $('thread-panel').hidden = false;
        $('thread-list').innerHTML = '<div class="thread-loading">Loading thread…</div>';
        await loadThread(true);
        $('thread-input').focus();
        if (threadTimer) clearInterval(threadTimer);
        // 2.5s is tight because an open thread is being read right now. A hidden
        // window is not being read, and this timer used to keep firing at full
        // rate for as long as the panel was left open — 24 requests a minute
        // into the tray.
        threadTimer = setInterval(() => {
            if (document.hidden) return;
            loadThread(false);
        }, THREAD_POLL_MS);
    }

    function closeThread() {
        threadRootId = 0;
        threadPosts = [];
        if (threadTimer) { clearInterval(threadTimer); threadTimer = null; }
        // An inline editor opened on a thread reply lives in this list. Hiding
        // the panel around it left the .msg-edit node in the document, and
        // renderMessages() bails whenever one exists anywhere — so the MAIN
        // message list stopped repainting for good until a thread was reopened.
        const list = $('thread-list');
        if (list.querySelector('.msg-edit')) editingId = null;
        list.innerHTML = '';
        $('thread-panel').hidden = true;
    }

    function threadOpen() { return !$('thread-panel').hidden; }

    async function loadThread(force) {
        if (!threadRootId) return;
        const root = threadRootId;
        const res = await L.board('thread', { query: { root } });
        if (root !== threadRootId) return;               // switched while in flight
        if (authGone(res)) return;
        if (!res || !res.success) return;

        threadPosts = res.posts || [];
        if (!threadPosts.length) { closeThread(); return; }   // root was deleted
        threadPosts.forEach((p) => addRosterName(p.name));

        const sig = JSON.stringify(threadPosts);
        if (!force && sig === threadSig) return;
        // Only claim this payload as rendered if it actually rendered. Stamping
        // the signature up front meant a renderThread() that bailed for an open
        // editor recorded replies it never painted, and the poll then skipped
        // them for as long as nothing else changed — new messages in the thread
        // simply never appeared.
        if (renderThread()) threadSig = sig;
    }

    // Returns false when it declined to paint, so the caller knows not to treat
    // the payload as displayed.
    function renderThread() {
        const list = $('thread-list');
        // Same courtesy the main list extends: a thread poll must not destroy
        // an inline editor someone is typing into.
        if (editingId && list.querySelector('.msg-edit')) return false;
        const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;

        const replies = threadPosts.length - 1;
        $('thread-title').textContent = 'Thread · ' +
            (replies > 0 ? `${replies} ${replies === 1 ? 'reply' : 'replies'}` : 'no replies yet');

        list.innerHTML = '';
        let prev = null;
        threadPosts.forEach((p, i) => {
            const row = renderMessage(p, i === 0 ? null : prev);
            if (i === 0) row.classList.add('thread-root');
            list.appendChild(row);
            prev = p;
        });
        if (atBottom) list.scrollTop = list.scrollHeight;
        return true;
    }

    $('thread-close').addEventListener('click', closeThread);

    $('thread-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            $('thread-composer').requestSubmit();
        }
    });

    $('thread-composer').addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = $('thread-input').value.trim();
        if (!body || !threadRootId) return;
        $('thread-send').disabled = true;
        $('thread-input').value = '';

        const res = await L.board('post', {
            method: 'POST',
            body: {
                body,
                name: settings.displayName || 'Anonymous',
                clientId: settings.clientId,
                channel,
                parentId: threadRootId          // what makes it a thread reply
            }
        });
        $('thread-send').disabled = false;

        if (authGone(res)) return;
        if (!res || !res.success) {
            $('thread-input').value = body;     // hand the text back
            return toast((res && res.error) || 'Could not reply', true);
        }
        announcePosted(channel, body);
        await loadThread(true);
        $('thread-list').scrollTop = $('thread-list').scrollHeight;
        await loadMessages(nearBottom());       // refresh the reply count
        $('thread-input').focus();
    });

    // ---------- pinned ----------------------------------------------------

    async function pinPost(id, pinned) {
        const res = await L.board('pin', { method: 'POST', body: { id, pinned, clientId: settings.clientId } });
        if (authGone(res)) return;
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

    // The same menu the channel row and the right-click open, from the header.
    $('btn-chan-alerts').addEventListener('click', (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        openChannelMenu(channel, r.left - 120, r.bottom + 6);
    });

    $('btn-pinned').addEventListener('click', () => togglePinned($('pinned-panel').hidden));
    $('pinned-close').addEventListener('click', () => togglePinned(false));

    async function renderPinned() {
        const list = $('pinned-list');
        $('pinned-channel').textContent = channel;
        list.innerHTML = '';

        // The whole channel's pins from the server — not just whatever pages
        // happen to be loaded. Falls back to loaded posts offline.
        let pinned = null;
        const forChannel = channel;
        try {
            const res = await L.board('pins', { query: { channel } });
            if (res && res.success && Array.isArray(res.pins)) pinned = res.pins;
        } catch (e) { /* fall through */ }
        if (forChannel !== channel || $('pinned-panel').hidden) return;   // switched away meanwhile
        if (!pinned) pinned = posts.filter((p) => p.pinned);
        list.innerHTML = '';
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
            const bodyIcon = (!p.body && p.att_name) ? I(fileIcon(p.att_name), 'ico inline-ico') : '';
            const body = p.body || p.att_name || '';
            item.innerHTML =
                '<div class="pinned-top">' +
                `<span class="pinned-name">${esc(p.name)}</span>` +
                `<span class="pinned-time">${esc(timeStr(p.created_at))}</span>` +
                '<button class="pinned-unpin" type="button">Unpin</button>' +
                '</div>' +
                `<div class="pinned-body">${bodyIcon}${esc(body.slice(0, 240))}</div>`;
            item.addEventListener('click', () => {
                // A pinned thread reply lives in its thread, not the main list.
                if (p.thread_root_id) openThread(p.thread_root_id, p.channel);
                else jumpToPost(p);
            });
            item.querySelector('.pinned-unpin').addEventListener('click', (e) => {
                e.stopPropagation();
                pinPost(p.id, false);
            });
            list.appendChild(item);
        });
    }

    // ---------- direct messages --------------------------------------------
    // DMs need a board account (see the Account settings group): message rows
    // are keyed by user id, and realtime delivery routes through the account's
    // bound client_id. The conversation opens in a drawer like the thread panel.

    const DM_POLL_MS = 12000;
    let dmThreads = [];               // [{ user:{id,username}, last:{...}, unread }]
    let dmOpen = null;                // { id, username } of the open conversation
    let dmMsgs = [];
    let dmTimer = null;

    // The open conversation is being read right now. The row already hides its
    // own badge; the rail and the taskbar badge read this total, so leaving it
    // in kept them lit while you were looking at the messages.
    function dmUnreadTotal() {
        return dmThreads.reduce((s, t) =>
            s + ((dmOpen && dmOpen.id === t.user.id) ? 0 : (t.unread || 0)), 0);
    }

    function renderDmSection() {
        const list = $('dm-list');
        list.innerHTML = '';
        if (!account) {
            const b = document.createElement('button');
            b.className = 'chan dm-signin';
            b.innerHTML = '<span class="hash">@</span><span class="chan-name">Sign in to use DMs</span>';
            b.addEventListener('click', () => { openSettings(); });
            list.appendChild(b);
            return;
        }
        dmThreads.forEach((t) => {
            const open = dmOpen && dmOpen.id === t.user.id;
            const unread = open ? 0 : (t.unread || 0);
            const b = document.createElement('button');
            b.className = 'chan dm' + (open ? ' active' : '') + (unread ? ' unread' : '');
            b.innerHTML = `<span class="hash">@</span><span class="chan-name">${esc(t.user.username)}</span>` +
                (unread ? `<span class="unread">${unread > 99 ? '99+' : unread}</span>` : '');
            b.addEventListener('click', () => openDm(t.user));
            list.appendChild(b);
        });
        renderChannels();   // DM unread feeds the rail + taskbar badges
    }

    async function loadDmThreads() {
        if (!account) return;
        const res = await L.board('dm/threads');
        if (res && res.success) {
            dmThreads = res.threads || [];
            // The server's count for the open conversation lags its read marker
            // by a poll; the drawer is on screen, so it is read by definition.
            if (dmOpen) {
                const t = dmThreads.find((x) => x.user.id === dmOpen.id);
                if (t) t.unread = 0;
            }
            renderDmSection();
        }
    }

    function startDmPolling() {
        if (dmTimer) clearInterval(dmTimer);
        dmTimer = setInterval(() => {
            if (!account || $('app').hidden) return;
            // DMs arrive over the socket ('dm' events), so while it is healthy
            // this poll is a safety net — and a hidden window has nothing to
            // repaint. ($('app').hidden is the login gate, not window visibility.)
            if (document.hidden && rtConnected) return;
            loadDmThreads();
            if (dmOpen) loadDmMessages(false);
        }, DM_POLL_MS);
    }

    function stopDmPolling() {
        if (dmTimer) { clearInterval(dmTimer); dmTimer = null; }
        closeDm();
    }

    async function openDm(user) {
        dmOpen = { id: user.id, username: user.username };
        $('dm-title').textContent = user.username;
        $('dm-panel').hidden = false;
        closeThread();
        dmMsgs = [];
        loadDmMessages.lastSig = null;    // the last conversation's payload isn't this one's
        $('dm-messages').innerHTML = '<div class="thread-loading">Loading…</div>';
        await loadDmMessages(true);
        // Everything below assumes this conversation is still the open one. It
        // may not be: a close, a session teardown, or simply opening someone
        // else can all land during the fetch, and the tail used to run anyway —
        // scrolling a panel that had moved on and pulling focus into a hidden
        // input.
        if (!dmOpen || dmOpen.id !== user.id) return;
        // Opening a conversation always lands on the newest message; only the
        // background re-renders defer to where the reader already is.
        const box = $('dm-messages');
        box.scrollTop = box.scrollHeight;
        const t = dmThreads.find((x) => x.user.id === user.id);
        if (t && t.unread) { t.unread = 0; renderDmSection(); }
        renderDmSection();
        $('dm-input').focus();
    }

    function closeDm() {
        dmOpen = null;
        loadDmMessages.lastSig = null;
        $('dm-panel').hidden = true;
        renderDmSection();
    }

    function dmPanelOpen() { return !$('dm-panel').hidden; }

    async function loadDmMessages(force) {
        if (!dmOpen) return;
        const forUser = dmOpen.id;
        const res = await L.board('dm/list', { query: { with: forUser } });
        if (!dmOpen || dmOpen.id !== forUser) return;      // switched conversations mid-flight
        if (!res || !res.success) {
            if (authGone(res)) return;
            if (res && res.needsAccount) { closeDm(); toast('Sign into your board account to use DMs', true); return; }
            // Anything else used to leave the drawer on "Loading…" forever.
            dmMessagesError((res && res.error) || 'Could not load this conversation.');
            return;
        }
        const sig = JSON.stringify(res.messages || []);
        if (!force && sig === loadDmMessages.lastSig) return;
        loadDmMessages.lastSig = sig;
        dmMsgs = res.messages || [];
        renderDmMessages();
    }

    // The drawer's "Loading…" placeholder never clears on its own, so a failed
    // first load has to replace it. Only when nothing is rendered yet — wiping a
    // readable conversation because one background poll failed would be worse.
    function dmMessagesError(msg) {
        if (dmMsgs.length) return;
        const box = $('dm-messages');
        box.innerHTML = `<div class="dm-empty">${esc(msg)}` +
            '<button type="button" class="keycap dm-retry">Retry</button></div>';
        box.querySelector('.dm-retry').addEventListener('click', () => loadDmMessages(true));
    }

    function renderDmMessages() {
        const box = $('dm-messages');
        // Measured before the rebuild: this drawer used to slam to the bottom on
        // every poll, so a DM arriving while you were reading back through the
        // conversation yanked you away from it. The main list and the thread
        // panel already extend this courtesy.
        const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
        box.innerHTML = '';
        if (!dmMsgs.length) {
            const e = document.createElement('div');
            e.className = 'dm-empty';
            e.textContent = 'No messages yet — say hi!';
            box.appendChild(e);
            return;
        }
        let prevDay = '';
        dmMsgs.forEach((m) => {
            const day = dayStr(m.created_at);
            if (day !== prevDay) {
                prevDay = day;
                const sep = document.createElement('div');
                sep.className = 'dm-day';
                sep.textContent = day;
                box.appendChild(sep);
            }
            const row = document.createElement('div');
            row.className = 'dm-msg' + (m.fromMe ? ' mine' : '');
            const bubble = document.createElement('div');
            bubble.className = 'dm-bubble';
            bubble.textContent = m.body;
            const time = document.createElement('span');
            time.className = 'dm-time';
            time.textContent = timeStr(m.created_at);
            row.appendChild(bubble);
            row.appendChild(time);
            box.appendChild(row);
        });
        // Follow the live edge only if that's where the reader already was.
        if (atBottom) box.scrollTop = box.scrollHeight;
    }

    $('dm-composer').addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!dmOpen) return;
        const input = $('dm-input');
        const body = input.value.trim();
        if (!body) return;
        const to = dmOpen.id;
        input.value = '';
        const res = await L.board('dm/send', { method: 'POST', body: { to, body } });
        if (!res || !res.success) {
            input.value = body;   // give the text back
            return toast((res && res.error) || 'Could not send the DM', true);
        }
        if (dmOpen && dmOpen.id === to) {
            dmMsgs.push({ id: res.id, body, created_at: res.created_at || Date.now(), fromMe: true });
            renderDmMessages();
        }
        loadDmThreads();
    });
    $('dm-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            $('dm-composer').requestSubmit();
        }
    });
    $('dm-close').addEventListener('click', closeDm);

    // Start a conversation: pick any account holder from the directory.
    $('btn-new-dm').addEventListener('click', async (e) => {
        if (!account) { openSettings(); return; }
        // Measured BEFORE the await: event.currentTarget is nulled once dispatch
        // finishes, so reading it afterwards is an unconditional TypeError and
        // the menu never opened at all.
        const r = e.currentTarget.getBoundingClientRect();
        const res = await L.board('account/users');
        if (!res || !res.success) return toast((res && res.error) || 'Could not load the member directory', true);
        const others = (res.users || []).filter((u) => u.id !== account.id);
        if (!others.length) {
            return toast('No one else has a board account yet — DMs need one on both ends');
        }
        openCtxMenu(others.map((u) => ({
            label: u.username + (u.role === 'admin' ? ' (admin)' : ''),
            icon: 'at',
            onClick: () => openDm({ id: u.id, username: u.username })
        })), r.left, r.bottom + 4);
    });

    // Realtime delivery — pushed by the server the moment the sender posts.
    function onDmEvent(m) {
        if (!m || !m.from) return;
        if (dmOpen && dmOpen.id === m.from.id) {
            // Open conversation: append and stop there. The event already
            // carries the body, and the re-fetch that used to follow read from a
            // replica that often hadn't seen the write yet — so the message we
            // had just shown disappeared again until the next poll agreed.
            if (!dmMsgs.some((x) => x.id === m.id)) {
                dmMsgs.push({ id: m.id, body: m.body, created_at: m.created_at, fromMe: false });
                renderDmMessages();
            }
        } else {
            const t = dmThreads.find((x) => x.user.id === m.from.id);
            if (t) {
                t.unread = (t.unread || 0) + 1;
                t.last = { id: m.id, body: m.body, created_at: m.created_at, fromMe: false };
                renderDmSection();
            } else {
                loadDmThreads();
            }
        }
        if (alertsAllowed(null)) {
            const conversationVisible = windowFocused && dmOpen && dmOpen.id === m.from.id;
            if (!conversationVisible) window.loungeSounds.playMessage();
            if (!windowFocused && settings.notifications !== false) {
                L.app.notify({ title: `${m.from.username} (DM)`, body: (m.body || '').slice(0, 140) });
            }
        }
    }

    // ---------- window chrome ---------------------------------------------

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            // Innermost first. The lightbox and the dialog are focus-trapped
            // modals drawn OVER the thread/DM drawers, so they have to rank
            // above them — opening an image from a thread row and pressing Esc
            // used to close the thread behind the picture that was still up.
            if (emojiPopOpen()) closeEmojiPop();
            else if (!$('ctx-menu').hidden) closeCtxMenu();
            else if (mePopoverOpen()) closeMePopover();
            else if (!$('lightbox').hidden) closeLightbox();
            else if (!$('dialog').hidden) closeDialog(inp_null());
            else if (threadOpen()) closeThread();
            else if (dmPanelOpen()) closeDm();
            else if (!$('picker').hidden) closePicker();
            else if (!$('popover').hidden) closePopover();
            else if (notesOpen()) closeNotes();
            else if (!$('settings').hidden) closeSettings();
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
        if (!voice) return;
        if (voice.isJoined()) heartbeatPresence(true);
        // Unconditional: leave() self-guards, and quitting mid-join must still
        // retire the pending join rather than leave it to resolve.
        voice.leave();
    });

    boot();
})();
