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

    it('keeps the composer from hovering over the column behind it', () => {
        // Was a thirteen-point step, which read as a raised card. The reference
        // barely separates the two at all.
        const step = lum(hex('input', dark)) - lum(hex('chat', dark));
        expect(step).toBeGreaterThan(0);
        expect(step).toBeLessThanOrEqual(6);
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
        // disagree about where the centre is. Both carets use the drawn one.
        expect((html.match(/data-icon="chevron-down"/g) || []).length).toBe(2);
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
        const st = src.slice(src.indexOf("$('btn-soundboard').hidden = !st.joined;"));
        expect(st.slice(0, 260)).toMatch(/renderMe\(\);/);
        expect(/#me-bar \.ms-voice \{[^}]*color:\s*var\(--voice-ok\)/.test(css)).toBe(true);
    });
});
