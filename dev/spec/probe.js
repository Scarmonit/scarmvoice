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
        const box = el.getBoundingClientRect();
        const svgs = [...el.querySelectorAll('svg')].filter((s) => {
            const r = s.getBoundingClientRect();
            return r.width > 0 && !s.closest('[hidden]');
        });

        // Ink is a question about a GLYPH — "the mic fills twelve of its
        // twenty-four units" — and it stops meaning anything once the element
        // is a column full of them. Measured across a scrolling message list it
        // reported a glyph 4554px tall, being the bounding box of every icon in
        // the scroll buffer including the ones nobody can see, and the diff
        // dutifully compared that to our 304.
        //
        // So: containers only get an ink figure when they hold a single glyph.
        const CONTROL = 240;
        if ((box.width > CONTROL || box.height > CONTROL) && svgs.length !== 1) return null;

        const shapes = svgs.flatMap((s) => [...s.querySelectorAll('path,circle,rect,line,polyline,polygon,ellipse')]);
        let l = Infinity, r = -Infinity, t = Infinity, b = -Infinity;
        shapes.forEach((sh) => {
            const q = sh.getBoundingClientRect();
            if (!q.width && !q.height) return;
            // Clipped to the element itself: a glyph that overflows its own box
            // is not describing that box.
            const ql = Math.max(q.left, box.left), qr = Math.min(q.right, box.right);
            const qt = Math.max(q.top, box.top), qb = Math.min(q.bottom, box.bottom);
            if (qr <= ql || qb <= qt) return;
            l = Math.min(l, ql); r = Math.max(r, qr);
            t = Math.min(t, qt); b = Math.max(b, qb);
        });
        if (l === Infinity) return null;
        return { w: +(r - l).toFixed(1), h: +(b - t).toFixed(1), l, r };
    }

    // ---- design tokens -----------------------------------------------------
    // The recovered hover rules turned out to be written entirely against named
    // variables:
    //
    //   .wrapper:hover .link { background: var(--interactive-background-hover) }
    //
    // which means the reference is not really a set of hex codes at all. It is
    // a token system, and every hex we have ever copied by eye was one
    // resolved value of one token in one theme. There are 4691 of them
    // resolving on :root, and they are declared as color-mix(in oklab, ...) —
    // unreadable as text, exact once painted.
    //
    // Collecting them costs one pass and replaces the entire practice of
    // reading colours off a screenshot.
    function tokens() {
        const names = new Set();
        for (const sheet of document.styleSheets) {
            let rules;
            try { rules = sheet.cssRules; } catch (e) { continue; }
            const walk = (list) => {
                for (const r of list) {
                    if (r.cssRules && r.cssRules.length) walk(r.cssRules);
                    if (!r.style) continue;
                    for (let i = 0; i < r.style.length; i++) {
                        const p = r.style[i];
                        if (p.charCodeAt(0) === 45 && p.charCodeAt(1) === 45) names.add(p);
                    }
                }
            };
            walk(rules);
        }
        const cs = getComputedStyle(document.documentElement);
        const out = {};
        names.forEach((n) => {
            const raw = cs.getPropertyValue(n).trim();
            if (!raw) return;                  // declared for another theme
            const rec = { raw };
            // Anything that paints gets a hex as well, so it can be compared
            // and so it can be reversed back to a name further down.
            if (/^(#|rgb|hsl|oklab|oklch|color|color-mix|var)/.test(raw)) {
                const hex = rgb(raw);
                if (hex && hex[0] === '#') { rec.hex = hex; rec.lum = lum(raw); }
            }
            out[n] = rec;
        });
        return out;
    }

    // hex -> the token names that resolve to it. Turns "#121214" back into
    // "--background-secondary", which is the difference between copying a
    // number and understanding the system it came from. Several names share a
    // value, so this keeps all of them and prefers the least decorated.
    let tokenIndex = null;

    function nameForColour(hex) {
        if (!hex || hex[0] !== '#') return undefined;
        if (!tokenIndex) {
            tokenIndex = {};
            const all = tokens();
            Object.keys(all).forEach((n) => {
                const h = all[n].hex;
                if (!h) return;
                (tokenIndex[h] = tokenIndex[h] || []).push(n);
            });
            // Ranked, because a value usually has several names and they are
            // not equally useful. #121214 answers to six, and the shortest of
            // them — "--neutral-92" — is the least informative: it is a rung
            // on a colour ramp, true of the paint and silent about the role.
            // "--background-base-lowest" is the one worth copying, because it
            // says what the surface IS, and it keeps saying it after the ramp
            // is retuned.
            //
            // So: ramp primitives last, names built on a known semantic root
            // first, and the more general of two survivors ahead of the
            // feature-specific one (--background-base-lowest over
            // --guild-profile-banner-background-default).
            const RAMP = /-\d+$/;
            const ROOT = /^--(background|bg|text|border|interactive|button|channel|panel|card|surface|content|elevation|radius|spacing|space|shadow|status|input|header|link|icon)\b/;
            const rank = (n) => (RAMP.test(n) ? 100 : 0) + (ROOT.test(n) ? 0 : 10) + n.split('-').length;
            Object.keys(tokenIndex).forEach((h) => {
                tokenIndex[h].sort((a, b) => rank(a) - rank(b) || a.length - b.length);
            });
        }
        const hit = tokenIndex[hex];
        return hit ? hit.slice(0, 3) : undefined;
    }

    window.__tokens = tokens;

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
            // x/y ride along for the cropper in pixdiff.cjs. diff.cjs only ever
            // reads w and h, so they are invisible to the comparison.
            box: { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) },
            text: (el.textContent || '').trim().slice(0, 60) || null,
            ink: ink(el)
        };
        // 'none' and 'normal' are noise for most properties and the answer for a
        // few — text-transform: none IS the finding when the other side is
        // uppercase, and its absence read as "unset" in the first diff.
        const MEANINGFUL_DEFAULT = new Set(['textTransform', 'lineHeight', 'letterSpacing', 'animationName']);

        // Two properties that every element HAS and most elements do not USE,
        // and both of them reported on every container in the sweep:
        //
        //   color            inherited and never painted, because the element
        //                    has no text of its own. The reference's columns
        //                    all carry a dark inherited colour; ours carry a
        //                    light one; neither is visible anywhere, and it
        //                    was the single most repeated row in the report.
        //   borderTopColor   the colour of a border that is not drawn.
        //
        // Reporting either is worse than saying nothing: it fills the diff with
        // rows that cannot be acted on and buries the ones that can.
        const paintsText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        const hasTopBorder = parseFloat(s.borderTopWidth) > 0;

        STYLE_KEYS.forEach((k) => {
            const v = s[k];
            if (v === undefined || v === '') return;
            if (k === 'color' && !paintsText) return;
            if (/^borderTop/.test(k) && !hasTopBorder) return;
            if (!MEANINGFUL_DEFAULT.has(k) && (v === 'normal' || v === 'none' || v === '0px')) return;
            if (/[Cc]olor$/.test(k)) {
                const hex = rgb(v);
                out[k] = hex;
                out[k + 'Lum'] = lum(v);
                // Which named token this value IS. A hex tells you what to
                // type; the name tells you what it MEANS, and whether the two
                // sides disagree about the colour or about the role.
                const named = nameForColour(hex);
                if (named) out[k + 'Token'] = named;
                return;
            }
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
        // :hover cannot be forced from inside the page, so this catches
        // JS-driven state only. Two things cover the CSS half: the stylesheet
        // read below, and — when a driver is present — force-states.cjs, which
        // forces the real pseudo-class over CDP and records `onHoverReal`.
        // Prefer that one; this stays for the paste-into-the-console path.
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
                    // Chrome gives EVERY CSSStyleRule a .cssRules list — empty
                    // unless the rule genuinely nests — and an empty list is
                    // still an object, so `if (r.cssRules)` is true for all of
                    // them. Recursing and continuing on that test walked past
                    // every style rule without ever reading its selector, and
                    // the index came out empty: 0 hover rules against a page
                    // that has 1209. Both sides reported "no hover rules",
                    // which looked like agreement and was silence.
                    //
                    // Recurse only when there is something to recurse INTO,
                    // then read this rule's own selector regardless — a nested
                    // rule has both.
                    if (r.cssRules && r.cssRules.length) walk(r.cssRules);
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

    // The elements the last sweep resolved, by name. A driver that can reach
    // into the page — Playwright, or anything else speaking CDP — needs a
    // handle on the very same element the sweep measured in order to force a
    // pseudo-class on it and measure again. Re-running the finder would risk
    // resolving something else.
    window.__specEls = {};
    window.__snapEl = function (name) { return snap(window.__specEls[name]); };

    window.__spec = function (targets, opts) {
        opts = opts || {};
        const out = { at: new Date().toISOString(), viewport: { w: innerWidth, h: innerHeight }, components: {} };
        window.__specEls = {};
        Object.keys(targets).forEach((name) => {
            const el = resolve(targets[name]);
            if (!el) { out.components[name] = { missing: true }; return; }
            window.__specEls[name] = el;
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
        // Thousands of entries, so it is opt-in and the capture scripts write
        // it to its own file rather than swelling every component sweep.
        if (opts.tokens) out.tokens = tokens();
        return out;
    };

    return 'probe ready';
}());
