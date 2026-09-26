# Design notes

Why the template is built the way it is.

## The goal
A wiki you mostly **talk to**. You open Claude, ask a question or jot something down, and get an answer in seconds, from your phone as easily as your desk. You can still browse and edit by hand in Obsidian, and upkeep stays close to zero.

That splits into two kinds of use:
- **Quick** (speed matters most): "who's Ada again?", "log: call the plumber", "person: Grace, met at the conference". One tool call, short answer, instant write.
- **Deep** (quality matters most): process the day's log into proper pages, weekly reviews, research and planning sessions that end in a batch of new, linked pages.

## Choices

**Markdown in git is the source of truth.** Obsidian-style `[[wikilinks]]`, YAML frontmatter, one page per thing. It's portable, works offline in Obsidian, and git history is the changelog and undo button.

**A custom MCP server instead of GitHub's own.** A claude.ai Project's built-in GitHub knowledge is a read-only snapshot you re-sync by hand, so it can't take live updates. GitHub's official MCP server can write, but its search knows nothing about aliases, frontmatter or summaries, and every edit takes several calls. This server is built for the job: alias- and typo-tolerant lookup, one-call logging, templates, duplicate checks, all-or-nothing batch publishing, and a public-only mode.

**No index file to maintain.** The server indexes every page (title, aliases, frontmatter, summary line, links) in memory from the repo tarball, and only reloads when the branch head moves.

**Every page opens with a one-line bold summary.** It's what lookups, search results and lists show, so most quick answers come from it without reading the page.

**Config lives in the repo, not the deployment.** `wiki.config.yaml` sits next to the content and is re-read on every change, so reshaping the wiki (new types, folders, privacy rules) is an edit in Obsidian, not a redeploy. A bad config falls back to defaults instead of breaking the connector.

**Capture fast, tidy later.** `wiki_log` appends to a daily file with no questions asked. Filing it into proper pages is a separate, deliberate step ("process the log"), where quality matters more than speed.

**Brainstorm, then publish once.** Open-ended planning reads freely but writes nothing until you say publish; then everything lands as one previewed commit through `wiki_publish`. No half-written wikis from abandoned ideas.

**Never delete.** Pages are archived (`status: archived`) rather than removed, and edits are targeted (frontmatter patch, one section, find/replace) rather than full rewrites. Renames go through `wiki_move`, which fixes every link and keeps the old name as an alias, so nothing ends up orphaned.

**Degrade, don't break.** If GitHub is unreachable or the token has expired, the connector keeps answering from the last copy it loaded and says so, instead of failing to connect.

**Public is opt-in and derived.** The optional website is built from an export that applies the same private rules as `public_only`, so there's no second list of what to hide.

**Auth is a secret in the connector URL.** It's the simplest thing claude.ai custom connectors accept for a personal server. It can be upgraded to OAuth later if the wiki is ever shared.

## Where things run
- **claude.ai Project** (web, desktop, mobile): the home base for quick and deep use.
- **Cowork / Claude Desktop**: long batch jobs through the same connector, or against a local clone.
- **Claude Code**: changing the structure, templates and server. `.mcp.json` also gives it the wiki tools locally.
- **Obsidian** (desktop via Obsidian Git, iPhone via GitSync): reading and hand-editing.
