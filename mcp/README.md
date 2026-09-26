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
| `wiki_move` | Rename a page and/or move it to another folder, rewriting every link to it, in **one commit** with a `dry_run` preview. The old title stays as an alias. |
| `wiki_history` | Commits that changed one page; pass a `version` to read it as it was. Works with a moved page's old path. |
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
npm run export -- ../_site-preview   # write the public-only copy the website is built from
```

Tests run against their own wiki skeleton in `test/fixtures/`, not this repo's content. `test/repo.test.ts` is the exception: it checks this repo's `wiki.config.yaml` and `_templates/`.

`WIKI_ROOT` points `dev` and `stdio` at a different checkout. `WIKI_TIMEZONE` overrides `timezone` from the config.

| File | What's in it |
|---|---|
| `api/mcp.ts` | Vercel entry point: checks the secret, then serves MCP |
| `src/settings.ts` | `wiki.config.yaml` schema, defaults, and the rules derived from it |
| `src/wiki.ts` | The in-memory index, lookup/search, create/update/publish/move/log, history, health |
| `src/markdown.ts` | Frontmatter, links, sections, summaries, private-content stripping |
| `src/store.ts` | `GitHubStore` (deployed) and `FsStore` (local checkout, tests) |
| `src/server.ts` | The MCP tools |
| `src/env.ts` | Environment variables and the connector-URL secret |
| `src/export.ts` | `npm run export`: the public-only copy for the website |
| `src/dev.ts`, `src/stdio.ts` | Local HTTP and stdio servers over a checkout |

## How it works
- On a cold start it downloads the repo tarball, reads `wiki.config.yaml`, and indexes every Markdown page: titles, aliases, frontmatter, links and summaries. Templates (`_templates/`), `_assets/`, `mcp/`, dotfolders and anything under `exclude:` are skipped.
- On warm requests it only checks the branch head (one small API call, at most every 5 seconds) and reloads the pages and the config when someone else has pushed, for example from Obsidian.
- Single writes use GitHub's Contents API with the file's SHA. If the file changed underneath, it re-reads and retries instead of overwriting.
- `wiki_publish` and `wiki_move` validate everything first, then make one commit through the Git Data API (tree → commit → fast-forward ref; a move deletes the old file in the same tree). If someone pushed in between, they rebuild the plan on the new head and try again.
- If GitHub can't be reached (an outage, or an expired token), the server keeps answering from the last copy it loaded and says so in `wiki_overview` and `wiki_health`; edits fail until it's back. On a cold start it still connects, and each tool call explains the problem.
- `wiki_history` reads GitHub's per-file history. Run locally (`dev`/`stdio`), it only knows the edits made since that process started.
- Template hint text is written as `<!-- comments -->`. Obsidian hides these, and pages created through the server drop them.
- A broken `wiki.config.yaml` never takes the server down: it falls back to the defaults and `wiki_health` reports the problem.
- Log entries written before `log.dayStartHour` count toward the previous day, so a late night stays in one log file.
