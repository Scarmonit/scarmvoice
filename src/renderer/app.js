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
    const POLL_IDLE_MS = 15000;     // socket up → slow safety-net poll
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

    // The pure half of the renderer lives in lib.js so it can be unit-tested;
    // these are local names for the parts used here.
    const {
        esc, avatarStyle, initials, isOnlyEmoji,
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

    // Mention chips within a segment that is already known to be URL-free.
    function appendMentionSegment(container, text, ctx) {
        let i = 0;
        while (i < text.length) {
            const at = text.indexOf('@', i);
            if (at === -1) { container.appendChild(document.createTextNode(text.slice(i))); break; }
            if (at > i) container.appendChild(document.createTextNode(text.slice(i, at)));
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
        if (!container || !window.hljs) return;
        container.querySelectorAll('pre.msg-code code:not([data-hl])').forEach((code) => {
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

    function openDialog({ title, message, value, ok, danger, withInput, label2, value2 }) {
        return new Promise((resolve) => {
            dialogDone = resolve;
            $('dialog-title').textContent = title;
            const msg = $('dialog-msg');
            msg.textContent = message || '';
            msg.hidden = !message;
            const inp = $('dialog-input');
            inp.hidden = !withInput;
            inp.value = value || '';
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
    function askNameAndStatus(name, status) {
        return openDialog({
            title: 'You', value: name, ok: 'Save', withInput: true,
            label2: 'Status (optional)', value2: status
        }).then((v) => (v === null || v === false ? null : { name: v, status: $('dialog-input2').value }));
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

    function showAccountStep() {
        $('login').hidden = false;
        $('login-pw').hidden = true;
        $('login-name').hidden = true;
        $('login-btn').hidden = true;
        $('login-advanced').hidden = true;
        $('login-advanced-box').hidden = true;
        $('login-acct').hidden = false;
        $('login-sub').textContent = 'One more step — sign into your account, or create one';
        $('login-error').textContent = '';
        $('login-acct-user').focus();
    }

    function hideAccountStep() {
        $('login-pw').hidden = false;
        $('login-name').hidden = false;
        $('login-btn').hidden = false;
        $('login-advanced').hidden = false;
        $('login-acct').hidden = true;
        $('login-verify').hidden = true;
        $('login-totp').hidden = true;
        $('login-sub').textContent = 'Enter the board password to connect';
    }

    // ---- 2FA challenge at sign-in ----
    // The username+password we already collected, replayed with the code.
    let pendingTotp = null;    // { username, password }

    function showTotpStep(username, password) {
        pendingTotp = { username, password };
        $('login-acct').hidden = true;
        $('login-totp').hidden = false;
        $('login-sub').textContent = 'Two-factor is on — enter the code from your authenticator app';
        $('login-totp-code').value = '';
        $('login-totp-code').focus();
    }

    async function totpLoginSubmit() {
        const err = $('login-error');
        const code = $('login-totp-code').value.trim();
        if (!/^\d{6}$/.test(code)) { err.textContent = 'Enter the 6-digit code from your app.'; return; }
        err.textContent = '';
        const res = await L.account.login(pendingTotp.username, pendingTotp.password, code);
        if (!res || !res.success) {
            err.textContent = (res && res.error) || 'Could not sign in.';
            $('login-totp-code').value = '';
            $('login-totp-code').focus();
            return;
        }
        account = res.user;
        pendingTotp = null;
        if (!settings.displayName) await saveSettings({ displayName: account.username });
        hideAccountStep();
        $('login').hidden = true;
        enterApp();
    }

    $('login-totp-btn').addEventListener('click', totpLoginSubmit);
    $('login-totp-code').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); totpLoginSubmit(); }
    });

    // The username whose emailed code we're waiting on.
    let pendingVerifyUser = null;

    function showVerifyStep(username) {
        pendingVerifyUser = username;
        $('login-acct').hidden = true;
        $('login-verify').hidden = false;
        $('login-sub').textContent = `We emailed a 6-digit code for "${username}" — enter it to finish`;
        $('login-error').textContent = '';
        $('login-code').value = '';
        $('login-code').focus();
    }

    async function verifySubmit() {
        const err = $('login-error');
        const code = $('login-code').value.trim();
        if (!/^\d{6}$/.test(code)) { err.textContent = 'Enter the 6-digit code from the email.'; return; }
        err.textContent = '';
        const res = await L.account.verify(pendingVerifyUser, code);
        if (!res || !res.success) {
            err.textContent = (res && res.error) || 'Could not verify.';
            return;
        }
        account = res.user;
        pendingVerifyUser = null;
        if (!settings.displayName) await saveSettings({ displayName: account.username });
        if (account.role === 'admin') toast('Account verified — you are the board admin');
        else toast('Account verified — welcome, ' + account.username);
        hideAccountStep();
        $('login').hidden = true;
        enterApp();
    }

    $('login-verify-btn').addEventListener('click', verifySubmit);
    $('login-code').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); verifySubmit(); }
    });
    $('login-resend').addEventListener('click', async () => {
        const res = await L.account.resend(pendingVerifyUser);
        $('login-error').textContent = (res && res.success) ? '' : ((res && res.error) || 'Could not resend.');
        if (res && res.success) toast('Code sent — check your email');
    });

    async function loginAcctSubmit(mode) {
        const err = $('login-error');
        const username = $('login-acct-user').value.trim();
        const password = $('login-acct-pw').value;
        const email = $('login-acct-email').value.trim();
        if (!username || !password) { err.textContent = 'Enter a username and a password.'; return; }
        if (mode === 'register' && !email) { err.textContent = 'Enter your email — new accounts must verify one.'; return; }
        err.textContent = '';

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
        // A fresh install with no display name inherits the account name.
        if (!settings.displayName) await saveSettings({ displayName: account.username });
        if (mode === 'register' && account.role === 'admin') {
            toast('Account created — you are the board admin');
        }
        hideAccountStep();
        $('login').hidden = true;
        enterApp();
    }

    $('login-acct-signin').addEventListener('click', () => loginAcctSubmit('login'));
    $('login-acct-create').addEventListener('click', () => loginAcctSubmit('register'));
    $('login-acct-pw').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); loginAcctSubmit('login'); }
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
        // Anything left queued by a previous session goes out as soon as the
        // first successful poll proves we're online.
        loadOutbox();

        applyChatFontSize(settings.chatFontSize);
        applyChrome();
        setChannelTitle(channel);
        warnIfElevated();
        window.loungeSounds.init(settings);
        window.ScarmNoise.setEnabled(!!settings.noiseSuppressionAI);
        setupVoice();
        renderMe();
        // BEFORE the socket opens: this registers the install against the
        // account, and the realtime upgrade resolves that mapping server-side
        // to merge your devices. A socket opened first would carry no identity.
        await refreshAccount();
        await L.rt.start();
        await loadChannels();
        await loadMessages(true);
        startPolling();
        startTextPresence();
        loadDmThreads();
        startDmPolling();
        await L.ptt.apply();
        refreshPttHint();
        flushOutbox();

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
        let total = 0;
        let alerting = 0;       // the same count minus muted channels
        channels.forEach((c) => {
            const b = document.createElement('button');
            const unread = c.name === channel ? 0 : (c.unread || 0);
            total += unread;
            if (!channelMuted(c.name)) alerting += unread;
            b.className = 'chan' + (c.name === channel ? ' active' : '') +
                (unread ? ' unread' : '') + (channelMuted(c.name) ? ' muted' : '');
            b.dataset.channel = c.name;
            b.innerHTML = `<span class="hash">#</span><span class="chan-name">${esc(c.name)}</span>` +
                (unread ? `<span class="unread">${unread > 99 ? '99+' : unread}</span>` : '');
            b.addEventListener('click', () => switchChannel(c.name));
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
        const n = settings.dnd ? 0 : Math.max(0, total | 0);
        if (n === lastTaskbarBadge) return;     // don't re-flash on every render
        lastTaskbarBadge = n;
        L.app.setBadge(n);
    }

    // Channel name only — the '#' is a separate glyph in the header.
    function setChannelTitle(name) {
        $('chan-title').textContent = name;
        $('composer-input').placeholder = 'Message #' + name;
    }

    async function switchChannel(name) {
        if (name === channel) return;
        channel = name;
        await saveSettings({ channel: name });
        setChannelTitle(name);
        posts = [];
        following = true;
        seenTopId = 0;
        clearReply();            // the quoted message lives in the old channel
        if (threadOpen()) closeThread();
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
        setChannelTitle(channel);
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
        setChannelTitle('general');
        renderChannels();
        loadMessages(true);
    });

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
            if (loading || channel !== forChannel) return;
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
                    if (alertsAllowed(channel)) window.loungeSounds.playMessage();
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

        if (!list.length) {
            const text = active
                ? 'No loaded messages match these filters.' + (hasMore ? ' Load earlier messages to search further back.' : '')
                : `No messages in #${channel} yet — say something.`;
            rows.push({
                key: 'empty', sig: text, make: () => {
                    const e = document.createElement('div');
                    e.className = 'empty-state';
                    e.textContent = text;
                    return e;
                }
            });
        } else {
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
            `<div class="msg-avatar" style="${avatarStyle(settings.displayName)}">` +
            `${esc(initials(settings.displayName || 'You'))}</div></div>` +
            '<div class="msg-body">' +
            '<div class="msg-head">' +
            `<span class="msg-author">${esc(settings.displayName || 'You')}</span>` +
            `<span class="msg-time">${esc(timeStr(entry.created_at))}</span>` +
            '</div>' +
            '<div class="msg-text"></div>' +
            '<div class="pending-note"></div>' +
            '</div>';

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
            `<div class="msg-avatar" style="${avatarStyle(p.name)}">${esc(initials(p.name))}</div>` +
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
                parts.push(`<img src="${esc(url)}" alt="${esc(p.att_name)}" loading="lazy" ` +
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
                    `<span class="rx-emoji">${esc(r.emoji)}</span><span class="rx-n">${r.count}</span></button>`;
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
            '<button class="msg-act" data-act="react" title="Add a reaction">' + I('smile') + '</button>' +
            '<button class="msg-act" data-act="reply" title="Reply">' + I('reply') + '</button>' +
            `<button class="msg-act${p.pinned ? ' on' : ''}" data-act="pin" title="${p.pinned ? 'Unpin' : 'Pin'} this message">` + I('pin') + '</button>' +
            '<button class="msg-act" data-act="copy" title="Copy text">' + I('copy') + '</button>' +
            (mine ? '<button class="msg-act" data-act="edit" title="Edit message">' + I('pencil') + '</button>' : '') +
            (mine ? '<button class="msg-act danger" data-act="delete" title="Delete message">' + I('trash') + '</button>' : '') +
            '</div>');

        el.innerHTML = parts.join('');

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
                L.rt.notifyPosted(forChannel);
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

        if (res && res.needsAuth) return relogin();
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
        L.rt.notifyPosted(forChannel);
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

                if (res && res.needsAuth) { entry.sending = false; return relogin(); }

                if (res && res.success) {
                    outbox = outbox.filter((o) => o !== entry);
                    saveOutbox();
                    L.rt.notifyPosted(entry.channel);
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

    const MAX_UPLOAD = 25 * 1048576;

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

        let buf = item.bytes;
        if (!buf) {
            try {
                buf = await item.file.arrayBuffer();
            } catch (e) {
                failUploadRow(row, `Could not read ${item.name}`);
                return false;
            }
        }

        const uploadId = 'u' + (++uploadSeq);
        uploadRows.set(uploadId, { row, size: item.size });
        let up;
        try {
            up = await L.uploadFile(item.name, item.type || 'application/octet-stream', buf, uploadId);
        } finally {
            uploadRows.delete(uploadId);
        }
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
                channel: chan || channel,
                quoteId: quoteId || null,
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
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (e) {
            toast(e && e.name === 'NotAllowedError'
                ? 'Microphone access is needed to record a voice message'
                : 'Could not open the microphone', true);
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
        // during a LATER one and auto-send it mid-sentence.
        const thisRec = mediaRec;
        setTimeout(() => { if (mediaRec === thisRec && recording()) stopRecording(true); }, REC_MAX_MS);
    }

    function stopRecording(send) {
        recSend = !!send;
        if (mediaRec && mediaRec.state !== 'inactive') { try { mediaRec.stop(); } catch (e) {} }
    }

    function finishRecording() {
        if (recTimer) { clearInterval(recTimer); recTimer = null; }
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

                // Share and camera controls only make sense while connected.
                $('btn-share').hidden = !st.joined;
                $('btn-share').classList.toggle('on', st.sharing);
                $('btn-share-label').textContent = st.sharing ? 'Stop sharing' : 'Share screen';

                $('btn-cam').hidden = !st.joined;
                $('btn-cam').classList.toggle('on', !!st.cam);
                $('btn-cam-label').textContent = st.cam ? 'Turn off camera' : 'Turn on camera';

                // Both tray buttons are icon-only, so the label doubles as the
                // tooltip rather than being read off the button face.
                $('btn-cam').title = $('btn-cam-label').textContent;
                $('btn-share').title = $('btn-share-label').textContent;

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

    // Clicking the channel you're already in is a no-op, as in Discord — leaving
    // is the disconnect button in the voice panel.
    $('btn-join-voice').addEventListener('click', () => {
        if (voice && voice.isJoined()) return;
        joinVoice();
    });
    $('btn-leave-voice').addEventListener('click', leaveVoice);

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
        window.loungeSounds.voiceRoster(list, inCall, settings.clientId, !!settings.dnd);

        list.forEach((p) => addRosterName(p.name));
        renderVoiceUsers(list, inCall);
        renderMembers(list, inCall);
    }

    // Who is in the call, listed under the voice channel in the sidebar. Rows
    // carry .vp so the speaking highlight and the per-person volume popover work
    // exactly as they do in the members sidebar.
    function renderVoiceUsers(list, inCall) {
        const ul = $('voice-users');
        ul.innerHTML = '';

        list.forEach((p) => {
            const isMe = p.id === settings.clientId;
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
                `<span class="av" style="${avatarStyle(p.name)}">${esc(initials(p.name))}</span>` +
                `<span class="vp-name">${esc(p.name)}${isMe ? ' (you)' : ''}</span>` +
                (unreachable ? '<span class="vp-flag warn" title="In voice, but not connected to you — they may need to reload the website">' + I('warning') + '</span>' : '') +
                (p.muted || localMuted ? '<span class="vp-flag">' + I('volume-off') + '</span>' : '');

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
        const inVoice = new Map(voiceList.map((p) => [keyOf(p.uid, p.id), p]));
        const seen = new Set();
        const rows = [];

        // Everyone the presence table knows about, plus anyone in the call who
        // hasn't heartbeated yet (a website user who only joined voice).
        members.forEach((m) => {
            const key = keyOf(m.user_id, m.client_id);
            if (seen.has(key)) return;
            seen.add(key);
            rows.push({
                id: m.client_id,
                uid: m.user_id || null,
                name: m.name || 'Anonymous',
                status: (m.status === 'away' || m.status === 'dnd') ? m.status : 'online',
                custom: m.custom || '',
                voice: inVoice.get(key) || null
            });
        });
        voiceList.forEach((p) => {
            const key = keyOf(p.uid, p.id);
            if (seen.has(key)) return;
            seen.add(key);
            rows.push({ id: p.id, uid: p.uid || null, name: p.name, status: 'online', custom: '', voice: p });
        });

        // Within a group, whoever is in the call comes first, then alphabetical.
        const byPresence = (a, b) =>
            (a.voice ? 0 : 1) - (b.voice ? 0 : 1) || a.name.localeCompare(b.name);
        const online = rows.filter((r) => r.status !== 'away').sort(byPresence);
        const away = rows.filter((r) => r.status === 'away').sort(byPresence);

        $('members-count').textContent = rows.length ? String(rows.length) : '';

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
            const sub = blocked ? 'Blocked'
                : (r.custom || (r.status === 'away' ? 'Away' : (r.status === 'dnd' ? 'Do not disturb' : '')));
            const dotClass = r.status === 'away' ? ' away' : (r.status === 'dnd' ? ' dnd' : '');
            li.innerHTML =
                '<span class="av-wrap">' +
                `<span class="av" style="${avatarStyle(r.name)}">${esc(initials(r.name))}</span>` +
                `<i class="presence${dotClass}" aria-hidden="true"></i>` +
                '</span>' +
                '<span class="vp-name">' + esc(r.name) + (isMe ? ' (you)' : '') +
                (sub ? `<span class="vp-sub">${esc(sub)}</span>` : '') + '</span>' +
                (blocked ? '<span class="vp-flag" title="Blocked">' + I('ban') + '</span>' : '') +
                (p ? '<span class="vp-invoice" title="In voice">' + I('volume') + '</span>' : '') +
                (unreachable ? '<span class="vp-flag warn" title="In voice, but not connected to you — they may need to reload the website">' + I('warning') + '</span>' : '') +
                (p && (p.muted || localMuted) ? '<span class="vp-flag">' + I('volume-off') + '</span>' : '');

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

        $('pop-avatar').textContent = initials(p.name);
        $('pop-avatar').setAttribute('style', avatarStyle(p.name));
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

    function myPresenceStatus() {
        // Do-not-disturb outranks the computed states — everyone should see it.
        if (settings.dnd) return 'dnd';
        if (document.hidden || !windowFocused) return 'away';
        if (Date.now() - lastActivity > AWAY_AFTER_MS) return 'away';
        return 'online';
    }

    async function sendTextPresence(leaving) {
        const res = await L.board('presence', {
            method: 'POST',
            body: {
                clientId: settings.clientId,
                name: settings.displayName || 'Anonymous',
                status: myPresenceStatus(),
                custom: settings.status || '',
                leaving: !!leaving
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
                } else {
                    bumpUnread(m.channel);
                    if (m.cid !== settings.clientId) notifyOtherChannel(m);
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
                // session per person, so this device steps aside.
                if (voice && voice.isJoined()) {
                    heartbeatPresence(true);
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

    // Rich notification for fresh posts in the CURRENT channel — the mention is
    // preferred over the newest message, same as the website.
    async function notifyForPosts(fresh) {
        if (!fresh.length || settings.notifications === false) return;
        if (!alertsAllowed(channel)) return;     // do not disturb, or a muted channel
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
        if (!alertsAllowed(m.channel)) return;
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
            // The poll is also the retry clock for anything queued while the
            // socket was down but before it reported itself as reconnected.
            await flushOutbox();
        }, every);
    }

    async function relogin() {
        stopPolling();
        stopPresence();
        stopTextPresence();
        if (voice) voice.leave();
        $('app').hidden = true;
        hideAccountStep();       // back to step 1 — the site password comes first
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
        const st = $('me-status');
        st.textContent = settings.status || '';
        st.hidden = !settings.status;
        const dot = $('me-presence');
        dot.classList.toggle('dnd', !!settings.dnd);
        dot.title = settings.dnd ? 'Do not disturb' : 'Online';
    }

    // Name and status together, like the website's name pill — they're the two
    // things that describe you to everyone else.
    async function changeName() {
        const r = await askNameAndStatus(settings.displayName || '', settings.status || '');
        if (r === null) return;
        await saveSettings({
            displayName: r.name.trim().slice(0, 40),
            status: r.status.trim().slice(0, 80)
        });
        renderMe();
        renderAccountCard();
        $('set-name').value = settings.displayName;
        $('set-status').value = settings.status || '';
        sendTextPresence(false);      // publish it now rather than up to 20s later
    }
    $('btn-name').addEventListener('click', changeName);

    // ---------- layout chrome: rail, categories, members sidebar ----------

    function applyMembersPanel(show) {
        $('members-panel').hidden = !show;
        const btn = $('btn-members');
        btn.classList.toggle('on', show);
        btn.setAttribute('aria-pressed', String(show));
        btn.title = show ? 'Hide member list' : 'Show member list';
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
    $('rail-settings').addEventListener('click', openSettings);

    // Everything about the shell that comes out of saved settings.
    function applyChrome() {
        applyMembersPanel(settings.showMembers !== false);
        applyCategory('text', settings.catTextOpen !== false);
        applyCategory('dms', settings.catDmsOpen !== false);
        applyCategory('voice', settings.catVoiceOpen !== false);
        applyTheme();
        applyDensity();
        let host = '';
        try { host = new URL(settings.baseUrl || 'https://scarmonit.com').host; }
        catch (e) { host = settings.baseUrl || ''; }
        $('sh-host').textContent = host;
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

    // One place decides whether anything is allowed to make a noise or a toast.
    function alertsAllowed(channelName) {
        if (settings.dnd) return false;
        if (channelName && channelMuted(channelName)) return false;
        return true;
    }

    function channelMuted(name) {
        return Array.isArray(settings.mutedChannels) && settings.mutedChannels.includes(name);
    }

    async function setChannelMuted(name, muted) {
        const list = (settings.mutedChannels || []).filter((c) => c !== name);
        if (muted) list.push(name);
        await saveSettings({ mutedChannels: list });
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

    // Right-click a channel for the things Discord puts there.
    $('channel-list').addEventListener('contextmenu', (e) => {
        const row = e.target.closest('.chan');
        if (!row) return;
        e.preventDefault();
        const name = row.dataset.channel;
        const muted = channelMuted(name);
        openCtxMenu([
            { label: muted ? 'Unmute #' + name : 'Mute #' + name, icon: muted ? 'bell' : 'bell-off',
                onClick: () => setChannelMuted(name, !muted) },
            'sep',
            { label: 'Rename channel', icon: 'pencil', disabled: name === 'general',
                onClick: () => { switchChannel(name).then(() => $('btn-rename-channel').click()); } },
            { label: 'Delete channel', icon: 'trash', danger: true, disabled: name === 'general',
                onClick: () => { switchChannel(name).then(() => $('btn-delete-channel').click()); } }
        ], e.clientX, e.clientY);
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
        $('set-dnd').checked = !!settings.dnd;
        $('set-theme').value = settings.theme || 'dark';
        $('set-density').value = settings.density || 'cozy';
        $('set-vad').value = String(vadValue());
        paintThreshold();
        renderAccountCard();
        renderMutedChannels();
        renderBlocked();

        await populateDevices();
        refreshPttHint();
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
        const av = $('set-avatar');
        av.textContent = initials(name);
        av.setAttribute('style', avatarStyle(name));
        $('set-avatar-name').textContent = name;
        const sub = $('set-avatar-status');
        sub.textContent = settings.status || '';
        sub.hidden = !settings.status;

        $('acct-signed').hidden = !account;
        $('acct-forms').hidden = !!account;
        if (account) {
            $('acct-user').textContent = account.username;
            $('acct-role').textContent = (account.role === 'admin' ? '(admin)' : '') +
                (account.totp ? ' · 2FA on' : '');
            $('btn-acct-2fa').textContent = account.totp ? 'Turn off 2FA' : 'Enable 2FA';
        }
    }

    // ---- two-factor auth (TOTP) ----

    function drawQr(container, text) {
        container.innerHTML = '';
        try {
            // Type 0 = auto-size for the payload; 'M' error correction.
            const qr = window.qrcode(0, 'M');
            qr.addData(text);
            qr.make();
            container.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 8, scalable: true });
        } catch (e) {
            container.textContent = 'Could not draw the QR code — use the key below.';
        }
    }

    async function start2faSetup() {
        const res = await L.board('account/twofactor', { method: 'POST', body: { action: 'setup' } });
        if (!res || !res.success) return toast((res && res.error) || 'Could not start 2FA setup', true);
        $('acct-2fa-secret').textContent = res.secret;
        drawQr($('acct-2fa-qr'), res.otpauth);
        $('acct-2fa-setup').hidden = false;
        $('acct-2fa-code').value = '';
        $('acct-2fa-code').focus();
    }

    $('btn-acct-2fa').addEventListener('click', async () => {
        if (!account) return;
        if (!account.totp) return start2faSetup();
        // Turning it off needs a live code, so the server can trust the request.
        const code = await openDialog({
            title: 'Turn off two-factor?',
            message: 'Enter a current code from your authenticator app to confirm.',
            ok: 'Turn off', withInput: true, danger: true
        });
        if (code === null || code === false) return;
        const res = await L.board('account/twofactor', { method: 'POST', body: { action: 'disable', code: String(code).trim() } });
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

    async function refreshAccount() {
        try {
            const res = await L.account.me();
            account = (res && res.success && res.user) || null;
        } catch (e) {
            account = null;
        }
        renderAccountCard();
        renderDmSection();
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
        await L.account.logout();
        account = null;
        dmThreads = [];
        closeDm();
        renderAccountCard();
        renderDmSection();
        // Accounts are mandatory: without one, back to the gate (the board
        // session itself stays valid, so it's a one-field hop back in).
        $('settings').hidden = true;
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
            const lab = document.createElement('label');
            lab.className = 'chan-mute';
            lab.innerHTML = '<input type="checkbox">' + I('bell-off', 'ico') +
                `<span>#${esc(c.name)}</span>`;
            const cb = lab.querySelector('input');
            cb.checked = channelMuted(c.name);
            cb.addEventListener('change', () => setChannelMuted(c.name, cb.checked));
            box.appendChild(lab);
        });
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
        $('btn-mic-test').textContent = 'Test';
        $('btn-mic-test').classList.remove('recording');
        $('mic-meter-bar').style.width = '0%';
        $('mic-meter-bar').classList.remove('over');
    }

    async function startMicTest() {
        stopMicTest();
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: settings.micDeviceId ? { deviceId: { exact: settings.micDeviceId } } : true
            });
        } catch (e) {
            toast(e && e.name === 'NotAllowedError'
                ? 'Microphone access is needed to test your mic'
                : 'Could not open the microphone', true);
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
        $('btn-mic-test').textContent = 'Stop';
        $('btn-mic-test').classList.add('recording');
    }

    $('btn-mic-test').addEventListener('click', () => {
        if (micTest) stopMicTest(); else startMicTest();
    });

    // Section nav down the left of the settings sheet, built from the sheet's own
    // headings so adding a section needs no extra wiring.
    (function buildSettingsNav() {
        const modal = document.querySelector('#settings .modal');
        const body = $('settings-body');
        const nav = document.createElement('nav');
        nav.className = 'set-nav';
        const items = [];

        body.querySelectorAll('.set-group').forEach((g) => {
            const h = g.querySelector('h3');
            if (!h) return;                      // the sign-out row has no heading
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'set-nav-item';
            b.textContent = h.textContent;
            // Rects, not offsetTop: the modal is a centred grid item, so offset
            // parents here are not the scroll container.
            b.addEventListener('click', () => {
                body.scrollTop += g.getBoundingClientRect().top - body.getBoundingClientRect().top - 8;
            });
            nav.appendChild(b);
            items.push({ g, b });
        });

        modal.insertBefore(nav, modal.firstChild);
        if (items.length) items[0].b.classList.add('on');

        body.addEventListener('scroll', () => {
            const top = body.getBoundingClientRect().top;
            let active = items[0];
            items.forEach((it) => {
                if (it.g.getBoundingClientRect().top - top <= 24) active = it;
            });
            items.forEach((it) => it.b.classList.toggle('on', it === active));
        });
    })();
    $('settings').addEventListener('mousedown', (e) => {
        if (e.target === $('settings')) closeSettings();
    });

    // ---- new settings controls ----
    $('set-status').addEventListener('change', async (e) => {
        await saveSettings({ status: e.target.value.trim().slice(0, 80) });
        renderMe();
        renderAccountCard();
        sendTextPresence(false);        // publish it now rather than up to 20s later
    });
    $('set-dnd').addEventListener('change', async (e) => {
        await saveSettings({ dnd: e.target.checked });
        renderMe();
        renderChannels();       // the taskbar badge is suppressed while DND is on
        sendTextPresence(false);   // everyone's member list shows the red dot now, not in 20s
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

    $('set-name').addEventListener('change', async (e) => {
        await saveSettings({ displayName: e.target.value.trim().slice(0, 40) });
        renderMe();
        renderAccountCard();
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
    $('set-nsai').addEventListener('change', async (e) => {
        await saveSettings({ noiseSuppressionAI: e.target.checked });
        window.ScarmNoise.setEnabled(e.target.checked);
        if (voice.isJoined()) toast('Rejoin voice to apply AI noise suppression');
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
        if (voice.isJoined()) { heartbeatPresence(true); voice.leave(); }
        stopPolling();
        stopPresence();
        await sendTextPresence(true);      // drop out of the members list now
        stopTextPresence();
        // "Sign out" means out of EVERYTHING — board session and account —
        // so the next sign-in walks both steps again.
        await L.account.logout();
        account = null;
        dmThreads = [];
        closeDm();
        await L.auth.logout();
        await L.rt.stop();
        $('settings').hidden = true;
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
            b.className = 'ctx-item' + (it.danger ? ' danger' : '');
            // it.icon is a name in the icon set, never a glyph.
            b.innerHTML = (it.icon ? I(it.icon, 'ico ctx-ico') : '<span class="ctx-ico"></span>') +
                `<span class="ctx-label">${esc(it.label)}</span>`;
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

    // Matches on the keywords above and, so an unlisted emoji is still findable,
    // on its category name.
    function searchEmojis(query) {
        const q = String(query || '').trim().toLowerCase();
        if (!q) return null;
        const terms = q.split(/\s+/);
        const out = [];
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

        function button(em) {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = em;
            b.title = EMOJI_WORDS[em] ? EMOJI_WORDS[em].split(' ')[0] : '';
            b.addEventListener('click', () => {
                const cb = emojiCb;
                noteEmojiUsed(em);
                closeEmojiPop();
                if (cb) cb(em);
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

            const recent = recentEmojis();
            if (recent.length) {
                grid.appendChild(heading('Frequently used'));
                recent.forEach((em) => grid.appendChild(button(em)));
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
        if (!isAdmin() && p.client_id !== settings.clientId) return toast('You can only delete your own messages', true);

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
    const isImageUrl = window.ScarmLib.isImageUrl;

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
            hideSearchResults();
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
        if (filter.fromIds) chips.push({ icon: 'users', label: 'From ' + (filter.fromName || 'user'), off: () => { filter.fromIds = filter.fromName = null; const fs = $('filter-from'); if (fs) fs.value = ''; } });
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
        if (res && res.needsAuth) return relogin();
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
            nm.textContent = r.client_id === settings.clientId ? 'You' : (r.name || 'Anonymous');
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

        threadRootId = rootId;
        threadSig = '';
        threadPosts = [];
        $('thread-panel').hidden = false;
        $('thread-list').innerHTML = '<div class="thread-loading">Loading thread…</div>';
        await loadThread(true);
        $('thread-input').focus();
        if (threadTimer) clearInterval(threadTimer);
        threadTimer = setInterval(() => loadThread(false), THREAD_POLL_MS);
    }

    function closeThread() {
        threadRootId = 0;
        threadPosts = [];
        if (threadTimer) { clearInterval(threadTimer); threadTimer = null; }
        $('thread-panel').hidden = true;
    }

    function threadOpen() { return !$('thread-panel').hidden; }

    async function loadThread(force) {
        if (!threadRootId) return;
        const root = threadRootId;
        const res = await L.board('thread', { query: { root } });
        if (root !== threadRootId) return;               // switched while in flight
        if (res && res.needsAuth) return relogin();
        if (!res || !res.success) return;

        threadPosts = res.posts || [];
        if (!threadPosts.length) { closeThread(); return; }   // root was deleted
        threadPosts.forEach((p) => addRosterName(p.name));

        const sig = JSON.stringify(threadPosts);
        if (!force && sig === threadSig) return;
        threadSig = sig;
        renderThread();
    }

    function renderThread() {
        const list = $('thread-list');
        // Same courtesy the main list extends: a thread poll must not destroy
        // an inline editor someone is typing into.
        if (editingId && list.querySelector('.msg-edit')) return;
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

        if (res && res.needsAuth) return relogin();
        if (!res || !res.success) {
            $('thread-input').value = body;     // hand the text back
            return toast((res && res.error) || 'Could not reply', true);
        }
        L.rt.notifyPosted(channel);
        await loadThread(true);
        $('thread-list').scrollTop = $('thread-list').scrollHeight;
        await loadMessages(nearBottom());       // refresh the reply count
        $('thread-input').focus();
    });

    // ---------- pinned ----------------------------------------------------

    async function pinPost(id, pinned) {
        const res = await L.board('pin', { method: 'POST', body: { id, pinned, clientId: settings.clientId } });
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
    let dmLoadedOnce = false;

    function dmUnreadTotal() {
        return dmThreads.reduce((s, t) => s + (t.unread || 0), 0);
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
            dmLoadedOnce = true;
            renderDmSection();
        }
    }

    function startDmPolling() {
        if (dmTimer) clearInterval(dmTimer);
        dmTimer = setInterval(() => {
            if (!account || $('app').hidden) return;
            loadDmThreads();
            if (dmOpen) loadDmMessages(false);
        }, DM_POLL_MS);
    }

    async function openDm(user) {
        dmOpen = { id: user.id, username: user.username };
        $('dm-title').textContent = user.username;
        $('dm-panel').hidden = false;
        closeThread();
        dmMsgs = [];
        $('dm-messages').innerHTML = '<div class="thread-loading">Loading…</div>';
        await loadDmMessages(true);
        const t = dmThreads.find((x) => x.user.id === user.id);
        if (t && t.unread) { t.unread = 0; renderDmSection(); }
        renderDmSection();
        $('dm-input').focus();
    }

    function closeDm() {
        dmOpen = null;
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
            if (res && res.needsAccount) { closeDm(); toast('Sign into your board account to use DMs', true); }
            return;
        }
        const sig = JSON.stringify(res.messages || []);
        if (!force && sig === loadDmMessages.lastSig) return;
        loadDmMessages.lastSig = sig;
        dmMsgs = res.messages || [];
        renderDmMessages();
    }

    function renderDmMessages() {
        const box = $('dm-messages');
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
        // A DM drawer always lands on the newest message.
        box.scrollTop = box.scrollHeight;
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
        const res = await L.board('account/users');
        if (!res || !res.success) return toast((res && res.error) || 'Could not load the member directory', true);
        const others = (res.users || []).filter((u) => u.id !== account.id);
        if (!others.length) {
            return toast('No one else has a board account yet — DMs need one on both ends');
        }
        const r = e.currentTarget.getBoundingClientRect();
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
            // Open conversation: append, and let the server mark it read via
            // the next list call rather than double-counting unread.
            dmMsgs.push({ id: m.id, body: m.body, created_at: m.created_at, fromMe: false });
            renderDmMessages();
            loadDmMessages(true);
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
            if (emojiPopOpen()) closeEmojiPop();
            else if (!$('ctx-menu').hidden) closeCtxMenu();
            else if (threadOpen()) closeThread();
            else if (dmPanelOpen()) closeDm();
            else if (!$('lightbox').hidden) closeLightbox();
            else if (!$('dialog').hidden) closeDialog(inp_null());
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
        if (voice && voice.isJoined()) {
            heartbeatPresence(true);
            voice.leave();
        }
    });

    boot();
})();
