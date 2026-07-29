// The release-notes parser turns whatever the GitHub feed hands electron-updater
// into the block model the release-notes modal renders.
//
// The HTML fixtures below are the REAL bodies of two shipped releases, copied
// from https://github.com/Scarmonit/scarmvoice/releases.atom — the same feed
// electron-updater reads. Guessing at the markup is how this broke before: the
// old parser stripped every tag and produced one unreadable paragraph.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMain, resetMainModules } from './helpers/load.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let parseNotes;

beforeEach(() => {
    resetMainModules();
    parseNotes = loadMain('updater.js').parseNotes;
});

// v0.6.1 — plain paragraphs, one with an inline <strong> lead-in.
const PARAGRAPHS = [
    '<p><strong>Fixed:</strong> scrolling the emoji picker closed it.</p>',
    '<p>Spinning the mouse wheel over the emoji list, or clicking its scrollbar,',
    'dismissed the whole picker instead of scrolling. Both now scroll the list and',
    'leave the picker open.</p>',
    '<p>Clicking elsewhere, pressing Esc, and picking an emoji all still close it',
    'exactly as before &#8212; and scrolling the message list still closes it.</p>'
].join('\n');

// v0.6.0 — a bold line acting as a section label, then <br>-separated bullets.
// This is how GitHub renders the notes this app actually publishes.
const SECTIONS = [
    '<p>Every icon in the app now comes from one set.</p>',
    '<p><strong>Icons</strong><br>',
    '• One icon set everywhere &#8212; buttons used to mix emoji and symbols.<br>',
    '• Emoji are content only now.<br>',
    '• New settings gear that stays legible at small sizes.</p>',
    '<p><strong>Settings &#8212; eight labelled sections</strong><br>',
    '• Account &#8212; custom status, and your avatar preview<br>',
    '• Voice &amp; Audio &#8212; microphone test meter</p>'
].join('\n');

describe('parseNotes', () => {
    it('returns nothing usable for empty input', () => {
        for (const empty of [null, undefined, '', 0, {}]) {
            expect(parseNotes(empty)).toEqual({ text: null, blocks: [] });
        }
    });

    it('turns paragraphs into paragraph blocks and drops the tags', () => {
        const { blocks } = parseNotes(PARAGRAPHS);
        expect(blocks.every((b) => b.t === 'p')).toBe(true);
        expect(blocks).toHaveLength(3);
        expect(blocks[0].text).toBe('Fixed: scrolling the emoji picker closed it.');
        expect(blocks[0].text).not.toMatch(/[<>]/);
    });

    it('decodes entities rather than leaking them into the UI', () => {
        const { blocks } = parseNotes(PARAGRAPHS);
        expect(blocks[2].text).toContain('—');          // &#8212; -> em dash
        expect(blocks[2].text).not.toContain('&#8212;');
        const amp = parseNotes(SECTIONS).blocks.map((b) => JSON.stringify(b)).join(' ');
        expect(amp).toContain('Voice & Audio');
        expect(amp).not.toContain('&amp;');
    });

    it('reads a wholly-bold line as a heading and the bullets under it as a list', () => {
        const { blocks } = parseNotes(SECTIONS);
        const shape = blocks.map((b) => b.t).join(',');
        expect(shape).toBe('p,h,ul,h,ul');

        expect(blocks[1]).toEqual({ t: 'h', text: 'Icons' });
        expect(blocks[2].items).toHaveLength(3);
        expect(blocks[2].items[1]).toBe('Emoji are content only now.');

        expect(blocks[3].text).toBe('Settings — eight labelled sections');
        expect(blocks[4].items).toEqual([
            'Account — custom status, and your avatar preview',
            'Voice & Audio — microphone test meter'
        ]);
        // The bullet character itself must not survive into the item text.
        expect(blocks[2].items.some((i) => i.startsWith('•'))).toBe(false);
    });

    it('understands real <ul>/<li> and <h2> markup too', () => {
        const { blocks } = parseNotes(
            '<h2>Fixes</h2><ul>\n<li>One thing</li>\n<li>Another <code>thing</code></li>\n</ul>');
        expect(blocks).toEqual([
            { t: 'h', text: 'Fixes' },
            { t: 'ul', items: ['One thing', 'Another thing'] }
        ]);
    });

    it('falls back to markdown when the feed hands over plain text', () => {
        const { blocks } = parseNotes('## Improvements\n- faster startup\n- less memory\n\nJust prose.');
        expect(blocks).toEqual([
            { t: 'h', text: 'Improvements' },
            { t: 'ul', items: ['faster startup', 'less memory'] },
            { t: 'p', text: 'Just prose.' }
        ]);
    });

    it('unwraps leftover markdown emphasis, code spans and links', () => {
        const { blocks } = parseNotes('- **bold** and `code` and [a link](https://example.com)');
        expect(blocks[0].items[0]).toBe('bold and code and a link');
    });

    it('sections an array of skipped releases by version', () => {
        const { blocks } = parseNotes([
            { version: '0.6.0', note: '<p>Older news.</p>' },
            { version: '0.6.1', note: '<p>Newer news.</p>' }
        ]);
        expect(blocks.map((b) => b.text)).toEqual([
            'Version 0.6.0', 'Older news.', 'Version 0.6.1', 'Newer news.'
        ]);
    });

    it('also produces flat text for the one-line status in Settings', () => {
        const { text } = parseNotes(SECTIONS);
        expect(text).toContain('Icons');
        expect(text).toContain('• Emoji are content only now.');
        expect(text).not.toMatch(/[<>]/);
    });

    it('caps runaway notes so a huge changelog cannot bloat the IPC payload', () => {
        const huge = Array.from({ length: 400 }, (_, i) => '<p>line ' + i + '</p>').join('');
        const { text, blocks } = parseNotes(huge);
        expect(blocks.length).toBeLessThanOrEqual(150);
        expect(text.length).toBeLessThanOrEqual(4000);
    });
});

