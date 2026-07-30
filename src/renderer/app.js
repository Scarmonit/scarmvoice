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
    // Every settings control that is DRAWN FROM a setting registers a repainter
    // here, so the whole sheet can be brought up to date in one call — see
    // wireSwitch / wireRadios / paintPaneControls.
    //
    // Declared HERE rather than beside those factories because the settings nav is
    // built at module scope and shows a pane on the way in, which repaints it: a
    // `const` further down the file is in its temporal dead zone until that line
    // runs, and reaching it from higher up throws — killing the rest of app.js,
    // which is every listener in the app.
    const switchPainters = [];
    const radioPainters = [];
    function paintSwitches() { switchPainters.forEach((f) => f()); }
    function paintRadios() { radioPainters.forEach((f) => f()); }

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
    // Is the window in the tray or minimised? `document.hidden` cannot answer
    // that here: webPreferences.backgroundThrottling is false — deliberately,
    // so the presence heartbeat and the fallback poll survive the tray — and
    // the price is that Chromium stops maintaining the visibility API
    // altogether. It reads `visible` through both a hide and a minimize, and
    // `visibilitychange` never fires. Verified in this Electron build.
    //
    // Every "don't do this while nobody is looking" guard in this file was
    // written against that flag, so none of them has ever run. main.js watches
    // the real window events and tells us instead; appHidden() is the one place
    // the answer comes from so the guards cannot drift apart again.
    let windowHidden = false;
    function appHidden() { return windowHidden; }
    let loading = false;
    let lastSoundId = 0;            // watermark so one message chimes exactly once
    let filterTimer = null;
    let filterScrollTop = null;      // scroll position to restore when filters clear
    // Active message filters. Types combine as OR; every other criterion is AND.
    const filter = {
        text: '',
        types: new Set(),           // 'links' | 'images' | 'videos' | 'audio' | 'files'
        pinned: null,               // true | false | null ("either") — see applyQuery
        mentions: false,
        edited: false,
        // The chosen person as an IDENTITY — { label, names, userIds } — not as
        // a list of install ids. See postFrom() in lib.js.
        from: null,
        fromName: null,
        // From the operators: `mentions:someone`, `in:channel`, `before:` and
        // `after:` as timestamps. All of them are derived from the ONE string
        // in the search box, never held independently of it.
        mentionsNames: [],
        inChannel: null,
        author: null,
        before: null,
        after: null
    };
    function filterActive() {
        // `pinned` is tri-state: null is "either", and BOTH true and false are
        // a filter — `pinned:false` narrows the list just as much as
        // `pinned:true` does.
        return !!(filter.text || filter.types.size || filter.pinned !== null ||
            filter.mentions || filter.edited || filter.from ||
            filter.mentionsNames.length || filter.inChannel || filter.author ||
            filter.before || filter.after);
    }

    // ---------- utilities -------------------------------------------------

    // The pure half of the renderer lives in lib.js so it can be unit-tested;
    // these are local names for the parts used here.
    const {
        esc, avatarStyle, bannerStyle, initials, isOnlyEmoji,
        timeStr, dayStr, stampStr, fmtSize, fmtDuration, splitName,
        attachmentKind, fileIcon,
        extractUrls, safeHttpUrl, urlFileName, youtubeId,
        FONT_SIZES, fontSizeIndex, matchesPttBinding
    } = window.ScarmLib;

    let toastTimer = null;
    function toast(msg, isError) {
        const el = $('toast');
        el.classList.toggle('err', !!isError);
        // An error is worth interrupting for; a confirmation is not.
        el.setAttribute('aria-live', isError ? 'assertive' : 'polite');
        // UNHIDDEN FIRST, then written. A mutation made while the element is still
        // hidden is not reliably announced — the live region is not being observed
        // yet — so writing the text before revealing it loses the announcement,
        // which is the whole reason the region exists (see index.html).
        el.hidden = false;
        el.textContent = msg;
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

    // Bumped whenever that map changes, and carried in every message signature.
    //
    // renderMessages() diffs the list by signature and KEEPS any row whose
    // signature is unchanged — which is the whole point of it — and a custom
    // emoji is not part of the post. So the renderMessages() sitting beside
    // every mutation of this map repainted nothing at all: adding an emoji left
    // messages already on screen showing `:name:` as text, and removing one left
    // them pointing at an R2 object that had just been deleted, i.e. a broken
    // image, until the channel was switched or the app restarted.
    let emojiGen = 0;

    // The set as the renderer sees it, so a reload that changed nothing does not
    // rebuild every message on screen (loadCustomEmoji runs on every Settings
    // open).
    function emojiFingerprint() {
        return [...customEmoji.values()].map((e) => e.name + '\x00' + e.url).sort().join('\x01');
    }

    function bumpEmojiGen() { emojiGen++; }

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
            const before = emojiFingerprint();
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
            if (emojiFingerprint() !== before) bumpEmojiGen();
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
    // The five-minute sweep armed by enterApp(), held so teardown can stop it.
    let avatarTimer = null;
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
        // The face at the top of the settings RAIL, which is a separate element
        // from the one on the account card and was the only one this function did
        // not know about. Changing your profile picture therefore left the two
        // sitting next to each other showing different pictures until Settings was
        // closed and reopened — and the five-minute refreshAvatars() sweep, which
        // exists to notice everyone ELSE's changes, never updated it either.
        paintSettingsMe();
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

    // Inline: ***bold italic***, **bold**, __underline__, *italic*, _italic_,
    // ~~strike~~, ||spoiler|| — Discord's set, in Discord's precedence. Recursive,
    // so the combinations nest.
    //
    //   `wrap`  a second element around the first. ***x*** is bold AND italic;
    //           letting the two-star rule take it left the odd star behind, so
    //           ***x*** rendered as a bold "*x" followed by a stray "*".
    //   `lead`  the match opens with a capture group that is CONTEXT, not content:
    //           the character in front of an underscore. Single-underscore italics
    //           only apply at a word boundary, because snake_case_identifiers are
    //           ordinary words in a chat about code — and Discord does not
    //           italicise them either.
    const FMT = [
        { re: /\|\|([\s\S]+?)\|\|/, kind: 'spoiler' },
        { re: /\*\*\*([\s\S]+?)\*\*\*/, kind: 'em', wrap: 'strong' },
        { re: /\*\*([\s\S]+?)\*\*/, kind: 'strong' },
        { re: /___([\s\S]+?)___/, kind: 'em', wrap: 'u' },
        { re: /__([\s\S]+?)__/, kind: 'u' },
        { re: /~~([\s\S]+?)~~/, kind: 'del' },
        { re: /\*([\s\S]+?)\*/, kind: 'em' },
        { re: /(^|[^\w_])_([^_\s](?:[^_]*[^_\s])?)_(?!\w)/, kind: 'em', lead: true }
    ];

    // The earliest-starting rule wins; ties go to whichever comes first in FMT,
    // which is why *** sits above ** and __ above _.
    function fmtMatch(text) {
        let best = null;
        for (const f of FMT) {
            const m = f.re.exec(text);
            if (!m) continue;
            const lead = f.lead ? m[1].length : 0;
            const start = m.index + lead;
            if (best && start >= best.start) continue;
            best = { f, start, inner: f.lead ? m[2] : m[1], end: m.index + m[0].length };
        }
        return best;
    }

    function renderFormatted(container, text, ctx) {
        const best = fmtMatch(text);
        if (!best) { appendTextWithMentions(container, text, ctx); return; }
        if (best.start > 0) appendTextWithMentions(container, text.slice(0, best.start), ctx);

        let host;
        if (best.f.kind === 'spoiler') {
            host = document.createElement('span');
            host.className = 'spoiler';
            host.setAttribute('role', 'button');
            host.setAttribute('tabindex', '0');
            host.title = 'Click to reveal spoiler';
            host.addEventListener('click', () => host.classList.add('revealed'));
            host.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); host.classList.add('revealed'); }
            });
            container.appendChild(host);
        } else {
            host = document.createElement(best.f.kind);
            if (best.f.wrap) {
                const outer = document.createElement(best.f.wrap);
                outer.appendChild(host);
                container.appendChild(outer);
            } else {
                container.appendChild(host);
            }
        }
        renderFormatted(host, best.inner, ctx);
        const after = text.slice(best.end);
        if (after) renderFormatted(container, after, ctx);
    }

    // `code` and ``code`` spans first, so formatting characters inside them stay
    // literal. Two backticks is how Discord writes a span containing a backtick;
    // splitting the line on a single one turned ``a`` into a bare letter with no
    // code styling, and an ODD number of backticks made everything after the last
    // one look like code.
    const CODE_SPAN_RE = /(`{1,2})([\s\S]+?)\1/;
    function renderInline(container, text, ctx) {
        let rest = String(text == null ? '' : text);
        for (;;) {
            const m = CODE_SPAN_RE.exec(rest);
            if (!m) break;
            if (m.index > 0) renderFormatted(container, rest.slice(0, m.index), ctx);
            const c = document.createElement('code');
            c.className = 'inline-code';
            c.textContent = m[2];
            container.appendChild(c);
            rest = rest.slice(m.index + m[0].length);
        }
        if (rest) renderFormatted(container, rest, ctx);
    }

    // One line of a list: how far it is indented, whether it is numbered, and the
    // number it was actually written with.
    function listItem(line) {
        const m = /^([ \t]*)(?:[-*+]|(\d{1,9})[.)])[ \t]+(.*)$/.exec(line);
        if (!m) return null;
        return {
            indent: m[1].replace(/\t/g, '    ').length,
            num: m[2] === undefined ? null : parseInt(m[2], 10),
            text: m[3]
        };
    }
    const blankLine = (s) => !String(s).trim();

    // Renders the list starting at lines[i] — and, recursively, anything nested
    // inside it — into `container`. Returns the index of the first line it did NOT
    // consume.
    //
    // THIS is the fix for "every item says 1.". The old code took a run of
    // CONSECUTIVE list lines and stopped at the first line that was not one, so a
    // blank line between items, an indented sub-list, or a wrapped second line all
    // ended the <ol> — and the next item opened a brand new <ol>, which starts
    // counting from one again. A 1-through-8 list written with any spacing at all
    // therefore came out as eight lists of one item, every one of them numbered 1.
    function renderList(lines, i, container, ctx) {
        const first = listItem(lines[i]);
        const ordered = first.num !== null;
        const base = first.indent;
        const el = document.createElement(ordered ? 'ol' : 'ul');
        el.className = 'msg-list';
        // "3." starts at three. The numbers after the first are advisory —
        // CommonMark and Discord both number the rest sequentially from the start
        // value — which is what makes a list typed as 1. 1. 1. render 1, 2, 3.
        if (ordered && first.num !== 1) el.setAttribute('start', String(first.num));

        let item = null;                 // the lines of the item being collected
        const flushItem = () => {
            if (!item) return;
            const li = document.createElement('li');
            // The common case is one line with no block structure in it, and
            // rendering that inline keeps the <li> free of a paragraph wrapper —
            // which is exactly how every existing message already draws.
            if (item.length === 1) renderInline(li, item[0], ctx);
            else renderTextBlock(item.join('\n'), li, ctx);
            el.appendChild(li);
            item = null;
        };

        while (i < lines.length) {
            if (blankLine(lines[i])) {
                // A blank line inside a list is SPACING. It ends the list only if
                // the list does not carry on below it.
                let j = i;
                while (j < lines.length && blankLine(lines[j])) j++;
                if (j >= lines.length) break;
                const next = listItem(lines[j]);
                const carriesOn = (next && next.indent >= base && (next.num !== null) === ordered) ||
                    /^[ \t]{2,}\S/.test(lines[j]);
                if (!carriesOn) break;
                if (item) item.push('');
                i = j;
                continue;
            }
            const m = listItem(lines[i]);
            if (m && m.indent <= base) {
                // Shallower than we opened at, or a bullet where the numbers were:
                // a different list, and not this one's to consume.
                if (m.indent < base || (m.num !== null) !== ordered) break;
                flushItem();
                item = [m.text];
                i++;
                continue;
            }
            // Anything indented under the current item belongs to it — a nested
            // list, a second paragraph, a wrapped line. Dedented by one level so
            // the recursive parse sees it at column zero.
            if (!item) break;
            item.push(lines[i].replace(/^[ \t]{1,4}/, ''));
            i++;
        }
        flushItem();
        container.appendChild(el);
        return i;
    }

    // Blocks within a non-code segment: headings, subtext, lists, blockquotes,
    // paragraphs. Discord's block set, so a message pasted from there reads the
    // same here.
    function renderTextBlock(text, container, ctx) {
        const lines = String(text == null ? '' : text).split('\n');
        let i = 0, para = null;
        const flush = () => { if (para) { container.appendChild(para); para = null; } };
        const startPara = () => {
            if (!para) { para = document.createElement('span'); para.className = 'msg-para'; }
            else para.appendChild(document.createElement('br'));
        };

        while (i < lines.length) {
            const line = lines[i];

            // # ## ### and -#, all of which REQUIRE the space: "#general" is a
            // channel somebody typed, not a heading, and "-#1" is not subtext.
            const h = /^(#{1,3})[ \t]+(\S[\s\S]*)$/.exec(line);
            if (h) {
                flush();
                const el = document.createElement('div');
                el.className = 'msg-h msg-h' + h[1].length;
                renderInline(el, h[2], ctx);
                container.appendChild(el);
                i++;
                continue;
            }
            const sub = /^-#[ \t]+(\S[\s\S]*)$/.exec(line);
            if (sub) {
                flush();
                const el = document.createElement('div');
                el.className = 'msg-sub';
                renderInline(el, sub[1], ctx);
                container.appendChild(el);
                i++;
                continue;
            }

            if (listItem(line)) {
                flush();
                i = renderList(lines, i, container, ctx);
                continue;
            }

            // >>> quotes everything that follows it; > quotes only its own line.
            // Checked first, or the single-> rule eats it and leaves ">> " inside
            // the quote.
            const bqAll = /^[ \t]*>>>[ \t]?([\s\S]*)$/.exec(line);
            if (bqAll) {
                flush();
                const q = document.createElement('blockquote');
                q.className = 'msg-bq';
                renderTextBlock([bqAll[1]].concat(lines.slice(i + 1)).join('\n'), q, ctx);
                container.appendChild(q);
                return;
            }
            if (/^[ \t]*>[ \t]?/.test(line)) {
                flush();
                // .msg-bq, not .msg-quote — that class is the reply quote box here.
                const q = document.createElement('blockquote');
                q.className = 'msg-bq';
                const quoted = [];
                while (i < lines.length) {
                    const qm = /^[ \t]*>[ \t]?(.*)$/.exec(lines[i]);
                    if (!qm) break;
                    quoted.push(qm[1]);
                    i++;
                }
                // Through renderTextBlock, not renderInline: a list or a heading
                // inside a quote is still a list or a heading, and Discord renders
                // it as one.
                renderTextBlock(quoted.join('\n'), q, ctx);
                container.appendChild(q);
                continue;
            }
            if (blankLine(line)) { flush(); i++; continue; }
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

    // (lang + text) -> the highlighted markup and class hljs produced for it.
    // Bounded by cachePut at PREVIEW_CACHE_MAX, like the preview caches.
    const hlCache = new Map();

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
            // A fence with no language runs auto-detection across the whole
            // vendored language set, and it is not cheap: measured against this
            // bundle, 1.2ms for a one-line fence, 2.7ms for a stack trace,
            // 9.3ms for a 1500-character paste — against 0.06-0.36ms when the
            // language is named. That was paid again every time the row was
            // rebuilt: an edit, a reaction, a channel switch back, a resync.
            //
            // hljs is deterministic for a given (text, language), so the answer
            // is worth keeping. Bounded by the same cachePut the preview caches
            // use.
            const lang = (/(?:^|\s)language-([\w+#._-]+)/.exec(code.className) || ['', ''])[1];
            // Now that a message can be a quarter of a megabyte, a fence inside
            // one can be too — and highlighting cost is linear in its length at
            // best. Left as plain monospace past these sizes, which is what an
            // unrecognised language already looks like. The `data-hl` stamp above
            // means this decision is made once per block, not once per render.
            //
            // The unlabelled ceiling is far lower because a fence with no language
            // runs auto-detection across every vendored language: 9.3ms for 1500
            // characters (measured, see above), so a 100,000-character paste of
            // logs would be most of a second of blocked main thread — per block.
            const big = code.textContent.length;
            if (big > (lang ? 50000 : 10000)) return;
            // A newline separates them safely: the language token is matched as
            // [\w+#._-]+, so it can never contain one.
            const key = lang + '\n' + code.textContent;
            const hit = hlCache.get(key);
            if (hit) {
                // The CLASS matters as much as the markup: highlightElement
                // adds `hljs`, and the theme hangs entirely off that class —
                // restoring the HTML alone gives an unstyled, unpadded,
                // transparent block. Restoring both makes a cache hit
                // byte-identical to a miss.
                code.className = hit.cls;
                code.innerHTML = hit.html;
                return;
            }
            try {
                window.hljs.highlightElement(code);
                cachePut(hlCache, key, { html: code.innerHTML, cls: code.className });
            } catch (e) { /* leave it plain */ }
        });
    }

    // ---------- chat font size --------------------------------------------
    // One CSS variable drives the whole message body — text, names, timestamps
    // and avatars are all sized in em against it, so they scale together.

    // Chat text size is a NUMBER now, in pixels, 12-24 — the reference's slider.
    // The four-name scale it replaced is still honoured on the way in (store.js
    // seeds chatFontPx from it once) and `chatFontSize` is still written, so an
    // older build and the tests that read it keep working.
    const FONT_PX_MIN = 12;
    const FONT_PX_MAX = 24;
    const FONT_PX_DEFAULT = 16;

    function clampFontPx(v) {
        const n = Math.round(Number(v));
        if (!Number.isFinite(n)) return FONT_PX_DEFAULT;
        return Math.max(FONT_PX_MIN, Math.min(FONT_PX_MAX, n));
    }

    // What the stored profile means, whichever of the two forms it is in.
    function currentFontPx() {
        if (settings.chatFontPx !== undefined && settings.chatFontPx !== null) {
            return clampFontPx(settings.chatFontPx);
        }
        return FONT_SIZES[fontSizeIndex(settings.chatFontSize)].px;
    }

    // The nearest name on the old scale, so `chatFontSize` keeps meaning
    // something for anything still reading it.
    function nearestFontKey(px) {
        let best = FONT_SIZES[0];
        FONT_SIZES.forEach((f) => {
            if (Math.abs(f.px - px) < Math.abs(best.px - px)) best = f;
        });
        return best.key;
    }

    function applyChatFontSize(px) {
        const n = clampFontPx(px);
        document.documentElement.style.setProperty('--chat-fs', n + 'px');
        const sel = $('set-font-size');
        if (sel) sel.value = nearestFontKey(n);
        const slider = $('set-font-px');
        if (slider) slider.value = String(n);
        paintTicks('ticks-font', n);
        renderA11yPreview();
        return n;
    }

    async function setChatFontPx(px) {
        const n = clampFontPx(px);
        await saveSettings({ chatFontPx: n, chatFontSize: nearestFontKey(n) });
        applyChatFontSize(n);
    }

    // step: -1 smaller, +1 larger, 0 reset to the default. One pixel a press,
    // which is what a pixel scale means — the old version stepped between four
    // named sizes and could only say "already at Extra Large".
    async function stepChatFontSize(step) {
        const current = currentFontPx();
        const next = step === 0 ? FONT_PX_DEFAULT : clampFontPx(current + step);
        if (next === current && step !== 0) {
            return toast(`Chat font: already at ${current}px`);
        }
        await setChatFontPx(next);
        toast(`Chat font: ${next}px`);
    }

    // ---------- accessibility ----------------------------------------------
    //
    // One function applies everything the Accessibility pane sets, from the stored
    // settings, and it is the ONLY thing that writes those classes and variables —
    // so the pane's live preview and the app itself can never disagree about what
    // a setting does. Called at boot and after every change.

    function applyAccessibility() {
        const root = document.documentElement;

        // Saturation. Skipped entirely at 100%: a filter creates a containing
        // block, so leaving it on at `saturate(1)` would change how position:fixed
        // resolves for every descendant, for no visual gain.
        const sat = Math.max(0, Math.min(100, parseInt(settings.saturation, 10) || 0)) || 100;
        const isFull = sat >= 100;
        root.classList.toggle('desat', !isFull);
        if (isFull) root.style.removeProperty('--sat');
        else root.style.setProperty('--sat', String(sat / 100));

        root.classList.toggle('high-contrast', !!settings.highContrast);
        root.classList.toggle('no-motion', !!settings.reducedMotion);
        root.classList.toggle('underline-links', !!settings.underlineLinks);

        const density = ['compact', 'default', 'spacious'].includes(settings.uiDensity)
            ? settings.uiDensity : 'default';
        root.dataset.uiDensity = density;

        // Message-group spacing. 16px is the shipped look, so that value clears the
        // override and lets the stylesheet's own em-based margin stand.
        const gap = Math.max(0, Math.min(24, parseInt(settings.msgGroupGap, 10)));
        if (Number.isFinite(gap) && gap !== 16) root.style.setProperty('--msg-gap', gap + 'px');
        else root.style.removeProperty('--msg-gap');

        // The conversation as a live region. 'polite' is the shipped value and is
        // what a screen reader ignores while the user is doing something else;
        // 'assertive' interrupts, which is what somebody who asked for this wants.
        const msgs = $('messages');
        if (msgs) msgs.setAttribute('aria-live', settings.announceMessages ? 'assertive' : 'polite');
    }

    // Zoom lives in the main process (webFrame needs node in the renderer, which
    // this app does not have). Answers with what was actually applied.
    async function applyZoom() {
        const want = Math.max(50, Math.min(200, parseInt(settings.zoomLevel, 10) || 100));
        try {
            const got = await L.app.setZoom(want);
            if (got && got !== want) await saveSettings({ zoomLevel: got });
        } catch (e) { /* an older main process has no such channel */ }
    }

    // The labelled scale above a slider. Positions are percentages of the track,
    // so the labels line up with the input's own stops at any width.
    const TICKS = {
        'ticks-font': { min: 12, max: 24, at: [12, 14, 15, 16, 18, 20, 24], suffix: 'px' },
        'ticks-gap': { min: 0, max: 24, at: [0, 4, 8, 16, 24], suffix: 'px' },
        'ticks-zoom': { min: 50, max: 200, at: [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200], suffix: '' },
        'ticks-sat': { min: 0, max: 100, at: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100], suffix: '%' }
    };

    function paintTicks(id, value) {
        const host = $(id);
        const spec = TICKS[id];
        if (!host || !spec) return;
        const span = spec.max - spec.min;
        // Rebuilt only when it has to be: the marks never change, so dragging a
        // slider just moves which one is highlighted.
        if (!host.children.length) {
            spec.at.forEach((v) => {
                const t = document.createElement('span');
                t.className = 'set-tick';
                t.dataset.v = String(v);
                t.textContent = v + spec.suffix;
                // Inset at the ends so the first and last labels stay inside the
                // column instead of hanging off it.
                const pct = ((v - spec.min) / span) * 100;
                t.style.left = Math.max(2, Math.min(98, pct)) + '%';
                host.appendChild(t);
            });
        }
        // Nearest mark, so a value between two of them still lights the one it is
        // closest to rather than none at all.
        let nearest = spec.at[0];
        spec.at.forEach((v) => {
            if (Math.abs(v - value) < Math.abs(nearest - value)) nearest = v;
        });
        Array.from(host.children).forEach((t) => {
            t.classList.toggle('on', Number(t.dataset.v) === nearest);
        });
    }

    // The live preview: REAL message rows through renderMessage(), so every
    // setting on this pane is demonstrated by the thing it actually changes. Two
    // fixed messages rather than the channel's own, because the pane has to look
    // the same on an empty board as on a busy one.
    const A11Y_PREVIEW_POSTS = [
        {
            id: -101, name: 'Scarmonit', client_id: 'preview-a', user_id: -1,
            body: 'what happened to all the beans',
            created_at: 1700000000000, pinned: 0, reply_count: 0,
            reactions: [{ emoji: '🫘', count: 3, who: [] }, { emoji: '🎉', count: 1, who: [] }]
        },
        {
            id: -102, name: 'Scarmonit', client_id: 'preview-a', user_id: -1,
            body: "here's a link https://scarmonit.com/messageboard and some **bold** text",
            created_at: 1700000060000, pinned: 0, reply_count: 0, reactions: []
        }
    ];

    function renderA11yPreview() {
        const host = $('a11y-preview-msgs');
        if (!host) return;
        // Only while somebody is looking at it. applyChatFontSize runs at boot and
        // on every Ctrl+= — rebuilding two message rows behind a closed sheet each
        // time is work nobody asked for.
        const pane = host.closest('.set-group');
        if (!pane || pane.hidden) return;
        host.innerHTML = '';
        let prev = null;
        A11Y_PREVIEW_POSTS.forEach((p) => {
            // Through the real renderer, in the real density — grouped exactly as
            // the message list would group them.
            const row = renderMessage(p, prev);
            host.appendChild(row);
            prev = p;
        });
        highlightCodeBlocks(host);
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

    function openDialog({ title, message, value, ok, danger, withInput, label2, value2, placeholder,
                          inputType, maxLength, placeholder2, maxLength2, noCancel }) {
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
            // Reset every time rather than only when asked: this field is
            // shared by every dialog, so a password type left behind by the
            // last caller would silently turn the next rename into dots.
            inp.type = inputType || 'text';
            inp.maxLength = maxLength || 60;
            // Optional second field (the name editor uses it for the status).
            const lab2 = $('dialog-label2'), inp2 = $('dialog-input2');
            lab2.textContent = label2 || '';
            lab2.hidden = !label2;
            inp2.hidden = !label2;
            inp2.value = value2 || '';
            inp2.placeholder = placeholder2 || '';
            inp2.maxLength = maxLength2 || 80;
            $('dialog-ok').textContent = ok || 'OK';
            $('dialog-ok').classList.toggle('danger', !!danger);
            // `noCancel` is for a dialog that ANNOUNCES rather than asks — the
            // role-change notice, where there is nothing to decline and a Cancel
            // button would imply the change had not already happened. Reset every
            // time, because this element is shared by every dialog.
            $('dialog-cancel').hidden = !!noCancel;
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
    // Tell the user something, with one button to dismiss it. No Cancel: there is
    // nothing to decline, because whatever it describes has already happened.
    function tellUser(title, message, ok) {
        return openDialog({ title, message, ok: ok || 'OK', withInput: false, noCancel: true });
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

    // The input gain lives in soundboard.js's mic graph (see ScarmMic), which is
    // built fresh on every getUserMedia. It is applied BEFORE the track is
    // published, so it decides how loud everyone ELSE hears you — which is
    // exactly why a session that never pushed it started at 100% no matter what
    // the slider said. saveSettings was the only caller, so the stored value was
    // ignored for the whole of any launch in which nothing happened to be saved:
    // join voice straight from a cold start and the room got you at full volume.
    function applyMicGain() {
        if (!window.ScarmMic) return;
        window.ScarmMic.setGain(settings.micVolume === undefined ? 1 : settings.micVolume);
    }

    async function saveSettings(patch) {
        settings = await L.settings.set(patch);
        if (voice) voice.setSettings(settings);
        if (window.loungeSounds) window.loungeSounds.setSettings(settings);
        applyMicGain();
        return settings;
    }

    // ---------- auth ------------------------------------------------------

    async function boot() {
        // The real focus state, once. A 'focus' event fired before this file
        // attached its listener is lost, and a window that starts hidden in the
        // tray never fires one at all — see the note on `windowFocused`.
        try { windowFocused = !!(await L.win.isFocused()); } catch (e) { /* keep false */ }
        settings = await L.settings.get();
        $('set-version').textContent = 'ScarmVoice v' + (await L.app.version());

        // The card is hidden in markup so a launch that is already signed in
        // never paints a sign-in screen it is about to discard. It must not be
        // withheld for the length of a request that is never going to answer,
        // though: net.js gives up after twenty seconds, and a captive portal or
        // a half-connected VPN would otherwise leave a blank window for all of
        // it. Past this deadline the card is the honest thing to show — and if
        // the check then comes back authed, enterApp() hides it again, which is
        // exactly what happened on every launch before this change.
        //
        // focusLogin() rather than focus(), so a late deadline cannot pull the
        // caret out of a field somebody has already started typing in.
        const cardDeadline = setTimeout(() => {
            $('login').hidden = false;
            focusLogin('login-pw');
        }, 400);
        const st = await L.auth.status();
        clearTimeout(cardDeadline);

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

    // Set when the answer in `account` came from a real account/me that landed
    // moments ago, so enterApp() does not immediately ask the same question
    // again. Consumed exactly once — see refreshAccount().
    let accountJustFetched = false;

    async function accountGate() {
        let res = null;
        try {
            res = await L.account.me();
            if (res && res.success && res.user) {
                account = res.user;
                accountJustFetched = true;
                return true;
            }
        } catch (e) { /* handled below, same as a returned failure */ }

        // "I could not ASK" is not "you have no account".
        //
        // board() answers a Worker exception page, an edge 502 or a 20-second
        // deadline with { success: false, network: true } rather than throwing, and
        // that fell into the same branch as a genuinely missing account: the sign-in
        // panel, with its error line deliberately BLANKED by showAccountStep(). So a
        // transient edge hiccup put someone in front of an empty username field with
        // no indication anything had failed, for an account whose token was still on
        // disk and still valid — and if it had 2FA they needed a code as well. Anyone
        // who no longer remembered that password was locked out of an app they were
        // signed into, with nothing on screen to suggest that quitting and
        // relaunching in a minute was the answer.
        //
        // The sign-in panel is still offered — it is a real way forward if the
        // outage lasts — but the copy says which of the two situations this is, and
        // the error line is written AFTER showAccountStep(), which blanks it.
        showAccountStep();
        if (!res || res.network || res.offline) {
            $('login-sub').textContent = 'Could not reach the server';
            $('login-error').textContent =
                'Your sign-in is still saved — quitting and reopening in a moment should be enough. ' +
                'Signing in below also works.';
        }
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
            if (account.role === 'owner') toast('Account verified — you are the board owner');
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
            if (register && account.role === 'owner') {
                toast('Account created — you are the board owner');
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

    $('login-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = $('login-btn');
        const err = $('login-error');

        err.textContent = '';
        btn.disabled = true;
        btn.textContent = 'Connecting…';

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

    // Unread watermarks — "the newest message id I have seen in each channel".
    //
    // Stored PER ACCOUNT. They used to live under one unkeyed localStorage entry
    // per machine, and localStorage is per-origin, not per-user, so on a shared
    // computer the second person to sign in inherited the first person's
    // watermarks: every channel the first had read showed nothing new, and every
    // channel they had NOT read counted from wherever that person left off. Both
    // directions are wrong, and the badge is the only thing that says where to
    // look.
    //
    // The legacy unkeyed value is adopted ONCE, by the first account to sign in
    // after this shipped, and then removed — that account is overwhelmingly the
    // person whose watermarks they are, and leaving the value behind would hand a
    // copy to everyone else who signs in afterwards.
    const READS_LEGACY_KEY = 'lounge_reads';
    function readsKey() {
        return 'lounge_reads:' + ((account && account.id) || 0);
    }

    function loadReads() {
        const key = readsKey();
        let raw = null;
        try { raw = localStorage.getItem(key); } catch (e) { /* storage unavailable */ }
        if (raw == null) {
            try {
                const legacy = localStorage.getItem(READS_LEGACY_KEY);
                if (legacy != null) {
                    raw = legacy;
                    localStorage.setItem(key, legacy);
                    localStorage.removeItem(READS_LEGACY_KEY);
                }
            } catch (e) { /* nothing to adopt */ }
        }
        try { reads = JSON.parse(raw || '{}'); } catch (e) { reads = {}; }
        if (!reads || typeof reads !== 'object') reads = {};
    }

    function saveReads() {
        try { localStorage.setItem(readsKey(), JSON.stringify(reads)); } catch (e) {}
    }

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
            loadReads();
            // Anything left queued by a previous session goes out as soon as the
            // first successful poll proves we're online.
            loadOutbox();

            applyChatFontSize(currentFontPx());
            applyAccessibility();
            applyZoom();
            applyChrome();
            initPaneResizing();
            setChannelTitle(channel);
            warnIfElevated();
            window.loungeSounds.init(settings);
            window.ScarmNoise.setEnabled(!!settings.noiseSuppressionAI);
            window.ScarmNoise.onFailure(handleNoiseFailure);
            // Before setupVoice(), so a call joined from a cold start (autoJoin,
            // or simply the first click) publishes at the level that is saved.
            applyMicGain();
            setupVoice();
            renderMe();
            // BEFORE the socket opens: this registers the install against the
            // account, and the realtime upgrade resolves that mapping server-side
            // to merge your devices. A socket opened first would carry no identity.
            await refreshAccount();
            await L.rt.start();

            // Three independent round trips that used to run strictly one after
            // another, for no reason beyond having been written on separate
            // lines. None of them needs any of the others, and each is a trip to
            // Cloudflare — measured at a ~44ms median from here — so the chain
            // cost the better part of a tenth of a second of dead time before
            // the first message could be drawn.
            //
            // Started together; the ORDER OF THE RENDERS below is unchanged,
            // which is the part that actually mattered.
            const emojiReady = loadCustomEmoji();
            const avatarsReady = loadAvatars();
            const channelsReady = loadChannels();

            // The first page of messages belongs in that burst too. It depends
            // on none of the three — only its RENDER does, and that still
            // happens below, after they have landed. Waiting to ASK cost a
            // whole extra round trip in front of the one thing the user is
            // actually here to see.
            //
            // `primary` keeps the read-your-writes freshness that the old
            // ordering got by accident: loadChannels() is a POST, and running
            // after it meant this read was served by the primary. Issued
            // alongside it, that no longer happens for free, so it is asked
            // for. The channel travels WITH the request — a switch during the
            // burst must not merge this page into a different channel.
            const firstPage = {
                channel,
                res: L.board('list', { query: { channel, limit: PAGE, before: null }, primary: true })
            };
            // Awaited at loadMessages() below; held here only so a rejection
            // that beats it cannot surface as an unhandled rejection.
            firstPage.res.catch(() => {});

            // Still awaited before the first render, exactly as before: a
            // message drawn without the emoji set shows `:shrug:` as text, and a
            // face drawn without the avatar map falls back to initials.
            await Promise.all([emojiReady, avatarsReady]);
            // renderMe() and the account card ran before the map existed (they
            // are part of the shell, drawn as soon as settings load), so they
            // need the repaint the message list gets for free by rendering after
            // this point.
            renderMe();
            renderAccountCard();
            await channelsReady;
            // AFTER the channel list (it carries the true unread count for this
            // channel, counted server-side against the watermark that went out
            // with the request) and BEFORE the first page lands, because that is
            // what overwrites the watermark. This is the launch case: the app
            // opens on the channel you left it on, and the bar is how you find
            // out what happened there while it was closed.
            enterUnread();
            await loadMessages(true, null, firstPage);
            startPolling();
            startTextPresence();
            loadDmThreads();
            startDmPolling();
            await applyPtt();
            flushOutbox();

            // Somebody else changing their picture is not worth a poll of its
            // own — it happens about as often as people change their haircut.
            // Your own change repaints immediately; this catches everyone else's.
            //
            // Held, and cleared by teardownSession, like every other timer here.
            // Unheld it survived sign-out and a second one was armed by the next
            // enterApp(), so each sign-in cycle left another five-minute board
            // call running from behind the login card for the life of the app.
            clearInterval(avatarTimer);
            // The account directory rides along: it feeds the member list's
            // Offline section, and it changes about as often as somebody's
            // haircut for exactly the same reason the avatars do.
            avatarTimer = setInterval(() => { refreshAvatars(); loadRoster(); }, 5 * 60 * 1000);
            // Not awaited, and after the first render on purpose: the people
            // who are HERE are the ones worth drawing first, and the absent
            // ones can arrive a round trip later without anything moving.
            loadRoster();

            if (settings.autoJoinVoice) joinVoice();
            // Measured: the very first join paid 1389ms in sdk.init against
            // 730ms for the ones after it, because the click beat the warm-up to
            // the noise model. Run it as soon as the main thread is free rather
            // than on a fixed delay, so the first join is not the slow one.
            else if (window.requestIdleCallback) requestIdleCallback(warmVoice, { timeout: 2000 });
            else setTimeout(warmVoice, 1200);
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
                (can('channel.rename') ? `<span class="chan-act" role="button" tabindex="0" data-act="edit" data-tip="Edit Channel">${I('gear')}</span>` : '') +
                '</span>';
            const runAct = (act) => {
                const r = act.getBoundingClientRect();
                if (act.dataset.act === 'edit') {
                    // Straight to the rename, which is what "edit channel" means
                    // here: everything else about a channel is on the menu.
                    switchChannel(c.name).then(renameChannel);
                    return;
                }
                openChannelMenu(c.name, r.left, r.bottom + 4);
            };
            b.addEventListener('click', (e) => {
                const act = e.target.closest && e.target.closest('.chan-act');
                if (!act) return switchChannel(c.name);
                e.stopPropagation();
                runAct(act);
            });
            // The bell and the gear declare themselves focusable and say they are
            // buttons, and then had no key handler at all — so tabbing to one and
            // pressing Enter or Space did nothing, which is worse than not being
            // reachable: the focus ring promises an action that isn't there. A
            // <span role="button"> gets no implicit key activation; only a real
            // <button> does, and one cannot be nested inside the row's button.
            b.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                const act = e.target.closest && e.target.closest('.chan-act');
                if (!act) return;                    // the row itself is a real button
                e.preventDefault();
                e.stopPropagation();
                runAct(act);
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

        // The DM button carries only its own count. Folding DMs into the server
        // badge alone would leave the button that opens them silent about them.
        const dmBadge = $('rail-dm-badge');
        if (dmBadge) {
            dmBadge.textContent = dmN > 99 ? '99+' : String(dmN);
            dmBadge.hidden = !dmN;
        }

        setTaskbarBadge(alerting);
    }

    // The same total, drawn onto the Windows taskbar button so unread messages
    // are visible when the window is minimised or hidden in the tray. Muted
    // channels are excluded — they are muted precisely so they don't nag.
    let lastTaskbarBadge = -1;
    let lastTaskbarFlash = null;
    function setTaskbarBadge(total) {
        // Two settings, two answers — deliberately not folded together. Somebody
        // can want the count without the button pulsing at them, and Badges off
        // must not stop the flash the other switch is still asking for.
        const n = (isDnd() || settings.badgeUnread === false) ? 0 : Math.max(0, total | 0);
        const flash = !isDnd() && settings.taskbarFlash !== false;
        if (n === lastTaskbarBadge && flash === lastTaskbarFlash) return;   // don't re-flash on every render
        lastTaskbarBadge = n;
        lastTaskbarFlash = flash;
        L.app.setBadge(n, flash);
    }

    // Channel name only — the '#' is a separate glyph in the header.
    function setChannelTitle(name) {
        // `ch-search-text` is a CLASS on #search-input, never an id, so this
        // looked up null on every switch and the label it exists to write was
        // never written. It is also an <input>: textContent paints nothing
        // there, so both halves had to change, not just the selector.
        const box = $('search-input');
        const server = document.querySelector('#server-head .sh-name');
        if (box) box.placeholder = 'Search ' + ((server && server.textContent) || 'ScarmVoice');
        $('chan-title').textContent = name;
        $('composer-input').placeholder = 'Message #' + name;
    }

    // Everything that has to be forgotten when the conversation on screen is
    // replaced. Rename and delete used to skip all of it and just reassign
    // `channel`, which left the old channel's posts in `posts` — and since post
    // ids are global, the refresh merge kept every one of them that was older
    // than the new channel's newest page, rendering them inline as ghosts.
    // channel name -> { posts, hasMore } as it was when you left it, so going
    // back paints immediately instead of showing an empty column for a round
    // trip. Never the source of truth: the fetch always runs and always wins.
    //
    // Bounded, and by insertion order — a Map iterates oldest-first, so
    // deleting the first key is a least-recently-touched eviction. Five pages
    // of at most PAGE posts each is a few hundred KB in the worst case.
    const CHANNEL_CACHE_MAX = 5;
    const channelCache = new Map();
    // Set for exactly one loadMessagesOnce: the page it is about to merge is
    // one the reader has already seen, so it must not chime for it.
    let restoredFromCache = false;

    function rememberChannel(name, list, more) {
        if (!name || !list || !list.length) return;
        channelCache.delete(name);
        channelCache.set(name, { posts: list, hasMore: more });
        if (channelCache.size > CHANNEL_CACHE_MAX) {
            channelCache.delete(channelCache.keys().next().value);
        }
    }

    function resetChannelView() {
        posts = [];
        following = true;
        seenTopId = 0;
        hasMore = true;
        // Where this channel was last caught up to, captured NOW — before the
        // first load overwrites it. See enterUnread().
        enterUnread();
        // Typing belongs to the channel being LEFT. The poll used to overwrite
        // this set wholesale with an answer scoped to the new channel, so it was
        // cleared as a side effect; now that the socket's live set is authoritative
        // (see loadMessagesOnce) nothing else would drop it, and someone still
        // typing in the old channel would appear to be typing in this one until
        // their expiry timer ran out.
        typingUsers.forEach((t) => clearTypingExpiry(t.client_id));
        typingUsers = [];
        renderTyping();          // in this frame, not when the fetch lands
        // The saved pre-filter offset belongs to the channel being left. Kept,
        // it gets replayed into the NEXT channel when the filter clears — a
        // scroll to a position that means nothing in the conversation it lands
        // in.
        filterScrollTop = null;
        clearReply();            // the quoted message lives in the old channel
        cancelEdit();            // an editor left open would freeze renderMessages()
        if (threadOpen()) closeThread();
        // The pinned panel is per-channel, and nothing ever repainted it on a
        // switch: it sat over the new conversation still listing #general's
        // messages, and clicking one yanked the reader into a channel they had
        // just left. Closed rather than redrawn now that it is a popover — a
        // panel you opened over one conversation is not an answer about the next
        // one, and the reference closes it on a channel change too.
        if (!$('pinned-panel').hidden) togglePinned(false);
        // Both header popouts are about the channel being left, for the same
        // reason the pinned panel is: a thread list or a mute setting you opened
        // over one conversation is not an answer about the next one.
        if (!$('notif-pop').hidden) closeNotifPop();
        if (!$('threads-pop').hidden) closeThreadsPop();
    }

    async function switchChannel(name) {
        // Leaving a DM is part of picking a channel, and it has to happen
        // BEFORE the early return. `channel` still holds whatever was open
        // behind the conversation, so clicking that same channel matched here
        // and did nothing at all — the DM stayed up and the click looked
        // broken. Picking a different one switched the column underneath and
        // left it covered, which looked the same.
        const leavingDm = dmMode || !!dmOpen;
        if (leavingDm) setDmMode(false);
        if (name === channel) {
            if (leavingDm) { setChannelTitle(name); renderChannels(); }
            return;
        }
        // Stash what is leaving BEFORE anything reassigns `channel`, so coming
        // straight back to it is instant.
        rememberChannel(channel, posts, hasMore);

        channel = name;
        setChannelTitle(name);
        resetChannelView();

        // A channel you have already opened this session paints from what you
        // last saw, in this frame, instead of showing an empty column for a
        // round trip. The fetch below still runs and the view still converges
        // on the server's answer within the same time it used to take to show
        // anything at all — this only fills the gap.
        const hit = channelCache.get(name);
        if (hit) {
            channelCache.delete(name);              // re-insert = LRU touch
            channelCache.set(name, hit);
            posts = hit.posts;
            hasMore = hit.hasMore;
            restoredFromCache = true;
        }
        renderMessages();
        renderChannels();
        // renderMessages() never touches scrollTop — the only scroll-to-bottom
        // lives in loadMessagesOnce. Painting the cached list without this
        // leaves it at the PREVIOUS channel's offset and then jumps when the
        // fetch lands, which is worse than the blank it replaces.
        if (hit) { const box = $('messages'); box.scrollTop = box.scrollHeight; }

        // Moved below the paint: this is an IPC round trip, and nothing on
        // screen depends on it having finished.
        await saveSettings({ channel: name });
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
        // The remembered page is filed under a name that no longer exists.
        channelCache.delete(channel);
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
        // Its messages are gone from the server; do not keep painting them.
        channelCache.delete(gone);
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

    // `pre`, when given, is a page already asked for: { channel, res }. Only
    // enterApp() passes one, so it can put the request on the wire alongside the
    // rest of the startup burst instead of behind it.
    async function loadMessages(scrollToEnd, before, pre) {
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
            await loadMessagesOnce(scrollToEnd, before, pre);
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

    async function loadMessagesOnce(scrollToEnd, before, pre) {
        // Pin the channel this request is FOR. The user can switch channels
        // while the request is in flight; merging the response then would
        // interleave the old channel's posts into the new one and stamp the
        // wrong channel's read watermark.
        //
        // With a pre-fetched page that channel is the one the request was
        // ISSUED with, not whichever is live now — reading `channel` here would
        // reintroduce exactly the interleaving this guard exists to stop, for a
        // switch made during the startup burst.
        const forChannel = pre ? pre.channel : channel;
        const res = pre ? await pre.res : await L.board('list', {
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
        //
        // `restoredFromCache` is the other case that has to be skipped, and it
        // exists because of the cache above. Painting a remembered page makes
        // `prevMax` the id of a message the reader has ALREADY seen, so every
        // message that arrived in that channel while they were elsewhere would
        // look fresh to this block and announce itself the moment they came
        // back. Before the cache, prevMax was 0 here and none of it ran — this
        // keeps exactly that behaviour.
        const wasRestored = restoredFromCache;
        if (!before) restoredFromCache = false;
        if (!before && prevMax > 0 && !wasRestored) {
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
                    // "New Message in the channel I'm currently reading", off by
                    // default like the reference: this IS that channel, and you are
                    // looking at it. A mention still chimes either way — being
                    // named is worth a noise even on the screen you are on.
                    //
                    // "Reading" means all four: the window has focus, it is not in
                    // the tray, no drawer is covering the channel, and the view is
                    // at the live edge. Miss any one of them and you are not
                    // looking at the message, so the ordinary chime applies.
                    const watching = windowFocused && !appHidden() &&
                        !threadOpen() && !dmPanelOpen() && nearBottom();
                    const wanted = settings.soundOwnChannel || hasMention || !watching;
                    if (wanted && alertsAllowed(channel, hasMention)) window.loungeSounds.playMessage();
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
        // The socket's typing events are authoritative when it is up: they carry a
        // stop, and each entry gets an expiry timer. The poll's answer is a
        // six-second-old snapshot with neither, so overwriting the live set with it
        // resurrects people the socket has already retired — most visibly the
        // person whose message just arrived, since the refetch that message
        // triggers races the row's own expiry. Names are still learned from it
        // either way, so @mention autocomplete loses nothing.
        const polledTyping = (res.typing || []).filter((t) => t.client_id !== settings.clientId);
        if (!rtConnected) typingUsers = polledTyping;
        polledTyping.forEach((t) => addRosterName(t.name));
        voicePresence = keepKnownUids(res.voice || []);

        if (res.maxId) {
            reads[channel] = res.maxId;
            saveReads();
        }

        const box = $('messages');
        const prevHeight = box.scrollHeight;
        const prevTop = box.scrollTop;
        const anchor = scrollAnchor();

        renderMessages();
        renderTyping();
        renderVoiceRoster();
        // The dropdown's people list is built from `posts` each time it is
        // drawn, so paging back — which the filtered empty state explicitly
        // invites — widens it with no hook needed here.
        if (searchOpen()) renderSearchPop();

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
            // `true`: opened by keyboard, so the menu takes focus and can be walked
            // with the arrows. Without it, Enter produced a menu that could only be
            // dismissed — every item in it was unreachable by the keyboard that had
            // just asked for them, which is the entire point of this handler.
            if (p) openCtxMenu(messageMenuItems(p, current), r.left + 24, r.top + 12, true);
        } else if (e.key === 'Escape' && !$('ctx-menu').hidden) {
            // The menu first: it was opened from this list and closing it is what
            // Escape means while it is up. Without this the key went past it to the
            // document handler, which closed the thread panel instead and left the
            // menu on screen.
            e.preventDefault();
            e.stopPropagation();
            closeCtxMenu();
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
        const banner = $('jump-latest');
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
        // The number alone is meaningless read aloud beside "You're Viewing
        // Older Messages" — say what it counts.
        badge.setAttribute('aria-label', n === 1 ? '1 new message' : n + ' new messages');
        badge.hidden = !n;

        banner.classList.toggle('show', away);
        banner.setAttribute('aria-hidden', away ? 'false' : 'true');
    }

    function jumpToLatest() {
        const box = $('messages');
        const far = box.scrollHeight - box.scrollTop - box.clientHeight > JUMP_INSTANT_PX;
        box.scrollTo({ top: box.scrollHeight, behavior: far ? 'auto' : 'smooth' });
        following = true;
        seenTopId = newestId();
        updateJump();
    }

    // ---------- the scrollbar shows itself while you scroll ------------------
    //
    // The bar is transparent at rest (see styles.css) so a conversation does not
    // carry a permanent piece of chrome down its edge — the reference's hides too.
    // Hover brings it back, and so does actually scrolling, which is the case CSS
    // alone cannot express: a wheel turn over a list is exactly when somebody
    // wants to see where they are.
    //
    // Delegated with ONE capturing listener rather than one per scroller, because
    // scroll does not bubble — and `#dm-messages` and the thread list are rebuilt
    // often enough that per-element listeners would need re-attaching.
    const SCROLLBAR_IDLE_MS = 900;
    const scrollIdle = new WeakMap();
    document.addEventListener('scroll', (e) => {
        const el = e.target;
        if (!el || el.nodeType !== 1 || !el.classList) return;
        el.classList.add('scrolling');
        clearTimeout(scrollIdle.get(el));
        scrollIdle.set(el, setTimeout(() => el.classList.remove('scrolling'), SCROLLBAR_IDLE_MS));
    }, true);

    // ---------- new messages bar -------------------------------------------
    //
    // "12 new messages since 12:38 AM on March 21, 2026", with Mark As Read, at
    // the top of a channel you have come back to. What it needs is a per-channel
    // "last read" position — and the app already had one: `reads` (see loadReads),
    // the map of channel -> newest post id seen, kept per account and sent to
    // /api/board/channels to compute the sidebar's unread badges.
    //
    // What it did NOT have is that value at a moment when it is still useful.
    // loadMessagesOnce writes `reads[channel] = res.maxId` on every load of the
    // channel on screen, which is right for the badge (looking at a channel reads
    // it) and destroys the only record of where you had got to. So the watermark
    // is captured on the way IN, before the first load of the channel can
    // overwrite it, and held for the length of the visit.
    //
    // It clears when the reader says so (Mark As Read), when they leave the
    // channel, and when they post into it themselves — at which point they are
    // plainly caught up. It deliberately does NOT clear on scrolling to the
    // bottom: this app opens a channel AT the bottom, so that would hide the bar
    // in the one moment it exists to be seen.
    let unreadFrom = 0;         // last post id read on entering the channel; 0 = nothing to say
    let unreadCount = 0;        // the server's count for the channel, if it is bigger than ours

    function enterUnread() {
        unreadFrom = (reads && parseInt(reads[channel], 10)) || 0;
        unreadCount = 0;
        const c = channels.find((x) => x.name === channel);
        if (c) unreadCount = parseInt(c.unread, 10) || 0;
        renderUnreadBar();
    }

    function clearUnread() {
        if (!unreadFrom) return;
        unreadFrom = 0;
        unreadCount = 0;
        renderUnreadBar();
    }

    // The messages that arrived while the reader was away, oldest first. Drawn
    // from `displayedPosts` rather than raw `posts` for the reason updateJump
    // does it: a blocked author's messages are never shown, so counting them
    // promises something the jump can never reveal.
    function unreadPosts() {
        if (!unreadFrom) return [];
        return displayedPosts().filter((p) => p.id > unreadFrom && !wroteByMe(p) && p.id);
    }

    function renderUnreadBar() {
        const bar = $('unread-bar');
        if (!bar) return;
        // Not over a conversation, and not over a filtered list: the bar is about
        // this channel's history, and neither of those is showing it.
        const fresh = (dmMode || dmOpen || filterActive()) ? [] : unreadPosts();
        if (!fresh.length) {
            bar.hidden = true;
            return;
        }
        // The server counted the whole channel; we can only see the page that is
        // loaded. Its number is the true one whenever it is larger — which is
        // exactly the case the loaded page cannot represent.
        const n = Math.max(fresh.length, unreadCount);
        const since = fresh[0].created_at;
        $('unread-text').textContent =
            `${n} new message${n === 1 ? '' : 's'} since ${timeStr(since)} on ${dayStr(since)}`;
        $('unread-jump').dataset.id = String(fresh[0].id);
        bar.hidden = false;
    }

    // Clicking the bar goes to the first message you have not read — the channel
    // opened at the bottom, so without this the bar names messages that are
    // somewhere above and offers no way to reach them.
    $('unread-jump').addEventListener('click', () => {
        const id = parseInt($('unread-jump').dataset.id, 10) || 0;
        const target = posts.find((p) => p.id === id);
        if (target) jumpToPost(target);
    });

    // Mark As Read. Stamps the watermark at the newest message, saves it, takes
    // the bar down, and refreshes the sidebar so the channel's badge agrees.
    $('unread-read').addEventListener('click', async () => {
        const newest = newestId();
        if (newest) {
            reads[channel] = newest;
            saveReads();
        }
        clearUnread();
        const c = channels.find((x) => x.name === channel);
        if (c) { c.unread = 0; renderChannels(); }
        await loadChannels();
    });

    // The BUTTON, not the banner. The banner is a label now, and making the
    // whole thing clickable would mean a stray click while selecting its text
    // threw the reader back to the live edge.
    $('jump-btn').addEventListener('click', jumpToLatest);

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

    // ---------- local echo ---------------------------------------------------
    //
    // A message you just sent, shown immediately, until a server page carries it.
    //
    // Posting used to be write-then-refetch, and the refetch is where it broke:
    // /api/board/list is served from a D1 READ REPLICA, so the page that comes
    // back milliseconds after the write frequently does not contain it yet.
    // Nothing else redraws the channel — the realtime nudge deliberately skips
    // the sender, and with the socket up the fallback poll is a whole minute
    // apart — so your own message was missing from your own screen until you
    // switched channels and came back (which reloads from scratch). Everyone
    // else saw it at once, which is exactly what made it look impossible.
    //
    // The echo carries the REAL id the server just returned, so it occupies the
    // same row key as the eventual server copy: when the page catches up there
    // is no duplicate and no flicker, just a row whose signature changed.
    const ECHO_MAX_MS = 60000;     // a page that never carries it is a deletion
    let selfEchoes = [];

    // Drop echoes the server has caught up on, and any that have outlived the
    // window in which a replica could still be behind.
    function pruneEchoes() {
        if (!selfEchoes.length) return;
        const have = new Set(posts.map((p) => p.id));
        const cutoff = Date.now() - ECHO_MAX_MS;
        selfEchoes = selfEchoes.filter((e) => !have.has(e.id) && e.created_at > cutoff);
    }

    function echoPost(id, body, chan, quoteId, attachment) {
        if (!id) return;
        // `posts` is whatever channel is on screen NOW. An echo for a different
        // one — a queued message flushing, or an upload that outlived a channel
        // switch — must not resolve its quote against a conversation it does
        // not belong to.
        const mine = chan === channel;
        const q = (mine && quoteId) ? posts.find((p) => p.id === quoteId) : null;
        selfEchoes.push({
            id,
            channel: chan,
            client_id: settings.clientId,
            user_id: myUserId() || null,
            name: settings.displayName || 'Anonymous',
            body: body || '',
            created_at: Date.now(),
            pinned: 0,
            reply_count: 0,
            reactions: [],
            quote: q ? { name: q.name, body: q.body, att_name: q.att_name } : null,
            att_key: (attachment && attachment.key) || '',
            att_name: (attachment && attachment.name) || '',
            att_type: (attachment && attachment.type) || '',
            att_size: (attachment && attachment.size) || 0
        });
        renderMessages();
        // Only jump to the live edge when the echo is for the channel being
        // read. flushOutbox() replays a queued message under ITS channel, so an
        // unconditional scroll threw the reader out of their place in a
        // conversation they had never touched — and pinned `following` there.
        if (mine) {
            const box = $('messages');
            box.scrollTop = box.scrollHeight;
            following = true;
            // Writing into a channel is as clear a statement of "I have read this"
            // as pressing Mark As Read, so the bar goes with it. A queued message
            // flushing into a channel the reader is NOT in says nothing about that
            // channel, which is why this sits inside `mine`.
            clearUnread();
        }
        settleScroll();
    }

    // Which type(s) a post satisfies, for filtering.
    const postMatchesFilter = (p) =>
        window.ScarmLib.postMatchesFilter(p, filter, settings.displayName);
    function displayedPosts() {
        // A blocked author's messages are hidden here rather than deleted, so
        // unblocking brings them straight back without a reload.
        const base = Object.keys(blockedMap()).length
            ? posts.filter((p) => !isBlocked(p.client_id))
            : posts;
        if (filterActive()) return base.filter(postMatchesFilter);
        // Anything the server page has not caught up on yet, on the end where it
        // belongs. Hidden while a filter is on, for the same reason queued
        // messages are: this one is about the live conversation.
        pruneEchoes();
        if (!selfEchoes.length) return base;
        const have = new Set(base.map((p) => p.id));
        const extra = selfEchoes.filter((e) => e.channel === channel && !have.has(e.id));
        return extra.length ? base.concat(extra) : base;
    }

    // A stand-in for a body too long to keep putting through JSON.stringify.
    //
    // messageSig runs for EVERY row on EVERY render — a poll, a reaction, a
    // channel repaint — and the signature it builds used to contain the whole
    // message text. At the old 2000-character cap that was free. Uncapped it is
    // not: a 250,000-character paste made every render pass copy and escape a
    // quarter of a megabyte per row, for a string that is then only ever compared
    // for equality and thrown away.
    //
    // Length, both ends and a 32-bit rolling hash. Two different bodies agreeing
    // on all four is not a case that occurs; if it somehow did, the cost is one
    // row not repainting after an edit, not incorrect content.
    const SIG_INLINE_MAX = 4000;
    function bodyKey(body) {
        const s = String(body == null ? '' : body);
        if (s.length <= SIG_INLINE_MAX) return s;
        let h = 5381;
        for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) | 0;
        return s.length + ':' + h + ':' + s.slice(0, 64) + ' ' + s.slice(-64);
    }

    // Everything that can change how one message draws. Two posts with equal
    // signatures produce byte-identical DOM, so the existing node is kept.
    // `grouped` is in here because it depends on the message BEFORE this one:
    // deleting a message can re-group its neighbour without that neighbour
    // itself changing.
    function messageSig(p, grouped, compact) {
        return JSON.stringify([
            p.id, bodyKey(p.body), p.edited_at, p.edited_by, p.pinned, p.reply_count, p.name,
            avatarSrc(p.user_id),
            p.att_key, p.att_name, p.att_size, p.created_at,
            p.quote ? [p.quote.name, p.quote.body, p.quote.att_name, p.quote.missing] : 0,
            p.reactions || 0,
            // Not a property of the post, but it decides how the post DRAWS:
            // both the body and the reaction chips resolve `:name:` against the
            // custom-emoji map. See emojiGen.
            emojiGen,
            // Nor is this, and it is here for the same reason. The action bar is
            // built from the viewer's ROLE — edit, delete and pin on somebody
            // else's message all depend on it — and the list is diffed by
            // signature, so a role that changed mid-session left every row on
            // screen with the buttons it was drawn with. The message repaint after
            // a promotion appeared to do nothing at all.
            account ? account.role : '',
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
        // The count belongs to the box that produced it now, not to a strip
        // that no longer exists.
        $('search-box').dataset.count = active
            ? (list.length + (list.length === 1 ? ' match' : ' matches')) : '';

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
                key: 'intro', sig: channel + '|' + String(can('channel.rename')), make: () => {
                    const e = document.createElement('div');
                    e.className = 'chan-intro';
                    e.innerHTML =
                        '<span class="ci-mark" aria-hidden="true">#</span>' +
                        `<h2 class="ci-title">Welcome to #${esc(channel)}!</h2>` +
                        `<p class="ci-sub">This is the start of the #${esc(channel)} channel.</p>`;
                    // Only offered to somebody who can actually do it: renaming
                    // a channel is admin-and-above, enforced server-side.
                    if (can('channel.rename')) {
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

        // Take the departed rows out BEFORE the walk below, not after it.
        //
        // The cursor only advances when it lands on the node it wanted, so a
        // single doomed node left in its path stops it advancing ever again —
        // and every row after that then gets `insertBefore`d past it. One
        // message deleted near the top, or one row trimmed off the front of a
        // channel you have scrolled back through, therefore re-seated the ENTIRE
        // list: measured in Chromium at 400 moves and 26ms of forced layout,
        // against 0.2ms for the single insertion the change actually was. Which
        // is to say it dropped a frame every time, for nothing.
        const keep = new Set();
        for (const row of rows) keep.add(row.key);
        for (const [key, node] of existing) {
            if (keep.has(key)) continue;
            node.remove();
            existing.delete(key);        // safe to delete the current entry mid-iteration
        }

        let cursor = box.firstElementChild;

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

            if (node === cursor) {
                cursor = cursor.nextElementSibling;  // already in the right place
            } else {
                box.insertBefore(node, cursor);      // moves it if it was elsewhere
            }
        });

        // Here rather than at each call site, so the bar can never disagree with
        // what is on screen — a filter being applied, a page landing, a DM opening
        // over the top all reach it for free. Free when there is nothing unread:
        // unreadPosts() answers with an empty list without touching `posts`.
        renderUnreadBar();
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
            // tries goes back to zero: a manual Retry is the user saying "try
            // properly again", not "have one more of the eight".
            retry.addEventListener('click', () => {
                entry.failed = false; entry.rejected = false;
                entry.tries = 0; entry.lastTryAt = 0;
                flushOutbox();
            });
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
        // A row's id alone does not identify it — see graft(). This is the other
        // half of the key.
        if (p.isDm) el.dataset.dm = '1';

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
        // Reactions, replies and pins read and write the posts table. A DM is
        // not a post, so in a conversation those three are dropped rather than
        // shown and then answered with "Not found" — which is exactly how the
        // delete button behaved before dm/message existed. Copy is local, and
        // edit and delete now have a DM endpoint of their own.
        const dm = !!p.isDm;
        parts.push('<div class="msg-actions">' +
            (dm ? '' : '<button class="msg-act" data-act="react" title="Add a reaction">' + I('smile') + '</button>') +
            (dm ? '' : '<button class="msg-act" data-act="reply" title="Reply">' + I('reply') + '</button>') +
            // Pinning somebody ELSE's message is admin-only server-side
            // (mayModifyPost, via pin.js), so offering the button to a member
            // produced a 403 toast on every message but their own. Gated exactly
            // the way edit and delete already are.
            (dm || !mayPin(p) ? '' : `<button class="msg-act${p.pinned ? ' on' : ''}" data-act="pin" title="${p.pinned ? 'Unpin' : 'Pin'} this message">` + I('pin') + '</button>') +
            '<button class="msg-act" data-act="copy" title="Copy text">' + I('copy') + '</button>' +
            // Editing somebody ELSE's message is a real ability the server has
            // always allowed a moderator (mayModifyPost) and the UI never offered:
            // the hover bar and the right-click menu both gated edit on `mine`, so
            // an admin could DELETE another person's message but not correct it.
            // Titled differently, because rewriting what somebody else said in
            // their name is not the same gesture as fixing your own typo — and it
            // is now recorded on the message itself (see edited_by).
            ((mine || (!dm && can('message.moderate')))
                ? `<button class="msg-act" data-act="edit" title="${mine ? 'Edit message' : 'Edit as moderator'}">` + I('pencil') + '</button>'
                : '') +
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
                // WHO edited it, when it was not the author.
                //
                // A moderator editing somebody else's message left it marked only
                // "(edited)" — indistinguishable from the author changing their own
                // words, while posts.name still shows the author underneath. One of
                // those is a correction and the other is somebody rewriting what
                // you said in your name, so the marker says which. edited_by is set
                // by the server only for a moderator edit and cleared when the
                // author edits their own message afterwards (see edit.js).
                ed.textContent = p.edited_by
                    ? `(edited by ${p.edited_by} · ${editedStamp(p.edited_at)})`
                    : '(edited)';
                // The exact moment on hover either way — the inline stamp is
                // deliberately short, and for your own edit there is no room for one.
                ed.title = 'Edited ' + new Date(p.edited_at).toLocaleString() +
                    (p.edited_by ? ' by ' + p.edited_by : '');
                if (p.edited_by) ed.classList.add('by-mod');
                // INSIDE the last paragraph, not after it.
                //
                // renderBody wraps prose in .msg-para, which is display:block — so
                // appending the marker to textEl made it a block sibling and it
                // landed on a line of its own under the message. The convention
                // everywhere else, this app's own reference included, is a small
                // "(edited)" trailing the last words of the text.
                //
                // Only when the last block IS a paragraph: after a code fence, a
                // list or a quote there is no line to trail, and its own line is
                // then the only sensible place for it.
                const tail = textEl.lastElementChild;
                if (tail && tail.classList.contains('msg-para')) tail.appendChild(ed);
                else textEl.appendChild(ed);
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

    // The one board mutation that used to have no failure branch: a rejected
    // reaction did nothing and said nothing, and — worse — never called
    // authGone(), so an expired session kept a dead button being clicked
    // instead of taking the user back to the sign-in card the way every other
    // action does.
    async function react(postId, emoji) {
        const res = await L.board('react', {
            method: 'POST', body: { postId, emoji, clientId: settings.clientId }
        });
        if (authGone(res)) return;
        if (!res || !res.success) return toast((res && res.error) || 'Could not react', true);
        loadMessages(false);
    }

    // Links open in the system browser. Attachments are saved through the
    // authenticated client — the browser has no way to fetch them itself.
    //
    // Bound to EVERY list renderMessage() draws into, not just the channel one.
    // renderMessage attaches its own listeners per row (the hover actions,
    // reactions, the right-click menu), but these three are delegated — so in
    // the thread panel and in a conversation, clicking an image opened nothing
    // and the download button under an attachment did nothing at all. The
    // right-click menu offered both, which is how it went unnoticed.
    async function onMessageListClick(e) {
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
    }
    ['messages', 'thread-list', 'dm-messages'].forEach((id) => {
        const box = $(id);
        if (box) box.addEventListener('click', onMessageListClick);
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

    // The composer grows to fit what is in it, up to 180px, and then scrolls.
    const COMPOSER_MAX_PX = 180;
    // Past this, the answer is always "the maximum" — and asking anyway is not
    // free. Reading scrollHeight after height:auto forces Chromium to lay out the
    // ENTIRE textarea, and this runs on every keystroke; with the character cap
    // gone the field can hold a quarter of a megabyte, where that measurement is
    // milliseconds of blocked typing per key. 6000 characters cannot fit in 180px
    // at any font size the chat offers, so the measurement is skippable, not
    // merely cached.
    const AUTOSIZE_MEASURE_MAX = 6000;
    function autosize() {
        if (input.value.length > AUTOSIZE_MEASURE_MAX) {
            input.style.height = COMPOSER_MAX_PX + 'px';
            return;
        }
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, COMPOSER_MAX_PX) + 'px';
    }

    input.addEventListener('input', () => {
        autosize();
        updateSendEnabled();
        const now = Date.now();
        // Never while a conversation is open. A DM has no channel to broadcast
        // into, so this announced you as typing in whatever channel happened to
        // be selected behind the drawer — to everyone in it, over the socket AND
        // the HTTP fallback. The submit handler already withholds the matching
        // "stopped typing" signal for exactly this reason; the start of it was
        // still going out.
        if (!dmOpen && input.value.trim() && now - typingSentAt > TYPING_MS) {
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
        // Pinned for the same reason the channel is: the conversation can be
        // closed or switched while the request is in flight, and reading
        // dmOpen after an await would deliver the message somewhere else.
        const forDm = dmOpen ? dmOpen.id : null;

        input.value = '';
        autosize();
        $('btn-send').disabled = true;
        clearStaged();
        clearReply();
        // Typing indicators belong to a channel; a DM has no channel to
        // broadcast into, and sending one told everyone you were typing in
        // whatever channel happened to be selected behind the conversation.
        //
        // BOTH transports, because the start goes out on both. Only the socket
        // stop was sent, so the server's `typing` row survived the send — and the
        // refetch this post triggers on every peer overwrites typingUsers from
        // the poll's answer, which still returns that row for its six-second
        // lifetime. The result was "Alice is typing…" reappearing UNDER Alice's
        // delivered message, with no expiry timer behind it, until the next
        // loadMessages — up to a minute later in a quiet channel.
        if (!forDm) {
            L.rt.sendTyping(channel, true);
            // typing.js deletes by client_id alone, so no channel is needed.
            L.board('typing', { method: 'POST', body: { clientId: settings.clientId, stop: true } });
            // …and the 3s throttle has to forget the send it just made, or the
            // NEXT keystroke is swallowed and someone firing off two quick
            // messages shows as typing for neither.
            typingSentAt = 0;
        }

        // With attachments, the text becomes the first one's caption so a
        // "here's the thing" message stays attached to the thing.
        if (attachments.length) {
            // The caption rides on the first attachment that actually makes it,
            // not blindly on index 0 — otherwise "#1 failed, #2 succeeded"
            // silently lost the typed text.
            let ok = 0;
            let bodyPosted = false;
            const failed = [];
            for (let i = 0; i < attachments.length; i++) {
                const carryBody = !bodyPosted;
                if (await uploadOne(attachments[i], carryBody ? body : '', carryBody ? quoteId : null, forChannel, forDm)) {
                    ok++;
                    if (carryBody) bodyPosted = true;
                } else {
                    failed.push(attachments[i]);
                }
            }
            // A file whose upload failed comes BACK, the same way the caption does
            // a few lines down. clearStaged() runs at submit time — before any
            // upload has been attempted — so a dropped connection halfway through
            // simply destroyed the staged item: a toast, and the file gone from the
            // composer with nothing to press again. For a picked file that means
            // finding it in Explorer a second time; for a pasted screenshot or a
            // voice recording the bytes were the only copy there was.
            //
            // Pushed rather than assigned, because more files can be staged while a
            // long upload is in flight, and prepareStage is re-run because
            // clearStaged already revoked the object URL behind the thumbnail.
            if (failed.length) {
                failed.forEach((it) => {
                    it.url = '';
                    it.prepared = false;
                    staged.push(it);
                    prepareStage(it);        // repaints itself when it finishes
                });
                renderStaged();
                updateSendEnabled();
            }
            if (ok) {
                if (forDm) {
                    await loadDmMessages(true);
                    loadDmThreads();
                } else {
                    announcePosted(forChannel, body);
                    await loadMessages(true);
                }
            }
            if (!bodyPosted && body) {
                input.value = body;      // the caption never went out — give it back
                autosize();
                updateSendEnabled();
            }
            return;
        }

        // A DM is not a post. Everything above this — staging, the caption
        // rule, the upload loop — is shared; only the endpoint differs.
        if (forDm) {
            const dres = await sendDm(body, forDm);
            if (!dres || !dres.success) {
                input.value = body;              // give the text back
                autosize();
                updateSendEnabled();
                toast((dres && dres.error) || 'Could not send the DM', true);
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
        // On screen NOW, from the id the server just handed back — not after a
        // round trip to a replica that may not have the write yet.
        echoPost(res.id, body, forChannel, quoteId, null);
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
    // Automatic sends before a queued message stops trying by itself. Generous
    // — a real outage is measured in poll ticks — but finite, so a message the
    // server chokes on every single time ends up in front of the person who
    // wrote it instead of looping quietly forever.
    const OUTBOX_TRIES = 8;
    // …and no faster than this. The retry clock is the poll, which runs every
    // four seconds while the socket is down, so without a floor the whole budget
    // burns through in half a minute of the edge being unwell.
    const OUTBOX_TRY_SPACING_MS = 15000;
    let outbox = [];
    let outboxSeq = 0;
    let flushingOutbox = false;

    // A queued message belongs to WHOEVER WROTE IT, and only they may send it.
    //
    // The queue is persisted per machine, and flushOutbox() sends whatever is in
    // it with the credential that happens to be current. So a message that was
    // still queued when its author signed out — an outage they gave up on, or a
    // run of 5xx from the edge, both of which leave an entry sitting — went out
    // under the NEXT person to sign in on that computer: their name, their
    // user_id, someone else's words, published to a channel with nobody told.
    // On a shared machine that is somebody's private line in another person's
    // mouth.
    //
    // Stamping the author and dropping foreign entries on load keeps the whole
    // point of the feature — a message survives a crash and a restart for the
    // person who wrote it — while making it impossible to send under an identity
    // that never typed it. Entries written before this existed carry no userId
    // and are kept for their owner's next launch, since dropping them would eat
    // exactly the message the queue was built to protect.
    function loadOutbox() {
        try {
            const raw = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]');
            outbox = Array.isArray(raw) ? raw.slice(-OUTBOX_MAX) : [];
        } catch (e) { outbox = []; }
        const me = (account && account.id) || 0;
        const before = outbox.length;
        outbox = outbox.filter((o) => !o || o.userId == null || o.userId === me);
        if (outbox.length !== before) {
            console.info(`[outbox] dropped ${before - outbox.length} queued message(s) belonging to another account`);
            saveOutbox();
        }
        outbox.forEach((o) => { outboxSeq = Math.max(outboxSeq, Number(o.seq) || 0); });
    }

    // Persisting the queue is best-effort, and it now has a way to fail that it
    // did not have before: a message may be a quarter of a megabyte, so fifty of
    // them do not fit in localStorage's few-megabyte quota. The old single
    // try/catch turned that into "nothing was saved at all" — the whole queue
    // lost on the next launch, including the small entries that would have fitted.
    // So a quota failure sheds the OLDEST entries and tries again, keeping the
    // most recent ones, which is the same rule OUTBOX_MAX applies.
    function saveOutbox() {
        let keep = Math.min(outbox.length, OUTBOX_MAX);
        for (;;) {
            try {
                localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox.slice(-keep)));
                return;
            } catch (e) {
                if (keep <= 1) {
                    // Even one did not fit. Nothing to shed; the in-memory queue
                    // still sends it, this only gives up on surviving a restart.
                    console.warn('[outbox] could not persist the queue:', (e && e.message) || e);
                    try { localStorage.removeItem(OUTBOX_KEY); } catch (e2) {}
                    return;
                }
                keep = Math.floor(keep / 2);
                console.warn(`[outbox] queue too large for storage — persisting the newest ${keep}`);
            }
        }
    }

    function queueOutbox(body, quoteId, chan) {
        const entry = {
            seq: ++outboxSeq,
            id: 'out:' + outboxSeq,
            channel: chan || channel,
            body,
            quoteId: quoteId || null,
            // Who wrote it — see loadOutbox. Without this the queue is a message
            // waiting for any credential at all, rather than for its author's.
            userId: (account && account.id) || 0,
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
                    // The queued row disappears the moment it is sent, so
                    // without an echo the message it became would blink out of
                    // the conversation until the next page carried it.
                    echoPost(res.id, entry.body, entry.channel, entry.quoteId, null);
                    announcePosted(entry.channel, entry.body);
                    continue;
                }

                entry.sending = false;
                if (res && res.network) {
                    // Still offline — leave the rest queued and try again later.
                    //
                    // Bounded, though: net.js now flags an edge 5xx as network
                    // too (it is transient, and marking it rejected stranded a
                    // perfectly good message), and a body that deterministically
                    // makes the Worker throw would otherwise be re-POSTed on
                    // every poll tick for the rest of the session. After
                    // OUTBOX_TRIES it becomes the user's decision, with Retry
                    // and Discard on the row.
                    //
                    // What may NOT count against that budget is a request that
                    // never reached anything (res.offline). The cap exists to
                    // stop a message the SERVER keeps choking on from looping
                    // forever, and a link that is down says nothing whatsoever
                    // about the message. This poll is the retry clock and it
                    // ticks every four seconds while the socket is down, so
                    // counting outages spent the entire budget in thirty-two
                    // seconds: close a laptop lid for half a minute and the
                    // queue — the whole feature — gave up and demanded the
                    // message be re-sent by hand. And even a real answer is
                    // only counted once per TRY_SPACING_MS, so an edge having a
                    // bad minute is an outage rather than eight verdicts.
                    entry.failed = true;
                    const now = Date.now();
                    if (!res.offline && now - (entry.lastTryAt || 0) >= OUTBOX_TRY_SPACING_MS) {
                        entry.lastTryAt = now;
                        entry.tries = (entry.tries || 0) + 1;
                        if (entry.tries >= OUTBOX_TRIES) {
                            entry.rejected = true;
                            entry.error = (res && res.error) || 'Could not send — the server is not answering';
                        }
                    }
                    saveOutbox();
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
        // #upload-progress, NOT #upload-list: renderStaged() empties that one,
        // and these rows have to survive every re-render between the send and
        // the server's answer. See the comment on the element in index.html.
        $('upload-progress').appendChild(row);
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
    // `dmThread` routes the finished upload to a conversation instead of a
    // channel. Everything before the post is identical — the file goes to the
    // same storage either way — which is why voice messages work in a DM too:
    // they are an upload like any other.
    async function uploadOne(item, caption, quoteId, chan, dmThread) {
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

        const attachment = { key: up.key, name: up.name, type: up.type, size: up.size };
        const res = dmThread
            ? await L.board('dm/send', { method: 'POST', body: { thread: dmThread, body: caption || '', attachment } })
            : await L.board('post', {
                method: 'POST',
                body: {
                    body: caption || '',
                    name: settings.displayName || 'Anonymous',
                    clientId: settings.clientId,
                    channel: chan || channel,
                    quoteId: quoteId || null,
                    attachment
                }
            });

        row.remove();
        if (authGone(res)) return false;
        if (!res || !res.success) {
            toast((res && res.error) || 'Could not post the attachment', true);
            return false;
        }
        // Same replica lag as a plain message — an upload you watched finish
        // vanishing off your own screen is worse still.
        if (!dmThread) echoPost(res.id, caption || '', chan || channel, quoteId, attachment);
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
                // The real filesystem path behind this File (see itemFromFile).
                // Dropping it here made uploadOne's `if (item.path)` branch
                // unreachable, so EVERY attachment — the picker's, a drop's, a
                // dropped folder's — was read whole into an ArrayBuffer in this
                // renderer and then structured-cloned across IPC. That is
                // precisely what the stream-from-disk path exists to avoid: it
                // holds the file twice in memory before a byte is sent, and the
                // 1 GB the composer advertises cannot survive the trip.
                path: it.path || '',
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

    // Right-click in a text field: the standard editing actions, and the
    // spellchecker's corrections above them.
    //
    // Electron ships no context menu of its own, so without this the only way to
    // paste is the keyboard. The commands run in the main process as native
    // editing commands on the focused element — that's what makes Paste behave
    // exactly like Ctrl+V, image-on-the-clipboard included, instead of being a
    // second half-implementation of it.
    //
    // MAIN OPENS THIS, and that inversion is the whole spellcheck feature. The
    // misspelled word and its suggestions exist only on main's `context-menu`
    // event, and this used to be a DOM `contextmenu` handler that called
    // preventDefault() — which stops Blink asking the browser process for a menu,
    // so that event never fired and the red underline the app had been drawing all
    // along led nowhere. Main now sends everything the menu needs (see the handler
    // there), which also means Cut/Copy/Paste are gated on Chromium's own
    // editFlags instead of a clipboard round trip, so the menu opens in one hop.
    //
    // It covers EVERY editable field rather than just the composer, because
    // `isEditable` is the only thing main can tell them apart by — and because a
    // text field you cannot paste into is the bug this menu was added to fix, which
    // was equally true of the thread composer, the edit box and the search field.
    L.edit.onContext((m) => {
        if (!m) return;
        // Right-clicking a field focuses it, and #ctx-menu never takes focus (its
        // mousedown is prevented), so the command will land on the right element.
        // Captured anyway, and restored before the command runs, because that
        // invariant is one repaint away from not being true and the failure mode is
        // a menu item that silently does nothing.
        const target = document.activeElement;
        const on = (fn) => () => {
            if (target && target.isConnected && typeof target.focus === 'function') target.focus();
            fn();
        };

        const items = [];
        // EVERY correction, in Chromium's own order of likelihood, each its own
        // item, and bold — the same place and the same weight every browser puts
        // them, because they are the reason the menu was opened and they insert
        // text rather than running a command. "toulp" offers tool, tolu, toil,
        // tools and Toul; picking any one of them rewrites the word.
        if (m.misspelledWord) {
            const suggestions = (m.suggestions || []).filter(Boolean);
            suggestions.forEach((s) => {
                items.push({ label: s, strong: true, onClick: on(() => L.edit.replaceMisspelling(s)) });
            });
            // Chromium finds nothing for a bad enough typo, or for a name. Saying so
            // is better than a menu that silently looks like any other, and it keeps
            // "Add to dictionary" in the same position either way.
            if (!suggestions.length) items.push({ label: 'No suggestions', disabled: true });
            items.push('sep');
            items.push({
                label: 'Add to dictionary', icon: 'plus',
                onClick: on(async () => {
                    if (await L.edit.addToDictionary(m.misspelledWord)) {
                        toast(`Added “${m.misspelledWord}” to your dictionary`);
                    }
                })
            });
            items.push('sep');
        }

        // The standard editing block, in the order every platform menu uses it.
        // Undo/Redo are Chromium's own — the same stack Ctrl+Z drives, so taking a
        // spelling correction back works from either.
        items.push(
            { label: 'Undo', icon: 'undo', disabled: !m.canUndo, onClick: on(() => L.edit.undo()) },
            { label: 'Redo', icon: 'redo', disabled: !m.canRedo, onClick: on(() => L.edit.redo()) },
            'sep',
            { label: 'Cut', icon: 'scissors', disabled: !m.canCut, onClick: on(() => L.edit.cut()) },
            { label: 'Copy', icon: 'copy', disabled: !m.canCopy, onClick: on(() => L.edit.copy()) },
            { label: 'Paste', icon: 'clipboard', disabled: !m.canPaste, onClick: on(() => L.edit.paste()) },
            'sep',
            { label: 'Select all', icon: 'list', disabled: !m.canSelectAll, onClick: on(() => L.edit.selectAll()) }
        );

        openCtxMenu(items, m.x, m.y);
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
            // The microphone the user CHOSE, not whatever Windows calls the
            // default. `{ audio: true }` ignored settings.micDeviceId, so someone
            // with a headset selected in Settings recorded every voice message on
            // their webcam mic — distant and hollow, and auto-sent with nothing on
            // screen naming the device. voice.micTestConstraints() is the same
            // expression the mic test and the call itself use, so this also lines
            // the clip's processing up with how the person sounds in voice.
            stream = await navigator.mediaDevices.getUserMedia(
                voice ? voice.micTestConstraints()
                      : { audio: settings.micDeviceId ? { deviceId: { exact: settings.micDeviceId } } : true });
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
        //
        // `mediaRec` covers the same window from the other side: recording() is
        // still false for the whole of the await above and showRecBar(true) is
        // below it, so NOTHING on screen changes while the device opens — 100-500ms
        // for the first acquisition, more with a cold RNNoise worklet. An impatient
        // or accidental second click therefore started a second acquisition, and
        // whichever landed first had its stream, its MediaRecorder and its 250ms
        // interval overwritten and orphaned: the OS microphone indicator stayed
        // lit for the session, the shared AudioContext never released, and even
        // signing out could not reach them.
        if (gen !== sessionGen || mediaRec) {
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
        // One entry per PERSON, not per install id.
        //
        // The same person reaches this list down two pipes — the socket, which
        // labels them with whatever install id the realtime layer resolved, and
        // the HTTP poll, which uses the id they actually posted under. When those
        // two ids differ (see renderVoiceRoster for how that happens), the
        // client_id check that guards the push below sees two strangers and the
        // line read "XIAIX and XIAIX are typing…".
        //
        // Your own name goes too: the same mismatch means the client_id filter on
        // the poll's list cannot be trusted to have excluded you, and telling
        // someone that they are typing is never useful.
        const me = String(settings.displayName || '').trim().toLowerCase();
        const seen = new Set();
        const names = [];
        typingUsers.forEach((t) => {
            const name = t.name || 'Someone';
            const key = name.trim().toLowerCase();
            if (seen.has(key)) return;
            if (me && key === me) return;
            seen.add(key);
            names.push(name);
        });
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
    let wasJoined = false;      // for the joined -> left transition

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
                // …and so does the panel over it, whose Leave Voice row only
                // exists while there is a call. It self-guards on being open.
                paintMePopover();
                // Leaving the call with the tray open would strand it above an
                // empty voice panel with nothing it can do.
                if (!st.joined) closeSoundboard();


                // Share audio rides its own elements in the voice engine (so a
                // presenter you aren't watching is still audible), and it
                // follows deafen there — the stage <video> is always silent.

                $('stage-quality').value = st.shareQuality;
                $('stage-motion').textContent = st.shareMotion === 'smooth' ? 'Smooth' : 'Sharp';

                L.app.setVoiceState({ inVoice: st.joined, muted: st.muted, deafened: st.deafened });
                L.rt.sendVoice(st.joined, st.muted, st.deafened);

                if (st.joined) startPresence(); else stopPresence();
                // Leaving is the moment to mint the NEXT token. The pointer is
                // usually already inside the voice area when somebody hangs up,
                // so no fresh hover arrives to trigger it — which is how every
                // rejoin ended up paying for a token again.
                if (wasJoined && !st.joined && entered) setTimeout(warmVoice, 400);
                wasJoined = !!st.joined;
                // Nothing emits "stopped speaking" for a meter that was torn
                // down while silent, so the ring is cleared on the way out
                // rather than left behind.
                if (!st.joined) markMeSpeaking(false);
            },
            onShares: (list) => { shareSources = list || []; renderStage(); },
            onCams: (list) => renderCams(list),
            onParticipants: () => renderVoiceRoster(),
            onSpeaking: (cid, on, isLocal) => {
                speaking[cid] = on;
                // Your own avatar in the me bar, which is on screen whether or
                // not the voice list is scrolled into view — and is the one
                // place you look to check that your microphone is working.
                if (isLocal) markMeSpeaking(on);
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
    // Warm everything heavy that sits in front of a call, on the first sign that
    // somebody is heading for one.
    //
    // TWO bundles, and the second is the bigger problem:
    //
    //   • the RealtimeKit SDK, 647 KB read off disk and parsed;
    //   • the RNNoise worklet, 1.9 MB of JavaScript wrapping a WebAssembly
    //     model — which sits directly in front of the MICROPHONE. noise.js
    //     patches getUserMedia, and every acquisition awaits addModule() before
    //     it returns a stream. Joining acquires the microphone, so that compile
    //     was inside the join, every time.
    //
    // Neither is loaded at startup: most sessions never join a call, and 2.5 MB
    // of parse delays the window appearing for everyone. But a pointer landing
    // on the voice channel is a far better guess than "never", and the work then
    // runs in the seconds before the click instead of inside it. Costs a wasted
    // parse when the guess is wrong, against the same parse happening while
    // somebody waits to be connected.
    // TWO different lifetimes here, and conflating them was a bug.
    //
    // The SDK and the noise model are built once and cached for the session, so
    // one latch is right for them. A participant token is CONSUMED by the join
    // that uses it — so latching it meant exactly one join per session got a
    // warm token and every rejoin paid the full ~800ms again. Measured: join 1
    // spent 0ms on the token, joins 2-4 spent 848/790/777ms.
    //
    // voice.warm() is internally idempotent (a token still fresh is reused, and
    // it declines while joined or joining), so calling it freely is safe.
    let voiceWarmed = false;
    function warmVoice() {
        try {
            if (voice && voice.warm) voice.warm();
            if (voiceWarmed) return;
            voiceWarmed = true;
            if (window.ScarmLazy) window.ScarmLazy.realtimekit().catch(() => { voiceWarmed = false; });
            // Only when it is actually switched on — off, wrap() returns the raw
            // stream and none of this is on the path at all.
            if (window.ScarmNoise && settings.noiseSuppressionAI) window.ScarmNoise.warm();
        } catch (e) { voiceWarmed = false; }
    }
    // The whole voice section, not just the button: a bigger target catches the
    // pointer earlier, which is the entire point.
    ['pointerenter', 'focus'].forEach((ev) => {
        const room = $('voice-room');
        if (room) room.addEventListener(ev, warmVoice, true);
        $('btn-join-voice').addEventListener(ev, warmVoice);
    });

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

    // The ring around your own face in the me bar. On the WRAPPER, not the
    // avatar: paintAvatarEl() rewrites the avatar's inline style on every
    // renderMe(), which a call state change triggers, so a ring drawn there
    // would be erased at exactly the wrong moment.
    let meSpeaking = false;
    function markMeSpeaking(on) {
        meSpeaking = !!on;
        const wrap = document.querySelector('#me-bar .me-av-wrap');
        if (wrap) wrap.classList.toggle('speaking', meSpeaking);
    }

    // Keep the speaking ring on camera tiles in sync without a full re-render.
    function markCamSpeaking(cid, on) {
        const tile = camTiles.get(cid);
        if (tile) tile.wrap.classList.toggle('speaking', on);
    }

    $('btn-cam').addEventListener('click', () => { if (voice) voice.toggleCam(); });

    let pickerSources = [];
    // Opens on Applications, like the client this is modelled on: picking a
    // single window is the common case, and "share my whole screen" is the
    // deliberate one.
    let pickerTab = 'window';
    let pickerSelected = null;

    async function openPicker() {
        pickerSelected = null;
        pickerTab = 'window';
        $('picker-go').disabled = true;
        $('picker-audio').checked = settings.shareAudio !== false;
        paintPickerChoice();
        paintPickerQuality();
        $('picker').hidden = false;
        trapFocus($('picker'), {
            label: 'Share your screen',
            initial: document.querySelector('.picker-tab.active')
        });
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
            const on = t.dataset.tab === pickerTab;
            t.classList.toggle('active', on);
            t.setAttribute('aria-selected', on ? 'true' : 'false');
        });
    }

    // The footer's left half: what is about to be shared, and what it will look
    // like at the other end.
    function paintPickerChoice() {
        const s = pickerSources.find((x) => x.id === pickerSelected);
        const name = $('picker-chosen-name');
        name.textContent = s ? s.name : 'Nothing selected';
        name.classList.toggle('none', !s);

        const q = settings.shareQuality || '1080p';
        const smooth = settings.shareMotion === 'smooth';
        $('picker-chosen-sub').textContent =
            `${smooth ? 'Smoother video' : 'Sharper text'} · ${q} · ${smooth ? 60 : 30}fps`;
    }

    // SD is 720p. HD is everything above it — which is why the buttons are not
    // symmetrical: SD always sets 720p, but HD only raises a 720p setting to
    // 1080p and otherwise leaves it alone. Writing 1080p unconditionally would
    // quietly DOWNGRADE somebody running at 1440p every time they opened the
    // picker and pressed the tier they were already on. The gear is where 1440p
    // and the motion setting live.
    function paintPickerQuality() {
        const sd = (settings.shareQuality || '1080p') === '720p';
        $('pq-sd').classList.toggle('active', sd);
        $('pq-hd').classList.toggle('active', !sd);
        $('pq-sd').setAttribute('aria-pressed', String(sd));
        $('pq-hd').setAttribute('aria-pressed', String(!sd));
    }

    async function setPickerQuality(tier) {
        const now = settings.shareQuality || '1080p';
        const next = tier === 'sd' ? '720p' : (now === '720p' ? '1080p' : now);
        if (next !== now) {
            await saveSettings({ shareQuality: next });
            // Takes effect on a share already running, not only the next one.
            if (voice && voice.isSharing()) voice.setShareQuality(next);
        }
        paintPickerQuality();
        paintPickerChoice();
    }

    $('pq-sd').addEventListener('click', () => setPickerQuality('sd'));
    $('pq-hd').addEventListener('click', () => setPickerQuality('hd'));

    // Everything SD/HD cannot say: 1440p, and sharp vs smooth. Closes the
    // picker rather than stacking a second modal on top of it — two focus traps
    // deep, Escape would unwind them in the wrong order.
    $('picker-settings').addEventListener('click', () => {
        closePicker();
        openSettings().then(() => {
            if (showSettingsPane) showSettingsPane(settingsPaneByTitle('Screen share'));
        });
    });

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
            b.setAttribute('aria-pressed', String(pickerSelected === s.id));
            // A source can come back without a thumbnail (a minimised window, a
            // capture Windows refuses). An <img> with no src is drawn as a
            // BROKEN image — a torn-page glyph and a stray outline — so the
            // empty case gets its own box that says what happened.
            b.innerHTML =
                (s.thumbnail
                    ? `<img src="${esc(s.thumbnail)}" alt="">`
                    : '<span class="pick-blank">No preview</span>') +
                '<span class="pick-name">' +
                (s.appIcon ? `<img src="${esc(s.appIcon)}" alt="">` : '') +
                `<span>${esc(s.name)}</span></span>`;
            b.addEventListener('click', () => {
                pickerSelected = s.id;
                $('picker-go').disabled = false;
                renderPicker();
                paintPickerChoice();
            });
            b.addEventListener('dblclick', startPickedShare);
            grid.appendChild(b);
        });
    }

    document.querySelectorAll('.picker-tab').forEach((t) => {
        t.addEventListener('click', () => {
            pickerTab = t.dataset.tab;
            // The selection belongs to the category it was made in — carrying it
            // across meant Share could send a window while the grid showed
            // screens, with nothing on screen saying which one was armed.
            pickerSelected = null;
            $('picker-go').disabled = true;
            renderPickerTabs();
            renderPicker();
            paintPickerChoice();
        });
    });

    function closePicker() {
        releaseFocus($('picker'));
        $('picker').hidden = true;
        L.share.cancel();
    }
    // No X in the corner any more — the categories own the top row. Cancel,
    // Escape (the document handler ranks the picker) and a click on the
    // backdrop are the three ways out.
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

        // A voice-presence row for THIS INSTALL, while this install is not in a
        // call, is a leftover. The server keeps a row for twelve seconds past
        // the last heartbeat, and quitting mid-call leaves one behind — which is
        // exactly what an update does, because it restarts the app out from
        // under whatever you were doing. The new process then came up, polled,
        // found its own stale row and drew ITSELF as sitting in a voice call it
        // had just been restarted out of, until the row aged out.
        //
        // Keyed on the INSTALL id, never the account: this process knows
        // perfectly well whether it is in a call, and knows nothing about the
        // phone in your pocket — which may legitimately be in one, and must
        // still show.
        const joining = !!(voice && voice.isJoining && voice.isJoining());
        const presence = (inCall || joining)
            ? voicePresence
            : voicePresence.filter((p) => p.client_id !== settings.clientId);

        // Install id -> account id. The SFU only knows installs, so this is how
        // a person signed in on two devices stays one row.
        const uidByCid = new Map();
        presence.forEach((p) => { if (p.user_id) uidByCid.set(p.client_id, p.user_id); });
        members.forEach((m) => { if (m.client_id && m.user_id) uidByCid.set(m.client_id, m.user_id); });

        // …and account id by NAME, as the fallback for a participant whose
        // install id nothing else recognises.
        //
        // That is not hypothetical. The realtime layer substitutes an id of its
        // own for any install it cannot verify, so its roster can name the same
        // person by a different id than the SFU and the presence table do — and
        // then the merge below, which keys on the account, had no account to key
        // on for the SFU row and drew that person TWICE. The two sources take
        // turns every few seconds, so the second copy appeared to join and leave
        // on a loop for as long as they stayed in the call.
        //
        // A name is safe to resolve on here, and only here: it is not a
        // credential, it decides nothing but which of two rows for one person to
        // keep, and the server derives it from the account rather than accepting
        // it from the client (see displayNameFor). The failure it can produce is
        // merging two people who genuinely share a display name into one row —
        // strictly better than splitting one person into two, and impossible
        // while names are account usernames.
        const uidByName = new Map();
        const noteName = (name, uid) => {
            const n = String(name || '').trim().toLowerCase();
            if (n && n !== 'anonymous' && uid && !uidByName.has(n)) uidByName.set(n, uid);
        };
        presence.forEach((p) => noteName(p.name, p.user_id));
        members.forEach((m) => noteName(m.name, m.user_id));

        const uidFor = (p) => uidByCid.get(p.id) ||
            uidByName.get(String(p.name || '').trim().toLowerCase()) || null;

        // Deafening is not a thing the SFU knows — it is a local decision about
        // what you HEAR, so it never touches a published track. It travels on
        // the presence layer instead, which means the SFU row for a peer has to
        // pick it up from there or nobody would ever see it.
        //
        // `muted` is NOT taken from presence: the SFU's own view of their
        // published track is both authoritative and immediate, where presence
        // is a five-second heartbeat, and preferring it would leave a muted
        // icon hanging for seconds after somebody unmutes.
        const presByCid = new Map();
        const presByUid = new Map();
        presence.forEach((p) => {
            if (p.client_id) presByCid.set(p.client_id, p);
            if (p.user_id) presByUid.set(p.user_id, p);
        });
        const presFor = (p, uid) => presByCid.get(p.id) || (uid ? presByUid.get(uid) : null);

        live.forEach((p) => {
            const uid = uidFor(p);
            const pres = p.isMe ? null : presFor(p, uid);
            byId.set(p.id, Object.assign({}, p, {
                uid,
                deafened: p.isMe ? p.deafened : !!(pres && pres.deafened)
            }));
        });
        presence.forEach((p) => {
            if (!byId.has(p.client_id)) {
                byId.set(p.client_id, {
                    id: p.client_id,
                    uid: p.user_id || uidByName.get(String(p.name || '').trim().toLowerCase()) || null,
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
        // The open conversation's profile reads the same presence table, so it
        // has to move when the table does — otherwise it says "Online" for the
        // rest of the session after they have gone.
        paintDmProfileStatus();
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
            // Two different facts: they silenced themselves (p.muted, from the
            // SFU) versus I silenced them (localMuted, mine alone).
            const localMuted = !isMe && ((p.localMuted) ||
                (settings.localMuted && settings.localMuted[p.id]));
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
                makeRowActivatable(li, (el, kb) => openPopover(p, el, undefined, undefined, kb));
            } else if (isMe && inCall) {
                // Your own row did nothing at all. Everyone else's opens a
                // popover of things to do to them, so the one row that is you
                // being inert made the list look half-wired — and the only way
                // out of the call was the small hang-up glyph in the panel
                // below, which is not where anyone looks after clicking their
                // own name.
                makeRowActivatable(li, (el) => openSelfVoiceMenu(el));
            }
            ul.appendChild(li);
        });
    }

    // Make a roster <li> a real control.
    //
    // The member list and the voice roster are <li> elements with a click handler
    // and a hover style, and nothing else: no role, no tabindex, no key handler.
    // So per-person volume, "Mute for me" and an admin's "Remove from voice" —
    // which live only inside the popover those rows open — had no keyboard path at
    // all. There is no other route to them anywhere in the app.
    //
    // `keyboard` is passed through so the popover can take focus when it was opened
    // by a key, and leave the pointer alone when it was not.
    function makeRowActivatable(li, open) {
        li.tabIndex = 0;
        li.setAttribute('role', 'button');
        li.addEventListener('click', () => open(li, false));
        li.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();          // Space would scroll the list
            open(li, true);
        });
    }

    // What you can do to YOURSELF in the call. The same three things the voice
    // panel's buttons do, from the row that names you.
    function openSelfVoiceMenu(anchor) {
        if (!voice || !voice.isJoined()) return;
        const r = anchor.getBoundingClientRect();
        // The three lists that can open this sit on OPPOSITE window edges — the
        // voice roster and the member sidebar — so the menu opens away from
        // whichever edge it was summoned from. openCtxMenu clamps, but a menu
        // clamped against the right edge covers the row it belongs to.
        const x = (r.left > window.innerWidth / 2) ? (r.left - 210) : (r.right + 6);
        const muted = voice.isMuted();
        const deafened = voice.isDeafened();
        openCtxMenu([
            { label: muted ? 'Unmute Microphone' : 'Mute Microphone',
                icon: muted ? 'mic' : 'mic-off',
                onClick: () => voice.toggleMuted() },
            { label: deafened ? 'Undeafen' : 'Deafen',
                icon: deafened ? 'headset' : 'headset-off',
                onClick: () => voice.toggleDeafened() },
            'sep',
            { label: 'Leave Voice', icon: 'phone-hangup', danger: true,
                onClick: () => {
                    // Same order the panel's own button uses: the tray goes
                    // before the round trip, so leaving is instant on screen.
                    $('voice-panel').classList.add('is-gone');
                    leaveVoice();
                } }
        ], x, r.top);
    }

    // Everyone present, grouped online / away like Discord's members sidebar.
    // People in the call sort to the top of their group and keep the per-person
    // volume controls.
    // ---------- one vocabulary for "what is this person right now" ----------
    //
    // The presence table says `away`. This app — and the client it is modelled
    // on — calls that Idle. The WIRE VALUE CANNOT CHANGE: that table is shared
    // with the website, both clients write it and both clients read each
    // other's rows, so renaming it here would split one member list into two
    // that disagree. So the translation happens in exactly one place, on the
    // way in, and nothing past it ever sees `away` again — not a label, not a
    // class name, not a sort key.
    //
    // `offline` has no wire value at all, in either direction: being offline is
    // the ABSENCE of a row, which is also why an invisible user is genuinely
    // indistinguishable from an absent one (see sendTextPresence).
    function statusFromWire(s) {
        if (s === 'away') return 'idle';
        if (s === 'dnd') return 'dnd';
        return 'online';
    }
    const STATUS_LABEL = {
        online: 'Online', idle: 'Idle', dnd: 'Do Not Disturb', offline: 'Offline'
    };
    // Green, yellow, red, grey. `online` is the bare class because that is the
    // dot's resting colour.
    const statusDot = (s) => (s === 'online' ? '' : ' ' + s);

    // What the presence table currently says about one ACCOUNT. Anyone it has
    // never heard of is offline — which is the same answer for somebody who
    // signed out an hour ago and somebody who has never opened the app.
    function statusForUser(uid) {
        if (!uid) return 'offline';
        const m = members.find((x) => x.user_id === uid);
        return m ? statusFromWire(m.status) : 'offline';
    }

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
                status: statusFromWire(m.status),
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

        // Everyone with an account who is NOT in the presence table. That is
        // what offline means here — there is no offline row to read, so the
        // answer has to come from the other direction: the account directory
        // minus whoever is currently present.
        //
        // Names are checked as well as ids because a presence row written by an
        // older client can arrive with no user_id, and keying on the id alone
        // would then list that person twice — once present, once offline.
        const seenNames = new Set(rows.map((r) => r.name));
        roster.forEach((u) => {
            if (u.banned) return;
            // You are never offline to yourself. Invisible keeps you out of the
            // presence table on purpose, and this is the one list where that
            // would read as an error rather than as the setting working.
            if (account && u.id === account.id) return;
            if (seen.has('u' + u.id) || seenNames.has(u.username)) return;
            rows.push({
                id: null, uid: u.id, name: u.username,
                status: 'offline', custom: '', voice: null
            });
        });

        // Within a group, whoever is in the call comes first, then alphabetical.
        const byPresence = (a, b) =>
            (a.voice ? 0 : 1) - (b.voice ? 0 : 1) || a.name.localeCompare(b.name);
        // Idle and Do Not Disturb sit in ONLINE, told apart by the colour of
        // their dot — they are here, they are just busy or away from the
        // keyboard. Only offline gets its own section.
        const here = rows.filter((r) => r.status !== 'offline').sort(byPresence);
        const offline = rows.filter((r) => r.status === 'offline')
            .sort((a, b) => a.name.localeCompare(b.name));

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
            li.className = 'vp' + (isMe ? ' me' : '') + statusDot(r.status) +
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
            // An offline row says nothing under the name but the person's own
            // custom status: the section heading above it has already said
            // "Offline", and repeating it on every row is the sort of noise
            // that made the list read as a wall rather than as people.
            const sub = blocked ? 'Blocked'
                : (p ? 'In voice'
                    : (r.custom || (r.status === 'online' || r.status === 'offline'
                        ? '' : STATUS_LABEL[r.status])));
            const dotClass = statusDot(r.status);
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
            // Gated on the TARGET, not on the viewer. It used to require `inCall`
            // — i.e. that *I* had joined — which meant an admin who was not in
            // the call had no way to reach "Remove from voice" at all, on a row
            // that styles itself as clickable and simply did nothing. The
            // local-audio half of the popover is what actually needs a live
            // call, so that is what the last argument turns off.
            const live = !!(p && inCall && !p.remoteOnly);
            if (!isMe) {
                // r.status is the status this list already worked out, handed
                // over so the popover does not have to re-derive it from a
                // presence row an Offline member does not have.
                makeRowActivatable(li, (el, kb) => openPopover(p || r, el, live, r.status, kb));
            } else if (isMe && inCall) {
                // Your own row here did nothing, while the identical row under
                // the voice channel opened the mute/deafen/leave menu. Same
                // person, same call, two different answers depending on which
                // list you happened to click them in.
                makeRowActivatable(li, (el) => openSelfVoiceMenu(el));
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
        group('Online', here);
        group('Offline', offline);
    }

    // ---------- per-participant popover -----------------------------------
    // Opened from either voice list. Same floating surface as the context menu,
    // but it needs a switch and a slider, which a menu of items cannot express.

    let popFor = null;
    // The ACCOUNT behind the open popover, when one is known — the admin
    // actions act on this, never on popFor (an install id).
    let popUid = null;
    // WHICH ROW the popover is open about, for the open/close toggle alone.
    //
    // The toggle used to compare popFor, the install id, and every member in the
    // Offline section is built with `id: null` — so `popFor === p.id` was
    // `null === null` for any offline person while the popover was open about
    // any other offline person. Clicking Dan while Carla's popover was up read
    // as clicking Carla again and closed it; Dan needed a second click, every
    // time. Prefixed so an install id can never collide with an account id.
    let popKey = null;
    const popKeyFor = (p) => (p.id ? 'c' + p.id : (p.uid ? 'u' + p.uid : null));
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

    // `audio` is false when this is opened about somebody who is not in the call
    // with us: the volume slider and "Mute for me" are about a stream that does
    // not exist, and offering them would be two more controls that do nothing.
    // Everything else — mention, block, and the admin actions — still applies.
    // `known` is the status the caller's list has already worked out, used when
    // the presence rows cannot answer — an Offline row has no install id to
    // match on, and defaulting to 'online' drew a green dot one pixel from the
    // grey one on the same person's row behind it.
    // `keyboard` = opened by Enter/Space rather than a click, in which case the
    // panel has to take focus: it holds real controls (the volume slider, Mute for
    // me, the admin actions) and leaving focus on the row behind it would put them
    // out of reach of the very interaction that just asked for them.
    function openPopover(p, anchor, audio, known, keyboard) {
        const pop = $('popover');
        // Clicking the same person again closes it, like every other toggle.
        const key = popKeyFor(p);
        if (key && popKey === key && !pop.hidden) { closePopover(); return; }
        popKey = key;
        popFor = p.id;

        const canAudio = audio !== false;
        $('pop-mute-row').hidden = !canAudio;
        $('pop-vol-head').hidden = !canAudio;
        $('pop-vol').hidden = !canAudio;
        $('pop-audio-sep').hidden = !canAudio;

        paintAvatarEl($('pop-avatar'), p.name, p.uid || uidForClient(p.id));
        $('pop-name').textContent = p.name;

        // The custom status lives in the presence list, not the SFU roster.
        // Matched on install id and then on ACCOUNT, because an Offline row is
        // built from the account directory and carries no install id at all.
        const m = members.find((x) => x.client_id === p.id)
            || (p.uid ? members.find((x) => x.user_id === p.uid) : null);
        // `known` rather than a bare 'online': a directory row passes 'offline',
        // while a voice-roster row that has not heartbeated yet passes nothing
        // and keeps its green dot.
        const status = m ? statusFromWire(m.status) : (known || 'online');
        const sub = (m && m.custom) || (p.muted ? 'Microphone muted'
            : (status === 'online' ? '' : STATUS_LABEL[status]));
        const st = $('pop-status');
        st.textContent = sub;
        st.hidden = !sub;
        $('pop-presence').className = 'pop-presence' + statusDot(status);

        const vol = settings.localVolumes && settings.localVolumes[p.id] !== undefined
            ? Number(settings.localVolumes[p.id]) : 1;
        const pct = Math.round(vol * 100);
        $('pop-vol').value = pct;
        paintPopVolume(pct);
        $('pop-mute').checked = !!(settings.localMuted && settings.localMuted[p.id]);

        const blocked = isBlocked(p.id);
        // settings.blocked is keyed by INSTALL id — it is what isBlocked() is
        // asked about everywhere a message, a roster row or a mention is
        // filtered. A row with no install id therefore has nothing to block, and
        // the button was doing exactly nothing when pressed: the popover closed,
        // no confirmation, no entry in Settings > Blocked, and it still said
        // "Block" next time. Hidden rather than dead, the same way the message
        // menu already drops Block when there is no client_id.
        $('pop-block').hidden = !p.id;
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
        // Two different tiers now, so two different answers. Removing somebody from
        // a call is moderation (admin and above); banning them is an account action
        // and belongs to the owner alone.
        const hasTarget = !!popUid && !isMe;
        const canKick = can('voice.kick') && hasTarget;
        const canBan = can('member.ban') && hasTarget;
        const canModerate = canKick || canBan;

        // Message them. Same account-or-nothing rule as the moderation actions
        // below, and for the same reason: a DM is addressed to an account, so a
        // row that resolves to none has nothing to open. Sits above Mention,
        // because it is the one that takes you somewhere.
        const canDm = !!(account && popUid && !isMe);
        $('pop-dm').hidden = !canDm;
        $('pop-dm-label').textContent = 'Message ' + (p.name || 'them');
        // In voice right now? Only then is there a call to remove them from.
        const inVoice = canKick && voicePresence.some((v) => v.user_id === popUid);
        $('pop-kick').hidden = !inVoice;
        $('pop-ban').hidden = !canBan;
        $('pop-admin-sep').hidden = !(inVoice || canBan);

        pop.hidden = false;              // shown before measuring, so it has a size
        placePopover(pop, anchor);
        if (keyboard) {
            popReturnFocus = anchor || null;
            const first = pop.querySelector('button:not([hidden]), input:not([hidden])');
            if (first) first.focus();
        }
    }

    // The row the popover was opened FROM, when it was opened by keyboard. Closing
    // has to hand focus back, or the caret is left on a hidden node and the next
    // Tab starts again from the top of the document.
    let popReturnFocus = null;

    function closePopover() {
        $('popover').hidden = true;
        popFor = null;
        popKey = null;
        if (popReturnFocus) {
            const back = popReturnFocus;
            popReturnFocus = null;
            try { if (back.isConnected) back.focus(); } catch (e) {}
        }
    }

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

    // popUid is read before closePopover(), the way kick and ban already do it:
    // the popover's identity state belongs to whichever row opened it, and
    // reading it first is what keeps that true if closePopover ever starts
    // clearing more than popFor.
    $('pop-dm').addEventListener('click', () => {
        const uid = popUid;
        closePopover();
        if (uid) messageUser(uid);
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
        if (can('member.setRole')) renderMemberAdmin();
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

    // Every account on the board, present or not. The member list needs it to
    // work out who is OFFLINE, which the presence table cannot answer — it only
    // knows who is here.
    //
    // Deliberately NOT on the presence cadence. This changes when somebody
    // registers, which is a handful of times a year, against a poll every
    // twenty seconds; it is loaded once at startup and refreshed on the same
    // five-minute sweep the avatars use.
    let roster = [];

    async function loadRoster() {
        try {
            const res = await L.board('account/users');
            if (!res || !res.success || !Array.isArray(res.users)) return;
            roster = res.users;
            // The list is already on screen by the time this lands on a cold
            // start, so it has to ask for a repaint rather than assume one.
            renderVoiceRoster();
        } catch (e) { /* the list is still correct, just without the absent */ }
    }

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
        // Away means AWAY: the window is put away, or nobody has touched it in
        // five minutes.
        //
        // `!windowFocused` used to count, which made everyone away almost all of
        // the time — clicking any other window published it within twenty
        // seconds, so the member list showed people as away while they were
        // sitting right there reading it. Blur is not absence; it is the normal
        // state of a chat client you are not typing into at this instant. No
        // other client treats it as away, and this one already has a real idle
        // rule underneath.
        //
        // This line has never fired. document.hidden is frozen at false by
        // backgroundThrottling:false (see appHidden), so "the window is put
        // away" has in practice always been decided by the idle rule below.
        // Left exactly as it is ON PURPOSE: appHidden() would make it work, and
        // making it work means minimising now publishes you as away to
        // everyone — a visible change to what other people see, which belongs
        // in its own change and not in a performance pass.
        if (document.hidden) return 'away';
        if (Date.now() - lastActivity > AWAY_AFTER_MS) return 'away';
        return 'online';
    }
    // What you ARE right now, as opposed to what you CHOSE. They differ in
    // exactly one case: you chose Online and the idle rule has since fired.
    //
    // Your own dot has to show that. Everyone else's copy of you already does —
    // it goes out on the heartbeat — so a green dot on your own face while the
    // member list two inches to the right shows you yellow is the app
    // disagreeing with itself about the same fact. The status PICKER still
    // checks the choice, because that is what a choice is.
    function effectivePresenceMode() {
        const mode = presenceMode();
        if (mode !== 'online') return mode;
        return myPresenceStatus() === 'away' ? 'idle' : 'online';
    }

    // The dot class for a mode, shared by the me-bar, the panel and the menu.
    function presenceDotClass(mode) {
        if (mode === 'idle') return 'idle';
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

        // The idle rule crosses on a clock, with no event behind it — nobody
        // clicks anything to become idle after five minutes. This heartbeat is
        // the tick that notices, so your own dot turns yellow in the same pass
        // that tells everyone else, rather than at the next unrelated repaint.
        const now = effectivePresenceMode();
        if (now !== lastEffectiveMode) {
            lastEffectiveMode = now;
            renderMe();
            if (mePopoverOpen()) paintMePopover();
        }
    }
    let lastEffectiveMode = null;

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
                // Published like `muted` so everyone sees it, and from the same
                // source, so the two can never disagree.
                deafened: voice ? voice.isDeafened() : false,
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
        // `available` is two different situations wearing one name: an update
        // whose download is about to start, and one whose download FAILED and
        // fell back here. Saying "downloading" for the second was a lie the app
        // told for up to three hours, until the periodic recheck happened to
        // pick it up again — with the captured error never shown to anyone.
        available: (s) => (s.stalled ? {
            title: 'Update download failed',
            sub: 'ScarmVoice ' + (s.version || '') + (s.error ? ' — ' + s.error : ''),
            action: 'Try again'
        } : {
            title: 'Update available',
            sub: 'ScarmVoice ' + (s.version || '') + ' — downloading',
            action: 'Downloading…'
        }),
        downloading: (s) => ({
            title: 'Downloading update',
            sub: 'ScarmVoice ' + (s.version || '') + ' \u00b7 ' + (s.progress || 0) + '%',
            action: 'Downloading\u2026'
        }),
        // Nothing here asks permission, and nothing here offers a delay: an
        // update that is ready installs itself and the app comes back on the new
        // version. This card is a statement of what is happening, and it is
        // normally on screen for about a second.
        ready: (s) => {
            const v = 'ScarmVoice ' + (s.version || '');
            // The one thing that can hold it: a call. Then the button is real,
            // because restarting now is a choice only the person in the call
            // can make.
            if (s.waitingFor === 'call') {
                return { title: 'Update ready', sub: v + ' — installs when your call ends', action: 'Restart now' };
            }
            return { title: 'Restarting to update', sub: v, action: 'Restarting…' };
        }
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
        // Pressable in the two cases where there is still something to do: an
        // update held back by a call, and one whose download died and needs
        // starting again. Everything else is narration.
        const heldByCall = updateState.status === 'ready' && updateState.waitingFor === 'call';
        const stalled = updateState.status === 'available' && !!updateState.stalled;
        $('ub-action').disabled = !heldByCall && !stalled;
        $('ub-progress').hidden = updateState.status !== 'downloading';
        if (updateState.status === 'downloading') {
            $('ub-bar').style.width = (updateState.progress || 0) + '%';
        }
        $('ub-notes-toggle').hidden = !hasNotes(updateState);
        showBanner();
    }

    function applyUpdateAction() {
        // "Restart now" on an update a call is holding back — everywhere else
        // the app has already restarted itself.
        if (updateState.status === 'ready') { L.update.install(); return; }
        // …and "Download update", which the release-notes modal offers whenever
        // the state is `available`. That button had no implementation at all:
        // it closed the modal and returned here, which did nothing, so the one
        // state it exists for — a download that errored back to `available`
        // with nothing retrying it for three hours — had a visible, enabled
        // control that could not start the download the IPC was already wired
        // for.
        if (updateState.status === 'available') L.update.download();
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

    // ---- the full release history (Settings > About) ------------------------
    //
    // One <details> per version, so collapsing is the browser's job rather than
    // a class this file has to keep in step — and so keyboard and screen-reader
    // behaviour comes for free. The newest is open, because that is the one
    // somebody opening this pane after an update came to read.
    //
    // Bodies arrive already parsed into the block model (see updater.history),
    // and go through the SAME renderNoteBlocks the update modal uses: built with
    // createElement + textContent, never markup, because this is remote text.

    const HISTORY_SHOWN = 10;       // how many get a section here; see below
    let historyLoaded = false;      // only fetched once per session
    let historyLoading = false;

    function releaseDate(iso) {
        if (!iso) return '';
        const t = Date.parse(iso);
        if (!Number.isFinite(t)) return '';
        try {
            return new Intl.DateTimeFormat([], { year: 'numeric', month: 'short', day: 'numeric' }).format(t);
        } catch (e) { return ''; }
    }

    function renderReleaseHistory(res) {
        const box = $('release-history');
        const sub = $('rn-sub');
        const retry = $('rn-refresh');
        box.innerHTML = '';

        if (!res || !res.ok) {
            retry.hidden = false;
            sub.textContent = (res && res.error)
                ? 'Could not load the release notes — ' + res.error + '.'
                : 'Could not load the release notes.';
            // The link still works when the list does not, which is exactly
            // when somebody most wants it.
            $('rn-more-row').hidden = false;
            return;
        }
        retry.hidden = true;

        const all = res.releases || [];
        if (!all.length) {
            sub.textContent = 'No releases have been published yet.';
            $('rn-more-row').hidden = true;
            return;
        }
        // Ten. Enough to answer "what changed lately" without turning a
        // settings pane into a directory of eighty collapsed rows — and the
        // rest are one click away, already published, under the link below.
        const list = all.slice(0, HISTORY_SHOWN);
        sub.textContent = all.length > list.length
            ? 'The ' + list.length + ' most recent, newest first.'
            : list.length + ' release' + (list.length === 1 ? '' : 's') + ', newest first.';
        $('rn-more-row').hidden = false;

        // The version this build IS, so the entry for it can say so — the single
        // most useful thing this list can tell you.
        const mine = String($('set-version').textContent || '').replace(/^\D+/, '').trim();

        list.forEach((r, i) => {
            const item = document.createElement('details');
            item.className = 'rn-item';
            if (i === 0) item.open = true;

            const head = document.createElement('summary');
            head.className = 'rn-sum';

            const ver = document.createElement('span');
            ver.className = 'rn-ver';
            ver.textContent = 'v' + r.version;
            head.appendChild(ver);

            // The title only earns its place when it says something the version
            // number does not — early releases were published with the version
            // as their name.
            const title = String(r.title || '').replace(/^v?\d+\.\d+\.\d+\s*[—–-]?\s*/, '').trim();
            if (title) {
                const t = document.createElement('span');
                t.className = 'rn-title';
                t.textContent = title;
                head.appendChild(t);
            }

            if (mine && r.version === mine) {
                const badge = document.createElement('span');
                badge.className = 'rn-badge';
                badge.textContent = 'installed';
                head.appendChild(badge);
            }
            if (r.prerelease) {
                const pre = document.createElement('span');
                pre.className = 'rn-badge rn-pre';
                pre.textContent = 'pre-release';
                head.appendChild(pre);
            }

            const when = document.createElement('span');
            when.className = 'rn-date';
            when.textContent = releaseDate(r.date);
            head.appendChild(when);

            item.appendChild(head);

            const body = document.createElement('div');
            body.className = 'rn-body';
            renderNoteBlocks(body, r.blocks);
            item.appendChild(body);

            box.appendChild(item);
        });
    }

    async function loadReleaseHistory(force) {
        if (historyLoading) return;
        if (historyLoaded && !force) return;
        historyLoading = true;
        $('rn-refresh').hidden = true;
        $('rn-sub').textContent = 'Loading…';
        try {
            const res = await L.update.history(!!force);
            historyLoaded = !!(res && res.ok);
            renderReleaseHistory(res);
        } catch (e) {
            renderReleaseHistory({ ok: false, error: (e && e.message) || 'unknown error' });
        } finally {
            historyLoading = false;
        }
    }

    $('rn-refresh').addEventListener('click', () => loadReleaseHistory(true));
    // A real <a> so it reads and copies as a link, opened through the shell —
    // the renderer must never navigate itself (see will-navigate in main.js).
    $('rn-more').addEventListener('click', (e) => {
        e.preventDefault();
        L.app.openExternal(e.currentTarget.getAttribute('href'));
    });

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
        if (connected && !was) { reannounceVoice(); resyncNow(); }
    });

    // Tell the new socket we are in a call, because it has no way to know.
    //
    // The Durable Object keeps its voice roster per SOCKET, in that socket's
    // attachment, and `hello` deliberately carries no voice state. Nothing else
    // re-sends it either: L.rt.sendVoice fires from the voice engine's onState,
    // which only runs when the call state CHANGES. So any reconnect during a
    // call — a laptop lid, a NAT timeout in the tray, the 20s liveness check
    // terminating a half-open socket — silently took the user out of everyone
    // else's realtime voice list, while the 5-second HTTP heartbeat kept putting
    // them back: clients replace their roster from whichever source answered
    // last, so the person flickered in and out of the call for as long as it ran.
    function reannounceVoice() {
        if (!voice) return;
        const st = voice.state();
        if (!st || !st.joined) return;
        L.rt.sendVoice(true, !!st.muted, !!st.deafened);
    }

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
                } else if (m.kind === 'refresh') {
                    // Somebody reacted, edited, deleted or pinned in a channel we
                    // are not reading. There is nothing new to announce: badging
                    // it counts a message that does not exist, and the desktop
                    // notification it used to fire — titled "#channel / New
                    // message" — cannot be taken back. The channel poll picks the
                    // change up whenever we next look at it.
                } else if (!isBlocked(m.cid)) {
                    // Blocking hides someone's messages from the list, so it has
                    // to keep them out of the badge and the notification too —
                    // otherwise a blocked person still lights up the app and
                    // pops their message body onto the desktop.
                    bumpUnread(m.channel);
                    if (!nudgeIsMine(m)) notifyOtherChannel(m);
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
            // The owner changed our role. Unicast by account, so every device this
            // person has open picks it up at once.
            //
            // A role used to take effect only after the affected person logged out
            // and back in, or restarted the app — because every client reads its
            // role exactly once, from account/me at startup, and nothing ever asked
            // again. Being promoted and then having to quit the app to use it is a
            // promotion that has not happened yet.
            case 'role':
                applyRoleChange(m);
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
                        name: v.name, muted: v.muted, deafened: v.deafened
                    }));
                    renderVoiceRoster();
                }
                break;
            case 'dm':
                onDmEvent(m);
                break;
            case 'dm-thread':
                // A group was created, renamed, added to, or someone left it.
                // The change is always to the LIST, and may also be to the
                // conversation on screen — refetching covers both without a
                // branch per variety of change.
                loadDmThreads();
                if (dmOpen && m.thread === dmOpen.id) loadDmMessages(true);
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
                        name: v.name, muted: v.muted, deafened: v.deafened
                    }));
                    renderVoiceRoster();
                }
                break;
        }
    });

    // Did I write the message this socket nudge is about?
    //
    // `cid` is per-INSTALL, so on its own it answers no to everything you post
    // from the phone or from the website — and the desktop then raised a
    // notification for a message you had just finished typing somewhere else,
    // attributed to you by name. wroteByMe() already makes exactly this
    // distinction for the messages the poll brings back; the nudge carries no
    // account id, so the NAME answers it here instead.
    //
    // Safe to resolve on: the display name is the account username, derived by
    // the server from the credential rather than accepted from the client, so
    // nobody else can be wearing it. Same reasoning renderTyping() uses.
    function nudgeIsMine(m) {
        if (!m) return false;
        if (m.cid && m.cid === settings.clientId) return true;
        const me = String(settings.displayName || '').trim().toLowerCase();
        if (!me || me === 'anonymous') return false;
        return String(m.name || '').trim().toLowerCase() === me;
    }

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
            if (appHidden() && rtConnected) return;
            const stick = nearBottom();
            await loadMessages(stick);
            await loadChannels();
            // The poll is also the retry clock for anything queued while the
            // socket was down but before it reported itself as reconnected.
            await flushOutbox();
        }, every);
    }

    // Everything that floats, closed together.
    //
    // #dialog, #lightbox, #picker, #notes, #dm-picker, #popover and #ctx-menu
    // are all SIBLINGS of #app rather than children — which is the whole reason
    // closeSettings() is called from teardown below, and #settings was the only
    // one of the set ever added. Hiding #app does nothing to the rest, so an
    // expired session left them drawn over the sign-in form. Four of them are
    // focus-trapped, and trapFocus() early-returns for an element it still
    // holds: a trap that is never released quietly disables focus management for
    // every later open of that overlay.
    //
    // Two of these are not cosmetic at all:
    //   • the input panel's level meter holds its own getUserMedia stream — the
    //     THIRD microphone in this file, after the call's and the mic test's,
    //     and the only one teardown never released. The OS microphone indicator
    //     stayed lit behind the login card.
    //   • the connection panel repaints on a three-second interval that nothing
    //     else clears, so every session left one more running.
    function closeFloatingUi() {
        closeAudioPops();        // releases the input panel's microphone
        closeConnPop();          // …and its repaint interval
        closeMePopover();
        closePopover();
        closeCtxMenu();
        closeEmojiPop();
        closeSoundboard();
        closePicker();
        closeLightbox();
        closeNotes();
        closeDmPicker();
        // Focus-trapped, a sibling of #app and LATER in the document than
        // #login — so left open it paints over the sign-in card and its Tab
        // trap keeps the password field unreachable.
        closeFiltersModal();
        hideTip();
        // A dialog left open never settles its promise, so whatever was
        // awaiting it is abandoned mid-flight rather than cancelled.
        if (!$('dialog').hidden) closeDialog(inp_null());
        // An attachment clip carries on playing behind the login card otherwise.
        stopOtherAudio(null);
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
        // …and #settings is not the only sibling of #app. See closeFloatingUi().
        closeFloatingUi();
        // Both of these are one-shot coalescing timeouts rather than intervals,
        // so each survives teardown by at most a quarter second — but each then
        // fires a request with no credential, 401s, and calls relogin() again,
        // which re-focuses the password field out from under someone already
        // typing into it.
        if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
        clearTimeout(filterTimer);
        filterTimer = null;
        // The profile-picture sweep. Slow enough that it was easy to miss, but
        // it is a board call on a timer like any other.
        if (avatarTimer) { clearInterval(avatarTimer); avatarTimer = null; }
        // The DM drawer holds its own poll-independent state; leaving it open
        // means the next session starts with a stranger's conversation on screen.
        //
        // The PLACE goes too, not just the conversation: dmMode is not something
        // closeDm() resets, so signing out from inside direct messages — or
        // having the session expire there — left the flag set, and the next
        // sign-in came up in the DM column with the channel sidebar hidden
        // behind a panel whose conversation had been torn down.
        //
        // The LIST goes too. dmThreads is per-account, and every deliberate
        // sign-out clears it by hand — but the two paths that end a session on
        // their own (an expired board session, a dead account token) never did,
        // and teardown is the one thing all four share. enterApp() renders the
        // shell from whatever is in memory before the first fetch answers, so
        // the next person to sign in on this machine was shown the previous
        // account's conversations until it did.
        dmThreads = [];
        setDmMode(false);
        closeDm();
        // …and the drafts it stashed are keyed by thread id, which is global
        // rather than per-account. Kept across a sign-out, the next person to
        // use this machine would find them waiting in a conversation of their
        // own that happened to share the number. (closeDm() has just stashed
        // the open one, so this has to come after it.)
        drafts.clear();
        // Exactly the same argument for the thread composer, which is a
        // separate textarea and so was never covered by `drafts`. closeThread()
        // has already run above and stashed whatever was open, so this is what
        // actually throws it away.
        threadDrafts.clear();
        // Same rule as the drafts: remembered pages are somebody's messages,
        // and the next person to sign in on this machine must not open a
        // channel and find them already painted.
        channelCache.clear();
        // Same rule again, for the two things that are keyed by ACCOUNT rather
        // than merely cached: the unread watermarks and the send queue. Both are
        // re-read from storage by enterApp() under the account that is signing in,
        // but a request still in flight when this ran could otherwise write the
        // outgoing person's state back out under the incoming person's key.
        reads = {};
        outbox = [];
        restoredFromCache = false;
        composerSurface = 'channel';
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

    // The window went to the tray / got minimised, or came back. Sent by
    // main.js on the real window events, because the renderer cannot see this
    // for itself — see appHidden().
    L.win.onHidden((hidden) => {
        windowHidden = !!hidden;
        // Stops the shared 20Hz meter tick (speaking dots, mic-test bar) while
        // there is nothing to draw it on. Its own document.hidden check has
        // never fired, so a call left in the tray kept running one 512-sample
        // RMS loop per participant.
        if (window.ScarmAudio && window.ScarmAudio.setHidden) window.ScarmAudio.setHidden(windowHidden);
        // Pauses the decorative infinite animations (voice signal bars, the
        // live-share dot, the recording pulse). Mid-cycle, so nothing pops when
        // it comes back. An explicit list in styles.css, not a universal
        // selector — that would recalc the whole document on every restore,
        // which is a felt interaction spent to save background work.
        document.documentElement.classList.toggle('win-hidden', windowHidden);
    });

    // The microphone went away mid-capture — unplugged, powered off, revoked.
    // The wrappers in noise.js/soundboard.js end the published track so the SDK
    // can reacquire, but the SDK cannot get the device back while you are muted
    // or on push-to-talk (it only auto-switches an ENABLED track), and it can
    // never get a DIFFERENT one. Until this, none of that reached the user at
    // all: the mic button still read unmuted and the room simply stopped
    // hearing them.
    let micLostAt = 0;
    window.addEventListener('scarm:miclost', () => {
        // One report per incident: the two wrappers are layered, so a single
        // unplug walks through both.
        const now = Date.now();
        if (now - micLostAt < 3000) return;
        micLostAt = now;
        L.app.log('microphone lost mid-capture');
        if (voice && (voice.isJoined() || voice.isJoining())) {
            toast('Your microphone disconnected — reconnect it, or pick another in Settings and rejoin', true);
        } else {
            toast('Your microphone disconnected', true);
        }
    });

    // Restore-from-tray / wake-from-sleep: main verifies the socket (rt.wake)
    // and fires this so we pull anything missed while hidden.
    //
    // The panel refreshes used to live in a `visibilitychange` listener here,
    // which has never once run (see appHidden). This is the event that actually
    // fires on restore/show/focus, so they belong on it: the thread and DM
    // polls skip their ticks while the window is away, and coming back is
    // exactly when whatever they skipped needs to land.
    L.app.onResync(() => {
        resyncNow();
        if (threadOpen()) loadThread(true);
        if (account) {
            loadDmThreads();
            if (dmOpen) loadDmMessages(true);
        }
    });

    // ---------- identity --------------------------------------------------

    function renderMe() {
        const name = settings.displayName || 'Anonymous';
        // Effective, not chosen: auto-idle has to reach your own dot, or it is
        // a state only other people can see you in.
        const mode = effectivePresenceMode();
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
        //
        // Unconditional, because this app has exactly one transport: the SFU.
        // The mesh fallback is the WEBSITE's — voice.js contains no mesh code at
        // all — so no measurement here could ever justify a peer-to-peer claim.
        // The branch that used to make one keyed off `peers > 1`, which counted
        // live RTCPeerConnections rather than people, and mediasoup opens one
        // transport per direction: it was 2 in every call, so the panel told
        // everyone their call was peer-to-peer when none of them ever is. That
        // is precisely the lie the comment above exists to prevent.
        $('cp-crypt').textContent =
            'Encrypted in transit (DTLS-SRTP) — relayed through the voice server';
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
            'peer connections: ' + (c.pcs || 0),
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
        // The dot and the status ROW report what you are — auto-idle included,
        // so this panel agrees with the bar it opened from. The picker below it
        // is the one place that shows the CHOICE, with its check.
        const now = effectivePresenceMode();
        $('mep-presence').className = 'mep-presence ' + presenceDotClass(now);
        $('mep-status-dot').className = 'presence ' + presenceDotClass(now);
        $('mep-status-label').textContent = PRESENCE_LABEL[now];
        // Empty, it still says something: an invitation is the only way anyone
        // finds out the field is there.
        const custom = $('mep-custom');
        custom.classList.toggle('has-status', !!settings.status);
        $('mep-custom-text').textContent = settings.status || "What you're up to";
        custom.setAttribute('data-tip', settings.status ? 'Edit your status' : 'Set a custom status');
        // Nothing to switch to and no id to copy without an account, which
        // leaves that whole card with nothing in it.
        $('mep-menu-account').hidden = !account;
        // And nothing to leave when there is no call.
        $('mep-menu-voice').hidden = !(voice && voice.isJoined());
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

    $('mep-leave-voice').addEventListener('click', () => {
        closeMePopover();
        // Tray first, round trip second — leaving is instant on screen.
        $('voice-panel').classList.add('is-gone');
        leaveVoice();
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
        const gen = sessionGen;
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: settings.micDeviceId ? { deviceId: { exact: settings.micDeviceId } } : true
            });
        } catch (e) { return; }          // no permission, no meter — and no error either
        // The same race startRecording() and startMicTest() both guard against,
        // and the reason they have to: stopApMeter() is a no-op while `apMeter`
        // is still null, so a panel closed — or a session ended — while the
        // capture was opening would assign the stream AFTER the only thing that
        // could release it had already run, with no handle left to reach it.
        // A blurred window closes this panel, so the window is not a small one.
        // `apMeter` is checked for the same reason the mic test checks micTest:
        // the `if (apMeter) return` guard at the top sits IN FRONT of the await,
        // so an open/close/open of the panel inside that window opens a second
        // capture and orphans the first.
        if (gen !== sessionGen || apMeter || $('mic-pop').hidden) {
            try { stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
            return;
        }
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
        if (voice) voice.setPttHeld(false);
        // Same reason as the #set-mode handler: paintVoicePane owns #row-ptt
        // and the Push to Talk switch, both of which this used to leave stale.
        paintVoicePane();
        await applyPtt();
    });

    // To the pane the row names, not to whatever pane opens first.
    const toVoiceSettings = async () => {
        closeAudioPops();
        await openSettings();
        if (showSettingsPane) showSettingsPane(settingsPaneByTitle('Voice & Audio'));
    };
    $('ap-input-settings').addEventListener('click', toVoiceSettings);
    $('ap-output-settings').addEventListener('click', toVoiceSettings);


    // ---------- resizable panels -------------------------------------------
    //
    // Both side panels are draggable by their inner edge, HORIZONTALLY ONLY: the
    // handler reads clientX and nothing else, so there is no vertical drag to start
    // by accident. The width lands in a CSS custom property that the #app grid
    // already uses for its column track, so nothing has to be re-laid-out by hand.
    //
    // THE LIMITS ARE TWO. A static floor and ceiling per panel stop either from
    // being dragged to a width it cannot be used at, or so wide it dominates the
    // window. On top of that a DYNAMIC clamp guarantees the message column keeps
    // MAIN_MIN pixels whatever the window size — that is the requirement that a
    // panel must never crowd out the text area, and a static maximum alone cannot
    // deliver it: 480 + 420 is comfortable at 1900px wide and covers the entire
    // conversation at 1100px. Re-applied on window resize for the same reason,
    // because shrinking the window is the other way to reach that state.
    const SIDEBAR_MIN = 180, SIDEBAR_MAX = 480;
    const MEMBERS_MIN = 160, MEMBERS_MAX = 420;
    const MAIN_MIN = 420;                 // the message column's guaranteed width
    const RAIL_W = 72;                    // the fixed far-left rail

    // The room actually available to a panel, given the window and its opposite
    // number. `other` is the width the panel on the far side is currently taking —
    // 0 when the member list is hidden, which is when the sidebar may be widest.
    function roomFor(other) {
        return Math.max(0, window.innerWidth - RAIL_W - other - MAIN_MIN);
    }

    function membersWidthNow() {
        return $('members-panel').hidden ? 0 : clampMembers(settings.membersWidth, 0);
    }

    function clampSidebar(px, othersWidth) {
        const room = roomFor(othersWidth === undefined ? membersWidthNow() : othersWidth);
        const max = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, room));
        return Math.round(Math.min(max, Math.max(SIDEBAR_MIN, Number(px) || SIDEBAR_MIN)));
    }

    function clampMembers(px, othersWidth) {
        const room = roomFor(othersWidth === undefined ? clampSidebar(settings.sidebarWidth, 0) : othersWidth);
        const max = Math.min(MEMBERS_MAX, Math.max(MEMBERS_MIN, room));
        return Math.round(Math.min(max, Math.max(MEMBERS_MIN, Number(px) || MEMBERS_MIN)));
    }

    // Write both widths to the properties the grid reads. Called on boot, on every
    // drag frame, and on window resize.
    function applyPaneWidths() {
        const root = document.documentElement;
        const members = $('members-panel').hidden ? 0 : clampMembers(settings.membersWidth, 0);
        const side = clampSidebar(settings.sidebarWidth, members);
        root.style.setProperty('--w-side', side + 'px');
        // Left as the stylesheet's value when the panel is hidden: the track is
        // `auto` and the panel is display:none, so the number is unused — and
        // writing 0 would make a later reveal flash at zero width.
        if (!$('members-panel').hidden) root.style.setProperty('--w-members', members + 'px');
        [$('sidebar-resize'), $('dm-sidebar-resize')].forEach((h) => {
            if (h) h.setAttribute('aria-valuenow', String(side));
        });
        const mh = $('members-resize');
        if (mh) mh.setAttribute('aria-valuenow', String(members));
    }

    // One drag, whichever handle started it.
    //
    // Pointer events rather than mouse: they capture, so a drag that leaves the
    // window or crosses an iframe-less overlay still delivers its moves and its up,
    // which a mousemove listener on document does not reliably do once the pointer
    // is outside the window.
    //
    // `dir` is +1 when dragging the handle right widens the panel (the left-hand
    // sidebar) and -1 when it narrows it (the right-hand member list).
    function makeResizable(handleId, dir, read, write, clamp) {
        const handle = $(handleId);
        if (!handle) return;
        handle.setAttribute('role', 'separator');
        handle.setAttribute('aria-orientation', 'vertical');

        let startX = 0, startW = 0, id = null;

        const onMove = (e) => {
            if (id === null || e.pointerId !== id) return;
            // clientX only. There is deliberately no clientY term anywhere in this
            // function: the panels resize horizontally and nothing else.
            const next = clamp(startW + dir * (e.clientX - startX));
            if (next === read()) return;
            write(next);
            applyPaneWidths();
        };

        const end = (e) => {
            if (id === null || (e && e.pointerId !== undefined && e.pointerId !== id)) return;
            try { handle.releasePointerCapture(id); } catch (err) { /* already released */ }
            id = null;
            handle.classList.remove('dragging');
            document.body.classList.remove('resizing-pane');
            // Persisted at the END of the drag, not on every frame: settings.set is
            // an IPC round trip and a debounced whole-file write, and a drag
            // produces one move event per frame.
            saveSettings({ sidebarWidth: settings.sidebarWidth, membersWidth: settings.membersWidth });
        };

        handle.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            id = e.pointerId;
            startX = e.clientX;
            startW = read();
            try { handle.setPointerCapture(id); } catch (err) { /* best effort */ }
            handle.classList.add('dragging');
            document.body.classList.add('resizing-pane');
        });
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
        // The window losing the pointer entirely (alt-tab mid-drag) leaves no up.
        window.addEventListener('blur', () => { if (id !== null) end(null); });

        // Double-click restores the default, which is the cheapest way back from a
        // width somebody dragged and did not like.
        handle.addEventListener('dblclick', () => {
            write(clamp(handleId === 'members-resize' ? DEFAULT_MEMBERS_W : DEFAULT_SIDEBAR_W));
            applyPaneWidths();
            saveSettings({ sidebarWidth: settings.sidebarWidth, membersWidth: settings.membersWidth });
        });

        // A resizer is a real control, so the arrows have to work — it is focusable
        // and announces itself as a separator, and a focus ring that does nothing
        // is worse than no focus ring.
        handle.addEventListener('keydown', (e) => {
            const step = e.shiftKey ? 40 : 10;
            let delta = 0;
            if (e.key === 'ArrowLeft') delta = -step;
            else if (e.key === 'ArrowRight') delta = step;
            else if (e.key === 'Home') delta = -9999;
            else if (e.key === 'End') delta = 9999;
            else return;
            e.preventDefault();
            write(clamp(read() + dir * delta));
            applyPaneWidths();
            saveSettings({ sidebarWidth: settings.sidebarWidth, membersWidth: settings.membersWidth });
        });
    }

    const DEFAULT_SIDEBAR_W = 300, DEFAULT_MEMBERS_W = 264;

    function initPaneResizing() {
        settings.sidebarWidth = clampSidebar(settings.sidebarWidth || DEFAULT_SIDEBAR_W, 0);
        settings.membersWidth = clampMembers(settings.membersWidth || DEFAULT_MEMBERS_W, 0);
        applyPaneWidths();

        ['sidebar-resize', 'dm-sidebar-resize'].forEach((idAttr) => {
            makeResizable(idAttr, 1,
                () => settings.sidebarWidth,
                (v) => { settings.sidebarWidth = v; },
                (v) => clampSidebar(v, membersWidthNow()));
        });
        makeResizable('members-resize', -1,
            () => settings.membersWidth,
            (v) => { settings.membersWidth = v; },
            (v) => clampMembers(v, clampSidebar(settings.sidebarWidth, 0)));

        // Shrinking the window is the other way to squeeze the message column, so
        // the clamp is re-applied rather than only enforced while dragging.
        window.addEventListener('resize', applyPaneWidths);
    }

    // ---------- layout chrome: rail, categories, members sidebar ----------

    function applyMembersPanel(show) {
        $('members-panel').hidden = !show;
        // The sidebar's ceiling depends on whether the member list is taking any
        // room, so hiding it lets the sidebar grow and showing it may have to give
        // some back. applyPaneWidths clamps from `settings` itself, so it is safe to
        // call before initPaneResizing has run — which it is, on the first paint.
        if (settings) applyPaneWidths();
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
    // The rail's server mark is the way BACK, not only a scroll-to-bottom.
    //
    // Direct messages are a place: the DM button swaps the whole second column
    // for them. This button is the other place, and it did nothing about that —
    // it jumped a message list that was not even on screen. So the only way out
    // of DMs was to press the @ again, which is a toggle pretending to be
    // navigation: the button you are already on is not where you look to leave.
    $('rail-home').addEventListener('click', () => {
        if (dmMode) setDmMode(false);
        jumpToLatest();
        input.focus();
    });
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
        // Creating a channel is admin-and-above now — it used to be open to every
        // signed-in member, on the server as well as here. Hidden rather than
        // disabled: a + that never works is not information, and channels.js
        // refuses the call regardless of what this button does.
        $('btn-add-channel').hidden = !can('channel.create');
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

    // ---- muting a channel for a while -------------------------------------
    //
    // A SECOND axis, not a fourth notification level, which is how the reference
    // has it: the level says what this channel is normally worth hearing about,
    // and a mute says "not for the next three hours" without throwing that away.
    // Coming off mute therefore restores whatever the level already was.
    //
    // Stored as channelMuteUntil[name] = epoch ms, or MUTE_FOREVER for "until I
    // turn it back on". Absent means not muted — so a profile that has never
    // touched this is the same as one that has and undone it.
    const MUTE_FOREVER = -1;
    const MUTE_DURATIONS = [
        { label: 'For 15 Minutes', ms: 15 * 60000 },
        { label: 'For 1 Hour', ms: 60 * 60000 },
        { label: 'For 3 Hours', ms: 3 * 60 * 60000 },
        { label: 'For 8 Hours', ms: 8 * 60 * 60000 },
        { label: 'For 24 Hours', ms: 24 * 60 * 60000 },
        { label: 'Until I turn it back on', ms: MUTE_FOREVER }
    ];

    function muteUntilFor(name) {
        const v = (settings.channelMuteUntil || {})[name];
        const n = parseInt(v, 10);
        return Number.isFinite(n) ? n : null;
    }

    // Read-only: it must not write from inside a render or an alert check. Expiry
    // is swept by pruneExpiredMutes on a timer and on every open of the popout.
    function channelMutedNow(name) {
        const until = muteUntilFor(name);
        if (until === null) return false;
        if (until === MUTE_FOREVER) return true;
        return Date.now() < until;
    }

    // "muted for 2h 14m" / "muted until I turn it back on" — the sub-label under
    // Mute Channel, and what the tooltip on a dimmed channel row says.
    function muteRemainingText(name) {
        const until = muteUntilFor(name);
        if (until === null) return '';
        if (until === MUTE_FOREVER) return 'Muted until you turn it back on';
        const left = until - Date.now();
        if (left <= 0) return '';
        const mins = Math.ceil(left / 60000);
        if (mins < 60) return `Muted for ${mins} more minute${mins === 1 ? '' : 's'}`;
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return `Muted for ${h}h${m ? ' ' + m + 'm' : ''} more`;
    }

    async function setChannelMute(name, ms) {
        const map = Object.assign({}, settings.channelMuteUntil || {});
        if (ms === null) delete map[name];
        else map[name] = ms === MUTE_FOREVER ? MUTE_FOREVER : Date.now() + ms;
        await saveSettings({ channelMuteUntil: map });
        renderChannels();
        renderMutedChannels();
        renderNotifPop();
    }

    // Drop entries whose time is up. Runs on a timer because a mute expiring has
    // to show on the channel row and in the badge without anybody clicking
    // anything — and because `channelMutedNow` deliberately does not write.
    async function pruneExpiredMutes() {
        const map = settings.channelMuteUntil || {};
        const now = Date.now();
        const gone = Object.keys(map).filter((k) => {
            const n = parseInt(map[k], 10);
            return Number.isFinite(n) && n !== MUTE_FOREVER && n <= now;
        });
        if (!gone.length) return;
        const next = Object.assign({}, map);
        gone.forEach((k) => { delete next[k]; });
        await saveSettings({ channelMuteUntil: next });
        renderChannels();
        renderMutedChannels();
        if (!$('notif-pop').hidden) renderNotifPop();
        // Silently would be worse: the channel simply starts making noise again
        // and nobody knows why.
        gone.forEach((k) => toast('#' + k + ' is no longer muted'));
    }
    setInterval(() => { pruneExpiredMutes(); }, 30000);

    // One place decides whether anything is allowed to make a noise or a toast.
    // `isMention` is what separates 'mentions' from 'none'; callers that cannot
    // know (a terse cross-channel nudge carries no body) pass false, which is
    // the quiet answer — see notifyOtherChannel.
    function alertsAllowed(channelName, isMention) {
        if (isDnd()) return false;
        // A timed mute outranks the level: that is the whole point of it.
        if (channelName && channelMutedNow(channelName)) return false;
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
    // calm without looking dead. A timed mute counts, or muting a channel would
    // silence it while its row went on looking wide awake.
    function channelQuieted(name) {
        return channelAlertMode(name) !== 'all' || channelMutedNow(name);
    }

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

    // Everything you can do to a channel, in one place — reached by right-click on
    // the channel row and by the bell ON that row, so neither is the only way in.
    //
    // The HEADER's bell opens the notification POPOUT below instead, which is what
    // the reference puts there: mute-for-a-while plus the three levels, and
    // nothing that reshapes the channel.
    function openChannelMenu(name, x, y) {
        const mode = channelAlertMode(name);
        const muted = channelMutedNow(name);
        // Three radio-ish items rather than one toggle: the middle setting is
        // the whole point, and a toggle cannot express it. `check` marks the
        // active one so the menu shows the current state instead of an action
        // whose meaning depends on state you have to remember.
        openCtxMenu([
            muted
                ? { label: 'Unmute channel', icon: 'bell', onClick: () => setChannelMute(name, null) }
                : { label: 'Mute channel…', icon: 'bell-off',
                    onClick: () => openNotifPop(name, lastMenuAt.x, lastMenuAt.y, true) },
            'sep',
            { label: 'All messages', icon: 'bell', check: mode === 'all',
                onClick: () => setChannelAlertMode(name, 'all') },
            { label: 'Only @mentions', icon: 'at', check: mode === 'mentions',
                onClick: () => setChannelAlertMode(name, 'mentions') },
            { label: 'Nothing', icon: 'bell-off', check: mode === 'none',
                onClick: () => setChannelAlertMode(name, 'none') },
            // Reshaping a channel is gated server-side, per operation — renaming
            // is an admin power, DELETING is the owner's, because it drops every
            // message in the channel along with its reactions and attachments and
            // cannot be undone. Offering either to somebody who cannot use it just
            // produces a 403 toast.
            ...(can('channel.rename') || can('channel.delete') ? ['sep'] : []),
            ...(can('channel.rename') ? [
                { label: 'Rename channel', icon: 'pencil', disabled: name === 'general',
                    onClick: () => { switchChannel(name).then(renameChannel); } }
            ] : []),
            ...(can('channel.delete') ? [
                { label: 'Delete channel', icon: 'trash', danger: true, disabled: name === 'general',
                    onClick: () => { switchChannel(name).then(deleteChannel); } }
            ] : [])
        ], x, y);
    }

    // ---------- notification settings popout --------------------------------
    //
    // The reference's, matching it item for item minus the one that cannot apply:
    // "Use Category Default" is absent because this board has no channel
    // categories, so it would be a fourth radio meaning exactly what the first
    // one means.
    //
    // Two panels. The submenu is separate so it can sit BESIDE the row that opens
    // it rather than pushing the radios down — and so a mouse travelling from
    // "Mute Channel" to "For 3 Hours" passes over nothing that would close it.

    let notifFor = '';          // which channel the open popout is about
    let notifSubTimer = null;

    function notifPopOpen() { return !$('notif-pop').hidden; }

    function closeNotifSub() {
        if (notifSubTimer) { clearTimeout(notifSubTimer); notifSubTimer = null; }
        $('notif-sub').hidden = true;
        $('np-mute').classList.remove('open');
        $('np-mute').setAttribute('aria-expanded', 'false');
    }

    function closeNotifPop() {
        closeNotifSub();
        $('notif-pop').hidden = true;
        $('btn-chan-alerts').setAttribute('aria-expanded', 'false');
        notifFor = '';
    }

    // Anchor a fixed panel so its trailing edge lines up with the button's, and
    // clamp it on screen. Shared by both popouts in this section.
    function placeFixedPanel(panel, anchorRect, opts) {
        const o = opts || {};
        const w = panel.offsetWidth;
        const h = panel.offsetHeight;
        const left = o.alignLeft ? anchorRect.left : anchorRect.right - w;
        panel.style.left = Math.max(8, Math.min(left, window.innerWidth - w - 8)) + 'px';
        panel.style.top = Math.max(8, Math.min(anchorRect.bottom + 8, window.innerHeight - h - 8)) + 'px';
    }

    function renderNotifPop() {
        if (!notifPopOpen()) return;
        const name = notifFor;
        const muted = channelMutedNow(name);
        const remaining = muteRemainingText(name);

        // The row says what it DOES, and carries what is currently true
        // underneath it — a muted channel's popout that still just said "Mute
        // Channel" would be the one place that could not tell you it was muted.
        $('np-mute-label').innerHTML = muted
            ? 'Mute Channel<span class="np-sub-label">' + esc(remaining) + '</span>'
            : 'Mute Channel';
        $('np-mute-label').classList.toggle('np-stacked', muted);
        $('np-unmute').hidden = !muted;

        const radios = $('np-radios');
        const mode = channelAlertMode(name);
        radios.innerHTML = '';
        [
            ['all', 'All Messages'],
            ['mentions', 'Only @mentions'],
            ['none', 'Nothing']
        ].forEach(([value, label]) => {
            const row = document.createElement('label');
            row.className = 'np-radio';
            row.innerHTML = `<span>${esc(label)}</span>` +
                `<input type="radio" name="np-level" value="${value}"${mode === value ? ' checked' : ''}>`;
            row.querySelector('input').addEventListener('change', () => {
                setChannelAlertMode(name, value);
                // Left OPEN, like the reference: picking a level is a setting, not
                // a command, and the radio moving is the confirmation.
                renderNotifPop();
            });
            radios.appendChild(row);
        });
    }

    function openNotifSub() {
        const name = notifFor;
        const sub = $('notif-sub');
        sub.innerHTML = '';
        MUTE_DURATIONS.forEach((d) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'np-item';
            b.setAttribute('role', 'menuitem');
            b.innerHTML = `<span class="np-label">${esc(d.label)}</span>`;
            b.addEventListener('click', () => {
                setChannelMute(name, d.ms);
                closeNotifPop();
                toast(d.ms === MUTE_FOREVER
                    ? '#' + name + ' muted until you turn it back on'
                    : '#' + name + ' muted ' + d.label.toLowerCase());
            });
            sub.appendChild(b);
        });

        // Beside the row, top-aligned with it, flipping to the left when there is
        // no room on the right.
        sub.hidden = false;
        const r = $('np-mute').getBoundingClientRect();
        const pop = $('notif-pop').getBoundingClientRect();
        const w = sub.offsetWidth, h = sub.offsetHeight;
        const right = pop.right + 6;
        sub.style.left = (right + w <= window.innerWidth - 8 ? right : Math.max(8, pop.left - w - 6)) + 'px';
        sub.style.top = Math.max(8, Math.min(r.top - 6, window.innerHeight - h - 8)) + 'px';
        $('np-mute').classList.add('open');
        $('np-mute').setAttribute('aria-expanded', 'true');
    }

    // `straightToSub` opens with the durations already showing — used by the
    // channel row's "Mute channel…", which has already said what it is for.
    function openNotifPop(name, x, y, straightToSub) {
        pruneExpiredMutes();
        closeThreadsPop();
        notifFor = name || channel;
        const pop = $('notif-pop');
        pop.hidden = false;
        $('btn-chan-alerts').setAttribute('aria-expanded', 'true');
        renderNotifPop();
        // Measured after the content exists, or the height is the empty box's.
        const w = pop.offsetWidth, h = pop.offsetHeight;
        pop.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px';
        pop.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + 'px';
        if (straightToSub) openNotifSub();
    }

    // Hover opens the submenu, and a small delay on the way OUT keeps it open
    // while the pointer crosses the gap between the two panels. Click works too,
    // for touch and for the keyboard.
    $('np-mute').addEventListener('mouseenter', () => {
        if (notifSubTimer) { clearTimeout(notifSubTimer); notifSubTimer = null; }
        if ($('notif-sub').hidden) openNotifSub();
    });
    $('np-mute').addEventListener('click', () => {
        if ($('notif-sub').hidden) openNotifSub(); else closeNotifSub();
    });
    [$('notif-pop'), $('notif-sub')].forEach((el) => {
        el.addEventListener('mouseleave', () => {
            if (notifSubTimer) clearTimeout(notifSubTimer);
            notifSubTimer = setTimeout(() => {
                // Only when the pointer is in neither panel.
                if (!$('notif-pop').matches(':hover') && !$('notif-sub').matches(':hover')) closeNotifSub();
            }, 220);
        });
        el.addEventListener('mouseenter', () => {
            if (notifSubTimer) { clearTimeout(notifSubTimer); notifSubTimer = null; }
        });
    });
    $('np-unmute').addEventListener('click', () => {
        const name = notifFor;
        setChannelMute(name, null);
        closeNotifPop();
        toast('#' + name + ' unmuted');
    });

    $('channel-list').addEventListener('contextmenu', (e) => {
        const row = e.target.closest('.chan');
        if (!row) return;
        e.preventDefault();
        openChannelMenu(row.dataset.channel, e.clientX, e.clientY);
    });

    // ---------- settings modal --------------------------------------------

    let recordingPtt = false;
    // Set while a hotkey recorder is armed; see bindKeyRecorder. Held here so
    // closeSettings() can call it — an armed recorder outliving the sheet it
    // belongs to swallows the next keystroke anywhere in the app.
    let cancelKeyRecorder = null;

    async function openSettings() {
        settings = await L.settings.get();
        // Member management is the OWNER's, not every admin's — see CAPABILITIES.
        // An admin used to see this whole panel, which is how one could ban, reset
        // the password of, or demote anybody, the owner included.
        $('acct-members').hidden = !can('member.setRole');
        if (can('member.setRole')) renderMemberAdmin();
        $('set-name').value = settings.displayName || '';
        $('set-mode').value = settings.voiceMode || 'open';
        $('set-ec').checked = settings.echoCancellation !== false;
        $('set-ns').checked = settings.noiseSuppression !== false;
        $('set-nsai').checked = !!settings.noiseSuppressionAI;
        $('set-agc').checked = !!settings.autoGainControl;
        refreshUpdateStatus();
        // Read the login item's ACTUAL OS state, so the switch is correct even
        // if the user changed it outside the app. Written back into `settings`
        // because that is what the switch reads.
        try {
            const li = await L.startup.get();
            settings.launchOnStartup = !!li.openAtLogin;
            settings.startMinimized = !!li.openAsHidden;
        } catch (e) { /* the mirror in settings is the fallback */ }
        updateLaunchHiddenEnabled();
        $('set-outvol').value = Math.round((settings.outputVolume === undefined ? 1 : settings.outputVolume) * 100);
        $('set-outvol-val').textContent = $('set-outvol').value + '%';
        $('set-share-quality').value = settings.shareQuality || '1080p';
        $('set-share-motion').value = settings.shareMotion || 'sharp';
        $('set-share-audio').checked = settings.shareAudio !== false;
        $('set-ptt').textContent = (await L.ptt.describe(settings.pttBinding)) || 'Click to set';
        $('set-mute-key').textContent = (await L.ptt.describe(settings.muteBinding)) || 'Click to set';
        $('set-deafen-key').textContent = (await L.ptt.describe(settings.deafenBinding)) || 'Click to set';
        $('row-ptt').style.display = settings.voiceMode === 'ptt' ? '' : 'none';

        // Account / notifications / appearance / privacy
        $('set-status').value = settings.status || '';
        $('set-theme').value = settings.theme || 'dark';
        $('set-density').value = settings.density || 'cozy';
        $('set-vad').value = String(vadValue());

        paintPaneControls();
        paintThreshold();
        paintVoicePane();
        renderAccountCard();
        renderAccountInfo();
        renderMutedChannels();
        renderBlocked();
        // Refetched rather than drawn from cache: someone else may have added
        // one since this client booted, and Settings is where you'd look.
        loadCustomEmoji().then(renderEmojiAdmin);

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

        // AFTER the reveal, deliberately. Cold, enumerateDevices() is a trip
        // through Chromium's audio service — measured at 268-356ms on this
        // machine's fifteen endpoints — and it was awaited in front of the
        // panel appearing. Nothing above reads a device, and the selects it
        // fills live in Voice & Audio, which is not the pane that opens. So the
        // gear now opens the panel and the dropdowns fill in behind it, which
        // is the rule the mic/speaker popovers already follow.
        populateDevices();
    }

    // Closing has to stop the mic test, whichever way it happens.
    function closeSettings() {
        stopMicTest();
        // A hotkey recorder is armed on the sheet, so it dies with the sheet.
        // Deliberately floating: finish(null,false) writes no setting, it only
        // detaches the two window capture listeners and repaints a button that
        // is about to be hidden anyway.
        if (cancelKeyRecorder) cancelKeyRecorder();
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
    // Which account the card was last drawn for, so an ordinary repaint can be
    // told apart from a sign-in, a sign-out or a switch. -1 rather than 0: 0 is
    // "nobody signed in", which is a real state the card is drawn in.
    let lastCardAccountId = -1;

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
        // Nothing to disable or delete when nobody is signed in.
        $('acct-removal').hidden = !account;
        // Both sub-panels belong to a state that has just ended: a stray verify
        // form under a signed-in account, or — worse — the PREVIOUS account's
        // TOTP secret still on screen for the next person who signs in.
        //
        // Only when the account has actually CHANGED, though. This function is
        // also the ordinary repaint — the custom-status field calls it on change,
        // and so does every avatar refresh through repaintAvatars() — so it used
        // to destroy a 2FA enrolment in progress: scan the QR with your phone,
        // then touch anything else in the same pane before typing the six digits,
        // and the QR, the manual key and the code box all vanished without a word.
        // Worse than a re-click, because the server mints a NEW secret on every
        // setup, so the entry already sitting in the authenticator app is dead and
        // has to be deleted by hand.
        if (lastCardAccountId !== myUserId()) {
            lastCardAccountId = myUserId();
            $('acct-verify').hidden = true;
            $('acct-2fa-setup').hidden = true;
            $('acct-2fa-secret').textContent = '';
        }
        if (account) {
            $('acct-user').textContent = account.username;
            // Every role is named, including member: "what am I" is the first
            // question the permission tiers raise, and it was only answered when
            // the answer happened to be admin.
            $('acct-role').textContent = '(' + roleLabel(account.role).toLowerCase() + ')' +
                (account.totp ? ' · 2FA on' : '');
            $('btn-acct-2fa').textContent = account.totp ? 'Turn off 2FA' : 'Enable 2FA';
        }
    }

    // ---- profile picture ----
    // 5 MB, matching the server. Checked here too so an obviously-too-big photo
    // is refused instantly rather than after a base64 round trip — which at this
    // size is now worth several seconds of encoding and upload.
    const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

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
            return avatarHint(`That image is ${fmtSize(file.size)} — 5 MB is the limit.`, true);
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
        // inputType + maxLength are not decoration. The shared dialog field is
        // type=text and capped at 60 unless a caller says otherwise, so without
        // both of these an account password was typed in the clear — in an app
        // whose whole purpose is sharing your screen — and silently truncated
        // at 60 characters, which is inside the range a password manager
        // generates. The server then rejected a password the user had entered
        // correctly, with nothing on screen to explain why.
        const pw = await openDialog({
            title: 'Confirm your password',
            message: 'Enter your account password to set up two-factor authentication.',
            ok: 'Continue', withInput: true, inputType: 'password', maxLength: 72
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
            ok: 'Turn off', withInput: true, danger: true,
            inputType: 'password', maxLength: 72
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
    // Enter submits, like the identical 6-digit box on the login card. A TOTP
    // code expires in thirty seconds, so making someone read the digits, type
    // them, and then go and find the mouse is a real way to miss the window and
    // be told a correct code is wrong.
    $('acct-2fa-code').addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        e.stopPropagation();
        $('btn-acct-2fa-confirm').click();
    });

    // ---- board account (username + role on top of the shared password) ----

    let account = null;               // { id, username, role } | null

    // ---- roles and capabilities -------------------------------------------
    //
    // A MIRROR of the server's table (functions/api/board/_accounts.js
    // CAPABILITIES), and only ever a mirror: every one of these is enforced again
    // on the server, so this decides what to DRAW, never what is allowed. Hiding a
    // button is not a permission check — anyone can call the endpoint directly —
    // which is why the two exist separately and why the server's copy is the one
    // that matters.
    //
    // Kept as one table here for the same reason it is one table there: "what can
    // an admin do" has to be answerable by reading a list, not by grepping for
    // role comparisons and hoping none were missed.
    const CAPABILITIES = {
        // Content and the shape of the channel list — admin and owner.
        'message.moderate': ['owner', 'admin'],
        'message.pin': ['owner', 'admin'],
        'emoji.moderate': ['owner', 'admin'],
        'voice.kick': ['owner', 'admin'],
        'channel.create': ['owner', 'admin'],
        'channel.rename': ['owner', 'admin'],
        // Destructive, and anything that touches an ACCOUNT — owner only.
        'channel.delete': ['owner'],
        'member.setRole': ['owner'],
        'member.ban': ['owner'],
        'member.unban': ['owner'],
        'member.resetPassword': ['owner'],
        'member.clearTotp': ['owner'],
        'member.delete': ['owner']
    };

    function can(capability) {
        const allowed = CAPABILITIES[capability];
        return !!(allowed && account && allowed.includes(account.role));
    }

    const isOwner = () => !!(account && account.role === 'owner');
    // "Admin OR ABOVE" — the owner has every ability an admin has. Every existing
    // caller meant this, from when admin was the top of the tree.
    const isAdmin = () => !!(account && (account.role === 'owner' || account.role === 'admin'));
    const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', member: 'Member' };
    const roleLabel = (role) => ROLE_LABEL[role] || 'Member';

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

    // Pinning is the same rule as editing and deleting — admins anything, members
    // only their own — and pin.js enforces it. See the pin button in renderMessage.
    function mayPin(p) {
        return can('message.pin') || ownsPost(p);
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
        // The account gate asks account/me and keeps the answer. Coming from
        // there, this call was a second trip to Cloudflare — same endpoint,
        // same clientId, milliseconds later, necessarily the same row — and
        // everything else in enterApp() waited behind it. Measured at ~50ms
        // from here, in front of the socket, the channel list and the first
        // message. The renders below still run; only the question is skipped.
        //
        // One pass, not a cache: the register / verify / TOTP paths never set
        // the flag, so they still make the real call that binds this install to
        // the account.
        const fresh = accountJustFetched;
        accountJustFetched = false;
        if (!fresh) {
            try {
                const res = await L.account.me();
                // An ANSWER is authoritative, including "you have no account".
                // A failure to ask is not: it used to be written straight into
                // `account` as null, and nothing asks again for the rest of the
                // session — this is the only call site. The paths that reach
                // here with `fresh` false are register, verify and TOTP, so the
                // account had just been proved moments earlier by the response
                // that created the session; one timed-out account/me (the
                // slowest call this app makes) erased it. myUserId() then
                // answers 0, and "is this me?" is decided by user_id: your own
                // messages stop being yours, edit and delete disappear from
                // them, the admin controls go, and the DM list empties — on a
                // session the server considers perfectly signed in.
                if (res && res.success) account = res.user || null;
                else console.warn('[account] could not refresh — keeping what we have:',
                    (res && res.error) || 'no answer');
            } catch (e) {
                console.warn('[account] refresh threw — keeping what we have:', e && e.message);
            }
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

    // ---- a role that changed under us ---------------------------------------

    // Everything on screen that a role decides. Called when the answer changes
    // rather than when the app starts, which is the whole point — the role used to
    // be read once at startup and never again, so a promotion or a demotion did
    // nothing at all until the affected person restarted the app.
    //
    // Enumerated rather than "just reload": a reload would throw away the messages
    // they are reading, their scroll position and anything half-typed, for a change
    // that only affects which buttons exist.
    function repaintForRole() {
        renderAccountCard();     // the role line, and whether Members is offered
        renderMessages();        // edit / delete / pin on other people's messages
        renderChannels();        // the per-channel gear, and the + that creates one
        applyChrome();           // the sidebar's create-channel affordance
        // renderVoiceRoster() is the wrapper that merges presence with the SFU
        // roster and then feeds renderMembers(list, inCall) — which takes arguments
        // and must not be called bare. Calling it directly threw a TypeError that
        // this function swallowed nothing of: everything after it, including the
        // message repaint, silently did not happen.
        renderVoiceRoster();
        // The popover is drawn from the role too, and it is a floating panel that
        // would otherwise keep offering moderation actions the server now refuses.
        if (!$('popover').hidden) closePopover();
        // Settings is where member management lives, and its visibility is decided
        // when the sheet OPENS — so a role that changes while it is already open
        // leaves the panel showing (or hiding) the wrong thing until it is reopened.
        $('acct-members').hidden = !can('member.setRole');
        // Open on the Members pane as a demoted admin, this list is no longer
        // yours to see; as a promoted one it is, and it is empty until asked for.
        if (!$('settings').hidden && can('member.setRole')) renderMemberAdmin();
    }

    // A push from the server saying our role changed. `m` carries { role, by }.
    //
    // account/me is refetched rather than trusting the event's `role`, because that
    // endpoint is the authoritative answer and this event is only a trigger — it
    // also picks up anything else that changed about the account in the meantime.
    // The event's `by` is still used for the message, since only it knows who did
    // it. If the refetch fails we fall back to the pushed role rather than doing
    // nothing: the alternative is a client that has been told it was promoted and
    // acts as though it wasn't.
    let roleNoticeOpen = false;
    async function applyRoleChange(m) {
        const before = account && account.role;
        let after = m && m.role;
        try {
            const res = await L.account.me();
            if (res && res.success && res.user) {
                account = res.user;
                after = account.role;
            } else if (account && after) {
                account = Object.assign({}, account, { role: after });
            }
        } catch (e) {
            if (account && after) account = Object.assign({}, account, { role: after });
        }
        if (!after || after === before) return;      // nothing actually moved

        repaintForRole();

        // Say what happened, with one button to dismiss it. A toast is not enough
        // for this: it is a change to what the person is allowed to do, it may have
        // happened while they were reading something else, and a toast is gone in
        // two seconds whether or not anyone was looking at the window.
        //
        // Guarded because two devices, or a quick promote-then-demote, would
        // otherwise stack dialogs — openDialog resolves the previous one as null,
        // so the second notice would silently replace the first.
        if (roleNoticeOpen) return;
        roleNoticeOpen = true;
        const promoted = ROLE_RANK[after] < ROLE_RANK[before || 'member'];
        const by = m && m.by ? m.by : null;
        const title = promoted
            ? `You've been promoted to ${roleLabel(after)}`
            : `You've been changed to ${roleLabel(after)}`;
        try {
            await tellUser(title, ROLE_NOTICE[after] + (by ? `\n\nChanged by ${by}.` : ''), 'OK');
        } finally {
            roleNoticeOpen = false;
        }
    }

    // Lower is more privileged, so a promotion is a DECREASE. Only used to word the
    // notice; nothing is authorised by it.
    const ROLE_RANK = { owner: 0, admin: 1, member: 2 };

    // What the new role actually lets them do, in the same words the release notes
    // use — being told "you are an admin now" without being told what that means is
    // half a notification.
    const ROLE_NOTICE = {
        owner: 'You have full control of the board.',
        admin: 'You can now delete and edit anyone\'s messages, pin them, and create '
            + 'and rename channels. Account settings — bans, passwords and roles — stay with the owner.',
        member: 'You can edit and delete your own messages. Creating channels and '
            + 'moderating other people\'s messages are no longer available to you.'
    };

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
              (account.role === 'owner' ? '. You are the board owner.'
                  : account.role === 'admin' ? '. You are an admin.' : '')
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
                `<em class="hint">${esc(roleLabel(u.role).toLowerCase())}${u.banned ? ' · banned' : ''}</em>`;
            row.appendChild(who);

            // An owner cannot be managed from here by anybody, including another
            // owner: the role is established once, when the board's first account
            // is created, and the server refuses every action aimed at it
            // (mayManage). Saying so beats five buttons that all answer 403.
            if (u.role === 'owner') {
                const note = document.createElement('em');
                note.className = 'hint';
                note.textContent = 'Board owner — cannot be changed or removed.';
                row.appendChild(note);
                box.appendChild(row);
                return;
            }

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
                        // Says what an admin can and cannot do, because the answer
                        // changed: an admin used to be able to manage members —
                        // including demoting the owner, which is the hole this
                        // release closed. They now get content moderation and the
                        // channel list, and nothing that touches an account.
                        message: 'Admins can edit, delete and pin anyone\'s messages, and create and '
                            + 'rename channels. They cannot ban, reset passwords, clear 2FA, delete '
                            + 'accounts or change roles — those stay with you.',
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
                    ok: 'Reset', withInput: true, inputType: 'password', maxLength: 72
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
    // Same gesture as its twin on the login card (#login-code).
    $('acct-code').addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        e.stopPropagation();
        $('btn-acct-verify').click();
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

    // ---- account removal ----
    // Two steps, in this order: say plainly what is about to happen, and only
    // then ask for the password. Asking first trains people to type it before
    // they have read anything, which is the opposite of what a confirmation is
    // for. The server re-checks the password regardless — this is the half a
    // client is allowed to enforce, not the half that matters.
    async function runAccountRemoval(action) {
        const deleting = action === 'delete';
        const ok = await askConfirm(
            deleting ? 'Delete your account?' : 'Disable your account?',
            deleting
                ? 'Your account, your direct messages and your devices are removed for good. '
                  + 'Messages you posted stay on the board without a name attached. This cannot be undone.'
                : 'You will be signed out everywhere and your account goes quiet. '
                  + 'Signing back in at any time restores it, with everything still there.',
            deleting ? 'Delete Account' : 'Disable Account',
            true
        );
        if (!ok) return;

        // 2FA is asked for up front when we already know it is on, so the
        // common case is one dialog rather than a rejection and a second.
        const needs2fa = !!(account && account.totp);
        const pass = await openDialog({
            title: deleting ? 'Confirm with your password' : 'Confirm with your password',
            message: deleting
                ? 'This is the last step. Deleting cannot be undone.'
                : 'Enter your password to disable the account.',
            ok: deleting ? 'Delete Account' : 'Disable Account',
            danger: true,
            withInput: true,
            inputType: 'password',
            maxLength: 72,
            placeholder: 'Password',
            label2: needs2fa ? 'Authenticator code' : '',
            placeholder2: needs2fa ? '6-digit code' : '',
            maxLength2: 6
        });
        if (pass === null || pass === false || !String(pass).length) return;
        const code = needs2fa ? ($('dialog-input2').value || '').trim() : '';

        const res = await L.account.removal(action, String(pass), code);
        if (!res || !res.success) {
            // need2fa comes back when the server knows about an authenticator
            // this client did not — an account that turned 2FA on elsewhere.
            toast((res && res.error) || 'Could not complete that just now.', 'err');
            return;
        }

        // Whichever action ran, this session is over on the server. Tear down
        // the same way sign-out does rather than leaving a shell of an app
        // pointed at an account that is gone.
        await teardownSession();
        account = null;
        dmThreads = [];
        closeDm();
        renderAccountCard();
        renderDmSection();
        closeSettings();
        $('app').hidden = true;
        showAccountStep();
        toast(deleting ? 'Your account has been deleted' : 'Your account is disabled — sign in to restore it');
    }

    $('btn-acct-disable').addEventListener('click', () => runAccountRemoval('disable'));
    $('btn-acct-delete').addEventListener('click', () => runAccountRemoval('delete'));

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
            // A channel muted for a while is not the same as one set to Nothing,
            // and the select cannot express it — so it is said, with the way out
            // beside it. Without this the Advanced list was the one place that
            // could show a muted channel as "All messages".
            if (channelMutedNow(c.name)) {
                const tag = document.createElement('span');
                tag.className = 'chan-mute-tag';
                tag.textContent = muteRemainingText(c.name);
                const un = document.createElement('button');
                un.type = 'button';
                un.className = 'keycap';
                un.textContent = 'Unmute';
                un.addEventListener('click', () => setChannelMute(c.name, null));
                row.appendChild(tag);
                row.appendChild(un);
            }
            box.appendChild(row);
        });
    }

    // ---------- Account Info ------------------------------------------------
    // The reference's label / value rows. Everything here is READ — the display
    // name is the account username and cannot be edited (which is the whole point
    // of it), and the email belongs to the account rather than to this app — so
    // the rows state rather than offering Edit buttons that could not work.
    function renderAccountInfo() {
        const nameRow = $('acct-info-name');
        if (nameRow) nameRow.textContent = settings.displayName || 'Anonymous';

        const roleRow = $('acct-info-role');
        if (roleRow) {
            roleRow.textContent = account
                ? (ROLE_LABEL[account.role] || account.role || 'Member')
                : 'Not signed in to a board account';
        }

        // Only when there is one to show. account/me does not always carry it.
        const emailRow = $('acct-info-email-row');
        const email = account && account.email;
        if (emailRow) {
            emailRow.hidden = !email;
            if (email) $('acct-info-email').textContent = maskEmail(email);
        }
    }

    // "sc••••••@gmail.com" — enough to recognise which address it is without
    // printing it in full on a screen somebody may be sharing.
    function maskEmail(addr) {
        const s = String(addr || '');
        const at = s.indexOf('@');
        if (at < 1) return s;
        const user = s.slice(0, at);
        const keep = user.slice(0, Math.min(2, user.length));
        return keep + '•'.repeat(Math.max(3, user.length - keep.length)) + s.slice(at);
    }

    // ---------- System: keybinds -------------------------------------------
    // The three settable ones are the SAME bindings the Voice & Audio pane
    // records — one setting, two places to reach it, which is what the reference
    // does with its keybind list. The recorders are bound below, beside the
    // originals, so there is one recorder implementation rather than two.
    async function paintKeybinds() {
        const pairs = [
            ['set-ptt-2', settings.pttBinding],
            ['set-mute-key-2', settings.muteBinding],
            ['set-deafen-key-2', settings.deafenBinding]
        ];
        for (const [id, binding] of pairs) {
            const el = $(id);
            if (!el) continue;
            el.textContent = (await L.ptt.describe(binding)) || 'Click to set';
        }
        const note = $('keybind-native-note');
        if (note) {
            note.textContent = pttHookAvailable
                ? 'These work system-wide — the native key hook is running.'
                : 'The native key hook is unavailable on this machine, so push-to-talk ' +
                  'behaves as a system-wide TOGGLE and hold-to-talk works while the window is focused.';
        }
    }

    // Every shortcut the app actually implements, grouped the way the reference
    // groups its Default Keybinds. Written from the handlers rather than from
    // memory: each entry below is wired in this file.
    const DEFAULT_KEYS = [
        ['Messages', [
            ['Send', ['Enter']],
            ['New line without sending', ['Shift', 'Enter']],
            ['Accept the @mention being suggested', ['Tab']],
            ['Reveal a spoiler', ['Enter']]
        ]],
        ['The conversation', [
            ['Move between messages', ['↑', '↓']],
            ['First / last message', ['Home', 'End']],
            ['Open the focused message’s menu', ['Enter']],
            ['Close that menu', ['Esc']]
        ]],
        ['Navigation', [
            ['Search this channel', ['Ctrl', 'F']],
            ['Close the top-most panel, menu or sheet', ['Esc']]
        ]],
        ['Text', [
            ['Larger chat text', ['Ctrl', '+']],
            ['Smaller chat text', ['Ctrl', '−']],
            ['Reset chat text size', ['Ctrl', '0']]
        ]]
    ];

    let defaultKeysDrawn = false;
    function renderDefaultKeys() {
        const box = $('set-default-keys');
        if (!box || defaultKeysDrawn) return;
        defaultKeysDrawn = true;
        DEFAULT_KEYS.forEach(([group, rows]) => {
            const h = document.createElement('div');
            h.className = 'set-keys-head';
            h.textContent = group;
            box.appendChild(h);
            rows.forEach(([label, keys]) => {
                const row = document.createElement('div');
                row.className = 'set-key';
                const caps = keys.map((k) => `<span class="set-key-cap">${esc(k)}</span>`).join('');
                row.innerHTML = `<span>${esc(label)}</span><span class="set-key-combo">${caps}</span>`;
                box.appendChild(row);
            });
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
                // A clip reaches the room by being mixed into the OUTGOING
                // MICROPHONE — that is the only path to the SFU — so it goes
                // nowhere at all while the microphone is not being published.
                // Muted, or push-to-talk with the key up, and disableAudio()
                // has already stopped the track the mix feeds. The clip still
                // comes out of the local tap, deliberately (the presser has to
                // hear what they played), which is exactly what made this
                // indistinguishable from a clip the whole call heard: the
                // button flashes, the sound plays, and nobody else gets it.
                const vst = voice ? voice.state() : null;
                if (vst && vst.joined && !vst.transmitting) {
                    toast(vst.muted
                        ? 'You are muted — nobody else can hear that clip.'
                        : 'Hold your push-to-talk key to play a clip into the call.', true);
                }
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
            if (mine || can('emoji.moderate')) {
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
        bumpEmojiGen();
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
        bumpEmojiGen();
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
        //
        // `micTest` is in the condition for the same reason, one step nearer
        // home: the leading stopMicTest() also does nothing while micTest is
        // null, so two clicks inside the device-open window (100-500ms — well
        // within a double click) opened two captures and the second overwrote
        // the handle to the first. Nothing could then release it, not Stop
        // Test, not closing Settings, not signing out — the microphone-in-use
        // light stayed on until the app was quit. Whichever capture loses the
        // race is stopped here.
        if (gen !== sessionGen || micTest) {
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
            const bar = $('mic-meter-bar');
            bar.style.width = Math.min(100, (meter.rms() / METER_MAX) * 100).toFixed(1) + '%';
            // The SAME test the live indicator applies, so what this meter shows
            // as "speaking" is what will actually light the ring. Comparing a
            // bare RMS here meant the two could disagree, which makes the
            // threshold slider impossible to calibrate against.
            bar.classList.toggle('over', meter.isSpeech(vadRms()));
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

    // Everything in the settings sheet that is DRAWN FROM a setting rather than
    // wired to one: the sliders and their scales, the switches, the radios, the
    // keybind buttons, the live preview.
    //
    // Called both when the sheet opens and whenever a pane is shown, because a
    // pane can be reached long after the sheet did — and a slider whose scale was
    // never drawn, or a radio group with nothing selected, is exactly what that
    // looked like before.
    function paintPaneControls() {
        const px = currentFontPx();
        if ($('set-font-px')) $('set-font-px').value = String(px);
        paintTicks('ticks-font', px);

        const gapRaw = parseInt(settings.msgGroupGap, 10);
        const gap = Number.isFinite(gapRaw) ? gapRaw : 16;
        if ($('set-msg-gap')) $('set-msg-gap').value = String(gap);
        paintTicks('ticks-gap', gap);

        const zoom = parseInt(settings.zoomLevel, 10) || 100;
        if ($('set-zoom')) $('set-zoom').value = String(zoom);
        paintTicks('ticks-zoom', zoom);

        const satRaw = parseInt(settings.saturation, 10);
        const sat = Number.isFinite(satRaw) ? satRaw : 100;
        if ($('set-saturation')) $('set-saturation').value = String(sat);
        paintTicks('ticks-sat', sat);

        paintSwitches();
        paintRadios();
        updateLaunchHiddenEnabled();
        renderDefaultKeys();
        paintKeybinds();
        renderA11yPreview();
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

                // SUB-ENTRIES, one per h4.set-sub in the section — the reference
                // lists a tab's own headings under it while that tab is open, and
                // in a pane as long as Accessibility or Notifications they are the
                // only way to see what is in it without scrolling the whole thing.
                //
                // Built from the markup, like the tabs themselves: a new heading
                // needs no wiring. Shown only while its section is the open one.
                const subWrap = document.createElement('div');
                subWrap.className = 'set-nav-subs';
                subWrap.hidden = true;
                const subs = [];
                g.querySelectorAll('h4.set-sub').forEach((h4) => {
                    const sb = document.createElement('button');
                    sb.type = 'button';
                    sb.className = 'set-nav-sub';
                    sb.textContent = h4.textContent;
                    sb.addEventListener('click', () => {
                        showPane(g);
                        // The pane is the scroller, and the sticky preview sits over
                        // its top — so scroll the heading to just under that rather
                        // than to the very top, where it would be covered.
                        const top = h4.offsetTop - 12;
                        body.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
                        subs.forEach((x) => x.el.classList.toggle('on', x.el === sb));
                    });
                    subWrap.appendChild(sb);
                    subs.push({ el: sb, h4 });
                });
                if (subs.length) inner.appendChild(subWrap);
                // Some of those headings live in a block that is hidden for this
                // viewer — "Members" is the owner's only — so the entry has to
                // follow it. Recomputed on every show rather than once: the role
                // can change mid-session, and openSettings decides that block's
                // visibility after this nav was built.
                subWrap.dataset.count = String(subs.length);

                const it = {
                    g, b, subWrap: subs.length ? subWrap : null, subs,
                    key: (h.textContent + ' ' + g.textContent).toLowerCase()
                };
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
                const on = it.g === target;
                it.g.hidden = !on;
                it.b.classList.toggle('on', on);
                if (it.subWrap) it.subWrap.hidden = !on;
                if (!on) return;
                // A heading inside a block this viewer cannot see — "Members" is
                // the owner's only — must not appear in the rail either.
                //
                // Asked of the DOM by walking up to the pane looking for `hidden`
                // or an inline display:none, rather than of the LAYOUT: offsetParent
                // would be the obvious test and it is null for everything in jsdom,
                // which has no layout at all — so it would hide every sub-entry
                // under test while looking correct in the app.
                let visible = 0;
                it.subs.forEach((x) => {
                    let shown = true;
                    for (let n = x.h4; n && n !== it.g; n = n.parentElement) {
                        if (n.hidden || (n.style && n.style.display === 'none')) { shown = false; break; }
                    }
                    x.el.hidden = !shown;
                    // The first VISIBLE entry is where the pane opens, so it is
                    // the one marked; nothing else has been navigated to yet.
                    x.el.classList.toggle('on', shown && visible === 0);
                    if (shown) visible++;
                });
                if (it.subWrap) it.subWrap.hidden = visible === 0;
            });
            const h = target.querySelector('h3');
            $('settings-title').textContent = h ? h.textContent : 'Settings';
            body.scrollTop = 0;
            // The release history is a network round trip to GitHub, which is
            // rate limited per address — so it is fetched when somebody actually
            // looks at About, not every time Settings opens.
            if (target === settingsPaneByTitle('About')) loadReleaseHistory(false);
            // Every control on the pane being shown, painted from the settings as
            // they are NOW. openSettings does this too, but a pane can be reached
            // long after the sheet opened — and a slider whose scale was never
            // drawn, or a radio group with nothing selected, is what that looked
            // like before this line.
            paintPaneControls();
        }

        // A query that matches nothing hides every row in the rail, and an empty
        // column beside a settings pane reads as the app having broken rather than
        // as an answer. Every other list in here — the emoji picker, the member
        // list, the pinned panel — says so; this one said nothing at all.
        const navEmpty = document.createElement('div');
        navEmpty.className = 'set-nav-empty';
        navEmpty.hidden = true;
        inner.appendChild(navEmpty);

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
            navEmpty.hidden = !q || !!first;
            if (navEmpty.hidden) navEmpty.textContent = '';
            else navEmpty.textContent = 'No settings match “' + search.value.trim() + '”';
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
    //
    // Two tiny factories first, because everything below uses them. Their
    // registries are declared at the top of this file, not here — the settings nav
    // repaints them from module scope, which is above this point.

    // A <button role="switch"> with the reference's look. One line per toggle:
    // where to find it, how to read the setting, how to write it.
    function wireSwitch(id, get, set) {
        const el = $(id);
        if (!el) return;
        const paint = () => el.setAttribute('aria-checked', get() ? 'true' : 'false');
        el.addEventListener('click', async () => {
            if (el.disabled) return;
            await set(!get());
            paint();
        });
        // A button gets Enter for free; a switch also has to answer to Space.
        el.addEventListener('keydown', (e) => {
            if (e.key === ' ') { e.preventDefault(); el.click(); }
        });
        switchPainters.push(paint);
        paint();
    }

    // A radio group. Same shape: name the group, read the setting, write it.
    function wireRadios(name, get, set) {
        const all = () => document.querySelectorAll(`input[type="radio"][name="${name}"]`);
        all().forEach((r) => {
            r.addEventListener('change', () => { if (r.checked) set(r.value); });
        });
        radioPainters.push(() => {
            const v = get();
            all().forEach((r) => { r.checked = r.value === v; });
        });
    }

    $('set-status').addEventListener('change', async (e) => {
        await saveSettings({ status: e.target.value.trim().slice(0, 80) });
        renderMe();
        renderAccountCard();
        sendTextPresence(false);        // publish it now rather than up to 20s later
    });
    // Through setPresenceMode, so the switch and the account panel's picker can
    // never end up saying different things. Turning it off returns to Online
    // rather than to whatever override was set before — a two-state switch has no
    // way to express "back to Idle", so it must not pretend to.
    wireSwitch('set-dnd', () => isDnd(), async (v) => {
        await setPresenceMode(v ? 'dnd' : 'online');
        toast(v ? 'Do not disturb on — everything is silenced' : 'Do not disturb off');
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
        const fill = (sel, kind, current) => {
            sel.innerHTML = '<option value="">System default</option>';
            deviceCache.filter((d) => d.kind === kind).forEach((d) => {
                const o = document.createElement('option');
                o.value = d.deviceId;
                o.textContent = d.label || `${kind === 'audioinput' ? 'Microphone' : 'Speaker'} ${sel.length}`;
                sel.appendChild(o);
            });
            sel.value = current || '';
        };
        const paint = () => {
            fill($('set-mic'), 'audioinput', settings.micDeviceId);
            fill($('set-speaker'), 'audiooutput', settings.speakerDeviceId);
        };

        // Shares the list the audio popovers already keep, instead of opening a
        // second enumeration of its own. A cold enumerateDevices() is a few
        // hundred milliseconds through the audio service, and this used to pay
        // it separately every time Settings opened. Painted from the cache
        // first when there is one, so a reopen fills the dropdowns in the same
        // frame; the refresh below still lands and re-applies the saved value,
        // so a device plugged in since is picked up.
        if (deviceCache.length) paint();
        await refreshDeviceCache();
        // Nothing to say. enumerateDevices threw, or this machine genuinely has
        // no audio endpoints — either way the old code returned without
        // touching the selects, and blanking them down to "System default"
        // would be a worse answer than leaving what is there.
        if (!deviceCache.length) return;
        paint();
    }

    // What ptt.apply() actually did, remembered — because the hint used to be
    // derived from a different question entirely.
    //
    // apply() returns { mode, bound }: 'native' is real hold-to-talk through the
    // system hook, 'toggle' means the hook was unavailable and a GLOBAL
    // ACCELERATOR was registered instead — taken off every other application on
    // the machine, and a LATCH (press to talk, press again to stop) rather than
    // a hold — and 'none' means neither could be arranged. All four call sites
    // threw that answer away, and the hint asked ptt.available() instead, which
    // is `!!loadHook()`: whether the module LOADED. ptt.js's own comment says
    // that is not the same question as whether the hook works — start() throws
    // when the OS refuses the low-level input hook — so a machine that fell back
    // to the latch was told "works system-wide", and one whose binding no
    // transport could carry was told the same while nothing was bound at all.
    let pttState = null;

    async function applyPtt() {
        try { pttState = await L.ptt.apply(); } catch (e) { pttState = null; }
        paintPttHint();
        paintToggleHints();
        return pttState;
    }

    // The mute and deafen hotkeys have the same problem the PTT hint above was
    // fixed for, and it went unnoticed because their hint was a STATIC line of
    // HTML asserting "works system-wide" whatever happened.
    //
    // apply() carries a key that neither transport can accept — a bare letter
    // with no modifier, Pause, the Menu key, IntlBackslash on an ISO keyboard —
    // or one another application already owns system-wide, and in both cases it
    // simply dropped it. The keycap went on showing the key the user pressed,
    // beside a promise it kept, for a hotkey that had never been registered. The
    // only way to find out was to press it and notice nothing happened.
    const TOGGLE_HINTS = [
        { action: 'toggleMute', el: 'mute-hint', ok: '— works system-wide; Backspace while recording clears it' },
        { action: 'toggleDeafen', el: 'deafen-hint', ok: '' }
    ];

    function paintToggleHints() {
        const unbound = (pttState && Array.isArray(pttState.unbound)) ? pttState.unbound : [];
        TOGGLE_HINTS.forEach((h) => {
            const el = $(h.el);
            if (!el) return;
            if (unbound.includes(h.action)) {
                el.textContent = '— that key could not be registered; try one with Ctrl, Alt or Shift';
                el.classList.add('warn');
            } else {
                el.textContent = h.ok;
                el.classList.remove('warn');
            }
        });
    }

    function paintPttHint() {
        const el = $('ptt-hint');
        if (!el) return;
        if (!pttState) {
            // Before the first apply() of the session. `available()` is the best
            // guess there is at that point, and it is only ever a guess.
            L.ptt.available().then((ok) => {
                if (pttState) return;                    // a real answer landed meanwhile
                el.textContent = ok ? 'works system-wide' : 'in-app only while the window is focused';
            });
            return;
        }
        if (pttState.mode === 'native') { el.textContent = 'works system-wide'; return; }
        if (pttState.mode === 'toggle') {
            el.textContent = 'system-wide, but press once to talk and again to stop' +
                (pttState.bound ? ' — ' + pttState.bound + ' is taken from other apps while ScarmVoice runs' : '');
            return;
        }
        // 'none'. A mouse button needs the native hook: the in-window handler
        // matches on event.code and refuses a mouse binding outright, so unlike
        // a key there is no degraded mode left for it.
        const b = settings.pttBinding;
        el.textContent = (b && b.type === 'mouse')
            ? 'that button needs the system-wide hook, which is unavailable here — pick a key instead'
            : 'in-app only while the window is focused';
    }

    // Kept for the callers that only need a repaint. Opening Settings must NOT
    // re-apply: apply() resets the held state, which would close the microphone
    // of anyone who opened Settings mid-hold.
    function refreshPttHint() { paintPttHint(); paintToggleHints(); }

    // #set-name is readonly: the display name IS the account username, so there
    // is nothing to listen for. It stays in the sheet because that is where
    // people look for their name — it just shows rather than asks.
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
        // See the note on #btn-ptt below: the key-up that would have cleared
        // this is discarded once the mode has moved off 'ptt'.
        if (voice) voice.setPttHeld(false);
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
        if (voice) voice.setPttHeld(false);
        // The repaint, not a hand-rolled line for the one control this handler
        // happens to know about. voiceMode has four controls — this select, the
        // Push to Talk switch a few rows ABOVE it in the same visible pane, the
        // checkbox in the audio popover, and the in-call button — and each used
        // to update its own idea of the subset that mattered. Changing the mode
        // here left the switch drawn in the old position, so the pane showed
        // "Push to Talk" off directly above "Input mode: Push to talk", and the
        // next click on the switch appeared to do the opposite of what it read.
        // paintVoicePane() owns #row-ptt too, so the manual line is gone.
        paintVoicePane();
        paintAudioPanels();
        await applyPtt();
    });
    ['ec', 'ns', 'agc'].forEach((k) => {
        const map = { ec: 'echoCancellation', ns: 'noiseSuppression', agc: 'autoGainControl' };
        $('set-' + k).addEventListener('change', async (e) => {
            await saveSettings({ [map[k]]: e.target.checked });
            // The Input Profile radios above are DERIVED from these checkboxes,
            // and nothing repainted them — so unticking "Noise suppression" from
            // Studio moved the real profile to Custom while the Studio radio
            // stayed selected. Clicking Studio to put it back then did nothing at
            // all, because the input was already .checked and no change event
            // fires: a dead control over a pane that was describing a state it
            // was not in. setInputProfile() and the mode toggle already repaint
            // for exactly this reason.
            paintVoicePane();
            paintAudioPanels();
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
        // …and the Input Profile radios in Settings, which are derived from this.
        // Changing it from the call left them describing the previous state.
        paintVoicePane();
        paintAudioPanels();
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
        // The held state only means anything in 'ptt', and BOTH key handlers
        // bail on `voiceMode !== 'ptt'` — so a key that is still down when the
        // mode changes never gets its release recorded. Left set, the next
        // switch back to push-to-talk re-reads it and opens the microphone with
        // nobody holding anything. This is the control reachable DURING a call,
        // which is exactly where that costs something.
        if (voice) voice.setPttHeld(false);
        if (voice) voice.setSettings(settings);
        $('btn-ptt').classList.toggle('on', next === 'ptt');
        setTip($('btn-ptt'), next === 'ptt' ? 'Push to Talk On' : 'Push to Talk Off');
        // …and the two controls in Settings and the audio popover that say the
        // same thing. Changing the mode from the call left both of them stale.
        paintVoicePane();
        paintAudioPanels();
    });

    $('set-nsai').addEventListener('change', async (e) => {
        await saveSettings({ noiseSuppressionAI: e.target.checked });
        window.ScarmNoise.setEnabled(e.target.checked);
        // Same reason as the ec/ns/agc handler above: this checkbox is one of the
        // inputs the Input Profile radios are computed from, and leaving them
        // unpainted left "Clear Voice" selected with RNNoise off — and unclickable,
        // since an already-checked radio fires no change event.
        paintVoicePane();
        paintAudioPanels();
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
        paintVoicePane();          // the profile radios are derived from it
        paintAudioPanels();
        // …but only for the NEXT capture. The microphone in a call that is
        // already running was acquired with the browser's suppressor switched
        // off ("RNNoise owns it"), and nothing re-acquires it — so promising a
        // fallback that has not happened yet left the user believing their fan
        // and keyboard were being filtered when neither filter was running.
        // Every sibling control that changes this chain says "rejoin"; this one
        // has more reason to than any of them.
        const live = !!(voice && (voice.isJoined() || voice.isJoining()));
        toast(live
            ? 'AI noise suppression could not start — rejoin voice to use standard noise suppression'
            : 'AI noise suppression could not start — using standard noise suppression instead', true);
    }
    // The hidden legacy select. Kept wired because the four-name scale is still
    // written to the profile, so anything that sets it (an older build, a test)
    // still moves the size.
    $('set-font-size').addEventListener('change', (e) => {
        setChatFontPx(FONT_SIZES[fontSizeIndex(e.target.value)].px);
    });

    // ---- Accessibility controls ------------------------------------------
    //
    // Every one of these writes the setting, then calls the single apply function
    // for its family. `input` rather than `change` on the sliders, so the app moves
    // under the thumb while it is being dragged — which is the whole reason the
    // preview is on the same pane.

    $('set-font-px').addEventListener('input', (e) => { setChatFontPx(e.target.value); });

    $('set-msg-gap').addEventListener('input', async (e) => {
        const v = Math.max(0, Math.min(24, parseInt(e.target.value, 10) || 0));
        await saveSettings({ msgGroupGap: v });
        paintTicks('ticks-gap', v);
        applyAccessibility();
        renderA11yPreview();
    });

    $('set-saturation').addEventListener('input', async (e) => {
        const v = Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0));
        await saveSettings({ saturation: v });
        paintTicks('ticks-sat', v);
        applyAccessibility();
    });

    // Zoom is the one that cannot be applied on every pointer move: each call is
    // an IPC round trip AND a full relayout of the window. Debounced, with the
    // ticks and the stored value kept live so the control still feels immediate.
    let zoomTimer = null;
    $('set-zoom').addEventListener('input', (e) => {
        const v = Math.max(50, Math.min(200, parseInt(e.target.value, 10) || 100));
        paintTicks('ticks-zoom', v);
        if (zoomTimer) clearTimeout(zoomTimer);
        zoomTimer = setTimeout(async () => {
            zoomTimer = null;
            await saveSettings({ zoomLevel: v });
            applyZoom();
        }, 120);
    });

    wireSwitch('set-underline', () => !!settings.underlineLinks, async (v) => {
        await saveSettings({ underlineLinks: v });
        applyAccessibility();
    });
    wireSwitch('set-contrast', () => !!settings.highContrast, async (v) => {
        await saveSettings({ highContrast: v });
        applyAccessibility();
    });
    wireSwitch('set-reduced-motion', () => !!settings.reducedMotion, async (v) => {
        await saveSettings({ reducedMotion: v });
        applyAccessibility();
    });
    wireSwitch('set-announce', () => !!settings.announceMessages, async (v) => {
        await saveSettings({ announceMessages: v });
        applyAccessibility();
        toast(v ? 'New messages will be announced' : 'New messages will not be announced');
    });

    wireRadios('set-uidensity',
        () => (['compact', 'default', 'spacious'].includes(settings.uiDensity) ? settings.uiDensity : 'default'),
        async (v) => { await saveSettings({ uiDensity: v }); applyAccessibility(); });

    wireRadios('set-msgdisplay',
        () => (settings.density === 'compact' ? 'compact' : 'cozy'),
        async (v) => {
            await saveSettings({ density: v });
            applyDensity();
            renderMessages();
            renderA11yPreview();
        });

    wireRadios('set-theme',
        () => (['dark', 'light', 'system'].includes(settings.theme) ? settings.theme : 'dark'),
        async (v) => {
            await saveSettings({ theme: v });
            $('set-theme').value = v;
            applyTheme();
            renderA11yPreview();
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

    // The OS login item is the source of truth for both of these, so they are
    // read back from it after every write rather than assumed — Windows can
    // refuse, and a switch that flipped anyway would be lying.
    //
    // "Start minimized" only makes sense when launch-on-startup is on, and the
    // reference greys it out rather than hiding it, which is also what says WHY.
    function updateLaunchHiddenEnabled() {
        const on = !!settings.launchOnStartup;
        const row = $('row-launch-hidden');
        if (row) row.classList.toggle('disabled', !on);
        const sw = $('set-launch-hidden');
        if (sw) sw.disabled = !on;
    }

    async function applyStartup(openAtLogin, openAsHidden) {
        const li = await L.startup.set(!!openAtLogin, !!(openAtLogin && openAsHidden));
        // Keep the mirror in settings, and reuse startMinimized for the "open
        // hidden" behaviour so a manual launch behaves the same.
        await saveSettings({ launchOnStartup: !!li.openAtLogin, startMinimized: !!li.openAsHidden });
        paintSwitches();
        updateLaunchHiddenEnabled();
    }

    wireSwitch('set-launch', () => !!settings.launchOnStartup,
        (v) => applyStartup(v, settings.startMinimized));
    wireSwitch('set-launch-hidden', () => !!settings.startMinimized,
        (v) => applyStartup(settings.launchOnStartup, v));

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

    $('btn-check-update').addEventListener('click', async () => {
        $('update-status').textContent = 'Checking for updates…';
        const r = await L.update.check();
        if (r && r.reason === 'dev') $('update-status').textContent = 'Updates are only available in the installed app.';
    });

    // ---- System + Notifications switches ---------------------------------

    wireSwitch('set-tray', () => settings.minimizeToTray !== false,
        (v) => saveSettings({ minimizeToTray: v }));
    wireSwitch('set-autojoin', () => !!settings.autoJoinVoice,
        (v) => saveSettings({ autoJoinVoice: v }));

    // Hardware acceleration can only be told to Chromium before the app is ready,
    // so this is the one setting that asks to restart. It says so, and it offers —
    // it does not restart out from under somebody, and it does not pretend to have
    // taken effect either.
    wireSwitch('set-hwaccel', () => settings.hardwareAcceleration !== false, async (v) => {
        await saveSettings({ hardwareAcceleration: v });
        const ok = await askConfirm(
            v ? 'Turn hardware acceleration on?' : 'Turn hardware acceleration off?',
            'ScarmVoice has to restart for this to take effect. Restart now?',
            'Restart now');
        if (ok) { try { await L.app.relaunch(); } catch (e) { toast('Could not restart — close and reopen the app', true); } }
        else toast('Saved — it takes effect the next time ScarmVoice starts');
    });

    wireSwitch('set-notify', () => settings.notifications !== false,
        (v) => saveSettings({ notifications: v }));
    wireSwitch('set-taskbar-flash', () => settings.taskbarFlash !== false,
        (v) => saveSettings({ taskbarFlash: v }));
    wireSwitch('set-badge', () => settings.badgeUnread !== false, async (v) => {
        await saveSettings({ badgeUnread: v });
        // Applied at once: turning it off has to clear the number that is already
        // on the taskbar button, not wait for the next message.
        renderChannels();
    });
    // Preview the sound on enable, so the toggle proves itself.
    wireSwitch('set-notify-sound', () => settings.notificationSound !== false, async (v) => {
        await saveSettings({ notificationSound: v });
        if (v) window.loungeSounds.playMessage();
    });
    wireSwitch('set-sound-own', () => !!settings.soundOwnChannel, async (v) => {
        await saveSettings({ soundOwnChannel: v });
        if (v) window.loungeSounds.playMessage();
    });
    wireSwitch('set-voice-sounds', () => settings.voiceSounds !== false, async (v) => {
        await saveSettings({ voiceSounds: v });
        if (v) window.loungeSounds.playVoice('join');
    });
    // The master switch. Kept apart from Do Not Disturb, which also silences
    // toasts and badges — this one is sounds only, and it leaves the individual
    // choices above alone so turning it off restores them.
    wireSwitch('set-mute-sounds', () => !!settings.disableAllSounds, async (v) => {
        await saveSettings({ disableAllSounds: v });
        window.loungeSounds.init(settings);
        toast(v ? 'All notification sounds off' : 'Notification sounds restored');
    });

    // Preview Sound, under each sound's name.
    document.querySelectorAll('.set-preview').forEach((b) => {
        b.addEventListener('click', () => {
            // Deliberately ignores the toggles: this is "what does this sound
            // like", not "would I hear it right now".
            if (b.dataset.preview === 'join') window.loungeSounds.playVoice('join');
            else window.loungeSounds.playMessage();
        });
    });

    // Hotkey recorder: captures the next key or mouse button pressed. Shared
    // by push-to-talk and the mute/deafen toggles — one recorder at a time,
    // guarded by the same recordingPtt flag the in-window PTT handlers respect.
    // `btnIds` may name MORE THAN ONE button for the same binding: push-to-talk,
    // mute and deafen are each reachable from two panes now (Voice & Audio's
    // advanced block and System's keybind list), and they are ONE setting. Both
    // buttons record into it and both are repainted, so the two panes cannot show
    // different keys for the same hotkey.
    function bindKeyRecorder(btnIds, settingKey, afterSave) {
        const ids = Array.isArray(btnIds) ? btnIds : [btnIds];
        const buttons = () => ids.map((id) => $(id)).filter(Boolean);
        const repaint = async () => {
            const text = (await L.ptt.describe(settings[settingKey])) || 'Click to set';
            buttons().forEach((b) => { b.textContent = text; });
        };
        buttons().forEach((btn) => btn.addEventListener('click', () => {
            if (recordingPtt) return;
            recordingPtt = true;
            btn.classList.add('recording');
            btn.textContent = 'Press any key…';

            const finish = async (binding, clear) => {
                recordingPtt = false;
                // Nulled first, so a cancel that arrives while this is running
                // (closeSettings during teardown, say) cannot re-enter.
                cancelKeyRecorder = null;
                btn.classList.remove('recording');
                window.removeEventListener('keydown', onKey, true);
                window.removeEventListener('mousedown', onMouse, true);
                if (binding || clear) {
                    await saveSettings({ [settingKey]: binding });
                    await applyPtt();
                }
                await repaint();
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
            // Escape cancels, but only if you are still looking at the sheet.
            // Closing Settings with the recorder armed used to leave both
            // capture listeners attached: push-to-talk was dead until the next
            // keystroke ANYWHERE, and that keystroke was then swallowed and
            // saved as the binding — a character vanishing out of a message and
            // a global hotkey silently rebound, with nothing on screen to
            // explain either. Cancel is exactly the Escape path.
            cancelKeyRecorder = () => finish(null, false);
        }));
    }
    bindKeyRecorder(['set-ptt', 'set-ptt-2'], 'pttBinding', refreshPttHint);
    bindKeyRecorder(['set-mute-key', 'set-mute-key-2'], 'muteBinding');
    bindKeyRecorder(['set-deafen-key', 'set-deafen-key-2'], 'deafenBinding');

    // "Sign out" means out of EVERYTHING — board session and account — so the
    // next sign-in walks both steps again. One function, because it is now
    // offered from two places (Settings, and the account panel over your name)
    // and half a sign-out is worse than none.
    async function signOutEverything() {
        await teardownSession();
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
    }

    $('btn-logout').addEventListener('click', signOutEverything);

    // The same thing from the account panel. Asked first: this one sits two
    // clicks from anywhere, right under "Copy User ID", and signing out costs a
    // password and a second sign-in step to undo.
    $('mep-logout').addEventListener('click', async () => {
        closeMePopover();
        const ok = await askConfirm(
            'Log out of ScarmVoice?',
            'You will be signed out of your account and of the board itself, so ' +
            'signing back in takes the shared password and then your account.',
            'Log Out', true
        );
        if (ok) await signOutEverything();
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

    // Where focus was when a keyboard-opened menu appeared, so closing it hands the
    // caret back instead of leaving it on a hidden button.
    let ctxReturnFocus = null;

    function closeCtxMenu() {
        $('ctx-menu').hidden = true;
        if (!ctxReturnFocus) return;
        const back = ctxReturnFocus;
        ctxReturnFocus = null;
        try { if (back.isConnected) back.focus(); } catch (e) {}
    }

    // Where the last menu was opened, so an action that opens a popup of its own
    // (React…) can anchor it at the cursor after the menu has closed.
    let lastMenuAt = { x: 0, y: 0 };

    // items: [{ label, icon, danger, disabled, onClick } | 'sep']
    // `keyboard` = summoned by a key rather than the pointer. Then, and only then,
    // the menu takes focus and the arrows walk it: a menu opened from the message
    // list's Enter handler used to appear with focus still on the message behind
    // it, so the only key that did anything was Escape — the items were reachable
    // exclusively by mouse, from a handler that exists to avoid needing one. Left
    // alone for a right-click, because Cut/Copy/Paste act on whatever was focused
    // when the menu opened.
    function openCtxMenu(items, x, y, keyboard) {
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
            // `strong` is for an item whose label is CONTENT rather than the name of
            // a command — a spelling suggestion is a word that will be inserted, not
            // an action. Every browser bolds them for that reason, and it is what
            // keeps them from reading as four more commands.
            b.className = 'ctx-item' + (it.danger ? ' danger' : '') +
                (it.check ? ' checked' : '') + (it.strong ? ' strong' : '');
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

        if (keyboard) {
            ctxReturnFocus = document.activeElement;
            const first = menu.querySelector('.ctx-item:not([disabled])');
            if (first) first.focus();
        }
    }

    // Arrow-key navigation, for a menu that was opened by keyboard. Bound once on
    // the container rather than per item, so it covers every menu this function
    // builds. Home/End because the menus are long enough for it to matter.
    $('ctx-menu').addEventListener('keydown', (e) => {
        const items = Array.from($('ctx-menu').querySelectorAll('.ctx-item:not([disabled])'));
        if (!items.length) return;
        const idx = items.indexOf(document.activeElement);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const step = e.key === 'ArrowDown' ? 1 : -1;
            // Wraps, the way a native menu does — the list is short and there is
            // nothing past either end to fall through to.
            const next = idx === -1 ? (step > 0 ? 0 : items.length - 1)
                : (idx + step + items.length) % items.length;
            items[next].focus();
        } else if (e.key === 'Home' || e.key === 'End') {
            e.preventDefault();
            (e.key === 'Home' ? items[0] : items[items.length - 1]).focus();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            closeCtxMenu();
        }
    });

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
        // The same rule the hover action bar follows: reply, threads, reactions
        // and pins all read and write the posts table, and a DM is not a post.
        // The action bar dropped them; this menu — which right-clicking any
        // message opens — kept offering all four, so they were still one click
        // away and answered with "Not found" or, for React, with nothing at all.
        //
        // Block goes too: a DM row's client_id is a synthetic 'dm-user-<id>'
        // (see renderDmMessages), so blocking one filed a key nothing else in
        // the app ever matches.
        const dm = !!p.isDm;

        // ---- the two PERSON actions, as opposed to the message ones ----
        //
        // Addressed by ACCOUNT (p.user_id), never by install: a client_id is
        // published with every message, so acting on one would let anybody name
        // anybody — and a message written before accounts existed carries no
        // author at all, which is why this is hidden rather than offered and
        // then refused.
        //
        // Skipped inside a one-to-one conversation, where the only thread it
        // could open is the one already on screen. A GROUP dm is the opposite
        // case: taking someone aside from a group is exactly when you want it,
        // and that is a different conversation.
        const oneToOne = dm && !!dmOpen && !dmOpen.isGroup;
        const canDm = !!(account && p.user_id && !wroteByMe(p) && !oneToOne);
        // Block is keyed by INSTALL id (settings.blocked) — see isBlocked — and
        // a DM row's client_id is a synthetic 'dm-user-<id>' that nothing else
        // in the app matches, so it stays out of a conversation entirely.
        const canBlock = !dm && !mine && !!p.client_id;

        return [
            !dm && (inThread
                ? { label: 'Reply', icon: 'reply', onClick: () => $('thread-input').focus() }
                : { label: 'Reply', icon: 'reply', onClick: () => setReplyTarget(p) }),
            !dm && !inThread && { label: 'Reply in thread', icon: 'thread', onClick: () => openThread(p.id) },
            // Anchored at the cursor, since the menu itself is gone by then.
            !dm && { label: 'React…', icon: 'smile', onClick: () => openEmojiPicker(pointAnchor(lastMenuAt.x, lastMenuAt.y), (em) => react(p.id, em)) },
            !dm && 'sep',
            { label: 'Copy text', icon: 'copy', onClick: () => copyMessage(p) },
            p.att_key && { label: 'Save attachment…', icon: 'download', onClick: () => saveAttachment(p.att_key, p.att_name) },
            // Admins anything, members only their own — see mayPin.
            !dm && mayPin(p) && { label: p.pinned ? 'Unpin' : 'Pin', icon: 'pin', onClick: () => pinPost(p.id, !p.pinned) },
            mine && 'sep',
            mine && { label: 'Edit message', icon: 'pencil', onClick: () => startEdit(p, el) },
            mine && { label: 'Delete message', icon: 'trash', danger: true, onClick: () => deletePost(p) },
            // A DM's delete endpoint checks authorship as well as membership, so
            // an admin acting on someone else's message would be refused.
            // Editing and deleting somebody ELSE's message — the moderation
            // capability. Labelled "(moderator)" so it is never mistaken for the
            // ordinary edit of your own message; the edit is attributed on the
            // message itself afterwards.
            !dm && !mine && can('message.moderate') && 'sep',
            !dm && !mine && can('message.moderate') && {
                label: 'Edit (moderator)', icon: 'pencil',
                onClick: () => startEdit(p, el)
            },
            !dm && !mine && can('message.moderate') && { label: 'Delete (moderator)', icon: 'trash', danger: true, onClick: () => deletePost(p) },
            // One separator for the person group, whichever of the two it holds.
            (canDm || canBlock) && 'sep',
            canDm && {
                label: 'Message ' + (p.name || 'them'), icon: 'send',
                onClick: () => messageUser(p.user_id)
            },
            canBlock && {
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
        // The same rule deletePost applies, for the same reason: the affordances are
        // gated, but a keyboard shortcut, a stale menu or a repaint that raced a
        // role change all reach here without passing one — and the answer should be
        // the reason rather than a bare 403 after the editor has already opened.
        if (!ownsPost(p) && !can('message.moderate')) {
            return toast('You can only edit your own messages', true);
        }
        const textEl = el.querySelector('.msg-text');
        if (!textEl) return;
        editingId = p.id;

        const wrap = document.createElement('div');
        wrap.className = 'msg-edit';
        wrap.innerHTML =
            // Uncapped, like both composers: an edit box that refuses to hold the
            // message it was opened on cannot save it either.
            '<textarea></textarea>' +
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
            // The editor may have been inside a conversation, which has its own
            // renderer — and which has been holding its updates back for
            // exactly as long as this editor was open.
            if (dmPanelOpen()) renderDmMessages();
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
            // Same split as delete: /edit reads the posts table, so a DM has to
            // go to its own endpoint or it fails the same way.
            const res = p.isDm
                ? await L.board('dm/message', { method: 'POST', body: { id: p.id, action: 'edit', body } })
                : await L.board('edit', {
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
            if (p.isDm) {
                // Reload the conversation, not the channel — loadMessages here
                // would refresh whatever channel sits behind the DM view and
                // leave the edited message on screen unchanged.
                await loadDmMessages(true);
                loadDmThreads();
                return toast('Message edited');
            }

            // The server stamps edited_at, so reload rather than guessing — that
            // makes the "(edited)" marker reflect real server state.
            await loadMessages(false);
            // 'refresh': peers should refetch, but nobody wrote anything, so this
            // must not raise an unread badge or a "New message" notification for
            // a reader in another channel.
            L.rt.notifyPosted(channel, null, 'refresh');
            toast('Message edited');
        });
    }

    async function deletePost(p) {
        if (!can('message.moderate') && !ownsPost(p)) return toast('You can only delete your own messages', true);

        const preview = (p.body || p.att_name || '').slice(0, 80);
        const ok = await askConfirm(
            'Delete this message?',
            preview ? `“${preview}${preview.length >= 80 ? '…' : ''}” will be permanently removed.`
                : 'This message will be permanently removed.',
            'Delete', true
        );
        if (!ok) return;

        // A DM is not a post: /delete reads the posts table, so sending a DM's
        // id there asked for a post that does not exist and came back "Not
        // found". Its own endpoint checks membership AND authorship.
        if (p.isDm) {
            const dres = await L.board('dm/message', { method: 'POST', body: { id: p.id, action: 'delete' } });
            if (authGone(dres)) return;
            if (!dres || !dres.success) return toast((dres && dres.error) || 'Could not delete', true);
            dmMsgs = dmMsgs.filter((x) => x.id !== p.id);
            renderDmMessages();
            loadDmThreads();          // the thread list shows the last message
            return toast('Message deleted');
        }

        // clientId lets the server enforce ownership for signed-in members.
        const res = await L.board('delete', { method: 'POST', body: { id: p.id, clientId: settings.clientId } });
        if (authGone(res)) return;
        if (!res || !res.success) return toast((res && res.error) || 'Could not delete', true);

        posts = posts.filter((x) => x.id !== p.id);
        // A local echo is retired by a server page CARRYING the message, which
        // a deleted one never will — so it has to be dropped by hand or it
        // lingers on screen for the length of the echo window.
        selfEchoes = selfEchoes.filter((e) => e.id !== p.id);
        renderMessages();
        await loadMessages(false);
        L.rt.notifyPosted(channel, null, 'refresh');   // a refetch nudge, not a new message
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
    //
    // Matched on the KIND of message as well as its id. A DM id and a post id
    // come out of two different tables and collide freely — both sequences start
    // at 1 — so a channel post's late-arriving preview could be grafted onto
    // whichever conversation message happened to share its number, and vice
    // versa. (A thread reply and a channel row legitimately share an id: they
    // are the same post drawn twice, which is exactly what this loop is for.)
    function graft(post, url, build) {
        const kind = post.isDm ? '.msg[data-dm]' : '.msg:not([data-dm])';
        document.querySelectorAll(`${kind}[data-id="${post.id}"] .msg-previews`).forEach((c) => {
            if (c.querySelector(`[data-preview-url="${CSS.escape(url)}"]`)) return;
            const el = build();
            if (!el) return;
            el.dataset.previewUrl = url;
            c.appendChild(el);
        });
    }

    // Detection order per url: YouTube → direct image → generic OG preview.
    // A message with several links renders each independently.
    // The prose of a message, with fenced and inline code removed.
    //
    // Previews were built from the raw body, so a url inside ```a code fence```
    // — which the renderer deliberately shows verbatim, as code — still got
    // unfurled, and a link to an image still rendered the image itself under the
    // block. Pasting a snippet containing a URL therefore fetched it and drew a
    // card for it, which is exactly what a code fence says not to do.
    //
    // Only the SCAN text is filtered; post.body is untouched everywhere else.
    function previewScanText(body) {
        return String(body)
            .split('```')
            .filter((_, i) => i % 2 === 0)      // odd segments are inside a fence
            .join(' ')
            .replace(/`[^`\n]*`/g, ' ');        // …and inline spans
    }

    function renderPreviews(container, post) {
        if (!container || !post.body) return;

        extractUrls(previewScanText(post.body)).forEach((url) => {
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
                // Another message with the same video is already asking. JOIN that
                // request instead of giving up on it: 'pending' used to mean "no
                // card here", so with the same link in two messages only the first
                // ever showed a preview — and the second stayed bare for good,
                // because the finished answer replaced the marker and nothing
                // re-rendered the row that had already skipped it.
                if (cached === 'pending') { joinPreview(youtubeCache, vid, post, url, youtubeCard); return; }

                cachePut(youtubeCache, vid, 'pending');
                L.youtube(vid).then((info) => {
                    cachePut(youtubeCache, vid, info || null);
                    if (info) graft(post, url, () => youtubeCard(info));
                    flushPreviewWaiters(vid, info || null);
                }).catch(() => { cachePut(youtubeCache, vid, null); flushPreviewWaiters(vid, null); });
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
            // See the YouTube branch: wait for the request already in flight rather
            // than treating "somebody else is asking" as "there is nothing to show".
            if (cached === 'pending') { joinPreview(previewCache, url, post, url, linkCard); return; }

            cachePut(previewCache, url, 'pending');
            L.unfurl(url).then((res) => {
                const preview = (res && res.success && res.preview) ? res.preview : null;
                cachePut(previewCache, url, preview);
                // Graft into the live node instead of re-rendering the list, so
                // the reader's scroll position is never disturbed.
                if (preview) graft(post, url, () => linkCard(preview));
                flushPreviewWaiters(url, preview);
            }).catch(() => { cachePut(previewCache, url, null); flushPreviewWaiters(url, null); });
        });
    }

    // Messages waiting on a preview fetch somebody else started, keyed by the same
    // cache key that fetch will resolve. Each entry grafts its own card when the
    // answer lands, so two messages with the same link both get one.
    const previewWaiters = new Map();

    function joinPreview(map, key, post, url, build) {
        // The answer may have landed between the cache read and this call.
        const now = map.get(key);
        if (now && now !== 'pending') { graft(post, url, () => build(now)); return; }
        if (now === null) return;
        const list = previewWaiters.get(key) || [];
        // One waiter per (message, url): renderPreviews runs again on every repaint
        // of the row, and an unbounded list would grow for as long as the fetch took.
        if (list.some((w) => w.post.id === post.id && w.post.isDm === post.isDm && w.url === url)) return;
        list.push({ post, url, build });
        previewWaiters.set(key, list);
    }

    function flushPreviewWaiters(key, value) {
        const list = previewWaiters.get(key);
        if (!list) return;
        previewWaiters.delete(key);
        if (!value) return;                     // nothing to show; the plain link stands
        list.forEach((w) => { try { graft(w.post, w.url, () => w.build(value)); } catch (e) {} });
    }

    // ---------- search ----------------------------------------------------
    //
    // ONE box, in the header, holding ONE string. `from:alice has:link lunch`
    // is a query and two filters, and the string is the source of truth for
    // both: the dropdown does not keep filters beside it, it WRITES operators
    // into it. That is what lets them be typed and clicked at the same time —
    // there is only one representation, so the two can never disagree.
    //
    // It replaced a second search UI, a row under the channel header with its
    // own input, its own scope toggle and its own filter menu. Two boxes that
    // filtered the same list in two different ways, and neither knew about the
    // other.
    //
    // What the operators narrow is the messages ALREADY LOADED, live. Text also
    // goes to the archive endpoint, which is the only part that leaves the
    // machine — so "images from Alice matching logo" resolves here instantly
    // and the archive answers underneath it.

    const { parseSearchQuery, opAtCaret, writeOp, HAS_KINDS } = window.ScarmLib;

    function searchOpen() { return !$('search-pop').hidden; }
    const searchInput = () => $('search-input');

    // Everyone who has written something in the loaded messages, keyed by the
    // label shown. Grouped by display NAME — one person posting from two
    // devices is still one person — and carrying the ACCOUNT ids seen under
    // that name, because a client_id is per-install and one person's history
    // routinely spans several. See postFrom() in lib.js.
    function peopleInView() {
        const byLabel = new Map();
        posts.forEach((p) => {
            const name = p.name || 'Anonymous';
            if (!byLabel.has(name)) byLabel.set(name, { label: name, names: new Set(), userIds: new Set() });
            const e = byLabel.get(name);
            e.names.add(name);
            if (p.user_id) e.userIds.add(p.user_id);
        });
        // Anyone with an account but nothing on screen belongs in the list too:
        // "from: somebody who has not spoken lately" is a reasonable thing to
        // ask, and offering only the recent talkers answers a different question.
        roster.forEach((u) => {
            if (u.banned || byLabel.has(u.username)) return;
            byLabel.set(u.username, {
                label: u.username, names: new Set([u.username]), userIds: new Set([u.id])
            });
        });
        return byLabel;
    }

    // A date operator's value -> a timestamp. Accepts what a person types:
    // 2026-03-15, 2026-03, 2026. Anything else is ignored rather than guessed
    // at — a filter built from a misreading is worse than no filter.
    function dayStart(v) {
        const m = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/.exec(String(v || '').trim());
        if (!m) return null;
        const d = new Date(Number(m[1]), (Number(m[2] || 1) - 1), Number(m[3] || 1));
        return isNaN(d.getTime()) ? null : d.getTime();
    }
    const DAY_MS = 24 * 60 * 60 * 1000;

    // The box -> the filter. The single place the string becomes state.
    function applyQuery() {
        const raw = searchInput().value;
        const q = parseSearchQuery(raw);
        const ops = q.ops;

        filter.text = q.text;
        filter.types.clear();
        (ops.has || []).forEach((v) => {
            const t = HAS_KINDS[String(v).toLowerCase()];
            if (t) filter.types.add(t);
        });

        // `from:` resolves against the people we know about; an unknown name
        // still filters, on the name alone, so a typo narrows to nothing rather
        // than silently matching everyone.
        const people = peopleInView();
        const froms = ops.from || [];
        if (froms.length) {
            const names = new Set();
            const userIds = new Set();
            froms.forEach((v) => {
                const hit = [...people.values()].find(
                    (c) => c.label.toLowerCase() === String(v).toLowerCase());
                if (hit) { hit.names.forEach((n) => names.add(n)); hit.userIds.forEach((i) => userIds.add(i)); }
                else names.add(v);
            });
            filter.from = { label: froms.join(', '), names, userIds };
            filter.fromName = froms.join(', ');
        } else {
            filter.from = filter.fromName = null;
        }

        filter.mentionsNames = (ops.mentions || []).slice();
        filter.inChannel = ops.in ? String(ops.in[0]) : null;

        // `author:` resolves to the same identity shape `from` uses, so the
        // matcher needs no new logic. Roles come from the account directory,
        // which is the only place they exist.
        const kind = ops.author ? String(ops.author[0]).toLowerCase() : null;
        if (!kind) {
            filter.author = null;
        } else if (kind === 'me') {
            filter.author = {
                label: 'You',
                names: new Set([settings.displayName || 'Anonymous']),
                userIds: new Set(account ? [account.id] : [])
            };
        } else {
            const who = roster.filter((u) => (u.role || 'member') === kind);
            filter.author = {
                label: kind,
                names: new Set(who.map((u) => u.username)),
                userIds: new Set(who.map((u) => u.id))
            };
        }

        // `pinned:` with no value, or pinned:true, means pinned; pinned:false
        // means "and NOT pinned"; absent means either. Three answers, so three
        // values — as a boolean the third and the second were the same thing,
        // and "Anything but pinned" in the form was a control with no effect.
        const pin = ops.pinned ? String(ops.pinned[0]).toLowerCase() : null;
        filter.pinned = pin === null ? null : !(pin === 'false' || pin === 'no');

        const before = ops.before ? dayStart(ops.before[0]) : null;
        const after = ops.after ? dayStart(ops.after[0]) : null;
        const during = ops.during ? dayStart(ops.during[0]) : null;
        // "during the 15th" is the whole of that day, which is two bounds.
        filter.before = during !== null ? during + DAY_MS : before;
        filter.after = during !== null ? during - 1 : after;

        $('search-clear').hidden = raw === '';
        applyFilter();
    }

    function clearSearch() {
        searchInput().value = '';
        filter.text = '';
        filter.types.clear();
        filter.pinned = null;       // "either", not "not pinned"
        filter.mentions = filter.edited = false;
        filter.from = filter.fromName = null;
        filter.mentionsNames = [];
        filter.inChannel = null;
        filter.author = null;
        filter.before = filter.after = null;
        $('search-clear').hidden = true;
        hideSearchResults();
        applyFilter();
    }

    // The single entry point for any filter change: re-renders the (filtered)
    // list and restores scroll when the filters go inactive.
    function applyFilter() {
        const active = filterActive();
        if (active && filterScrollTop === null) filterScrollTop = $('messages').scrollTop;
        renderMessages();
        if (!active) {
            if (filterScrollTop !== null) {
                const t = filterScrollTop; filterScrollTop = null;
                requestAnimationFrame(() => { $('messages').scrollTop = t; settleScroll(); });
            }
        }
        settleScroll();
    }

    // ---------- the filters dropdown --------------------------------------

    // The four things the reference offers, each an operator with the hint that
    // says how to type it — because the hint IS the feature: read it once and
    // you never need the menu again.
    const FILTER_ROWS = [
        { icon: 'users', key: 'from', title: 'From a specific user', hint: 'from: user' },
        { icon: 'paperclip', key: 'has', title: 'Includes a specific type of data', hint: 'has: link, embed or file' },
        { icon: 'at', key: 'mentions', title: 'Mentions a specific user', hint: 'mentions: user' }
    ];
    // has: values, in the reference's vocabulary.
    const HAS_ROWS = [
        ['link', 'Links'], ['embed', 'Embeds'], ['file', 'Any file'],
        ['image', 'Images'], ['video', 'Videos'], ['sound', 'Audio']
    ];

    function openSearchPop() {
        $('search-pop').hidden = false;
        searchInput().setAttribute('aria-expanded', 'true');
        renderSearchPop();
    }
    function closeSearchPop() {
        $('search-pop').hidden = true;
        searchInput().setAttribute('aria-expanded', 'false');
    }

    // One row. `onPick` writes into the box and re-parses — every row in this
    // menu is a shortcut for typing, never a second way to hold state.
    function popRow({ icon, title, hint, onPick, on }) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'sp-row' + (on ? ' on' : '');
        b.setAttribute('role', 'option');
        b.innerHTML = I(icon, 'ico sp-ico') +
            '<span class="sp-text"><span class="sp-title">' + esc(title) + '</span>' +
            (hint ? '<span class="sp-hint">' + esc(hint) + '</span>' : '') + '</span>';
        b.addEventListener('mousedown', (e) => e.preventDefault());   // keep the caret
        b.addEventListener('click', onPick);
        return b;
    }

    function popHead(text) {
        const h = document.createElement('div');
        h.className = 'sp-head';
        h.textContent = text;
        return h;
    }

    // Put `key:value` into the box where the caret is, then re-parse.
    function pickOperator(key, value) {
        const el = searchInput();
        const at = value === undefined ? null : opAtCaret(el.value, el.selectionStart);
        const out = writeOp(el.value, key, value === undefined ? '' : value, at);
        // With no value this is "start typing this operator": the trailing space
        // writeOp adds would end the token before it began.
        el.value = value === undefined ? out.text.replace(/\s$/, '') : out.text;
        el.setSelectionRange(el.value.length, el.value.length);
        el.focus();
        applyQuery();
        renderSearchPop();
        if (value !== undefined) runSearch();
    }

    function renderSearchPop() {
        const pop = $('search-pop');
        pop.innerHTML = '';
        const el = searchInput();
        const at = opAtCaret(el.value, el.selectionStart);

        // Mid-operator: offer its VALUES. Offering "from: user" to somebody who
        // has already typed `from:` is answering a question they have moved past.
        if (at) {
            const typed = at.value.toLowerCase();
            if (at.key === 'from' || at.key === 'mentions') {
                pop.appendChild(popHead(at.key === 'from' ? 'From' : 'Mentions'));
                const list = [...peopleInView().values()]
                    .filter((c) => c.label.toLowerCase().includes(typed))
                    .sort((a2, b2) => a2.label.localeCompare(b2.label))
                    .slice(0, 8);
                if (!list.length) pop.appendChild(popHead('Nobody by that name'));
                list.forEach((c) => pop.appendChild(popRow({
                    icon: 'users', title: c.label, hint: '',
                    onPick: () => pickOperator(at.key, c.label)
                })));
            } else if (at.key === 'has') {
                pop.appendChild(popHead('Has'));
                HAS_ROWS.filter(([v]) => v.includes(typed)).forEach(([v, label]) =>
                    pop.appendChild(popRow({
                        icon: 'paperclip', title: label, hint: 'has: ' + v,
                        onPick: () => pickOperator('has', v)
                    })));
            } else if (at.key === 'in') {
                pop.appendChild(popHead('In'));
                channels.filter((c) => c.name.includes(typed)).slice(0, 8).forEach((c) =>
                    pop.appendChild(popRow({
                        icon: 'doc', title: '#' + c.name, hint: '',
                        onPick: () => pickOperator('in', c.name)
                    })));
            } else if (at.key === 'pinned') {
                pop.appendChild(popHead('Pinned'));
                [['true', 'Only pinned'], ['false', 'Anything but pinned']].forEach(([v, label]) =>
                    pop.appendChild(popRow({
                        icon: 'pin', title: label, hint: 'pinned: ' + v,
                        onPick: () => pickOperator('pinned', v)
                    })));
            } else {
                // A date: there is nothing to list, so say what shape it wants.
                pop.appendChild(popHead('Date'));
                pop.appendChild(popRow({
                    icon: 'archive', title: 'Type a date', hint: 'YYYY-MM-DD, YYYY-MM or YYYY', onPick: () => {}
                }));
            }
            return;
        }

        pop.appendChild(popHead('Filters'));
        FILTER_ROWS.forEach((r) => pop.appendChild(popRow(
            Object.assign({}, r, { onPick: () => pickOperator(r.key) }))));

        // "More filters" opens the form, rather than growing this list into one
        // — the extra criteria are a different shape of question (a date, a
        // role, a channel) and a menu that answers by adding eight more rows
        // is a list you scroll rather than a thing you fill in.
        pop.appendChild(popRow({
            icon: 'sliders', title: 'More filters', hint: 'dates, author type, and more',
            onPick: () => { closeSearchPop(); openFiltersModal(); }
        }));
    }

    // ---------- the filters form ------------------------------------------
    //
    // Every field here is one of the operators the box already understands, so
    // the form READS the box on open and WRITES it on apply. It holds no state
    // of its own between those two moments, which is what keeps it from ever
    // disagreeing with what is typed.

    function fillPeopleSelect(sel, chosen) {
        sel.innerHTML = '';
        const any = document.createElement('option');
        any.value = '';
        any.textContent = 'Anyone';
        sel.appendChild(any);
        [...peopleInView().values()]
            .sort((a, b) => a.label.localeCompare(b.label))
            .forEach((c) => {
                const o = document.createElement('option');
                o.value = c.label;
                o.textContent = c.label;
                sel.appendChild(o);
            });
        // Somebody named in the box who is not in the list still belongs in it,
        // or opening the form would silently drop a filter that is applied.
        if (chosen && ![...sel.options].some((o) => o.value === chosen)) {
            const o = document.createElement('option');
            o.value = chosen;
            o.textContent = chosen;
            sel.appendChild(o);
        }
        sel.value = chosen || '';
    }

    function fillChannelSelect(sel, chosen) {
        sel.innerHTML = '';
        const any = document.createElement('option');
        any.value = '';
        any.textContent = 'Any channel';
        sel.appendChild(any);
        channels.forEach((c) => {
            const o = document.createElement('option');
            o.value = c.name;
            o.textContent = '#' + c.name;
            sel.appendChild(o);
        });
        if (chosen && ![...sel.options].some((o) => o.value === chosen)) {
            const o = document.createElement('option');
            o.value = chosen;
            o.textContent = '#' + chosen;
            sel.appendChild(o);
        }
        sel.value = chosen || '';
    }

    // The date operator's value exactly as it was in the box, which <input
    // type="date"> cannot always hold. See openFiltersModal.
    let fmDateRaw = '';

    function openFiltersModal() {
        const ops = parseSearchQuery(searchInput().value).ops;
        const first = (k) => (ops[k] ? String(ops[k][0]) : '');

        fillPeopleSelect($('fm-from'), first('from'));
        fillPeopleSelect($('fm-mentions'), first('mentions'));
        fillChannelSelect($('fm-in'), first('in'));
        // `has:audio` and `has:sound` mean the same thing to the parser (see
        // lib.js HAS_KINDS), but only "sound" is an <option> — so a box reading
        // `has:audio` loaded a select with no matching value, which HTML resolves
        // to the blank "Any content", and pressing Apply then deleted the filter.
        // `embed` is the same shape and is normalised for the same reason.
        const has = first('has');
        $('fm-has').value = has === 'audio' ? 'sound' : (has === 'embed' ? 'link' : has);
        $('fm-author').value = first('author');
        // A bare `pinned:` means true; the select's blank is "either".
        const pin = first('pinned');
        $('fm-pinned').value = pin === '' ? '' : (pin === 'false' || pin === 'no' ? 'false' : 'true');

        // Only one of the three date operators can be in the box at a time —
        // the form offers a mode, not three fields — so the first one found
        // wins and the others are dropped on apply.
        const mode = ['during', 'before', 'after'].find((k) => ops[k]);
        const hasDate = !!mode;
        $('fm-date-row').hidden = !hasDate;
        $('fm-date-add').hidden = hasDate;
        $('fm-date-mode').value = mode || 'during';
        // Kept verbatim as well as assigned, because #fm-date-value is <input
        // type="date"> and that element silently REFUSES anything that is not a
        // full YYYY-MM-DD. The query parser accepts `before:2026` and
        // `after:2026-03` — a year or a month is a perfectly good bound — so
        // opening "More filters" over one of those loaded an empty date box, and
        // pressing Apply then deleted a filter the user had typed and never
        // touched. Falling back to the original on apply makes the round trip
        // lossless while leaving the picker to handle the ordinary full dates.
        fmDateRaw = hasDate ? String(ops[mode][0]) : '';
        $('fm-date-value').value = fmDateRaw;

        // What was in the box when this opened, so Apply can tell whether pressing
        // it would change anything. See refreshApplyEnabled.
        fmOpenedWith = fmFormState();
        refreshApplyEnabled();

        $('filters-modal').hidden = false;
        trapFocus($('filters-modal'), { label: 'Filters', initial: $('fm-from') });
    }

    // ---- Apply is only offered when it would do something -------------------
    //
    // The reference disables its own Apply Filters in the empty state, and it can:
    // its fields are dim `ex. scarmonit` placeholders, so "empty" and "unset" are
    // the same thing. This form's fields are selects that read "Anyone" / "Any
    // channel" — resolved values, which is the more honest thing for a select to
    // say, and it means "nothing chosen" is not a state this form has.
    //
    // So the rule is the one that is actually true here, and it is stricter than
    // the reference's: Apply is disabled when applying would be a NO-OP — when the
    // form says exactly what the search box already says. That covers the empty
    // state the reference cares about (open it over an empty box, change nothing)
    // and it also covers "I set a filter, then put it back", which the reference
    // would offer as an enabled button that does nothing.
    let fmOpenedWith = '';

    function fmFormState() {
        return JSON.stringify([
            $('fm-from').value, $('fm-in').value, $('fm-has').value,
            $('fm-mentions').value, $('fm-author').value, $('fm-pinned').value,
            $('fm-date-row').hidden ? '' : $('fm-date-mode').value,
            $('fm-date-row').hidden ? '' : ($('fm-date-value').value || fmDateRaw)
        ]);
    }

    function refreshApplyEnabled() {
        const btn = $('fm-apply');
        if (btn) btn.disabled = fmFormState() === fmOpenedWith;
    }

    // Every control in the form, on one listener — `change` covers the selects and
    // the date input, and the two date buttons call it themselves because showing
    // or hiding that row is a change the row's own events never see.
    $('filters-modal').addEventListener('change', refreshApplyEnabled);

    function closeFiltersModal() {
        releaseFocus($('filters-modal'));
        $('filters-modal').hidden = true;
    }

    // The form -> the box. Everything the form owns is rewritten; anything else
    // in the box — the words being searched for, and any operator this form has
    // no field for — is left exactly where it was.
    function applyFiltersModal() {
        const OWNED = ['from', 'mentions', 'in', 'has', 'author', 'pinned', 'before', 'after', 'during'];
        const parsed = parseSearchQuery(searchInput().value);
        let text = parsed.text;
        // Put back the operators this form does not own, so applying it cannot
        // quietly delete one that was typed.
        Object.keys(parsed.ops).forEach((k) => {
            if (OWNED.includes(k)) return;
            parsed.ops[k].forEach((v) => { text = writeOp(text, k, v, null).text; });
        });

        const add = (k, v) => { if (v) text = writeOp(text, k, v, null).text; };
        add('from', $('fm-from').value);
        add('in', $('fm-in').value);
        add('has', $('fm-has').value);
        add('mentions', $('fm-mentions').value);
        add('author', $('fm-author').value);
        add('pinned', $('fm-pinned').value);
        if (!$('fm-date-row').hidden) {
            // The picker's value when it has one; otherwise whatever was in the box
            // before this form opened — a year or a month the date input could not
            // display. See openFiltersModal.
            add($('fm-date-mode').value, $('fm-date-value').value || fmDateRaw);
        }

        // The TRAILING space writeOp leaves is kept, and it is load-bearing:
        // the caret then sits outside the last operator, so clicking back into
        // the box offers the filter list again. Trimmed, the caret lands inside
        // `from:Parker` and the dropdown quite correctly offers people instead
        // — leaving no way back to "More filters" without typing a space.
        // Only the leading side is trimmed; with no operators applied there is
        // no trailing space to keep.
        searchInput().value = text.replace(/^\s+/, '');
        applyQuery();
        runSearch();
        closeFiltersModal();
    }

    $('fm-close').addEventListener('click', closeFiltersModal);
    $('fm-cancel').addEventListener('click', closeFiltersModal);
    $('fm-apply').addEventListener('click', applyFiltersModal);
    $('filters-modal').addEventListener('mousedown', (e) => {
        if (e.target === $('filters-modal')) closeFiltersModal();
    });

    // Clears the FIELDS, not the box — nothing is applied until Apply is
    // pressed, so Cancel after this still leaves the search as it was.
    $('fm-clear').addEventListener('click', () => {
        ['fm-from', 'fm-in', 'fm-has', 'fm-mentions', 'fm-author', 'fm-pinned']
            .forEach((id) => { $(id).value = ''; });
        $('fm-date-value').value = '';
        $('fm-date-mode').value = 'during';
        $('fm-date-row').hidden = true;
        $('fm-date-add').hidden = false;
        // Clearing a form that was already clear changes nothing, so Apply goes
        // back to disabled — and clearing one that had filters in it enables it,
        // because applying now removes them.
        refreshApplyEnabled();
    });

    $('fm-date-add').addEventListener('click', () => {
        $('fm-date-row').hidden = false;
        $('fm-date-add').hidden = true;
        $('fm-date-value').focus();
        // Showing the row is a change no event on the row itself can see.
        refreshApplyEnabled();
    });
    $('fm-date-clear').addEventListener('click', () => {
        $('fm-date-value').value = '';
        fmDateRaw = '';                 // …including the un-displayable original
        $('fm-date-row').hidden = true;
        $('fm-date-add').hidden = false;
        refreshApplyEnabled();
    });

    // ---------- wiring ------------------------------------------------------

    searchInput().addEventListener('focus', openSearchPop);
    searchInput().addEventListener('click', () => { if (!searchOpen()) openSearchPop(); });

    searchInput().addEventListener('input', () => {
        applyQuery();
        if (!searchOpen()) openSearchPop(); else renderSearchPop();
        clearTimeout(filterTimer);
        filterTimer = setTimeout(runSearch, 220);
    });

    // Arrow keys and clicks move the caret, and which operator it sits in is
    // what the menu is showing — so the menu has to follow it.
    ['keyup', 'mouseup'].forEach((ev) => searchInput().addEventListener(ev, () => {
        if (searchOpen()) renderSearchPop();
    }));

    searchInput().addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            if (searchOpen() && searchInput().value) closeSearchPop();
            else { clearSearch(); closeSearchPop(); searchInput().blur(); }
            return;
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            closeSearchPop();
            runSearch();
        }
    });

    $('search-clear').addEventListener('click', () => {
        clearSearch();
        searchInput().focus();
        openSearchPop();
    });

    // Anywhere else closes it. mousedown rather than click so it closes on the
    // press, and the rows themselves preventDefault so picking one does not
    // count as clicking away.
    document.addEventListener('mousedown', (e) => {
        if (!searchOpen()) return;
        if (e.target.closest('#search-pop') || e.target.closest('#search-box')) return;
        closeSearchPop();
    });

    // ---------- archive search --------------------------------------------
    // The filter above narrows the messages already on screen; this asks the
    // server about everything ever posted, the same endpoint and scopes the
    // website uses. Both run off the one Ctrl+F box.

    let searchScope = 'channel';
    let searchSeq = 0;
    // How many hits one request asks for. Named because renderSearchResults has to
    // know it to tell a complete answer from a truncated one.
    const SEARCH_LIMIT = 40;

    // Closes the archive results without touching the box: the operators are
    // still narrowing the loaded messages, and clearing those is what the X in
    // the box is for.
    $('search-close').addEventListener('click', hideSearchResults);

    $('search-scope').addEventListener('click', () => {
        searchScope = searchScope === 'channel' ? 'all' : 'channel';
        $('search-scope').textContent = searchScope === 'all' ? 'All channels' : 'This channel';
        runSearch();
    });

    function hideSearchResults() {
        // Invalidates any reply still in flight. Without this, clearing the box
        // (or closing the panel) left the previous query's seq current, so its
        // response passed the staleness check and re-opened the results panel
        // over an empty search.
        searchSeq++;
        $('search-panel').hidden = true;
        $('search-results').innerHTML = '';
    }

    // Always reads the box. The archive only understands free text, so the
    // OPERATORS stay local — `from:alice logo` asks the server about "logo"
    // and narrows the loaded messages by Alice, which is the honest split:
    // the server has no idea who Alice is, and the operators are answerable
    // here without a round trip.
    async function runSearch() {
        const q = parseSearchQuery(searchInput().value).text;
        if (q.length < 2) { hideSearchResults(); return; }

        // Only the newest query gets to render — a slow reply must not overwrite
        // results for what's now in the box.
        const seq = ++searchSeq;
        // `in:` is the one operator the archive CAN answer, and it was the one
        // being dropped: the request always named the current channel, so
        // `in:random` searched #general while the loaded-message half — which
        // only ever holds one channel — matched nothing. Asked here, it means
        // what it says. Naming a channel also pins the scope to it; "in this
        // one, across all of them" is not a question.
        const inChan = filter.inChannel || null;
        const res = await L.board('search', {
            query: {
                q,
                channel: inChan || channel,
                scope: inChan ? 'channel' : searchScope,
                limit: SEARCH_LIMIT
            }
        });
        if (seq !== searchSeq) return;
        if (authGone(res)) return;
        // A FAILED search is not an empty one, and hiding the panel made the two
        // indistinguishable: an offline box, an edge 502 or a Worker exception all
        // looked exactly like "nothing matched", so the honest conclusion was
        // "there is nothing in the archive about that" — for a question the server
        // never answered. Say so, keep the panel open, and offer the retry, the way
        // the thread panel and the DM list already do.
        if (!res || !res.success) { searchError(res, q); return; }
        renderSearchResults(res.results || [], q);
    }

    function searchError(res, q) {
        $('search-panel').hidden = false;
        $('search-results').innerHTML = '';
        const sum = $('search-summary');
        sum.textContent = (res && res.error) ||
            (res && res.network ? 'Could not reach the archive' : 'Could not search the archive');
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'linkish';
        retry.textContent = 'Try again';
        retry.addEventListener('click', () => runSearch());
        const wrap = document.createElement('div');
        wrap.className = 'search-empty';
        wrap.appendChild(retry);
        $('search-results').appendChild(wrap);
        console.warn('[search] archive search failed for', JSON.stringify(q), res);
    }

    // The stamp on a moderator's edit: enough to place it without turning the
    // marker into a second line. Today's edits show only a time, an older one shows
    // the date too — the same rule the message list itself follows.
    function editedStamp(ts) {
        const d = new Date(ts);
        const now = new Date();
        const sameDay = d.toDateString() === now.toDateString();
        return sameDay
            ? timeStr(ts)
            : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + timeStr(ts);
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

        // The summary lives in the panel's own head now, beside the scope
        // toggle it belongs with, rather than as the first row of the results.
        // "40 results in the archive" was a claim the response could not support:
        // the request asks for limit: 40, so a full page means "at least 40" and
        // there is no way from here to see the rest. A truthful count when the page
        // is short, and an honest description when it is full.
        $('search-summary').textContent = list.length >= SEARCH_LIMIT
            ? `Showing the newest ${SEARCH_LIMIT} matches`
            : (list.length
                ? `${list.length} result${list.length === 1 ? '' : 's'} in the archive`
                : 'Nothing in the archive matches that');

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
                // clearSearch(), not a hand-blank of filter.text: the operators
                // (from:, has:, author:, the dates) are separate fields, and
                // clearing only the text left them narrowing the channel list
                // behind an EMPTY search box — a filtered conversation with
                // nothing on screen to say why, and no obvious way back.
                // jumpToPost already did this; the thread branch did not.
                clearSearch();
                // A reply lives in its thread, not the main list.
                if (r.thread_root_id) openThread(r.thread_root_id, r.channel);
                else jumpToPost(r);
            });
            box.appendChild(it);
        });

        $('search-panel').hidden = false;
    }
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
        // Drop any active filters so the message shows among its neighbours.
        // Forget the saved pre-filter scroll position first: otherwise
        // clearSearch queues a restore that lands after — and undoes — the
        // scroll to the target.
        if (filterActive()) { filterScrollTop = null; clearSearch(); }
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
    // The thread composer is a second, never-moved textarea, so it was never
    // covered by the main composer's per-surface drafts — and nothing cleared
    // it. An unsent reply survived closing the panel, switching channels and
    // signing out, and the next thread opened started pre-filled with it, one
    // Enter away from posting under a different root or a different account.
    // Same contract as `drafts`: keyed by the surface it was typed into.
    const threadDrafts = new Map();

    async function openThread(rootId, chan) {
        if (!rootId) return;
        // Opening a thread OVER an open one is a switch, not a fresh open, so
        // the reply in progress has to be stashed exactly as closing it would.
        //
        // closeThread() is the only thing that ever writes threadDrafts, and
        // this never called it: the drawer only narrows the message column
        // rather than covering it, so every reply-count chip and every
        // right-click "Reply in thread" in the main list stays live while a
        // thread is open — and using one blanked whatever had been typed into
        // the previous thread, permanently. The cross-channel path was safe only
        // by accident (switchChannel -> resetChannelView -> closeThread).
        //
        // Unconditional: re-clicking the chip of the thread already open must
        // not blank its box either, and the restore below deletes the map entry
        // on the way in, so a `rootId !== threadRootId` guard would still lose it.
        if (threadRootId) closeThread();
        // A result from another channel: switch first so replies post to the
        // right place and closing the thread lands somewhere sensible.
        if (chan && chan !== channel) await switchChannel(chan);

        // Both drawers occupy the same slot at the same z-index, and #dm-panel
        // is later in the DOM — so with a DM open the thread would open
        // invisibly underneath it and "Reply in thread" looked like a no-op.
        // (openDm already does the reverse.)
        if (dmPanelOpen()) closeDm();

        threadRootId = rootId;
        // AFTER the switchChannel above: that runs resetChannelView ->
        // closeThread(), which stashes and blanks the box, so restoring any
        // earlier would be undone by it.
        $('thread-input').value = threadDrafts.get(rootId) || '';
        threadDrafts.delete(rootId);
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
            if (appHidden()) return;
            loadThread(false);
        }, THREAD_POLL_MS);
    }

    function closeThread() {
        // Stash before blanking, so closing a thread you were mid-reply to and
        // coming back gives the text back — to the root it was written for, and
        // to no other.
        if (threadRootId) {
            const draft = $('thread-input').value;
            if (draft.trim()) threadDrafts.set(threadRootId, draft);
            else threadDrafts.delete(threadRootId);
        }
        $('thread-input').value = '';
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

    // Say the thread could not be loaded, and offer the way out.
    //
    // loadThread used to `return` on every failure without touching the DOM, so
    // openThread's "Loading thread…" placeholder was the last thing ever drawn:
    // one failed request and the drawer sat on that line for the rest of the
    // session, with the 2.5s poll taking the same silent path (and skipped
    // entirely while the window is hidden). The DM drawer beside it has had an
    // explicit error and a Retry for the identical case all along.
    function threadError(msg) {
        // Never wipe a thread that IS on screen over one failed poll.
        if (threadPosts.length) return;
        const list = $('thread-list');
        if (list.querySelector('.thread-retry')) return;   // already saying it
        const box = document.createElement('div');
        box.className = 'thread-loading';
        box.append(msg, ' ');
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'keycap thread-retry';
        retry.textContent = 'Retry';
        retry.addEventListener('click', () => {
            list.innerHTML = '<div class="thread-loading">Loading thread…</div>';
            loadThread(true);
        });
        box.appendChild(retry);
        list.innerHTML = '';
        list.appendChild(box);
    }

    async function loadThread(force) {
        if (!threadRootId) return;
        const root = threadRootId;
        const res = await L.board('thread', { query: { root } });
        if (root !== threadRootId) return;               // switched while in flight
        if (authGone(res)) return;
        if (!res || !res.success) {
            threadError((res && res.error) || 'Could not load this thread.');
            return;
        }

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

    // ---------- threads popout ----------------------------------------------
    //
    // Every thread in the channel, off the header's Threads button — the
    // reference's panel: title, a search box and Create on one bar, the list or
    // an empty state below.
    //
    // The list comes from /api/board/threads rather than from the loaded page.
    // Both clients can half-derive it locally (a root carries reply_count), but
    // only for the page they happen to hold — so a thread nobody had scrolled
    // back to was missing from a panel whose whole claim is to list them all.
    //
    // CREATE is adapted, not copied. A thread here hangs off a message; there is
    // no such thing as an empty one. So Create asks for the opening message,
    // posts it, and opens its thread — which is what "start a thread" means in
    // this app, and is real rather than a button that cannot do anything.

    let threadsList = null;          // null = not loaded yet
    let threadsFilter = '';

    function threadsPopOpen() { return !$('threads-pop').hidden; }

    function closeThreadsPop() {
        $('threads-pop').hidden = true;
        $('btn-threads').setAttribute('aria-expanded', 'false');
    }

    // Hung off the BUTTON, trailing edges aligned — the reference puts its right
    // edge 6px past the trigger's, so the panel and the thing that opened it read
    // as one gesture.
    //
    // This was centred over the conversation for a while, on the theory that a
    // panel this wide right-aligned to a button near the window's right edge would
    // hang off the left. It does not: the window's minWidth is 900, the panel is
    // 602, and the button sits ~90px in from the right — which leaves ~200px of
    // room. The clamp below is still the backstop for a window narrower than the
    // panel plus its margins.
    function placeThreadsPop() {
        if (!threadsPopOpen()) return;
        const pop = $('threads-pop');
        const btn = $('btn-threads').getBoundingClientRect();
        const w = pop.offsetWidth;
        const left = btn.right + 6 - w;
        pop.style.left = Math.max(8, Math.min(left, window.innerWidth - w - 8)) + 'px';
        pop.style.top = Math.round(btn.bottom + 8) + 'px';
    }

    async function openThreadsPop() {
        closeNotifPop();
        const pop = $('threads-pop');
        pop.hidden = false;
        $('btn-threads').setAttribute('aria-expanded', 'true');
        threadsFilter = '';
        $('threads-search').value = '';
        threadsList = null;
        renderThreadsPop();          // the loading state, in this frame
        placeThreadsPop();
        $('threads-search').focus();

        const forChannel = channel;
        let list = null;
        try {
            const res = await L.board('threads', { query: { channel: forChannel } });
            if (res && res.success && Array.isArray(res.threads)) list = res.threads;
        } catch (e) { /* fall through to the local derivation */ }
        if (forChannel !== channel || !threadsPopOpen()) return;
        // Offline, or an older server with no such endpoint: what the loaded page
        // can see is worth more than an error.
        if (!list) {
            list = posts.filter((p) => (p.reply_count || 0) > 0).map((p) => ({
                id: p.id,
                name: p.name,
                user_id: p.user_id,
                title: (String(p.body || '').split('\n').map((s) => s.trim()).find(Boolean) ||
                    p.att_name || 'Thread').slice(0, 100),
                reply_count: p.reply_count || 0,
                last_reply_at: p.last_reply_at || p.created_at
            })).sort((a, b) => b.last_reply_at - a.last_reply_at);
        }
        threadsList = list;
        renderThreadsPop();
        placeThreadsPop();
    }

    function renderThreadsPop() {
        const body = $('threads-body');
        body.innerHTML = '';

        if (threadsList === null) {
            const l = document.createElement('div');
            l.className = 'tp-empty';
            l.innerHTML = '<div class="tp-empty-sub">Loading threads…</div>';
            body.appendChild(l);
            return;
        }

        const q = threadsFilter.trim().toLowerCase();
        const shown = q
            ? threadsList.filter((t) => (t.title || '').toLowerCase().includes(q) ||
                (t.name || '').toLowerCase().includes(q))
            : threadsList;

        if (!shown.length) {
            const e = document.createElement('div');
            e.className = 'tp-empty';
            // Two different empty states. "No threads at all" is an invitation;
            // "nothing matched your search" is an answer, and offering Create
            // Thread there would read as "create one called that".
            if (q) {
                e.innerHTML =
                    I('threads-empty', 'tp-empty-mark') +
                    '<div class="tp-empty-title">No threads found</div>' +
                    `<div class="tp-empty-sub">Nothing in #${esc(channel)} matches “${esc(threadsFilter.trim())}”.</div>`;
                body.appendChild(e);
                return;
            }
            e.innerHTML =
                I('threads-empty', 'tp-empty-mark') +
                '<div class="tp-empty-title">There are no threads.</div>' +
                // Shorter than it was, which is what lets it sit on two lines in the
                // reference's own width rather than three in a narrower box — and
                // "off one message" is the part that is actually true here. Threads
                // in this app are not temporary, so the reference's own wording
                // ("a temporary text channel") would be a claim, not a description.
                '<div class="tp-empty-sub">Stay focused with a thread — ' +
                'a side conversation off one message.</div>';
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'tp-create';
            b.textContent = 'Create Thread';
            b.addEventListener('click', createThreadFromPop);
            e.appendChild(b);
            body.appendChild(e);
            return;
        }

        shown.forEach((t) => {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'tp-item';
            const n = t.reply_count || 0;
            row.innerHTML =
                I('thread') +
                '<div class="tp-item-main">' +
                `<div class="tp-item-name">${esc(t.title || 'Thread')}</div>` +
                `<div class="tp-item-meta">${esc(t.name || 'Someone')} · ` +
                `${n} ${n === 1 ? 'reply' : 'replies'} · last ${esc(stampStr(t.last_reply_at))}</div>` +
                '</div>';
            row.addEventListener('click', () => {
                closeThreadsPop();
                openThread(t.id, channel);
            });
            body.appendChild(row);
        });
    }

    async function createThreadFromPop() {
        const forChannel = channel;
        // Through openDialog rather than askText so it can carry the explanation:
        // "create a thread" in this app means posting the message it hangs off,
        // and that is worth saying before somebody types into the box.
        const body = await openDialog({
            title: 'Start a thread',
            message: 'A thread hangs off a message. What should the opening message say? ' +
                'Its first line becomes the thread\'s name.',
            value: '', ok: 'Create', withInput: true, maxLength: 200
        });
        if (!body || !body.trim()) return;

        const res = await L.board('post', {
            method: 'POST',
            body: {
                body: body.trim(),
                name: settings.displayName || 'Anonymous',
                clientId: settings.clientId,
                channel: forChannel
            }
        });
        if (authGone(res)) return;
        if (!res || !res.success) return toast((res && res.error) || 'Could not start the thread', true);

        closeThreadsPop();
        announcePosted(forChannel, body.trim());
        echoPost(res.id, body.trim(), forChannel, null, null);
        await loadMessages(true);
        // The root exists now, so the drawer has something to open onto — and the
        // reply box in it is where the thread actually begins.
        openThread(res.id, forChannel);
    }

    $('threads-search').addEventListener('input', (e) => {
        threadsFilter = e.target.value;
        renderThreadsPop();
    });
    $('threads-create').addEventListener('click', createThreadFromPop);

    // ---- the header's two popouts share their open/close rules ---------------

    $('btn-threads').addEventListener('click', () => {
        if (threadsPopOpen()) closeThreadsPop(); else openThreadsPop();
    });
    // The header bell opens the notification popout, aligned to its trailing edge.
    $('btn-chan-alerts').addEventListener('click', () => {
        if (notifPopOpen()) { closeNotifPop(); return; }
        const r = $('btn-chan-alerts').getBoundingClientRect();
        const pop = $('notif-pop');
        // Opened first so it can be measured, then anchored.
        openNotifPop(channel, 0, 0);
        placeFixedPanel(pop, r);
    });

    // A click outside closes them, and so does Escape (see the global keydown).
    // The buttons are excluded or the toggle would close and reopen in one gesture.
    document.addEventListener('mousedown', (e) => {
        if (notifPopOpen() && !$('notif-pop').contains(e.target) &&
            !$('notif-sub').contains(e.target) && !e.target.closest('#btn-chan-alerts')) {
            closeNotifPop();
        }
        if (threadsPopOpen() && !$('threads-pop').contains(e.target) &&
            !e.target.closest('#btn-threads')) {
            closeThreadsPop();
        }
    });
    window.addEventListener('resize', () => { placeThreadsPop(); if (notifPopOpen()) closeNotifPop(); });

    // ---------- pinned ----------------------------------------------------

    async function pinPost(id, pinned) {
        // The buttons are gated (see mayPin), but so is deletePost — a keyboard
        // shortcut, a stale menu or a repaint that raced a role change all reach
        // here without passing one, and the answer should be the reason rather
        // than a bare server 403.
        // Only when the row is loaded here; a pin from a page we do not hold falls
        // through to the server, which is the authority either way.
        const target = posts.find((x) => x.id === id);
        if (target && !mayPin(target)) {
            return toast('Only admins can pin other people\'s messages', true);
        }
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

    // Anchor the panel under the header's pin button, right edges aligned, and
    // clamp it on screen. Done in script rather than with a positioned ancestor
    // because the panel is position:fixed — the header's own overflow would clip
    // a 520px popover hanging out of a 40px bar.
    function placePinned() {
        const panel = $('pinned-panel');
        if (panel.hidden) return;
        const btn = $('btn-pinned').getBoundingClientRect();
        const w = panel.offsetWidth;
        panel.style.left = Math.max(8, Math.min(btn.right - w, window.innerWidth - w - 8)) + 'px';
        panel.style.top = Math.round(btn.bottom + 8) + 'px';
    }

    function togglePinned(open) {
        const panel = $('pinned-panel');
        panel.hidden = !open;
        $('btn-pinned').setAttribute('aria-expanded', open ? 'true' : 'false');
        if (!open) return;
        closeSearchPop();
        hideSearchResults();
        placePinned();
        renderPinned();
    }

    // Click anywhere else, and Escape, close it — the two things a popover has to
    // answer to and an inline banner never did. The pin button is excluded or the
    // toggle would close and reopen in the same gesture.
    document.addEventListener('mousedown', (e) => {
        const panel = $('pinned-panel');
        if (panel.hidden) return;
        if (panel.contains(e.target) || e.target.closest('#btn-pinned')) return;
        togglePinned(false);
    });
    window.addEventListener('resize', placePinned);

    // The header bell opens the NOTIFICATION POPOUT, wired above with the threads
    // button it sits beside. It used to open the channel's whole context menu —
    // rename and delete included — which is not what a bell in a header means; the
    // channel row's own bell and right-click still open that.

    $('btn-pinned').addEventListener('click', () => togglePinned($('pinned-panel').hidden));
    // No close button to wire: the panel closes on Escape, on a click outside, on
    // the pin button and on a channel switch — the reference has no ✕ either, and
    // one up there made the ✕ on a card read as "close" rather than "unpin".

    async function renderPinned() {
        const list = $('pinned-list');
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
            placePinned();      // an empty panel is a different height
            return;
        }

        pinned.forEach((p) => {
            const item = document.createElement('div');
            item.className = 'pinned-item';
            // A card, like the reference's: the face, the name, when it was said,
            // and the WHOLE message — run through the same markdown renderer the
            // conversation uses, so a pinned list or a pinned code block reads the
            // way it does in the channel. The banner this replaced escaped the
            // body and cut it at 240 characters.
            item.innerHTML =
                `<div class="pinned-avatar${avatarCls(p.user_id)}" style="${avatarStyle(p.name)}">` +
                `${esc(initials(p.name))}${avatarImgHtml(p.user_id)}</div>` +
                '<div class="pinned-main">' +
                '<div class="pinned-top">' +
                `<span class="pinned-name">${esc(p.name)}</span>` +
                // Date AND time: a pin sits outside any day divider, so a bare
                // clock reading does not say which day it belongs to.
                `<span class="pinned-time">${esc(stampStr(p.created_at))}</span>` +
                '</div>' +
                '<div class="pinned-body"></div>' +
                '</div>' +
                '<div class="pinned-acts">' +
                // Jump first, the reference's order: it is what the panel was opened
                // for. Unpin is the small destructive one, on the outside edge.
                '<button class="pinned-jump" type="button" title="Jump to this message">Jump</button>' +
                // Unpinning is the same admin-or-owner rule as pinning; offering it
                // to a member on somebody else's message only produced a 403.
                // An ✕ rather than the word — it was the widest thing on the card,
                // which made Jump look secondary. The label lives in the title and
                // aria-label instead, so it still says what it does.
                (mayPin(p)
                    ? '<button class="pinned-unpin" type="button" title="Unpin this message" ' +
                      'aria-label="Unpin this message">' + I('x') + '</button>'
                    : '') +
                '</div>';

            const bodyEl = item.querySelector('.pinned-body');
            if (p.body) {
                renderBody(p.body, bodyEl);
                highlightCodeBlocks(bodyEl);
            } else if (p.att_name) {
                const att = document.createElement('span');
                att.className = 'pinned-att';
                const ico = I(fileIcon(p.att_name), 'ico inline-ico');
                att.innerHTML = ico + esc(p.att_name);
                bodyEl.appendChild(att);
            }
            wireAvatarFallback(item);

            // A pinned thread reply lives in its thread, not the main list.
            const jump = () => {
                togglePinned(false);
                if (p.thread_root_id) openThread(p.thread_root_id, p.channel);
                else jumpToPost(p);
            };
            // The whole card is still clickable — the reference's cards are — but
            // never through a control: a click on Unpin that also jumped would
            // yank the reader somewhere on their way to removing the pin.
            item.addEventListener('click', (e) => {
                if (e.target.closest('button')) return;
                jump();
            });
            item.querySelector('.pinned-jump').addEventListener('click', (e) => {
                e.stopPropagation();
                jump();
            });
            const unpin = item.querySelector('.pinned-unpin');
            if (unpin) unpin.addEventListener('click', (e) => {
                e.stopPropagation();
                pinPost(p.id, false);
            });
            list.appendChild(item);
        });
        // Measured after the cards exist: the panel grows to fit them up to its
        // max, and an anchor computed against the empty box sits in the wrong place.
        placePinned();
    }

    // ---------- direct messages --------------------------------------------
    // DMs need a board account (see the Account settings group): message rows
    // are keyed by user id, and realtime delivery routes through the account's
    // bound client_id. The conversation opens in a drawer like the thread panel.

    const DM_POLL_MS = 12000;
    let dmThreads = [];               // [{ user:{id,username}, last:{...}, unread }]
    // id -> the directory entry (role, etc). Threads only carry id/username, so
    // the profile panel gets the rest from here — populated whenever the picker
    // loads the directory, and left empty rather than guessed if it never has.
    const dmDirectory = {};
    // Declared with the other DM state, not beside its listener: renderDmMessages
    // reads it, and a `let` further down the file is in its temporal dead zone
    // until that line runs.
    let dmFilter = '';
    let dmOpen = null;                // { id, username } of the open conversation
    let dmMsgs = [];
    // dm/list has always paged — it takes `before` and answers `hasMore` — and
    // the client never asked. Anything past the newest fifty messages was
    // simply unreachable, in the only place they can be read at all, and the
    // intro block cheerfully announced itself as the beginning of the history.
    let dmHasMore = false;
    let dmPaging = false;
    let dmTimer = null;
    // Whether the profile column is showing, as a CHOICE rather than as
    // whatever the last render happened to leave behind. renderDmProfile() runs
    // on every DM poll, and it used to set `hidden` outright — so closing the
    // column lasted until the next tick twelve seconds later and then reopened
    // itself, with the toggle still claiming it was off.
    let dmProfileOpen = true;

    // The open conversation is being read right now. The row already hides its
    // own badge; the rail and the taskbar badge read this total, so leaving it
    // in kept them lit while you were looking at the messages.
    // Everything below keys off the THREAD id, never the partner's user id.
    // A group has no single partner — `t.user` is null for one — so anything
    // reaching through it worked only for as long as two-person conversations
    // were the only kind that existed.
    function dmUnreadTotal() {
        return dmThreads.reduce((s, t) =>
            s + ((dmOpen && dmOpen.id === t.id) ? 0 : (t.unread || 0)), 0);
    }

    // Who to show a conversation as. A group keeps its name; a pair is named
    // after the other person. The server already decides this — mirrored here
    // so an optimistic local render agrees with the next fetch.
    function dmLabel(t) {
        return t.title || (t.user && t.user.username) || 'Conversation';
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
            const open = dmOpen && dmOpen.id === t.id;
            const unread = open ? 0 : (t.unread || 0);
            const b = document.createElement('button');
            b.className = 'chan dm dm-row' + (t.isGroup ? ' dm-group' : '') +
                (open ? ' active' : '') + (unread ? ' unread' : '');
            // A face, not an @. The reference identifies a conversation by who
            // is in it, and for a group it stacks two of them — which is what
            // says "more than one person" before any name is read.
            const face = (u) => u
                ? `<span class="av${avatarCls(u.id)}" style="${avatarStyle(u.username)}">` +
                  `${esc(initials(u.username))}${avatarImgHtml(u.id)}</span>`
                : '<span class="av"></span>';
            let art;
            if (t.isGroup) {
                const others = (t.members || []).filter((m) => !account || m.id !== account.id).slice(0, 2);
                art = '<span class="dm-stack">' + others.map(face).join('') + '</span>';
            } else {
                art = '<span class="dm-face">' + face(t.user) + '</span>';
            }
            b.innerHTML = art + `<span class="chan-name">${esc(dmLabel(t))}</span>` +
                (unread ? `<span class="unread">${unread > 99 ? '99+' : unread}</span>` : '');
            b.title = t.isGroup
                ? (t.members || []).map((m) => m.username).join(', ')
                : dmLabel(t);
            // .has-img makes the initials transparent, so a picture that fails
            // to load leaves an EMPTY circle unless something takes it back off
            // again. Every other surface that draws a face wires this; the four
            // DM ones were built without it.
            wireAvatarFallback(b);
            b.addEventListener('click', () => openDm(t));
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
                const t = dmThreads.find((x) => x.id === dmOpen.id);
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
            if (appHidden() && rtConnected) return;
            loadDmThreads();
            if (dmOpen) loadDmMessages(false);
        }, DM_POLL_MS);
    }

    function stopDmPolling() {
        if (dmTimer) { clearInterval(dmTimer); dmTimer = null; }
        closeDm();
    }

    // Takes a THREAD. `{ id, title, isGroup, members }` — the shape the thread
    // list already hands out, so opening one never has to look a partner up.
    async function openDm(thread) {
        // Opening a conversation puts you in the DM view if you were not
        // already there — a DM cannot be read from inside a server's channel
        // list any more than a channel can be read from inside a DM.
        if (!dmMode) setDmMode(true);
        const id = thread.id;
        dmOpen = {
            id,
            title: dmLabel(thread),
            isGroup: !!thread.isGroup,
            members: thread.members || []
        };
        $('dm-title').textContent = dmOpen.title;
        // A group says how many people are in it; a pair does not need telling.
        $('dm-panel').classList.toggle('is-group', dmOpen.isGroup);
        // …and it is no longer the empty state, whichever of the two ways in
        // put that class there.
        $('dm-panel').classList.remove('empty');
        renderDmHead();
        $('dm-panel').hidden = false;
        moveComposer(true);
        closeThread();
        dmMsgs = [];
        dmHasMore = false;
        loadDmMessages.lastSig = null;    // the last conversation's payload isn't this one's
        $('dm-messages').innerHTML = '<div class="thread-loading">Loading…</div>';
        await loadDmMessages(true);
        // Everything below assumes this conversation is still the open one. It
        // may not be: a close, a session teardown, or simply opening someone
        // else can all land during the fetch, and the tail used to run anyway —
        // scrolling a panel that had moved on and pulling focus into a hidden
        // input.
        if (!dmOpen || dmOpen.id !== id) return;
        // Opening a conversation always lands on the newest message; only the
        // background re-renders defer to where the reader already is.
        const box = $('dm-messages');
        box.scrollTop = box.scrollHeight;
        const t = dmThreads.find((x) => x.id === id);
        if (t && t.unread) { t.unread = 0; renderDmSection(); }
        renderDmSection();
        setComposerPlaceholder();
        $('composer-input').focus();
    }

    // "Message this person", from wherever you are looking at them — a message
    // they wrote, their row in the members list, their tile in the call.
    //
    // The server is the authority on WHICH thread that is: dm/create with a
    // single person returns the one you already have with them rather than
    // starting a second one beside it. So this asks instead of guessing from
    // the sidebar, which would be wrong for anyone you have never messaged and
    // stale for anyone whose thread arrived after the last poll.
    let startingDm = false;
    async function messageUser(userId) {
        const uid = parseInt(userId, 10) || 0;
        if (!uid) return;
        // DMs are addressed by ACCOUNT, so there has to be one on this end too.
        // The picker answers this the same way — there is nothing useful to show
        // in the conversation view without one.
        if (!account) {
            toast('Sign into your board account to send direct messages', true);
            openSettings();
            return;
        }
        if (uid === account.id) return;      // there is no conversation with yourself
        // A second click while the first is in flight. dm/create is idempotent
        // for a pair, so this cannot duplicate a thread — but it can open the
        // conversation twice and fight over the scroll.
        if (startingDm) return;
        startingDm = true;
        try {
            const res = await L.board('dm/create', { method: 'POST', body: { users: [uid] } });
            if (authGone(res)) return;
            if (!res || !res.success || !res.thread) {
                return toast((res && res.error) || 'Could not open that conversation', true);
            }
            // The sidebar first, so the conversation being opened is already in
            // the list it highlights.
            await loadDmThreads();
            await openDm(res.thread);
        } finally {
            startingDm = false;
        }
    }

    // The header carries everything that is true only of a group, so it is one
    // function rather than a toggle repeated at each call site.
    function renderDmHead() {
        const group = !!(dmOpen && dmOpen.isGroup);
        const count = $('dm-count');
        count.hidden = !group;
        if (group) {
            const n = (dmOpen.members || []).length;
            count.textContent = n + ' member' + (n === 1 ? '' : 's');
        }
        $('dm-add').hidden = !group;
        $('dm-more').hidden = !group;
        $('dm-title').textContent = dmOpen ? dmOpen.title : 'Direct message';

        // A face, not an @ — the reference names a conversation by who is in it.
        const face = $('dm-head-face');
        if (face) {
            const others = (dmOpen && dmOpen.members || []).filter((m) => !account || m.id !== account.id);
            const u = group ? null : others[0];
            face.innerHTML = u
                ? `<span class="av${avatarCls(u.id)}" style="${avatarStyle(u.username)}">` +
                  `${esc(initials(u.username))}${avatarImgHtml(u.id)}</span>`
                : '<span class="ico" data-icon="users"></span>';
            wireAvatarFallback(face);
            if (window.ScarmIcons) window.ScarmIcons.hydrate(face);
        }

        setComposerPlaceholder();
        renderDmProfile();
    }

    // The person you are talking to, beside the conversation. Only for a pair —
    // a group has no single profile, and guessing which member to show would be
    // worse than showing none.
    function renderDmProfile() {
        const panel = $('dm-profile');
        if (!panel) return;
        const others = (dmOpen && dmOpen.members || []).filter((m) => !account || m.id !== account.id);
        const u = (dmOpen && !dmOpen.isGroup) ? others[0] : null;
        // The button goes with the panel, which is what the comment above always
        // claimed and nothing ever did: left up in a group it opened this aside
        // still holding the LAST pair conversation's profile — someone else's
        // name and face over a group chat.
        const toggle = $('dm-prof-toggle');
        if (toggle) {
            toggle.hidden = !u;
            toggle.setAttribute('aria-pressed', String(!!u && dmProfileOpen));
        }
        panel.hidden = !u || !dmProfileOpen;
        if (!u) return;

        // The banner takes its colour from the same hash the avatar does, so the
        // card reads as one person — but FLAT and dark, via bannerStyle, not the
        // avatar's gradient. A saturated two-stop sweep is not a shape a header
        // takes, and at 105px tall it drowns the name and the rows under it.
        // (The account panel's banner has used bannerStyle since it was written;
        // this one was built with the wrong helper.)
        $('dm-prof-banner').style.cssText = bannerStyle(u.username);
        // Whether they are there, answered on the face itself and again in
        // words underneath. The presence table is the only source: it is the
        // same one the member list reads, so the two can never disagree.
        const status = statusForUser(u.id);
        $('dm-prof-face').innerHTML =
            `<span class="av${avatarCls(u.id)}" style="${avatarStyle(u.username)}">` +
            `${esc(initials(u.username))}${avatarImgHtml(u.id)}</span>` +
            `<i class="presence${statusDot(status)}" aria-hidden="true"></i>`;
        wireAvatarFallback($('dm-prof-face'));
        $('dm-prof-name').textContent = u.username;
        $('dm-prof-handle').textContent = '@' + u.username;
        paintDmProfileStatus();

        // Only what we actually know. The reference shows "Member Since" from a
        // creation date we do not carry, and inventing one would be worse than
        // leaving the row out.
        const meta = $('dm-prof-meta');
        meta.innerHTML = '';
        const known = dmDirectory[u.id];
        if (known && known.role) {
            const b = document.createElement('span');
            b.className = 'pm-badge';
            b.textContent = known.role === 'admin' ? 'ADMIN' : 'MEMBER';
            meta.appendChild(b);
        }
        const label = document.createElement('div');
        label.className = 'pm-label';
        label.textContent = 'Account';
        const value = document.createElement('div');
        value.className = 'pm-value';
        value.textContent = 'Board member #' + u.id;
        meta.appendChild(label);
        meta.appendChild(value);

        // The button did nothing at all — it was styled and never wired.
        $('dm-prof-full').onclick = () => openProfileCard(u);
    }

    // The status half of the panel, on its own so the presence poll can refresh
    // it every twenty seconds WITHOUT going back through renderDmProfile —
    // which rewrites the avatar's markup, and would therefore restart the image
    // load and flash the face three times a minute for as long as a
    // conversation stayed open.
    function paintDmProfileStatus() {
        const panel = $('dm-profile');
        if (!panel || panel.hidden) return;
        const others = (dmOpen && dmOpen.members || []).filter((m) => !account || m.id !== account.id);
        const u = (dmOpen && !dmOpen.isGroup) ? others[0] : null;
        if (!u) return;

        const status = statusForUser(u.id);
        // Their custom line rides along when they have set one — it is the
        // difference between "Online" and "Online — heads down until four".
        const custom = (members.find((x) => x.user_id === u.id) || {}).custom || '';
        const faceDot = $('dm-prof-face').querySelector('.presence');
        if (faceDot) faceDot.className = 'presence' + statusDot(status);
        $('dm-prof-dot').className = 'presence' + statusDot(status);
        $('dm-prof-status-text').textContent =
            STATUS_LABEL[status] + (custom ? ' — ' + custom : '');
    }

    // The fuller profile, as a card over the conversation. Everything the panel
    // shows plus what does not fit in 302px.
    function openProfileCard(u) {
        // dmDirectory is only filled when the new-conversation picker has been
        // OPENED this session, so on a straight "reply to a DM → View Full
        // Profile" it is empty — and `known.role === 'admin' ? … : 'Member'`
        // then reported every admin on the board as an ordinary member. `roster`
        // holds the same rows from account/users and is loaded at startup, so it
        // answers this without a round trip; when neither knows, say so rather
        // than guessing the commoner case.
        const known = dmDirectory[u.id] || roster.find((r) => r.id === u.id) || {};
        const rows = [
            ['Username', u.username],
            ['Account id', String(u.id)],
            ['Role', known.role ? (known.role === 'admin' ? 'Admin' : 'Member') : 'Unknown']
        ];
        openDialog({
            title: u.username,
            message: rows.map((r) => r[0] + ': ' + r[1]).join('\n'),
            ok: 'Close',
            withInput: false
        });
    }

    // Direct messages as a PLACE, not a category inside a server's channel
    // list. The reference swaps the whole second column for them, and the
    // conversation list lives only there — which is why the rail button carries
    // its own unread count. dmMode is the place; dmOpen is which conversation
    // inside it, and you can be in the place with nothing selected.
    let dmMode = false;

    function setDmMode(on) {
        if (dmMode === on) return;
        dmMode = on;
        $('sidebar').hidden = on;
        $('dm-sidebar').hidden = !on;
        // The list is MOVED, never copied. A second conversation list would
        // need a second renderer, and the two would disagree within a week.
        const list = $('dm-list');
        if (list) (on ? $('dm-list-slot') : $('dm-section')).appendChild(list);
        $('dm-panel').hidden = !on;
        // The new-messages bar belongs to a CHANNEL. Nothing else here repaints
        // the message column on the way into the conversation list, so without
        // this a bar raised over #general stayed up behind the DM panel.
        renderUnreadBar();
        // Which of the two places you are in. The server mark was hard-coded
        // active, so it claimed to be selected while you were reading DMs.
        $('rail-home').classList.toggle('active', !on);
        $('rail-dms').classList.toggle('active', on);
        if (!on && dmOpen) closeDm();
        if (on) {
            renderDmSection();
            renderDmHead();
            // Arriving in the place with nothing selected. Only openDm() and
            // closeDm() ever painted this column, and neither runs on the way
            // IN when there is no conversation to open — so somebody who has
            // never sent a DM pressed @ and got an entirely blank panel, with
            // the app's own "No conversations yet" line sitting unused two
            // hundred lines away.
            if (!dmOpen) {
                $('dm-panel').classList.add('empty');
                $('dm-title').textContent = 'Direct Messages';
                renderDmMessages();
            }
        } else {
            moveComposer(false);
        }
        setComposerPlaceholder();
    }

    // The one composer, relocated. Moving the node keeps every listener, every
    // sub-control and the exact appearance, because it IS the same element —
    // which is the whole point. A marker holds its place in #main so it goes
    // back exactly where it was rather than at the end.
    let composerHome = null;

    // Which conversation the composer's CONTENTS belong to, and what was left
    // behind on the surfaces it is not currently sitting on.
    //
    // Moving the node is what makes the one composer possible, and it is also
    // what made it dangerous: the element carries its value, its staged files
    // and its reply chip along with it, so a half-typed message written for
    // #general was still in the box after clicking through to a conversation,
    // and the next Enter sent it to whoever was on the other end. A file that
    // had been attached but not sent went the same way — into a private
    // conversation it was never meant for. Only the reply chip was ever
    // cleared, which is the one of the three that could not misdeliver
    // anything (a DM send has no quote to carry it).
    //
    // Nothing is discarded to fix it. Each surface keeps its own draft and gets
    // it back on return, because losing text somebody has already typed is the
    // failure this file goes out of its way to avoid everywhere else.
    let composerSurface = 'channel';        // the composer starts in #main
    const drafts = new Map();               // surface key -> { text, staged, reply }

    // Channels share one draft, which is what they did before this existed;
    // every conversation gets its own, because that is where the misdelivery is.
    function composerSurfaceKey() {
        return dmOpen ? 'dm:' + dmOpen.id : 'channel';
    }

    function stashDraft(key) {
        if (!key) return;
        const text = input.value;
        if (!text && !staged.length && !replyTarget) { drafts.delete(key); return; }
        drafts.set(key, { text, staged, reply: replyTarget });
    }

    function restoreDraft(key) {
        const d = drafts.get(key) || null;
        drafts.delete(key);
        input.value = d ? d.text : '';
        // Handed back whole rather than rebuilt: the object URLs behind those
        // previews belong to the stashed items, and clearStaged() would revoke
        // them out from under a draft that is only being put down, not thrown
        // away.
        staged = d ? d.staged : [];
        replyTarget = (d && d.reply) || null;
        renderStaged();          // also refreshes the send button
        renderReplyChip();
        autosize();
    }

    function moveComposer(intoDm) {
        const form = $('composer');
        if (!form) return;
        if (!composerHome) {
            composerHome = document.createComment('composer');
            form.parentNode.insertBefore(composerHome, form);
        }
        const slot = $('dm-composer-slot');
        if (intoDm && slot) slot.appendChild(form);
        else if (composerHome.parentNode) composerHome.parentNode.insertBefore(form, composerHome.nextSibling);

        // Both callers can fire twice for one transition (setDmMode calls
        // closeDm, which moves the composer, and then moves it again), so the
        // swap is keyed on the surface actually changing rather than on being
        // called.
        const next = composerSurfaceKey();
        if (next === composerSurface) return;
        stashDraft(composerSurface);
        composerSurface = next;
        restoreDraft(next);
    }

    function closeDm() {
        const was = dmOpen;
        dmOpen = null;
        loadDmMessages.lastSig = null;
        // Closing a CONVERSATION does not leave the DM view. Staying puts you
        // on the empty state with the list still there, which is what the
        // reference does; hiding the panel here dropped you back into whatever
        // channel was behind it.
        if (!dmMode) $('dm-panel').hidden = true;
        $('dm-panel').classList.remove('is-group');
        $('dm-panel').classList.toggle('empty', dmMode);
        $('dm-profile').hidden = true;
        if (was) { moveComposer(false); setComposerPlaceholder(); }
        if (dmMode) { $('dm-title').textContent = 'Direct Messages'; renderDmMessages(); }
        renderDmSection();
    }

    // One place decides what the field says, so the channel and DM paths cannot
    // disagree about it.
    function setComposerPlaceholder() {
        const input = $('composer-input');
        if (!input) return;
        input.placeholder = dmOpen
            ? 'Message ' + (dmOpen.isGroup ? dmOpen.title : '@' + dmOpen.title)
            : 'Message #' + channel;
    }

    function dmPanelOpen() { return !$('dm-panel').hidden; }

    async function loadDmMessages(force) {
        if (!dmOpen) return;
        const forThread = dmOpen.id;
        const res = await L.board('dm/list', { query: { thread: forThread } });
        if (!dmOpen || dmOpen.id !== forThread) return;    // switched conversations mid-flight
        // The server is the authority on who is in a group; it can change
        // between opening and reading, and the sender labels below depend on it.
        if (res && res.success && res.thread) {
            dmOpen.members = res.thread.members || dmOpen.members;
            dmOpen.isGroup = !!res.thread.isGroup;
            if (res.thread.title) dmOpen.title = res.thread.title;
            // Membership drives the member count, the add/options buttons and
            // the sender labels below, so the header is repainted with it
            // rather than only when the conversation is first opened.
            renderDmHead();
        }
        if (!res || !res.success) {
            if (authGone(res)) return;
            if (res && res.needsAccount) { closeDm(); toast('Sign into your board account to use DMs', true); return; }
            // Anything else used to leave the drawer on "Loading…" forever.
            dmMessagesError((res && res.error) || 'Could not load this conversation.');
            return;
        }
        const sig = JSON.stringify(res.messages || []);
        // Recorded even when the payload is unchanged: it describes the
        // conversation, not this page, and the poll must not keep resetting it.
        dmHasMore = !!res.hasMore;
        if (!force && sig === loadDmMessages.lastSig) return;
        // The poll fetches the NEWEST page. Anything older that has been paged
        // in stays: assigning the page outright would throw the history away
        // again the moment somebody sent a message, which is the same bug in a
        // slower disguise.
        const page = res.messages || [];
        const oldest = page.length ? page[0].id : 0;
        const kept = oldest ? dmMsgs.filter((m) => m.id < oldest) : [];
        dmMsgs = kept.concat(page);
        // Only claim this payload as rendered if it actually rendered. Stamping
        // the signature up front meant a renderDmMessages() that bailed for an
        // open editor recorded messages it never painted, and the poll then
        // skipped them for as long as nothing else changed.
        if (renderDmMessages()) loadDmMessages.lastSig = sig;
    }

    // One page further back, the way the channel list already does it. Scroll
    // position is restored by height difference rather than by index: the
    // prepended page changes scrollHeight, and without this the view jumps to
    // wherever the old offset now points.
    async function loadOlderDms() {
        if (dmPaging || !dmHasMore || !dmOpen || !dmMsgs.length) return;
        dmPaging = true;
        const forThread = dmOpen.id;
        const before = dmMsgs[0].id;
        const box = $('dm-messages');
        const wasHeight = box.scrollHeight;
        const wasTop = box.scrollTop;
        try {
            const res = await L.board('dm/list', { query: { thread: forThread, before } });
            if (!dmOpen || dmOpen.id !== forThread) return;   // switched mid-flight
            if (authGone(res)) return;
            if (!res || !res.success) return;
            const older = res.messages || [];
            dmHasMore = !!res.hasMore;
            if (!older.length) return;
            // Guarded against a double-fetch racing itself into duplicates.
            const have = new Set(dmMsgs.map((m) => m.id));
            const fresh = older.filter((m) => !have.has(m.id));
            if (!fresh.length) return;
            dmMsgs = fresh.concat(dmMsgs);
            if (renderDmMessages()) {
                box.scrollTop = wasTop + (box.scrollHeight - wasHeight);
            }
        } finally {
            dmPaging = false;
        }
    }

    // Same trigger as the channel list: near the top, with more behind it.
    $('dm-messages').addEventListener('scroll', () => {
        if ($('dm-messages').scrollTop < 60) loadOlderDms();
    });

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

    // Returns false when it declined to paint, so the caller knows not to treat
    // the payload as displayed — exactly as renderThread() does.
    function renderDmMessages() {
        const box = $('dm-messages');
        // The same courtesy the main list and the thread panel already extend:
        // a background poll — or a message arriving over the socket — must not
        // rip the inline editor out from under someone mid-sentence. This list
        // was the one that didn't, so editing your own DM and having the other
        // person reply threw away whatever you had typed.
        if (editingId && box.querySelector('.msg-edit')) return false;
        // Measured before the rebuild: this drawer used to slam to the bottom on
        // every poll, so a DM arriving while you were reading back through the
        // conversation yanked you away from it. The main list and the thread
        // panel already extend this courtesy.
        const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
        box.innerHTML = '';
        // In the DM view with nothing selected: the list is on the left and this
        // column has nothing to say yet.
        if (!dmOpen) {
            const e = document.createElement('div');
            e.className = 'dm-empty dm-nothing';
            e.textContent = dmThreads.length
                ? 'Pick a conversation on the left.'
                : 'No conversations yet — start one with the + above.';
            box.appendChild(e);
            return true;
        }

        // No early return for an empty conversation any more: the start block
        // below IS the empty state, and it says something useful — whose
        // conversation this is and that it has not started yet. Returning here
        // meant a new DM showed a bare line of grey text and no start block at
        // all, which is the one moment the block matters most.
        // A DM is a message, not a chat bubble.
        //
        // This used to render right-aligned rounded bubbles with the timestamp
        // outside them — an iMessage layout — while the channel column three
        // hundred lines up rendered avatar, name, timestamp and flat content on
        // the background. Two renderers for the same thing, and the DM one was
        // the poorer relation: no grouping, no reply quoting, no embeds, no
        // attachments, its own day separator that had already drifted from the
        // channel's, and every one of those would have had to be built a second
        // time to catch up.
        //
        // The reference does not do that. A DM uses the SAME row as a channel
        // message, which is why it gets all of the above for nothing. So does
        // this now: map each message onto the shape renderMessage() expects and
        // hand it over.
        const nameOf = (id) => {
            const u = (dmOpen && dmOpen.members || []).find((x) => x.id === id);
            if (u) return u.username;
            return (account && id === account.id) ? account.username : 'someone';
        };
        // client_id is what the grouping test compares, and DMs have no install
        // id — the account id stands in, which is the right identity here
        // anyway: the same person on two devices is still one speaker.
        const asPost = (m) => ({
            id: m.id,
            client_id: 'dm-user-' + (m.from || 0),
            user_id: m.from || 0,
            name: nameOf(m.from),
            body: m.body,
            created_at: m.created_at,
            // The shared renderer draws "(edited)" from this. dm/list returns it
            // now; older servers omit it, which reads as 0 and draws nothing.
            edited_at: m.edited_at || 0,
            pinned: 0,
            // Lets the shared renderer drop the actions a DM has no backing
            // for. Without it every one of them pointed at the posts table.
            isDm: true,
            // Named as the channel list names them, so the shared renderer
            // draws a DM attachment — image, file card, voice message — with
            // no branch of its own.
            att_key: m.att_key || '',
            att_name: m.att_name || '',
            att_type: m.att_type || '',
            att_size: m.att_size || 0
        });

        // With older messages still on the server this is not the beginning of
        // anything, so say what it is instead — and give the mouse a way back
        // that does not depend on noticing that scrolling loads more.
        if (dmHasMore) {
            const more = document.createElement('div');
            more.className = 'dm-empty dm-more';
            more.innerHTML = '<button type="button" class="keycap dm-load-older">Load earlier messages</button>';
            more.querySelector('.dm-load-older').addEventListener('click', loadOlderDms);
            box.appendChild(more);
        }

        // The DM equivalent of the channel welcome block. It is also what pushes
        // the conversation to the bottom of the column (see #dm-messages >
        // .dm-intro), so a short conversation sits above the composer instead of
        // stranded at the top with a screen of nothing under it.
        // Only when this really IS the start of the history — see above.
        const intro = dmHasMore ? null : document.createElement('div');
        if (intro) {
        intro.className = 'chan-intro dm-intro';
        const others = (dmOpen && dmOpen.members || []).filter((u) => !account || u.id !== account.id);
        const who = dmOpen && dmOpen.isGroup ? dmOpen.title : ((others[0] && others[0].username) || dmOpen && dmOpen.title || '');
        const head = dmOpen && dmOpen.isGroup
            ? '<span class="ico" data-icon="users"></span>'
            : (others[0]
                ? `<span class="av${avatarCls(others[0].id)}" style="${avatarStyle(others[0].username)}">` +
                  `${esc(initials(others[0].username))}${avatarImgHtml(others[0].id)}</span>`
                : '');
        // Three elements, not two. The reference puts a distinct handle line
        // between the name and the sentence — nearly as tall as the name and
        // brighter than the body — and without it the block reads as a heading
        // with a caption rather than a person.
        const handle = dmOpen && dmOpen.isGroup
            ? (dmOpen.members || []).length + ' members'
            : '@' + who;
        intro.innerHTML =
            `<div class="dm-intro-face">${head}</div>` +
            `<h2 class="dm-intro-name">${esc(who)}</h2>` +
            `<div class="dm-intro-handle">${esc(handle)}</div>` +
            '<p class="dm-intro-sub">' + (dmOpen && dmOpen.isGroup
                ? 'This is the beginning of this group.'
                : 'This is the beginning of your direct message history with <b>' + esc(who) + '</b>.') +
            '</p>';
        box.appendChild(intro);
        wireAvatarFallback(intro);
        if (window.ScarmIcons) window.ScarmIcons.hydrate(intro);
        }

        let lastDay = '';
        let prev = null;
        // The header's search box narrows what is on screen. Only what has been
        // loaded — see the listener — so an empty result means "not in the part
        // of this conversation you have open", not "nowhere".
        const shown = dmFilter
            ? dmMsgs.filter((m) => (m.body || '').toLowerCase().includes(dmFilter))
            : dmMsgs;
        if (dmFilter && !shown.length) {
            const e = document.createElement('div');
            e.className = 'dm-empty';
            e.textContent = 'Nothing matching “' + dmFilter + '” in the messages loaded here.';
            box.appendChild(e);
            return true;
        }
        shown.forEach((m) => {
            const day = dayStr(m.created_at);
            if (day !== lastDay) {
                lastDay = day;
                prev = null;                  // a new day always reintroduces the speaker
                // The channel's own separator markup and class, so the two can
                // never drift apart again — they did, and the DM view was left
                // on an older style nobody remembered to update.
                const sep = document.createElement('div');
                sep.className = 'day-sep';
                sep.innerHTML = `<span>${esc(day)}</span>`;
                box.appendChild(sep);
            }
            const p = asPost(m);
            box.appendChild(renderMessage(p, prev));
            prev = p;
        });
        // Follow the live edge only if that's where the reader already was.
        if (atBottom) box.scrollTop = box.scrollHeight;
        return true;
    }

    // Sending a DM is a branch inside the real composer's submit handler now,
    // not a second handler on a second form. See sendDm() below.
    $('dm-close').addEventListener('click', closeDm);

    // Text-only DM send, used by the shared composer. Attachments go through
    // uploadOne(), which posts to the same endpoint with a key.
    async function sendDm(body, thread) {
        const res = await L.board('dm/send', { method: 'POST', body: { thread, body } });
        if (!res || !res.success) return res;
        if (dmOpen && dmOpen.id === thread) {
            dmMsgs.push({
                id: res.id, body, created_at: res.created_at || Date.now(),
                fromMe: true, from: account ? account.id : null
            });
            renderDmMessages();
        }
        loadDmThreads();
        return res;
    }

    // ---- new conversation picker ----
    // One picker for both: one person selected makes a DM, several make a
    // group. Splitting it into "New DM" and "New Group" would ask the reader to
    // decide which they want before they have chosen who, which is backwards.
    const dmPick = { all: [], chosen: new Set(), mode: 'create', thread: 0 };
    const DM_GROUP_MAX = 10;                  // server enforces the same cap

    function renderDmPicker() {
        const box = $('dm-picker-list');
        const q = ($('dm-picker-search').value || '').trim().toLowerCase();
        const shown = dmPick.all.filter((u) => !q || u.username.toLowerCase().includes(q));
        box.innerHTML = '';
        if (!shown.length) {
            box.innerHTML = '<div class="hint dm-picker-empty">No one matches that.</div>';
        }
        shown.forEach((u) => {
            const row = document.createElement('button');
            row.type = 'button';
            const on = dmPick.chosen.has(u.id);
            row.className = 'dm-pick-row' + (on ? ' on' : '');
            row.innerHTML = `<span class="dm-pick-name">${esc(u.username)}` +
                (u.role === 'admin' ? ' <em class="hint">admin</em>' : '') + '</span>' +
                `<span class="dm-pick-check">${on ? '✓' : ''}</span>`;
            row.addEventListener('click', () => {
                if (dmPick.chosen.has(u.id)) dmPick.chosen.delete(u.id);
                // The cap counts me too, which is why it is one fewer here.
                else if (dmPick.chosen.size >= DM_GROUP_MAX - 1) {
                    return toast('A group can hold ' + DM_GROUP_MAX + ' people');
                } else dmPick.chosen.add(u.id);
                renderDmPicker();
            });
            box.appendChild(row);
        });
        const n = dmPick.chosen.size;
        const ok = $('dm-picker-ok');
        ok.disabled = n === 0;
        ok.textContent = n > 1 ? `Create Group DM (${n + 1})` : 'Create DM';
        $('dm-picker-hint').textContent = n > 1
            ? 'A group with you and ' + n + ' others.'
            : 'Pick someone to message. Pick a few to start a group.';
    }

    function closeDmPicker() {
        releaseFocus($('dm-picker'));
        $('dm-picker').hidden = true;
        dmPick.chosen.clear();
    }

    $('dm-picker-cancel').addEventListener('click', closeDmPicker);
    $('dm-picker-search').addEventListener('input', renderDmPicker);
    $('dm-picker').addEventListener('click', (e) => { if (e.target === $('dm-picker')) closeDmPicker(); });

    $('dm-picker-ok').addEventListener('click', async () => {
        const users = [...dmPick.chosen];
        if (!users.length) return;
        // A group create is not idempotent server-side — dm/create INSERTs a new
        // thread every time ids.length > 1 — and this button gave no spinner, no
        // disable and no state change for the ~300ms it was in flight. A second
        // click made a second identical group and pushed it to everyone in it,
        // with no way to tell the two apart. (The one-to-one path was always
        // safe: the server returns the existing thread.)
        const okBtn = $('dm-picker-ok');
        if (okBtn.disabled) return;
        okBtn.disabled = true;
        try {
        // Adding to a group and starting one are the same choice made in two
        // places, so they share the picker and differ only in where it posts.
        if (dmPick.mode === 'add' && dmPick.thread) {
            const r = await L.board('dm/manage', {
                method: 'POST', body: { thread: dmPick.thread, action: 'add', users }
            });
            if (!r || !r.success) return toast((r && r.error) || 'Could not add them', true);
            if (dmOpen && dmOpen.id === dmPick.thread) {
                dmOpen.members = r.members || dmOpen.members;
                renderDmHead();
            }
            closeDmPicker();
            loadDmThreads();
            return toast(users.length === 1 ? 'Added them to the group' : 'Added ' + users.length + ' people');
        }
        const res = await L.board('dm/create', { method: 'POST', body: { users } });
        if (!res || !res.success) {
            return toast((res && res.error) || 'Could not start that conversation', true);
        }
        closeDmPicker();
        await loadDmThreads();

        // The server hands back the thread — including the EXISTING one when a
        // single person was picked, so choosing someone you already talk to
        // reopens that conversation instead of starting a second one beside it.
        if (res.thread) openDm(res.thread);
        } finally {
            okBtn.disabled = false;
        }
    });

    // Open the picker. `exclude` keeps people already in the group off the list
    // — offering to add someone who is already there is an error the server
    // would have to reject, and one the reader should never be shown.
    async function openDmPicker(mode, thread, exclude) {
        if (!account) { openSettings(); return; }
        // ON SCREEN FIRST, then fetch. This used to await the whole member
        // directory before the modal existed, so "New message" and "Add people"
        // did nothing visible at all for a full round trip — and because the
        // reveal was also where re-entry became detectable, a second click
        // during that window ran the whole function again and its
        // `dmPick.chosen.clear()` wiped whatever the first one had produced.
        if (!$('dm-picker').hidden) return;
        dmPick.all = [];
        dmPick.chosen.clear();
        dmPick.mode = mode;
        dmPick.thread = thread || 0;
        $('dm-picker-search').value = '';
        $('dm-picker').querySelector('h2').textContent = mode === 'add' ? 'Add people' : 'New message';
        $('dm-picker-ok').disabled = true;
        $('dm-picker-list').innerHTML = '<div class="hint dm-picker-empty">Loading members…</div>';
        $('dm-picker').hidden = false;
        trapFocus($('dm-picker'), { label: mode === 'add' ? 'Add people' : 'New message', initial: $('dm-picker-search') });

        const res = await L.board('account/users');
        // Closed while the directory was in flight — nothing left to fill in.
        if ($('dm-picker').hidden) return;
        if (!res || !res.success) {
            closeDmPicker();
            return toast((res && res.error) || 'Could not load the member directory', true);
        }
        (res.users || []).forEach((u) => { dmDirectory[u.id] = u; });
        const skip = new Set([account.id, ...(exclude || [])]);
        const others = (res.users || []).filter((u) => !skip.has(u.id));
        if (!others.length) {
            // The modal is already up, so take it back down before saying why.
            closeDmPicker();
            return toast(mode === 'add'
                ? 'Everyone with an account is already in this group'
                : 'No one else has a board account yet — DMs need one on both ends');
        }
        dmPick.all = others;
        renderDmPicker();
    }

    $('btn-new-dm').addEventListener('click', () => openDmPicker('create', 0, []));

    $('dm-add').addEventListener('click', () => {
        if (!dmOpen || !dmOpen.isGroup) return;
        openDmPicker('add', dmOpen.id, (dmOpen.members || []).map((m) => m.id));
    });

    $('dm-more').addEventListener('click', (e) => {
        if (!dmOpen || !dmOpen.isGroup) return;
        const r = e.currentTarget.getBoundingClientRect();
        const thread = dmOpen.id;
        openCtxMenu([
            {
                label: 'Rename group', icon: 'pencil',
                onClick: async () => {
                    const name = await askText('Rename group', dmOpen && dmOpen.title === defaultGroupName(dmOpen) ? '' : (dmOpen ? dmOpen.title : ''), 'Save');
                    if (name === null || name === false) return;
                    const res = await L.board('dm/manage', {
                        method: 'POST', body: { thread, action: 'rename', title: String(name).trim() }
                    });
                    if (!res || !res.success) return toast((res && res.error) || 'Could not rename it', true);
                    if (dmOpen && dmOpen.id === thread) {
                        dmOpen.title = res.title || dmOpen.title;
                        renderDmHead();
                    }
                    loadDmThreads();
                }
            },
            {
                label: 'Leave group', icon: 'ban', danger: true,
                onClick: async () => {
                    const ok = await askConfirm(
                        'Leave this group?',
                        'You will stop receiving its messages. Someone still in it can add you back.',
                        'Leave', true
                    );
                    if (!ok) return;
                    const res = await L.board('dm/manage', { method: 'POST', body: { thread, action: 'leave' } });
                    if (!res || !res.success) return toast((res && res.error) || 'Could not leave the group', true);
                    if (dmOpen && dmOpen.id === thread) closeDm();
                    loadDmThreads();
                    toast('You left the group');
                }
            }
        ], r.left - 140, r.bottom + 4);
    });

    // An unnamed group is shown as its member list, so the rename box should
    // start empty rather than pre-filled with names the reader never typed.
    function defaultGroupName(t) {
        return (t.members || []).filter((m) => !account || m.id !== account.id)
            .map((m) => m.username).join(', ');
    }

    // The rail's DM button: the other place you can be, not one of the servers.
    // It switches PLACE — the sidebar swaps — rather than opening a particular
    // conversation, because that is what a home button does.
    $('rail-dms').addEventListener('click', () => {
        if (!account) { openSettings(); return; }
        // Only ever a way IN. This used to toggle — pressing it while already
        // in direct messages threw you back to the channel — which is what a
        // destination must not do: the server mark beside it is the way back,
        // and a button that means two things depending on where you are is why
        // people could not find it.
        if (dmMode) {
            // Already here. Land on a conversation if none is open, so the
            // press still does something when there is something to do.
            if (!dmOpen && dmThreads.length) openDm(dmThreads[0]);
            return;
        }
        setDmMode(true);
        if (dmThreads.length) openDm(dmThreads[0]);
    });

    $('dm-find').addEventListener('click', () => openDmPicker('create', 0, []));
    $('btn-new-dm-2').addEventListener('click', () => openDmPicker('create', 0, []));
    $('dm-nav-members').addEventListener('click', () => openDmPicker('create', 0, []));

    // Show or hide the profile column. Only meaningful for a pair — a group has
    // no single profile, so the button goes with it.
    $('dm-prof-toggle').addEventListener('click', () => {
        dmProfileOpen = !dmProfileOpen;
        // Through the renderer, so the choice and what is on screen come from
        // the one place — writing `hidden` here is what the poll then undid.
        renderDmProfile();
    });

    // Filters the messages already loaded. It is not a server-side search —
    // there is no DM search endpoint — so it says so rather than pretending to
    // reach further back than the conversation currently holds.
    $('dm-search-input').addEventListener('input', (e) => {
        dmFilter = (e.target.value || '').trim().toLowerCase();
        renderDmMessages();
    });

    // Realtime delivery — pushed by the server the moment the sender posts.
    function onDmEvent(m) {
        if (!m || !m.from) return;
        // Route by thread. The event carries one now; a message from an older
        // server, or a pair conversation, still resolves because the thread
        // list knows which thread that person's messages belong to.
        const tid = m.thread || (dmThreads.find((x) => !x.isGroup && x.user && x.user.id === m.from.id) || {}).id;
        if (dmOpen && tid && dmOpen.id === tid) {
            // Open conversation: append and stop there. The event already
            // carries the body, and the re-fetch that used to follow read from a
            // replica that often hadn't seen the write yet — so the message we
            // had just shown disappeared again until the next poll agreed.
            if (!dmMsgs.some((x) => x.id === m.id)) {
                dmMsgs.push({
                    id: m.id, body: m.body, created_at: m.created_at,
                    fromMe: false, from: m.from.id,
                    // The attachment, which the event carries now. Without it a
                    // file sent with no caption drew a row with a name, an
                    // avatar, a timestamp and nothing else — blank until the
                    // 12-second poll replaced the list. The `|| ''` defaults
                    // mean this client against a server that predates the change
                    // degrades to exactly the old behaviour rather than throwing.
                    att_key: m.att_key || '', att_name: m.att_name || '',
                    att_type: m.att_type || '', att_size: m.att_size || 0
                });
                renderDmMessages();
            }
        } else {
            const t = tid ? dmThreads.find((x) => x.id === tid) : null;
            if (t) {
                t.unread = (t.unread || 0) + 1;
                t.last = { id: m.id, body: m.body, created_at: m.created_at, fromMe: false };
                renderDmSection();
            } else {
                loadDmThreads();
            }
        }
        if (alertsAllowed(null)) {
            const conversationVisible = windowFocused && dmOpen && tid && dmOpen.id === tid;
            if (!conversationVisible) window.loungeSounds.playMessage();
            if (!windowFocused && settings.notifications !== false) {
                // A group has to name both the sender and the group; the
                // sender alone gives no clue where it arrived.
                const title = m.isGroup && m.title
                    ? `${m.from.username} — ${m.title}`
                    : `${m.from.username} (DM)`;
                // A file sent with no caption names itself rather than raising
                // a notification with an empty body.
                L.app.notify({ title, body: (m.body || m.att_name || '').slice(0, 140) });
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
            // The mute-duration submenu is inside the notification popout, so it
            // has to come off first — Escape on it must not take the whole popout
            // with it.
            else if (!$('notif-sub').hidden) closeNotifSub();
            else if (notifPopOpen()) closeNotifPop();
            else if (threadsPopOpen()) closeThreadsPop();
            else if (mePopoverOpen()) closeMePopover();
            else if (!$('lightbox').hidden) closeLightbox();
            else if (!$('dialog').hidden) closeDialog(inp_null());
            // Also a focus-trapped modal over the drawers. Without it here Esc
            // fell through to dmPanelOpen() and closed the conversation BEHIND
            // the picker, which stayed up and kept the focus trap.
            else if (!$('dm-picker').hidden) closeDmPicker();
            else if (!$('picker').hidden) closePicker();
            // Above the dropdown that opened it, and above settings: it is a
            // focus-trapped modal drawn over both.
            else if (!$('filters-modal').hidden) closeFiltersModal();
            else if (!$('popover').hidden) closePopover();
            else if (notesOpen()) closeNotes();
            else if (!$('settings').hidden) closeSettings();
            // The thread and DM drawers sit BELOW every modal above, and the
            // rule at the top of this chain — innermost first — has to hold for
            // all of them, not just the three it was originally written for.
            // Settings, the share picker, the filters form and the release
            // notes are all focus-trapped surfaces drawn over the drawers, and
            // they were ranked underneath: with a thread open, opening Settings
            // and pressing Escape left Settings on screen and quietly closed the
            // thread behind it — including whatever reply was half-typed in it.
            else if (threadOpen()) closeThread();
            else if (dmPanelOpen()) closeDm();
            else if (searchOpen()) closeSearchPop();
            else if (!$('search-panel').hidden) hideSearchResults();
            else if (filterActive()) clearSearch();
            else if (!$('pinned-panel').hidden) togglePinned(false);
        }
        // Ctrl+F goes to the search box, like every other chat client — which
        // is now the box in the header rather than a row that appeared under it.
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && !$('app').hidden) {
            // Never out of a modal. Every focus-trapped surface registers itself
            // with trapFocus, so this asks the trap rather than keeping a list
            // of element ids beside it that would drift out of date. Without it
            // Ctrl+F in Settings, a confirm dialog, the filters form, the share
            // picker or the release notes broke straight out of the trap: the
            // caret landed in the header search box behind the scrim, a dropdown
            // opened behind the scrim, and every keystroke filtered a message
            // list nobody could see — with Tab still confined to the modal, so
            // there was no way back to the box that now had the focus.
            if (trapped.size) return;
            e.preventDefault();
            // The header box belongs to the channel column, and #dm-panel is
            // painted OVER that column — so in direct messages Ctrl+F focused a
            // field nobody could see, opened a dropdown nobody could see, and
            // filtered a channel list nobody was looking at. Search the thing on
            // screen instead.
            if (dmMode) {
                const box = $('dm-search-input');
                if (box) { box.focus(); box.select(); return; }
            }
            searchInput().focus();
            searchInput().select();
            openSearchPop();
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
