// Local HTTP server for testing: `npm run dev` (reads .env-style vars from the shell).
// Uses the local checkout unless GITHUB_TOKEN and WIKI_REPO are set.
import { createServer as createHttpServer } from 'node:http';
import path from 'node:path';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { wikiFromEnv } from './env.js';
import { createServer } from './server.js';
import { FsStore } from './store.js';
import { Wiki } from './wiki.js';

const wiki = process.env.GITHUB_TOKEN && process.env.WIKI_REPO ? wikiFromEnv() : new Wiki(new FsStore(path.resolve(process.env.WIKI_ROOT ?? path.join(import.meta.dirname, '../..'))), { timeZone: process.env.WIKI_TIMEZONE || undefined });
const handler = createMcpHandler(() => createServer(wiki), { responseMode: 'json' });
const port = Number(process.env.PORT ?? 3333);
createHttpServer(toNodeHandler(handler)).listen(port, () => console.log(`Wiki MCP server on http://localhost:${port}/mcp`));
