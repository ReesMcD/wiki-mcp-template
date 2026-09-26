import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { findSection, parseFrontmatter, stripPrivate } from './markdown.js';
import { instructionsFor, slug, typeList } from './settings.js';
import { keyFields, sectionList, Wiki, WikiError, type Page, type PlanItem, type PublishOp } from './wiki.js';

const publicOnly = z
    .boolean()
    .optional()
    .describe('Hide private material (private pages and sections, %%comments%%, marked lines). Use for anything that will be shared with other people.');

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

function fail(err: unknown) {
    if (err instanceof WikiError) return { ...text(err.message), isError: true };
    throw err;
}

const link = (p: Page) => `[[${p.title}]]`;

function list(items: string[], max: number): string {
    return items.length > max ? `${items.slice(0, max).join(', ')} (+${items.length - max} more)` : items.join(', ');
}


/** Lines added/removed between two versions (multiset difference: ignores moves, fine for a preview). */
function lineDiff(before: string, after: string): { added: string[]; removed: string[] } {
    const minus = (from: string[], other: string[]) => {
        const left = new Map<string, number>();
        for (const l of other) left.set(l, (left.get(l) ?? 0) + 1);
        return from.filter(l => {
            const n = left.get(l) ?? 0;
            if (n > 0) {
                left.set(l, n - 1);
                return false;
            }
            return l.trim() !== '';
        });
    };
    const a = before.split('\n');
    const b = after.split('\n');
    return { added: minus(b, a), removed: minus(a, b) };
}

function renderPlan(plan: PlanItem[], detail: boolean): string {
    return plan
        .map(p => {
            if (p.action === 'create') {
                const head = `+ NEW ${p.type}: [[${p.title}]] → ${p.path}`;
                return detail ? `${head}\n${p.after.split('\n').map(l => `    ${l}`).join('\n')}` : head;
            }
            if (p.after === p.before) return `= no change: [[${p.title}]]`;
            const { added, removed } = lineDiff(p.before ?? '', p.after);
            const head = `~ EDIT [[${p.title}]] (${p.path}): +${added.length} / -${removed.length} lines`;
            if (!detail) return head;
            const show = (sign: string, lines: string[]) => lines.slice(0, 25).map(l => `    ${sign} ${l}`).concat(lines.length > 25 ? [`    … ${lines.length - 25} more`] : []);
            return [head, ...show('-', removed), ...show('+', added)].join('\n');
        })
        .join('\n');
}

/**
 * Build the MCP server. Tool descriptions and instructions come from
 * wiki.config.yaml, so this is async and runs once per request.
 */
