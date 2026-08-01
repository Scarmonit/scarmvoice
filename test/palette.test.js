// The stylesheet's own claims, checked as text.
//
// jsdom does not do layout, so the geometry in here was measured in a real
// browser against the real stylesheet and then pinned as the declarations that
// produce it. That is worth doing because every one of these is a value someone
// will reasonably want to nudge later, and each has a reason that is invisible
// from the declaration alone: the surface ramp has to stay near-neutral, the
// user card has to stay LIGHTER than the column it sits in, and an icon button
// that regains the browser's default padding puts its glyph off-centre again.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RENDERER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');

let css = '';
let dark = '';

beforeAll(() => {
    css = fs.readFileSync(path.join(RENDERER, 'styles.css'), 'utf8');
    dark = css.slice(css.indexOf(':root {'), css.indexOf('* { box-sizing'));
});

const hex = (name, block) => {
    const m = new RegExp('--' + name + ':\\s*(#[0-9a-f]{6})', 'i').exec(block);
    if (!m) throw new Error('no --' + name + ' in that block');
    const v = m[1];
    return { r: parseInt(v.slice(1, 3), 16), g: parseInt(v.slice(3, 5), 16), b: parseInt(v.slice(5, 7), 16), hex: v };
};

// Relative luminance is close enough for "is this lighter than that", and it is
// what the eye is judging when it decides a surface is raised or sunk.
const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

