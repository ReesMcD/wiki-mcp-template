import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { createTar } from 'nanotar';

const secret = 's'.repeat(32);
process.env.MCP_SECRET = secret;
process.env.WIKI_REPO = 'owner/repo';
process.env.GITHUB_TOKEN = 'unused';

// A one-page repo on a fake GitHub, with a wiki.config.yaml that names the wiki.
const tarball = gzipSync(createTar([{ name: 'owner-repo-abc/Home.md', data: '**Home.**\n' }]));
globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/git/ref/heads/main')) return Response.json({ object: { sha: 'abc' } });
    if (url.endsWith('/tarball/abc')) return new Response(tarball);
    if (url.includes('/contents/wiki.config.yaml')) return Response.json({ type: 'file', sha: 'c', content: Buffer.from('name: Team Wiki\n').toString('base64') });
    throw new Error(`unexpected fetch ${url}`);
}) as typeof fetch;

const { POST } = await import('../api/mcp.js');

const init = (url: string) =>
    POST(
        new Request(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })
        })
    );

test('Vercel entry point: secret URL required, then serves MCP named after the config', async () => {
    assert.equal((await init('https://x.vercel.app/mcp/wrong-secret')).status, 404);
    const ok = await init(`https://x.vercel.app/api/mcp?key=${secret}`);
    assert.equal(ok.status, 200);
    const body = await ok.text();
    assert.match(body, /"name":"team-wiki"/);
    assert.match(body, /Team Wiki: A personal knowledge wiki/);
});
