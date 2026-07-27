// Persistent logging.
//
// A packaged Electron app has nowhere to put console output: there is no
// attached terminal, so every console.info in this codebase — the voice roster
// diagnostics, the share bitrate reports, the realtime socket's liveness
// warnings — vanishes the moment it is written. That is precisely the
// information needed to explain a bug someone hit an hour ago.
//
// So the console methods are wrapped: they still do what they always did, and
// additionally append a timestamped line to a log file in userData. Rotation is
// size-based with a single previous generation kept, which is enough to cover a
// session without letting the file grow without bound.
const fs = require('fs');
const path = require('path');
const { app, crashReporter, shell } = require('electron');

const MAX_BYTES = 2 * 1024 * 1024;   // rotate at 2 MB
const LEVELS = ['log', 'info', 'warn', 'error', 'debug'];

let dir = null;
let file = null;
let stream = null;
let bytes = 0;
let installed = false;

function logDir() {
    return dir;
}

function stamp() {
    // Local time, no date: the file is per-session and the header carries the
    // date. Shorter lines are easier to scan.
    const d = new Date();
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

// console.log's own formatting is in C++ and not reachable, so approximate it:
// strings pass through, everything else is JSON where possible.
function fmt(arg) {
    if (typeof arg === 'string') return arg;
    if (arg instanceof Error) return arg.stack || arg.message;
    try {
        return JSON.stringify(arg);
    } catch (e) {
        return String(arg);
    }
}

function rotate() {
    // The rename must wait for the fd to actually close: stream.end() flushes
    // and closes asynchronously, and Windows refuses to rename a file that is
    // still open — renaming in the same tick fails with EPERM every time,
    // which silently disabled rotation entirely.
    bytes = 0;
    const s = stream;
    stream = null;   // lines during the swap are dropped; that beats a giant log
    // Guarded because both paths below can reach it: if s.end() throws we call
    // finish() synchronously, and the 'close' listener can still fire after.
    // Running twice would open a second write stream and orphan the first fd.
    let done = false;
    const finish = () => {
        if (done) return;
        done = true;
        try {
            const old = file + '.1';
            try { fs.unlinkSync(old); } catch (e) { /* no previous generation */ }
            fs.renameSync(file, old);
        } catch (e) { /* rotation is best effort — keep logging either way */ }
        open();
    };
    if (s) {
        s.once('close', finish);
        try { s.end(); } catch (e) { finish(); }
    } else {
        finish();
    }
}

function open() {
    try {
        stream = fs.createWriteStream(file, { flags: 'a' });
        // A write error (disk full, file locked) must never take down the app,
        // and must never re-enter the console wrapper.
        stream.on('error', () => { stream = null; });
    } catch (e) {
        stream = null;
    }
}

function write(line) {
    if (!stream) return;
    try {
        stream.write(line);
        bytes += Buffer.byteLength(line);
        if (bytes >= MAX_BYTES) rotate();
    } catch (e) { /* dropped line; not worth crashing over */ }
}

// Wrap the console so existing call sites keep working unchanged.
function install() {
    if (installed) return;
    installed = true;

    dir = path.join(app.getPath('userData'), 'logs');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* fall through */ }
    file = path.join(dir, 'main.log');
    try { bytes = fs.statSync(file).size; } catch (e) { bytes = 0; }
    open();

    write(`\n=== ScarmVoice ${app.getVersion()} — ${new Date().toISOString()} ` +
        `(electron ${process.versions.electron}, ${process.platform} ${process.arch}) ===\n`);

    LEVELS.forEach((level) => {
        const original = console[level] ? console[level].bind(console) : () => {};
        console[level] = (...args) => {
            original(...args);
            write(`${stamp()} [${level}] ${args.map(fmt).join(' ')}\n`);
        };
    });

    // Anything that escapes a handler entirely. Without this the process can die
    // (or, worse, limp on) leaving no trace of why.
    process.on('uncaughtException', (err) => {
        console.error('[fatal] uncaught exception:', err && (err.stack || err.message));
    });
    process.on('unhandledRejection', (reason) => {
        console.error('[fatal] unhandled rejection:', reason instanceof Error
            ? (reason.stack || reason.message) : fmt(reason));
    });

    // Native crashes (a renderer or GPU process dying) never reach JavaScript.
    // Minidumps land beside the logs; uploadToServer stays off because there is
    // no endpoint to receive them — they're for the user to attach to a report.
    try {
        crashReporter.start({ submitURL: '', uploadToServer: false, compress: true });
    } catch (e) {
        console.warn('[log] crashReporter unavailable:', e.message);
    }
    pruneCrashDumps();
}

// With uploadToServer off, nothing ever collects the minidumps Crashpad writes,
// and each is typically several MB. In an app that lives in the tray for weeks,
// a renderer that dies repeatedly quietly fills the disk. The log file itself is
// already bounded (MAX_BYTES + one generation); this gives the dumps the same
// treatment — keep the newest few, which is all anyone attaches to a report.
const KEEP_DUMPS = 5;

function pruneCrashDumps() {
    let dumpDir;
    try {
        dumpDir = path.join(app.getPath('crashDumps'), 'reports');
    } catch (e) { return; }

    let entries;
    try {
        entries = fs.readdirSync(dumpDir)
            .filter((n) => n.endsWith('.dmp'))
            .map((n) => {
                const p = path.join(dumpDir, n);
                try { return { p, at: fs.statSync(p).mtimeMs }; } catch (e2) { return null; }
            })
            .filter(Boolean)
            .sort((a, b) => b.at - a.at);
    } catch (e) { return; }   // no reports directory yet — nothing to do

    if (entries.length <= KEEP_DUMPS) return;
    let removed = 0;
    entries.slice(KEEP_DUMPS).forEach((e) => {
        try { fs.unlinkSync(e.p); removed++; } catch (e2) { /* locked — next launch */ }
    });
    if (removed) console.log(`[log] pruned ${removed} old crash dump(s)`);
}

function openFolder() {
    if (!dir) return false;
    shell.openPath(dir);
    return true;
}

function close() {
    try { if (stream) stream.end(); } catch (e) {}
    stream = null;
}

module.exports = { install, openFolder, logDir, close, MAX_BYTES };
