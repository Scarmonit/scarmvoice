// The probe. One function, no dependencies, runs in ANY browser context —
// pasted into DevTools on discord.com, or evaluated by Playwright against our
// own harness. Same code both sides, which is the whole point: a difference in
// the output is a difference in the app, not in how it was measured.
//
// It answers, for each named component, the questions that have actually come
// up in review: what colour is it, how big is it, what does it do on hover,
// what does its tooltip say, and what is the glyph inside it.
(function () {
    'use strict';

    // Modern CSS colours (oklab, color()) do not compare as strings. Painting
    // one pixel and reading it back is the only way to get a number that means
    // the same thing on both sides.
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    function rgb(css) {
        if (!css || css === 'none') return css;
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = '#000';
        ctx.fillStyle = css;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        const hex = '#' + [d[0], d[1], d[2]].map((x) => x.toString(16).padStart(2, '0')).join('');
        return d[3] < 255 ? hex + '@' + (d[3] / 255).toFixed(2) : hex;
    }

    // Relative luminance, so "is this brighter than that" is one number rather
    // than three. Every brightness note in review has been this figure.
    function lum(css) {
        const h = rgb(css);
        if (!h || h[0] !== '#') return null;
        const n = parseInt(h.slice(1, 7), 16);
        return Math.round(0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255));
    }

    // What the eye measures is the ink, never the box the glyph is drawn in —
    // a mic in a 24-unit viewBox may only fill twelve of them.
    function ink(el) {
        const svgs = [...el.querySelectorAll('svg')].filter((s) => {
            const r = s.getBoundingClientRect();
            return r.width > 0 && !s.closest('[hidden]');
        });
        const shapes = svgs.flatMap((s) => [...s.querySelectorAll('path,circle,rect,line,polyline,polygon,ellipse')]);
        let l = Infinity, r = -Infinity, t = Infinity, b = -Infinity;
        shapes.forEach((sh) => {
            const q = sh.getBoundingClientRect();
            if (!q.width && !q.height) return;
            l = Math.min(l, q.left); r = Math.max(r, q.right);
            t = Math.min(t, q.top); b = Math.max(b, q.bottom);
        });
        if (l === Infinity) return null;
        return { w: +(r - l).toFixed(1), h: +(b - t).toFixed(1), l, r };
    }

    const STYLE_KEYS = [
        'backgroundColor', 'color', 'borderTopWidth', 'borderTopColor', 'borderRadius',
        'boxShadow', 'fontSize', 'fontWeight', 'fontFamily', 'letterSpacing', 'lineHeight',
        'textTransform', 'opacity', 'padding', 'margin', 'gap', 'display', 'flexDirection',
        'justifyContent', 'alignItems', 'gridTemplateColumns',
        'transitionProperty', 'transitionDuration', 'animationName', 'animationDuration'
    ];

    function snap(el) {
        if (!el) return null;
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const out = {
            box: { w: Math.round(r.width), h: Math.round(r.height) },
            text: (el.textContent || '').trim().slice(0, 60) || null,
            ink: ink(el)
        };
        // 'none' and 'normal' are noise for most properties and the answer for a
        // few — text-transform: none IS the finding when the other side is
        // uppercase, and its absence read as "unset" in the first diff.
        const MEANINGFUL_DEFAULT = new Set(['textTransform', 'lineHeight', 'letterSpacing', 'animationName']);
        STYLE_KEYS.forEach((k) => {
            const v = s[k];
            if (v === undefined || v === '') return;
            if (!MEANINGFUL_DEFAULT.has(k) && (v === 'normal' || v === 'none' || v === '0px')) return;
            if (/[Cc]olor$/.test(k)) { out[k] = rgb(v); out[k + 'Lum'] = lum(v); return; }
            out[k] = v;
        });
        // A tooltip is a thing the user reads, so it belongs in the spec even
        // though it is not a style.
        const tip = el.getAttribute('data-tip') || el.getAttribute('title') || el.getAttribute('aria-label');
        if (tip) out.tip = tip;
        return out;
    }

    // Hover is where half the review notes have lived, and it is only visible
    // as a DIFFERENCE — so capture both states and keep what changed.
    function hoverDelta(el) {
        if (!el) return null;
        const before = snap(el);
        el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        // :hover cannot be forced from script, so this catches JS-driven state
        // only. The CSS half is read out of the stylesheet instead, below.
        const after = snap(el);
        el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
        const delta = {};
        Object.keys(after || {}).forEach((k) => {
            if (JSON.stringify(after[k]) !== JSON.stringify((before || {})[k])) delta[k] = after[k];
        });
        return Object.keys(delta).length ? delta : null;
    }

    // The :hover and :active rules that apply to an element, read straight out
    // of the sheets. This is how "the gear turns 90deg" ends up in the spec
    // without anyone having to notice it by eye.
    //
    // The index is built ONCE. The first version ran a DOM query per rule per
    // element, which is unnoticeable against our own three thousand rules and
    // hangs the tab against Discord's four hundred stylesheets — a probe that
    // cannot be pointed at the thing it is comparing to is no use.
    let stateIndex = null;

    function buildStateIndex() {
        const idx = [];
        for (const sheet of document.styleSheets) {
            let rules;
            try { rules = sheet.cssRules; } catch (e) { continue; }
            const walk = (list) => {
                for (const r of list) {
                    if (r.cssRules) { walk(r.cssRules); continue; }
                    if (!r.selectorText || !r.style) continue;
                    if (!/:hover|:active|:focus-visible/.test(r.selectorText)) continue;
                    // Only rules that actually change something visual.
                    if (!/transform|animation|background|color|opacity|box-shadow/.test(r.style.cssText)) continue;
                    idx.push({
                        sel: r.selectorText,
                        // The same selector with the state stripped: what it
                        // would match at rest, which is what we can test.
                        base: r.selectorText.replace(/:hover|:active|:focus-visible/g, '').split(','),
                        text: r.selectorText + ' { ' + r.style.cssText.slice(0, 160) + ' }'
                    });
                    if (idx.length > 4000) return;
                }
            };
            walk(rules);
            if (idx.length > 4000) break;
        }
        return idx;
    }

    function stateRules(el) {
        if (!el) return null;
        if (!stateIndex) stateIndex = buildStateIndex();
        const found = [];
        for (const r of stateIndex) {
            for (const b of r.base) {
                const sel = b.trim();
                if (!sel) continue;
                let hit = false;
                try { hit = el.matches(sel); } catch (e) { continue; }
                if (hit) { found.push(r.text); break; }
            }
            if (found.length >= 12) break;
        }
        return found.length ? found : null;
    }

    // Glyph geometry, so an icon can be compared as a shape rather than as a
    // screenshot. Normalised to the viewBox so two different render sizes still
    // compare.
    function glyphs(el) {
        if (!el) return null;
        const out = [];
        el.querySelectorAll('svg').forEach((svg) => {
            if (svg.closest('[hidden]')) return;
            const vb = svg.getAttribute('viewBox') || '';
            const paths = [...svg.querySelectorAll('path')].map((p) => (p.getAttribute('d') || '').slice(0, 90));
            const filled = getComputedStyle(svg.querySelector('path,g,rect,circle') || svg).fill;
            out.push({ vb, filled: rgb(filled), paths: paths.slice(0, 6) });
        });
        return out.length ? out : null;
    }

    // A target is a name plus a way to find the element. A selector when the
    // markup is ours; a predicate when it is Discord's, because their class
    // names are hashed and change on every deploy — geometry and text do not.
    function resolve(t) {
        try {
            if (typeof t === 'function') return t();
            if (typeof t === 'string') return document.querySelector(t);
        } catch (e) { return null; }
        return null;
    }

    window.__spec = function (targets, opts) {
        opts = opts || {};
        const out = { at: new Date().toISOString(), viewport: { w: innerWidth, h: innerHeight }, components: {} };
        Object.keys(targets).forEach((name) => {
            const el = resolve(targets[name]);
            if (!el) { out.components[name] = { missing: true }; return; }
            const rec = snap(el);
            if (opts.hover !== false) {
                const d = hoverDelta(el);
                if (d) rec.onHover = d;
                const rules = stateRules(el);
                if (rules) rec.stateRules = rules;
            }
            const g = glyphs(el);
            if (g) rec.glyphs = g;
            out.components[name] = rec;
        });
        return out;
    };

    return 'probe ready';
}());
