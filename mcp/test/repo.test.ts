// Checks this repo's own wiki setup (not the server code): run by CI whenever
// wiki.config.yaml or _templates/ change, so a broken config fails fast.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parseFrontmatter } from '../src/markdown.js';
import { CONFIG_PATH, parseConfig } from '../src/settings.js';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const configPath = path.join(repoRoot, CONFIG_PATH);
const { config, error } = parseConfig(existsSync(configPath) ? readFileSync(configPath, 'utf8') : null);

test(`${CONFIG_PATH} is valid`, () => {
    assert.equal(error, null);
});

test('every page type in the config has a template', { skip: error ? 'the config is invalid (see above)' : false }, () => {
    const missing = Object.keys(config.types).filter(type => !existsSync(path.join(repoRoot, '_templates', `${type}.md`)));
    assert.deepEqual(missing, [], `Add _templates/<type>.md for: ${missing.join(', ')}`);
});

test('every template has valid frontmatter with a type', () => {
    const dir = path.join(repoRoot, '_templates');
    if (!existsSync(dir)) return;
    for (const file of readdirSync(dir).filter(f => f.endsWith('.md'))) {
        const text = readFileSync(path.join(dir, file), 'utf8');
        // Obsidian placeholders like {{date}} aren't valid YAML until filled in.
        const { data, fmText } = parseFrontmatter(text.replace(/\{\{[^}]*\}\}/g, 'x'));
        assert.ok(fmText !== null, `_templates/${file} has no frontmatter`);
        assert.ok(typeof data.type === 'string' && data.type, `_templates/${file} needs a "type:" field in valid YAML frontmatter`);
    }
});
