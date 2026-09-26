import { Document, parseDocument, stringify } from 'yaml';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export interface Parsed {
    /** Parsed YAML frontmatter (empty object if none or invalid). */
    data: Record<string, unknown>;
    /** Raw YAML text between the fences, or null when the page has none. */
    fmText: string | null;
    body: string;
}

export function parseFrontmatter(raw: string): Parsed {
    const match = FRONTMATTER.exec(raw);
    if (!match) return { data: {}, fmText: null, body: raw };
    let data: Record<string, unknown> = {};
    try {
        const parsed = parseDocument(match[1]).toJS();
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
    } catch {
        // Invalid YAML: keep the page, treat it as having no metadata.
    }
    return { data, fmText: match[1], body: raw.slice(match[0].length) };
}

/**
 * Apply a patch to frontmatter, keeping the existing formatting and comments.
 * A null value deletes the key.
 */
export function patchFrontmatter(fmText: string | null, patch: Record<string, unknown>): string {
    const parsed = fmText?.trim() ? parseDocument(fmText) : null;
    const doc = parsed && parsed.contents !== null ? parsed : new Document({});
    for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === undefined) doc.delete(key);
        else doc.set(key, value);
    }
    return String(doc).trimEnd();
}

export function assemble(fmText: string | null, body: string): string {
    const cleanBody = body.replace(/^\n+/, '');
    return fmText === null || fmText.trim() === '' ? cleanBody : `---\n${fmText.trimEnd()}\n---\n${cleanBody}`;
}

export function toYaml(value: unknown): string {
    return stringify(value).trimEnd();
}

// ---------------------------------------------------------------------------
// Links, names and text

