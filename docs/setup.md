# Setup

About 30 minutes, one time. You'll end up with:

- a private GitHub repo holding your wiki as Markdown
- a small MCP server on Vercel's free tier that lets Claude search, read and edit it
- a claude.ai Project wired to that server (works on web, desktop and phone)
- Obsidian on desktop and/or iPhone syncing the same repo

```
        claude.ai Project / Claude Desktop / mobile / Cowork
                            │  wiki_* tools (custom connector)
                            ▼
              MCP server on Vercel  (this repo's mcp/)
                            │  GitHub API: read tarball, commit edits
                            ▼
                GitHub repo (Markdown) ← source of truth
                            ▲
              ┌─────────────┴─────────────┐
        Obsidian desktop            Obsidian iOS
        (Obsidian Git)              (GitSync / Working Copy)
```

## 1. Create your repo from the template
On GitHub, open this template and click **Use this template → Create a new repository**. Make it **private** (it's your wiki). Then edit `wiki.config.yaml` in your new repo: at least `name`, `description` and `timezone`. Everything else can wait (see [customize.md](customize.md)).

## 2. Create a GitHub token
GitHub → Settings → Developer settings → **Fine-grained personal access tokens** → *Generate new token*:
- **Repository access:** only your new wiki repo
- **Permissions:** Contents → **Read and write** (Metadata read-only is added automatically)
- **Expiration:** as long as you're comfortable with. Put a reminder in your calendar to rotate it.

## 3. Make a connector secret
Any random string of 24+ characters, e.g. `openssl rand -hex 24` or your password manager's generator. It ends up in the connector URL, so treat that URL like a password.

## 4. Deploy the server to Vercel
Vercel → **Add New… → Project** → import your wiki repo:
- **Root Directory:** `mcp`
- **Framework Preset:** Other (leave the build settings empty)
- **Environment Variables:**

| Name | Value |
|---|---|
| `GITHUB_TOKEN` | the token from step 2 |
| `WIKI_REPO` | `your-name/your-wiki` |
| `WIKI_BRANCH` | `main` |
| `MCP_SECRET` | the secret from step 3 |
| `WIKI_TIMEZONE` | *(optional)* overrides `timezone` in `wiki.config.yaml` |

Deploy. `mcp/vercel.json` has an *ignored build step*, so Vercel only redeploys when something in `mcp/` changes, not on every wiki edit. Changes to `wiki.config.yaml` don't need a redeploy either: the server re-reads it whenever the repo changes.

If requests get a 401 or a Vercel login page, turn off *Deployment Protection* for production in the project settings.

## 5. Add the connector to Claude
claude.ai → **Settings → Connectors → Add custom connector**:
- **Name:** whatever you like, e.g. `My Wiki`
- **URL:** `https://<your-project>.vercel.app/mcp/<MCP_SECRET>`
- Leave the OAuth fields empty.

Connectors added on claude.ai are also available in the Claude desktop and mobile apps.

## 6. Create the Project
claude.ai → **Projects → New project** → paste [`../claude/project-instructions.md`](../claude/project-instructions.md) into the project instructions (edit the first paragraph to say what your wiki is for). In a chat, enable the connector from the tools menu. The first time each tool runs, choose **Always allow** so quick lookups and logs don't prompt you.

Try: *"what's in the wiki?"*, then *"log: set up my wiki"*, then *"person: Ada Lovelace, mathematician I'm reading about"*.

## 7. Obsidian
**Desktop:** clone the repo and open the folder as a vault. Install the community plugin **Obsidian Git**, and turn on *auto pull on startup* and *auto commit-and-sync* (every 5 minutes works well). The vault already has sensible settings in `.obsidian/`:
- `[[wikilinks]]`, attachments in `_assets/`, links updated on rename
- **Templates** core plugin pointed at `_templates/` (same templates the server uses)
- **Daily notes** core plugin writing to `Log/YYYY-MM-DD` with `_templates/log.md`, so "Open today's daily note" opens the same file `wiki_log` appends to
- `mcp/`, `claude/`, `docs/` and the repo docs hidden from search and the graph

**iPhone:** Obsidian iOS plus **GitSync** (free) syncing the vault folder, or **Working Copy** as a fallback. Skip the Obsidian Git plugin on iOS; its own docs call the mobile version unstable.

**Conflicts** are rare: the server makes small, targeted commits, logs are append-only, and Obsidian Git pulls before it pushes.

## 8. Optional: local and other clients
The same server runs locally over stdio against your checkout (edits go straight to disk, and Obsidian Git commits them):

- **Claude Code:** `.mcp.json` in this repo already registers it as `wiki`. Run `cd mcp && npm install` once; Claude Code asks to approve the server the first time.
- **Claude Desktop** (or any stdio MCP client): add to its config file
  ```json
  {
    "mcpServers": {
      "wiki": { "command": "npm", "args": ["run", "--silent", "--prefix", "/absolute/path/to/your-wiki/mcp", "stdio"] }
    }
  }
  ```
  Or just use the remote connector from step 5, which Claude Desktop picks up automatically.
- **Cowork:** use the connector, or point it at your local clone.

## 9. Optional: a read-only website
[Quartz](https://quartz.jzhao.xyz/) can build a site from the repo (free on Vercel or Cloudflare Pages, works with a private repo). Exclude `Private/` and anything else private if you share it.

## Maintenance
- Rotate the GitHub token before it expires (update `GITHUB_TOKEN` in Vercel, then redeploy).
- Ask Claude to "tidy up" now and then: it runs `wiki_health` and fixes broken links, orphans and missing summaries.
