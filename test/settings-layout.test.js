// Where things live in the Settings sheet, and what is no longer there at all.
//
// Static, against the markup: the settings nav is BUILT from the sections' own
// <h3>s, so which section a control sits in is decided by nothing but where it
// appears in this file — and a control that moves house leaves no trace in any
// behavioural test.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
const appjs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');

// The slice of markup belonging to the settings section headed `title`, up to
// the next section.
function section(title) {
    const at = html.indexOf('<h3>' + title + '</h3>');
    expect(at, 'no settings section headed ' + title).toBeGreaterThan(-1);
    const next = html.indexOf('<section class="set-group"', at);
    return html.slice(at, next === -1 ? html.length : next);
}

describe('signing out', () => {
    it('lives under Account', () => {
        expect(section('Account')).toContain('id="btn-logout"');
    });

    it('is not under About, where it used to be', () => {
        // About is otherwise pure information; the most consequential button in
        // the sheet had no business being the only control in it.
        expect(section('About')).not.toContain('btn-logout');
    });

    it('is wired exactly once', () => {
        expect(html.split('id="btn-logout"').length - 1).toBe(1);
    });
});

describe('the server URL', () => {
    // It decided which host receives the session cookie AND the account token,
    // both bearer-equivalent. There is one server, and no field can name another.
    it('cannot be edited from Behaviour', () => {
        expect(section('Behaviour')).not.toContain('set-base');
    });

    it('cannot be edited from the sign-in card either', () => {
        expect(html).not.toContain('login-base');
        expect(html).not.toContain('login-advanced');
    });

    it('leaves nothing behind in the renderer', () => {
        // A $('set-base') with no element throws on the line that reads it, and
        // openSettings() would take the whole sheet down with it.
        expect(appjs).not.toContain("'set-base'");
        expect(appjs).not.toContain("'login-base'");
        expect(appjs).not.toContain("'login-advanced'");
    });
});

describe('updates', () => {
    it('are checked for from About, with the version and the notes', () => {
        const about = section('About');
        expect(about).toContain('id="btn-check-update"');
        expect(about).toContain('id="release-history"');
        expect(about).toContain('id="set-version"');
    });

    it('are not configured from Behaviour any more', () => {
        // Behaviour is how the app behaves; an update is not a behaviour you
        // configure, it is something that happens to the app.
        expect(section('Behaviour')).not.toContain('btn-check-update');
    });

    it('link out to the full history, since only the recent ones are listed', () => {
        const about = section('About');
        expect(about).toContain('github.com/Scarmonit/scarmvoice/releases');
        expect(appjs).toContain('const HISTORY_SHOWN = 10;');
    });
});

describe('settings durability', () => {
    const mainjs = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
    const updaterjs = fs.readFileSync(path.join(ROOT, 'src', 'main', 'updater.js'), 'utf8');
    const storejs = fs.readFileSync(path.join(ROOT, 'src', 'main', 'store.js'), 'utf8');

    it('flushes before handing the app to the installer', () => {
        // Writes are debounced 250ms; the NSIS updater allows about a second
        // and then force-kills, and a force-kill runs no 'will-quit'. That is
        // how a setting changed shortly before an update came back as its
        // default.
        const at = updaterjs.indexOf('function installNow');
        expect(at).toBeGreaterThan(-1);
        expect(updaterjs.slice(at, at + 900)).toContain('store.flush()');
    });

    it('flushes on the way out and on the way to the background', () => {
        expect(mainjs).toMatch(/before-quit[\s\S]{0,400}store\.flush\(\)/);
        expect(mainjs).toMatch(/win\.on\('blur'[\s\S]{0,400}store\.flush\(\)/);
        expect(mainjs).toContain("win.on('hide', () => store.flush());");
    });

    it('declares a default for every setting the app writes', () => {
        // A key the app writes but DEFAULTS does not name has no defined
        // default at all — "the default" becomes whatever undefined happens to
        // mean at each call site.
        expect(storejs).toMatch(/^\s*catDmsOpen:/m);
        expect(storejs).toMatch(/^\s*noiseSuppressionAI:/m);
    });
});

describe('the profile picture limit', () => {
    it('is 5 MB on the client', () => {
        expect(appjs).toContain('const AVATAR_MAX_BYTES = 5 * 1024 * 1024;');
    });

    it('says so where the picture is chosen', () => {
        // The hint is the only place anybody learns the limit before hitting it.
        expect(html).toContain('up to 5 MB');
        expect(html).not.toContain('up to 512 KB');
    });
});

describe('the installer', () => {
    it('has a header script that puts the version in its title bar', () => {
        // electron-builder picks build/installer.nsh up automatically. The
        // download filename must stay stable (releases/latest/download resolves
        // to it), so the title bar is where the version has to go.
        const nsh = fs.readFileSync(path.join(ROOT, 'build', 'installer.nsh'), 'utf8');
        expect(nsh).toMatch(/Caption\s+"\$\{PRODUCT_NAME\} \$\{VERSION\}/);
        // Not applied to the uninstaller pass, which would then call itself Setup.
        expect(nsh).toContain('!ifndef BUILD_UNINSTALLER');
    });
});
