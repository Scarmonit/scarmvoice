// Real :hover and :active, measured rather than guessed.
//
// probe.js says it plainly: ":hover cannot be forced from inside the page."
// Dispatching pointerover only moves JS-driven state, and half of what makes
// Discord feel like Discord is a plain CSS `:hover` rule that no event will
// ever trigger. The probe's fallback — reading the rule text out of the
// stylesheet — proves a rule EXISTS but not what it computes to, and against
// 400-odd sheets of hashed selectors that is a long way from an answer.
//
// A driver outside the page has no such limit. CDP's CSS.forcePseudoState
// pins the pseudo-class on, and then the ordinary probe measures the hovered
// element the same way it measures everything else. So "the channel row goes
// two points brighter on hover" stops being something a person notices and
// writes down, and becomes a number on both sides.
//
// Used by both capture scripts, so the two sides stay measured identically.

// The mark is how a node found by predicate gets named to CDP. There is no
// selector for "the deepest painted div wider than 40% of the window", so the
// page tags the element it already resolved and CDP looks the tag up. It is
// removed immediately; no stylesheet on either side selects on it.
const MARK = 'data-spec-forced';

async function open(page) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    return cdp;
}

// Resolve the element the sweep stored under `name` to a CDP nodeId.
async function nodeIdFor(page, cdp, name) {
    const tagged = await page.evaluate(([n, mark]) => {
        const el = window.__specEls && window.__specEls[n];
        if (!el) return false;
        el.setAttribute(mark, '');
        return true;
    }, [name, MARK]);
    if (!tagged) return null;

    try {
        const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
        const { nodeId } = await cdp.send('DOM.querySelector', {
            nodeId: root.nodeId,
            selector: '[' + MARK + ']'
        });
        return nodeId || null;
    } catch (e) {
        return null;
    } finally {
        await page.evaluate(([n, mark]) => {
            const el = window.__specEls && window.__specEls[n];
            if (el) el.removeAttribute(mark);
        }, [name, MARK]).catch(() => {});
    }
}

// Only report what the state CHANGED. A hovered element that returns forty
// identical properties and one different background is telling us one thing,
// and the report should say one thing.
function delta(before, after) {
    if (!before || !after) return null;
    const out = {};
    Object.keys(after).forEach((k) => {
        // Position drifts under a re-render and says nothing about hover.
        if (k === 'box' || k === 'ink') return;
        if (JSON.stringify(after[k]) !== JSON.stringify(before[k])) out[k] = after[k];
    });
    return Object.keys(out).length ? out : null;
}

/**
 * Force each pseudo-class in turn and re-measure.
 *
 * @param page   Playwright page with probe.js loaded and a sweep already run
 * @param names  component names to test — must exist in window.__specEls
 * @param states pseudo-classes to force, default hover then active
 * @returns      { componentName: { hover: {...}, active: {...} } }
 */
async function forceStates(page, names, states) {
    states = states || ['hover', 'active'];
    const cdp = await open(page);
    const out = {};

    for (const name of names) {
        const nodeId = await nodeIdFor(page, cdp, name);
        if (!nodeId) continue;

        const before = await page.evaluate((n) => window.__snapEl(n), name);
        const found = {};

        for (const state of states) {
            try {
                await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [state] });
            } catch (e) {
                continue;                       // node went away under a re-render
            }
            // A forced pseudo-class repaints on the next frame; measuring in
            // the same tick reads the old value and reports "no change".
            await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
            const after = await page.evaluate((n) => window.__snapEl(n), name);
            const d = delta(before, after);
            if (d) found[state] = d;
            await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] }).catch(() => {});
        }

        if (Object.keys(found).length) out[name] = found;
    }

    await cdp.detach().catch(() => {});
    return out;
}

module.exports = { forceStates };
