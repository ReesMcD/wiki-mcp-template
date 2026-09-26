# Customizing your wiki

Almost everything is set in [`wiki.config.yaml`](../wiki.config.yaml) at the repo root. The MCP server re-reads it whenever the repo changes, so an edit (from Obsidian, GitHub or anywhere) takes effect on the next request. You don't need to redeploy.

If the file has a mistake, the server keeps running on its built-in defaults, and `wiki_health` (or asking Claude to "tidy up") tells you what's wrong.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `name` | `My Wiki` | Shown to Claude when it connects; also the server's id (`my-wiki`) |
| `description` | *(one line)* | What the wiki is for. Claude reads this first, so make it specific. |
| `timezone` | `UTC` | IANA name (`America/New_York`) for log dates and timestamps |
| `dashboard` | `Dashboard.md` | The live "right now" page `wiki_overview` returns first. `null` for none. |
| `log.folder` | `Log` | Where `wiki_log` writes `YYYY-MM-DD.md` |
| `log.dayStartHour` | `4` | Notes before this hour go to the previous day's log. `0` = midnight. |
| `inbox` | `Inbox` | Folder `wiki_health` reports as waiting to be filed. `null` for none. |
| `defaultFolder` | `Inbox` | Where pages of an unlisted type go |
| `types` | note, person, project, topic, source, draft | Page types, see below |
| `private` | see below | What counts as private |
| `exclude` | README, CLAUDE, LICENSE, `claude/`, `docs/` | Files, or folders ending in `/`, that aren't wiki pages |
| `instructions` | *(none)* | Extra guidance appended to the instructions Claude sees |

Missing settings keep their defaults. `log` and `private` merge key by key, so `private: { lineMarker: "(secret)" }` changes only the marker.

Always skipped, whatever the config says: dotfolders (`.obsidian/`, `.github/`), folders starting with `_` (`_templates/`, `_assets/`), and `mcp/`.

## Page types
Each type has a folder and, optionally, a description (helps Claude pick the right type) and `standalone: true` (the page doesn't need anything linking to it, so `wiki_health` won't call it an orphan).

```yaml
types:
  recipe:
    folder: Recipes
    description: A dish I cook, with ingredients and steps
  meeting:
    folder: Meetings
    description: Notes from one meeting
    standalone: true
```

**To add a type:** add it under `types:` **and** add `_templates/<type>.md`. The template is used both by Obsidian's *Insert template* and by `wiki_create`. It supports `{{title}}`, `{{date}}`, `{{time}}` and `{{summary}}`, and `<!-- hint comments -->` that Obsidian hides and the server strips. Give it at least:

```markdown
---
type: recipe
aliases: []
tags: []
---
**{{summary}}**

## Ingredients

## Steps

## Private Notes
```

Replacing `types:` replaces the whole list, so copy the defaults you want to keep. A page's type comes from its `type:` frontmatter; pages without one get the type whose folder they're in (subfolders included), or `page`.

Built-in types that need no config: `hub` (navigation pages like `Home.md`), `dashboard` and `log`. None of them are ever reported as orphans.

## Private material
Claude sees everything. Private material is stripped only when a tool is called with `public_only: true`, which the Project instructions tell Claude to do for anything you'll share.

```yaml
private:
  folders: [Private]                   # every page under these folders
  frontmatter: { visibility: private } # pages with this frontmatter value
  headings: [Private, Private Notes]   # "## Private Notes" sections, including subsections
  lineMarker: "(private)"              # any line containing this text (case-insensitive)
```

Obsidian `%%comments%%` are always private. Headings match whole words, so `Private` also covers `## Private: money` but not `## Privateer`. New sections added by Claude go above a page's private section, so private notes stay at the bottom.

This is a convenience, not security: anyone with access to the repo or the connector URL can read everything.

## Folders and pages
- Rename or add content folders freely; just keep `types`, `log.folder`, `inbox` and `private.folders` pointing at the right places.
- `Home.md` and `Dashboard.md` are ordinary pages. Edit them to fit your wiki.
- If you rename folders, update `.obsidian/daily-notes.json` (log folder) and the conventions in `claude/project-instructions.md`.

## Claude's behavior
Two places shape how Claude uses the wiki:
1. **`claude/project-instructions.md`**, pasted into the claude.ai Project: modes, shortcuts (`log:`, `person:`), workflows (process the log, weekly review, brainstorm → publish). Change these freely: they're just a prompt. Re-paste into the Project after editing.
2. **`instructions:` in `wiki.config.yaml`**: short, always-on rules that should apply in every client (Project, plain chat, Desktop, Claude Code), e.g. "Client pages live under Projects/Clients/".

## Changing the server
The server is plain TypeScript in `mcp/`. Run `npm test && npm run typecheck` before pushing; the GitHub Actions workflow runs the same checks.

The workflow also runs when you change `wiki.config.yaml` or `_templates/`, and checks your setup: the config is valid, every type has a template, and every template has a `type:`. The server's own tests use a separate copy of the skeleton (`mcp/test/fixtures/`), so customizing your wiki never breaks them. If you change tool names or behavior, update `claude/project-instructions.md` and the tool table in `mcp/README.md`.

## Getting template updates
Repos made from a GitHub template don't stay linked to it. To pull in later improvements, commit your work and run:

```bash
scripts/update-from-template.sh
```

It fetches the template and merges only what changed there since your wiki was created: pages you deleted stay deleted and your settings stay yours. (The first time, it finds the template version your wiki started from and links the two histories, so git knows what's new.) If you changed a file the template also changed, it lists the conflicts and how to finish or undo (`git merge --abort`). Afterwards run `cd mcp && npm install && npm test`, then push.

`TEMPLATE_URL` and `TEMPLATE_BRANCH` point it at a fork or another branch.
