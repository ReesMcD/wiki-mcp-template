import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { isAuthorized } from '../src/env.js';
import { createServer } from '../src/server.js';
import { fixtureWiki } from './helpers.js';

function setup() {
    const { wiki, root } = fixtureWiki();
    const handler = createMcpHandler(() => createServer(wiki), { responseMode: 'json' });
    return { handler, root };
}

async function rpc(handler: ReturnType<typeof setup>['handler'], body: unknown, protocolVersion?: string) {
    const res = await handler.fetch(
        new Request('https://wiki.example/mcp', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
                ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {})
            },
            body: JSON.stringify(body)
        })
    );
    const raw = await res.text();
    // Stateless legacy responses may come back as a single SSE event.
    const json = raw.startsWith('event:') || raw.startsWith('data:') ? raw.split('\n').find(l => l.startsWith('data:'))!.slice(5) : raw;
    return { status: res.status, body: JSON.parse(json) };
}

test('2025-era clients (stateless JSON-RPC) can list and call tools', async () => {
    const { handler } = setup();
    const init = await rpc(handler, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai', version: '1' } }
    });
    assert.equal(init.status, 200);
    assert.equal(init.body.result.serverInfo.name, 'my-wiki');
    assert.match(init.body.result.instructions, /^My Wiki: A personal knowledge wiki/);
    assert.match(init.body.result.instructions, /source → Sources\//);

    const tools = await rpc(handler, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, '2025-06-18');
    const names = tools.body.result.tools.map((t: { name: string }) => t.name).sort();
    assert.deepEqual(names, ['wiki_create', 'wiki_health', 'wiki_history', 'wiki_list', 'wiki_log', 'wiki_lookup', 'wiki_move', 'wiki_overview', 'wiki_publish', 'wiki_read', 'wiki_recent_changes', 'wiki_search', 'wiki_update']);
    const lookupTool = tools.body.result.tools.find((t: { name: string }) => t.name === 'wiki_lookup');
    assert.equal(lookupTool.inputSchema.type, 'object');
    assert.equal(lookupTool.annotations.readOnlyHint, true);

    const create = tools.body.result.tools.find((t: { name: string }) => t.name === 'wiki_create');
    assert.match(create.description, /person → People\//);
    assert.match(create.inputSchema.properties.type.description, /note, person, project, topic, source, draft/);

    const call = await rpc(handler, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'wiki_lookup', arguments: { name: 'the countess' } } }, '2025-06-18');
    const text = call.body.result.content[0].text as string;
    assert.match(text, /\[\[Ada Lovelace\]\] \(person\)/);
    assert.match(text, /owes me a reply/);
    assert.match(text, /Linked from: .*Analytical Engine/);
});

