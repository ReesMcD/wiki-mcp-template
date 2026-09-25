import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { createTar } from 'nanotar';
import { ConflictError, gitBlobSha, GitHubStore } from '../src/store.js';

function fakeGitHub(refStatus = 200) {
    const calls: Array<{ method: string; url: string; body?: any }> = [];
    const tarball = gzipSync(
        createTar([
            { name: 'owner-repo-abc123/', data: undefined },
            { name: 'owner-repo-abc123/People/Ada.md', data: '---\ntype: person\n---\n**Mathematician.**\n' },
            { name: 'owner-repo-abc123/Private/Q & A.md', data: 'secret' },
            { name: 'owner-repo-abc123/_assets/map.png', data: 'png' }
        ])
    );
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer tok');
        if (url.endsWith('/git/ref/heads/main')) return Response.json({ object: { sha: 'abc123' } });
        if (url.endsWith('/tarball/abc123')) return new Response(tarball);
        if (url.includes('/contents/People/Ada.md?ref=main')) return Response.json({ type: 'file', sha: 'blob1', content: Buffer.from('hello').toString('base64') });
        if (url.includes('/contents/Nope.md')) return new Response('', { status: 404 });
        if (method === 'PUT' && url.endsWith('/contents/People/Ada.md')) return new Response('conflict', { status: 409 });
        if (method === 'PUT') return Response.json({ content: { sha: 'blob2' }, commit: { sha: 'def456', parents: [{ sha: 'abc123' }] } });
        if (url.endsWith('/git/commits/abc123')) return Response.json({ tree: { sha: 'tree1' } });
        if (url.endsWith('/git/trees/tree1?recursive=1')) return Response.json({ truncated: false, tree: [{ path: 'People/Ada.md', sha: 'blob1', type: 'blob' }, { path: 'People', sha: 't', type: 'tree' }] });
        if (method === 'POST' && url.endsWith('/git/trees')) return Response.json({ sha: 'tree2' });
        if (method === 'POST' && url.endsWith('/git/commits')) return Response.json({ sha: 'commit2' });
        if (method === 'PATCH' && url.endsWith('/git/refs/heads/main')) return refStatus === 200 ? Response.json({}) : new Response('not fast-forward', { status: refStatus });
        throw new Error(`unexpected ${method} ${url}`);
    }) as typeof fetch;
    return { calls, store: new GitHubStore({ owner: 'owner', repo: 'repo', branch: 'main', token: 'tok', fetch: fetchImpl }) };
}

test('snapshot reads Markdown files out of the tarball with correct blob SHAs', async () => {
    const { store } = fakeGitHub();
    const snap = await store.snapshot();
    assert.equal(snap.rev, 'abc123');
    assert.deepEqual(snap.files.map(f => f.path).sort(), ['People/Ada.md', 'Private/Q & A.md']);
    const ada = snap.files.find(f => f.path === 'People/Ada.md')!;
    assert.equal(ada.sha, gitBlobSha(ada.text));
    // Known value: `printf 'secret' | git hash-object --stdin`
    assert.equal(gitBlobSha('secret'), '536aca34dbae6b2b8af26bebdcba83543c9546f0');
});

test('reads, writes and maps conflicts', async () => {
    const { store, calls } = fakeGitHub();
    assert.equal((await store.readFile('People/Ada.md'))?.text, 'hello');
    assert.equal(await store.readFile('Nope.md'), null);
    await assert.rejects(store.writeFile('People/Ada.md', 'x', 'msg', 'blob1'), ConflictError);
    const res = await store.writeFile('Private/Q & A.md', 'new', 'Add Q&A', null);
    assert.deepEqual(res, { rev: 'def456', parentRev: 'abc123', sha: 'blob2' });
    const put = calls.at(-1)!;
    assert.match(put.url, /\/contents\/Private\/Q%20%26%20A\.md$/);
    assert.equal(put.body.branch, 'main');
    assert.equal(put.body.sha, undefined);
    assert.equal(Buffer.from(put.body.content, 'base64').toString(), 'new');
});

test('commitFiles makes one commit on top of head and detects conflicts', async () => {
    const { store, calls } = fakeGitHub();
    const res = await store.commitFiles(
        [
            { path: 'People/Ada.md', text: 'new ada', prevSha: 'blob1' },
            { path: 'Projects/Japan Trip.md', text: 'japan', prevSha: null }
        ],
        'Add Japan trip'
    );
    assert.deepEqual(res, { rev: 'commit2', parentRev: 'abc123' });
    const tree = calls.find(c => c.method === 'POST' && c.url.endsWith('/git/trees'))!;
    assert.equal(tree.body.base_tree, 'tree1');
    assert.deepEqual(tree.body.tree.map((t: { path: string }) => t.path), ['People/Ada.md', 'Projects/Japan Trip.md']);
    const commit = calls.find(c => c.method === 'POST' && c.url.endsWith('/git/commits'))!;
    assert.deepEqual(commit.body, { message: 'Add Japan trip', tree: 'tree2', parents: ['abc123'] });
    assert.deepEqual(calls.at(-1)!.body, { sha: 'commit2', force: false });

    await assert.rejects(store.commitFiles([{ path: 'People/Ada.md', text: 'x', prevSha: 'stale' }], 'm'), ConflictError);
    await assert.rejects(store.commitFiles([{ path: 'People/Ada.md', text: 'x', prevSha: null }], 'm'), ConflictError);
    await assert.rejects(fakeGitHub(422).store.commitFiles([{ path: 'New.md', text: 'x', prevSha: null }], 'm'), ConflictError);
});
