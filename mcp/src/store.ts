import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { parseTar } from 'nanotar';
import { CONFIG_PATH } from './settings.js';

/** A Markdown file as stored in the repo. `sha` is its git blob SHA. */
export interface StoredFile {
    path: string;
    text: string;
    sha: string;
}

export interface Snapshot {
    rev: string;
    files: StoredFile[];
}

export interface WriteResult {
    rev: string;
    parentRev: string | null;
    sha: string;
}

export interface FileChange {
    path: string;
    text: string;
    prevSha: string | null;
}

export interface Change {
    when: string;
    message: string;
}

/** Thrown when a write races another edit (the file changed or already exists). */
export class ConflictError extends Error {}

/**
 * Where the wiki lives. GitHubStore is used when deployed; FsStore serves a
 * local checkout (tests, and running the server locally over stdio).
 */
export interface Store {
    /** Cheap revision id; changes whenever any file changes. */
    head(): Promise<string>;
    /** Every Markdown file in the repo. */
    snapshot(): Promise<Snapshot>;
    readFile(filePath: string): Promise<StoredFile | null>;
    /**
     * Create or overwrite a file. `prevSha` is the blob SHA the caller last saw
     * (null means "must not exist yet"); a mismatch throws ConflictError.
     * Returns the new revision and the revision it was made on top of.
     */
    writeFile(filePath: string, text: string, message: string, prevSha: string | null): Promise<WriteResult>;
    /**
     * Write several files as one all-or-nothing commit. Every file's current
     * blob SHA must still match its `prevSha` (null = must not exist yet).
     */
    commitFiles(files: FileChange[], message: string): Promise<Omit<WriteResult, 'sha'>>;
    recentChanges(limit: number): Promise<Change[]>;
}

