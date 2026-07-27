// The renderer's pure helpers (src/renderer/lib.js).
//
// These were previously buried inside app.js's 5000-line IIFE, where nothing
// could reach them, so the renderer had no tests at all — including the
// escaping that stands between a message someone else wrote and this window.
import { describe, it, expect } from 'vitest';
import lib from '../src/renderer/lib.js';

const {
    esc, hueOf, avatarStyle, initials, isOnlyEmoji, mentionsMe,
    fmtSize, fmtDuration, splitName, dayStr,
    attachmentKind, fileIcon,
    extractUrls, isImageUrl, safeHttpUrl, urlFileName, youtubeId,
    postMatchesFilter, fontSizeIndex, FONT_SIZES, matchesPttBinding
} = lib;

describe('esc', () => {
    it('escapes every character that can break out of markup', () => {
        expect(esc('<script>')).toBe('&lt;script&gt;');
        expect(esc('a & b')).toBe('a &amp; b');
    });

    it('escapes quotes, because call sites interpolate into attributes', () => {
        // e.g. `<img src="${esc(url)}">` — an unescaped quote here is an
        // injection point, not a cosmetic issue.
        expect(esc('" onerror="alert(1)')).toBe('&quot; onerror=&quot;alert(1)');
        expect(esc("it's")).toBe('it&#39;s');
    });

    it('escapes the ampersand first so entities are not double-decoded', () => {
        expect(esc('&lt;')).toBe('&amp;lt;');
    });

    it('renders null and undefined as empty rather than the word', () => {
        expect(esc(null)).toBe('');
        expect(esc(undefined)).toBe('');
        expect(esc(0)).toBe('0');
    });
});

describe('avatars', () => {
    it('gives the same name the same hue on every machine', () => {
        expect(hueOf('Scarm')).toBe(hueOf('Scarm'));
        expect(hueOf('Scarm')).not.toBe(hueOf('Someone Else'));
    });

    it('keeps the hue in range for any input', () => {
        ['', 'a', '🎉🎉🎉', 'a very long display name indeed'].forEach((n) => {
            const h = hueOf(n);
            expect(h).toBeGreaterThanOrEqual(0);
            expect(h).toBeLessThan(360);
        });
    });

    it('produces a style string with no unescaped quotes', () => {
        // It is interpolated into a style="…" attribute.
        expect(avatarStyle('Scarm')).not.toContain('"');
    });

    it('initials one word, two words, and nothing at all', () => {
        expect(initials('Scarm')).toBe('SC');
        expect(initials('Parker Dunned')).toBe('PD');
        expect(initials('  spaced   out  ')).toBe('SO');
        expect(initials('')).toBe('?');
        expect(initials(null)).toBe('?');
    });
});

describe('isOnlyEmoji', () => {
    it('accepts a short run of emoji', () => {
        expect(isOnlyEmoji('🎉')).toBe(true);
        expect(isOnlyEmoji('🎉 🚀 🔥')).toBe(true);
    });

    it('accepts emoji with skin tones and ZWJ sequences', () => {
        expect(isOnlyEmoji('👍🏽')).toBe(true);
    });

    it('rejects anything with text in it', () => {
        expect(isOnlyEmoji('nice 🎉')).toBe(false);
        expect(isOnlyEmoji('hello')).toBe(false);
    });

    it('rejects an empty body and a wall of emoji', () => {
        expect(isOnlyEmoji('')).toBe(false);
        expect(isOnlyEmoji(null)).toBe(false);
        expect(isOnlyEmoji('🎉'.repeat(7))).toBe(false);
    });
});

