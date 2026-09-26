import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { exportPublic } from '../src/export.js';
import { unlinkLinks } from '../src/markdown.js';
import { fixtureWiki } from './helpers.js';

test('unlinkLinks keeps the label or the name, drops hidden embeds, skips code', () => {
    const hide = (t: string) => t === 'Secret';
    assert.equal(unlinkLinks('[[Secret|the plan]], [[Secret#x]], ![[Secret]], [[Open]], `[[Secret]]`', hide), 'the plan, Secret, , [[Open]], `[[Secret]]`');
});

test('the public export leaves out private and raw material', async () => {
    const { root, wiki, write } = fixtureWiki();
    await wiki.log('raw note about the surprise');
    write('Inbox/Scratch.md', '**Unsorted.**\n');
    write('Topics/Birthdays.md', '---\ntype: topic\nvisibility: public\nprivate_budget: 200\n---\n**Birthdays.** Plans: [[Surprise Party|the dinner]], [[Ada]] and [[Not Written Yet]].\n\n![[cake.png]] ![[vault.png]]\n');
    write('_assets/cake.png', 'png');
    write('_assets/unused.png', 'png');
    write('Private/vault.png', 'png');
    const out = mkdtempSync(path.join(tmpdir(), 'site-'));
    const r = await exportPublic(root, out);

    assert.ok(r.pages.includes('People/Ada Lovelace.md'));
    for (const p of ['Private/Surprise Party.md', 'Log/2026-09-27.md', 'Inbox/Scratch.md']) {
        assert.ok(r.skipped.includes(p), p);
        assert.ok(!existsSync(path.join(out, p)), p);
    }
    const ada = readFileSync(path.join(out, 'People/Ada Lovelace.md'), 'utf8');
    assert.match(ada, /Mathematician and friend/);
    assert.doesNotMatch(ada, /Project Babbage|London|Private Notes/);

    const topic = readFileSync(path.join(out, 'Topics/Birthdays.md'), 'utf8');
    assert.match(topic, /Plans: the dinner, \[\[Ada\]\] and \[\[Not Written Yet\]\]\./, 'only links to hidden pages are unlinked');
    assert.doesNotMatch(topic, /visibility|private_budget/);
    assert.deepEqual(r.assets, ['_assets/cake.png'], 'only used, non-private attachments');

    // Home becomes the site's front page and stays linkable as [[Home]].
    assert.ok(!existsSync(path.join(out, 'Home.md')));
    assert.match(readFileSync(path.join(out, 'index.md'), 'utf8'), /^---\ntype: hub\naliases:\n  - Index\n  - Start\n  - Home\ntitle: Home\n---/);
});
