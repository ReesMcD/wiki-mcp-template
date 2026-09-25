import {
    asList,
    assemble,
    editSection,
    extractLinks,
    findSection,
    findSections,
    normalizeName,
    parseFrontmatter,
    patchFrontmatter,
    plainText,
    setSummary,
    stripPrivate,
    summaryLine,
    toYaml,
    unwrapLink,
    type PrivacyRules,
    type SectionAction
} from './markdown.js';
import { CONFIG_PATH, folderForType, isPrivatePage, isWikiPath, parseConfig, standaloneTypes, typeForFolder, type WikiConfig } from './settings.js';
import { ConflictError, gitBlobSha, type Store, type StoredFile, type WriteResult } from './store.js';

export interface Page {
    path: string;
    title: string;
    folder: string;
    type: string;
    aliases: string[];
    tags: string[];
    data: Record<string, unknown>;
    fmText: string | null;
    body: string;
    text: string;
    sha: string;
    links: string[];
    /** Whole page is private (in a private folder, or marked private in its frontmatter). */
    private: boolean;
}

export function toPage(file: StoredFile, config: WikiConfig): Page {
    const { data, fmText, body } = parseFrontmatter(file.text);
    const segments = file.path.split('/');
    const title = segments[segments.length - 1].replace(/\.md$/, '');
    const folder = segments.slice(0, -1).join('/');
    return {
        path: file.path,
        title,
        folder,
        type: typeof data.type === 'string' && data.type ? data.type : typeForFolder(folder, config),
        aliases: asList(data.aliases).map(unwrapLink),
        tags: asList(data.tags).map(t => t.replace(/^#/, '')),
        data,
        fmText,
        body,
        text: file.text,
        sha: file.sha,
        links: extractLinks(file.text),
        private: isPrivatePage(folder, data, config)
    };
}

export interface Match {
    page: Page;
    score: number;
    /** Which name matched (title or an alias). */
    via: string;
}

const STOPWORDS = new Set(
    'a an and are as at be by did do does for from had has have he her his how i in is it its me my of on or our she that the their them they this to was we were what when where which who whom why will with you your'.split(' ')
);

function bigrams(s: string): Map<string, number> {
    const m = new Map<string, number>();
    const t = s.replace(/ /g, '');
    for (let i = 0; i < t.length - 1; i++) m.set(t.slice(i, i + 2), (m.get(t.slice(i, i + 2)) ?? 0) + 1);
    return m;
}

/** Dice coefficient on character bigrams: typo-tolerant name similarity in [0, 1]. */
function similarity(a: string, b: string): number {
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    const A = bigrams(a);
    const B = bigrams(b);
    let overlap = 0;
    for (const [k, n] of A) overlap += Math.min(n, B.get(k) ?? 0);
    let total = 0;
    for (const n of A.values()) total += n;
    for (const n of B.values()) total += n;
    return (2 * overlap) / total;
}

function scoreName(query: string, name: string): number {
    if (!query || !name) return 0;
    if (query === name) return 100;
    const qTokens = query.split(' ');
    const nTokens = name.split(' ');
    if (name.startsWith(`${query} `) || query.startsWith(`${name} `)) return 75;
    if (qTokens.every(t => nTokens.includes(t))) return 65;
    if (nTokens.includes(query)) return 60;
    const sim = similarity(query, name);
    return sim >= 0.55 ? Math.round(55 * sim) : 0;
}

export function dateInZone(tz: string, at: Date = new Date()): { date: string; time: string; hour: number } {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-CA', {
            timeZone: tz,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23'
        })
            .formatToParts(at)
            .map(p => [p.type, p.value])
    );
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, hour: Number(parts.hour) };
}

export class WikiError extends Error {}

export interface CreateInput {
    type: string;
    name: string;
    summary: string;
    folder?: string;
    frontmatter?: Record<string, unknown>;
    sections?: Record<string, string>;
    body?: string;
    message?: string;
}

export type PublishOp = ({ action: 'create' } & CreateInput) | ({ action: 'update'; name: string } & PageEdit);

export interface PlanItem {
    action: 'create' | 'update';
    path: string;
    title: string;
    type: string;
    before: string | null;
    after: string;
    prevSha: string | null;
}

export interface PublishResult {
    plan: PlanItem[];
    committed: boolean;
}

export interface WikiOptions {
    /** Overrides `timezone` from wiki.config.yaml. */
    timeZone?: string;
    /** How long a checked revision is trusted before asking the store again. */
    freshnessMs?: number;
    now?: () => Date;
}