export async function createServer(wiki: Wiki): Promise<McpServer> {
    // Even if GitHub is unreachable, the server comes up: tools are listed and
    // each call reports the problem, instead of the whole connector failing.
    const config = await wiki.configOrDefault();
    const types = Object.keys(config.types);
    // Tool inputs are strict objects: an unknown or misspelled argument is an
    // error Claude can see and fix, never silently dropped (a dropped
    // `public_only` would leak private material).
    const server = new McpServer({ name: slug(config.name), version: '1.0.0' }, { instructions: instructionsFor(config) });

    server.registerTool(
        'wiki_lookup',
        {
            title: 'Look up a page',
            description:
                'Fastest way to answer "who/what is X". Finds a page by name or alias (typos OK) and returns its summary, key facts, sections and what links to it. Use wiki_read for the full page.',
            inputSchema: z.strictObject({ name: z.string().describe('Page name, alias or nickname, e.g. "Ada Lovelace" or "Ada"'), public_only: publicOnly }),
            annotations: { readOnlyHint: true, openWorldHint: false }
        },
        async ({ name, public_only }) => {
            try {
                const matches = await wiki.find(name, { publicOnly: public_only });
                const top = matches[0];
                if (!top || top.score < 55) {
                    const hits = await wiki.search(name, { publicOnly: public_only, limit: 5 });
                    return text(
                        `No page named "${name}".` +
                            (hits.length ? `\nMentioned in:\n${hits.map(h => `- ${link(h.page)} (${h.page.type}): ${h.snippet}`).join('\n')}` : '\nNot mentioned anywhere in the wiki.')
                    );
                }
                const page = top.page;
                const body = wiki.bodyFor(page, !!public_only);
                const backlinks = await wiki.backlinks(page, { publicOnly: public_only });
                const lines = [
                    `${link(page)} (${page.type}) · ${page.path}`,
                    `Summary: ${wiki.summaryFor(page, !!public_only) || '(none yet)'}`
                ];
                const fields = keyFields(page, !!public_only);
                if (fields) lines.push(fields);
                if (page.aliases.length) lines.push(`Aliases: ${page.aliases.join(', ')}`);
                if (page.tags.length) lines.push(`Tags: ${page.tags.join(', ')}`);
                if (page.private) lines.push('Private page.');
                const sections = sectionList(body);
                if (sections.length) lines.push(`Sections: ${sections.join(', ')}`);
                if (backlinks.length) lines.push(`Linked from: ${list(backlinks.map(p => p.title), 12)}`);
                const others = matches.slice(1, 4).filter(m => m.score >= 55);
                if (others.length) lines.push(`Other matches: ${others.map(m => `${m.page.title} (${m.page.type})`).join(', ')}`);
                return text(lines.join('\n'));
            } catch (err) {
                return fail(err);
            }
        }
    );

    server.registerTool(
        'wiki_search',
        {
            title: 'Search the wiki',
            description:
                'Full-text search across every page (titles, aliases, frontmatter, body). Use for topics or questions ("notes on sourdough", "who did I meet at the conference"). Returns ranked pages with snippets.',
            inputSchema: z.strictObject({
                query: z.string(),
                type: z.string().optional().describe(`Only pages of this type: ${[...types, 'hub', 'log'].join(', ')}, ...`),
                folder: z.string().optional().describe('Only pages under this folder, e.g. "Projects"'),
                tag: z.string().optional(),
                status: z.string().optional().describe('e.g. active, done, someday'),
                limit: z.number().int().min(1).max(30).optional(),
                public_only: publicOnly
            }),
            annotations: { readOnlyHint: true, openWorldHint: false }
        },
        async ({ query, public_only, ...filters }) => {
            const hits = await wiki.search(query, { ...filters, publicOnly: public_only });
            if (!hits.length) return text(`Nothing in the wiki matches "${query}".`);
            return text(hits.map(h => `- ${link(h.page)} (${h.page.type}, ${h.page.path}): ${wiki.summaryFor(h.page, !!public_only)}\n  …${h.snippet}`).join('\n'));
        }
    );

    server.registerTool(
        'wiki_read',
        {
            title: 'Read a page',
            description: 'Full content of a page (or one section), plus pages that link to it and links that point at pages that don\'t exist yet.',
            inputSchema: z.strictObject({
                name: z.string().describe('Title, alias or path'),
                section: z.string().optional().describe('Only return this section, e.g. "Next Steps"'),
                public_only: publicOnly
            }),
            annotations: { readOnlyHint: true, openWorldHint: false }
        },
        async ({ name, section, public_only }) => {
            try {
                const page = await wiki.resolve(name, { publicOnly: public_only });
                let body = wiki.bodyFor(page, !!public_only);
                if (section) {
                    const s = findSection(body, section);
                    if (!s) return { ...text(`${link(page)} has no "${section}" section. Sections: ${sectionList(body).join(', ')}`), isError: true };
                    body = body.slice(s.start, s.end);
                }
                const backlinks = await wiki.backlinks(page, { publicOnly: public_only });
                const all = await wiki.pages();
                const missing = wiki.linksFor(page, !!public_only).filter(l => !all.some(p => [p.title, ...p.aliases].some(n => n.toLowerCase() === l.toLowerCase()) || p.path.replace(/\.md$/, '') === l));
                const fm = public_only ? keyFields(page, true) : (page.fmText ?? '');
                const parts = [`# ${page.title}`, `path: ${page.path}`];
                if (fm) parts.push(public_only ? fm : `---\n${fm}\n---`);
                parts.push(body.trim());
                if (backlinks.length) parts.push(`Linked from: ${list(backlinks.map(p => p.title), 25)}`);
                if (missing.length) parts.push(`Links to pages that don't exist yet: ${missing.join(', ')}`);
                return text(parts.join('\n\n'));
            } catch (err) {
                return fail(err);
            }
        }
    );

    server.registerTool(
        'wiki_list',
        {
            title: 'List pages',
            description: 'List pages with their one-line summaries, filtered by type, folder, tag, status, or pages linking to a given page. E.g. all active projects, everyone linked to a project, every source on a topic.',
            inputSchema: z.strictObject({
                type: z.string().optional(),
                folder: z.string().optional(),
                tag: z.string().optional(),
                status: z.string().optional(),
                links_to: z.string().optional().describe('Only pages that link to this page, e.g. "Kitchen Remodel"'),
                limit: z.number().int().min(1).max(500).optional().describe('Default 100'),
                public_only: publicOnly
            }),
            annotations: { readOnlyHint: true, openWorldHint: false }
        },
        async ({ links_to, limit, public_only, ...filters }) => {
            try {
                let pages = wiki.filter(await wiki.pages(), { ...filters, publicOnly: public_only });
                if (links_to) {
                    const target = await wiki.resolve(links_to, { publicOnly: public_only });
                    const linked = new Set((await wiki.backlinks(target, { publicOnly: public_only })).map(p => p.path));
                    pages = pages.filter(p => linked.has(p.path));
                }
                pages.sort((a, b) => a.path.localeCompare(b.path));
                if (!pages.length) return text('No pages match.');
                const max = limit ?? 100;
                const lines = pages.slice(0, max).map(p => {
                    const status = p.data.status ? ` [${p.data.status}]` : '';
                    return `- ${link(p)} (${p.type}${status}): ${wiki.summaryFor(p, !!public_only)}`;
                });
                if (pages.length > max) lines.push(`…and ${pages.length - max} more. Narrow the filter or raise limit.`);
                return text(`${pages.length} page(s)\n${lines.join('\n')}`);
            } catch (err) {
                return fail(err);
            }
        }
    );

    server.registerTool(
        'wiki_overview',
        {
            title: 'Wiki overview',
            description: `${config.dashboard ? 'The dashboard page plus a' : 'A'} compact map of every page title grouped by type, and the page types you can create. Call once at the start of a bigger task to orient yourself.`,
            inputSchema: z.strictObject({ public_only: publicOnly }),
            annotations: { readOnlyHint: true, openWorldHint: false }
        },
        async ({ public_only }) => {
            const pages = wiki.filter(await wiki.pages(), { publicOnly: public_only });
            const dashboard = config.dashboard ? pages.find(p => p.path === config.dashboard) : undefined;
            const byType = new Map<string, Page[]>();
            for (const p of pages) if (p.type !== 'log') byType.set(p.type, [...(byType.get(p.type) ?? []), p]);
            const logs = pages.filter(p => p.type === 'log').sort((a, b) => b.title.localeCompare(a.title));
            const { date } = wiki.today();
            const parts = [`${config.name}: ${config.description}\nToday: ${date} (${wiki.timeZone}). ${pages.length} pages.`];
            if (wiki.storeError) parts.push(`⚠ Can't reach the wiki's repo right now, so this is the last good copy and edits will fail: ${wiki.storeError}`);
            if (dashboard) {
                const fm = dashboard.fmText && !public_only ? `---\n${dashboard.fmText}\n---` : '';
                parts.push(`## ${dashboard.path.replace(/\.md$/, '')}\n${[fm, wiki.bodyFor(dashboard, !!public_only).trim()].filter(Boolean).join('\n')}`);
            }
            const map = [...byType.entries()]
                .sort((a, b) => b[1].length - a[1].length)
                .map(([type, ps]) => `- ${type} (${ps.length}): ${list(ps.map(p => (p.data.status ? `${p.title} [${p.data.status}]` : p.title)).sort(), 60)}`);
            parts.push(`## Pages by type\n${map.join('\n') || '(no pages yet)'}`);
            parts.push(`## Page types you can create\n${typeList(config)}`);
            if (logs.length) parts.push(`## Logs\n${logs.slice(0, 5).map(l => `- ${l.title}${l.data.processed === true ? '' : ' (not processed yet)'}`).join('\n')}`);
            return text(parts.join('\n\n'));
        }
    );

    server.registerTool(
        'wiki_log',
        {
            title: 'Add to today\'s log',
            description: `Instantly append timestamped notes to today's log (${config.log.folder}/YYYY-MM-DD.md). Use for quick capture: ideas, things to remember, decisions, names, links. One note per line. Don't ask follow-up questions; just log it.`,
            inputSchema: z.strictObject({
                text: z.string().describe('One or more notes, one per line'),
                date: z.string().optional().describe(`YYYY-MM-DD; defaults to today${config.log.dayStartHour ? ` (before ${config.log.dayStartHour}:00 counts as the previous day)` : ''}`)
            }),
            annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
        },
        async ({ text: note, date }) => {
            try {
                const { path, lines } = await wiki.log(note, { date });
                return text(`Logged ${lines.length} line(s) to ${path}.`);
            } catch (err) {
                return fail(err);
            }
        }
    );

    server.registerTool(
        'wiki_create',
        {
            title: 'Create a page',
            description: `Create a new page from its template (in _templates/). Refuses if the name or an alias already exists; update that page instead. Types and their folders: ${typeList(config)}. Any other type goes to ${config.defaultFolder}/. A stub with just a summary is fine.`,
            inputSchema: z.strictObject({
                type: z.string().describe(types.join(', ')),
                name: z.string().describe('Page title, e.g. "Ada Lovelace" or "Kitchen Remodel"'),
                summary: z.string().describe('One line: who/what this is and why it matters'),
                frontmatter: z.record(z.string(), z.unknown()).optional().describe('Fields to set, e.g. {"aliases": ["Ada"], "status": "active", "related": ["[[Analytical Engine]]"]}'),
                sections: z.record(z.string(), z.string()).optional().describe('Fill template sections by heading, e.g. {"Notes": "..."}'),
                body: z.string().optional().describe('Replace the whole template body instead (Markdown). The summary is kept at the top.'),
                folder: z.string().optional().describe('Override the folder, e.g. "Projects/Home"'),
                message: z.string().optional().describe('Commit message')
            }),
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
        },
        async input => {
            try {
                const page = await wiki.create(input);
                return text(`Created ${link(page)} at ${page.path}.`);
            } catch (err) {
                return fail(err);
            }
        }
    );

    server.registerTool(
        'wiki_update',
        {
            title: 'Edit a page',
            description:
                'Targeted edits to an existing page, applied in this order: frontmatter patch, find/replace, section edits, summary. Section edits create the section if it is missing. Prefer small edits over rewriting the body. Nothing is ever deleted outright: to retire a page, set status: archived and explain why in the page.',
            inputSchema: z.strictObject({
                name: z.string().describe('Title, alias or path of the page'),
                frontmatter: z.record(z.string(), z.unknown()).optional().describe('Keys to set; null removes a key. E.g. {"status": "done", "owner": "[[Ada Lovelace]]"}'),
                replace: z
                    .array(z.object({ find: z.string(), with: z.string() }))
                    .optional()
                    .describe('Exact text replacements; each find must match exactly once. E.g. ticking a checkbox "- [ ] 3." → "- [x] 3."'),
                sections: z
                    .array(z.object({ heading: z.string(), action: z.enum(['append', 'prepend', 'replace']).optional().describe('Default append'), content: z.string() }))
                    .optional(),
                summary: z.string().optional().describe('New one-line summary'),
                body: z.string().optional().describe('Replace the entire body (frontmatter is kept). Only for full rewrites.'),
                message: z.string().optional().describe('Commit message, e.g. "Kitchen Remodel: contractor chosen"')
            }),
            annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
        },
        async ({ name, message, ...edit }) => {
            try {
                const { page, changed } = await wiki.update(name, edit, message);
                return text(changed ? `Updated ${link(page)} (${page.path}).` : `No change needed to ${link(page)}.`);
            } catch (err) {
                return fail(err);
            }
        }
    );

    const createFields = {
        type: z.string().describe(`Page type: ${types.join(', ')}`),
        summary: z.string().describe('One line: who/what this is and why it matters'),
        frontmatter: z.record(z.string(), z.unknown()).optional().describe('Fields to set, e.g. {"aliases": ["KR"], "status": "active"}'),
        sections: z.record(z.string(), z.string()).optional().describe('Fill template sections by heading'),
        body: z.string().optional().describe('Replace the whole template body instead (Markdown)'),
        folder: z.string().optional().describe('Override the folder, e.g. "Projects/Kitchen Remodel" for a sub-page')
    };
    const editFields = {
        frontmatter: z.record(z.string(), z.unknown()).optional().describe('Keys to set; null removes a key'),
        replace: z.array(z.object({ find: z.string(), with: z.string() })).optional(),
        sections: z
            .array(z.object({ heading: z.string(), action: z.enum(['append', 'prepend', 'replace']).optional(), content: z.string() }))
            .optional(),
        summary: z.string().optional(),
        body: z.string().optional()
    };

    server.registerTool(
        'wiki_publish',
        {
            title: 'Publish a batch of pages',
            description:
                'Create and update many pages in ONE all-or-nothing commit: use it to publish the result of a brainstorm (e.g. a project plus its people, sources and topics, and back-links added to existing pages). ALWAYS call with dry_run: true first and show the user the plan; commit (dry_run: false) only after they confirm. Everything is validated before anything is written: duplicate names, ambiguous targets and bad edits are all reported together.',
            inputSchema: z.strictObject({
                pages: z
                    .array(
                        z.discriminatedUnion('action', [
                            z.strictObject({ action: z.literal('create'), name: z.string().describe('New page title'), ...createFields }),
                            z.strictObject({ action: z.literal('update'), name: z.string().describe('Existing page: title, alias or path'), ...editFields })
                        ])
                    )
                    .min(1)
                    .max(40),
                message: z.string().describe('Commit message, e.g. "Add Kitchen Remodel: project, 2 people, 3 sources"'),
                dry_run: z.boolean().describe('true = preview only, nothing written. Always preview first.')
            }),
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
        },
        async ({ pages, message, dry_run }) => {
            try {
                const { plan, committed } = await wiki.publish(pages as PublishOp[], { message, dryRun: dry_run });
                const creates = plan.filter(p => p.action === 'create').length;
                const edits = plan.filter(p => p.action === 'update' && p.after !== p.before).length;
                if (dry_run) {
                    return text(`PREVIEW (nothing written yet): ${creates} new page(s), ${edits} edit(s).\n\n${renderPlan(plan, true)}\n\nCall again with dry_run: false to publish.`);
                }
                if (!committed) return text('Nothing to publish: every edit was already in place.');
                return text(`Published in one commit ("${message}"): ${creates} new, ${edits} edited.\n${renderPlan(plan, false)}`);
            } catch (err) {
                return fail(err);
            }
        }
    );

    server.registerTool(
        'wiki_move',
        {
            title: 'Rename or move a page',
            description:
                'Rename a page and/or move it to another folder, rewriting every [[link]] to it across the wiki, as ONE commit. Title links follow a rename, path links follow any move, and the old title is kept as an alias so lookups still find it. Use it to file Inbox notes into their proper folder, or fix a page name. ALWAYS call with dry_run: true first and show the user the plan.',
            inputSchema: z.strictObject({
                name: z.string().describe('The page to move: title, alias or path'),
                new_name: z.string().optional().describe('New title, e.g. "Ada Lovelace"'),
                folder: z.string().optional().describe(`New folder, e.g. "People" or "Projects/Home". Types and their folders: ${typeList(config)}`),
                keep_alias: z.boolean().optional().describe('On a rename, add the old title to aliases (default true)'),
                message: z.string().optional().describe('Commit message'),
                dry_run: z.boolean().describe('true = preview only, nothing written. Always preview first.')
            }),
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
        },
        async ({ name, new_name, folder, keep_alias, message, dry_run }) => {
            try {
                const r = await wiki.move(name, { newName: new_name, folder, keepAlias: keep_alias, message, dryRun: dry_run });
                const head = `${r.from} → ${r.to}${r.newTitle !== r.oldTitle ? ` ([[${r.oldTitle}]] → [[${r.newTitle}]])` : ''}`;
                const lines = [
                    r.aliasAdded ? `"${r.oldTitle}" is added to aliases.` : '',
                    r.edits.length
                        ? `Links rewritten on ${r.edits.length} page(s):\n${r.edits.map(e => `- [[${e.title}]] (${e.path}): ${e.links} link(s)`).join('\n')}`
                        : 'No other page needs its links changed.'
                ].filter(Boolean);
                if (dry_run) return text(`PREVIEW (nothing written yet): ${head}\n${lines.join('\n')}\n\nCall again with dry_run: false to move it.`);
                return text(`Moved in one commit: ${head}\n${lines.join('\n')}`);
            } catch (err) {
                return fail(err);
            }
        }
    );

    server.registerTool(
        'wiki_history',
        {
            title: 'Page history',
            description:
                'The commits that changed one page (newest first): when, and the commit message. Pass version (from the list) to see the page as it was then, e.g. to answer "what did this say before?" or to recover something. Also works with the old path of a page that was moved.',
            inputSchema: z.strictObject({
                name: z.string().describe('Title, alias or path (an old path works too)'),
                version: z.string().optional().describe('A version id from the list, to read the page as it was then'),
                limit: z.number().int().min(1).max(50).optional().describe('Default 15'),
                public_only: publicOnly
            }),
            annotations: { readOnlyHint: true, openWorldHint: false }
        },
        async ({ name, version, limit, public_only }) => {
            try {
                if (version) {
                    const v = await wiki.versionAt(name, version);
                    if (public_only && v.private) return { ...text(`${v.path} is private.`), isError: true };
                    const parsed = parseFrontmatter(v.text);
                    const body = public_only ? stripPrivate(parsed.body, config.private) : parsed.body;
                    return text(`# ${v.title} as of version ${version.slice(0, 7)}\npath: ${v.path}\n\n${public_only ? '' : parsed.fmText ? `---\n${parsed.fmText}\n---\n` : ''}${body.trim()}`);
                }
                const h = await wiki.history(name, limit ?? 15);
                if (public_only && h.private) return { ...text(`${h.path} is private.`), isError: true };
                if (!h.versions.length) return text(`No history found for ${h.path}.`);
                return text(
                    `History of [[${h.title}]] (${h.path}), newest first:\n${h.versions.map(v => `- ${v.when.slice(0, 16).replace('T', ' ')} · ${v.rev.slice(0, 7)} · ${v.message}`).join('\n')}\n\nPass version to see the page as it was.`
                );
            } catch (err) {
                return fail(err);
            }
        }
    );

    server.registerTool(
        'wiki_recent_changes',
        {
            title: 'Recent changes',
            description: 'The latest commits to the wiki (newest first): what was added or changed recently, from any device.',
            inputSchema: z.strictObject({ limit: z.number().int().min(1).max(50).optional().describe('Default 15') }),
            annotations: { readOnlyHint: true, openWorldHint: false }
        },
        async ({ limit }) => {
            const changes = await wiki.recentChanges(limit ?? 15);
            if (!changes.length) return text('No recent changes recorded.');
            return text(changes.map(c => `- ${c.when.slice(0, 16).replace('T', ' ')} ${c.message}`).join('\n'));
        }
    );

    server.registerTool(
        'wiki_health',
        {
            title: 'Wiki health check',
            description: 'Maintenance report: problems with wiki.config.yaml, broken [[links]] (pages worth creating), orphan pages nothing links to, pages missing a summary, unprocessed logs, and Inbox items waiting to be filed.',
            inputSchema: z.strictObject({}),
            annotations: { readOnlyHint: true, openWorldHint: false }
        },
        async () => {
            const h = await wiki.health();
            const broken = [...h.broken.entries()].sort((a, b) => b[1].length - a[1].length);
            const parts = [
                ...(h.storeError ? [`Store problem (serving the last good copy, edits will fail): ${h.storeError}`] : []),
                ...(h.configError ? [`Config problem: ${h.configError}`] : []),
                `Broken links (${broken.length}): ${broken.length ? '\n' + broken.slice(0, 40).map(([l, from]) => `- [[${l}]] ← ${list(from, 5)}`).join('\n') : 'none'}`,
                `Orphans (${h.orphans.length}): ${list(h.orphans.map(p => p.title), 40) || 'none'}`,
                `Missing summary (${h.noSummary.length}): ${list(h.noSummary.map(p => p.path), 40) || 'none'}`,
                `Unprocessed logs (${h.unprocessedLogs.length}): ${list(h.unprocessedLogs.map(p => p.title), 20) || 'none'}`,
                `Inbox (${h.inbox.length}): ${list(h.inbox.map(p => p.title), 20) || 'empty'}`
            ];
            return text(parts.join('\n\n'));
        }
    );

    return server;
}
