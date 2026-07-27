// electron-builder afterPack hook: flip Electron "fuses" (package-time feature
// toggles baked into the ScarmVoice binary) to disable powerful capabilities the
// app never uses. This closes the main "living off the land" attack surface —
// nobody can coerce the shipped .exe into running as a bare Node interpreter or
// having a debugger attached to read the session cookie / voice tokens out of
// memory.
//
// Only fuses that CANNOT affect launch or any feature ScarmVoice uses are flipped
// here. In particular EnableEmbeddedAsarIntegrityValidation is deliberately left
// alone: on an unsigned build with electron-updater it can cause launch failures,
// which isn't worth the trade-off. See https://electronjs.org/docs/latest/tutorial/fuses
const path = require('path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

// electron-builder calls this with a context object.
module.exports = async function afterPack(context) {
    const { appOutDir, packager, electronPlatformName } = context;

    const ext = { darwin: '.app', win32: '.exe', linux: '' }[electronPlatformName] || '';
    const binary = path.join(appOutDir, `${packager.appInfo.productFilename}${ext}`);

    await flipFuses(binary, {
        version: FuseVersion.V1,
        // Flipping a fuse rewrites the binary, which invalidates the ad-hoc
        // signature macOS gives it — on Apple Silicon the app then refuses to
        // launch. Windows-only today, but the darwin branch above means a mac
        // build would hit this the moment anyone tried one.
        resetAdHocDarwinSignature: electronPlatformName === 'darwin',
        // ELECTRON_RUN_AS_NODE — makes the .exe run as plain Node.js. The app
        // never spawns a child process at all (the elevation probe is a readdir,
        // see main.js), so nothing depends on it and disabling is safe.
        [FuseV1Options.RunAsNode]: false,
        // NODE_OPTIONS / NODE_EXTRA_CA_CERTS env vars — unused; deny injection.
        [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
        // --inspect / --inspect-brk / SIGUSR1 debugger attach — deny.
        [FuseV1Options.EnableNodeCliInspectArguments]: false,
        // Only load app code from app.asar (never a loose ./app dir or default_app).
        [FuseV1Options.OnlyLoadAppFromAsar]: true
    });

    console.log(`[fuses] hardened ${path.basename(binary)} (RunAsNode/NodeOptions/NodeCliInspect off, OnlyLoadAppFromAsar on)`);
};
