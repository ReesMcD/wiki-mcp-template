// Serve the local checkout over stdio (Claude Desktop, Claude Code and other local MCP clients).
// Edits are written to disk; Obsidian Git (or you) commits and pushes them.
import path from 'node:path';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.js';
import { FsStore } from './store.js';
import { Wiki } from './wiki.js';

const root = path.resolve(process.env.WIKI_ROOT ?? path.join(import.meta.dirname, '../..'));
const wiki = new Wiki(new FsStore(root), { timeZone: process.env.WIKI_TIMEZONE || undefined });
serveStdio(() => createServer(wiki));
