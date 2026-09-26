import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { rewriteLinks } from '../src/markdown.js';
import { fixtureWiki } from './helpers.js';

test('rewriteLinks keeps headings, labels and embeds, and skips code', () => {
    const text = 'a [[Ada]] b [[ada#About|her]] c ![[Ada]] d `[[Ada]]`\n```\n[[Ada]]\n```\n[[People/Ada.md|x]] [[Adam]]';
    const out = rewriteLinks(text, t => (t.toLowerCase() === 'ada' ? 'Grace' : t === 'People/Ada.md' ? 'People/Grace' : null));
    assert.equal(out, 'a [[Grace]] b [[Grace#About|her]] c ![[Grace]] d `[[Ada]]`\n```\n[[Ada]]\n```\n[[People/Grace|x]] [[Adam]]');
});

test('rename: rewrites title links everywhere, keeps the old title as an alias, one commit', async () => {
    const { wiki, root, store } = fixtureWiki();
    const preview = await wiki.move('Ada Lovelace', { newName: 'Augusta Ada King', dryRun: true });
    assert.equal(preview.committed, false);
    assert.deepEqual(preview.edits.map(e => [e.title, e.links]), [['Analytical Engine', 1]]);
    assert.ok(existsSync(path.join(root, 'People/Ada Lovelace.md')), 'dry run writes nothing');

    const done = await wiki.move('Ada Lovelace', { newName: 'Augusta Ada King' });
    assert.ok(done.committed);
    assert.equal(done.to, 'People/Augusta Ada King.md');
    assert.ok(!existsSync(path.join(root, 'People/Ada Lovelace.md')));
    const moved = readFileSync(path.join(root, 'People/Augusta Ada King.md'), 'utf8');
    assert.match(moved, /Ada Lovelace/, 'old title kept as an alias');
    assert.match(moved, /Mathematician and friend/);
    const engine = readFileSync(path.join(root, 'Projects/Analytical Engine.md'), 'utf8');
    assert.match(engine, /\[\[Augusta Ada King\|Ada\]\]/);
    assert.match(engine, /- \[\[Ada\]\]\n/, 'alias links are left alone');
    // Lookups by the old name still work, and backlinks survive.
    assert.equal((await wiki.resolve('Ada Lovelace')).path, 'People/Augusta Ada King.md');
    assert.deepEqual((await wiki.backlinks(await wiki.resolve('Augusta Ada King'))).map(p => p.title).sort(), ['Analytical Engine', 'Kitchen Remodel']);
    assert.equal((await store.recentChanges(1))[0].message, 'Move Ada Lovelace → People/Augusta Ada King');
});

test('folder move: only path links change; code is untouched', async () => {
    const { wiki, root, write } = fixtureWiki();
    write('Inbox/Sourdough.md', '---\ntype: note\n---\n**Starter feeding schedule.**\n');
    write('Topics/Baking.md', '---\ntype: topic\n---\n**Bread.**\n\nSee [[Sourdough]], [[Inbox/Sourdough|the notes]] and `[[Inbox/Sourdough]]`.\n');
    const r = await wiki.move('Sourdough', { folder: 'Topics/Baking' });
    assert.equal(r.to, 'Topics/Baking/Sourdough.md');
    assert.equal(r.aliasAdded, false);
    const baking = readFileSync(path.join(root, 'Topics/Baking.md'), 'utf8');
    assert.match(baking, /See \[\[Sourdough\]\], \[\[Topics\/Baking\/Sourdough\|the notes\]\] and `\[\[Inbox\/Sourdough\]\]`\./);
    assert.equal((await wiki.resolve('Sourdough')).type, 'note');
    assert.equal((await wiki.health()).inbox.length, 0);
});

test('moves that would clash or go nowhere are refused', async () => {
    const { wiki } = fixtureWiki();
    await assert.rejects(wiki.move('Ada', {}), /already at/);
    await assert.rejects(wiki.move('Ada', { newName: 'Kitchen Remodel', folder: 'Projects' }), /already exists/);
    await assert.rejects(wiki.move('Ada', { newName: 'The Engine' }), /already exists as \[\[Analytical Engine\]\]/);
    await assert.rejects(wiki.move('Ada', { folder: '../outside' }), /isn't a wiki content folder/);
    await assert.rejects(wiki.move('Ada', { folder: 'docs' }), /isn't a wiki content folder/);
    await assert.rejects(wiki.move('Ada', { newName: 'a/b' }), /can't be used/);
});

test('history lists a page\'s changes and shows old versions, also after a move', async () => {
    const { wiki } = fixtureWiki();
    await wiki.update('Kitchen Remodel', { frontmatter: { status: 'paused' } }, 'Pause the remodel');
    await wiki.update('Kitchen Remodel', { frontmatter: { status: 'done' } }, 'Finish the remodel');
    const h = await wiki.history('Kitchen Remodel');
    assert.deepEqual(h.versions.map(v => v.message), ['Finish the remodel', 'Pause the remodel']);
    const old = await wiki.versionAt('Kitchen Remodel', h.versions[1].rev.slice(0, 7));
    assert.match(old.text, /status: paused/);
    await assert.rejects(wiki.versionAt('Kitchen Remodel', 'nope1234'), /didn't exist at version/);

    await wiki.move('Kitchen Remodel', { newName: 'Kitchen' });
    assert.equal((await wiki.history('Projects/Kitchen Remodel')).versions.length, 3, 'the old path still has its history');
});
