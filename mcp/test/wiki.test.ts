import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { WikiError } from '../src/wiki.js';
import { fixtureWiki } from './helpers.js';

test('finds pages by title, alias, prefix and typo', async () => {
    const { wiki } = fixtureWiki();
    for (const q of ['Ada Lovelace', 'ada', 'the countess', 'Countess of Lovelace', 'Ada Lovelac', '[[Ada]]', 'People/Ada Lovelace.md']) {
        assert.equal((await wiki.resolve(q)).title, 'Ada Lovelace', q);
    }
    assert.equal((await wiki.resolve('the engine')).title, 'Analytical Engine');
    await assert.rejects(wiki.resolve('Grace Hopper'), WikiError);
});

test('public-only mode hides private pages and private material', async () => {
    const { wiki } = fixtureWiki();
    await assert.rejects(wiki.resolve('Surprise Party', { publicOnly: true }), WikiError);
    const ada = await wiki.resolve('Ada');
    assert.ok(!ada.private);
    assert.doesNotMatch(wiki.bodyFor(ada, true), /Project Babbage|London/);
    assert.match(wiki.bodyFor(ada, false), /Project Babbage/);
    assert.equal((await wiki.search('surprise birthday', { publicOnly: true })).length, 0);
    assert.equal((await wiki.search('surprise birthday'))[0]?.page.title, 'Surprise Party');
});

test('search ranks the most relevant page first', async () => {
    const { wiki } = fixtureWiki();
    const hits = await wiki.search('leaking sink contractors');
    assert.equal(hits[0].page.title, 'Kitchen Remodel');
    assert.match(hits[0].snippet, /leaking sink/);
    assert.equal((await wiki.search('who owes me a reply', { type: 'person' }))[0]?.page.title, 'Ada Lovelace');
});

test('backlinks resolve through aliases', async () => {
    const { wiki } = fixtureWiki();
    const back = await wiki.backlinks(await wiki.resolve('Ada'));
    assert.deepEqual(back.map(p => p.title).sort(), ['Analytical Engine', 'Kitchen Remodel']);
});

test('types come from the folder when a page has no type field', async () => {
    const { wiki, write } = fixtureWiki();
    write('Sources/Sapiens.md', '**A book about the history of humans.**\n');
    write('Projects/Home/Garden.md', '**Plant the vegetable beds.**\n');
    write('Random/Thing.md', '**Something.**\n');
    assert.equal((await wiki.resolve('Sapiens')).type, 'source');
    assert.equal((await wiki.resolve('Garden')).type, 'project');
    assert.equal((await wiki.resolve('Random/Thing')).type, 'page');
});

