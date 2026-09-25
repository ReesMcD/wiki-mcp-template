import { createMcpHandler } from '@modelcontextprotocol/server';
import { isAuthorized, wikiFromEnv } from '../src/env.js';
import { createServer } from '../src/server.js';
import type { Wiki } from '../src/wiki.js';

// Module scope survives between requests on a warm instance, so the page
// index is only rebuilt when the repo actually changes.
let wiki: Wiki | undefined;
const handler = createMcpHandler(() => createServer((wiki ??= wikiFromEnv())), { responseMode: 'json' });

async function serve(request: Request): Promise<Response> {
    const secret = process.env.MCP_SECRET?.trim();
    if (!secret || secret.length < 24) return new Response('Server misconfigured: set MCP_SECRET (24+ characters).', { status: 500 });
    if (!isAuthorized(request, secret)) return new Response('Not found', { status: 404 });
    return handler.fetch(request);
}

export const GET = serve;
export const POST = serve;
export const DELETE = serve;