describe('mentionsMe', () => {
    it('matches the display name case-insensitively', () => {
        expect(mentionsMe('hey @Scarm look', 'scarm')).toBe(true);
        expect(mentionsMe('hey @scarm', 'Scarm')).toBe(true);
    });

    it('does not match Anonymous, which would mention everyone unnamed', () => {
        expect(mentionsMe('@Anonymous hi', 'Anonymous')).toBe(false);
    });

    it('is inert when there is no display name', () => {
        expect(mentionsMe('@someone', '')).toBe(false);
        expect(mentionsMe('@someone', null)).toBe(false);
    });

    it('treats a name with regex metacharacters literally', () => {
        // A name like "a.b" must not match "axb", and "(" must not throw.
        expect(mentionsMe('@axb', 'a.b')).toBe(false);
        expect(mentionsMe('@a.b', 'a.b')).toBe(true);
        expect(() => mentionsMe('@x', 'what(')).not.toThrow();
        expect(mentionsMe('@x', 'what(')).toBe(false);
    });

    it('bounds both sides on the same character class', () => {
        // The trailing class used to allow '_' while the leading one didn't, so
        // "@alice_smith" pinged "alice" — the exact false positive the trailing
        // boundary exists to prevent.
        expect(mentionsMe('@alice_smith shipped it', 'alice')).toBe(false);
        expect(mentionsMe('mail bob@alice.com', 'alice')).toBe(false);
        expect(mentionsMe('@Alexander said so', 'Alex')).toBe(false);
        // …while the real thing still matches, including at either end.
        expect(mentionsMe('@alice', 'alice')).toBe(true);
        expect(mentionsMe('hi @alice!', 'alice')).toBe(true);
        expect(mentionsMe('@alice_smith', 'alice_smith')).toBe(true);
    });
});

describe('formatting', () => {
    it('formats sizes across the unit boundaries', () => {
        expect(fmtSize(0)).toBe('');
        expect(fmtSize(512)).toBe('512 B');
        expect(fmtSize(1024)).toBe('1.0 KB');
        expect(fmtSize(1048576)).toBe('1.0 MB');
        expect(fmtSize(25 * 1048576)).toBe('25.0 MB');
    });

    it('formats durations and rejects nonsense', () => {
        expect(fmtDuration(9)).toBe('0:09');
        expect(fmtDuration(75)).toBe('1:15');
        expect(fmtDuration(0)).toBe('');
        expect(fmtDuration(NaN)).toBe('');
        expect(fmtDuration(-5)).toBe('');
    });

    it('splits a filename so the extension survives truncation', () => {
        const { head, tail } = splitName('a-very-long-report-name.pdf');
        expect(head + tail).toBe('a-very-long-report-name.pdf');
        expect(tail).toContain('.pdf');
    });

    it('leaves an extensionless name whole', () => {
        expect(splitName('README')).toEqual({ head: 'README', tail: '' });
        expect(splitName('')).toEqual({ head: '', tail: '' });
    });

    it('labels today and yesterday relative to a supplied clock', () => {
        const noon = new Date('2026-07-25T12:00:00').getTime();
        expect(dayStr(noon, noon)).toBe('Today');
        expect(dayStr(noon - 86400000, noon)).toBe('Yesterday');
        expect(dayStr(noon - 10 * 86400000, noon)).not.toBe('Today');
    });
});

describe('attachmentKind', () => {
    it('prefers the MIME type over the extension', () => {
        // .webm is legitimately either audio or video; the uploader's type wins.
        expect(attachmentKind({ att_type: 'audio/webm', att_name: 'clip.webm' })).toBe('audio');
        expect(attachmentKind({ att_type: 'video/webm', att_name: 'clip.webm' })).toBe('video');
    });

    it('falls back to the extension when the type is generic', () => {
        expect(attachmentKind({ att_type: 'application/octet-stream', att_name: 'x.png' })).toBe('image');
        expect(attachmentKind({ att_type: '', att_name: 'song.flac' })).toBe('audio');
    });

    it('calls anything unrecognised a file', () => {
        expect(attachmentKind({ att_name: 'notes.pdf' })).toBe('file');
        expect(attachmentKind({})).toBe('file');
    });

    it('picks an icon per family and defaults for the unknown', () => {
        expect(fileIcon('a.pdf')).toBe('doc');
        expect(fileIcon('a.xlsx')).toBe('sheet');
        expect(fileIcon('a.7z')).toBe('archive');
        expect(fileIcon('a.exe')).toBe('app');
        expect(fileIcon('a.iso')).toBe('disc');
        expect(fileIcon('a.qqq')).toBe('file');
        expect(fileIcon('')).toBe('file');
    });
});