export function gitBlobSha(text: string): string {
    const bytes = Buffer.from(text, 'utf8');
    return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

export interface GitHubStoreOptions {
    owner: string;
    repo: string;
    branch: string;
    token: string;
    fetch?: typeof fetch;
}

export class GitHubStore implements Store {
    private readonly base: string;
    private readonly fetchImpl: typeof fetch;

    constructor(private readonly opts: GitHubStoreOptions) {
        this.base = `https://api.github.com/repos/${opts.owner}/${opts.repo}`;
        this.fetchImpl = opts.fetch ?? fetch;
    }

    private async api(pathname: string, init: RequestInit = {}): Promise<Response> {
        return this.fetchImpl(`${this.base}${pathname}`, {
            ...init,
            headers: {
                accept: 'application/vnd.github+json',
                authorization: `Bearer ${this.opts.token}`,
                'x-github-api-version': '2022-11-28',
                'user-agent': 'wiki-mcp',
                ...(init.body ? { 'content-type': 'application/json' } : {}),
                ...init.headers
            }
        });
    }

    private async json<T>(pathname: string, init?: RequestInit): Promise<T> {
        const res = await this.api(pathname, init);
        if (!res.ok) throw new Error(`GitHub ${init?.method ?? 'GET'} ${pathname} failed: ${res.status} ${await res.text()}`);
        return (await res.json()) as T;
    }

    async head(): Promise<string> {
        const ref = await this.json<{ object: { sha: string } }>(`/git/ref/heads/${encodePath(this.opts.branch)}`);
        return ref.object.sha;
    }

    async snapshot(): Promise<Snapshot> {
        const rev = await this.head();
        const res = await this.api(`/tarball/${rev}`);
        if (!res.ok) throw new Error(`GitHub tarball download failed: ${res.status}`);
        const entries = parseTar(gunzipSync(Buffer.from(await res.arrayBuffer())));
        const files: StoredFile[] = [];
        for (const entry of entries) {
            if (entry.type !== 'file' || !entry.data) continue;
            // Tarball entries are prefixed with "<owner>-<repo>-<sha>/".
            const filePath = entry.name.slice(entry.name.indexOf('/') + 1);
            if (!filePath.endsWith('.md')) continue;
            const text = new TextDecoder().decode(entry.data);
            files.push({ path: filePath, text, sha: gitBlobSha(text) });
        }
        return { rev, files };
    }

    async readFile(filePath: string): Promise<StoredFile | null> {
        const res = await this.api(`/contents/${encodePath(filePath)}?ref=${encodeURIComponent(this.opts.branch)}`);
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`GitHub read ${filePath} failed: ${res.status}`);
        const data = (await res.json()) as { content: string; sha: string; type: string };
        if (data.type !== 'file') return null;
        return { path: filePath, text: Buffer.from(data.content, 'base64').toString('utf8'), sha: data.sha };
    }

    async writeFile(filePath: string, text: string, message: string, prevSha: string | null): Promise<WriteResult> {
        const res = await this.api(`/contents/${encodePath(filePath)}`, {
            method: 'PUT',
            body: JSON.stringify({
                message,
                content: Buffer.from(text, 'utf8').toString('base64'),
                branch: this.opts.branch,
                ...(prevSha ? { sha: prevSha } : {})
            })
        });
        // 409: sha mismatch; 422: file exists but no sha was supplied.
        if (res.status === 409 || res.status === 422) throw new ConflictError(`${filePath} changed or already exists`);
        if (!res.ok) throw new Error(`GitHub write ${filePath} failed: ${res.status} ${await res.text()}`);
        const data = (await res.json()) as { content: { sha: string }; commit: { sha: string; parents?: Array<{ sha: string }> } };
        return { rev: data.commit.sha, parentRev: data.commit.parents?.[0]?.sha ?? null, sha: data.content.sha };
    }

    async commitFiles(files: FileChange[], message: string): Promise<Omit<WriteResult, 'sha'>> {
        const branch = encodePath(this.opts.branch);
        const head = await this.head();
        const commit = await this.json<{ tree: { sha: string } }>(`/git/commits/${head}`);
        const tree = await this.json<{ truncated: boolean; tree: Array<{ path: string; sha: string; type: string }> }>(`/git/trees/${commit.tree.sha}?recursive=1`);
        const current = new Map(tree.tree.filter(e => e.type === 'blob').map(e => [e.path, e.sha]));
        for (const f of files) {
            // Huge repos return a truncated tree; fall back to asking per file.
            const sha = tree.truncated && !current.has(f.path) ? ((await this.readFile(f.path))?.sha ?? null) : (current.get(f.path) ?? null);
            if (sha !== f.prevSha) throw new ConflictError(`${f.path} changed or already exists`);
        }
        const newTree = await this.json<{ sha: string }>('/git/trees', {
            method: 'POST',
            body: JSON.stringify({ base_tree: commit.tree.sha, tree: files.map(f => ({ path: f.path, mode: '100644', type: 'blob', content: f.text })) })
        });
        const newCommit = await this.json<{ sha: string }>('/git/commits', {
            method: 'POST',
            body: JSON.stringify({ message, tree: newTree.sha, parents: [head] })
        });
        // Not a force update: if someone pushed since `head`, GitHub refuses (422).
        const res = await this.api(`/git/refs/heads/${branch}`, { method: 'PATCH', body: JSON.stringify({ sha: newCommit.sha, force: false }) });
        if (res.status === 422 || res.status === 409) throw new ConflictError('The branch moved while publishing');
        if (!res.ok) throw new Error(`GitHub ref update failed: ${res.status} ${await res.text()}`);
        return { rev: newCommit.sha, parentRev: head };
    }

    async recentChanges(limit: number): Promise<Change[]> {
        const commits = await this.json<Array<{ commit: { message: string; author: { date: string } } }>>(
            `/commits?sha=${encodeURIComponent(this.opts.branch)}&per_page=${limit}`
        );
        return commits.map(c => ({ when: c.commit.author.date, message: c.commit.message.split('\n')[0] }));
    }
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.obsidian', '.trash']);

/** Serves a local checkout. Writes go straight to disk (no git commit). */
export class FsStore implements Store {
    private changes: Change[] = [];

    constructor(private readonly root: string) {}

    private async walk(dir = ''): Promise<string[]> {
        const out: string[] = [];
        for (const entry of await fs.readdir(path.join(this.root, dir), { withFileTypes: true })) {
            if (SKIP_DIRS.has(entry.name)) continue;
            const rel = dir ? `${dir}/${entry.name}` : entry.name;
            if (entry.isDirectory()) out.push(...(await this.walk(rel)));
            else if (entry.name.endsWith('.md')) out.push(rel);
        }
        return out;
    }

    async head(): Promise<string> {
        const hash = createHash('sha1');
        // Markdown pages plus the settings file: a change to either reloads the index.
        for (const rel of [...(await this.walk()).sort(), CONFIG_PATH]) {
            const stat = await fs.stat(path.join(this.root, rel)).catch(() => null);
            if (stat) hash.update(`${rel}:${stat.size}:${stat.mtimeMs}\n`);
        }
        return hash.digest('hex');
    }

    async snapshot(): Promise<Snapshot> {
        const files: StoredFile[] = [];
        for (const rel of await this.walk()) {
            const text = await fs.readFile(path.join(this.root, rel), 'utf8');
            files.push({ path: rel, text, sha: gitBlobSha(text) });
        }
        return { rev: await this.head(), files };
    }

    async readFile(filePath: string): Promise<StoredFile | null> {
        try {
            const text = await fs.readFile(path.join(this.root, filePath), 'utf8');
            return { path: filePath, text, sha: gitBlobSha(text) };
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw err;
        }
    }

    async writeFile(filePath: string, text: string, message: string, prevSha: string | null): Promise<WriteResult> {
        const current = await this.readFile(filePath);
        if ((current?.sha ?? null) !== prevSha) throw new ConflictError(`${filePath} changed or already exists`);
        const parentRev = await this.head();
        const abs = path.join(this.root, filePath);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, text, 'utf8');
        this.changes.unshift({ when: new Date().toISOString(), message });
        return { rev: await this.head(), parentRev, sha: gitBlobSha(text) };
    }

    async commitFiles(files: FileChange[], message: string): Promise<Omit<WriteResult, 'sha'>> {
        for (const f of files) {
            if (((await this.readFile(f.path))?.sha ?? null) !== f.prevSha) throw new ConflictError(`${f.path} changed or already exists`);
        }
        const parentRev = await this.head();
        for (const f of files) {
            const abs = path.join(this.root, f.path);
            await fs.mkdir(path.dirname(abs), { recursive: true });
            await fs.writeFile(abs, f.text, 'utf8');
        }
        this.changes.unshift({ when: new Date().toISOString(), message });
        return { rev: await this.head(), parentRev };
    }

    async recentChanges(limit: number): Promise<Change[]> {
        return this.changes.slice(0, limit);
    }
}
