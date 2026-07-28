// Captures a spec from the REFERENCE, automatically.
//
//   node dev/spec/capture-ref.cjs [scene]
//
// The old README ended with an apology:
//
//   "Discord's CSP blocks a remote <script> and a fetch to localhost, so the
//    payload has to arrive as literal source. That is the one manual step
//    left."
//
// It is not a step any more. Content-Security-Policy governs what the PAGE may
// load; it has nothing to say about what a driver attached to the browser may
// evaluate. page.evaluate() goes over CDP, the same channel DevTools uses, and
// is not subject to the page's policy — so probe.js is read off disk in node
// and handed straight to the page. Nothing is fetched, so nothing is blocked.
//
// That the manual step existed is visible in the output it produced: the
// pasted discord.json carried a box and a background colour per component,
// while our side carried luminance, ink extent, font metrics, tooltips, hover
// deltas and glyph geometry. A capture nobody enjoys running is a capture that
// gets run once, shallowly.
//
// Connecting: two ways, tried in order.
//
//   1. An already-running Chrome with a debugging port open. Reuses the
//      session you are signed in to — nothing to log into, and no copy of
//      your credentials anywhere. Start it with:
//        chrome.exe --remote-debugging-port=9222
//   2. A dedicated profile under dev/spec/.profile. The first run opens
//      headed so you can sign in once by hand; every run after reuses it.
//
// Signing in is yours to do in the browser window either way. This script
// never handles a password.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { forceStates } = require('./force-states.cjs');
const scenes = require('./scenes.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(__dirname, 'out');
const PROFILE = path.join(__dirname, '.profile');
const CDP_URL = process.env.SPEC_CDP || 'http://127.0.0.1:9222';
const VIEWPORT = { width: 1364, height: 1075 };
const START = process.env.SPEC_DISCORD_URL || 'https://discord.com/app';

const isDiscord = (u) => /^https:\/\/(\w+\.)?discord\.com\//.test(u || '');
// A channel inside a server. The finders are written against that layout, and
// "@me" is the Friends list, which has no member list, no channel header and a
// differently-shaped sidebar — it silently produces a spec full of nulls.
const isChannel = (u) => /discord\.com\/channels\/\d+\/\d+/.test(u || '');

async function connect() {
    try {
        const browser = await chromium.connectOverCDP(CDP_URL);
        const ctx = browser.contexts()[0];
        if (ctx) {
            console.log('attached to the running Chrome on ' + CDP_URL);
            return { browser, ctx, attached: true };
        }
        await browser.close().catch(() => {});
    } catch (e) {
        // Nothing listening: fall through to the dedicated profile.
    }
    console.log('no debuggable Chrome on ' + CDP_URL + ' — using ' + path.relative(ROOT, PROFILE));

    // Installed Chrome first, bundled Chromium as the fallback: the reference
    // is a media app and installed Chrome carries the proprietary codecs the
    // bundle leaves out. Both were observed loading it without complaint.
    const opts = {
        headless: false,
        viewport: VIEWPORT,
        deviceScaleFactor: 2,
        // Kept bare on purpose. Media flags to pre-empt the microphone prompt
        // were tried and removed again: the capture only ever measures the
        // shell, never joins a call, so there is no prompt to pre-empt and no
        // reason to carry flags nobody can account for later.
        args: ['--disable-blink-features=AutomationControlled']
    };
    for (const channel of ['chrome', 'msedge', undefined]) {
        try {
            const ctx = await chromium.launchPersistentContext(PROFILE, channel ? { ...opts, channel } : opts);
            if (channel) console.log('launched installed ' + channel);
            return { browser: null, ctx, attached: false };
        } catch (e) {
            if (channel === undefined) throw e;
        }
    }
}

// Prefer a tab already sitting on a channel, then any Discord tab, then the
// blank one a fresh context always opens with, and only then a new one.
//
// Without that third case this opened a SECOND tab every run — a persistent
// context starts on about:blank, which is neither a channel nor Discord, so it
// fell straight through to newPage() and left the blank one behind.
async function findPage(ctx) {
    const pages = ctx.pages();
    return pages.find((p) => isChannel(p.url()))
        || pages.find((p) => isDiscord(p.url()))
        || pages.find((p) => p.url() === 'about:blank' || p.url() === '')
        || (await ctx.newPage());
}

async function waitForSignIn(page) {
    if (isChannel(page.url())) return true;
    if (!isDiscord(page.url())) await page.goto(START, { waitUntil: 'domcontentloaded' });

    // Said once each, when the condition is first SEEN — not on a fixed
    // iteration. Pinning the sign-in notice to i === 0 meant it never printed:
    // at the first poll the tab is still on /app and only redirects to /login a
    // few seconds later, so the run sat silent for its full five minutes with
    // the reason on screen in a window and nothing on the console.
    let saidLogin = false, saidFriends = false;

    for (let i = 0; i < 150; i++) {                       // up to five minutes
        if (isChannel(page.url())) return true;
        const state = await page.evaluate(() => ({
            login: /\/login|\/register/.test(location.pathname),
            shell: !!document.querySelector('[class*="guilds"], [data-list-id="guildsnav"]')
        })).catch(() => ({}));
        if (state.login && !saidLogin) {
            saidLogin = true;
            console.log('\n  Discord is asking for a sign-in. Please sign in in the browser window.');
            console.log('  Waiting — this script does not handle credentials.\n');
        }
        if (state.shell && !isChannel(page.url()) && !saidFriends) {
            saidFriends = true;
            console.log('\n  Signed in, but this is the Friends view. Please click into a server');
            console.log('  channel — the finders need a channel layout. Waiting.\n');
        }
        try {
            await page.waitForTimeout(2000);
        } catch (e) {
            // A crashed or closed tab throws here, and an unhandled rejection
            // out of a five-minute wait loop is an unreadable way to report
            // "the browser died".
            throw new Error('the reference tab stopped responding (' + e.message.split('\n')[0] + ')');
        }
    }
    return isChannel(page.url());
}

// Things that quietly poison a capture. Each one produced a wrong number in
// the first sweep, so each one is checked rather than remembered.
async function hygiene(page) {
    return page.evaluate(() => {
        const notes = [];
        const cls = document.documentElement.className;

        const theme = (cls.match(/theme-(darker|dark|light|midnight)/) || [])[1] || 'unknown';
        // theme-darker is not theme-dark with a tweak; it is a different set of
        // surface tokens. Diffing our shell against the wrong one moves every
        // background at once and reads as "everything is off".
        if (theme !== 'dark') notes.push('theme is "' + theme + '", not the default "dark" — surface colours will differ wholesale');

        const density = (cls.match(/density-(\w+)/) || [])[1];
        if (density && density !== 'default') notes.push('message density is "' + density + '" — spacing will differ');
        const fontSize = (cls.match(/font-size-(\d+)/) || [])[1];
        if (fontSize && fontSize !== '16') notes.push('base font size is ' + fontSize + 'px, not 16px');

        // A muted mic paints the button red. Capturing it as the rest state is
        // how "the mute button is red" became a note nobody could reproduce.
        const muted = [...document.querySelectorAll('button[aria-label]')]
            .some((b) => /^unmute|^undeafen/i.test(b.getAttribute('aria-label') || ''));
        if (muted) notes.push('you are muted or deafened — the mic/headphone buttons will capture in their ACTIVE state, not at rest');

        const zoom = Math.round((window.outerWidth / window.innerWidth) * 100);
        if (window.devicePixelRatio && Math.abs(zoom - 100) > 15) notes.push('browser zoom looks like ~' + zoom + '% — every measurement scales');

        return { theme, density, fontSize, notes };
    }).catch(() => ({ notes: [] }));
}

(async () => {
    const sceneName = process.argv[2] || null;
    const { browser, ctx, attached } = await connect();
    const page = await findPage(ctx);

    if (attached) {
        // Match capture-app.cjs exactly, or the two sides are not comparable.
        const cdp = await ctx.newCDPSession(page);
        await cdp.send('Emulation.setDeviceMetricsOverride', {
            width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 2, mobile: false
        }).catch(() => {});
    }

    if (!(await waitForSignIn(page))) {
        console.error('\ngave up waiting for a Discord channel view.');
        console.error('open a server channel in the browser and run this again.');
        if (browser) await browser.close(); else await ctx.close();
        process.exit(1);
    }

    await page.waitForSelector('[id^="message-content-"]', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(600);

    const health = await hygiene(page);
    if (health.notes.length) {
        console.log('\nbefore trusting this capture:');
        health.notes.forEach((n) => console.log('  ! ' + n));
        console.log('');
    }

    if (sceneName) {
        const scene = scenes[sceneName];
        if (!scene) {
            console.error('unknown scene "' + sceneName + '". known: ' + Object.keys(scenes).join(', '));
            process.exit(2);
        }
        const ok = await scene(page);
        if (!ok) console.log('! scene "' + sceneName + '" did not fully open — components may come back missing');
        await page.waitForTimeout(500);
    }

    // The CSP workaround, in two lines: read in node, evaluate over CDP.
    await page.evaluate(fs.readFileSync(path.join(__dirname, 'probe.js'), 'utf8'));
    await page.evaluate(fs.readFileSync(path.join(__dirname, 'targets.js'), 'utf8'));

    const spec = await page.evaluate((s) => window.__spec(window.__targets.for('discord', s)), sceneName);
    spec.meta = { source: 'discord', url: page.url(), theme: health.theme, density: health.density, notes: health.notes };

    // Real pseudo-classes, on the elements the sweep just measured.
    const present = Object.entries(spec.components).filter(([, v]) => !v.missing).map(([k]) => k);
    const forced = await forceStates(page, present);
    Object.entries(forced).forEach(([name, states]) => {
        if (states.hover) spec.components[name].onHoverReal = states.hover;
        if (states.active) spec.components[name].onActiveReal = states.active;
    });

    fs.mkdirSync(OUT, { recursive: true });
    const stem = 'discord' + (sceneName ? '-' + sceneName : '');
    fs.writeFileSync(path.join(OUT, stem + '.json'), JSON.stringify(spec, null, 1));
    await page.screenshot({ path: path.join(OUT, stem + '.png') });

    // The whole token system, in its own file. This is the thing that used to
    // be transcribed a colour at a time.
    const tokenSet = await page.evaluate(() => window.__tokens());
    fs.writeFileSync(path.join(OUT, stem + '-tokens.json'), JSON.stringify(tokenSet, null, 1));
    console.log('wrote dev/spec/out/' + stem + '-tokens.json — ' + Object.keys(tokenSet).length + ' design tokens');

    const names = Object.keys(spec.components);
    const missing = names.filter((n) => spec.components[n].missing);
    console.log('wrote dev/spec/out/' + stem + '.json — ' + names.length + ' components, '
        + Object.keys(forced).length + ' with a real hover/active delta'
        + (missing.length ? ', missing: ' + missing.join(', ') : ''));

    // Leave an attached browser exactly as it was found.
    if (browser) await browser.close(); else await ctx.close();
})();