export interface PageEdit {
    frontmatter?: Record<string, unknown>;
    summary?: string;
    sections?: Array<{ heading: string; action?: SectionAction; content: string }>;
    replace?: Array<{ find: string; with: string }>;
    body?: string;
}

export class Wiki {
    private rev: string | null = null;
    private checkedAt = 0;
    private byPath = new Map<string, Page>();
    private loading: Promise<void> | null = null;
    private cfg: WikiConfig = parseConfig(null).config;
    private cfgError: string | null = null;
    private readonly timeZoneOverride?: string;
    private readonly freshnessMs: number;
    private readonly now: () => Date;

    constructor(
        private readonly store: Store,
        opts: WikiOptions = {}
    ) {
        this.timeZoneOverride = opts.timeZone;
        this.freshnessMs = opts.freshnessMs ?? 5000;
        this.now = opts.now ?? (() => new Date());
    }

    /** Settings from wiki.config.yaml, current as of the latest refresh. */
    async config(): Promise<WikiConfig> {
        await this.pages();
        return this.cfg;
    }

    /** Why wiki.config.yaml couldn't be used, if it couldn't. */
    get configError(): string | null {
        return this.cfgError;
    }

    get timeZone(): string {
        return this.timeZoneOverride ?? this.cfg.timezone ?? 'UTC';
    }

    private get privacy(): PrivacyRules {
        return this.cfg.private;
    }

    // -- Index ---------------------------------------------------------------

    /** All pages, refreshed from the store when the repo has changed. */
    async pages(): Promise<Page[]> {
        if (this.loading) await this.loading;
        if (this.rev === null || Date.now() - this.checkedAt >= this.freshnessMs) {
            this.loading = this.refresh().finally(() => (this.loading = null));
            await this.loading;
        }
        return [...this.byPath.values()];
    }

    private async refresh(): Promise<void> {
        const head = await this.store.head();
        if (head !== this.rev) {
            const [snap, configFile] = await Promise.all([this.store.snapshot(), this.store.readFile(CONFIG_PATH)]);
            const { config, error } = parseConfig(configFile?.text ?? null);
            this.cfg = config;
            this.cfgError = error;
            this.byPath = new Map(snap.files.filter(f => isWikiPath(f.path, config)).map(f => [f.path, toPage(f, config)]));
            this.rev = snap.rev;
        }
        this.checkedAt = Date.now();
    }

    /**
     * Fold our own write into the index. The cached revision only moves
     * forward when the write landed directly on top of it; otherwise someone
     * else pushed in between and the next read reloads everything.
     */
    private remember(file: StoredFile, result: WriteResult): Page {
        const page = toPage(file, this.cfg);
        if (this.rev === null) return page;
        if (isWikiPath(file.path, this.cfg)) this.byPath.set(file.path, page);
        if (result.parentRev === this.rev) this.rev = result.rev;
        return page;
    }

    /** Rank pages whose title or alias matches `name`. */
    async find(name: string, opts: { publicOnly?: boolean } = {}): Promise<Match[]> {
        const raw = unwrapLink(name);
        const pages = (await this.pages()).filter(p => !(opts.publicOnly && p.private));
        const byPathHit = pages.find(p => p.path === raw || p.path === `${raw}.md`);
        if (byPathHit) return [{ page: byPathHit, score: 1000, via: byPathHit.title }];
        const q = normalizeName(raw);
        const matches: Match[] = [];
        for (const page of pages) {
            let best: Match | null = null;
            for (const [name, weight] of [[page.title, 0], ...page.aliases.map(a => [a, -3] as const)] as const) {
                const s = scoreName(q, normalizeName(name));
                if (s > 0 && (!best || s + weight > best.score)) best = { page, score: s + weight, via: name };
            }
            if (best) matches.push(best);
        }
        return matches.sort((a, b) => b.score - a.score || a.page.title.length - b.page.title.length);
    }

    /** Resolve a name to exactly one page, or explain why not. */
    async resolve(name: string, opts: { publicOnly?: boolean } = {}): Promise<Page> {
        const matches = await this.find(name, opts);
        const [top, second] = matches;
        if (!top || top.score < 55) {
            const hint = matches.length ? ` Closest: ${matches.slice(0, 5).map(m => m.page.title).join(', ')}.` : '';
            throw new WikiError(`No page named "${name}".${hint}`);
        }
        if (second && top.score < 95 && second.score >= top.score - 5) {
            throw new WikiError(
                `"${name}" is ambiguous: ${matches
                    .slice(0, 6)
                    .map(m => `${m.page.title} (${m.page.path})`)
                    .join('; ')}. Use the exact title or path.`
            );
        }
        return top.page;
    }

