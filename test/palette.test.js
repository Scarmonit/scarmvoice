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
        expect(/\.composer-row \{[^}]*border: 1px solid var\(--line\)/.test(css)).toBe(true);
    });

    it('raises a card on a floating surface too', () => {
        // The account panel's action groups. They were --panel, three points
        // DARKER than the popover they sit on, so they read as wells cut into
        // it rather than as buttons resting on it — the same inversion the user
        // panel had, one level in.
        expect(lum(hex('float-2', dark))).toBeGreaterThan(lum(hex('float', dark)));
        expect(lum(hex('elev', dark))).toBeGreaterThan(lum(hex('float-2', dark)));
    });

    it('does the same in the light theme, where it was inverted too', () => {
        const light = css.slice(css.indexOf(':root[data-theme="light"]'));
        expect(lum(hex('panel', light))).toBeGreaterThan(lum(hex('side', light)));
        expect(lum(hex('float-2', light))).toBeGreaterThan(lum(hex('float', light)));
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
        expect(sheet).toMatch(/place-items: center/);
        // Dimmed, NOT blurred. Measured on the reference: text behind the panel
        // is as sharp as text inside it.
        expect(sheet).toMatch(/background: rgba\(0, 0, 0, \.68\)/);
        expect(sheet).toMatch(/backdrop-filter: none/);
    });

    it('floats above the app rather than reusing its shades', () => {
        // The panel was the same values as the main window, so it read as the
        // same layer. It is lighter than what is behind it now.
        expect(/\.settings-modal \{[^}]*background: var\(--chat-2\)/.test(css)).toBe(true);
        expect(/\.set-nav \{[^}]*background: var\(--chat\)/.test(css)).toBe(true);
        expect(lum(hex('chat-2', dark))).toBeGreaterThan(lum(hex('chat', dark)));
    });

    it('gives the nav a column instead of a gutter', () => {
        // 194px of nav floated to the right of a 604px column left 400px of
        // nothing — the pre-redesign shape.
        expect(/\.settings-modal \{[^}]*grid-template-columns: 252px/.test(css)).toBe(true);
        expect(/\.set-nav \{[^}]*flex-direction: column/.test(css)).toBe(true);
        expect(/\.set-nav-item \{[^}]*height: 36px/.test(css)).toBe(true);
        expect(/\.set-nav-item \.ico \{[^}]*width: 18px/.test(css)).toBe(true);
        expect(/\.set-search \{[^}]*height: 38px/.test(css)).toBe(true);
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

    it('is laid out as two cards, in the reference is order', () => {
        const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
        const pop = html.slice(html.indexOf('id="me-popover"'), html.indexOf('<main id="main">'));
        const groups = pop.split('class="mep-menu"').slice(1);
        expect(groups.length).toBe(2);
        // Two rows each, split by a divider inside the card — the gap between
        // the CARDS is what separates the groups.
        groups.forEach((g) => {
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
        expect(dock).toMatch(/border:\s*1px solid var\(--line\)/);
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
        // The plate is a lift of the red channel, not a second colour.
        const plate = /--danger-plate:\s*rgba\((\d+), (\d+), (\d+), \.(\d+)\)/.exec(css);
        expect(Number('0.' + plate[4])).toBeLessThanOrEqual(0.1);
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
        expect(voice()).toMatch(/joined = true;[\s\S]{0,120}startRtt\(\);/);
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
        expect(rule).toMatch(/background:\s*var\(--chat\)/);
        expect(rule).toMatch(/box-shadow:\s*inset 1px 0 0 var\(--line\)/);
    });

    it('draws the channel header s rule lighter than the surface', () => {
        expect(/#chan-head \{[^}]*box-shadow:\s*0 1px 0 var\(--line\)/.test(css)).toBe(true);
    });
});

describe('the channel header', () => {
    const html = () => fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');

    it('groups every action before the search field', () => {
        const acts = html().slice(html().indexOf('class="chan-actions"'), html().indexOf('id="filter-bar"'));
        const ids = [...acts.matchAll(/id="(btn-[a-z-]+)"/g)].map((m) => m[1]);
        expect(ids).toEqual(['btn-chan-alerts', 'btn-pinned', 'btn-members', 'btn-search']);
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
        const search = html().slice(html().indexOf('id="btn-search"'), html().indexOf('</button>', html().indexOf('id="btn-search"')));
        expect(search.indexOf('ch-search-text')).toBeLessThan(search.indexOf('data-icon="search"'));
        expect(css).toMatch(/\.ch-search \.ico \{[^}]*margin-left:\s*auto/);
    });
});

describe('an empty channel', () => {
    const src = () => fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');

    it('reads as the start of something rather than as an empty pane', () => {
        expect(src()).toMatch(/e\.className = 'chan-intro'/);
        expect(src()).toMatch(/Welcome to #\$\{esc\(channel\)\}!/);
        expect(src()).toMatch(/This is the start of the #\$\{esc\(channel\)\} channel\./);
        // Only offered to somebody who can act on it.
        expect(src()).toMatch(/if \(isAdmin\(\)\) \{[\s\S]{0,300}Edit Channel/);
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
        // And the header hash is a marker beside the name, not a second name.
        expect(css).toMatch(/\.ch-hash \{ color: var\(--muted\)/);
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
        expect(src()).toMatch(/Encrypted peer-to-peer \(DTLS-SRTP\)/);
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
