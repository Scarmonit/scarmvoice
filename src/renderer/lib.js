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
        const EMOJI = /[\p{Extended_Pictographic}\u{1f1e6}-\u{1f1ff}]/u;
        if (!EMOJI.test(t)) return false;
        if (/[^\s\p{Extended_Pictographic}\u{1f1e6}-\u{1f1ff}‍️\u{1f3fb}-\u{1f3ff}]/u.test(t)) return false;
        // Regional indicators come in pairs, so each flag counts once.
        const flags = cps.filter((c) => /[\u{1f1e6}-\u{1f1ff}]/u.test(c)).length / 2;
        const pictos = cps.filter((c) => /\p{Extended_Pictographic}/u.test(c)).length;
        return pictos + flags <= 6;
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
            const esc = me.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return new RegExp('(^|[^A-Za-z0-9_])@' + esc + '($|[^A-Za-z0-9_])', 'i').test(body || '');
        } catch (e) { return false; }
    }

    // ---- formatting --------------------------------------------------------

    function timeStr(ms) {
        return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }

    function dayStr(ms, now) {
        const d = new Date(ms);
        const ref = now === undefined ? Date.now() : now;
        const today = new Date(ref);
        const yest = new Date(ref - 86400000);
        const same = (a, b) => a.toDateString() === b.toDateString();
        if (same(d, today)) return 'Today';
        if (same(d, yest)) return 'Yesterday';
        return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
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

    // ---- filtering ---------------------------------------------------------

    // Types combine as OR; every other criterion is AND. `filter.types` may be a
    // Set or an array so this can be called from a test without building one.
    function postMatchesFilter(p, filter, displayName) {
        if (!filter) return true;
        const types = filter.types instanceof Set
            ? filter.types
            : new Set(filter.types || []);

        if (filter.fromIds && !filter.fromIds.includes(p.client_id)) return false;
        if (filter.pinned && !p.pinned) return false;
        if (filter.mentions && !mentionsMe(p.body, displayName)) return false;
        if (filter.edited && !p.edited_at) return false;
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
        esc, hueOf, avatarStyle, initials, isOnlyEmoji, mentionsMe,
        timeStr, dayStr, fmtSize, fmtDuration, splitName,
        attachmentKind, fileIcon,
        extractUrls, isImageUrl, safeHttpUrl, urlFileName, youtubeId,
        postMatchesFilter,
        FONT_SIZES, fontSizeIndex,
        matchesPttBinding,
        URL_RE
    };
}));