describe('urls', () => {
    it('extracts urls and trims the punctuation people type after them', () => {
        expect(extractUrls('see https://example.com/a, and more')).toEqual(['https://example.com/a']);
        expect(extractUrls('(https://example.com/x).')).toEqual(['https://example.com/x']);
    });

    it('de-duplicates and caps at three', () => {
        expect(extractUrls('https://a.com https://a.com')).toEqual(['https://a.com']);
        expect(extractUrls('https://a.com https://b.com https://c.com https://d.com')).toHaveLength(3);
    });

    it('finds nothing in text without links', () => {
        expect(extractUrls('no links here')).toEqual([]);
        expect(extractUrls(null)).toEqual([]);
    });

    it('only accepts http and https for anything handed to the shell', () => {
        // This is the guard between a message someone else wrote and
        // shell.openExternal, so the scheme is parsed, not pattern-matched.
        expect(safeHttpUrl('https://example.com')).toBe('https://example.com');
        expect(safeHttpUrl('http://example.com')).toBe('http://example.com');
        expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
        expect(safeHttpUrl('file:///C:/Windows/System32/calc.exe')).toBeNull();
        expect(safeHttpUrl('data:text/html,<script>')).toBeNull();
        expect(safeHttpUrl('not a url')).toBeNull();
        expect(safeHttpUrl('')).toBeNull();
    });

    it('recognises image urls including those with query strings', () => {
        expect(isImageUrl('https://x.com/a.png')).toBe(true);
        expect(isImageUrl('https://x.com/a.jpg?v=2')).toBe(true);
        expect(isImageUrl('https://x.com/a.html')).toBe(false);
    });

    it('names a downloaded image from its path', () => {
        expect(urlFileName('https://x.com/pics/cat.png')).toBe('cat.png');
        expect(urlFileName('https://x.com/pics/a%20cat.png')).toBe('a cat.png');
        expect(urlFileName('https://x.com/')).toBe('image');
        expect(urlFileName('nonsense')).toBe('image');
    });
});

