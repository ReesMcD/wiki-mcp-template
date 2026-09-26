import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createServer } from '../src/server.js';
import { GitHubStore, type Store } from '../src/store.js';
import { Wiki } from '../src/wiki.js';
import { fixtureWiki } from './helpers.js';

/** Wrap a store so every call can be made to fail, like GitHub being down. */
function flaky(store: Store) {
    const state = { down: false };
    const guard =
        <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
        async (...a: A): Promise<R> => {
            if (state.down) throw new Error('GitHub is down (503)');
            return fn(...a);
        };
    const wrapped: Store = {
        head: guard(() => store.head()),
        snapshot: guard(() => store.snapshot()),
        readFile: guard(p => store.readFile(p)),
        writeFile: guard((p, t, m, s) => store.writeFile(p, t, m, s)),
        commitFiles: guard((f, m) => store.commitFiles(f, m)),
        recentChanges: guard(n => store.recentChanges(n)),
        history: guard((p, n) => store.history(p, n)),
        readFileAt: guard((p, r) => store.readFileAt(p, r))
    };
    return { state, store: wrapped };
}

async function connect(wiki: Wiki) {
    const handler = createMcpHandler(() => createServer(wiki), { responseMode: 'json' });
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL('https://wiki.example/mcp'), { fetch: (url, init) => handler.fetch(new Request(url, init)) }));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
        const res = await client.callTool({ name, arguments: args });
        return { text: (res.content as Array<{ text: string }>)[0].text, isError: !!res.isError };
    };
    return { client, call };
}

test('an outage after loading serves the last good copy, says so, and recovers', async () => {
    const base = fixtureWiki();
    const { state, store } = flaky(base.store);
    const wiki = new Wiki(store, { timeZone: 'UTC', freshnessMs: 0 });
    const { call } = await connect(wiki);
    assert.match((await call('wiki_lookup', { name: 'Ada' })).text, /Ada Lovelace/);

    state.down = true;
    assert.match((await call('wiki_lookup', { name: 'Ada' })).text, /Ada Lovelace/);
    assert.match((await call('wiki_overview')).text, /Can't reach the wiki's repo right now[\s\S]*GitHub is down/);
    assert.match((await call('wiki_health')).text, /Store problem \(serving the last good copy/);
    const write = await call('wiki_log', { text: 'during the outage' });
    assert.ok(write.isError);
    assert.match(write.text, /GitHub is down/);

    state.down = false;
    assert.doesNotMatch((await call('wiki_health')).text, /Store problem/);
    assert.match((await call('wiki_log', { text: 'back again' })).text, /Logged 1 line/);
});

test('an outage on a cold start still connects; each call explains the problem', async () => {
    const { state, store } = flaky(fixtureWiki().store);
    state.down = true;
    const wiki = new Wiki(store, { timeZone: 'UTC', freshnessMs: 0 });
    const { client, call } = await connect(wiki);
    assert.ok((await client.listTools()).tools.some(t => t.name === 'wiki_lookup'));
    const res = await call('wiki_lookup', { name: 'Ada' });
    assert.ok(res.isError);
    assert.match(res.text, /Couldn't load the wiki: GitHub is down/);

    state.down = false;
    assert.match((await call('wiki_lookup', { name: 'Ada' })).text, /Ada Lovelace/);
});

test('GitHub token and repo mistakes get plain-English errors', async () => {
    const store = (status: number, headers: Record<string, string> = {}) =>
        new GitHubStore({ owner: 'me', repo: 'wiki', branch: 'main', token: 't', fetch: (async () => new Response('{}', { status, headers })) as typeof fetch });
    await assert.rejects(store(401).head(), /GITHUB_TOKEN \(401\).*expired or been revoked/);
    await assert.rejects(store(404).head(), /can't find me\/wiki on branch "main".*WIKI_REPO/);
    await assert.rejects(store(403, { 'x-ratelimit-remaining': '0' }).head(), /rate limit/);
    await assert.rejects(store(401).readFile('a.md'), /GITHUB_TOKEN/);
});
