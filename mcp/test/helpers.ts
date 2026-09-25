import { cpSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FsStore } from '../src/store.js';
import { Wiki } from '../src/wiki.js';

const repoRoot = path.resolve(import.meta.dirname, '../..');

/**
 * A throwaway copy of the real wiki skeleton plus a few fixture pages. Pass
 * `config` to replace wiki.config.yaml (its timezone is then used as-is).
 */
export function fixtureWiki(now = new Date('2026-09-27T23:30:00Z'), opts: { config?: string } = {}) {
    const root = mkdtempSync(path.join(tmpdir(), 'wiki-'));
    for (const entry of ['_templates', 'Home.md', 'Dashboard.md', 'wiki.config.yaml']) cpSync(path.join(repoRoot, entry), path.join(root, entry), { recursive: true });
    const write = (rel: string, text: string) => {
        mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        writeFileSync(path.join(root, rel), text);
    };
    if (opts.config !== undefined) write('wiki.config.yaml', opts.config);
    write(
        'People/Ada Lovelace.md',
        `---
type: person
aliases: [Ada, the Countess, Countess of Lovelace]
status: active
organization: "[[Analytical Society]]"
related: ["[[Analytical Engine]]"]
tags: [math]
---
**Mathematician and friend; owes me a reply about the translation notes.** %%Moving to London in spring.%%

## About
Writes long letters, hates phone calls.

## Interactions
- 2026-08-03: lunch, talked about the Engine notes.

## Private Notes
Might recruit her for [[Project Babbage]].
`
    );
    write(
        'Projects/Analytical Engine.md',
        `---
type: project
aliases: [The Engine]
status: active
---
**Build a working model of the Analytical Engine with [[Ada Lovelace|Ada]].**

## People
- [[Ada]]
- [[Charles Babbage]]
`
    );
    write(
        'Projects/Kitchen Remodel.md',
        `---
type: project
status: active
people: ["[[Ada]]"]
---
**Replace the cabinets and fix the leaking sink before winter.**

## Log
- Got three quotes from contractors.
`
    );
    write('Private/Surprise Party.md', `---\ntype: note\n---\n**Planning a surprise birthday dinner in March.**\n`);
    const store = new FsStore(root);
    const wiki = new Wiki(store, { timeZone: opts.config === undefined ? 'America/New_York' : undefined, freshnessMs: 0, now: () => now });
    return { root, store, wiki, write };
}