test('current SDK client works end to end, including writes and errors', async () => {
    const { handler } = setup();
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(
        new StreamableHTTPClientTransport(new URL('https://wiki.example/mcp'), {
            fetch: (url, init) => handler.fetch(new Request(url, init))
        })
    );
    const call = async (name: string, args: Record<string, unknown>) => {
        const res = await client.callTool({ name, arguments: args });
        return { text: (res.content as Array<{ text: string }>)[0].text, isError: !!res.isError };
    };

    assert.match((await call('wiki_log', { text: 'Met Grace at the conference' })).text, /Logged 1 line\(s\) to Log\/2026-09-27.md/);
    assert.match((await call('wiki_create', { type: 'person', name: 'Grace', summary: 'Compiler pioneer', frontmatter: { related: ['[[Analytical Engine]]'] } })).text, /Created \[\[Grace\]\] at People\/Grace.md/);
    const dup = await call('wiki_create', { type: 'person', name: 'Grace', summary: 'again' });
    assert.ok(dup.isError);
    assert.match(dup.text, /already exists/);

    assert.match((await call('wiki_list', { type: 'person', links_to: 'Analytical Engine' })).text, /\[\[Grace\]\]/);
    assert.match((await call('wiki_search', { query: 'compiler' })).text, /\[\[Grace\]\]/);
    assert.match((await call('wiki_update', { name: 'Grace', frontmatter: { status: 'archived' }, message: 'Grace retires' })).text, /Updated \[\[Grace\]\]/);
    assert.match((await call('wiki_read', { name: 'Grace' })).text, /status: archived/);

    const shared = await call('wiki_read', { name: 'Ada', public_only: true });
    assert.doesNotMatch(shared.text, /Project Babbage|London/);
    assert.match((await call('wiki_read', { name: 'Ada' })).text, /Project Babbage/);
    // Unknown arguments are rejected rather than ignored, so a wrong name for public_only can't leak.
    const typo = await call('wiki_read', { name: 'Ada', publicOnly: true });
    assert.ok(typo.isError);
    assert.doesNotMatch(typo.text, /Project Babbage/);
    const badOp = await call('wiki_publish', { pages: [{ action: 'update', name: 'Ada', content: 'x' }], message: 'm', dry_run: true });
    assert.ok(badOp.isError);
    const hidden = await call('wiki_read', { name: 'Surprise Party', public_only: true });
    assert.ok(hidden.isError);
    assert.match((await call('wiki_lookup', { name: 'Surprise Party' })).text, /Private page\./);

    const missing = await call('wiki_lookup', { name: 'Charles Babbage' });
    assert.match(missing.text, /No page named "Charles Babbage"[\s\S]*Analytical Engine/);

    const overview = await call('wiki_overview', {});
    assert.match(overview.text, /## Dashboard\n---\ntype: dashboard/);
    assert.match(overview.text, /person \(2\): Ada Lovelace \[active\], Grace \[archived\]/);
    assert.match(overview.text, /## Page types you can create\nnote → Notes\//);
    assert.match(overview.text, /not processed yet/);
    assert.doesNotMatch((await call('wiki_overview', { public_only: true })).text, /Surprise Party/);

    assert.match((await call('wiki_health', {})).text, /\[\[Analytical Society\]\]/);
    assert.match((await call('wiki_recent_changes', {})).text, /Grace retires/);

    const batch = [
        { action: 'create', type: 'topic', name: 'Compilers', summary: 'Programs that translate programs' },
        { action: 'update', name: 'Grace', sections: [{ heading: 'Notes', content: '- Wrote the first [[Compilers|compiler]]' }] }
    ];
    const preview = await call('wiki_publish', { pages: batch, message: 'Add Compilers', dry_run: true });
    assert.match(preview.text, /PREVIEW \(nothing written yet\): 1 new page\(s\), 1 edit\(s\)/);
    assert.match(preview.text, /\+ NEW topic: \[\[Compilers\]\] → Topics\/Compilers.md/);
    assert.match(preview.text, /~ EDIT \[\[Grace\]\].*\+1 \/ -0 lines[\s\S]*\+ - Wrote the first \[\[Compilers\|compiler\]\]/);
    assert.match((await call('wiki_lookup', { name: 'Compilers' })).text, /No page named/);
    const done = await call('wiki_publish', { pages: batch, message: 'Add Compilers', dry_run: false });
    assert.match(done.text, /Published in one commit \("Add Compilers"\): 1 new, 1 edited/);
    assert.match((await call('wiki_lookup', { name: 'Compilers' })).text, /topic/);

    const movePreview = await call('wiki_move', { name: 'Grace', new_name: 'Grace Hopper', dry_run: true });
    assert.match(movePreview.text, /PREVIEW[\s\S]*People\/Grace.md → People\/Grace Hopper.md[\s\S]*"Grace" is added to aliases/);
    assert.match((await call('wiki_move', { name: 'Grace', new_name: 'Grace Hopper', dry_run: false })).text, /Moved in one commit/);
    assert.match((await call('wiki_lookup', { name: 'Grace' })).text, /\[\[Grace Hopper\]\]/);
    const history = await call('wiki_history', { name: 'Grace Hopper' });
    assert.match(history.text, /History of \[\[Grace Hopper\]\]/);
    const graceHistory = await call('wiki_history', { name: 'People/Grace.md' });
    const firstVersion = /· ([0-9a-f]{7}) · Add person: Grace/.exec(graceHistory.text)![1];
    assert.match((await call('wiki_history', { name: 'People/Grace.md', version: firstVersion })).text, /Compiler pioneer/);
    assert.ok((await call('wiki_history', { name: 'Surprise Party', public_only: true })).isError);
    await client.close();
});

test('requests need the secret from the connector URL', () => {
    const secret = 'a'.repeat(32);
    assert.ok(isAuthorized(new Request(`https://x.vercel.app/mcp/${secret}`), secret));
    assert.ok(isAuthorized(new Request(`https://x.vercel.app/api/mcp?key=${secret}`), secret));
    assert.ok(isAuthorized(new Request('https://x.vercel.app/api/mcp', { headers: { authorization: `Bearer ${secret}` } }), secret));
    assert.ok(!isAuthorized(new Request('https://x.vercel.app/mcp/wrong'), secret));
    assert.ok(!isAuthorized(new Request('https://x.vercel.app/api/mcp'), secret));
});