const WIKILINK = /!?\[\[([^\]|#^\n]+)(?:[#^][^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g;

/** Fenced code blocks and `inline code`, where [[...]] isn't a link. */
const CODE = /^[ \t]*(```|~~~)[\s\S]*?^[ \t]*\1.*$|`[^`\n]*`/gm;

/** Targets of every [[wikilink]] in the text (frontmatter included). Code blocks and `inline code` aren't links. */
export function extractLinks(text: string): string[] {
    const out = new Set<string>();
    for (const m of text.replace(CODE, '').matchAll(WIKILINK)) out.add(m[1].trim());
    return [...out];
}

/** A wikilink split into target and the rest: "#heading", "^block", "|label". */
const WIKILINK_PARTS = /(!?)\[\[([^\]|#^\n]+)((?:[#^][^\]|\n]*)?(?:\|[^\]\n]*)?)\]\]/g;

/**
 * Rewrite link targets outside code. `retarget` gets each target and
 * returns its replacement, or null to leave the link alone. Headings,
 * block refs, labels and embeds (![[...]]) are kept.
 */
export function rewriteLinks(text: string, retarget: (target: string) => string | null): string {
    const rewrite = (prose: string) =>
        prose.replace(WIKILINK_PARTS, (whole, bang: string, target: string, rest: string) => {
            const next = retarget(target.trim());
            return next === null ? whole : `${bang}[[${next}${rest}]]`;
        });
    let out = '';
    let last = 0;
    for (const m of text.matchAll(CODE)) {
        out += rewrite(text.slice(last, m.index)) + m[0];
        last = m.index! + m[0].length;
    }
    return out + rewrite(text.slice(last));
}

/** Normalize a page name or alias for matching: case, accents and punctuation insensitive. */
export function normalizeName(name: string): string {
    return name
        .replace(/\.md$/i, '')
        .replace(/^.*\//, '')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/['’]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/^the /, '');
}

/** Strip a wikilink wrapper: "[[Ada Lovelace|Ada]]" -> "Ada Lovelace". */
export function unwrapLink(value: string): string {
    const m = /^\s*!?\[\[([^\]|#^]+)[^\]]*\]\]\s*$/.exec(value);
    return (m ? m[1] : value).trim();
}

export function asList(value: unknown): string[] {
    if (value === null || value === undefined || value === '') return [];
    if (Array.isArray(value)) return value.filter(v => v !== null && v !== undefined && v !== '').map(v => String(v));
    return [String(value)];
}

/** Plain-text rendering of a Markdown line, for summaries and snippets. */
export function plainText(md: string): string {
    return md
        .replace(WIKILINK, (m, target: string) => {
            const alias = /\|([^\]]+)\]\]$/.exec(m);
            return alias ? alias[1] : target;
        })
        .replace(/\*\*|__|`/g, '')
        .replace(/(^|\s)[*_](\S[^*_]*?)[*_](?=\s|$|[.,;:!?])/g, '$1$2')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
}

// ---------------------------------------------------------------------------
// Sections

export interface Section {
    heading: string;
    level: number;
    /** Offset of the heading line. */
    start: number;
    /** Offset just after the heading line. */
    contentStart: number;
    /** Offset where the section (including subsections) ends. */
    end: number;
}

export function findSections(body: string): Section[] {
    const lines: Array<{ heading: string; level: number; start: number; contentStart: number }> = [];
    const re = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/gm;
    let inFence = false;
    let offset = 0;
    // Walk line by line so headings inside code fences are ignored.
    for (const line of body.split('\n')) {
        if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
        re.lastIndex = 0;
        const m = !inFence ? re.exec(line) : null;
        if (m) lines.push({ heading: m[2].trim(), level: m[1].length, start: offset, contentStart: Math.min(offset + line.length + 1, body.length) });
        offset += line.length + 1;
    }
    return lines.map((h, i) => {
        const next = lines.slice(i + 1).find(o => o.level <= h.level);
        return { ...h, end: next ? next.start : body.length };
    });
}

export function findSection(body: string, heading: string): Section | undefined {
    const want = normalizeName(heading.replace(/^#+\s*/, ''));
    return findSections(body).find(s => normalizeName(s.heading) === want);
}

export type SectionAction = 'append' | 'prepend' | 'replace';

/** Edit one section's content, creating the section if it doesn't exist. */
export function editSection(body: string, heading: string, action: SectionAction, content: string, rules: PrivacyRules = NO_PRIVACY): string {
    const text = content.replace(/\s+$/, '');
    const section = findSection(body, heading);
    if (!section) {
        const cleanHeading = heading.replace(/^#+\s*/, '');
        const block = `## ${cleanHeading}\n${text}\n`;
        // New sections go above the private section so private notes stay at the bottom.
        const priv = findSections(body).find(s => s.level === 2 && isPrivateHeading(s.heading, rules));
        if (priv) return `${body.slice(0, priv.start)}${block}\n${body.slice(priv.start)}`;
        return `${body.replace(/\s*$/, '')}\n\n${block}`;
    }
    // Subsections belong to the section; appends go after its own direct content.
    const ownEnd = findSections(body).find(s => s.start > section.start && s.start < section.end)?.start ?? section.end;
    const existing = body.slice(section.contentStart, ownEnd);
    const trimmed = existing.replace(/\s+$/, '');
    let replaced: string;
    if (action === 'replace') replaced = text;
    else if (action === 'prepend') replaced = trimmed ? `${text}\n${trimmed}` : text;
    else replaced = trimmed && !isPlaceholder(trimmed) ? `${trimmed}\n${text}` : text;
    const tail = body.slice(ownEnd);
    return `${body.slice(0, section.contentStart)}${replaced}\n${tail ? '\n' : ''}${tail}`;
}

/** Template filler like "- " or "1. " that an append should replace. */
function isPlaceholder(text: string): boolean {
    return /^(?:[-*]|\d+\.|- \[ \])\s*$/.test(text.trim()) || /^<!--[\s\S]*-->$/.test(text.trim());
}

// ---------------------------------------------------------------------------
// Private material

/** What counts as private inside a page (see `private` in wiki.config.yaml). */
export interface PrivacyRules {
    /** Sections whose heading is, or starts with, one of these (case-insensitive). */
    headings: string[];
    /** Any line containing this text (case-insensitive). */
    lineMarker: string | null;
}

export const NO_PRIVACY: PrivacyRules = { headings: [], lineMarker: null };

export function isPrivateHeading(heading: string, rules: PrivacyRules): boolean {
    const h = heading.trim().toLowerCase();
    return rules.headings.some(p => {
        const want = p.trim().toLowerCase();
        return !!want && (h === want || h.startsWith(`${want} `) || h.startsWith(`${want}:`));
    });
}

/**
 * Remove private material: private sections, Obsidian %%comments%% (always
 * private) and lines containing the private marker.
 */
export function stripPrivate(body: string, rules: PrivacyRules): string {
    let out = body.replace(/%%[\s\S]*?%%/g, '');
    for (const s of findSections(out).filter(s => isPrivateHeading(s.heading, rules)).reverse()) {
        out = out.slice(0, s.start) + out.slice(s.end);
    }
    const marker = rules.lineMarker?.trim().toLowerCase();
    if (marker) {
        out = out
            .split('\n')
            .filter(line => !line.toLowerCase().includes(marker))
            .join('\n');
    }
    return out.replace(/\n{3,}/g, '\n\n');
}

/** The first line of prose after the frontmatter: the page's one-line summary. */
export function summaryLine(body: string): string {
    let inFence = false;
    for (const line of body.split('\n')) {
        if (/^\s*(```|~~~)/.test(line)) {
            inFence = !inFence;
            continue;
        }
        const t = line.trim();
        if (inFence || !t || t.startsWith('#') || t.startsWith('|') || t.startsWith('>') || t === '---') continue;
        const plain = plainText(t.replace(/^[-*+]\s+|^\d+\.\s+/, ''));
        if (!plain || plain === '{{summary}}') return '';
        return plain.length > 280 ? `${plain.slice(0, 277)}...` : plain;
    }
    return '';
}

/** Replace the page's summary line, or insert one at the top of the body. */
export function setSummary(body: string, summary: string): string {
    const bold = `**${summary.replace(/^\*\*|\*\*$/g, '').trim()}**`;
    const lines = body.split('\n');
    const idx = lines.findIndex(l => l.trim() !== '');
    if (idx !== -1) {
        const first = lines[idx].trim();
        if (/^\*\*.*\*\*$/.test(first) || (!first.startsWith('#') && !first.startsWith('-') && !first.startsWith('|'))) {
            lines[idx] = bold;
            return lines.join('\n');
        }
    }
    return `${bold}\n\n${body.replace(/^\n+/, '')}`;
}
