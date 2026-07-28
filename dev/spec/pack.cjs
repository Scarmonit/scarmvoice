// Builds the one-line payload for the reference side.
//
// The signed-in browser is the only place Discord can be measured, and its CSP
// blocks both a remote <script> and a fetch to localhost — so the probe has to
// arrive as literal source in the evaluate call. Comments are stripped for
// transport only; dev/spec/probe.js stays the source of truth.
const fs = require('fs');
const path = require('path');
const strip = (s) => s
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
const out = strip(fs.readFileSync(path.join(__dirname, 'probe.js'), 'utf8'))
    + '\n' + strip(fs.readFileSync(path.join(__dirname, 'targets.js'), 'utf8'))
    + '\nJSON.stringify(window.__spec(window.__targets.for("discord", null)));';
fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'out', '_payload.js'), out);
console.log(out.length + ' chars');