describe('the dark surface ramp', () => {
    const SURFACES = ['rail', 'side', 'chat', 'input', 'chat-2', 'panel', 'float', 'float-2', 'elev'];

    it('stays within a few points of neutral', () => {
        // A blue channel far above the red is what made every surface read navy
        // rather than grey. The composer was the worst of them at fifteen.
        SURFACES.forEach((name) => {
            const c = hex(name, dark);
            expect(c.b - c.r).toBeLessThanOrEqual(5);
            expect(c.b - c.r).toBeGreaterThanOrEqual(0);
            // Grey, not tinted: green tracks red too.
            expect(Math.abs(c.g - c.r)).toBeLessThanOrEqual(2);
        });
    });

    it('raises the user card out of the sidebar instead of sinking it in', () => {
        // This is the one that made the panel look dated: a card DARKER than the
        // column around it reads as a well, not as something floating.
        expect(lum(hex('panel', dark))).toBeGreaterThan(lum(hex('side', dark)));
        expect(lum(hex('side', dark))).toBeGreaterThan(lum(hex('rail', dark)));
    });

    it('separates the composer from the column with a step AND a line', () => {
        // Measured twice on two different captures and read differently each
        // time: once as "barely separates", once as ~9 points with a hairline
        // round it. The second reading is the newer one and the one that comes
        // with a border — and a step this size only works BECAUSE of the border,
        // so the two are checked together.
        const step = lum(hex('input', dark)) - lum(hex('chat', dark));
        expect(step).toBeGreaterThan(4);
        expect(step).toBeLessThanOrEqual(11);
        // --line-lo, not --line: on a surface this light a .06 hairline came out
        // eight points brighter than the reference's edge.
        expect(/\.composer-row \{[^}]*border: 1px solid var\(--line-lo\)/.test(css)).toBe(true);
    });

    it('raises a card on a floating surface too', () => {
        // The account panel's action groups. They were --panel, three points
        // DARKER than the popover they sit on, so they read as wells cut into
        // it rather than as buttons resting on it — the same inversion the user
        // panel had, one level in.
        expect(lum(hex('float-2', dark))).toBeGreaterThan(lum(hex('float', dark)));
        expect(lum(hex('elev', dark))).toBeGreaterThan(lum(hex('float-2', dark)));
    });

    it('layers the light theme too — but NOT by mirroring the dark ramp', () => {
        const light = css.slice(css.indexOf(':root[data-theme="light"]'));
        // The page still layers outside-in: rail deepest, then the sidebars, then
        // the message column. This is the part that was missing entirely — every
        // one of those was a flat white.
        expect(lum(hex('side', light))).toBeGreaterThan(lum(hex('rail', light)));
        expect(lum(hex('chat', light))).toBeGreaterThan(lum(hex('side', light)));
        // The user dock is still raised out of the sidebar it sits in.
        expect(lum(hex('panel', light))).toBeGreaterThan(lum(hex('side', light)));
        // …and the member list is its own step, which in the dark theme it is not:
        // two white columns with a hairline between them read as one sheet.
        expect(lum(hex('members', light))).toBeLessThan(lum(hex('chat', light)));
        // A CARD ON PAPER INVERTS. In the dark theme --float-2 is a step lighter
        // than --float, because there is always more room above a dark surface.
        // White is the ceiling, so a card raised on white is a tint with an edge —
        // mirroring the dark ramp here is what a naive inversion does, and it is
        // why this assertion is the opposite of the dark one on purpose.
        expect(lum(hex('float-2', light))).toBeLessThan(lum(hex('float', light)));
    });

    it('keeps pure white for the things that float, and nothing else', () => {
        const light = css.slice(css.indexOf(':root[data-theme="light"]'), css.indexOf('/* The rail pill'));
        const whites = [...light.matchAll(/(--[a-z0-9-]+):\s*#ffffff/g)].map((m) => m[1]);
        // The composer, the floating surfaces and the settings sheet are paper.
        // The PAGE — rail, sidebars, message column, member list, user dock — is
        // not, which is the whole difference between this and an inversion.
        // --on-accent is the text drawn ON the accent, not a surface.
        expect(whites.sort()).toEqual(
            ['--field', '--float', '--input', '--menu', '--on-accent', '--sheet']);
    });

    it('never uses a near-black for text', () => {
        const light = css.slice(css.indexOf(':root[data-theme="light"]'), css.indexOf('/* The rail pill'));
        ['text', 'text-strong', 'text-body', 'msg-text', 'author', 'muted', 'dim', 'meta']
            .forEach((name) => {
                // #06060a was the old --author and --text-strong: black in all but
                // name. Dark GREY starts around 0x1c.
                expect(lum(hex(name, light)), name).toBeGreaterThan(28);
            });
    });
});

// The root cause of a harsh light theme, checked directly rather than through its
// symptoms: a colour written into the rule that needed it is a colour NO theme can
// reach. Every one of these was a dark surface that stayed dark on white — the
// pinned card, the filter sheet's fields, the settings rail's selected pane, the
// slider tick marks, the two popovers' outlines.
describe('the direct-messages place', () => {
    // THE REGRESSION GUARD. #dm-panel replaces the whole right-hand side while a
    // conversation is open — its own header included — so it has to outrank the
    // channel header. When #chan-head went to 45 (to get the search dropdown over
    // the member list's resize strip) this panel was still on 40, and the symptom
    // was the last text channel's name and its channel icons sitting over a DM.
    it('puts the conversation panel above the channel header', () => {
        const dm = Number(/#dm-panel \{[\s\S]*?z-index: (\d+)/.exec(css)[1]);
        const head = Number(/#chan-head \{[^}]*z-index: (\d+)/.exec(css)[1]);
        expect(dm).toBeGreaterThan(head);
    });

    it('draws the finder as a button, not as a filter field', () => {
        // 28px of --sunk with dim left-aligned text reads as something you type
        // into; it opens a picker. Filled, 32px, centred, at full brightness.
        expect(css).toMatch(/#dm-find \{[^}]*height: 32px/);
        expect(css).toMatch(/#dm-find \{[^}]*background: var\(--input\); color: var\(--author\)/);
        expect(css).toMatch(/#dm-find \{[^}]*text-align: center/);
    });

    it('heads the conversation list the way the server sidebar heads its categories', () => {
        // Both sidebars occupy the same column and swap for each other, so two
        // different heading styles is the one comparison a person makes for free.
        const label = /\.dm-side-label \{[^}]*\}/.exec(css)[0];
        const cat = /\.cat-toggle \{[^}]*\}/.exec(css)[0];
        const size = (r) => /font-size: ([\d.]+)px/.exec(r)[1];
        expect(size(label)).toBe(size(cat));
        expect(label).not.toMatch(/text-transform: uppercase/);
    });

    it('resets the nav rows own button face', () => {
        // A <button> with no background paints the UA's, which put a light plate
        // at the top of the conversation list in the dark theme.
        expect(css).toMatch(/\.dm-nav-row \{[^}]*background: none; border: 0/);
    });

    // The UA's own button is `border: 2px outset buttonface` — a raised 3D bevel,
    // light on the top-left and PURE BLACK on the bottom-right. Two buttons out of
    // 203 were showing it, and they were the two that set a background and a radius
    // and never thought about the border. There is no way to notice that from the
    // rule you are writing, so it is reset once at the base.
    it('turns off the browser s own button bevel, once', () => {
        expect(css).toMatch(/^button \{ font-family: inherit; background: none; border: 0; \}$/m);
        // …and nothing re-enables it by asking for an outset.
        expect(css).not.toMatch(/border[^;:]*:\s*[^;]*outset/);
    });

    it('gives the picker an input that leads, and rows that are flat', () => {
        // It was a 43px field under a 17px heading, filled 24 points darker than
        // the card — a hole in the panel — over 44px bordered rows. The reference
        // makes the input the panel and the rows plain text.
        expect(css).toMatch(/\.dm-picker-card \{ width: min\(680px, 92vw\)/);
        expect(css).toMatch(/input#dm-picker-search \{[^}]*height: 70px/);
        expect(css).toMatch(/input#dm-picker-search \{[^}]*font-size: 20px/);
        expect(css).toMatch(/input#dm-picker-search \{[^}]*background: var\(--ctl-sunk\); border: 1px solid var\(--ctl-sunk-line\)/);
        expect(css).toMatch(/\.dm-pick-row \{[^}]*height: 34px/);
        expect(css).toMatch(/\.dm-pick-row \{[^}]*background: none/);
        // the list itself is no longer a well with a border round it
        expect(css).not.toMatch(/\.dm-picker-list \{[^}]*background: var\(--sunk\)/);
    });

    it('marks the row Enter would act on, and keeps the others quiet', () => {
        // Nothing said which row was live: every one measured the card's own
        // colour, so a palette that is meant to be driven from the keyboard gave
        // the keyboard nothing to aim at. The rows are muted and the cursor row
        // carries the contrast, which is the only arrangement where a highlight
        // reads as "this one".
        expect(css).toMatch(/\.dm-pick-row \{[^}]*color: var\(--muted\)/);
        expect(css).toMatch(/\.dm-pick-row:hover, \.dm-pick-row\.cursor \{ background: var\(--elev\); color: var\(--text-strong\); \}/);
    });

    it('raises the picker s own footer buttons out of the card', () => {
        // They were --input on --float: two points DARKER than the thing they sit
        // on, which is the same elevation inversion the Filters sheet's footer had.
        expect(css).toMatch(/\.dm-picker-card \.dialog-actions button \{\s*background: var\(--ctl\)/);
        // …and they are hidden until there is something to confirm.
        expect(css).toMatch(/\.dm-picker-card \.dialog-actions\[hidden\] \{ display: none; \}/);
    });

    it('lets the finder actually FIND, not only start', () => {
        // The button says "Find or start a conversation" — two verbs — and it only
        // ever did the second: there was no way to reach #general from it.
        const app = fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');
        expect(app).toMatch(/function dmPickerJumps\(q\)/);
        expect(app).toMatch(/kind: 'channel'[^}]*go: \(\) => switchChannel\(name\)/);
        expect(app).toMatch(/go: \(\) => openDm\(t\.id\)/);
        // …and not while adding people to a group, where "jump to #general" is not
        // an answer to "who else should be in this".
        expect(app).toMatch(/if \(dmPick\.mode === 'add'\) return \[\];/);
        expect(css).toMatch(/\.dm-pick-head \{/);
    });

    it('gives the full profile a view of its own, not the confirm dialog', () => {
        const app = fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');
        const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
        // It WAS openDialog({ title, message, ok: 'Close' }) — a shell whose shape
        // is title → body → Cancel/Confirm. That is a decision; a profile is a
        // thing to look at, and it showed strictly less than the side panel that
        // launched it plus an account id.
        const fn = app.slice(app.indexOf('function openProfileCard'), app.indexOf('function closeProfileCard'));
        expect(fn).not.toMatch(/openDialog\(/);
        expect(fn).toMatch(/pc-name'\)\.textContent = u\.username/);
        // Label OVER value, the way the side panel does it.
        expect(fn).toMatch(/pc-fact-k/);
        expect(fn).toMatch(/pc-fact-v/);
        // The prominent button does something, and it is not a second dismiss.
        expect(html).toContain('id="pc-message"');
        expect(fn).toMatch(/messageUser\(u\.id\)/);
        expect(html).not.toMatch(/id="profile-card"[\s\S]{0,900}>Cancel</);
        // The name is the SUBJECT of the view, not a 12px dialog title.
        expect(css).toMatch(/\.pc-name \{[^}]*font-size: 32px/);
        expect(css).toMatch(/\.pc-banner \{ height: 120px/);
    });

    it('fills every primary button with one colour', () => {
        // The app had two: .btn-primary and the Threads popover's Create are
        // --slider, while the dialog's confirm was --accent — so a filled button
        // meant blurple on one screen and teal on the next. The accent keeps
        // everything else: links, active state, the brand.
        expect(css).toMatch(/\.dialog-actions #dialog-ok \{ background: var\(--slider\)/);
        expect(css).toMatch(/\.btn-primary \{[^}]*background: var\(--slider\)/);
    });

    it('sizes the profile panel s one button like the reference s', () => {
        expect(css).toMatch(/#dm-prof-full \{[^}]*margin: auto 16px 16px[^}]*height: 40px/);
        expect(css).toMatch(/#dm-prof-full \{[^}]*color: var\(--author\)[^}]*font-size: 15px/);
    });

    it('reads the handle at full brightness, in both places it appears', () => {
        // It was --muted under the name, which turns the second half of somebody's
        // identity into a caption. --author is the token at the reference's 251.
        expect(css).toMatch(/#dm-prof-handle \{ font-size: 13px; color: var\(--author\); \}/);
        expect(css).toMatch(/\.dm-intro-handle \{[^}]*color: var\(--author\)/);
        // …and no '@' in front of it, in either.
        const app = fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');
        expect(app).not.toMatch(/dm-prof-handle'\)\.textContent = '@'/);
        expect(app).not.toMatch(/: '@' \+ who;/);
    });
});

describe('every colour goes through a token', () => {
    // Declarations, with the selector they belong to. Comments are blanked first so
    // a hex quoted in prose is never mistaken for one that paints.
    const declarations = () => {
        const blanked = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
        const out = [];
        const stack = [];
        let buf = '';
        for (const ch of blanked) {
            if (ch === '{') { stack.push(buf.trim().replace(/\s+/g, ' ')); buf = ''; }
            else if (ch === '}') { stack.pop(); buf = ''; }
            else if (ch === ';') {
                if (stack.length) out.push({ sel: stack[stack.length - 1], decl: buf.trim() });
                buf = '';
            } else buf += ch;
        }
        return out;
    };
    // A theme block is allowed literals — that is what it is for.
    const isTheme = (sel) => /^:root/.test(sel) || /^html\.(high-contrast|desat)/.test(sel);
    // …and so are the surfaces that are black in BOTH themes: video, the lightbox
    // and the share picker are dark by nature, not by palette.
    // …and the controls that sit ON one: a ✕ over somebody's banner needs a dark
    // plate whatever the theme, because what is behind it is a colour, not a
    // surface.
    const BLACK_ON_PURPOSE = /video|#stage|\.cam-|\.pick|\.yt-|\.msg-att|\.sc-|\.lb-|\.up-bar|#lightbox|\.pc-x/;

    const relLum = (hexStr) => {
        const h = hexStr.length === 4
            ? '#' + [...hexStr.slice(1)].map((c) => c + c).join('') : hexStr;
        const v = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
            .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
        return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
    };

    it('leaves no dark literal in an ordinary rule', () => {
        const offenders = declarations()
            .filter((d) => !isTheme(d.sel) && !BLACK_ON_PURPOSE.test(d.sel))
            .filter((d) => (d.decl.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g) || [])
                .some((c) => relLum(c) < 0.16))
            .map((d) => d.sel + ' :: ' + d.decl);
        expect(offenders).toEqual([]);
    });

    it('leaves no white or black WASH in an ordinary rule', () => {
        // rgba(255,255,255,…) is a lift on a dark surface and nothing at all on a
        // light one; rgba(0,0,0,…) is the same problem the other way up. Both
        // belong in a token. Text and glyphs drawn ON a coloured fill are exempt:
        // white on blurple is white in both themes.
        const TEXT_ON_FILL = /color|fill|stroke/;
        const offenders = declarations()
            .filter((d) => !isTheme(d.sel) && !BLACK_ON_PURPOSE.test(d.sel))
            .filter((d) => !TEXT_ON_FILL.test(d.decl.split(':')[0]))
            .filter((d) => /(background|box-shadow)\s*:/.test(d.decl))
            .filter((d) => /rgba?\(\s*(0,\s*0,\s*0|255,\s*255,\s*255)/.test(d.decl))
            .map((d) => d.sel + ' :: ' + d.decl);
        // The white knob on a switch and the white thumb on a slider are the two
        // things that are white in both themes BY DESIGN — they are drawn on the
        // control's own fill, exactly like text on a coloured button.
        const allowed = /switch-knob|slider-thumb|input:checked|a11y-face|acct-qr|btn-danger-solid/;
        expect(offenders.filter((o) => !allowed.test(o))).toEqual([]);
    });

    it('builds the generated avatar and banner from tokens, not literal hsl()', () => {
        // The one colour in this app that lands on every surface, and it lived in
        // JS: a 70%-saturated disc reads as friendly on a dark column and shouts on
        // a light one, and no stylesheet could say so.
        const lib = fs.readFileSync(path.join(RENDERER, 'lib.js'), 'utf8');
        expect(lib).toMatch(/var\(--av-s1,\s*70%\)/);
        expect(lib).toMatch(/var\(--av-l2,\s*52%\)/);
        expect(lib).toMatch(/var\(--banner-s,\s*32%\)/);
        const light = css.slice(css.indexOf(':root[data-theme="light"]'));
        // Softer in the light theme, which is the whole point of it being a token.
        const pct = (name, block) => Number(new RegExp('--' + name + ':\\s*(\\d+)%').exec(block)[1]);
        expect(pct('av-s1', light)).toBeLessThan(pct('av-s1', dark));
        expect(pct('banner-l', light)).toBeGreaterThan(pct('banner-l', dark));
    });
});

describe('the settings card', () => {
    const html = () => fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
    const src = () => fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');

    it('is a card on a dimmed app, not a takeover', () => {
        // Filling the window is the single thing that made this read as an older
        // program: the reference leaves the app visible around all four sides.
        const modal = /\.settings-modal \{[^}]*\}/.exec(css)[0];
        expect(modal).toMatch(/width: min\(1400px, 88vw\)/);
        expect(modal).toMatch(/border-radius: 8px/);
        expect(modal).toMatch(/border: 1px solid/);
        const sheet = /#settings \{[^}]*\}/.exec(css)[0];
        // Horizontally centred, TOP-aligned. It used to be centred both ways, but
        // this overlay starts one title bar down, so centring put 103px of margin
        // above the sheet and 72 below — see "the settings sheet, measured".
        expect(sheet).toMatch(/place-items: start center/);
        // Dimmed, NOT blurred. Measured on the reference: text behind the panel
        // is as sharp as text inside it.
        // Through --scrim, like every other overlay: a hard black at .68 over a
        // light app is a blackout rather than a dim.
        expect(sheet).toMatch(/background: var\(--scrim\)/);
        expect(dark).toMatch(/--scrim: rgba\(0, 0, 0, \.72\)/);
        expect(sheet).toMatch(/backdrop-filter: none/);
    });

    it('floats above the app rather than reusing its shades', () => {
        // The panel was the same values as the main window, so it read as the
        // same layer. It is lighter than what is behind it now.
        // Its own pair of tokens, not --chat-2 and --chat borrowed: the RELATIONSHIP
        // between those two (body raised, rail sunk) only holds in a dark theme, and
        // reusing them put the light theme's rail above its own body.
        expect(/\.settings-modal \{[^}]*background: var\(--sheet\)/.test(css)).toBe(true);
        expect(/\.set-nav \{[^}]*background: var\(--sheet-nav\)/.test(css)).toBe(true);
        expect(dark).toMatch(/--sheet:\s*var\(--chat-2\)/);
        expect(dark).toMatch(/--sheet-nav:\s*var\(--chat\)/);
        expect(lum(hex('chat-2', dark))).toBeGreaterThan(lum(hex('chat', dark)));
        // …and the light theme says the same thing with the opposite numbers.
        const light = css.slice(css.indexOf(':root[data-theme="light"]'));
        expect(lum(hex('sheet', light))).toBeGreaterThan(lum(hex('sheet-nav', light)));
    });

    it('gives the nav a column instead of a gutter', () => {
        // 194px of nav floated to the right of a 604px column left 400px of
        // nothing — the pre-redesign shape.
        expect(/\.settings-modal \{[^}]*grid-template-columns: 252px/.test(css)).toBe(true);
        expect(/\.set-nav \{[^}]*flex-direction: column/.test(css)).toBe(true);
        expect(/\.set-nav-item \{[^}]*height: 36px/.test(css)).toBe(true);
        expect(/\.set-nav-item \.ico \{[^}]*width: 18px/.test(css)).toBe(true);
        expect(/\.set-search \{[^}]*height: 40px/.test(css)).toBe(true);
    });

    it('opens the nav with who you are, and a search you can find', () => {
        expect(src()).toMatch(/me\.className = 'set-me'/);
        expect(src()).toMatch(/function paintSettingsMe\(\)/);
        // The magnifier the field had none of.
        expect(src()).toMatch(/searchWrap\.innerHTML = I\('search'\)/);
    });

    it('carries the section name in a header bar, not in the body', () => {
        expect(html()).toContain('class="set-head"');
        expect(html()).toContain('id="settings-title"');
        // The ring-and-ESC is gone; the reference has a plain x in the bar.
        expect(html()).not.toContain('set-esc');
        expect(src()).toMatch(/\$\('settings-title'\)\.textContent = h \? h\.textContent/);
        // And the body's own copy of the title is out of the way rather than
        // saying the same thing twice.
        expect(css).toMatch(/\.set-group h3 \{ position: absolute; width: 1px/);
    });

    it('centres the reading column', () => {
        expect(/\.set-group \{ max-width: 700px; margin: 0 auto; \}/.test(css)).toBe(true);
    });

    it('keeps the nav dim and the labels bright, not the reverse', () => {
        // A clickable nav item and a static field label were rendering
        // identically at the same mid-grey.
        expect(/\.set-nav-item \{[^}]*color: var\(--nav-idle\)/.test(css)).toBe(true);
        expect(lum(hex('nav-idle', dark))).toBeLessThan(lum(hex('muted', dark)));
        expect(css).toMatch(/\.settings-modal \.row > span:first-child \{[\s\S]{0,120}color: var\(--text-strong\)/);
    });

    it('draws flat rows with rules, and destructive buttons in red', () => {
        // Every group being a filled container is most of what made this
        // heavier than the reference, and the sections ran together.
        expect(css).toMatch(/\.settings-modal \.acct-card \{[\s\S]{0,160}box-shadow: 0 1px 0 var\(--line-2\)/);
        expect(css).toMatch(/\.settings-modal \.acct-card \{[\s\S]{0,80}background: none/);
        expect(css).toMatch(/\.settings-modal \.keycap\.danger \{[\s\S]{0,80}background: var\(--danger\)/);
    });
});

describe('the user panel', () => {
    it('is an inset card, not a full-bleed strip', () => {
        // The card is the DOCK: it holds the voice section and the user panel
        // on one left edge, with one border around both.
        // Two rules carry this selector; the grid-area one comes first.
        const dock = (css.match(/#user-dock \{[^}]*\}/g) || []).find((r) => r.includes('margin'));
        expect(dock).toMatch(/margin:\s*0 8px 8px/);
        expect(dock).toMatch(/border-radius:\s*8px/);
        expect(dock).toMatch(/background:\s*var\(--panel\)/);
        // 8 of margin + 1 of border + 7 of padding + the identity block's own 6
        // puts the avatar 22px from the window edge, 14px inside the card.
        const bar = (css.match(/#me-bar \{[^}]*\}/g) || []).find((r) => r.includes('padding'));
        expect(bar).toMatch(/padding:\s*7px/);
        // Flat: no fill and no gradient of its own, or the seam between the two
        // sections reads as a shade change instead of a hairline.
        expect(bar).toMatch(/background:\s*none/);
    });

    it('separates the two control groups by more than it separates a caret', () => {
        // A caret has to read as belonging to the control BEFORE it, so the gap
        // inside a pair has to stay clearly smaller than the gap between them.
        // Let these two converge and the grouping inverts.
        const between = Number(/\.me-actions \{[^}]*gap:\s*(\d+)px/.exec(css)[1]);
        const within = Number(/\.me-ctl \{[^}]*gap:\s*(\d+)px/.exec(css)[1]);
        expect(within).toBeLessThan(between);
        expect(between - within).toBeGreaterThanOrEqual(5);
    });

    it('sizes the presence dot as a 10px core inside a 3px cutout', () => {
        const rule = /\.me-presence \{[^}]*\}/.exec(css)[0];
        expect(rule).toMatch(/width:\s*16px/);
        expect(rule).toMatch(/border:\s*3px solid var\(--panel\)/);
        // The ring is punched in the CARD's colour, so it has to follow it.
        expect(rule).not.toMatch(/border:\s*3px solid #/);
    });

    it('draws its glyphs dimmer than its text, and the status line brighter than a hint', () => {
        expect(/#me-bar \.icon-btn \{[^}]*color:\s*var\(--panel-icon\)/.test(css)).toBe(true);
        expect(/\.me-status \{[^}]*color:\s*var\(--panel-sub\)/.test(css)).toBe(true);
        expect(/\.me-name \{[^}]*color:\s*var\(--panel-name\)/.test(css)).toBe(true);
        // The panel's three tones, brightest to dimmest, all below --text.
        expect(lum(hex('panel-name', dark))).toBeLessThan(lum(hex('text', dark)));
        expect(lum(hex('panel-icon', dark))).toBeLessThan(lum(hex('panel-name', dark)));
        expect(lum(hex('panel-sub', dark))).toBeLessThan(lum(hex('panel-icon', dark)));
        expect(/#composer-input::placeholder \{ color: var\(--placeholder\); \}/.test(css)).toBe(true);
    });
});

describe('icon buttons', () => {
    it('reset the browser padding that pushed every glyph off-centre', () => {
        // Buttons default to `padding: 1px 6px`. On a fixed-width button that
        // leaves a content box narrower than the glyph, and a centred item wider
        // than its area overflows to one side only — so every icon in the app
        // sat a couple of pixels right of the button it belonged to.
        const rule = /\.icon-btn \{[^}]*\}/.exec(css)[0];
        expect(rule).toMatch(/padding:\s*0/);
    });

    it('keeps every me-bar glyph inside its own button', () => {
        const btn = (sel) => Number(new RegExp(sel + '[^}]*width:\\s*(\\d+)px').exec(css)[1]);
        const caretBtn = btn('\\.me-ctl \\.me-ctl-caret \\{');
        const caretIco = Number(/#me-bar \.me-ctl-caret \.ico \{[^}]*width:\s*(\d+)px/.exec(css)[1]);
        expect(caretIco).toBeLessThanOrEqual(caretBtn);

        const mainBtn = Number(/\.me-ctl \.me-ctl-main \{[^}]*width:\s*(\d+)px/.exec(css)[1]);
        const deafenIco = Number(/#me-bar #btn-deafen \.ico \{[^}]*width:\s*(\d+)px/.exec(css)[1]);
        expect(deafenIco).toBeLessThanOrEqual(mainBtn);
    });
});

describe('the caret glyph', () => {
    it('is drawn pointing down rather than turned into place', () => {
        const icons = fs.readFileSync(path.join(RENDERER, 'icons.js'), 'utf8');
        const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
        expect(icons).toMatch(/'chevron-down':/);
        // A rotated glyph keeps its unrotated box, so the box and the ink
        // disagree about where the centre is. Both me-bar carets use the drawn
        // one — as does the server header's, which is the same mark.
        const bar = html.slice(html.indexOf('id="me-bar"'), html.indexOf('id="mic-pop"'));
        expect((bar.match(/data-icon="chevron-down"/g) || []).length).toBe(2);
        expect(/\.me-ctl \.me-ctl-caret \.ico \{[^}]*rotate/.test(css)).toBe(false);
    });

    it('nudges the way it points', () => {
        expect(/\.me-ctl-caret:hover \.ico \{ transform: translateY\(1\.5px\); \}/.test(css)).toBe(true);
    });
});

describe('hover motion', () => {
    it('gives each control its own gesture, and lets it be turned off', () => {
        expect(/#btn-settings:hover \.ico \{ transform: rotate\(90deg\); \}/.test(css)).toBe(true);
        expect(/#btn-mute:hover \.ico \{ transform: scale\(1\.15\); \}/.test(css)).toBe(true);
        expect(/@keyframes headset-wiggle/.test(css)).toBe(true);
        expect(/#btn-deafen:hover \.ico \{ animation: headset-wiggle/.test(css)).toBe(true);

        // An animation ignores `transition: none`, so reduced motion has to
        // switch it off by name or the headset shakes anyway.
        const reduced = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce) {\n  #me-bar'));
        expect(reduced).toMatch(/#btn-deafen:hover \.ico \{ animation: none; \}/);
        expect(reduced).toMatch(/\.me-ctl-caret:hover \.ico,/);
    });
});

describe('the account panel', () => {
    it('raises its action groups instead of sinking them', () => {
        expect(/\.mep-menu \{[^}]*background:\s*var\(--float-2\)/.test(css)).toBe(true);
        expect(/\.mep-bubble \{[^}]*background:\s*var\(--float-2\)/.test(css)).toBe(true);
    });

    it('has no stroke around it', () => {
        // The old one was lighter than the fill, which draws an outline. The
        // reference has only a shadow, and its edge is darker than its fill.
        const rule = /\.me-pop \{[^}]*\}/.exec(css)[0];
        expect(rule).toMatch(/border:\s*0/);
        expect(rule).toMatch(/box-shadow:/);
    });

    it('gives its rows room to breathe', () => {
        // ~34px before, against the reference's ~49. Everything else about the
        // rows already matched; it was purely vertical.
        expect(/\.mep-item \{[^}]*height:\s*48px/.test(css)).toBe(true);
        // The card has no padding of its own, so the divider inside it spans
        // the full width and the rows clip into its corners.
        const menu = /\.mep-menu \{[^}]*\}/.exec(css)[0];
        expect(menu).not.toMatch(/padding:/);
        expect(menu).toMatch(/overflow:\s*hidden/);
    });

    it('matches the row labels to the icons beside them', () => {
        // Was --text-body against --muted icons, so a label and its own icon
        // looked like two different things.
        expect(/\.mep-item \{[^}]*color:\s*var\(--muted\)/.test(css)).toBe(true);
        expect(/\.mep-item \.ico \{[^}]*color:\s*var\(--muted\)/.test(css)).toBe(true);
    });

    it('drops the persistent highlight behind the identity block', () => {
        // .me-id is flex:1, so a plate behind it runs the full width and the
        // user panel stops reading as one card.
        expect(/\.me-id\[aria-expanded="true"\]\s*\{/.test(css)).toBe(false);
    });

    it('is laid out as cards, in the reference is order', () => {
        const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
        const pop = html.slice(html.indexOf('id="me-popover"'), html.indexOf('<main id="main">'));
        const groups = pop.split('class="mep-menu"').slice(1);
        // Two standing cards, plus a third that only exists during a call and
        // holds the single row that leaves it.
        expect(groups.length).toBe(3);
        // Two rows each, split by a divider inside the card — the gap between
        // the CARDS is what separates the groups. The voice card is the
        // exception: one row, nothing to divide it from.
        groups.slice(0, 2).forEach((g) => {
            expect((g.match(/class="mep-item/g) || []).length).toBeGreaterThanOrEqual(2);
            expect(g).toContain('mep-sep');
        });
        const order = [...pop.matchAll(/id="(mep-edit|mep-status|mep-switch|mep-copy-id)"/g)].map((m) => m[1]);
        expect(order).toEqual(['mep-edit', 'mep-status', 'mep-switch', 'mep-copy-id']);
    });

    it('sizes the banner, avatar and dot the way the reference does', () => {
        expect(/\.mep-banner \{ height: 105px/.test(css)).toBe(true);
        const wrap = /\.mep-av-wrap \{[^}]*\}/.exec(css)[0];
        expect(wrap).toMatch(/width:\s*92px/);
        expect(wrap).toMatch(/border:\s*6px/);      // 92 - 2x6 = an 80px picture
        const dot = /\.mep-presence \{[^}]*\}/.exec(css)[0];
        expect(dot).toMatch(/width:\s*26px/);
        expect(dot).toMatch(/border:\s*5px solid var\(--float\)/);   // 26 - 2x5 = a 16px core
    });

    it('shows the bare username, near-white', () => {
        const src = fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');
        // No sigil: there is nothing else on that line for it to distinguish.
        expect(src).toMatch(/mep-handle'\)\.textContent = account \? account\.username/);
        expect(/\.mep-handle \{[^}]*color:\s*var\(--text-strong\)/.test(css)).toBe(true);
    });

    it('offers the custom status where the reference offers it', () => {
        const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
        // A button, not a div: it is the only place in the app that field is
        // ever offered, and it has to be reachable empty.
        expect(html).toMatch(/<button type="button" class="mep-bubble" id="mep-custom">/);
        // The tail is what makes it read as something the person said.
        expect(css).toMatch(/\.mep-bubble::before,\s*\.mep-bubble::after/);
    });

    it('draws the banner flat rather than as a two-stop sweep', () => {
        const lib = fs.readFileSync(path.join(RENDERER, 'lib.js'), 'utf8');
        expect(lib).toMatch(/function bannerStyle/);
        const fn = lib.slice(lib.indexOf('function bannerStyle'));
        expect(fn.slice(0, fn.indexOf('\n    }'))).not.toMatch(/gradient/);
        const src = fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');
        expect(src).toMatch(/mep-banner'\)\.setAttribute\('style', bannerStyle\(name\)\)/);
    });
});

describe('the user dock', () => {
    it('holds the voice section and the user panel in one container', () => {
        const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
        const dock = html.slice(html.indexOf('id="user-dock"'), html.indexOf('id="mic-pop"'));
        // Both inside it, and neither inside the sidebar — which is what puts
        // them on the same left edge. The sidebar starts 72px further right
        // than the dock does, so a voice panel living there floated on its own
        // margin above the panel it belongs to.
        expect(dock).toContain('id="voice-panel"');
        expect(dock).toContain('id="me-bar"');
        const aside = html.slice(html.indexOf('<aside id="sidebar">'), html.indexOf('id="user-dock"'));
        expect(aside).not.toContain('id="voice-panel"');
        expect(aside).not.toContain('id="me-bar"');
    });

    it('draws one border around both, and a hairline between them', () => {
        const dock = (css.match(/#user-dock \{[^}]*\}/g) || []).find((r) => r.includes('margin'));
        // A fainter edge than a general hairline — measured off the live panel
        // at four percent, where --line is six.
        expect(dock).toMatch(/border:\s*1px solid rgba\(153, 153, 153, \.04\)/);
        // Positioned, because the soundboard tray clears the WHOLE card.
        expect(dock).toMatch(/position:\s*relative/);
        const at = css.indexOf('#voice-panel:has');
        const voice = css.slice(at, css.indexOf('}', at) + 1);
        expect(voice).toMatch(/box-shadow:\s*0 1px 0 var\(--line\)/);
        // No card of its own any more: no margin, no radius, no fill.
        expect(voice).not.toMatch(/margin:/);
        expect(voice).not.toMatch(/border-radius:/);
        expect(voice).not.toMatch(/background:/);
        expect(/\.soundboard \{[^}]*left:\s*0;\s*right:\s*0/.test(css)).toBe(true);
    });

    it('gives the action row buttons a surface to be', () => {
        // They were --input on a --panel card: one point apart, which is to say
        // invisible. The row read as loose glyphs floating on the card.
        const rule = /\.btn-share \{[^}]*\}/.exec(css)[0];
        expect(rule).toMatch(/background:\s*var\(--float-2\)/);
        expect(rule).toMatch(/color:\s*var\(--text-strong\)/);
        expect(lum(hex('float-2', dark))).toBeGreaterThan(lum(hex('panel', dark)));
    });

    it('says where you are, not just that you are somewhere', () => {
        const src = fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');
        // Read off the sidebar's own labels, so the two cannot disagree.
        expect(src).toMatch(/vl-where'\)\.textContent =/);
        expect(src).toMatch(/#btn-join-voice \.vchan-name/);
        expect(src).toMatch(/#server-head \.sh-name/);
    });

    it('does not paint a chosen mute the colour of a healthy connection', () => {
        const src = fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');
        expect(src).toMatch(/vl-status'\)\.classList\.toggle\('warn', !!\(st\.muted \|\| st\.deafened\)\)/);
        expect(css).toMatch(/\.vl-status\.warn[^}]*color:\s*var\(--idle\)/);
        expect(/#vl-label \{[^}]*color:\s*var\(--voice-ok\)/.test(css)).toBe(true);
    });

    it('offers both header controls, including the way out', () => {
        const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
        const live = html.slice(html.indexOf('id="voice-live"'), html.indexOf('class="vp-actions"'));
        expect((live.match(/class="btn-vl/g) || []).length).toBe(2);
        expect(live).toContain('id="btn-leave-voice"');
        // The hang-up is the handset turned down, NOT the slashed one — slashing
        // it as well made it read as an eye with a line through it.
        expect(live).toContain('data-icon="phone-hangup"');
        const icons = fs.readFileSync(path.join(RENDERER, 'icons.js'), 'utf8');
        const g = icons.slice(icons.indexOf("'phone-hangup':"));
        expect(g.slice(0, g.indexOf("',\n"))).not.toMatch(/M3\.6 20\.4/);
    });
});

describe('the muted and deafened controls', () => {
    it('put a plate under both halves of the pair, and none under the cog', () => {
        // A red glyph alone reads as "that icon happens to be red". A plate
        // under it reads as a control switched on — and the cog staying plain is
        // what makes the plates mean "toggled" rather than "these are buttons".
        const on = /#me-bar \.me-ctl:has\(\.me-ctl-main\[aria-pressed="true"\]\) \.icon-btn \{[^}]*\}/.exec(css)[0];
        expect(on).toMatch(/background:\s*var\(--danger-plate\)/);
        expect(on).toMatch(/color:\s*var\(--danger-lo\)/);
        // Scoped to .me-ctl, which the cog is not inside.
        expect(css).not.toMatch(/#btn-settings[^{]*\{[^}]*--danger-plate/);
    });

    it('draws them in a red that can sit on that plate', () => {
        // A full-strength alert red on a red ground vibrates.
        expect(lum(hex('danger-lo', dark))).toBeLessThan(lum(hex('danger', dark)));
        // A tint, not a second surface — measured off the live panel at .12.
        const plate = /--danger-plate:\s*rgba\((\d+), (\d+), (\d+), \.(\d+)\)/.exec(css);
        expect(Number('0.' + plate[4])).toBeLessThanOrEqual(0.15);
        expect(Number(plate[1])).toBeGreaterThan(Number(plate[2]));
    });

    it('gives the mic and the headset the same ink to fill', () => {
        // Drawn tall and narrow, the mic measured 17% smaller than the headset
        // beside it even though their boxes matched. Same box AND same glyph
        // proportions is what makes the pair look like a pair.
        const w = (id) => {
            const at = css.indexOf('#me-bar #' + id + ' .ico {');
            return Number(/width:\s*(\d+)px/.exec(css.slice(at, css.indexOf('}', at)))[1]);
        };
        expect(w('btn-mute')).toBe(w('btn-deafen'));
        const icons = fs.readFileSync(path.join(RENDERER, 'icons.js'), 'utf8');
        // The stand arc spans the same 16 units the headset's band does.
        expect(icons).toMatch(/mic: '<rect[^']*'\s*\+\s*\n\s*'<path d="M4 11a8 8 0 0 0 16 0"/);
    });
});

describe('text rendering', () => {
    it('is switched to grayscale antialiasing at the process level', () => {
        // -webkit-font-smoothing is a no-op on Windows in Chromium, so the CSS
        // that has always been on <body> never did anything: subpixel rendering
        // fringed every glyph edge with colour. The switch is the only lever.
        const main = fs.readFileSync(path.join(RENDERER, '..', 'main', 'main.js'), 'utf8');
        expect(main).toMatch(/appendSwitch\('disable-lcd-text'\)/);
    });
});

describe('the status line', () => {
    it('reports the call when you are in one', () => {
        const src = fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');
        // "Online" is true of everyone reading it. Being in voice is the fact
        // worth the line.
        expect(src).toMatch(/const text = voiceNow \? 'In voice'/);
        expect(src).toMatch(/\.ms-voice'\)\.toggleAttribute\('hidden', !voiceNow\)/);
        // And it has to follow joining and leaving, not only settings changes.
        // Same handler block, wherever renderMe ends up inside it.
        const st = src.slice(src.indexOf("$('btn-soundboard').hidden = !st.joined;"));
        expect(st.slice(0, st.indexOf('closeSoundboard()'))).toMatch(/renderMe\(\);/);
        expect(/#me-bar \.ms-voice \{[^}]*color:\s*var\(--voice-ok\)/.test(css)).toBe(true);
    });
});

describe('the voice panel controls', () => {
    const html = () => fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
    const src = () => fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');

    it('names every one of them on hover, and none of them by title', () => {
        const live = html().slice(html().indexOf('id="voice-live"'), html().indexOf('id="soundboard"'));
        const tip = (id) => new RegExp('id="' + id + '"[^>]*data-tip="([^"]+)"').exec(live);
        expect(tip('btn-soundboard')[1]).toBe('Soundboard');
        expect(tip('btn-leave-voice')[1]).toBe('Disconnect');
        expect(tip('btn-cam')[1]).toBe('Turn On Camera');
        expect(tip('btn-share')[1]).toBe('Share Your Screen');
        // `title` would draw the OS bubble on top of the themed one.
        ['btn-soundboard', 'btn-leave-voice', 'btn-cam', 'btn-share'].forEach((id) => {
            expect(new RegExp('id="' + id + '"[^>]*title=').test(live)).toBe(false);
        });
    });

    it('flips the two that toggle, through the one helper', () => {
        // setTip writes data-tip AND aria-label, so a pointer and a screen
        // reader can never be told different things about the same button.
        expect(src()).toMatch(/setTip\(\$\('btn-share'\), st\.sharing \? 'Stop Sharing Your Screen' : 'Share Your Screen'\)/);
        expect(src()).toMatch(/setTip\(\$\('btn-cam'\), st\.cam \? 'Turn Off Camera' : 'Turn On Camera'\)/);
    });

    it('runs one animation without hover, and only one', () => {
        // The signal bars, because there the motion IS the information: moving
        // means connected. Everything else is gated on :hover, which is what
        // stops the panel being a permanent fidget in the corner of the eye.
        // Every rule that starts a vp- loop, paired with the selector it is
        // written under — walked back from the declaration to the { above it.
        const loops = [];
        let at = css.indexOf('animation: vp-');
        while (at > -1) {
            const open = css.lastIndexOf('{', at);
            const prev = css.lastIndexOf('}', open);
            loops.push(css.slice(prev + 1, open).replace(/\/\*[\s\S]*?\*\//g, '').trim());
            at = css.indexOf('animation: vp-', at + 1);
        }
        expect(loops.length).toBeGreaterThan(3);
        const ambient = loops.filter((sel) => !/:hover|\.on\b/.test(sel));
        expect(ambient).toEqual(['#voice-live .vl-signal rect']);
        // …and they stop when the state stops being "all well".
        expect(css).toMatch(/\.vl-status\.warn \.vl-signal rect \{ animation: none; \}/);
    });

    it('staggers the two that are made of bars', () => {
        // Four things pulsing together is a pulse; offset, it is a wave.
        const delays = (prefix) => [...css.matchAll(/animation-delay: (\d+)ms/g)]
            .filter((m) => css.lastIndexOf(prefix, m.index) > css.lastIndexOf('}', m.index))
            .map((m) => Number(m[1]));
        expect(delays('#voice-live .vl-signal rect:nth-child')).toEqual([180, 360, 540]);
        expect(delays('#btn-soundboard:hover .wv:nth-child')).toEqual([90, 180, 270, 360]);
    });

    it('lets the camera lens lead the body', () => {
        // The 40ms is the whole effect. Without it both parts move as one flat
        // shape and nothing has reacted to anything.
        expect(css).toMatch(/\.cam-lens \{ transition: transform [^;]*40ms; \}/);
        expect(css).toMatch(/\.cam-body \{ transition: transform [^;]*\); \}/);
        // Percentage origins need a box to resolve against, or every one of
        // these scales from the corner of the viewBox instead of its own centre.
        expect(css).toMatch(/transform-box: fill-box/);
    });

    it('starts the exit at the click, not at the answer', () => {
        // Leaving is a network round trip. An exit that begins when the server
        // replies is not an exit.
        const at = src().indexOf("$('btn-leave-voice').addEventListener");
        const body = src().slice(at, at + 420);
        expect(body.indexOf("classList.add('is-gone')")).toBeLessThan(body.indexOf('leaveVoice()'));
        expect(css).toMatch(/#voice-panel\.is-gone \{ opacity: 0/);
        // And rejoining has to clear it, or the panel comes back invisible.
        expect(src()).toMatch(/if \(st\.joined\) \$\('voice-panel'\)\.classList\.remove\('is-gone'\)/);
    });

    it('can be switched off entirely', () => {
        // The voice-panel block, which is no longer the last one in the sheet:
        // the reduced-motion query that mentions the signal bars.
        const Q = '@media (prefers-reduced-motion: reduce) {';
        let block = '';
        for (let at = css.indexOf(Q); at > -1; at = css.indexOf(Q, at + 1)) {
            const chunk = css.slice(at, css.indexOf('\n}', at));
            if (chunk.includes('vl-signal rect')) { block = chunk; break; }
        }
        expect(block).toBeTruthy();
        ['vl-signal rect', 'btn-soundboard:hover .wv', 'cam-rec', 'mon-arrow', 'mon-frame']
            .forEach((sel) => expect(block).toContain(sel));
        expect(block).toMatch(/animation: none/);
        expect(block).toMatch(/transition: none/);
    });
});

describe('the latency readout', () => {
    const voice = () => fs.readFileSync(path.join(RENDERER, 'voice.js'), 'utf8');
    const src = () => fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');

    it('reads the number the transport measured, not one of our own', () => {
        // The STUN check on the candidate pair the connection actually settled
        // on IS the latency to the server. An application-level ping over a
        // different socket would be a different number about a different path.
        const fn = voice().slice(voice().indexOf('async function sampleConnection()'));
        const body = fn.slice(0, fn.indexOf('\n    }'));
        expect(body).toMatch(/currentRoundTripTime/);
        // The live pair, named by the transport — not just any succeeded one.
        expect(body).toMatch(/selectedCandidatePairId/);
        // RTCP's estimate only as the fallback, for the window before the first
        // STUN check lands.
        expect(body.indexOf('currentRoundTripTime')).toBeLessThan(body.indexOf('remote-inbound-rtp'));
        // Seconds in, milliseconds out.
        expect(body).toMatch(/Math\.round\(rtt \* 1000\)/);
    });

    it('returns nothing rather than a guess', () => {
        const fn = voice().slice(voice().indexOf('async function sampleConnection()'));
        const body = fn.slice(0, fn.indexOf('\n    }'));
        // Every field starts null and only a measurement fills it.
        expect(body).toMatch(/rtt: null,/);
        expect(body).toMatch(/lossPct: null,/);
        // And the panel says so in words instead of drawing a number.
        expect(src()).toMatch(/'Measuring latency…'/);
    });

    it('samples only while the call is up', () => {
        // A timer left running against closed peer connections is a leak that
        // reports a stale number forever.
        //
        // Matched over the whole join, not on adjacency to `joined = true`: the
        // post-join work was reordered so the UI is told it is connected before
        // any of the tuning runs, and startRtt() moved with it. What matters is
        // that joining starts it and leaving stops it, which is what these two
        // assert.
        const joinBody = voice().slice(voice().indexOf('async function join()'),
            voice().indexOf('// Point the SDK at the microphone'));
        expect(joinBody).toMatch(/joined = true;/);
        expect(joinBody).toMatch(/startRtt\(\);/);
        expect(voice()).toMatch(/SHARE_GEN\+\+;\s*\n\s*stopRtt\(\);/);
        expect(voice()).toMatch(/function stopRtt\(\) \{[^}]*rttMs = null;/);
        expect(voice()).toMatch(/rtt: rttMs,/);
    });

    it('repaints only when the displayed value would change', () => {
        // It is a running average inside the transport already, so a push on
        // every tick would repaint the panel for a millisecond nobody can see.
        const at = voice().indexOf('function startRtt()');
        const body = voice().slice(at, at + 700);
        expect(body).toMatch(/Math\.abs\(v - rttMs\) >= 3/);
        expect(body).toMatch(/if \(changed\) pushState\(\)/);
    });

    it('reads the freshest sample under the pointer', () => {
        // The state push is up to three seconds old; a listener on the element
        // runs in the target phase, before the document-level one reads the
        // attribute.
        expect(src()).toMatch(/\$\('vl-signal'\)\.addEventListener\('pointerover'/);
        expect(src()).toMatch(/if \(voice && voice\.rtt\) paintSignal\(voice\.rtt\(\)\)/);
        expect(voice()).toMatch(/rtt: \(\) => rttMs,/);
    });

    it('lights the bars from the same number', () => {
        const fn = src().slice(src().indexOf('function signalBars('));
        const body = fn.slice(0, fn.indexOf('\n    }'));
        // Unmeasured is not drawn as poor: before the first sample there is no
        // evidence either way, and the tooltip says so.
        expect(body).toMatch(/if \(rtt === null \|\| rtt === undefined\) return 4;/);
        [[100, 4], [200, 3], [400, 2]].forEach(([ms, bars]) => {
            expect(body).toContain('if (rtt <= ' + ms + ') return ' + bars + ';');
        });
        // And the ones above the measured quality go dark.
        [1, 2, 3].forEach((n) => {
            expect(css).toContain('.vl-signal[data-bars="' + n + '"] rect:nth-child(n+' + (n + 1) + ')');
        });
    });
});

describe('the rail and the channel list', () => {
    const html = () => fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
    const src = () => fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');

    it('divides the rail from the list with a line, not with a shade', () => {
        // Three points of shade was more separation than the reference uses, and
        // it made the rail read as a different surface rather than as the left
        // end of the same one.
        const rail = (css.match(/#rail \{[^}]*\}/g) || []).find((r) => r.includes('background'));
        expect(rail).toMatch(/background:\s*var\(--side\)/);
        expect(rail).toMatch(/box-shadow:\s*inset -1px 0 0 var\(--line\)/);
    });

    it('marks the active server with a bright pill on the edge', () => {
        // An underline under the avatar in --line-2 was nearly invisible. This
        // is the one mark that says where you are in a column of round icons:
        // it has to be white and it has to be on the edge.
        const rule = /\.rail-server::before \{[^}]*\}/.exec(css)[0];
        expect(rule).toMatch(/width:\s*5px/);
        expect(rule).toMatch(/background:\s*var\(--text-strong\)/);
        expect(rule).toMatch(/left:\s*-12px/);
        // Taller than the hover stub, whatever the exact figure.
        const on = Number(/\.rail-server\.active::before \{[^}]*height:\s*(\d+)px/.exec(css)[1]);
        const hover = Number(/\.rail-server:hover::before \{[^}]*height:\s*(\d+)px/.exec(css)[1]);
        expect(on).toBeGreaterThan(hover);
    });

    it('makes the server name a way in rather than a caption', () => {
        const head = html().slice(html().indexOf('<header id="server-head">'), html().indexOf('side-scroll'));
        expect(head).toContain('id="server-menu"');
        expect(head).toContain('aria-haspopup="menu"');
        expect(head).toContain('data-icon="chevron-down"');
        expect(head).toContain('id="btn-invite"');
        // One line: the host moved to the header's own tooltip, where it answers
        // "which server is this" without spending a line on it.
        expect(head).not.toContain('sh-host');
        expect(src()).toMatch(/server-menu'\)\.setAttribute\('data-tip', serverHost\(\)\)/);
        // A chevron has to open something.
        expect(src()).toMatch(/\$\('server-menu'\)\.addEventListener\('click'/);
        expect(src()).toMatch(/\$\('btn-invite'\)\.addEventListener\('click', copyServerLink\)/);
    });

    it('titles its categories rather than shouting them', () => {
        // All-caps categories are the pre-redesign pattern — the same era
        // mismatch the settings screen had.
        const rule = /\.cat-toggle \{[^}]*\}/.exec(css)[0];
        expect(rule).not.toMatch(/text-transform:\s*uppercase/);
        expect(Number(/font-size:\s*([\d.]+)px/.exec(rule)[1])).toBeGreaterThanOrEqual(13);
        // And the arrow follows the label, pointing at what it opens.
        const cats = html().match(/<button type="button" class="cat-toggle"[\s\S]*?<\/button>/g);
        expect(cats.length).toBe(3);
        cats.forEach((c) => expect(c.indexOf('cat-arrow')).toBeGreaterThan(c.indexOf('<span>')));
        expect(css).toMatch(/\.side-section\.collapsed \.cat-arrow \{ transform: rotate\(-90deg\); \}/);
    });

    it('brightens the hash with the label it belongs to', () => {
        // Leaving it grey while the name went white made the two look like they
        // belonged to different rows.
        expect(css).toMatch(/\.chan\.active \.hash \{ color: var\(--text-strong\); \}/);
        expect(Number(/\.chan \.hash \{[^}]*font-size:\s*(\d+)px/.exec(css)[1])).toBeGreaterThanOrEqual(22);
        expect(css).toMatch(/\.chan\.active \{ background: var\(--chan-active\)/);
        expect(/\.chan \{[^}]*height:\s*32px/.test(css)).toBe(true);
    });

    it('puts the row s own controls on the row you are on', () => {
        // A column of these on every channel is noise; the reference shows them
        // on the active row and under the pointer.
        expect(css).toMatch(/\.chan\.active \.chan-acts, \.chan:hover \.chan-acts \{ display: flex; \}/);
        // Not <button>s: a button cannot contain buttons, and the inner click
        // would never reach the right handler.
        expect(src()).toMatch(/class="chan-act" role="button"/);
        expect(src()).toMatch(/function openChannelMenu\(name, x, y\)/);
    });

    it('counts heads until you join, then times the call', () => {
        expect(src()).toMatch(/function paintCallTimer\(\)/);
        // Started from the JOINED state, not from the click: the number has to
        // be the length of the call, not of the wait for it.
        expect(src()).toMatch(/setCallRunning\(!!inCall\)/);
        expect(src()).toMatch(/\$\('voice-count'\)\.hidden = !!inCall;/);
        expect(src()).toMatch(/\$\('voice-timer'\)\.hidden = !inCall;/);
        // And the interval is cleared, or it ticks against a call that ended.
        expect(src()).toMatch(/clearInterval\(callTimer\)/);
    });

    it('renders a voice roster as secondary to the channel above it', () => {
        // At full brightness these were the loudest thing in the sidebar, which
        // put the eye on the roster instead of on the channel list.
        expect(css).toMatch(/\.vp\.vu \.vp-name \{[^}]*color:\s*var\(--dim\)/);
        expect(css).toMatch(/\.vp\.vu \.av \{[^}]*width:\s*24px/);
        // Muted and deafened are two states and someone can be in both.
        expect(src()).toMatch(/title="Muted">' \+ I\('mic-off'\)/);
        expect(src()).toMatch(/title="Deafened">' \+ I\('headset-off'\)/);
        // No "(you)": the roster is short and your own avatar is in it.
        expect(src()).not.toMatch(/vp-name">\$\{esc\(p\.name\)\}\$\{isMe \? ' \(you\)'/);
    });

    it('sizes the voice panel buttons rather than stretching them', () => {
        // Two features spread across the whole card read as a different
        // component; the reference's own width is what makes them read as its.
        expect(css).toMatch(/\.btn-share \{[^}]*flex:\s*0 1 78px/);
        const live = html().slice(html().indexOf('class="vp-actions"'), html().indexOf('id="soundboard"'));
        // Four: camera, screen, noise suppression, push to talk. All four are
        // things you change DURING a call and none duplicates another control.
        expect((live.match(/class="btn-share"/g) || []).length).toBe(4);
        expect(live).toContain('id="btn-nsai"');
        expect(live).toContain('id="btn-ptt"');
    });
});

describe('panes are divided by a line, not by a darker neighbour', () => {
    it('puts the member list on the chat surface with a hairline between', () => {
        // The third place this pattern showed up — the rail and the account
        // panel's row cards were the other two. Making the neighbour darker is
        // more separation than the reference uses, and it leaves no visible edge.
        // Two rules carry this selector; the grid-area one comes first.
        const rule = (css.match(/#members-panel \{[^}]*\}/g) || []).find((r) => r.includes('background'));
        // Through --members, which IS --chat in the dark theme — the light theme
        // needs a step here that the dark theme must not have.
        expect(rule).toMatch(/background:\s*var\(--members\)/);
        expect(dark).toMatch(/--members:\s*var\(--chat\)/);
        expect(rule).toMatch(/box-shadow:\s*inset 1px 0 0 var\(--line\)/);
    });

    it('draws the channel header s rule lighter than the surface', () => {
        expect(/#chan-head \{[^}]*box-shadow:\s*0 1px 0 var\(--line\)/.test(css)).toBe(true);
    });
});

describe('the channel header', () => {
    const html = () => fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');

    it('groups every action before the search field', () => {
        const acts = html().slice(html().indexOf('class="chan-actions"'), html().indexOf('id="search-pop"'));
        const ids = [...acts.matchAll(/id="(btn-[a-z-]+)"/g)].map((m) => m[1]);
        // The field itself is no longer one of them: it is an input, and the
        // only button inside it is the one that clears it.
        // Threads first, then the bell, then pins, then members — the
        // reference's order, and it reads outward from "this conversation" to
        // "this channel" to "these people".
        expect(ids).toEqual(['btn-threads', 'btn-chan-alerts', 'btn-pinned', 'btn-members']);
        expect(acts).toContain('id="search-input"');
        // Reshaping a channel is not a header action: it lives on the channel,
        // in the menu the row and the right-click both open.
        expect(acts).not.toContain('btn-rename-channel');
        expect(acts).not.toContain('btn-delete-channel');
    });

    it('marks the active toggle by going white, not by adding a plate', () => {
        // A tint plus a pill said "toggled" twice, in a colour that means
        // something else everywhere else in the app.
        expect(css).toMatch(/#chan-head \.ch-btn\.on \{ background: none; color: var\(--text-strong\); \}/);
        expect(css).toMatch(/\.ch-btn \{[^}]*color:\s*var\(--ch-icon\)/);
        expect(lum(hex('ch-icon', dark))).toBeLessThan(lum(hex('muted', dark)));
    });

    it('sinks the search field and trails its magnifier', () => {
        const rule = /\.ch-search \{[^}]*\}/.exec(css)[0];
        expect(rule).toMatch(/width:\s*244px/);
        expect(rule).toMatch(/background:\s*var\(--sunk\)/);
        expect(rule).toMatch(/border:\s*1px solid/);
        // Sunk means DARKER than the surface it is cut into.
        expect(lum(hex('sunk', dark))).toBeLessThan(lum(hex('chat', dark)));
        // The glyph is last in the markup and pushed right, so the field reads
        // as a sentence you finish rather than a button you press.
        const at = html().indexOf('id="search-box"');
        const search = html().slice(at, html().indexOf('</div>', at));
        expect(search.indexOf('ch-search-text')).toBeLessThan(search.indexOf('data-icon="search"'));
        expect(css).toMatch(/\.ch-search-ico \{[^}]*margin-left:\s*auto/);
    });
});

describe('an empty channel', () => {
    const src = () => fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');

    it('reads as the start of something rather than as an empty pane', () => {
        expect(src()).toMatch(/e\.className = 'chan-intro'/);
        expect(src()).toMatch(/Welcome to #\$\{esc\(channel\)\}!/);
        expect(src()).toMatch(/This is the start of the #\$\{esc\(channel\)\} channel\./);
        // Only offered to somebody who can act on it.
        // Renaming is admin-and-above, checked through the capability table that
        // mirrors the server's — not a bare role comparison.
        expect(src()).toMatch(/if \(can\('channel\.rename'\)\) \{[\s\S]{0,300}Edit Channel/);
        // Left-aligned: it is the top of a history, not a centred notice.
        expect(css).not.toMatch(/\.chan-intro \{[^}]*text-align:\s*center/);
    });

    it('sits at the bottom without breaking the scroller', () => {
        // An auto margin, NOT justify-content: flex-end — in a scroller that
        // overflows, Chromium strands the first items above the scroll origin
        // where nothing can reach them. An auto margin resolves to zero as soon
        // as there is no free space.
        expect(css).toMatch(/#messages > :first-child \{ margin-top: auto; \}/);
        const box = /#messages \{[^}]*\}/.exec(css)[0];
        expect(box).toMatch(/display: flex; flex-direction: column;/);
        expect(box).not.toMatch(/justify-content/);
    });
});

describe('the composer and the member list', () => {
    const src = () => fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');
    const html = () => fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');

    it('gives the composer an edge and some height', () => {
        expect(css).toMatch(/\.composer-row \{[^}]*min-height:\s*58px/);
        expect(css).toMatch(/#composer \{ flex: 0 0 auto; padding: 0 8px 8px; \}/);
        // One fill, not two: the sheen put a visible band across the top third.
        expect(/\.composer-row \{[^}]*background: var\(--input\);/.test(css)).toBe(true);
    });

    it('drops the panel title above a list that already has a heading', () => {
        expect(html()).not.toContain('class="mp-head"');
        expect(html()).not.toContain('id="members-count"');
        // Title Case, like the sidebar's categories.
        const g = /\.mp-group \{[^}]*\}/.exec(css)[0];
        expect(g).not.toMatch(/text-transform:\s*uppercase/);
        expect(Number(/font-size:\s*([\d.]+)px/.exec(g)[1])).toBeGreaterThanOrEqual(12);
    });

    it('stacks the voice state under the name, dimly', () => {
        // At full brightness a member list pulls the eye off the conversation;
        // and at the far right edge, "in voice" read as a decoration.
        expect(css).toMatch(/#members-list \.vp \.vp-name \{[^}]*color:\s*var\(--dim\)/);
        expect(css).toMatch(/\.vp-body \{[^}]*flex-direction: column/);
        expect(src()).toMatch(/\? 'In voice'/);
        expect(src()).not.toMatch(/vp-invoice/);
        expect(src()).not.toMatch(/esc\(r\.name\) \+ \(isMe \? ' \(you\)'/);
    });
});

describe('the window shell', () => {
    const html = () => fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
    const voice = () => fs.readFileSync(path.join(RENDERER, 'voice.js'), 'utf8');

    it('runs the channel header across the member list too', () => {
        // A header that stops at the chat column leaves the member list divided
        // from the title bar to the floor, and puts the search field a whole
        // column left of where it belongs.
        expect(css).toMatch(/"rail side head head"/);
        expect(css).toMatch(/"rail side main members"/);
        expect(css).toMatch(/#chan-head \{ grid-area: head; \}/);
        // Which is only possible with the header OUTSIDE #main.
        const main = html().slice(html().indexOf('<main id="main">'));
        expect(main.slice(0, main.indexOf('</main>'))).not.toContain('id="chan-head"');
    });

    it('keeps the title bar and the native caption buttons the same height', () => {
        // Windows draws the caption buttons over our bar. If the two disagree
        // there is a notch in the corner in whichever colour lost.
        const tb = Number(/--tb:\s*(\d+)px/.exec(css)[1]);
        const main = fs.readFileSync(path.join(RENDERER, '..', 'main', 'main.js'), 'utf8');
        const overlay = Number(/titleBarOverlay: \{[^}]*height: (\d+)/.exec(main)[1]);
        expect(overlay).toBe(tb);
        // And the same colour as the columns under it.
        expect(/titleBarOverlay: \{ color: '#131316'/.test(main)).toBe(true);
        expect(/#titlebar \{[^}]*background: var\(--side\)/.test(css)).toBe(true);
        expect(/#titlebar \{[^}]*box-shadow: 0 1px 0 var\(--line\)/.test(css)).toBe(true);

        // …AND on the theme path, which is the one that actually decides what
        // is on screen: the renderer calls app:setTheme during boot, so a stale
        // height or colour there overwrites the constructor's within
        // milliseconds of every launch and the assertions above prove nothing.
        // That is exactly what happened when the bar shrank from 38px.
        const themed = Number(/setTitleBarOverlay\(Object\.assign\(\{ height: (\d+) \}/.exec(main)[1]);
        expect(themed).toBe(tb);
        // Dark is the shade the window is BUILT with, so the two cannot
        // disagree whichever of them is edited next.
        const built = /titleBarOverlay: \{ color: '(#[0-9a-f]{6})'/i.exec(main)[1];
        expect(new RegExp("dark: \\{ color: '" + built + "'").test(main)).toBe(true);
        // Light is that theme's own --side; anything paler puts a white plate on
        // a bar that is not white.
        const lightSide = /--side:\s*(#[0-9a-f]{6})/i
            .exec(css.slice(css.indexOf(':root[data-theme="light"]')))[1];
        expect(new RegExp("light: \\{ color: '" + lightSide + "'").test(main)).toBe(true);
        // Centred name, and no wordmark competing with the sidebar's.
        expect(html()).toContain('class="tb-title"');
        expect(html()).not.toContain('class="tb-name"');
    });

    it('draws the last inverted divider the right way round', () => {
        // The rail and the member list were fixed in earlier rounds; the server
        // header was the one row still drawing its rule as a shadow.
        expect(/#server-head \{[^}]*box-shadow: 0 1px 0 var\(--line\)/.test(css)).toBe(true);
    });

    it('separates an active channel row from an inactive one', () => {
        // At --muted the two were close enough to flatten the distinction.
        expect(/\.chan \{[^}]*color: var\(--dim\)/.test(css)).toBe(true);
        expect(lum(hex('dim', dark))).toBeLessThan(lum(hex('muted', dark)));
        // And the header hash is a marker beside the name, not a second name —
        // --dim, measured off the reference's own (~125 against our 126). At
        // --muted (173) it sat close enough to the white name to read as one
        // phrase, which is what it looked like in every capture.
        expect(css).toMatch(/\.ch-hash \{ color: var\(--dim\)/);
        expect(lum(hex('dim', dark))).toBeLessThan(lum(hex('muted', dark)));
    });

    // A round of measurements against the reference, all leaning the same way:
    // the sidebar and the header ran 4-5% small, and the empty-channel block ran
    // large. Pinned as declarations because the numbers came from a real browser.
    it('sizes the sidebar and header type against the reference', () => {
        // 16px, not 15: the channel row measured ~5% short in both ink height and
        // width for the same string.
        expect(css).toMatch(/\.chan \{[^}]*font-size: 16px/);
        // The member name was ~15% small.
        expect(css).toMatch(/#members-list \.vp \.vp-name \{[^}]*font-size: 16px/);
        // …and the header's icons ~10%.
        expect(css).toMatch(/\.ch-btn \.ico \{ width: 22px; height: 22px; \}/);
    });

    it('sizes the empty-channel block against the reference', () => {
        // The heading was cap-27 against the reference's 23 — pure scale, now that
        // the two faces measure the same width-to-height ratio.
        expect(css).toMatch(/\.ci-title \{[^}]*font-size: 30\.5px/);
        // A SMALLER disc with a BIGGER glyph in it: 36-in-68 (0.53) against the 34-in-80
        // (0.43) it was, which is the reference's proportion.
        expect(css).toMatch(/\.ci-mark \{[^}]*width: 68px; height: 68px/);
        expect(css).toMatch(/\.ci-mark \{[^}]*font-size: 61px/);
        // Its own fill, four points above the panels layered on the column.
        expect(css).toMatch(/\.ci-mark \{[^}]*background: var\(--mark\)/);
        expect(dark).toMatch(/--mark:\s*#242428/);
    });

    it('marks the OWNER in the member list, as the reference does', () => {
        const src = fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');
        const icons = fs.readFileSync(path.join(RENDERER, 'icons.js'), 'utf8');
        expect(icons).toMatch(/crown: '<path fill="currentColor"/);
        // Gated on the ROLE, from the account directory — the only place roles
        // exist — and never on a roster row with no account behind it. The OWNER,
        // not admins: there can be several of those, and a list with three crowns
        // in it says nothing.
        expect(src).toMatch(/function crownFor\(uid\) \{\s*if \(!uid\) return '';/);
        expect(src).toMatch(/u\.role !== 'owner'\) return ''/);
        expect(src).not.toMatch(/crownFor[\s\S]{0,300}'admin'/);
        expect(css).toMatch(/\.vp-crown \{[^}]*color: var\(--crown\)/);
        // Its own token, not --idle borrowed: one is a presence colour and the
        // other is a badge.
        expect(dark).toMatch(/--crown:\s*#ecab34/);
        const light = css.slice(css.indexOf(':root[data-theme="light"]'));
        expect(lum(hex('crown', light))).toBeLessThan(lum(hex('crown', dark)));
        // The name ellipsises before the badge is pushed off the row.
        expect(css).toMatch(/\.vp-name-row \{[^}]*min-width: 0/);
    });

    it('publishes your own deafen state to your own row', () => {
        // roster() carried `muted` and not `deafened`, so the sidebar showed a
        // slashed mic and an unslashed headset whatever the user panel said.
        const at = voice().indexOf('isMe: true,');
        expect(voice().slice(at, at + 400)).toMatch(/deafened/);
    });

    it('shows nothing on the right of a member row', () => {
        // The row already says "In voice" on its second line; an icon at the far
        // edge was saying it twice.
        expect(css).toMatch(/#members-list \.vp \.vp-flag \{ display: none; \}/);
        // …but the sidebar's voice roster keeps both states, where they are the
        // only thing reporting them.
        expect(css).not.toMatch(/#voice-users[^{]*\.vp-flag \{ display: none/);
    });

    it('keeps a plain setting out of the accent colour', () => {
        // Camera and screen keep their live colours — those are states other
        // people can see. A setting is not that.
        expect(css).toMatch(/#btn-nsai\.on \{ background: var\(--float-2\); \}/);
        expect(css).toMatch(/#btn-ptt\.on \{ background: var\(--float-2\); \}/);
        expect(css).not.toMatch(/\.btn-share\.on \{ background: var\(--accent-soft\)/);
    });
});

describe('voice details', () => {
    const voice = () => fs.readFileSync(path.join(RENDERER, 'voice.js'), 'utf8');
    const src = () => fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');
    const html = () => fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');

    it('turns the status line over to say what it does', () => {
        // A line that opens something has to look like a control. Two faces on
        // one card, and the card turns.
        expect(html()).toContain('class="vl-flip"');
        expect(html()).toContain('Voice Details');
        expect(css).toMatch(/\.vl-face \{[^}]*backface-visibility: hidden/);
        expect(css).toMatch(/\.vl-status:hover \.vl-face-front[^{]*\{ transform: rotateX\(180deg\); \}/);
        // And it is a <button>, not a div with a click handler.
        expect(html()).toMatch(/<button type="button" class="vl-status"/);
    });

    it('measures everything it shows', () => {
        const fn = voice().slice(voice().indexOf('async function sampleConnection()'));
        const body = fn.slice(0, fn.indexOf('\n    }'));
        // Loss is what the FAR END reports missing of what we sent — that is
        // outbound loss. Inbound would be a different number about them.
        expect(body).toMatch(/remote-inbound-rtp[\s\S]{0,200}packetsLost/);
        expect(body).toMatch(/outbound-rtp[\s\S]{0,120}packetsSent/);
        // The route comes from the pair actually carrying media.
        expect(body).toMatch(/pair\.localCandidateId/);
        expect(body).toMatch(/pair\.remoteCandidateId/);
        expect(body).toMatch(/codecId/);
    });

    it('shows a gap where a sample failed rather than a zero', () => {
        // A failed sample is not a sample of zero, and a line drawn across the
        // hole would claim measurements nobody took.
        expect(voice()).toMatch(/rttHistory\.push\(v\)/);
        expect(src()).toMatch(/if \(v === null\) \{ flush\(\); return; \}/);
        // The average skips them too, or it drops every time one fails.
        expect(voice()).toMatch(/rttHistory\.filter\(\(v\) => v !== null\)/);
    });

    it('says unknown rather than inventing a number', () => {
        expect(src()).toMatch(/'unknown'/);
        expect(src()).toMatch(/Route unknown/);
    });

    it('does not claim end-to-end encryption it cannot provide', () => {
        // Media is DTLS-SRTP on every leg, but a call through the SFU is
        // decrypted and re-encrypted there. Copying the reference's wording
        // would be a lie about the one thing nobody can check for themselves.
        expect(src()).not.toMatch(/End-to-end encrypted/i);
        expect(src()).toMatch(/Encrypted in transit \(DTLS-SRTP\)/);
        // …and not peer-to-peer either. This app has one transport, the SFU;
        // the mesh fallback belongs to the website. The line used to be picked
        // by `peers > 1`, where `peers` counted RTCPeerConnections rather than
        // people — mediasoup opens one per direction, so it was 2 in every call
        // and everybody was told their relayed call was peer-to-peer.
        // Matched on the STRING LITERAL, not the word: the comment above the
        // line explains why the claim is wrong and has to be allowed to say so.
        expect(src()).not.toMatch(/['"`]Encrypted peer-to-peer/i);
    });

    it('grows the graph past its floor instead of clipping a spike', () => {
        // A fixed axis flattens a 400ms spike into the top edge; a free one
        // makes 20ms of jitter look like a crisis.
        expect(src()).toMatch(/const CONN_FLOOR = 100;/);
        expect(src()).toMatch(/Math\.max\(CONN_FLOOR, Math\.ceil\(Math\.max\.apply\(null, taken\) \/ 50\) \* 50\)/);
    });
});

describe('the message list', () => {
    const src = () => fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');
    const lib = () => fs.readFileSync(path.join(RENDERER, 'lib.js'), 'utf8');

    it('keeps the channel start as scrollback, not as an empty state', () => {
        // It is the top of the history, so it belongs above the first message
        // forever — not only until one arrives.
        expect(src()).toMatch(/if \(!hasMore && !active\) \{/);
        const at = src().indexOf("key: 'intro'");
        expect(at).toBeGreaterThan(-1);
        // Which means it is NOT inside the "no messages" branch any more.
        const empty = src().indexOf("key: 'empty'");
        expect(src().slice(empty, empty + 400)).not.toContain('chan-intro');
    });

    it('grows the conversation up from the composer', () => {
        // An auto margin on whatever is first. It resolves to zero the moment
        // the content overflows, which is why this is safe on a scroller where
        // justify-content: flex-end is not.
        expect(css).toMatch(/#messages > :first-child \{ margin-top: auto; \}/);
    });

    it('dates its dividers instead of naming them', () => {
        // "Today" and "Yesterday" are only true while you are reading them.
        expect(lib()).toMatch(/month: 'long', day: 'numeric', year: 'numeric'/);
        expect(lib()).not.toMatch(/out = 'Today'/);
        // Title Case, and the rule runs behind the label.
        const sep = /\.day-sep \{[^}]*\}/.exec(css)[0];
        expect(sep).not.toMatch(/text-transform: uppercase/);
        expect(sep).toMatch(/color: var\(--day-sep\)/);
        expect(lum(hex('day-sep', dark))).toBeGreaterThan(lum(hex('dim', dark)));
    });

    it('sizes message text off one value', () => {
        // Everything in the list is em against --chat-fs, so the whole list was
        // 16-22% oversized from this one number.
        expect(css).toMatch(/--chat-fs: 14px;/);
        expect(/\.msg-head \{[^}]*gap: 15px/.test(css)).toBe(true);
        // Prose sits brighter than --text-body, which is tuned for labels.
        expect(/\.msg-text \{[^}]*color: var\(--msg-text\)/.test(css)).toBe(true);
        expect(lum(hex('msg-text', dark))).toBeGreaterThan(lum(hex('text-body', dark)));
    });

    it('renders an author the way the rest of the app renders a username', () => {
        expect(/\.msg-author \{[^}]*text-transform: lowercase/.test(css)).toBe(true);
    });
});

describe('the audio menus', () => {
    const html = () => fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
    const src = () => fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');

    it('groups six items into three, and sits above the card that opened it', () => {
        const pop = /\.audio-pop \{[^}]*\}/.exec(css)[0];
        expect(pop).toMatch(/width: 222px/);
        expect(pop).toMatch(/background: var\(--menu\)/);
        // A menu opened from the user card has to read as being in FRONT of it.
        expect(lum(hex('menu', dark))).toBeGreaterThan(lum(hex('float', dark)));
        const mic = html().slice(html().indexOf('id="mic-pop"'), html().indexOf('id="spk-pop"'));
        expect((mic.match(/class="ap-sep"/g) || []).length).toBe(2);
    });

    it('has a live level meter, open only while the panel is', () => {
        // The only way to answer "is my microphone working" without leaving the
        // menu — and an open capture is not something to leave running behind a
        // closed one.
        expect(html()).toContain('id="ap-meter"');
        expect(src()).toMatch(/function startApMeter\(\)/);
        expect(src()).toMatch(/if \(popId === 'mic-pop'\) startApMeter\(\)/);
        expect(src()).toMatch(/function closeAudioPops\(\) \{[\s\S]{0,160}stopApMeter\(\)/);
        // Metered on the shared context, like the Settings one: Chromium allows
        // six, and a call already holds several.
        expect(src()).toMatch(/window\.ScarmAudio\.createMeter\(stream\)/);
    });

    it('draws the slider rather than leaving it to accent-color', () => {
        // A thumb in the fill colour has almost no contrast against the fill it
        // is sitting on; white is what makes the position readable.
        expect(css).toMatch(/::-webkit-slider-runnable-track \{[^}]*height: 4px/);
        expect(css).toMatch(/::-webkit-slider-thumb \{[^}]*background: #fff/);
        // The track is painted from --fill, so the value has to be written there.
        expect(src()).toMatch(/function paintRangeFill\(el\)/);
        expect(src()).toMatch(/setProperty\('--fill'/);
    });

    it('draws an unchecked box dark', () => {
        // Native, unchecked, on Windows it is a solid white block — which reads
        // as ON.
        const box = /\.ap-check input\[type="checkbox"\] \{[^}]*\}/.exec(css)[0];
        expect(box).toMatch(/appearance: none/);
        expect(box).toMatch(/background: var\(--sunk\)/);
        expect(box).toMatch(/width: 20px/);
    });

    it('sends Voice Settings to the pane it names', () => {
        expect(src()).toMatch(/showSettingsPane\(settingsPaneByTitle\('Voice & Audio'\)\)/);
    });

    it('draws the panel mic and headset filled', () => {
        const icons = fs.readFileSync(path.join(RENDERER, 'icons.js'), 'utf8');
        ['mic-solid', 'headset-solid'].forEach((n) => {
            expect(icons).toContain("'" + n + "':");
            const at = icons.indexOf("'" + n + "':");
            expect(icons.slice(at, at + 120)).toContain('fill="currentColor"');
        });
        const bar = html().slice(html().indexOf('id="me-bar"'), html().indexOf('id="mic-pop"'));
        expect(bar).toContain('data-icon="mic-solid"');
        expect(bar).toContain('data-icon="headset-solid"');
    });
});

describe('sliders', () => {
    it('are drawn in the reference blurple, not in the app accent', () => {
        // The accent is a brand mark and it is everywhere. A slider is a
        // control, and this was the one place the two competed for the same
        // read — a teal thumb on a teal fill has no boundary.
        expect(css).toMatch(/--slider:\s*#5d67f6/);
        expect(css).toMatch(/::-webkit-slider-runnable-track \{[^}]*var\(--slider\), var\(--slider\)/);
        expect(css).toMatch(/--track:\s*#474851/);
    });
});

describe('values taken from the live client', () => {
    // These were read off discord.com in DevTools rather than scanned from a
    // screenshot: computed styles on the real elements. Where a value here
    // disagrees with an earlier pixel measurement, this one wins.
    it('uses the surfaces the client actually renders', () => {
        expect(hex('side', dark).hex).toBe('#121214');
        expect(hex('chat', dark).hex).toBe('#1a1a1e');
        expect(hex('panel', dark).hex).toBe('#202024');
    });

    it('draws the active channel as an overlay with an 8px radius', () => {
        // rgba(150,150,160,.20) on the sidebar, not a flat shade: the plate is
        // drawn on different surfaces in different places and the client lets
        // it take the colour underneath.
        expect(css).toMatch(/--chan-active: rgba\(150, 150, 160, \.20\)/);
        expect(/\.chan \{[^}]*border-radius: 8px/.test(css)).toBe(true);
        expect(/\.vchan \{[^}]*border-radius: 8px/.test(css)).toBe(true);
    });

    it('sets author names medium, not semibold', () => {
        // 500 at 16px in #fbfbfb — semibold was reading as a heading.
        expect(/\.msg-author \{[^}]*font-weight: 500/.test(css)).toBe(true);
        expect(hex('author', dark).hex).toBe('#fbfbfb');
        // Timestamps and category labels share the quietest text tone.
        expect(hex('meta', dark).hex).toBe('#81828a');
        expect(css).toMatch(/\.msg-time \{ font-size: 0\.75em; color: var\(--meta\)/);
        expect(/\.cat-toggle \{[^}]*font-weight: 500/.test(css)).toBe(true);
    });
});

describe('the Voice & Audio pane', () => {
    const html = () => fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
    const src = () => fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');

    it('never paints a destructive label its own background colour', () => {
        // The regression: a solid red plate went on .keycap.danger, while
        // .ma-row .keycap.danger set the TEXT to that same red at equal
        // specificity and later in the sheet. Ban and Delete rendered as blank
        // red rectangles.
        const row = /\.ma-row \.keycap\.danger \{[^}]*\}/.exec(css)[0];
        // border-color is fine; a bare `color` is what painted it invisible.
        expect(row).not.toMatch(/(^|[^-])color:/);
        expect(css).toMatch(/\.settings-modal \.keycap\.danger \{[^}]*color: #fff/);
    });

    it('pairs each device with its own level, in two columns', () => {
        expect(css).toMatch(/\.set-cols \{[^}]*grid-template-columns: 1fr 1fr/);
        const pane = html().slice(html().indexOf('<h3>Voice &amp; Audio</h3>'), html().indexOf('id="set-voice-advanced"'));
        ['set-mic', 'set-speaker', 'set-invol', 'set-outvol'].forEach((id) => expect(pane).toContain('id="' + id + '"'));
    });

    it('asks the input question once, with the answers explained', () => {
        // A dropdown of processing flags asked people to know what echo
        // cancellation does before they could choose.
        expect(html()).toContain('id="set-profile"');
        expect((html().match(/name="inprofile"/g) || []).length).toBe(3);
        // Mapped onto the two flags the audio menu already drives.
        expect(src()).toMatch(/const PANE_PROFILE = \{ ai: 'clear', off: 'studio', standard: 'custom' \}/);
        expect(src()).toMatch(/function paintVoicePane\(\)/);
    });

    it('draws push to talk as a switch and folds the rest away', () => {
        expect(html()).toContain('id="set-ptt-toggle"');
        expect(html()).toMatch(/role="switch" aria-checked="false"/);
        // 24px of travel now: the switch is 48 wide, not 40.
        expect(css).toMatch(/\.switch\[aria-checked="true"\] \.switch-knob \{ transform: translateX\(24px\); \}/);
        expect(html()).toContain('id="set-voice-advanced"');
        expect(src()).toMatch(/\$\('set-voice-more'\)\.addEventListener\('click'/);
    });

    it('draws every slider in the app the same way', () => {
        // The settings pane was still getting Chromium's native blue.
        expect(css).toMatch(/\.settings-modal input\[type="range"\]::-webkit-slider-thumb/);
        expect(css).toMatch(/\.settings-modal input\[type="range"\]::-webkit-slider-runnable-track/);
    });
});

// Measurements taken off the reference and then pinned as the declarations that
// produce them, because every one is a value somebody will reasonably want to
// nudge later and each has a reason that is invisible from the declaration alone.
describe('the pinned popover, measured', () => {
    const block = () => css.slice(css.indexOf('.pinned-panel {'), css.indexOf('.pinned-empty'));

    it('is 422 wide with a 202 floor', () => {
        // The floor is what keeps one pin from producing a squat box — the
        // reference leaves room under a single card.
        expect(block()).toMatch(/width: 422px/);
        expect(block()).toMatch(/min-height: 202px/);
    });

    it('outlines itself with an explicit hairline, not --line', () => {
        // Over --float that token computes to #313136, eight points brighter than
        // the reference's #29292C — bright enough to read as a highlight.
        expect(block()).toMatch(/border: 1px solid var\(--float-edge\)/);
        expect(dark).toMatch(/--float-edge:\s*#29292c/);
        expect(block()).not.toMatch(/\.pinned-panel \{[^}]*border: 1px solid var\(--line\)/);
    });

    it('fills the header with the body shade, separated only by the rule', () => {
        // It used to be --float-2, which is ALSO the card colour, so the bar read
        // as raised out of the panel and level with the cards under it.
        const head = css.slice(css.indexOf('.pinned-head {'), css.indexOf('.pinned-title {'));
        expect(head).toMatch(/background: var\(--float\); border-bottom: 1px solid var\(--float-rule\)/);
        expect(dark).toMatch(/--float-rule:\s*#323237/);
        expect(head).not.toMatch(/background: var\(--float-2\)/);
    });

    it('sizes the title and the pin to each other', () => {
        // 9x13 against a 15px title is what made them look unrelated rather than
        // like one mark and one word.
        const head = css.slice(css.indexOf('.pinned-head {'), css.indexOf('#pinned-list {'));
        expect(head).toMatch(/font-size: 22px; line-height: 1;/);
        expect(head).toMatch(/\.pinned-title \.ico \{ width: 22px; height: 22px/);
        // …and the later "Icon contexts" block must not set a second size: same
        // specificity, later in the file, so it used to win and drag the pin back
        // down to 15.
        expect(css.slice(css.indexOf('Icon contexts'))).not.toMatch(/\.pinned-title \.ico \{ width/);
    });

    it('gives a card its own fill, its own outline and a 78px floor', () => {
        const card = css.slice(css.indexOf('.pinned-item {'), css.indexOf('.pinned-avatar'));
        expect(card).toMatch(/background: var\(--card\); border: 1px solid var\(--card-line\)/);
        expect(dark).toMatch(/--card:\s*#28282d/);
        expect(dark).toMatch(/--card-line:\s*#35353b/);
        expect(card).toMatch(/min-height: 78px/);
        expect(card).toMatch(/padding: 16px;/);
    });
});

describe('a pinned message in the channel', () => {
    it('is marked by the tag beside its timestamp and by nothing else', () => {
        // The row used to carry a tinted background and a 2px accent bar as well,
        // which was wrong twice: it does not scale (ten pins mean ten permanently
        // highlighted rows scattered through the scrollback), and accent-bar-plus-
        // tint is already the language of a reply quote AND of the jump flash — so
        // three different states looked the same.
        expect(css).toMatch(/\.msg-pinned-tag \{[^}]*color: var\(--accent\)/);
        expect(css).not.toMatch(/\.msg\.pinned \{[^}]*background/);
        expect(css).not.toMatch(/\.msg\.pinned \{[^}]*inset 2px/);
        // The flash and the reply quote keep theirs — they are the states that
        // treatment belongs to.
        expect(css).toMatch(/@keyframes flash/);
    });
});

describe('the scrollbar', () => {
    it('draws a thumb LIGHTER than what it sits on', () => {
        // It was rgba(0,0,0,.45), so over the message column (#1A1A1E) it computed
        // to #0E0E10 — twelve points DARKER than its background, which reads as a
        // recessed groove with no handle in it.
        expect(dark).toMatch(/--scrollbar:\s*rgba\(255, 255, 255, \.13\)/);
        expect(dark).toMatch(/--scrollbar-hover:\s*rgba\(255, 255, 255, \.22\)/);
    });

    it('hides itself when nothing is happening', () => {
        // Transparent at rest; hover brings it back, and so does actually
        // scrolling — the case CSS alone cannot express.
        expect(css).toMatch(/#messages::-webkit-scrollbar-thumb,[\s\S]{0,320}background: transparent/);
        expect(css).toMatch(/#messages\.scrolling::-webkit-scrollbar-thumb/);
        expect(css).toMatch(/#messages:hover::-webkit-scrollbar-thumb/);
    });
});

describe('the (edited) marker', () => {
    it('tells the two apart by italic, not by brightness', () => {
        // They used to render at 175 and 128, so one footnote looked like a
        // different kind of text rather than the same kind with two readings.
        expect(css).toMatch(/\.msg-edited \{[^}]*color: var\(--dim\)/);
        expect(css).toMatch(/\.msg-edited\.by-mod \{ font-style: italic; \}/);
        expect(css).not.toMatch(/\.msg-edited\.by-mod \{[^}]*color:/);
    });
});

// The Filters form, measured off the reference. Its fields were the biggest
// divergence in the app: they were drawn as underlines, so a scan straight across
// one found nothing at all — no top, no sides, no fill — and the sheet read as a
// settings list rather than as a form.
describe('the filters modal, measured', () => {
    const fm = () => css.slice(css.indexOf('.fm-modal {'), css.indexOf('.fm-foot {'));

    it('is 480 wide, capped at 800, with the body scrolling', () => {
        // It used to grow to fit — 470x911 — which is taller than a 900px window
        // can show. The field rhythm was already right, so only the frame moved.
        expect(fm()).toMatch(/max-width: 480px; max-height: min\(800px, 88vh\)/);
    });

    it('draws each field as a BOUNDED BOX, not an underline', () => {
        // The fill is four points darker than the modal and the hairline goes all
        // the way round. It used to be var(--input) with a transparent border, and
        // --input is close enough to --float that the field had no visible edge.
        expect(fm()).toMatch(/\.fm-input \{[^}]*height: 40px/);
        expect(fm()).toMatch(/\.fm-input \{[^}]*background: var\(--ctl-sunk\); border: 1px solid var\(--ctl-sunk-line\)/);
        expect(dark).toMatch(/--ctl-sunk:\s*#202024/);
        expect(dark).toMatch(/--ctl-sunk-line:\s*#37373d/);
    });

    it('has no rule between sections', () => {
        // The reference has exactly two — under the header and above the footer —
        // because each of its fields is visibly bounded. Give the fields borders
        // and the dividers become redundant.
        expect(css).not.toMatch(/\.fm-field \+ \.fm-field/);
    });

    it('draws Add date as a real button the same height as a field', () => {
        // It was plain text on the modal's own fill: nothing there to press.
        expect(fm()).toMatch(/\.fm-add \{[^}]*height: 40px/);
        expect(fm()).toMatch(/\.fm-add \{[^}]*background: var\(--ctl\); border: 1px solid var\(--ctl-line\)/);
        expect(dark).toMatch(/--ctl:\s*#323237/);
    });

    it('raises the footer buttons OUT of the sheet', () => {
        // Cancel was var(--input) with no border — two points DARKER than the modal
        // it sits on, so it was invisible as a button. Same elevation inversion as
        // the scrollbar and the pinned header.
        const foot = css.slice(css.indexOf('.fm-foot {'));
        expect(foot).toMatch(/\.fm-foot button:not\(\.fm-link\) \{[^}]*background: var\(--ctl\); border: 1px solid var\(--ctl-line\)/);
        expect(foot).toMatch(/\.fm-apply:disabled \{[^}]*opacity: \.5/);
    });

    it('gives every modal the reference s border and title size', () => {
        const modal = css.slice(css.indexOf('.modal {'), css.indexOf('.modal-body {'));
        expect(modal).toMatch(/border: 1px solid var\(--float-rule\)/);
        expect(modal).toMatch(/\.modal-head h2 \{[^}]*font-size: 20px/);
    });

    it('keeps a modal s scrollbar visible, and light', () => {
        // The opposite call from the chat scrollbar, deliberately: there a permanent
        // bar down the edge of a conversation is chrome asking to be read, so it
        // hides. Here it is the only thing saying there is more below the fold.
        const bar = css.slice(css.indexOf('.modal-body::-webkit-scrollbar'));
        expect(bar).toMatch(/background: var\(--scrollbar-modal\)/);
        expect(dark).toMatch(/--scrollbar-modal: rgba\(255, 255, 255, \.30\)/);
        expect(css).not.toMatch(/\.modal-body\.scrolling/);
    });
});

describe('the backdrop behind a modal', () => {
    it('is PURE BLACK, which is what makes the dimming uniform', () => {
        // It was rgba(4,5,7,.82). A coloured scrim contributes its own colour in
        // proportion to how dark the surface under it is, so the rail came out at a
        // 0.41 multiplier against the chat column's 0.34 while the reference sits
        // flat at 0.27-0.29 everywhere. Black at .72 measures 0.27-0.29 on every
        // surface — and dims MORE than the old value despite the lower alpha,
        // because the tint was doing the lifting.
        expect(dark).toMatch(/--scrim:\s*rgba\(0, 0, 0, \.72\)/);
    });
});

// The Threads popover, measured off the reference. It shares two faults with the
// pinned popover — a tinted header and a --line border — which is what makes them
// worth pinning together rather than one at a time.
describe('the threads popover, measured', () => {
    const tp = () => css.slice(css.indexOf('.threads-pop {'), css.indexOf('.tp-item {'));

    it('is 602 x 450', () => {
        // It was 528 x 368, and the empty state is the whole point of the panel.
        expect(tp()).toMatch(/width: 602px/);
        expect(tp()).toMatch(/min-height: 450px/);
        expect(tp()).toMatch(/border: 1px solid var\(--float-edge\)/);
    });

    it('fills the header with the body shade, like the pinned one', () => {
        // Both popovers filled their header with --float-2 — which is a CARD
        // colour — so the bar read as raised out of the panel. The reference keeps
        // it flush and separates it with the rule alone.
        expect(tp()).toMatch(/\.tp-head \{[^}]*height: 48px/);
        expect(tp()).toMatch(/background: var\(--float\); border-bottom: 1px solid var\(--float-rule\)/);
        expect(tp()).not.toMatch(/\.tp-head \{[^}]*var\(--float-2\)/);
        // The pinned popover's header must not drift back either.
        const ph = css.slice(css.indexOf('.pinned-head {'), css.indexOf('.pinned-title {'));
        expect(ph).toMatch(/background: var\(--float\)/);
    });

    it('draws the search box as a bordered input, not a well', () => {
        // It was --sunk with no border: 21 points darker than the header it sat in.
        // The reference's is four points darker than the panel, with a hairline —
        // the same field treatment the Filters form needed.
        expect(tp()).toMatch(/\.tp-search \{[^}]*flex: 0 0 280px/);
        expect(tp()).toMatch(/\.tp-search \{[^}]*height: 32px/);
        expect(tp()).toMatch(/\.tp-search \{[^}]*background: var\(--ctl-sunk\); border: 1px solid var\(--ctl-sunk-line\)/);
    });

    it('sizes the header glyph to 22, like the pinned popover s pin', () => {
        expect(tp()).toMatch(/\.tp-title \.ico \{ width: 22px; height: 22px/);
    });

    it('gives the empty state an illustration, a big heading and a bright line', () => {
        // 104x80 against the 47x32 the bare glyph drew — roughly twice the
        // footprint, and a composition rather than an icon scaled up. That is most
        // of why the reference's empty state reads as designed.
        expect(tp()).toMatch(/\.tp-empty-mark \{ width: 104px; height: 80px/);
        // 24px, for an 18px cap height. It was 17, which drew 13.
        expect(tp()).toMatch(/\.tp-empty-title \{ font-size: 24px/);
        // Nearly body text, not --panel-sub: that measured 156 against the
        // reference's 240 and read as a caption rather than as the sentence it is.
        expect(tp()).toMatch(/\.tp-empty-sub \{[^}]*color: var\(--msg-text\)/);
        expect(tp()).toMatch(/max-width: 494px/);
        // Centred in the body, which is where the reference puts it: it measured
        // 85px of clear space above the illustration and 86 below the button.
        expect(tp()).toMatch(/\.tp-empty \{[^}]*margin: auto 0/);
    });
});

describe('a header button whose panel is open', () => {
    it('goes white, not just the members toggle', () => {
        // The threads button and the bell both set aria-expanded and neither was
        // styled for it, so a panel could be open with nothing in the header saying
        // which button had opened it. The members toggle already did this via .on.
        expect(css).toMatch(/#chan-head \.ch-btn\[aria-expanded="true"\] \{[^}]*color: var\(--text-strong\)/);
    });
});

// The settings sheet, measured off the reference. Several of these are the same
// faults the popovers and the Filters form had — a field with no border, a control
// darker than its surface — which is why they are pinned by value rather than left
// to be re-noticed a fourth time.
describe('the settings sheet, measured', () => {
    const sheet = () => css.slice(css.indexOf('#settings {'), css.indexOf('.set-nav-head {'));

    it('leaves 72px of margin top and bottom, not a box floating in the middle', () => {
        // It was height: min(760px, 86vh) centred in an overlay that starts one
        // title bar down, which measured 103 above and 72 below — and the practical
        // cost was that Visual Density was always below the fold.
        expect(sheet()).toMatch(/place-items: start center/);
        expect(sheet()).toMatch(/margin-top: calc\(72px - var\(--tb\)\)/);
        expect(sheet()).toMatch(/height: calc\(100% - 72px - \(72px - var\(--tb\)\)\)/);
    });

    it('insets the nav rail 16px, and fills the active pill at #2e2e33', () => {
        expect(sheet()).toMatch(/padding: 16px 16px 24px/);
        expect(css).toMatch(/\.set-nav-item\.on \{ background: var\(--nav-active\)/);
        expect(dark).toMatch(/--nav-active: #2e2e33/);
    });

    it('draws the profile avatar at 46px', () => {
        // 34 was ~30% small against the two lines beside it, which already matched.
        expect(sheet()).toMatch(/\.set-me-av \{\s*width: 46px; height: 46px/);
    });

    it('gives the rail search field a visible edge', () => {
        // A transparent border on --sunk is not an edge. Same gap as the Filters
        // fields and the Threads search box.
        expect(sheet()).toMatch(/\.set-search \{[^}]*height: 40px/);
        expect(sheet()).toMatch(/border: 1px solid var\(--field-edge\)/);
        expect(dark).toMatch(/--field-edge:\s*#303035/);
    });

    it('sets section headings at 23px', () => {
        // 20 drew an h20 cap height against the reference's h23; the
        // width-to-height ratio already matched within 4%.
        expect(css).toMatch(/\.set-sub \{[^}]*font-size: 23px/);
    });
});

describe('the settings controls, measured', () => {
    it('fills the traveled half of a slider', () => {
        // The biggest functional miss on the Accessibility page: both halves of the
        // track measured the same grey, so the value could only be read off the
        // thumb. A range input's track is ONE element, so the fill is a
        // hard-stopped gradient at --fill, which app.js writes on every input.
        expect(css).toMatch(/linear-gradient\(to right, var\(--slider\) 0 var\(--fill, 0%\), var\(--track\) var\(--fill, 0%\) 100%\)/);
    });

    it('draws a selected radio as a filled disc with a white dot', () => {
        // It was a 3px ring, a transparent gap and an 8px blurple dot floating
        // inside it — much lighter weight, and blurple-on-blurple left the dot with
        // almost no contrast against the ring holding it.
        expect(css).toMatch(/\.set-radio input\[type="radio"\]:checked \{\s*border-color: var\(--slider\); background: var\(--slider\);/);
        // 22px with an 8px dot, measured. At 20/6 the selected state read soft.
        expect(css).toMatch(/\.set-radio input\[type="radio"\]:checked::after \{[^}]*width: 8px; height: 8px[^}]*background: #fff/);
        expect(css).toMatch(/\.set-radio input\[type="radio"\] \{[^}]*width: 22px; height: 22px/);
    });

    it('keeps an UNSELECTED radio quiet enough for the filled one to win', () => {
        // The ring was --nav-idle (#9A9AA0) on the pane's own background: luminance
        // ~153 against the reference's ~69, so an unselected option read almost as
        // strongly as the blurple disc beside it. Both values measured off the
        // reference — and the interior is DARKER than the pane rather than a hole
        // in it. The old bright grey is the hover state now.
        expect(css).toMatch(/\.set-radio input\[type="radio"\] \{[^}]*border: 2px solid var\(--well-ring\); background: var\(--well\)/);
        expect(dark).toMatch(/--well-ring:\s*#45454a/);
        expect(dark).toMatch(/--well:\s*#1d1d21/);
        expect(css).toMatch(/\.set-radio input\[type="radio"\]:hover \{ border-color: var\(--nav-idle\); \}/);
    });

    it('draws an OFF switch as a dark well, not a grey pill', () => {
        // --track is a mid grey, and a filled grey pill reads as a third state
        // rather than as the absence of one. 48px wide, measured.
        expect(css).toMatch(/\.switch \{[^}]*width: 48px/);
        expect(css).toMatch(/\.switch \{[^}]*border: 1px solid var\(--switch-off-line\)[^}]*background: var\(--switch-off\)/);
        expect(dark).toMatch(/--switch-off-line:\s*#353539/);
        expect(dark).toMatch(/--switch-off:\s*#1c1c20/);
        // In the light theme the TRACK carries the off state instead: a white knob
        // in a near-white well is a switch with nothing in it.
        const light = css.slice(css.indexOf(':root[data-theme="light"]'));
        expect(lum(hex('switch-off', light))).toBeLessThan(lum(hex('side', light)));
        expect(css).toMatch(/\.switch\[aria-checked="true"\] \.switch-knob \{ transform: translateX\(24px\); \}/);
    });

    it('draws the preview as one outlined box with a muted caption', () => {
        // It was a filled card holding a header strip, a divider and a nested darker
        // panel — three surfaces where the reference has a single outline — and the
        // caption was white, so it read as a heading.
        expect(css).toMatch(/\.a11y-preview-box \{[^}]*background: none; border: 1px solid var\(--outline\)/);
        expect(dark).toMatch(/--outline:\s*#38383d/);
        expect(css).toMatch(/\.a11y-preview-box \{[^}]*min-height: 210px/);
        expect(css).toMatch(/\.a11y-preview-label \{[^}]*color: var\(--panel-sub\)/);
        // 16px, measured: at 12 the caption rendered 9px tall against the
        // reference's 12. The colour was already right.
        expect(css).toMatch(/\.a11y-preview-label \{[^}]*font-size: 16px/);
        // …and the sticky wrapper matches the sheet, or it draws a band across it.
        // The SHEET's colour, not --chat-2: this is what the controls scroll under,
        // and those two are the same shade in the dark theme and different ones in
        // the light theme, where the sheet is paper.
        expect(css).toMatch(/\.a11y-preview \{[^}]*background: var\(--sheet\)/);
    });

    it('gives the preview a role-coloured username, as the reference does', () => {
        // This app has no role colours; the preview shows one because a coloured
        // name is one of the things a reader with a colour sensitivity is being
        // asked about here.
        expect(css).toMatch(/\.a11y-msgs \.msg-author \{ color: var\(--preview-role\); \}/);
        expect(css).toMatch(/--preview-role: #c297d8/);
    });

    it('draws a 4px slider track, not 8', () => {
        // One component, therefore five controls: Accessibility's four and Voice &
        // Audio's input and output volume all drew a bar twice the reference's.
        expect(css).toMatch(/\.settings-modal input\[type="range"\] \{[^}]*height: 4px/);
        expect(css).toMatch(/\.settings-modal input\[type="range"\]::-webkit-slider-runnable-track \{\s*height: 4px; border-radius: 2px/);
        // A 16px thumb straddling a 4px track: half the thumb minus half the track.
        expect(css).toMatch(/\.settings-modal input\[type="range"\]::-webkit-slider-thumb \{[^}]*margin-top: -6px/);
    });

    it('runs the tick marks THROUGH the bar rather than resting them on it', () => {
        // Measured off the reference: 1px wide, 16px tall, centred on the 4px track,
        // so 6px stands above the bar and 6px below. They were 9px sitting on top of
        // it, which read as marks near the bar rather than rules crossing it.
        expect(css).toMatch(/\.set-tick-mark \{\s*position: absolute; bottom: -12px; width: 1px; height: 16px/);
        // The scale cannot take the pointer: it lies directly over the top half of
        // the thumb, which could otherwise only be grabbed from below its centre.
        expect(css).toMatch(/\.set-ticks \{[^}]*pointer-events: none/);
    });

    it('puts the channel header, and the menu hanging off it, above both columns', () => {
        // The header is a stacking context, so .search-pop's own z-index is spent
        // inside it and the header's number is the only one that counts. At 5 it lost
        // to the member list's resize strip (6): the drag line painted through the
        // open filters list and, because whatever paints on top is what the pointer
        // hits, took the hover and the drag with it. It also lost to the unread jump
        // bar (25) and the thread drawer (40).
        // Two rules carry this selector — the grid placement one-liner and the
        // block below it; the z-index lives in the second.
        const head = css.match(/#chan-head \{[^}]*z-index: (\d+)/);
        const z = Number(head[1]);
        const handle = Number(css.match(/\.pane-resize \{[\s\S]*?z-index: (\d+)/)[1]);
        expect(z).toBeGreaterThan(handle);
        expect(z).toBeGreaterThan(40);
        expect(css).toMatch(/\.search-pop \{[^}]*z-index: 40/);
    });
});
