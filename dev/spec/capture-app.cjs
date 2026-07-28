// Captures a spec from OUR app, via the harness.
//
//   node dev/spec/capture-app.cjs [scene]
//
// `scene` is an optional method on window.scene in the harness — "voice",
// "members", "settings" — so states that need a live call or a live account
// can still be measured.
//
// The Discord side is captured by running the same probe in the browser that
// is signed in to it; see dev/spec/README.md. Same probe, same output shape,
// so the two are comparable by construction.
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { forceStates } = require('./force-states.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(__dirname, 'out');
const PORT = 8799;

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.wasm': 'application/wasm' };

function serve() {
    return new Promise((resolve) => {
        const s = http.createServer((req, res) => {
            const rel = decodeURIComponent(req.url.split('?')[0]);
            const file = path.join(ROOT, rel);
            // Everything served is inside the repo; nothing here is reachable
            // from outside localhost.
            if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
            fs.readFile(file, (err, data) => {
                if (err) { res.writeHead(404); return res.end('not found'); }
                res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
                res.end(data);
            });
        });
        s.listen(PORT, () => resolve(s));
    });
}

(async () => {
    const scene = process.argv[2] || null;
    const server = await serve();
    const browser = await chromium.launch({ executablePath: chromium.executablePath() });
    const page = await browser.newPage({ viewport: { width: 1364, height: 1075 }, deviceScaleFactor: 2 });
    page.on('pageerror', (e) => console.error('page error:', e.message));
    if (process.env.SPEC_VERBOSE) page.on('console', (m) => console.log('[' + m.type() + ']', m.text().slice(0, 200)));

    await page.goto(`http://127.0.0.1:${PORT}/dev/harness.html`);
    await page.waitForFunction('window.HARNESS_READY === true', null, { timeout: 20000 });
    // The entry path renders the channel list and the message column
    // asynchronously; wait for the thing we came to measure rather than a fixed
    // delay that is either too short or wasted.
    await page.waitForSelector('.chan', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(400);

    if (scene) {
        await page.evaluate((s) => {
            const [name, ...rest] = s.split(':');
            window.scene[name](rest.length ? { [rest[0]]: true } : undefined);
        }, scene);
        await page.waitForTimeout(500);
    }

    await page.addScriptTag({ path: path.join(__dirname, 'probe.js') });
    await page.addScriptTag({ path: path.join(__dirname, 'targets.js') });
    // The scene name selects the extra targets too, so both sides sweep the
    // same set of names — a scene that adds contextMenu on one side and not
    // the other produces a diff full of "MISSING" that means nothing.
    const spec = await page.evaluate((s) => window.__spec(window.__targets.for('app', s)), scene ? scene.split(':')[0] : null);

    // Real :hover and :active, forced over CDP rather than inferred. Same
    // module the reference runner uses, so the two are measured identically.
    const present = Object.entries(spec.components).filter(([, v]) => !v.missing).map(([k]) => k);
    const forced = await forceStates(page, present);
    Object.entries(forced).forEach(([name, states]) => {
        if (states.hover) spec.components[name].onHoverReal = states.hover;
        if (states.active) spec.components[name].onActiveReal = states.active;
    });
    spec.meta = { source: 'app', scene: scene || null };

    fs.mkdirSync(OUT, { recursive: true });
    const file = path.join(OUT, 'app' + (scene ? '-' + scene.replace(':', '-') : '') + '.json');
    fs.writeFileSync(file, JSON.stringify(spec, null, 1));
    const missing = Object.entries(spec.components).filter(([, v]) => v.missing).map(([k]) => k);
    console.log('wrote ' + path.relative(ROOT, file) + ' — ' + Object.keys(spec.components).length + ' components'
        + (missing.length ? ', missing: ' + missing.join(', ') : ''));

    await page.screenshot({ path: path.join(OUT, 'app' + (scene ? '-' + scene.replace(':', '-') : '') + '.png') });

    const tokenSet = await page.evaluate(() => window.__tokens());
    fs.writeFileSync(path.join(OUT, 'app' + (scene ? '-' + scene.replace(':', '-') : '') + '-tokens.json'),
        JSON.stringify(tokenSet, null, 1));
    console.log('wrote ' + Object.keys(tokenSet).length + ' of our own tokens beside it');
    await browser.close();
    server.close();
})();
