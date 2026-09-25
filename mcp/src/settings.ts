import { parse } from 'yaml';
import { z } from 'zod';

/** Where the wiki's settings live, relative to the repo root. */
export const CONFIG_PATH = 'wiki.config.yaml';

function isTimeZone(tz: string): boolean {
    try {
        new Intl.DateTimeFormat('en', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

const typeSchema = z.object({
    folder: z.string().min(1),
    description: z.string().optional(),
    /** Pages of this type are fine without incoming links (not reported as orphans). */
    standalone: z.boolean().optional()
});

const schema = z.object({
    name: z.string().min(1).default('My Wiki'),
    description: z.string().default('A personal knowledge wiki of people, projects, topics and sources.'),
    timezone: z
        .string()
        .refine(isTimeZone, { error: iss => `unknown time zone "${String(iss.input)}" (use an IANA name like "America/New_York")` })
        .optional(),
    dashboard: z.string().nullable().default('Dashboard.md'),
    defaultFolder: z.string().min(1).default('Inbox'),
    inbox: z.string().nullable().default('Inbox'),
    log: z
        .object({
            folder: z.string().min(1).default('Log'),
            dayStartHour: z.number().int().min(0).max(12).default(4)
        })
        .default({ folder: 'Log', dayStartHour: 4 }),
    types: z.record(z.string(), typeSchema).default({}),
    private: z
        .object({
            folders: z.array(z.string()).default([]),
            frontmatter: z.record(z.string(), z.string()).default({}),
            headings: z.array(z.string()).default([]),
            lineMarker: z.string().nullable().default(null)
        })
        .default({ folders: [], frontmatter: {}, headings: [], lineMarker: null }),
    exclude: z.array(z.string()).default([]),
    instructions: z.string().optional()
});

export type WikiConfig = z.infer<typeof schema>;
export type TypeConfig = z.infer<typeof typeSchema>;

/** Used when the repo has no wiki.config.yaml (and as the base for a broken one). */
export const DEFAULT_CONFIG: WikiConfig = {
    name: 'My Wiki',
    description: 'A personal knowledge wiki of people, projects, topics and sources.',
    dashboard: 'Dashboard.md',
    defaultFolder: 'Inbox',
    inbox: 'Inbox',
    log: { folder: 'Log', dayStartHour: 4 },
    types: {
        note: { folder: 'Notes', description: 'Anything that fits nowhere else', standalone: true },
        person: { folder: 'People', description: 'Someone you know, work with or read about' },
        project: { folder: 'Projects', description: 'Something with a goal and an end' },
        topic: { folder: 'Topics', description: 'An area, concept or recurring subject' },
        source: { folder: 'Sources', description: 'A book, article, video, podcast or link' },
        draft: { folder: 'Private/Drafts', description: 'Work-in-progress from a brainstorm', standalone: true }
    },
    private: {
        folders: ['Private'],
        frontmatter: { visibility: 'private' },
        headings: ['Private', 'Private Notes'],
        lineMarker: '(private)'
    },
    exclude: ['README.md', 'CLAUDE.md', 'LICENSE.md', 'claude/', 'docs/']
};

/** Folders that are never wiki content, whatever the config says. */
const TOOLING = new Set(['mcp', 'node_modules']);

/**
 * Parse wiki.config.yaml. A missing file or setting gives the defaults; a broken one
 * also gives the defaults plus an error message (reported by wiki_health)
 * so a typo never takes the whole server down.
 */
export function parseConfig(text: string | null): { config: WikiConfig; error: string | null } {
    if (text === null) return { config: DEFAULT_CONFIG, error: null };
    let raw: unknown;
    try {
        raw = parse(text) ?? {};
    } catch (err) {
        return { config: DEFAULT_CONFIG, error: `${CONFIG_PATH} isn't valid YAML: ${(err as Error).message}` };
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) return { config: DEFAULT_CONFIG, error: `${CONFIG_PATH} should be a set of "key: value" settings.` };
    // Missing settings keep their defaults; `log` and `private` merge key by key.
    const given = raw as Record<string, unknown>;
    const nested = (key: 'log' | 'private') =>
        given[key] && typeof given[key] === 'object' ? { ...DEFAULT_CONFIG[key], ...(given[key] as object) } : (given[key] ?? DEFAULT_CONFIG[key]);
    const result = schema.safeParse({ ...DEFAULT_CONFIG, ...given, log: nested('log'), private: nested('private') });
    if (!result.success) {
        const issues = result.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
        return { config: DEFAULT_CONFIG, error: `${CONFIG_PATH} has problems, so the defaults are in use: ${issues}` };
    }
    const config = result.data;
    const clean = (f: string) => f.replace(/^\/+|\/+$/g, '');
    return {
        config: {
            ...config,
            types: Object.fromEntries(Object.entries(config.types).map(([t, v]) => [t.toLowerCase(), { ...v, folder: clean(v.folder) }])),
            defaultFolder: clean(config.defaultFolder),
            inbox: config.inbox === null ? null : clean(config.inbox),
            log: { ...config.log, folder: clean(config.log.folder) },
            private: { ...config.private, folders: config.private.folders.map(clean) }
        },
        error: null
    };
}

const inFolder = (folder: string, prefix: string) => folder === prefix || folder.startsWith(`${prefix}/`);

/** Only wiki content is indexed: not templates, tooling, dotfolders or excluded paths. */
export function isWikiPath(p: string, config: WikiConfig): boolean {
    if (!p.endsWith('.md')) return false;
    const first = p.split('/')[0];
    if (first.startsWith('.') || first.startsWith('_') || (p.includes('/') && TOOLING.has(first))) return false;
    return !config.exclude.some(e => (e.endsWith('/') ? p.startsWith(e) : p === e));
}

export function isPrivatePage(folder: string, data: Record<string, unknown>, config: WikiConfig): boolean {
    if (config.private.folders.some(f => inFolder(folder, f))) return true;
    return Object.entries(config.private.frontmatter).some(([k, v]) => String(data[k] ?? '').toLowerCase() === v.toLowerCase());
}

/** The page type implied by a folder, for pages without a `type` field. */
export function typeForFolder(folder: string, config: WikiConfig): string {
    if (inFolder(folder, config.log.folder)) return 'log';
    const entries = Object.entries(config.types);
    const exact = entries.find(([, t]) => t.folder === folder);
    const parent = entries.filter(([, t]) => inFolder(folder, t.folder)).sort((a, b) => b[1].folder.length - a[1].folder.length)[0];
    return (exact ?? parent)?.[0] ?? 'page';
}

export function folderForType(type: string, config: WikiConfig): string {
    return config.types[type.toLowerCase()]?.folder ?? config.defaultFolder;
}

/** Page types that never count as orphans: navigation pages, logs, and types marked standalone. */
export function standaloneTypes(config: WikiConfig): Set<string> {
    return new Set(['hub', 'dashboard', 'log', ...Object.entries(config.types).filter(([, t]) => t.standalone).map(([k]) => k)]);
}

export function typeList(config: WikiConfig): string {
    return Object.entries(config.types)
        .map(([t, v]) => `${t} → ${v.folder}/${v.description ? ` (${v.description})` : ''}`)
        .join('; ');
}

/** The server-level instructions Claude sees when it connects. */
export function instructionsFor(config: WikiConfig): string {
    const p = config.private;
    const privacy = [
        p.folders.length ? `pages in ${p.folders.map(f => `${f}/`).join(', ')}` : '',
        ...Object.entries(p.frontmatter).map(([k, v]) => `pages with "${k}: ${v}"`),
        p.headings.length ? `"## ${p.headings.join('" / "## ')}" sections` : '',
        '%%comments%%',
        p.lineMarker ? `lines containing "${p.lineMarker}"` : ''
    ].filter(Boolean);
    const lines = [
        `${config.name}: ${config.description}`,
        'Stored as Obsidian-style Markdown in a git repo. Pages have YAML frontmatter (type, aliases, status, ...), a bold one-line summary, then "## Sections". Links are [[Page Title]].',
        '- To answer a question quickly: wiki_lookup (a name) or wiki_search (a topic), then wiki_read only if you need detail.',
        config.dashboard
            ? `- "${config.dashboard.replace(/\.md$/, '')}" is the live dashboard. wiki_overview returns it plus a map of the wiki.`
            : '- wiki_overview returns a map of the wiki.',
        `- Quick capture: wiki_log appends to today's log (${config.log.folder}/YYYY-MM-DD). wiki_create makes a page from its template.`,
        `- Page types: ${typeList(config)}.`,
        '- While brainstorming, read as much as you like but don\'t write until the user says publish. Then send everything as one wiki_publish batch: dry_run first, commit after they confirm.',
        `- Private material: ${privacy.join(', ')}. Pass public_only: true for anything meant to be shared.`,
        '- Never invent facts silently: if the wiki doesn\'t say, say so, then label anything you add as new.'
    ];
    if (config.instructions?.trim()) lines.push(config.instructions.trim());
    return lines.join('\n');
}

/** Short machine-friendly id for the server name, e.g. "My Wiki" -> "my-wiki". */
export function slug(name: string): string {
    return (
        name
            .normalize('NFKD')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '') || 'wiki'
    );
}