    /** Pages that link to `page` (by title or alias). */
    async backlinks(page: Page, opts: { publicOnly?: boolean } = {}): Promise<Page[]> {
        const names = new Set([page.title, ...page.aliases, page.path.replace(/\.md$/, '')].map(normalizeName));
        return (await this.pages()).filter(
            p => p.path !== page.path && !(opts.publicOnly && p.private) && this.linksFor(p, !!opts.publicOnly).some(l => names.has(normalizeName(l)))
        );
    }

    /** Outgoing link targets; in public-only mode, only links outside private material. */
    linksFor(page: Page, publicOnly: boolean): string[] {
        return publicOnly ? extractLinks(`${page.fmText ?? ''}\n${stripPrivate(page.body, this.privacy)}`) : page.links;
    }

    /** Visible body of a page: private material removed in public-only mode. */
    bodyFor(page: Page, publicOnly: boolean): string {
        return publicOnly ? stripPrivate(page.body, this.privacy) : page.body;
    }

    summaryFor(page: Page, publicOnly = false): string {
        return summaryLine(this.bodyFor(page, publicOnly));
    }

    // -- Search --------------------------------------------------------------

    async search(
        query: string,
        filters: { type?: string; folder?: string; tag?: string; status?: string; publicOnly?: boolean; limit?: number } = {}
    ): Promise<Array<{ page: Page; score: number; snippet: string }>> {
        const tokens = [...new Set(normalizeName(query).split(' '))].filter(t => t && !STOPWORDS.has(t));
        const phrase = normalizeName(query);
        const pages = this.filter(await this.pages(), filters);
        const results: Array<{ page: Page; score: number; snippet: string }> = [];
        for (const page of pages) {
            const body = this.bodyFor(page, !!filters.publicOnly);
            const names = [page.title, ...page.aliases].map(normalizeName).join(' | ');
            const summary = normalizeName(summaryLine(body));
            const tags = page.tags.map(normalizeName).join(' ');
            const text = normalizeName(body);
            const fm = normalizeName(Object.values(page.data).map(v => (typeof v === 'object' ? JSON.stringify(v) : String(v ?? ''))).join(' '));
            let score = 0;
            let covered = 0;
            for (const t of tokens) {
                const re = new RegExp(`\\b${t}`, 'g');
                const inName = re.test(names);
                const bodyHits = Math.min(5, text.match(re)?.length ?? 0);
                const hit = inName || bodyHits > 0 || new RegExp(`\\b${t}`).test(fm) || new RegExp(`\\b${t}`).test(tags);
                if (!hit) continue;
                covered++;
                score += (inName ? 12 : 0) + (new RegExp(`\\b${t}`).test(summary) ? 4 : 0) + (new RegExp(`\\b${t}`).test(tags) ? 3 : 0) + (new RegExp(`\\b${t}`).test(fm) ? 2 : 0) + bodyHits;
            }
            if (!covered) continue;
            if (tokens.length > 1 && text.includes(phrase)) score += 10;
            score += covered === tokens.length ? 8 * covered : 3 * covered;
            results.push({ page, score, snippet: snippetFor(body, tokens) });
        }
        return results.sort((a, b) => b.score - a.score).slice(0, filters.limit ?? 10);
    }

