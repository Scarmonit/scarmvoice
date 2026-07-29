// Pure helpers shared by the renderer.
//
// WHY THIS FILE EXISTS: app.js is one very large IIFE that touches the DOM,
// window.lounge and module-scope state on almost every line, so none of it could
// be unit-tested — the entire renderer, including the escaping that stands
// between a message someone else wrote and this window, had zero coverage.
//
// Everything here is a pure function of its arguments: no DOM, no IPC, no shared
// state. That is the whole point — these are the parts where a bug is silent
// (a URL parsed slightly wrong, a filter that quietly matches nothing, an escape
// that misses a character) and where a test is therefore worth the most.
//
// Anything needing the DOM or app state stays in app.js.
(function (root, factory) {
    const api = factory();
    // Browser: hang it on window, the way the other renderer modules do.
    if (typeof window !== 'undefined') window.ScarmLib = api;
    // Tests import it directly as a CommonJS module.
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(this, function () {
    'use strict';

    // ---- text --------------------------------------------------------------

    // Everything interpolated into an innerHTML string in app.js goes through
    // here. Quotes matter as much as angle brackets: several call sites build
    // attributes (src="…", style="…"), where an unescaped quote is an escape
    // from the attribute and therefore an injection point.
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

    // The same hue as the avatar, flat and much darker. A profile header with no
    // uploaded banner is a solid band in every client that has one — a saturated
    // two-stop sweep across the full width is not a shape a header ever takes,
    // and at 105px tall it drowned everything under it.
    function bannerStyle(name) {
        return `background:hsl(${hueOf(name || '?')},32%,17%)`;
    }

    function initials(name) {
        const n = String(name || '?').trim();
        const parts = n.split(/\s+/).filter(Boolean);
        if (!parts.length) return '?';
        if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
        return (parts[0][0] + parts[1][0]).toUpperCase();
    }

    // A body that is nothing but a handful of emoji renders large, the way every
    // other chat client does. Anything that isn't an emoji, a skin-tone modifier,
    // a ZWJ, a variation selector or whitespace disqualifies it.
    function isOnlyEmoji(body) {
        const t = String(body || '').trim();
        // Counted in code points, not UTF-16 units: a ZWJ family emoji is 11
        // units on its own, so six of them blew a length-40 cap that was meant
        // to be generous.
        const cps = [...t];
        if (!cps.length || cps.length > 60) return false;
        // Flags are regional-indicator pairs, which are NOT Extended_Pictographic
        // — without allowing them here a message of nothing but flags failed
        // both tests below and rendered at normal size.
        // U+20E3 is listed too: a keycap's only emoji-ish code point is the
        // enclosing mark itself, which is Me rather than Extended_Pictographic.
        const EMOJI = /[\p{Extended_Pictographic}\u{1f1e6}-\u{1f1ff}⃣]/u;
        if (!EMOJI.test(t)) return false;
        // Everything permitted alongside the pictographs: whitespace, regional
        // indicators, the ZWJ and VS16 that glue sequences together, skin-tone
        // modifiers, and the two halves of a KEYCAP. Keycaps were the gap here —
        // the '1' in "1️⃣" is a plain ASCII digit, not Extended_Pictographic, so
        // a message of nothing but keycaps failed this test and rendered small.
        if (/[^\s\p{Extended_Pictographic}\u{1f1e6}-\u{1f1ff}‍️\u{1f3fb}-\u{1f3ff}0-9#*⃣]/u.test(t)) return false;
        // …but a digit only earns its place as part of a keycap. Without this a
        // bare "911" would now pass the class above.
        if (/[0-9#*](?!️?⃣)/u.test(t)) return false;
        // Count what the reader SEES. Code points are the wrong unit: a ZWJ
        // family is four pictographs, so two of them counted as eight and blew
        // a cap that is meant to read "six emoji". Grapheme clusters are exactly
        // the "one visual character" rule — they hold ZWJ sequences, flag pairs,
        // keycaps and skin tones together.
        let count = 0;
        try {
            const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
            for (const g of seg.segment(t)) { if (g.segment.trim()) count++; }
        } catch (e) {
            // No Intl.Segmenter: fall back to the old approximation rather than
            // refusing to enlarge anything.
            const flags = cps.filter((c) => /[\u{1f1e6}-\u{1f1ff}]/u.test(c)).length / 2;
            count = cps.filter((c) => /\p{Extended_Pictographic}/u.test(c)).length + flags;
        }
        return count > 0 && count <= 6;
    }

    // @mention of a given display name. "Anonymous" is excluded because it is the
    // default for anyone who hasn't set a name — matching it would mention a
    // crowd.
    function mentionsMe(body, displayName) {
        const me = String(displayName || '').toLowerCase();
        if (!me || me === 'anonymous') return false;
        try {
            // Bounded on both sides: without the leading boundary
            // "bob@alice.com" notified user "alice", and without the trailing
            // one "@Alexander" notified user "Alex" — false-positive pings for
            // messages that don't even render a mention chip.
            // Both classes must exclude '_' alike: with it allowed on the
            // trailing side only, "@alice_smith" still pinged user "alice" —
            // the very false positive the trailing boundary is here to stop.
            //
            // The classes are UNICODE-aware, not [A-Za-z0-9_]. An ASCII-only
            // boundary treats every non-Latin letter as a separator, so "@alice"
            // matched inside "@alicesson" written in any script that isn't
            // Latin — "@алиса" and "@alice漢字" both pinged "alice". \p{L} and
            // \p{N} cover the letters and digits of every script, which is what
            // "still part of the name" actually means. Display names are free
            // text, so the name itself may be non-ASCII too.
            const esc = me.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const NOT_NAME = '[^\\p{L}\\p{N}_]';
            return new RegExp('(^|' + NOT_NAME + ')@' + esc + '($|' + NOT_NAME + ')', 'iu').test(body || '');
        } catch (e) { return false; }
    }

    // ---- formatting --------------------------------------------------------

    // Date.prototype.toLocale*String builds a fresh Intl formatter on EVERY
    // call. dayStr runs once per retained message on every render, so at 400
    // messages spanning a couple of weeks that measured ~16 ms of main-thread
    // time per render (and ~54 ms once you have paged back to 1200). Hoisting
    // the formatter out is the whole fix: same output, ~90x cheaper.
    //
    // Built lazily so a runtime without Intl still loads the module.
    let TIME_FMT = null;
    let DAY_FMT = null;
    function timeFmt() {
        if (!TIME_FMT) TIME_FMT = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
        return TIME_FMT;
    }
    function dayFmt() {
        if (!DAY_FMT) DAY_FMT = new Intl.DateTimeFormat([], { month: 'long', day: 'numeric', year: 'numeric' });
        return DAY_FMT;
    }

    function timeStr(ms) {
        return timeFmt().format(ms);
    }

    // Which local calendar day an instant falls on, as an integer. The offset is
    // read for that instant, so DST transitions land on the right day.
    function localDayIndex(ms) {
        const d = new Date(ms);
        return Math.floor((ms - d.getTimezoneOffset() * 60000) / 86400000);
    }

    // Memoised by local day. The label no longer depends on what day it is
    // TODAY — it is the date itself — so unlike the old "Today"/"Yesterday"
    // version this cache cannot go stale on a window left open past midnight.
    const dayCache = new Map();

    // Always the date. "Today" and "Yesterday" are only true while you are
    // reading them: scroll back a week and every divider above is still using
    // yesterday's word about a different day. A divider is a bookmark in a log,
    // and a log wants the date.
    function dayStr(ms) {
        const idx = localDayIndex(ms);
        const hit = dayCache.get(idx);
        if (hit !== undefined) return hit;
        const out = dayFmt().format(ms);
        dayCache.set(idx, out);
        return out;
    }

    function fmtSize(b) {
        if (!b) return '';
        if (b < 1024) return b + ' B';
        if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
        return (b / 1048576).toFixed(1) + ' MB';
    }

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

    // ---- files -------------------------------------------------------------

    const AUDIO_EXT = /\.(mp3|wav|ogg|oga|m4a|flac|aac|opus|weba)$/i;
    const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
    const VIDEO_EXT = /\.(mp4|webm|mov|mkv|avi|m4v)$/i;

    // Attachment precedence: audio → image → video → generic file. Types are
    // checked before extensions because .webm is legitimately either audio or
    // video, and the uploader's MIME type is the more reliable signal.
    function attachmentKind(p) {
        const type = String((p && p.att_type) || '').toLowerCase();
        const name = String((p && p.att_name) || '').toLowerCase();
        if (type.startsWith('audio/') || (!type && AUDIO_EXT.test(name))) return 'audio';
        if (type.startsWith('image/') || (!type && IMAGE_EXT.test(name))) return 'image';
        if (type.startsWith('video/') || (!type && VIDEO_EXT.test(name))) return 'video';
        // A generic octet-stream upload still deserves the right player.
        if (AUDIO_EXT.test(name)) return 'audio';
        if (IMAGE_EXT.test(name)) return 'image';
        if (VIDEO_EXT.test(name)) return 'video';
        return 'file';
    }

    function fileIcon(name) {
        const ext = (String(name || '').split('.').pop() || '').toLowerCase();
        const map = {
            pdf: 'doc', doc: 'doc', docx: 'doc', rtf: 'doc', txt: 'doc', md: 'doc',
            xls: 'sheet', xlsx: 'sheet', csv: 'sheet', tsv: 'sheet',
            ppt: 'slides', pptx: 'slides', key: 'slides',
            zip: 'archive', rar: 'archive', '7z': 'archive', gz: 'archive', tar: 'archive',
            json: 'app', xml: 'app', yml: 'app', yaml: 'app', js: 'app', ts: 'app',
            exe: 'app', msi: 'app', bat: 'app', ps1: 'app',
            dmg: 'disc', iso: 'disc', img: 'disc'
        };
        return map[ext] || 'file';
    }

    // ---- urls --------------------------------------------------------------

    const URL_RE = /https?:\/\/[^\s<>"']+/g;
    const IMAGE_URL_RE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)(\?[^\s]*)?$/i;

    function extractUrls(body) {
        const found = String(body || '').match(URL_RE) || [];
        // Trim trailing punctuation people type after a link.
        return [...new Set(found.map((u) => u.replace(/[),.;:!?\]]+$/, '')))].slice(0, 3);
    }

    function isImageUrl(url) {
        return IMAGE_URL_RE.test(String(url || ''));
    }

    // The scheme is PARSED, never pattern-matched: this decides what gets handed
    // to the OS shell, and a javascript: or file: url reaching that point is how
    // a message someone else wrote runs code on this machine.
    function safeHttpUrl(raw) {
        const s = String(raw || '').trim();
        try {
            const u = new URL(s);
            return (u.protocol === 'http:' || u.protocol === 'https:') ? s : null;
        } catch (e) { return null; }
    }

    function urlFileName(url) {
        try {
            const n = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
            return n || 'image';
        } catch (e) { return 'image'; }
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

    // ---- search operators --------------------------------------------------
    //
    // `from:alice has:link before:2026-01-01 lunch` is one string carrying a
    // query and four filters, and the string is the source of truth: the
    // dropdown WRITES operators into the box rather than holding state beside
    // it. That is what makes them typeable and clickable at once — there is
    // only one representation, so the two can never disagree.

    // What each operator accepts. Anything not listed here is not an operator,
    // and stays in the text — so a message about `http://x` or a ratio like
    // `16:9` searches for itself instead of vanishing into a filter.
    const SEARCH_OPS = {
        from: 'user', mentions: 'user', has: 'kind', 'in': 'channel',
        before: 'date', after: 'date', during: 'date', pinned: 'bool'
    };
    // `has:` values, as the reference names them. `embed` and `link` are the
    // same thing to this app — an embed IS the preview of a link — and both are
    // accepted so neither vocabulary is wrong.
    const HAS_KINDS = {
        link: 'links', embed: 'links', file: 'files', image: 'images',
        video: 'videos', sound: 'audio', audio: 'audio'
    };

    // key:value, value optionally "quoted" for names with spaces. The trailing
    // group is deliberately lazy about the closing quote so a half-typed
    // `from:"Ali` still parses — the dropdown has to be able to offer
    // completions while somebody is still typing the thing being completed.
    const OP_RE = /(^|\s)([a-z]+):("([^"]*)"?|[^\s]*)/gi;

    // -> { text, ops } where ops[key] is an ARRAY of values. Repeats are kept
    // rather than overwritten: `from:a from:b` reads as "either of them", which
    // is the only reading that makes repeating one useful.
    function parseSearchQuery(raw) {
        const ops = {};
        let text = String(raw || '');
        text = text.replace(OP_RE, (m, lead, key, whole, quoted) => {
            const k = key.toLowerCase();
            if (!SEARCH_OPS[k]) return m;                 // not an operator; leave it be
            const value = quoted !== undefined ? quoted : whole;
            // A bare `from:` is somebody mid-type, not a filter on the empty
            // string — it must not narrow the list to nothing while they are
            // still choosing.
            if (value !== '') (ops[k] = ops[k] || []).push(value);
            return lead;
        });
        return { text: text.replace(/\s+/g, ' ').trim(), ops };
    }

    // The operator token being typed at the caret, so the dropdown can offer
    // values for it. Returns { key, value, start, end } or null.
    //
    // The tokens are FOUND rather than walked back to, because a quoted value
    // contains the very whitespace a walk-back would stop at: from:"Ada Lov has
    // its caret inside a token that a space sits in the middle of.
    function opAtCaret(raw, caret) {
        const s = String(raw || '');
        const pos = Math.max(0, Math.min(caret === undefined ? s.length : caret, s.length));
        const re = /([a-z]+):("[^"]*"?|[^\s]*)/gi;
        let m;
        while ((m = re.exec(s)) !== null) {
            const start = m.index;
            const end = start + m[0].length;
            // A token only counts at a word boundary, or `16:9` inside a
            // sentence would offer to complete an operator called "16".
            if (start > 0 && !/\s/.test(s[start - 1])) continue;
            if (pos < start || pos > end) continue;
            const key = m[1].toLowerCase();
            if (!SEARCH_OPS[key]) return null;
            const value = m[2].startsWith('"') ? m[2].slice(1).replace(/"$/, '') : m[2];
            return { key, value, start, end };
        }
        return null;
    }

    // Put `key:value` into the string at `at` (from opAtCaret), quoting the
    // value only when it needs it. Returns { text, caret }.
    function writeOp(raw, key, value, at) {
        const s = String(raw || '');
        const v = /\s/.test(String(value)) ? '"' + value + '"' : String(value);
        const token = key + ':' + v + ' ';
        const start = at ? at.start : s.length;
        const end = at ? at.end : s.length;
        // A space before, unless we are at the very start or already have one.
        const head = s.slice(0, start);
        const lead = (head === '' || /\s$/.test(head)) ? '' : ' ';
        const text = head + lead + token + s.slice(end).replace(/^\s+/, '');
        return { text, caret: (head + lead + token).length };
    }

    // ---- filtering ---------------------------------------------------------

    // Set-or-array, so a test can pass a plain array.
    function asSet(v) { return v instanceof Set ? v : new Set(v || []); }

    // Does this post belong to the person the "From" filter names?
    //
    // It used to be `filter.fromIds.includes(p.client_id)` — a list of INSTALL
    // ids snapshotted when the dropdown was built. A client_id is per-install
    // and the server hands out a fresh one whenever the id a device holds
    // already belongs to another account, so one person's history routinely
    // spans several of them (other devices, rotations, rows written before
    // accounts existed with no id at all). Every one of those messages was
    // silently missing from a filter that claimed to show everything they
    // wrote — and because the list was frozen at open, "Load earlier messages
    // to widen results" made it worse rather than better.
    //
    // So resolve the person the way everything else in this app does: the
    // ACCOUNT first, the display name (which the server derives from the
    // credential, so it cannot be worn by someone else) as the fallback for
    // rows that have no account.
    function postFrom(p, from) {
        if (!from) return true;
        const uids = asSet(from.userIds);
        const names = asSet(from.names);
        if (p.user_id && uids.has(p.user_id)) return true;
        return names.has(p.name || 'Anonymous');
    }

    // Types combine as OR; every other criterion is AND. `filter.types` may be a
    // Set or an array so this can be called from a test without building one.
    function postMatchesFilter(p, filter, displayName) {
        if (!filter) return true;
        const types = filter.types instanceof Set
            ? filter.types
            : new Set(filter.types || []);

        if (filter.from && !postFrom(p, filter.from)) return false;
        if (filter.pinned && !p.pinned) return false;
        if (filter.mentions && !mentionsMe(p.body, displayName)) return false;
        if (filter.edited && !p.edited_at) return false;

        // `mentions:someone` — the same test the app uses for "did this ping
        // me", asked about somebody else. Any of the named people counts, so
        // `mentions:a mentions:b` reads as "either".
        if (filter.mentionsNames && filter.mentionsNames.length) {
            const hit = filter.mentionsNames.some((n) => mentionsMe(p.body, n));
            if (!hit) return false;
        }
        // `in:general`. Only meaningful across a multi-channel result set; a
        // post with no channel on it (a DM row) can never match.
        if (filter.inChannel && String(p.channel || '') !== filter.inChannel) return false;
        // before: is exclusive of the day named, after: is exclusive too, and
        // during: is the whole of that day — which is what the words mean when
        // a person says them.
        if (filter.before && !(p.created_at < filter.before)) return false;
        if (filter.after && !(p.created_at > filter.after)) return false;
        if (filter.text) {
            const hay = ((p.body || '') + ' ' + (p.att_name || '')).toLowerCase();
            if (!hay.includes(String(filter.text).toLowerCase())) return false;
        }
        if (types.size) {
            const kind = p.att_key ? attachmentKind(p) : null;
            let ok = false;
            if (types.has('links') && extractUrls(p.body).length) ok = true;
            if (!ok && types.has('files') && p.att_key) ok = true;
            if (!ok && types.has('images') && kind === 'image') ok = true;
            if (!ok && types.has('videos') && kind === 'video') ok = true;
            if (!ok && types.has('audio') && kind === 'audio') ok = true;
            if (!ok) return false;
        }
        return true;
    }

    // ---- chat font size ----------------------------------------------------

    const FONT_SIZES = [
        { key: 'small', px: 14, label: 'Small' },
        { key: 'medium', px: 16, label: 'Medium' },
        { key: 'large', px: 18, label: 'Large' },
        { key: 'xlarge', px: 21, label: 'Extra Large' }
    ];

    function fontSizeIndex(key) {
        const i = FONT_SIZES.findIndex((f) => f.key === key);
        return i === -1 ? 1 : i;                     // default to medium
    }

    // ---- push to talk ------------------------------------------------------

    // Mirrors main/ptt.js's matcher for the native hook, so the in-window path
    // and the global one agree on what counts as a press. A modifier used AS the
    // trigger key must not also be required as a modifier: binding PTT to Shift
    // records shiftKey false, but the event that fires it reports shiftKey true.
    function matchesPttBinding(e, binding) {
        if (!binding || !binding.code || binding.type === 'mouse') return false;
        if (e.code !== binding.code) return false;
        return (!binding.ctrl || !!e.ctrlKey) && (!binding.shift || !!e.shiftKey) &&
               (!binding.alt || !!e.altKey) && (!binding.meta || !!e.metaKey);
    }

    return {
        esc, hueOf, avatarStyle, bannerStyle, initials, isOnlyEmoji, mentionsMe,
        timeStr, dayStr, fmtSize, fmtDuration, splitName,
        attachmentKind, fileIcon,
        extractUrls, isImageUrl, safeHttpUrl, urlFileName, youtubeId,
        postMatchesFilter, postFrom,
        parseSearchQuery, opAtCaret, writeOp, SEARCH_OPS, HAS_KINDS,
        FONT_SIZES, fontSizeIndex,
        matchesPttBinding,
        URL_RE
    };
}));
