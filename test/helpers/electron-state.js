// Shared, mutable state for the fake `electron` module (test/stubs/electron.cjs).
//
// It hangs off globalThis so the test file and the stub agree on one object no
// matter which loads first, and so it survives vi.resetModules().
export const electronState = (globalThis.__ELECTRON_STUB__ ||= {
    userDataDir: '',
    encryptionAvailable: true
});