test('create uses the template, fills fields and refuses duplicates', async () => {
    const { wiki, root } = fixtureWiki();
    const page = await wiki.create({
        type: 'person',
        name: 'Grace Hopper',
        summary: 'Rear admiral and compiler pioneer',
        frontmatter: { aliases: ['Grace'], organization: '[[US Navy]]' },
        sections: { About: 'Hands out nanoseconds.' }
    });
    assert.equal(page.path, 'People/Grace Hopper.md');
    const text = readFileSync(path.join(root, page.path), 'utf8');
    assert.match(text, /^---\ntype: person\n/);
    assert.match(text, /organization: "\[\[US Navy\]\]"/);
    assert.match(text, /\*\*Rear admiral and compiler pioneer\*\*/);
    assert.match(text, /## About\nHands out nanoseconds.\n/);
    assert.match(text, /## Private Notes/);
    assert.equal((await wiki.resolve('Grace')).path, page.path);
    await assert.rejects(wiki.create({ type: 'person', name: 'grace hopper', summary: 'x' }), /already exists/);
    await assert.rejects(wiki.create({ type: 'person', name: 'Someone', summary: 'x', frontmatter: { aliases: ['the countess'] } }), /already exists/);
    await assert.rejects(wiki.create({ type: 'person', name: 'a/b', summary: 'x' }), /can't be used/);
    await assert.rejects(wiki.create({ type: 'person', name: 'X', summary: 'x', folder: '../etc' }), /isn't a wiki content folder/);
    await assert.rejects(wiki.create({ type: 'note', name: 'X', summary: 'x', folder: 'docs' }), /isn't a wiki content folder/);
    // Unknown types still work: they land in the default folder with a minimal page.
    assert.equal((await wiki.create({ type: 'recipe', name: 'Pancakes', summary: 'Sunday pancakes' })).path, 'Inbox/Pancakes.md');
});

test('update patches frontmatter, sections, replacements and summary', async () => {
    const { wiki, root } = fixtureWiki();
    const { changed } = await wiki.update('Ada', {
        frontmatter: { status: 'archived' },
        replace: [{ find: 'hates phone calls', with: 'loves phone calls' }],
        sections: [{ heading: 'Interactions', content: '- 2026-09-20: she finally replied.' }],
        summary: 'Mathematician and friend; replied about the translation notes.'
    });
    assert.ok(changed);
    const text = readFileSync(path.join(root, 'People/Ada Lovelace.md'), 'utf8');
    assert.match(text, /status: archived/);
    assert.match(text, /loves phone calls/);
    assert.match(text, /Engine notes.\n- 2026-09-20: she finally replied.\n/);
    assert.match(text, /^\*\*Mathematician and friend; replied about the translation notes.\*\*$/m);
    await assert.rejects(wiki.update('Ada', { replace: [{ find: 'nope', with: 'x' }] }), /was not found/);
    assert.equal((await wiki.update('Ada', { frontmatter: { status: 'archived' } })).changed, false);
});

test('new sections go above the private section', async () => {
    const { wiki, root } = fixtureWiki();
    await wiki.update('Ada', { sections: [{ heading: 'Books', content: '- Sketch of the Analytical Engine' }] });
    const text = readFileSync(path.join(root, 'People/Ada Lovelace.md'), 'utf8');
    assert.match(text, /## Books\n- Sketch of the Analytical Engine\n\n## Private Notes/);
});

test('ambiguous names are refused rather than guessed', async () => {
    const { wiki } = fixtureWiki();
    await wiki.create({ type: 'person', name: 'Mira Vale', summary: 'a' });
    await wiki.create({ type: 'person', name: 'Mira Vane', summary: 'b' });
    await assert.rejects(wiki.resolve('Mira'), /ambiguous/);
});

test('log appends timestamped lines from the log template; late-night entries stay on the same day', async () => {
    // 23:30 UTC = 19:30 in New York.
    const { wiki, root } = fixtureWiki(new Date('2026-09-27T23:30:00Z'));
    await wiki.log('Call the plumber\n- Ask Ada about the notes');
    const { path: logPath } = await wiki.log('Idea: a recipe section');
    assert.equal(logPath, 'Log/2026-09-27.md');
    const text = readFileSync(path.join(root, logPath), 'utf8');
    assert.match(text, /^---\ntype: log\ndate: 2026-09-27\nprocessed: false\n---\n\*\*Log for 2026-09-27\./);
    assert.match(text, /\n\n- 19:30 Call the plumber\n- 19:30 Ask Ada about the notes\n- 19:30 Idea: a recipe section\n$/);

    // 1:15am New York on the 28th still belongs to the 27th (dayStartHour: 4).
    const late = fixtureWiki(new Date('2026-09-28T05:15:00Z'));
    assert.equal((await late.wiki.log('Can\'t sleep')).path, 'Log/2026-09-27.md');
    // 4:30am is a new day.
    const early = fixtureWiki(new Date('2026-09-28T08:30:00Z'));
    assert.equal((await early.wiki.log('Morning run')).path, 'Log/2026-09-28.md');
    await assert.rejects(wiki.log('x', { date: 'yesterday' }), /YYYY-MM-DD/);
});

test('health reports broken links, orphans, unprocessed logs and the inbox', async () => {
    const { wiki, write } = fixtureWiki();
    await wiki.log('something happened');
    write('Inbox/Scratch.md', '**Unsorted.**\n');
    write('Topics/Lonely.md', '---\ntype: topic\n---\n**Nothing links here.**\n');
    const h = await wiki.health();
    assert.equal(h.configError, null);
    assert.ok(h.broken.has('Analytical Society'));
    assert.ok(h.broken.has('Charles Babbage'));
    assert.ok(!h.broken.has('Ada'));
    assert.ok(h.orphans.some(p => p.title === 'Lonely'));
    // Hubs, the dashboard, logs and standalone types (note, draft) are never orphans.
    assert.ok(!h.orphans.some(p => ['Home', 'Dashboard', 'Surprise Party'].includes(p.title) || p.type === 'log'));
    assert.equal(h.unprocessedLogs.length, 1);
    assert.deepEqual(h.inbox.map(p => p.title), ['Scratch']);
});

test('the index picks up edits made outside the server (e.g. Obsidian)', async () => {
    const { wiki, store } = fixtureWiki();
    await wiki.pages();
    const file = await store.readFile('Projects/Kitchen Remodel.md');
    await store.writeFile(file!.path, file!.text.replace('status: active', 'status: done'), 'edit', file!.sha);
    assert.equal((await wiki.resolve('Kitchen Remodel')).data.status, 'done');
});
