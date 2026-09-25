import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { PublishOp } from '../src/wiki.js';
import { fixtureWiki } from './helpers.js';

const trip: PublishOp[] = [
    {
        action: 'create',
        type: 'project',
        name: 'Japan Trip',
        summary: 'Two weeks in Japan next April: Tokyo, Kyoto and the Alps',
        frontmatter: { aliases: ['Japan'], due: '2027-04-01', budget: 5000 },
        sections: { Goal: '- Book flights by January\n- See [[Kyoto]] in cherry blossom season', 'Private Notes': 'Proposing in Kyoto.' }
    },
    { action: 'create', type: 'topic', name: 'Kyoto', folder: 'Topics/Japan', summary: 'Old capital of [[Japan Trip|Japan]]; temples and gardens' },
    { action: 'create', type: 'person', name: 'Kenji Sato', summary: 'Friend in Tokyo who offered a place to stay', frontmatter: { related: ['[[Japan Trip]]'] } },
    { action: 'update', name: 'Ada', sections: [{ heading: 'Interactions', content: '- Recommended [[Japan Trip|the Japan trip]] guidebook.' }] },
    { action: 'update', name: 'Ada', frontmatter: { status: 'traveling' } }
];

test('dry run returns the plan and writes nothing', async () => {
    const { wiki, root } = fixtureWiki();
    const { plan, committed } = await wiki.publish(trip, { message: 'Add Japan trip', dryRun: true });
    assert.equal(committed, false);
    assert.deepEqual(
        plan.map(p => `${p.action} ${p.path}`),
        ['create Projects/Japan Trip.md', 'create Topics/Japan/Kyoto.md', 'create People/Kenji Sato.md', 'update People/Ada Lovelace.md']
    );
    assert.ok(!existsSync(path.join(root, 'Projects/Japan Trip.md')));
    assert.doesNotMatch(readFileSync(path.join(root, 'People/Ada Lovelace.md'), 'utf8'), /traveling/);
});

test('publish writes every page, merges edits to the same page, and indexes them', async () => {
    const { wiki, root } = fixtureWiki();
    const { committed } = await wiki.publish(trip, { message: 'Add Japan trip' });
    assert.ok(committed);
    const project = readFileSync(path.join(root, 'Projects/Japan Trip.md'), 'utf8');
    assert.match(project, /^---\ntype: project\n/);
    assert.match(project, /budget: 5000/);
    assert.match(project, /## Goal\n- Book flights by January\n/);
    assert.match(project, /## Private Notes\nProposing in Kyoto.\n$/);
    assert.doesNotMatch(project, /<!--/);
    const ada = readFileSync(path.join(root, 'People/Ada Lovelace.md'), 'utf8');
    assert.match(ada, /status: traveling/);
    assert.match(ada, /Engine notes.\n- Recommended \[\[Japan Trip\|the Japan trip\]\] guidebook\./);
    assert.equal((await wiki.resolve('Japan')).path, 'Projects/Japan Trip.md');
    assert.deepEqual((await wiki.backlinks(await wiki.resolve('Japan Trip'))).map(p => p.title).sort(), ['Ada Lovelace', 'Kenji Sato', 'Kyoto']);
    assert.equal((await wiki.recentChanges(1))[0].message, 'Add Japan trip');
});

test('all problems are reported together and nothing is written', async () => {
    const { wiki, root } = fixtureWiki();
    await assert.rejects(
        wiki.publish(
            [
                { action: 'create', type: 'person', name: 'Brakka', summary: 'a' },
                { action: 'create', type: 'person', name: 'The Countess', summary: 'clashes with an existing alias' },
                { action: 'create', type: 'person', name: 'brakka', summary: 'duplicate in batch' },
                { action: 'update', name: 'Grace Hopper', summary: 'no such page' },
                { action: 'update', name: 'Ada', replace: [{ find: 'not there', with: 'x' }] }
            ],
            { message: 'bad batch' }
        ),
        (err: Error) => {
            assert.match(err.message, /Nothing was published/);
            assert.match(err.message, /#2 .*already exists as \[\[Ada Lovelace\]\]/);
            assert.match(err.message, /#3 .*used twice in this batch/);
            assert.match(err.message, /#4 .*No page named "Grace Hopper"/);
            assert.match(err.message, /#5 .*was not found/);
            return true;
        }
    );
    assert.ok(!existsSync(path.join(root, 'People/Brakka.md')));
});

test('template hints are stripped from new pages', async () => {
    const { wiki, root } = fixtureWiki();
    await wiki.create({ type: 'person', name: 'Mira', summary: 'Neighbour' });
    const text = readFileSync(path.join(root, 'People/Mira.md'), 'utf8');
    assert.doesNotMatch(text, /how you know them|<!--/);
    assert.match(text, /## About\n\n## Interactions/);
});

test('drafts are private and hidden from public-only reads', async () => {
    const { wiki } = fixtureWiki();
    const draft = await wiki.create({ type: 'draft', name: 'Draft - Garden', summary: 'Brainstorm for the vegetable garden', sections: { Decisions: '- Raised beds, tomatoes and beans' } });
    assert.equal(draft.path, 'Private/Drafts/Draft - Garden.md');
    assert.ok(draft.private);
    assert.equal((await wiki.search('raised beds tomatoes', { publicOnly: true })).length, 0);
    const h = await wiki.health();
    assert.ok(!h.orphans.some(p => p.path === draft.path));
});
