import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_CONFIG, instructionsFor, isWikiPath, parseConfig, slug, typeForFolder } from '../src/settings.js';
import { fixtureWiki } from './helpers.js';

const fixtures = path.resolve(import.meta.dirname, 'fixtures');

test('DEFAULT_CONFIG matches the documented default wiki.config.yaml', () => {
    // test/fixtures/wiki.config.yaml is the file the template ships with.
    const { config, error } = parseConfig(readFileSync(path.join(fixtures, 'wiki.config.yaml'), 'utf8'));
    assert.equal(error, null);
    assert.deepEqual({ ...config, timezone: undefined }, { ...DEFAULT_CONFIG, timezone: undefined });
    for (const type of Object.keys(config.types)) assert.ok(existsSync(path.join(fixtures, '_templates', `${type}.md`)), `fixtures/_templates/${type}.md`);
});

test('missing settings fall back to defaults; log and private merge key by key', () => {
    assert.deepEqual(parseConfig(null).config, DEFAULT_CONFIG);
    assert.deepEqual(parseConfig('').config, DEFAULT_CONFIG);
    const { config, error } = parseConfig('name: Work Notes\nlog:\n  folder: /Journal/\nprivate:\n  lineMarker: "(secret)"\n');
    assert.equal(error, null);
    assert.equal(config.name, 'Work Notes');
    assert.deepEqual(config.log, { folder: 'Journal', dayStartHour: 4 });
    assert.equal(config.private.lineMarker, '(secret)');
    assert.deepEqual(config.private.folders, ['Private']);
    assert.deepEqual(config.types, DEFAULT_CONFIG.types);
});

test('broken settings fall back to the defaults with a readable error', () => {
    for (const [text, why] of [
        ['name: [unclosed', /isn't valid YAML/],
        ['timezone: Mars/Olympus', /unknown time zone "Mars\/Olympus"/],
        ['types:\n  person: {}', /types\.person\.folder/],
        ['- a list', /key: value/]
    ] as const) {
        const { config, error } = parseConfig(text);
        assert.equal(config, DEFAULT_CONFIG, text);
        assert.match(error ?? '', why, text);
    }
});

test('paths, types and names', () => {
    const c = DEFAULT_CONFIG;
    assert.ok(isWikiPath('People/Ada.md', c));
    assert.ok(isWikiPath('Home.md', c));
    for (const p of ['README.md', 'CLAUDE.md', 'docs/setup.md', 'claude/project-instructions.md', 'mcp/README.md', '_templates/person.md', '.obsidian/x.md', 'People/photo.png']) {
        assert.ok(!isWikiPath(p, c), p);
    }
    assert.equal(typeForFolder('Private/Drafts', c), 'draft');
    assert.equal(typeForFolder('Log', c), 'log');
    assert.equal(slug('Rees’s Wiki!'), 'rees-s-wiki');
    const instructions = instructionsFor({ ...c, instructions: 'Tag client pages `client`.' });
    assert.match(instructions, /^My Wiki: A personal knowledge wiki/);
    assert.match(instructions, /person → People\//);
    assert.match(instructions, /pages in Private\//);
    assert.match(instructions, /Tag client pages/);
});

test('the wiki follows its config file, and picks up changes to it', async () => {
    const config = `
name: Kitchen
timezone: Europe/London
log: { folder: Journal, dayStartHour: 0 }
inbox: null
types:
  recipe: { folder: Recipes, description: A dish }
private:
  folders: [Vault]
  headings: [Secret]
  lineMarker: "(shh)"
`;
    const { wiki, write } = fixtureWiki(new Date('2026-09-27T23:30:00Z'), { config });
    assert.equal(wiki.configError, null);
    assert.equal((await wiki.create({ type: 'recipe', name: 'Pancakes', summary: 'Sunday pancakes' })).path, 'Recipes/Pancakes.md');
    // 23:30 UTC is 00:30 the next day in London, and the day starts at midnight.
    assert.equal((await wiki.log('Buy flour')).path, 'Journal/2026-09-28.md');
    write('Vault/Card PIN.md', '**1234**\n');
    write('Notes/Family Recipe.md', '**Grandma\'s stew.**\nAdd a pinch of cinnamon (shh)\n\n## Secret\nand a splash of whisky\n\n## Private Notes\nnot private in this config\n');
    const stew = await wiki.resolve('Family Recipe');
    assert.doesNotMatch(wiki.bodyFor(stew, true), /cinnamon|whisky/);
    assert.match(wiki.bodyFor(stew, true), /not private in this config/);
    assert.ok((await wiki.resolve('Card PIN')).private);
    assert.equal((await wiki.health()).inbox.length, 0);

    write('wiki.config.yaml', 'types:\n  recipe: { folder: Cookbook }\n');
    assert.equal((await wiki.create({ type: 'recipe', name: 'Waffles', summary: 'Crispy' })).path, 'Cookbook/Waffles.md');
    assert.equal((await wiki.config()).name, 'My Wiki');

    write('wiki.config.yaml', 'timezone: Nowhere/Land\n');
    assert.match((await wiki.health()).configError ?? '', /unknown time zone/);
});
