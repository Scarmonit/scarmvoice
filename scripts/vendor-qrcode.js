// Copies qrcode-generator's UMD build into the renderer vendor dir (the CSP
// allows no CDN scripts). Loaded as a plain <script>, it exposes the global
// `qrcode(typeNumber, errorCorrectionLevel)` used by the 2FA setup panel.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'node_modules', 'qrcode-generator', 'dist', 'qrcode.js');
const OUT = path.join(__dirname, '..', 'src', 'renderer', 'vendor', 'qrcode.js');

if (!fs.existsSync(SRC)) {
    console.error('[vendor-qrcode] qrcode-generator is not installed — run npm install');
    process.exit(1);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.copyFileSync(SRC, OUT);
console.log('[vendor-qrcode] wrote ' + OUT);
