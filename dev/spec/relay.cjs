// A loopback relay, so the reference capture never travels through a clipboard.
//
//   node dev/spec/relay.cjs        # then run the snippet below in the page
//
// This is the second way to remove the manual step, and the one that works
// against a browser you are ALREADY signed in to without restarting it or
// creating a second profile. capture-ref.cjs is the first and the better one;
// use this when attaching a driver is inconvenient.
//
// The README recorded the constraint as:
//
//   "Discord's CSP blocks a remote <script> and a fetch to localhost"
//
// Half of that holds. Measured against the live app:
//
//   <script src="http://127.0.0.1:8799/probe.js">   BLOCKED   (script-src)
//   fetch("http://127.0.0.1:8799/probe.js")         200, 10793 chars
//
// script-src governs what the page may EXECUTE and it does block the tag. But
// code injected by an extension — or by anything driving the tab from outside,
// which is the only context this is ever run from — does not inherit the
// page's connect-src for its own fetches. So the probe can be pulled in and
// the result pushed back out, and nothing has to be pasted in either
// direction. That matters beyond convenience: a 20KB spec that goes through a
// human is a spec that arrives truncated, and the thin first capture is what
// that looks like.
//
// Loopback only, GET is confined to this directory, and the only thing it will
// write is out/<name>.json.
const http = require('http');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const OUT = path.join(DIR, 'out');
// Deliberately NOT 8799: capture-app.cjs serves the harness there. Sharing the
// port meant whichever bound first answered, the harness fetch 404'd against
// this server, and the app capture hung on HARNESS_READY with no hint as to
// why — a failure that looks like a broken harness and is a busy socket.
const PORT = Number(process.env.SPEC_RELAY_PORT || 8798);

const server = http.createServer((req, res) => {
    // The page's origin is discord.com, so the fetch is cross-origin and needs
    // this to read a response or post one back.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    const url = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'POST') {
        // A spec is small; the cap is only here so a stuck client cannot grow
        // the heap without bound.
        let body = '';
        let over = false;
        req.on('data', (c) => {
            body += c;
            if (body.length > 8e6 && !over) { over = true; res.writeHead(413); res.end('too large'); req.destroy(); }
        });
        req.on('end', () => {
            if (over) return;
            const name = (url.searchParams.get('name') || 'discord').replace(/[^a-z0-9._-]/gi, '');
            try {
                JSON.parse(body);                        // refuse to save a truncated capture
            } catch (e) {
                res.writeHead(400); return res.end('not valid JSON — capture was truncated');
            }
            fs.mkdirSync(OUT, { recursive: true });
            const file = path.join(OUT, name + '.json');
            fs.writeFileSync(file, body);
            console.log('saved out/' + name + '.json — ' + body.length + ' bytes');
            res.writeHead(200); res.end('ok');
        });
        return;
    }

    const file = path.join(DIR, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
    if (!file.startsWith(DIR)) { res.writeHead(403); return res.end('outside dev/spec'); }
    fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        res.end(data);
    });
});

server.listen(PORT, '127.0.0.1', () => {
    console.log('relay on http://127.0.0.1:' + PORT + ' — serving dev/spec, saving to dev/spec/out');
    console.log('\nrun this in the reference tab (a server channel, not Friends):\n');
    console.log("  const B='http://127.0.0.1:" + PORT + "';");
    console.log("  (0,eval)(await (await fetch(B+'/probe.js')).text());");
    console.log("  (0,eval)(await (await fetch(B+'/targets.js')).text());");
    console.log("  const s=window.__spec(window.__targets.discord);");
    console.log("  s.meta={source:'discord',url:location.href,theme:(document.documentElement.className.match(/theme-(\\w+)/)||[])[1]};");
    console.log("  await fetch(B+'/save',{method:'POST',body:JSON.stringify(s)});\n");
});
