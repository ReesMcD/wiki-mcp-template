# Wiki MCP server

A small remote MCP server that lets Claude (in a claude.ai Project, chat, Claude Desktop, Cowork or mobile) search, read and edit the Markdown wiki in this repo. It reads the repo through the GitHub API and commits edits straight to your branch, so Obsidian picks them up on its next pull.

Deploying it: see [`../docs/setup.md`](../docs/setup.md). Configuring the wiki it serves: see [`../docs/customize.md`](../docs/customize.md).

## Tools

| Tool | What it's for |
|---|---|
| `wiki_lookup` | "Who/what is X?" Finds a page by name or alias (typo tolerant). Returns summary, key fields, sections and backlinks. |
| `wiki_search` | Full-text search with snippets; filter by type, folder, tag or status |
| `wiki_read` | Full page or one section, plus backlinks and links to pages that don't exist yet |
| `wiki_list` | Pages with summaries by type/folder/tag/status, or everything linking to a page |
| `wiki_overview` | The dashboard page, a map of every page grouped by type, and the page types you can create |
| `wiki_log` | Instant, append-only daily log (`Log/YYYY-MM-DD.md`) for quick capture |
| `wiki_create` | New page from `_templates/<type>.md` in the type's folder; refuses duplicate names or aliases |
| `wiki_update` | Targeted edits: frontmatter patch, find/replace, section append/replace, summary |
| `wiki_publish` | Many creates and updates as **one all-or-nothing commit**, with a `dry_run` preview (new pages plus line-level changes). Used to publish a brainstorm. |
| `wiki_recent_changes` | Latest commits, from any device |
| `wiki_health` | Config problems, broken links, orphans, missing summaries, unprocessed logs, Inbox |

Every tool that returns content accepts `public_only: true`. That strips private pages, private sections, `%%comments%%` and marked lines, as defined under `private:` in `wiki.config.yaml`.

Tool descriptions and the server's instructions are generated from `wiki.config.yaml`, so Claude always sees your wiki's name, page types and folders.

## Develop

```bash
cd mcp
npm install
npm test            # unit + end-to-end tests (no network needed)
npm run typecheck
npm run dev         # local HTTP server on :3333 over this checkout (or GitHub if GITHUB_TOKEN + WIKI_REPO are set)
npm run stdio       # serve this checkout over stdio (Claude Desktop, Claude Code)
```

`WIKI_ROOT` points `dev` and `stdio` at a different checkout. `WIKI_TIMEZONE` overrides `timezone` from the config.

| File | What's in it |
|---|---|
| `api/mcp.ts` | Vercel entry point: checks the secret, then serves MCP |
| `src/settings.ts` | `wiki.config.yaml` schema, defaults, and the rules derived from it |
| `src/wiki.ts` | The in-memory index, lookup/search, create/update/publish/log, health |
| `src/markdown.ts` | Frontmatter, links, sections, summaries, private-content stripping |
| `src/store.ts` | `GitHubStore` (deployed) and `FsStore` (local checkout, tests) |
| `src/server.ts` | The MCP tools |
| `src/env.ts` | Environment variables and the connector-URL secret |

## How it works
- On a cold start it downloads the repo tarball, reads `wiki.config.yaml`, and indexes every Markdown page: titles, aliases, frontmatter, links and summaries. Templates (`_templates/`), `_assets/`, `mcp/`, dotfolders and anything under `exclude:` are skipped.
- On warm requests it only checks the branch head (one small API call, at most every 5 seconds) and reloads the pages and the config when someone else has pushed, for example from Obsidian.
- Single writes use GitHub's Contents API with the file's SHA. If the file changed underneath, it re-reads and retries instead of overwriting.
- `wiki_publish` validates the whole batch first, then makes one commit through the Git Data API (tree → commit → fast-forward ref). If someone pushed in between, it rebuilds the plan on the new head and tries again.
- Template hint text is written as `<!-- comments -->`. Obsidian hides these, and pages created through the server drop them.
- A broken `wiki.config.yaml` never takes the server down: it falls back to the defaults and `wiki_health` reports the problem.
- Log entries written before `log.dayStartHour` count toward the previous day, so a late night stays in one log file.