    filter(pages: Page[], f: { type?: string; folder?: string; tag?: string; status?: string; publicOnly?: boolean }): Page[] {
        const folder = f.folder?.replace(/^\/|\/$/g, '').toLowerCase();
        return pages.filter(
            p =>
                !(f.publicOnly && p.private) &&
                (!f.type || p.type.toLowerCase() === f.type.toLowerCase()) &&
                (!folder || p.folder.toLowerCase() === folder || p.folder.toLowerCase().startsWith(`${folder}/`)) &&
                (!f.tag || p.tags.some(t => t.toLowerCase() === f.tag!.replace(/^#/, '').toLowerCase())) &&
                (!f.status || String(p.data.status ?? '').toLowerCase() === f.status.toLowerCase())
        );
    }

    // -- Writes --------------------------------------------------------------

    today(): { date: string; time: string; hour: number } {
        return dateInZone(this.timeZone, this.now());
    }

    async create(input: CreateInput): Promise<Page> {
        const draft = await this.buildCreate(input);
        try {
            const result = await this.store.writeFile(draft.path, draft.text, input.message ?? `Add ${draft.type}: ${draft.name}`, null);
            return this.remember({ path: draft.path, text: draft.text, sha: result.sha }, result);
        } catch (err) {
            if (err instanceof ConflictError) throw new WikiError(`${draft.path} already exists.`);
            throw err;
        }
    }

    /**
     * Render a new page from its template without writing it. `reserved`
     * holds names claimed earlier in the same publish batch.
     */
    private async buildCreate(input: CreateInput, reserved = new Map<string, string>()): Promise<{ path: string; text: string; type: string; name: string }> {
        const name = input.name.trim().replace(/\s+/g, ' ');
        if (!name || /[\\/:*?"<>|#^[\]]/.test(name)) {
            throw new WikiError(`"${input.name}" can't be used as a page name (avoid / \\ : * ? " < > | # ^ [ ]).`);
        }
        await this.pages();
        const type = input.type.toLowerCase();
        const folder = (input.folder ?? folderForType(type, this.cfg)).replace(/^\/+|\/+$/g, '');
        if (folder.split('/').some(s => s === '..' || s === '.' || !s) || !isWikiPath(`${folder}/x.md`, this.cfg)) {
            throw new WikiError(`Folder "${folder}" isn't a wiki content folder.`);
        }

        // Refuse duplicates: the same name or any alias already in use.
        const names = [name, ...asList(input.frontmatter?.aliases)];
        for (const n of names) {
            const clash = (await this.find(n)).find(m => m.score >= 97);
            if (clash) throw new WikiError(`"${n}" already exists as [[${clash.page.title}]] (${clash.page.path}). Update that page instead, or pick a different name.`);
            const claimed = reserved.get(normalizeName(n));
            if (claimed) throw new WikiError(`"${n}" is used twice in this batch (also by "${claimed}").`);
        }
        for (const n of names) reserved.set(normalizeName(n), name);

        const { date, time } = this.today();
        const template = (await this.store.readFile(`_templates/${type}.md`))?.text ?? `---\ntype: ${type}\naliases: []\ntags: []\n---\n**{{summary}}**\n`;
        const filled = fillTemplate(template, name, date, time);
        const parsed = parseFrontmatter(filled);
        const fm = patchFrontmatter(parsed.fmText, { type, ...(input.frontmatter ?? {}) });
        let body: string;
        if (input.body !== undefined) {
            body = setSummary(input.body, input.summary);
        } else {
            // Template hints are HTML comments; they're for people writing by hand.
            body = parsed.body.replace(/[ \t]*<!--[\s\S]*?-->[ \t]*\n?/g, '');
            body = body.replace(/\{\{summary\}\}/g, input.summary.replace(/^\*\*|\*\*$/g, ''));
            if (!parsed.body.includes('{{summary}}')) body = setSummary(body, input.summary);
            for (const [heading, content] of Object.entries(input.sections ?? {})) body = editSection(body, heading, 'replace', content, this.privacy);
        }
        return { path: `${folder}/${name}.md`, text: `${assemble(fm, body).replace(/\s*$/, '')}\n`, type, name };
    }

    /**
     * Create and update many pages as one commit. Everything is validated
     * first; with `dryRun` nothing is written and the plan is returned.
     */
    async publish(ops: PublishOp[], opts: { message: string; dryRun?: boolean }): Promise<PublishResult> {
        if (!ops.length) throw new WikiError('Nothing to publish.');
        for (let attempt = 0; ; attempt++) {
            const plan = await this.plan(ops);
            const changed = plan.filter(p => p.after !== p.before);
            if (opts.dryRun || !changed.length) return { plan, committed: false };
            try {
                const result = await this.store.commitFiles(
                    changed.map(p => ({ path: p.path, text: p.after, prevSha: p.prevSha })),
                    opts.message
                );
                for (const p of changed) this.remember({ path: p.path, text: p.after, sha: gitBlobSha(p.after) }, { ...result, sha: '' });
                return { plan, committed: true };
            } catch (err) {
                if (!(err instanceof ConflictError) || attempt >= 2) throw err;
                // Someone else edited in the meantime: reload and rebuild the plan on top of it.
                this.checkedAt = 0;
            }
        }
    }

    private async plan(ops: PublishOp[]): Promise<PlanItem[]> {
        await this.pages();
        const reserved = new Map<string, string>();
        const items = new Map<string, PlanItem>();
        const errors: string[] = [];
        for (const [i, op] of ops.entries()) {
            const label = `#${i + 1} (${op.action} ${op.name})`;
            try {
                if (op.action === 'create') {
                    const draft = await this.buildCreate(op, reserved);
                    if (items.has(draft.path)) throw new WikiError(`${draft.path} is created twice in this batch.`);
                    items.set(draft.path, { action: 'create', path: draft.path, title: draft.name, type: draft.type, before: null, after: draft.text, prevSha: null });
                } else {
                    const page = await this.resolve(op.name);
                    const existing = items.get(page.path);
                    const base = existing?.after ?? page.text;
                    const { action: _a, name: _n, ...edit } = op;
                    const after = applyEdit(base, edit, page.path, this.privacy);
                    items.set(page.path, existing ? { ...existing, after } : { action: 'update', path: page.path, title: page.title, type: page.type, before: page.text, after, prevSha: page.sha });
                }
            } catch (err) {
                if (!(err instanceof WikiError)) throw err;
                errors.push(`${label}: ${err.message}`);
            }
        }
        if (errors.length) throw new WikiError(`Nothing was published. Fix these first:\n${errors.map(e => `- ${e}`).join('\n')}`);
        return [...items.values()];
    }

    /** Apply edits to a page, re-reading and retrying once if someone else edited it first. */
    async update(name: string, edit: PageEdit, message?: string): Promise<{ page: Page; changed: boolean }> {
        const page = await this.resolve(name);
        const msg = message ?? `Update ${page.title}`;
        for (let attempt = 0; ; attempt++) {
            const current = attempt === 0 ? { path: page.path, text: page.text, sha: page.sha } : await this.store.readFile(page.path);
            if (!current) throw new WikiError(`${page.path} was deleted.`);
            const text = applyEdit(current.text, edit, page.path, this.privacy);
            if (text === current.text) return { page, changed: false };
            try {
                const result = await this.store.writeFile(page.path, text, msg, current.sha);
                return { page: this.remember({ path: page.path, text, sha: result.sha }, result), changed: true };
            } catch (err) {
                if (!(err instanceof ConflictError) || attempt >= 2) throw err;
            }
        }
    }

    /**
     * Append timestamped lines to today's log. Before `log.dayStartHour` the
     * entry goes to the previous day's log, so a late night stays in one file.
     */
    async log(text: string, opts: { date?: string } = {}): Promise<{ path: string; lines: string[] }> {
        await this.pages();
        const now = this.now();
        const { time } = dateInZone(this.timeZone, now);
        const date = opts.date ?? dateInZone(this.timeZone, new Date(now.getTime() - this.cfg.log.dayStartHour * 3600_000)).date;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new WikiError(`Log date must be YYYY-MM-DD, got "${date}".`);
        const path = `${this.cfg.log.folder}/${date}.md`;
        const lines = text
            .split('\n')
            .map(l => l.trim().replace(/^[-*]\s+/, ''))
            .filter(Boolean)
            .map(l => `- ${time} ${l}`);
        if (!lines.length) throw new WikiError('Nothing to log.');
        for (let attempt = 0; ; attempt++) {
            const current = await this.store.readFile(path);
            // A new log starts from _templates/log.md, the same template Obsidian's daily notes use.
            const template = current ? null : ((await this.store.readFile('_templates/log.md'))?.text ?? null);
            const base =
                current?.text ??
                (template
                    ? fillTemplate(template, date, date, time)
                    : `---\ntype: log\ndate: ${date}\nprocessed: false\n---\n**Log for ${date}. Quick notes captured during the day; file them into pages later.**\n\n`);
            const next = `${base.replace(/\s*$/, '')}\n${current ? '' : '\n'}${lines.join('\n')}\n`.replace(/^\n/, '');
            try {
                const result = await this.store.writeFile(path, next, `Log ${date}: ${plainText(lines[0].slice(8)).slice(0, 60)}`, current?.sha ?? null);
                this.remember({ path, text: next, sha: result.sha }, result);
                return { path, lines };
            } catch (err) {
                if (!(err instanceof ConflictError) || attempt >= 3) throw err;
            }
        }
    }

    async recentChanges(limit: number) {
        return this.store.recentChanges(limit);
    }

    // -- Health --------------------------------------------------------------

    async health(): Promise<{ configError: string | null; broken: Map<string, string[]>; orphans: Page[]; noSummary: Page[]; unprocessedLogs: Page[]; inbox: Page[] }> {
        const pages = await this.pages();
        const known = new Set<string>();
        for (const p of pages) for (const n of [p.title, ...p.aliases, p.path.replace(/\.md$/, '')]) known.add(normalizeName(n));
        const linkedTo = new Set<string>();
        const broken = new Map<string, string[]>();
        for (const p of pages) {
            for (const l of p.links) {
                const n = normalizeName(l);
                linkedTo.add(n);
                // Links to non-Markdown files (maps, images) aren't pages.
                if (/\.(png|jpe?g|gif|webp|svg|pdf)$/i.test(l)) continue;
                if (!known.has(n)) broken.set(l, [...(broken.get(l) ?? []), p.title]);
            }
        }
        const standalone = standaloneTypes(this.cfg);
        const orphans = pages.filter(p => !standalone.has(p.type) && ![p.title, ...p.aliases].some(n => linkedTo.has(normalizeName(n))));
        const noSummary = pages.filter(p => p.type !== 'log' && !summaryLine(p.body));
        const unprocessedLogs = pages.filter(p => p.type === 'log' && p.data.processed !== true);
        const inboxFolder = this.cfg.inbox;
        const inbox = inboxFolder ? pages.filter(p => p.folder === inboxFolder || p.folder.startsWith(`${inboxFolder}/`)) : [];
        return { configError: this.cfgError, broken, orphans, noSummary, unprocessedLogs, inbox };
    }
}

/** Fill Obsidian's core template variables: {{title}}, {{date}} and {{time}} (formats are ignored). */
function fillTemplate(template: string, title: string, date: string, time: string): string {
    return template
        .replace(/\{\{title\}\}/g, title)
        .replace(/\{\{date(?::[^}]*)?\}\}/g, date)
        .replace(/\{\{time(?::[^}]*)?\}\}/g, time);
}

export function applyEdit(text: string, edit: PageEdit, pathForErrors: string, rules?: PrivacyRules): string {
    const parsed = parseFrontmatter(text);
    let fm = parsed.fmText;
    let body = edit.body !== undefined ? edit.body : parsed.body;
    if (edit.frontmatter && Object.keys(edit.frontmatter).length) fm = patchFrontmatter(fm, edit.frontmatter);
    for (const r of edit.replace ?? []) {
        const count = body.split(r.find).length - 1;
        if (count !== 1) throw new WikiError(`Text to replace ${count ? `appears ${count} times` : 'was not found'} in ${pathForErrors}: "${r.find.slice(0, 80)}". Include more surrounding text so it matches exactly once.`);
        body = body.replace(r.find, () => r.with);
    }
    for (const s of edit.sections ?? []) body = editSection(body, s.heading, s.action ?? 'append', s.content, rules);
    if (edit.summary) body = setSummary(body, edit.summary);
    return `${assemble(fm, body).replace(/\s*$/, '')}\n`;
}

function snippetFor(body: string, tokens: string[]): string {
    const flat = body.replace(/^---[\s\S]*?---/, '').replace(/\s+/g, ' ');
    const lower = flat.toLowerCase();
    let at = -1;
    for (const t of tokens) {
        const i = lower.search(new RegExp(`\\b${t}`));
        if (i !== -1 && (at === -1 || i < at)) at = i;
    }
    if (at === -1) return plainText(flat.slice(0, 160));
    const start = Math.max(0, at - 80);
    return `${start > 0 ? '…' : ''}${plainText(flat.slice(start, at + 140))}…`;
}

// -- Formatting helpers shared by the tools ----------------------------------

const HIDDEN_KEYS = new Set(['type', 'aliases', 'tags']);

/** Compact "key: value" rendering of the interesting frontmatter fields. */
export function keyFields(page: Page, publicOnly = false): string {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(page.data)) {
        if (HIDDEN_KEYS.has(k) || v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) continue;
        if (publicOnly && (k.startsWith('private_') || k === 'visibility')) continue;
        parts.push(`${k}: ${typeof v === 'object' ? (Array.isArray(v) ? v.join(', ') : toYaml(v).replace(/\n/g, '; ')) : String(v)}`);
    }
    return parts.join(' · ');
}

export function sectionList(body: string): string[] {
    return findSections(body)
        .filter(s => s.level <= 3)
        .map(s => s.heading);
}

export { findSection };
