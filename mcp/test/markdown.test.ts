import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editSection, extractLinks, isPrivateHeading, normalizeName, parseFrontmatter, patchFrontmatter, setSummary, stripPrivate, summaryLine } from '../src/markdown.js';

const rules = { headings: ['Private', 'Private Notes'], lineMarker: '(private)' };

test('frontmatter patch keeps existing keys and quotes wikilinks', () => {
    const fm = 'type: person # keep me\nstatus: active\naliases: [Ada]';
    const out = patchFrontmatter(fm, { status: 'archived', organization: '[[Royal Society]]', aliases: null });
    assert.match(out, /# keep me/);
    assert.match(out, /status: archived/);
    assert.doesNotMatch(out, /aliases/);
    assert.equal(parseFrontmatter(`---\n${out}\n---\nbody`).data.organization, '[[Royal Society]]');
});

test('patching a page with no frontmatter produces block YAML', () => {
    assert.equal(patchFrontmatter(null, { type: 'note', tags: ['a'] }), 'type: note\ntags:\n  - a');
});

test('links, names and summaries', () => {
    assert.deepEqual(extractLinks('see [[Ada|the countess]], [[Kitchen Remodel#Log]] and ![[plan.png]]'), ['Ada', 'Kitchen Remodel', 'plan.png']);
    assert.deepEqual(extractLinks('write `[[Page Title]]` to link\n```\n[[Not A Link]]\n```\n[[Real]]'), ['Real']);
    assert.equal(normalizeName('The Analytical Engine'), 'analytical engine');
    assert.equal(normalizeName('Topics/Café Culture.md'), 'cafe culture');
    assert.equal(summaryLine('\n**Mathematician and [[Ada|friend]].**\n\n## About'), 'Mathematician and friend.');
    assert.equal(summaryLine('**{{summary}}**\n'), '');
});

test('section edits: append, replace, create above the private section, placeholder replaced', () => {
    const body = '**S**\n\n## Next Steps\n- \n\n## Log\n1. a\n\n## Private Notes\nsecret\n';
    let out = editSection(body, 'Next Steps', 'append', '- call the plumber', rules);
    assert.match(out, /## Next Steps\n- call the plumber\n\n## Log/);
    out = editSection(out, 'log', 'append', '2. b', rules);
    assert.match(out, /1\. a\n2\. b\n\n## Private Notes/);
    out = editSection(out, 'Budget', 'append', '- $2,000', rules);
    assert.match(out, /## Budget\n- \$2,000\n\n## Private Notes/);
    out = editSection(out, 'Private Notes', 'replace', 'new secret', rules);
    assert.match(out, /## Private Notes\nnew secret\n$/);
});

test('subsections stay attached to their parent section', () => {
    const body = '## Places\nintro\n### Kyoto\nkyoto text\n## Other\n';
    const out = editSection(body, 'Places', 'append', 'more');
    assert.equal(out, '## Places\nintro\nmore\n\n### Kyoto\nkyoto text\n## Other\n');
});

test('private material is stripped', () => {
    const body = '**Friend.** %%moving soon%%\n\n## About\nnice\nOwes me money (private)\nAlso (PRIVATE) this\n\n## Private Notes\nsecret\n### Sub\nalso secret\n\n## After\nvisible\n';
    const out = stripPrivate(body, rules);
    assert.doesNotMatch(out, /moving|secret|money|this/);
    assert.match(out, /nice/);
    assert.match(out, /## After\nvisible/);
    // Without rules only %%comments%% are private.
    assert.match(stripPrivate(body, { headings: [], lineMarker: null }), /Owes me money[\s\S]*## Private Notes/);
});

test('private headings match whole words only', () => {
    assert.ok(isPrivateHeading('Private', rules));
    assert.ok(isPrivateHeading('private notes', rules));
    assert.ok(isPrivateHeading('Private: money', rules));
    assert.ok(!isPrivateHeading('Privateer ships', rules));
    assert.ok(!isPrivateHeading('Notes', rules));
});

test('setSummary replaces the first bold line or inserts one', () => {
    assert.equal(setSummary('**old**\n\n## A', 'new'), '**new**\n\n## A');
    assert.equal(setSummary('## A\ntext', 'new'), '**new**\n\n## A\ntext');
});
