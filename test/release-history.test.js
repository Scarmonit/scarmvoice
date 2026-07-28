// The release history behind Settings > About.
//
// Two halves, tested separately: updater.history() turns GitHub's answer into
// the block model (sorting, filtering, failure), and the About pane turns that
// into one collapsible section per version.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadMain, resetMainModules } from './helpers/load.js';

const body = (s) => s;

// A page of releases in the shape the REST API returns.
const PAGE = [
    { tag_name: 'v0.9.0', name: '0.9.0', draft: false, prerelease: false, published_at: '2026-07-01T00:00:00Z', body: body('**Voice**\n\n- Something older\n') },
    { tag_name: 'v0.10.0', name: 'A named one', draft: false, prerelease: false, published_at: '2026-07-05T00:00:00Z', body: body('**Messages**\n\nA paragraph about it.\n') },
    { tag_name: 'v0.10.1', name: '', draft: true, prerelease: false, published_at: null, body: body('never published') },
    { tag_name: 'v0.11.0-rc', name: 'Trying something', draft: false, prerelease: true, published_at: '2026-07-06T00:00:00Z', body: body('- a bullet\n') }
];

function stubFetch(impl) { globalThis.fetch = vi.fn(impl); }

let updater;

beforeEach(() => {
    resetMainModules();
    updater = loadMain('updater.js');
});

describe('updater.history()', () => {
    it('parses every published release, newest first', async () => {
        stubFetch(async () => ({ ok: true, status: 200, json: async () => PAGE }));
        const res = await updater.history();

        expect(res.ok).toBe(true);
        // 0.10.0 must outrank 0.9.0 — a string compare puts them the other way,
        // which is exactly the bug a version list invites.
        expect(res.releases.map((r) => r.version)).toEqual(['0.11.0-rc', '0.10.0', '0.9.0']);
        // The draft is not published; nobody running this build can have it.
        expect(res.releases.some((r) => r.version === '0.10.1')).toBe(false);
        expect(res.releases[0].prerelease).toBe(true);
        // Bodies come back as the block model, not as markup.
        const named = res.releases.find((r) => r.version === '0.10.0');
        expect(named.blocks[0]).toEqual({ t: 'h', text: 'Messages' });
        expect(named.title).toBe('A named one');
    });

    it('sends the User-Agent GitHub refuses to answer without', async () => {
        stubFetch(async () => ({ ok: true, status: 200, json: async () => [] }));
        await updater.history();
        const [, opts] = globalThis.fetch.mock.calls[0];
        expect(opts.headers['User-Agent']).toMatch(/^ScarmVoice\//);
    });

    it('asks once per session and serves the rest from memory', async () => {
        stubFetch(async () => ({ ok: true, status: 200, json: async () => PAGE }));
        await updater.history();
        await updater.history();
        expect(globalThis.fetch.mock.calls.length).toBe(1);
        // …unless the retry button asks it to go again.
        await updater.history(true);
        expect(globalThis.fetch.mock.calls.length).toBe(2);
    });

    it('names the rate limit rather than blaming the network', async () => {
        stubFetch(async () => ({ ok: false, status: 403, body: null }));
        const res = await updater.history();
        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/rate limit/i);
        expect(res.releases).toEqual([]);
    });

    it('survives being offline', async () => {
        stubFetch(async () => { throw new Error('getaddrinfo ENOTFOUND'); });
        const res = await updater.history();
        expect(res.ok).toBe(false);
        expect(res.releases).toEqual([]);
        // A failure must not be cached as though it were an answer.
        stubFetch(async () => ({ ok: true, status: 200, json: async () => PAGE }));
        expect((await updater.history()).ok).toBe(true);
    });
});
