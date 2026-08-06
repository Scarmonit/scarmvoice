// Theme engine — the presets beyond dark/light, and the custom tint.
//
// styles.css owns two palettes: the dark ramp in :root and the light one in
// [data-theme="light"]. Everything else this file produces is DERIVED from
// those at apply time and written as inline custom properties on <html>, so
// the stylesheet stays the single source of truth for what the app's surfaces
// ARE and this file only ever says how far to move them:
//
//   ash    the dark ramp lifted and desaturated — a softer, ashy grey
//   onyx   the dark ramp compressed toward black — for OLED and the dim room
//   custom the dark or light ramp re-hued toward colours the user picked,
//          scaled by an intensity slider, spread across the elevation ladder
//          when there is more than one colour
//
// The base values are MIRRORED here rather than read from getComputedStyle:
// reading back through the cascade means the engine cannot run before first
// paint, cannot be unit-tested outside a real renderer, and silently produces
// garbage if it runs while another override is still applied. The mirror can
// drift from the stylesheet instead — so a test (theme-engine.test.js) parses
// styles.css and fails the moment the two disagree.
(function () {
    'use strict';

    // token -> [dark, light, ladder]
    //
    // `ladder` is the token's place on the elevation ladder, 0 = the outermost
    // chrome (the rail) and 1 = the most raised control. It only matters for a
    // custom theme with several colours: the colours are spread along the
    // ladder, so the window shades from the first colour in its deepest
    // surfaces to the last in its most raised — the closest one app with
    // discrete surfaces can come to the reference's whole-window gradient.
    //
    // --members is var(--chat) in the dark theme (null here — overriding it
    // would break the alias) and its own paper tone in the light one.
    const TOKENS = {
        '--rail':             ['#0c0c0e', '#e4e6ea', 0.00],
        '--side':             ['#121214', '#eef0f3', 0.10],
        '--members':          [null,      '#f4f6f8', 0.45],
        '--panel':            ['#202024', '#f8f9fb', 0.15],
        '--chat-2':           ['#202024', '#f1f3f6', 0.50],
        '--sunk':             ['#17171a', '#e7e9ed', 0.30],
        '--chat':             ['#1a1a1e', '#fafbfc', 0.40],
        '--input':            ['#222327', '#ffffff', 0.55],
        '--mark':             ['#242428', '#eaedf1', 0.50],
        '--well':             ['#1d1d21', '#e9ecf0', 0.45],
        '--well-ring':        ['#45454a', '#c3c8d0', 0.60],
        '--switch-off':       ['#1c1c20', '#c4c9d1', 0.45],
        '--switch-off-line':  ['#353539', '#b3b9c3', 0.55],
        '--track':            ['#474851', '#d7dae0', 0.55],
        '--nav-active':       ['#2e2e33', '#dfe3e9', 0.50],
        '--spoiler':          ['#2e2e33', '#d7dae0', 0.50],
        '--spoiler-hover':    ['#383840', '#c9cdd4', 0.55],
        '--float':            ['#242429', '#ffffff', 0.65],
        '--float-2':          ['#2c2c31', '#f2f4f7', 0.75],
        '--float-edge':       ['#29292c', '#e2e5ea', 0.60],
        '--float-rule':       ['#323237', '#e8eaee', 0.65],
        '--field-edge':       ['#303035', '#dde0e6', 0.55],
        '--outline':          ['#38383d', '#e0e3e9', 0.60],
        '--menu':             ['#28282d', '#ffffff', 0.70],
        '--card':             ['#28282d', '#f4f6f8', 0.70],
        '--card-hover':       ['#2e2e34', '#eceff3', 0.75],
        '--card-line':        ['#35353b', '#e2e5ea', 0.75],
        '--card-line-hover':  ['#3d3d44', '#d3d7de', 0.80],
        '--ctl-sunk':         ['#202024', '#f1f3f6', 0.65],
        '--ctl-sunk-line':    ['#37373d', '#dde0e6', 0.70],
        '--ctl-sunk-line-hi': ['#43434a', '#c6cbd3', 0.75],
        '--ctl':              ['#323237', '#edf0f3', 0.75],
        '--ctl-hover':        ['#3a3a41', '#e3e7ec', 0.80],
        '--ctl-line':         ['#35353b', '#dadee4', 0.75],
        '--ctl-line-hover':   ['#45454d', '#c8cdd5', 0.85],
        '--elev':             ['#343439', '#e6e9ed', 0.85]
    };

    // The STRUCTURAL surfaces — the panes that tile the window itself. Under
    // a custom theme the gradient must pass through them as ONE field, which
    // means it may only cross ONE sheet of glass: attenuation compounds per
    // layer, and the app stacks its surfaces (the #app backdrop behind every
    // column, the column, then a panel on the column — the composer sat
    // behind three sheets and measured a 4.7× chroma cut). So the tokens
    // split by depth:
    //
    //   COLUMN  the first-layer panes (rail backdrop, sidebars, chat,
    //           members) — these are the one glass sheet.
    //   NESTED  surfaces that always sit ON a column (composer, user dock,
    //           panels, wells). These express their elevation the way the
    //           reference does — a faint white lift or black dip — which
    //           raises or sinks them WITHOUT desaturating what is beneath.
    //
    // Floating surfaces (menus, modals, popovers) stay opaque — they are
    // drawn OVER the window and a see-through menu is unreadable — and take
    // the hue tint instead.
    const COLUMN = new Set(['--rail', '--side', '--members', '--chat']);
    const NESTED = {
        '--input':  'rgba(255, 255, 255, 0.05)',   // composer: raised
        '--panel':  'rgba(255, 255, 255, 0.05)',   // user dock: raised
        '--chat-2': 'rgba(255, 255, 255, 0.04)',   // panels on the column
        '--mark':   'rgba(255, 255, 255, 0.05)',
        '--sunk':   'rgba(0, 0, 0, 0.14)'          // wells: recessed
    };

    // Not surfaces the stylesheet names, but chrome the OS draws: the native
    // caption-button strip and the window's own background. Transformed with
    // everything else so the titlebar never sits on a patch of the old theme.
    const TB_SEED = { dark: '#131316', light: '#eef0f3' };
    const BG_SEED = { dark: '#101218', light: '#f4f5f7' };
    const SYMBOL = { dark: '#e9ebf0', light: '#3a3d43' };

    const DEFAULT_CUSTOM = { base: 'dark', colors: ['#5865f2'], intensity: 70, angle: 0 };

    // ---- colour math ------------------------------------------------------

    function normHex(v) {
        const m = /^#?([0-9a-f]{6})$/i.exec(String(v || '').trim());
        if (m) return '#' + m[1].toLowerCase();
        const s = /^#?([0-9a-f]{3})$/i.exec(String(v || '').trim());
        if (s) return '#' + s[1].toLowerCase().replace(/(.)/g, '$1$1');
        return null;
    }

    function hexToRgb(hex) {
        const h = normHex(hex) || '#000000';
        return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
    }
    function rgbToHex(r, g, b) {
        const c = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
        return '#' + c(r) + c(g) + c(b);
    }

    function rgbToHsl(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const l = (max + min) / 2;
        if (max === min) return [0, 0, l];
        const d = max - min;
        const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        let h;
        if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        return [h * 60, s, l];
    }
    function hslToRgb(h, s, l) {
        h = ((h % 360) + 360) % 360;
        if (s === 0) { const v = l * 255; return [v, v, v]; }
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        const f = (t) => {
            t = ((t % 360) + 360) % 360;
            if (t < 60) return p + (q - p) * (t / 60);
            if (t < 180) return q;
            if (t < 240) return p + (q - p) * ((240 - t) / 60);
            return p;
        };
        return [f(h + 120) * 255, f(h) * 255, f(h - 120) * 255];
    }
    function hexToHsl(hex) { const [r, g, b] = hexToRgb(hex); return rgbToHsl(r, g, b); }
    function hslToHex(h, s, l) { const [r, g, b] = hslToRgb(h, s, l); return rgbToHex(r, g, b); }

    // HSV, for the picker: the saturation/value square works in HSV, not HSL —
    // the top edge of the square is the pure hue and the left edge is white,
    // which HSL cannot express as two independent axes.
    function hexToHsv(hex) {
        let [r, g, b] = hexToRgb(hex);
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const d = max - min;
        let h = 0;
        if (d) {
            if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
            else if (max === g) h = ((b - r) / d + 2) * 60;
            else h = ((r - g) / d + 4) * 60;
        }
        return [h, max ? d / max : 0, max];
    }
    function hsvToHex(h, s, v) {
        h = ((h % 360) + 360) % 360;
        const i = Math.floor(h / 60) % 6;
        const f = h / 60 - Math.floor(h / 60);
        const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
        const pick = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i];
        return rgbToHex(pick[0] * 255, pick[1] * 255, pick[2] * 255);
    }

    // The hue/saturation the ladder position lands on, when there is more than
    // one colour. Hue takes the short way round the wheel, so a red→blue theme
    // passes through purple rather than sweeping the whole spectrum.
    function colorAt(colors, t) {
        const list = colors.map(hexToHsl);
        if (list.length === 1) return list[0];
        const span = list.length - 1;
        const x = Math.max(0, Math.min(1, t)) * span;
        const i = Math.min(span - 1, Math.floor(x));
        const f = x - i;
        const a = list[i], b = list[i + 1];
        let dh = b[0] - a[0];
        if (dh > 180) dh -= 360;
        if (dh < -180) dh += 360;
        return [a[0] + dh * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
    }

    // ---- the transforms ---------------------------------------------------

    // Ash: lifted and pushed toward neutral. The dark ramp leans faintly blue;
    // ash reads as GREY because the lean is halved along with the lift.
    function ashOf(hex) {
        const [h, s, l] = hexToHsl(hex);
        return hslToHex(h, s * 0.45, Math.min(1, l * 0.82 + 0.115));
    }

    // Edges, rings and rules: tokens whose entire job is to hold contrast
    // AGAINST the surfaces around them. Onyx must not compress these with the
    // surfaces — doing so took the unselected radio ring from #45454a to
    // ~#242427, an affordance nobody could see on a near-black pane.
    const EDGE = /line|ring|edge|rule|outline|track/;

    // Onyx: the same ladder compressed toward black. Multiplicative, so the
    // steps between surfaces survive — a flat subtraction crushes them into
    // one indistinguishable void. Edges are compressed far more gently: the
    // darker the surfaces get, the MORE the things outlined on them need
    // their outlines.
    function onyxOf(hex, isEdge) {
        const [h, s, l] = hexToHsl(hex);
        return hslToHex(h, s * 0.7, l * (isEdge ? 0.85 : 0.52));
    }

    // Custom: keep the ramp's lightness ladder — it is what makes the app read
    // as surfaces — and replace the hue, with saturation scaled by intensity.
    // The caps differ by base: a dark surface can carry more saturation before
    // text drowns; a light one goes pastel much sooner.
    function tintOf(hex, base, colors, intensity, ladder) {
        const k = Math.max(0, Math.min(100, intensity)) / 100;
        if (!k || !colors.length) return hex;
        const [ch, cs] = colorAt(colors, ladder);
        const [, , l] = hexToHsl(hex);
        // Scaled up with the pane-alpha curve: the opaque floats have to keep
        // family with panes that now pass three times the chroma, or every
        // menu reads as a grey card on a vivid page.
        const cap = base === 'light' ? 0.48 : 0.6;
        const s = Math.min(cap, cs * k * (base === 'light' ? 0.6 : 0.8));
        return hslToHex(ch, s, l);
    }

    // ---- application ------------------------------------------------------

    let applied = [];   // property names currently written inline

    function clearVars(root) {
        applied.forEach((p) => { try { root.style.removeProperty(p); } catch (e) {} });
        applied = [];
    }

    function normalizeCustom(cfg) {
        const c = cfg || {};
        const colors = (Array.isArray(c.colors) ? c.colors : [])
            .map(normHex).filter(Boolean).slice(0, 4);
        return {
            base: c.base === 'light' ? 'light' : 'dark',
            colors: colors.length ? colors : DEFAULT_CUSTOM.colors.slice(),
            intensity: Math.max(0, Math.min(100,
                Math.round(Number(c.intensity ?? DEFAULT_CUSTOM.intensity) || 0))),
            // The gradient's direction, 0-360. 0° puts the first colour at the
            // top; the wheel wraps, so 360 IS 0.
            angle: ((Math.round(Number(c.angle ?? 0) || 0) % 360) + 360) % 360
        };
    }

    // The gradient underlay itself: the user's colours as one smooth linear
    // fade at the chosen angle — or the colour, alone. The angle is CSS's,
    // untranslated: 180° runs the first colour top→bottom, 0° bottom→top —
    // the reference reads its slider the same way, so a theme carried between
    // the two apps keeps its direction instead of flipping.
    function underlayOf(cfg) {
        if (cfg.colors.length < 2) return cfg.colors[0];
        return 'linear-gradient(' + cfg.angle + 'deg, ' + cfg.colors.join(', ') + ')';
    }

    function rgbaOf(hex, a, scale) {
        const [r, g, b] = hexToRgb(hex);
        const f = scale === undefined ? 1 : scale;
        return 'rgba(' + Math.round(r * f) + ', ' + Math.round(g * f) + ', ' + Math.round(b * f) + ', ' + a + ')';
    }
    // The gradient's colour AT A POINT of the window (x,y in 0..1, y down).
    // The native titlebar overlay cannot wear a gradient, so it wears the
    // gradient's own colour at its corner — averaging the stops instead
    // cancelled complementary hues into neutral mud (measured chroma 4 on an
    // orange/purple/green theme).
    function gradientAt(cfg, x, y) {
        const list = cfg.colors.map(hexToRgb);
        if (list.length === 1) return list[0];
        // CSS angle: 0deg points up, so the axis direction in screen space
        // (y down) is (sin a, -cos a); t runs 0..1 from the axis's entry
        // corner to its exit corner.
        const rad = cfg.angle * Math.PI / 180;
        const ux = Math.sin(rad), uy = -Math.cos(rad);
        const dots = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([cx, cy]) => cx * ux + cy * uy);
        const min = Math.min.apply(null, dots), max = Math.max.apply(null, dots);
        const t = max === min ? 0.5 : Math.max(0, Math.min(1, ((x * ux + y * uy) - min) / (max - min)));
        const span = list.length - 1;
        const i = Math.min(span - 1, Math.floor(t * span));
        const f = t * span - i;
        const a = list[i], b = list[i + 1];
        return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
    }

    // What a glass pane over the gradient actually shows at a point — the
    // exact compositing arithmetic, so the native chrome matches the page
    // beside it instead of approximating it.
    function paneOver(paneHex, scale, alpha, cfg, x, y) {
        const p = hexToRgb(paneHex);
        const g = gradientAt(cfg, x, y);
        return rgbToHex(
            p[0] * scale * alpha + g[0] * (1 - alpha),
            p[1] * scale * alpha + g[1] * (1 - alpha),
            p[2] * scale * alpha + g[2] * (1 - alpha)
        );
    }

    // Apply `name` ('dark' | 'light' | 'ash' | 'onyx' | 'custom') and answer
    // with the chrome the main process needs for the native caption buttons
    // and the window background. Does NOT set data-theme — the caller owns the
    // attribute (it also feeds the a11y preview) — but says which base to set.
    function apply(name, customCfg) {
        const root = document.documentElement;
        clearVars(root);

        if (name === 'ash' || name === 'onyx') {
            const f = name === 'ash'
                ? (hex) => ashOf(hex)
                : (hex, tok) => onyxOf(hex, EDGE.test(tok || ''));
            Object.keys(TOKENS).forEach((tok) => {
                const dark = TOKENS[tok][0];
                if (!dark) return;
                root.style.setProperty(tok, f(dark, tok));
                applied.push(tok);
            });
            return { base: 'dark', color: f(TB_SEED.dark), symbolColor: SYMBOL.dark, bg: f(BG_SEED.dark) };
        }

        if (name === 'custom') {
            const cfg = normalizeCustom(customCfg);
            const col = cfg.base === 'light' ? 1 : 0;
            const k = cfg.intensity / 100;
            // The reference's model, not an imitation of it: ONE gradient laid
            // under the whole window (html/body carry --theme-underlay), with
            // the structural panes above it going translucent so the same
            // sweep reads through the rail, the sidebars, the chat column and
            // the panels continuously. Per-pane tinting — the old approach —
            // can never blend across a pane boundary, which is exactly the
            // "uneven, not a smooth gradient" complaint.
            //
            // Intensity is the panes' TRANSPARENCY: at 0 they are the stock
            // opaque ramp and no gradient exists; at 100 they are thin glass
            // over it. A light base keeps more of its paper so text stays on
            // something readable.
            if (k > 0) {
                root.style.setProperty('--theme-underlay', underlayOf(cfg));
                applied.push('--theme-underlay');
            }
            // The one sheet of glass. Calibrated against the reference's
            // measured panes, WITH the single-layer model in place: at 50%
            // intensity its me-bar passes ~95% of the raw gradient's chroma,
            // which means the sheet is nearly clear by mid-slider — so the
            // alpha runs down steeply (1−1.6k) to a floor of .08. The pane's
            // own colour also shrinks toward black as intensity rises: the
            // pane·α term is a flat ADDITION to every channel, and stock grey
            // there lifts the gradient's near-zero channels into a wash
            // (measured floor ~24 vs the reference's ~10). Light panes keep
            // more paper and never darken — dark text sits on them.
            const alpha = +Math.max(cfg.base === 'light' ? 0.2 : 0.08,
                1 - (cfg.base === 'light' ? 1.1 : 1.6) * k).toFixed(3);
            const paneScale = cfg.base === 'light' ? 1 : +(1 - 0.85 * k).toFixed(3);
            Object.keys(TOKENS).forEach((tok) => {
                const t = TOKENS[tok];
                if (!t[col]) return;
                let v;
                if (k > 0 && COLUMN.has(tok)) v = rgbaOf(t[col], alpha, paneScale);
                else if (k > 0 && cfg.base !== 'light' && NESTED[tok]) v = NESTED[tok];
                else if (k > 0 && NESTED[tok]) v = rgbaOf(t[col], alpha);
                else v = tintOf(t[col], cfg.base, cfg.colors, cfg.intensity, t[2]);
                root.style.setProperty(tok, v);
                applied.push(tok);
            });
            // The native chrome wears exactly what the page beside it shows:
            // the caption strip composites the glass over the gradient AT ITS
            // OWN CORNER, and the window background takes the centre.
            return {
                base: cfg.base,
                underlay: k > 0,
                color: k > 0
                    ? paneOver(TB_SEED[cfg.base], paneScale, alpha, cfg, 0.95, 0.02)
                    : TB_SEED[cfg.base],
                symbolColor: SYMBOL[cfg.base],
                bg: k > 0
                    ? paneOver(BG_SEED[cfg.base], paneScale, alpha, cfg, 0.5, 0.5)
                    : BG_SEED[cfg.base]
            };
        }

        const base = name === 'light' ? 'light' : 'dark';
        return { base, color: TB_SEED[base], symbolColor: SYMBOL[base], bg: BG_SEED[base] };
    }

    // A theme worth being surprised by: one or two saturated hues, strongly
    // applied. The appearance base is the caller's — surprise should recolour
    // the world, not flip day to night under someone reading.
    function randomCustom(base) {
        const hue = Math.floor(Math.random() * 360);
        const colors = [hslToHex(hue, 0.6 + Math.random() * 0.3, 0.5 + Math.random() * 0.15)];
        if (Math.random() < 0.5) {
            const h2 = hue + 60 + Math.floor(Math.random() * 180);
            colors.push(hslToHex(h2, 0.6 + Math.random() * 0.3, 0.5 + Math.random() * 0.15));
        }
        return {
            base: base === 'light' ? 'light' : 'dark',
            colors,
            intensity: 55 + Math.floor(Math.random() * 35),
            // One of the eight compass directions — every one of them reads as
            // deliberate, where an arbitrary 137° reads as a mistake.
            angle: 45 * Math.floor(Math.random() * 8)
        };
    }

    window.ScarmTheme = {
        apply,
        normalizeCustom,
        randomCustom,
        defaultCustom: () => ({
            base: DEFAULT_CUSTOM.base, colors: DEFAULT_CUSTOM.colors.slice(),
            intensity: DEFAULT_CUSTOM.intensity, angle: DEFAULT_CUSTOM.angle
        }),
        // The gradient string for a config — exported so the picker's swatch
        // strip paints EXACTLY what the window gets, not a re-derivation.
        underlayOf,
        // Picker + test helpers.
        normHex, hexToHsv, hsvToHex, hexToHsl, hslToHex,
        // The mirror, exposed so the drift test can hold it against styles.css.
        tokens: () => TOKENS
    };
})();
