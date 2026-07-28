// Stands in for the real `electron` module under test (see vitest.config.js).
//
// In a plain Node process `require('electron')` returns the *path* to the binary,
// so `const { app, safeStorage } = require('electron')` silently yields undefined
// and every call blows up. This provides just the surface the main-process
// modules actually touch.
//
// safeStorage is faked with a visible "ENC:" prefix so a test can assert the
// session never hits disk as plaintext, and so decrypting something this
// "profile" didn't encrypt throws the way DPAPI does after an app rename.
const state = (globalThis.__ELECTRON_STUB__ ||= {
    userDataDir: '',
    encryptionAvailable: true
});

module.exports = {
    app: {
        getPath: () => state.userDataDir,
        getName: () => 'ScarmVoice',
        // updater.js puts this in the User-Agent GitHub's REST API requires.
        getVersion: () => state.version || '0.0.0-test'
    },
    safeStorage: {
        isEncryptionAvailable: () => state.encryptionAvailable,
        encryptString: (s) => Buffer.from('ENC:' + s, 'utf8'),
        decryptString: (buf) => {
            const s = Buffer.from(buf).toString('utf8');
            if (!s.startsWith('ENC:')) {
                throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString');
            }
            return s.slice(4);
        }
    },
    globalShortcut: {
        register: () => false,
        unregister: () => {},
        unregisterAll: () => {}
    }
};
