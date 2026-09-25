# Wiki + MCP template

A Markdown wiki you can talk to. Plain Markdown in a GitHub repo, readable and editable in Obsidian on desktop and iPhone, and searchable and editable by Claude through a small MCP server you deploy for free on Vercel.

- **Ask:** "who's Ada again?", "what did I decide about the kitchen?" → one-line answer with a link.
- **Capture:** "log: call the plumber tomorrow" → appended to today's log instantly.
- **Create:** "person: Grace Hopper, met at the conference" → a page from the right template, duplicates refused.
- **Plan:** brainstorm with Claude, then publish everything as one previewed commit.
- **Share safely:** anything marked private is stripped when Claude writes something for other people.

## Quick start
1. **Use this template** → create a new **private** repo.
2. Edit [`wiki.config.yaml`](wiki.config.yaml): name, description, time zone.
3. Deploy `mcp/` to Vercel and add it to Claude as a custom connector.
4. Create a claude.ai Project with [`claude/project-instructions.md`](claude/project-instructions.md).
5. Open the repo in Obsidian (with Obsidian Git).

Step-by-step, about 30 minutes: **[docs/setup.md](docs/setup.md)**.

## What's inside

```
├── wiki.config.yaml        # ★ settings: name, page types & folders, log, privacy
├── Home.md                 # landing page
├── Dashboard.md            # live "what's going on right now" page
├── Log/                    # daily quick-capture logs (also Obsidian's daily notes)
├── Inbox/                  # unsorted notes waiting to be filed
├── People/ Projects/ Topics/ Sources/ Notes/
├── Private/                # never shared; brainstorm drafts in Private/Drafts/
├── _templates/             # one per page type, used by Obsidian and by Claude
├── _assets/                # images and attachments
├── .obsidian/              # vault settings: wikilinks, templates, daily notes
├── .mcp.json               # the wiki tools for Claude Code (local, over stdio)
├── claude/project-instructions.md   # system prompt for the claude.ai Project
├── mcp/                    # the MCP server (TypeScript, Vercel)
└── docs/                   # setup, customization, design notes
```

## Make it yours
Page types, folders, the log, what counts as private, and extra guidance for Claude all live in `wiki.config.yaml`. The server re-reads it on every change, so no redeploy is needed. The default types (person, project, topic, source, note) are a starting point for a personal knowledge base; swap them for recipes, clients, characters, papers, whatever your wiki is about. See **[docs/customize.md](docs/customize.md)**.

## More
- [mcp/README.md](mcp/README.md): the tools, how the server works, local development
- [docs/design.md](docs/design.md): why it's built this way
