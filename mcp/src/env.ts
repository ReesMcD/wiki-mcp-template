import { timingSafeEqual } from 'node:crypto';
import { GitHubStore } from './store.js';
import { Wiki } from './wiki.js';

function required(env: NodeJS.ProcessEnv, key: string): string {
    const value = env[key]?.trim();
    if (!value) throw new Error(`Missing environment variable ${key}`);
    return value;
}

/** Build the GitHub-backed wiki from environment variables (see README). */
export function wikiFromEnv(env: NodeJS.ProcessEnv = process.env): Wiki {
    const [owner, repo] = required(env, 'WIKI_REPO').split('/');
    if (!owner || !repo) throw new Error('WIKI_REPO must look like "owner/repo"');
    const store = new GitHubStore({ owner, repo, branch: env.WIKI_BRANCH?.trim() || 'main', token: required(env, 'GITHUB_TOKEN') });
    return new Wiki(store, { timeZone: env.WIKI_TIMEZONE?.trim() || undefined });
}

/**
 * The connector URL carries a secret: https://<host>/mcp/<MCP_SECRET>.
 * Also accepted: ?key=<secret> or "Authorization: Bearer <secret>".
 */
export function isAuthorized(request: Request, secret: string): boolean {
    const url = new URL(request.url);
    const candidates = [
        url.searchParams.get('key'),
        url.searchParams.get('token'),
        url.pathname.split('/').filter(Boolean).pop(),
        request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    ];
    const want = Buffer.from(secret);
    return candidates.some(c => {
        if (!c) return false;
        const got = Buffer.from(c);
        return got.length === want.length && timingSafeEqual(got, want);
    });
}
