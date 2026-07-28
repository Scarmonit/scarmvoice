// Scenes: put the reference into a state, then let the probe measure it.
//
// The README lists this as a standing limitation —
//
//   "Anything off screen. A menu has to be opened before it can be measured."
//
// — and it is the expensive one. The shell is seven components and was
// described once. The cost has always been everything that is not on screen at
// rest: the right-click menu, the profile popover, the message hover toolbar,
// the pinned list, every tooltip, the settings tree. Each of those has been
// opened by hand, looked at, and written down in prose, once per round.
//
// A scene opens it instead, and then it is just another capture.
//
// Discord's class names are hashed and rotate on every deploy, so nothing here
// selects on one. ARIA labels and roles are what the accessibility tree needs
// to keep stable, and they have outlived several redesigns.
//
// Every scene returns true only if it can confirm the thing actually opened.
// A scene that silently fails produces a spec full of `missing` and wastes a
// round, so failure is reported loudly instead.

const OPEN_WAIT = 900;

// Discord labels the same control differently depending on its state — the
// member-list toggle is "Hide Member List" when the list is already showing.
// Matching a list of alternatives keeps a scene from breaking on the state it
// happens to find.
async function clickLabelled(page, patterns, opts) {
    opts = opts || {};
    const handle = await page.evaluateHandle((pats) => {
        const rx = pats.map((p) => new RegExp(p, 'i'));
        const cands = [...document.querySelectorAll('[aria-label],[role="button"],button')];
        return cands.find((el) => {
            const label = el.getAttribute('aria-label') || el.textContent || '';
            if (!rx.some((r) => r.test(label.trim()))) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        }) || null;
    }, patterns);

    const el = handle.asElement();
    if (!el) return false;
    await el.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(opts.wait || OPEN_WAIT);
    return true;
}

// Did a layer actually appear? Discord renders menus, popovers and modals into
// a portal at the end of <body>, which is the one structural fact about them
// that has not changed.
function layerPresent(page, role) {
    return page.evaluate((r) => {
        const sel = r ? '[role="' + r + '"]' : '[role="menu"],[role="dialog"],[role="tooltip"]';
        return [...document.querySelectorAll(sel)].some((e) => {
            const b = e.getBoundingClientRect();
            return b.width > 20 && b.height > 20;
        });
    }, role);
}

async function lastMessage(page) {
    const h = await page.evaluateHandle(() => {
        const msgs = [...document.querySelectorAll('[id^="chat-messages-"], li[id^="chat-messages-"]')];
        return msgs[msgs.length - 1] || [...document.querySelectorAll('[id^="message-content-"]')].pop() || null;
    });
    return h.asElement();
}

const scenes = {
    // The member list is a panel, not a layer — it may simply be toggled off,
    // which is exactly why the first sweep reported memberList as missing and
    // nobody could tell whether that meant "absent" or "hidden".
    async members(page) {
        const showing = await page.evaluate(() =>
            !!document.querySelector('[aria-label="Hide Member List"], [aria-label*="Members" i][aria-expanded="true"]'));
        if (!showing) await clickLabelled(page, ['^Show Member List$', '^Members$']);
        return page.evaluate(() => [...document.querySelectorAll('div,aside')].some((e) => {
            const r = e.getBoundingClientRect();
            return r.x > innerWidth * 0.6 && r.width > 200 && r.width < 320 && r.height > innerHeight * 0.5;
        }));
    },

    // The hover toolbar over a message. Needs a real pointer move — this is
    // the one state that genuinely cannot be reached without a mouse.
    async messageActions(page) {
        const msg = await lastMessage(page);
        if (!msg) return false;
        const box = await msg.boundingBox();
        if (!box) return false;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(400);
        // Nudge: a single move can land between React's enter and leave.
        await page.mouse.move(box.x + box.width / 2 + 4, box.y + box.height / 2);
        await page.waitForTimeout(OPEN_WAIT);
        return page.evaluate(() => !!document.querySelector('[aria-label="Message Actions"], [class*="buttonContainer"] [role="button"]'));
    },

    async contextMenu(page) {
        const msg = await lastMessage(page);
        if (!msg) return false;
        const box = await msg.boundingBox();
        if (!box) return false;
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
        await page.waitForTimeout(OPEN_WAIT);
        return layerPresent(page, 'menu');
    },

    // The profile popover, opened off a message author rather than the member
    // list so the scene works whether or not the member list is showing.
    async userCard(page) {
        const h = await page.evaluateHandle(() => document.querySelector('[class*="username"]'));
        const el = h.asElement();
        if (!el) return false;
        await el.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(OPEN_WAIT);
        return layerPresent(page, 'dialog');
    },

    async pinned(page) {
        await clickLabelled(page, ['^Pinned Messages$']);
        return layerPresent(page);
    },

    async threads(page) {
        await clickLabelled(page, ['^Threads$']);
        return layerPresent(page);
    },

    async emojiPicker(page) {
        await clickLabelled(page, ['^Select emoji$', '^Emoji$'], { wait: 1200 });
        return page.evaluate(() => !!document.querySelector('[class*="emojiPicker"], [role="dialog"] [role="tablist"]'));
    },

    // A tooltip is pure hover, and it is the thing most often described in
    // prose ("it says Mute on hover") when it could just be read.
    async tooltip(page) {
        const h = await page.evaluateHandle(() =>
            document.querySelector('[aria-label="Pinned Messages"], [aria-label="Threads"], [aria-label*="Member List"]'));
        const el = h.asElement();
        if (!el) return false;
        const box = await el.boundingBox();
        if (!box) return false;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(1100);                 // Discord delays tooltips
        return layerPresent(page, 'tooltip');
    },

    async settings(page) {
        await clickLabelled(page, ['^User Settings$', '^Settings$'], { wait: 1600 });
        return page.evaluate(() => !!document.querySelector('[class*="sidebarRegion"], [role="tablist"][aria-orientation="vertical"]'));
    },

    async search(page) {
        const ok = await clickLabelled(page, ['^Search$'], { wait: 700 });
        if (!ok) return false;
        return page.evaluate(() => !!document.querySelector('[role="combobox"], input[placeholder*="Search" i]'));
    }
};

module.exports = scenes;
