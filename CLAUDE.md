# CLAUDE.md

This repo is a Markdown wiki (Obsidian-style) with git as the source of truth. Claude mostly reaches it through the MCP server in `mcp/`, connected to a claude.ai Project. Claude Code sessions here are usually about **structure and tooling**, not content.

## Layout
- `wiki.config.yaml`: the wiki's settings (name, page types and their folders, log, private rules, excludes). The server re-reads it on every repo change; no redeploy needed.
- Content folders: `Dashboard.md` (live "what's going on" page), `Home.md`, `Log/` (daily quick-capture logs), `Inbox/`, `Notes/`, `People/`, `Projects/`, `Topics/`, `Sources/`, `Private/` (never shared; drafts in `Private/Drafts/`).
- `_templates/`: one template per page type, used by both Obsidian and `wiki_create`. Supports `{{title}}`, `{{date}}`, `{{time}}` and `{{summary}}`. `_templates/log.md` is also Obsidian's daily-note template.
- `mcp/`: the remote MCP server (TypeScript, deployed on Vercel). See `mcp/README.md`.
- `claude/project-instructions.md`: the system prompt for the claude.ai Project. Keep it in sync when tools or conventions change.
- `docs/`: setup, customization and design notes.
- `scripts/update-from-template.sh`: merges newer template changes into a wiki made from it.
- `.github/workflows/site.yml`: optional public website. `mcp/src/export.ts` (`npm run export`) writes the public-only copy that Quartz builds.
- `.claude/`: a SessionStart hook that installs `mcp/` dependencies in Claude Code on the web.

## Content conventions (for anyone editing pages)
- Frontmatter (`type`, `aliases`, `status`, links as quoted `"[[Page]]"`), then a **bold one-line summary**, then `## Sections`.
- Private material goes in `Private/`, `visibility: private`, a `## Private Notes` section, `%%comments%%`, or a line containing `(private)` (all configurable in `wiki.config.yaml`).
- Never delete pages; use `status: archived`.

## Working on the MCP server
- `cd mcp && npm test && npm run typecheck` before pushing.
- Nothing about the wiki's structure is hard-coded: types, folders, log location and private rules come from `wiki.config.yaml` (`mcp/src/settings.ts` holds the schema and defaults).
- Server tests use their own wiki skeleton in `mcp/test/fixtures/` (a copy of the template's original config, templates, Home and Dashboard), so customizing this repo never breaks them. `DEFAULT_CONFIG` must match `mcp/test/fixtures/wiki.config.yaml`; a test checks this.
- `mcp/test/repo.test.ts` is the one test that reads this repo's own setup: the config is valid, every type has a template, every template has a `type`.
- To add a page type: add it under `types:` in `wiki.config.yaml` and add `_templates/<type>.md`.
- Changing tool names or behavior means updating `claude/project-instructions.md` and the tool table in `mcp/README.md`.