// The notes this repo actually ships, read off disk.
//
// v0.56.0 was published with NO notes at all, because attaching them was a
// manual `gh release edit` that lived in nobody's script. They are a build input
// now (build/release-notes/v<version>.md, checked by the release preflight), and
// this is the other half of that: a file written in a style parseNotes cannot
// read would produce a release the app describes as one shapeless paragraph, and
// nothing else would notice.
describe('the release notes this repo ships', () => {
    const DIR = path.join(__dirname, '..', 'build', 'release-notes');
    const files = fs.existsSync(DIR)
        ? fs.readdirSync(DIR).filter((f) => f.endsWith('.md')).sort()
        : [];

    it('has notes for the version in package.json', () => {
        const version = JSON.parse(
            fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
        ).version;
        expect(files).toContain('v' + version + '.md');
    });

    it.each(files)('%s parses into headings and bullets, not one blob', (name) => {
        const raw = fs.readFileSync(path.join(DIR, name), 'utf8').replace(/\r\n/g, '\n');
        const lines = raw.split('\n');
        const title = lines.shift().trim();
        const body = lines.join('\n').trim();

        // The first line is the release NAME on GitHub, never part of the body.
        expect(title.length).toBeGreaterThan(0);
        expect(title).not.toMatch(/^[-*#]/);

        const { blocks, text } = parseNotes(body);
        // A `**bold line**` is what parseNotes reads as a section heading, and
        // `- ` lines as list items. Getting either wrong is invisible until it
        // is in front of somebody being offered an update.
        expect(blocks.some((b) => b.t === 'h')).toBe(true);
        expect(blocks.some((b) => b.t === 'ul' && b.items.length)).toBe(true);
        // Nothing may reach the renderer still wearing markup.
        expect(text).not.toMatch(/\*\*/);
        blocks.forEach((b) => {
            const strings = b.t === 'ul' ? b.items : [b.text];
            strings.forEach((s) => expect(s).not.toMatch(/[<>]/));
        });
    });
});