describe('youtubeId', () => {
    it('reads every url shape YouTube uses', () => {
        const id = 'dQw4w9WgXcQ';
        expect(youtubeId(`https://www.youtube.com/watch?v=${id}`)).toBe(id);
        expect(youtubeId(`https://youtu.be/${id}`)).toBe(id);
        expect(youtubeId(`https://www.youtube.com/shorts/${id}`)).toBe(id);
        expect(youtubeId(`https://www.youtube.com/embed/${id}`)).toBe(id);
        expect(youtubeId(`https://www.youtube.com/live/${id}`)).toBe(id);
        expect(youtubeId(`https://music.youtube.com/watch?v=${id}`)).toBe(id);
    });

    it('ignores the tracking and timestamp params hanging off the end', () => {
        expect(youtubeId('https://youtu.be/dQw4w9WgXcQ?t=42&si=abc')).toBe('dQw4w9WgXcQ');
        expect(youtubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLxx')).toBe('dQw4w9WgXcQ');
    });

    it('rejects anything that is not an 11-character id on a YouTube host', () => {
        expect(youtubeId('https://example.com/watch?v=dQw4w9WgXcQ')).toBeNull();
        expect(youtubeId('https://www.youtube.com/watch?v=tooshort')).toBeNull();
        expect(youtubeId('https://www.youtube.com/')).toBeNull();
        expect(youtubeId('javascript:alert(1)')).toBeNull();
        expect(youtubeId('')).toBeNull();
    });
});

describe('postMatchesFilter', () => {
    const post = (extra) => Object.assign({
        id: 1, client_id: 'c1', body: 'hello world', created_at: 0
    }, extra);

    it('matches everything when nothing is set', () => {
        expect(postMatchesFilter(post(), {})).toBe(true);
        expect(postMatchesFilter(post(), null)).toBe(true);
    });

    it('matches text against the body and the attachment name', () => {
        expect(postMatchesFilter(post(), { text: 'WORLD' })).toBe(true);
        expect(postMatchesFilter(post({ body: '', att_name: 'report.pdf' }), { text: 'report' })).toBe(true);
        expect(postMatchesFilter(post(), { text: 'absent' })).toBe(false);
    });

    it('ANDs the non-type criteria together', () => {
        const p = post({ pinned: true, edited_at: 123 });
        expect(postMatchesFilter(p, { pinned: true, edited: true })).toBe(true);
        expect(postMatchesFilter(post({ pinned: true }), { pinned: true, edited: true })).toBe(false);
    });

    it('ORs the type criteria', () => {
        const img = post({ att_key: 'k', att_type: 'image/png', att_name: 'a.png' });
        expect(postMatchesFilter(img, { types: ['images'] })).toBe(true);
        expect(postMatchesFilter(img, { types: ['videos'] })).toBe(false);
        // images OR videos still matches the image
        expect(postMatchesFilter(img, { types: ['videos', 'images'] })).toBe(true);
    });

    it('treats a link in the body as the links type', () => {
        expect(postMatchesFilter(post({ body: 'see https://x.com' }), { types: ['links'] })).toBe(true);
        expect(postMatchesFilter(post(), { types: ['links'] })).toBe(false);
    });

    it('filters by author id', () => {
        expect(postMatchesFilter(post(), { fromIds: ['c1', 'c2'] })).toBe(true);
        expect(postMatchesFilter(post(), { fromIds: ['c9'] })).toBe(false);
    });

    it('needs the display name to filter by mention', () => {
        const p = post({ body: 'hey @scarm' });
        expect(postMatchesFilter(p, { mentions: true }, 'Scarm')).toBe(true);
        expect(postMatchesFilter(p, { mentions: true }, 'Someone')).toBe(false);
    });
});

describe('chat font size', () => {
    it('maps each key to its entry', () => {
        FONT_SIZES.forEach((f, i) => expect(fontSizeIndex(f.key)).toBe(i));
    });

    it('defaults to medium for anything unrecognised', () => {
        expect(FONT_SIZES[fontSizeIndex('nonsense')].key).toBe('medium');
        expect(FONT_SIZES[fontSizeIndex(undefined)].key).toBe('medium');
    });
});

describe('matchesPttBinding', () => {
    const key = (code, mods = {}) => Object.assign({ code }, mods);

    it('matches a plain key', () => {
        expect(matchesPttBinding(key('KeyQ'), { code: 'KeyQ' })).toBe(true);
        expect(matchesPttBinding(key('KeyW'), { code: 'KeyQ' })).toBe(false);
    });

    it('requires the modifiers the binding recorded', () => {
        // The bug this replaced: a Ctrl+Q binding also fired on a bare Q.
        const binding = { code: 'KeyQ', ctrl: true };
        expect(matchesPttBinding(key('KeyQ', { ctrlKey: true }), binding)).toBe(true);
        expect(matchesPttBinding(key('KeyQ'), binding)).toBe(false);
    });

    it('ignores modifiers the binding did not ask for', () => {
        // Holding Shift incidentally must not stop PTT working.
        expect(matchesPttBinding(key('KeyQ', { shiftKey: true }), { code: 'KeyQ' })).toBe(true);
    });

    it('lets a modifier itself be the trigger key', () => {
        // Binding PTT to Shift records shift:false, but the event reports
        // shiftKey true — requiring it both ways would never match.
        expect(matchesPttBinding(key('ShiftLeft', { shiftKey: true }), { code: 'ShiftLeft' })).toBe(true);
    });

    it('never matches a mouse binding or an empty one', () => {
        expect(matchesPttBinding(key('KeyQ'), { type: 'mouse', button: 4 })).toBe(false);
        expect(matchesPttBinding(key('KeyQ'), null)).toBe(false);
        expect(matchesPttBinding(key('KeyQ'), {})).toBe(false);
    });
});
