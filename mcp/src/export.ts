// Export a public copy of the wiki: `npm run export -- <outDir>`.
// Private pages, private sections, %%comments%% and marked lines are left
// out (the same rules as public_only), links to pages that aren't exported
// become plain text, and only attachments the exported pages use are copied.
// The output is plain Markdown, ready for Quartz or any static site builder.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assemble, extractLinks, normalizeName, parseFrontmatter, patchFrontmatter, stripPrivate, unlinkLinks } from './markdown.js';
import { FsStore } from './store.js';
import { Wiki, type Page } from './wiki.js';

export interface ExportResult {
    pages: string[];
    skipped: string[];
    assets: string[];
}

const ASSET = /\.(png|jpe?g|gif|webp|svg|pdf|mp3|mp4|webm)$/i;

/** Raw material that isn't worth publishing even when it isn't private. */
function isRaw(page: Page, inbox: string | null): boolean {
    return page.type === 'log' || (!!inbox && (page.folder === inbox || page.folder.startsWith(`${inbox}/`)));
}

export async function exportPublic(root: string, outDir: string): Promise<ExportResult> {
    const wiki = new Wiki(new FsStore(root));
    const pages = await wiki.pages();
    const config = await wiki.config();
    const published = pages.filter(p => !p.private && !isRaw(p, config.inbox));
    const hidden = pages.filter(p => !published.includes(p));

    // A link is unlinked when it points at a page that exists but isn't published.
    const names = (ps: Page[]) => new Set(ps.flatMap(p => [p.title, ...p.aliases, p.path.replace(/\.md$/, '')]).map(normalizeName));
    const publicNames = names(published);
    const hiddenNames = names(hidden);
    const isHidden = (target: string) => {
        const n = normalizeName(target);
        return hiddenNames.has(n) && !publicNames.has(n);
    };

    await fs.rm(outDir, { recursive: true, force: true });
    const assets = new Set<string>();
    const home = published.find(p => p.path === 'Home.md');
    for (const page of published) {
        let fm = page.fmText;
        if (fm !== null) {
            // Private frontmatter keys go too.
            const drop = Object.keys(page.data).filter(k => k === 'visibility' || k.startsWith('private_'));
            if (drop.length) fm = patchFrontmatter(fm, Object.fromEntries(drop.map(k => [k, null])));
            fm = unlinkLinks(fm, isHidden);
        }
        let body = unlinkLinks(stripPrivate(page.body, config.private), isHidden);
        // Quartz (and most site builders) use index.md as the front page.
        const target = page === home ? 'index.md' : page.path;
        if (page === home) fm = patchFrontmatter(fm, { title: page.title, aliases: [...new Set([...page.aliases, page.title])] });
        for (const link of extractLinks(`${fm ?? ''}\n${body}`)) if (ASSET.test(link)) assets.add(link);
        const abs = path.join(outDir, target);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, `${assemble(fm, body).replace(/\s*$/, '')}\n`, 'utf8');
    }

    // Attachments live anywhere in the vault (usually _assets/); copy the ones in use.
    const copied: string[] = [];
    if (assets.size) {
        const wanted = new Map([...assets].map(a => [path.basename(a).toLowerCase(), a]));
        for (const rel of await listFiles(root)) {
            if (!wanted.has(path.basename(rel).toLowerCase()) || rel.split('/').some(s => s.startsWith('.') || s === 'node_modules')) continue;
            if (config.private.folders.some(f => rel === f || rel.startsWith(`${f}/`))) continue;
            await fs.mkdir(path.dirname(path.join(outDir, rel)), { recursive: true });
            await fs.copyFile(path.join(root, rel), path.join(outDir, rel));
            copied.push(rel);
        }
    }
    return { pages: published.map(p => p.path).sort(), skipped: hidden.map(p => p.path).sort(), assets: copied.sort() };
}

async function listFiles(root: string, dir = ''): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) out.push(...(await listFiles(root, rel)));
        else if (ASSET.test(entry.name)) out.push(rel);
    }
    return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    const outDir = process.argv[2];
    if (!outDir) {
        console.error('Usage: npm run export -- <output folder>');
        process.exit(1);
    }
    const root = path.resolve(process.env.WIKI_ROOT ?? path.join(import.meta.dirname, '../..'));
    // npm runs scripts from mcp/; resolve the folder against where the command was typed.
    const result = await exportPublic(root, path.resolve(process.env.INIT_CWD ?? process.cwd(), outDir));
    console.log(`Exported ${result.pages.length} page(s) and ${result.assets.length} attachment(s) to ${outDir}; left out ${result.skipped.length} private or raw page(s).`);
}
