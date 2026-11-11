/**
 * The Guide for the web (spec §6.12): its pages as plain Markdown for a
 * reader on any platform, with an index. Pure: `exportGuide` returns the
 * files; scripts/guide-export.ts writes them.
 *
 * - Names come from BRAND. A key or anything else that differs reads
 *   "⌘N (Linux: Ctrl+N)"; inside <kbd> or `code` each platform gets its own.
 * - {{mac}}…{{/mac}} and {{other}}…{{/other}}: a part that starts a line, or
 *   a sentence, is labelled "On macOS:" / "On Linux:" (a heading names its
 *   platform already); a pair inside a sentence reads "macOS part (Linux:
 *   Linux part)"; a lone part inside a sentence "(on macOS: …)".
 * - `:::` blocks become quotes and tables, links `page.md#section`, and every
 *   `##` gets an `<a id>` with the Guide's own anchor, which GitHub's differ from.
 * - Screenshots point at their light file; index.json lists both.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fill, SECTIONS } from '../../src/renderer/src/guide/content';
import { GLYPHS } from '../../src/renderer/src/guide/glyphs';
import { images, parsePage, plainText, slug } from '../../src/renderer/src/guide/markdown';
import { BRAND } from '../../src/shared/brand';
import { formatShortcut, GROUP_ORDER, SHORTCUTS, type Shortcut } from '../../src/shared/shortcuts';

export interface ExportedPage {
  id: string;
  file: string;
  title: string;
  description: string;
  headings: { id: string; text: string }[];
  images: { name: string; alt: string; light: string; dark: string }[];
}

export interface GuideIndex {
  app: string;
  version: string;
  sections: { title: string; pages: ExportedPage[] }[];
}

export interface GuideExport {
  /** Markdown files by name, and index.json. */
  files: Record<string, string>;
  /** Screenshot files to copy into images/, by name (`sidebar-light.webp`). */
  images: string[];
  index: GuideIndex;
}

const FRAGMENT = /\{\{(mac|other)\}\}([\s\S]*?)\{\{\/\1\}\}/g;
/** A macOS part directly followed by a Linux one; neither crosses its own end. */
const PAIR =
  /\{\{mac\}\}((?:(?!\{\{\/mac\}\})[\s\S])*?)\{\{\/mac\}\}\{\{other\}\}((?:(?!\{\{\/other\}\})[\s\S])*?)\{\{\/other\}\}/g;
const PLACEHOLDER = /\{\{[a-zA-Z]+(?::[A-Za-z_]+)?\}\}/g;
const LABEL = { mac: 'On macOS', other: 'On Linux' } as const;

/** One text for both platforms, or the macOS one with Linux's after it. */
function both(text: string, wrap: (s: string) => string = (s) => s): string {
  const mac = fill(text, true);
  const linux = fill(text, false);
  return mac === linux ? wrap(mac) : `${wrap(mac)} (Linux: ${wrap(linux)})`;
}

/** Placeholders outside the platform parts: <kbd> and `code` per platform, the rest inline. */
function fillShared(text: string): string {
  return text
    .replace(/<kbd>([^<]*\{\{[^<]*)<\/kbd>/g, (_w, inner: string) =>
      both(inner, (s) => `<kbd>${s}</kbd>`),
    )
    .replace(/`([^`\n]*\{\{[^`\n]*)`/g, (_w, inner: string) => both(inner, (s) => `\`${s}\``))
    .replace(PLACEHOLDER, (p) => both(p));
}

const startsSentence = (s: string) => /^\s*[A-Z<*`]/.test(s);
const PLATFORM_START = /^\s*(#|On (macOS|Linux)\b)/;

/** A platform's part, labelled for a reader on any platform. */
function labelled(only: 'mac' | 'other', text: string, block: boolean): string {
  const filled = fill(text, only === 'mac');
  // A heading names its platform already.
  if (/^\s*#/.test(filled)) return filled;
  if (block) {
    // Each paragraph that isn't a list, table or code, and doesn't say its platform.
    return filled
      .split(/(\n\n+)/)
      .map((part) =>
        !part.trim() || PLATFORM_START.test(part) || /^\s*(- |\d+\. |\||```|:::)/.test(part)
          ? part
          : `${LABEL[only]}: ${part}`,
      )
      .join('');
  }
  if (PLATFORM_START.test(filled)) return filled;
  if (startsSentence(filled)) return filled.replace(/^(\s*)/, `$1${LABEL[only]}: `);
  return ` (${LABEL[only].replace('On', 'on')}: ${filled.replace(/^[\s,(]+|[\s,)]+$/g, '')})`;
}

/** The page's Markdown with every placeholder resolved for both platforms. */
export function fillWeb(markdown: string): string {
  const lineStart = (all: string, at: number) => at === 0 || all[at - 1] === '\n';
  const lineEnd = (all: string, end: number) => end === all.length || all[end] === '\n';
  return (
    markdown
      // <kbd>⇧⇥</kbd> (Linux: <kbd>Shift+Tab</kbd>)
      .replace(/<kbd>([^<]*\{\{(?:mac|other)\}\}[^<]*)<\/kbd>/g, (_w, inner: string) =>
        both(inner, (s) => `<kbd>${s}</kbd>`),
      )
      .replace(PAIR, (whole, mac: string, other: string, at: number, all: string) => {
        const end = at + whole.length;
        if (lineStart(all, at) && lineEnd(all, end)) {
          const sep = /^\s*#/.test(mac) ? '' : '\n\n';
          return `${labelled('mac', mac, true)}${sep}${labelled('other', other, true)}`;
        }
        // Two whole sentences: each labelled.
        if (startsSentence(mac) && (lineEnd(all, end) || /\s/.test(all[end] ?? ''))) {
          return `${labelled('mac', mac, false)} ${labelled('other', other, false).trim()}`;
        }
        return `${fill(mac, true)} (Linux: ${fill(other, false).trim()})`;
      })
      .replace(FRAGMENT, (whole, only: 'mac' | 'other', text: string, at: number, all: string) =>
        labelled(only, text, lineStart(all, at) && lineEnd(all, at + whole.length)),
      )
      .split(/(```[\s\S]*?```)/)
      .map((part, i) => {
        if (i % 2 === 0) return fillShared(part);
        // A code block is the same on both platforms, or the export would be wrong.
        const mac = fill(part, true);
        if (mac !== fill(part, false)) throw new Error(`A code block differs by platform: ${part}`);
        return mac;
      })
      .join('')
  );
}

/** A shortcut's keys on one platform as a table cell; — where it has none there. */
export function shortcutCell(shortcut: Shortcut, mac: boolean): string {
  if (shortcut.platform && shortcut.platform !== (mac ? 'mac' : 'other')) return '—';
  return `<kbd>${formatShortcut(shortcut, mac)}</kbd>`;
}

/** The Keyboard shortcuts page's tables: every shortcut, with a column per platform. */
export function shortcutsWeb(): string {
  const all: Shortcut[] = Object.values(SHORTCUTS);
  return GROUP_ORDER.map((group) => {
    const rows = all
      .filter((s) => s.group === group)
      .map((s) => `| ${s.label} | ${shortcutCell(s, true)} | ${shortcutCell(s, false)} |`);
    return `## ${group}\n\n| Action | macOS | Linux |\n| --- | --- | --- |\n${rows.join('\n')}`;
  }).join('\n\n');
}

const issueUrl = (template: string) =>
  `https://github.com/${BRAND.github.owner}/${BRAND.github.repo}/issues/new?template=${template}`;

const ACTION_LINKS: Record<string, string> = {
  'app:report-bug': issueUrl('bug_report.yml'),
  'app:request-feature': issueUrl('feature_request.yml'),
};

/** The Guide's own blocks and links as plain Markdown. */
export function toPlainMarkdown(markdown: string): string {
  const lines = markdown.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.startsWith('```')) {
      out.push(line);
      for (i++; i < lines.length && !(lines[i] as string).startsWith('```'); i++) {
        out.push(lines[i] as string);
      }
      if (i < lines.length) out.push(lines[i] as string);
      continue;
    }
    if (line.startsWith('## ')) {
      if (out.length > 0 && out.at(-1) !== '') out.push('');
      out.push(`<a id="${slug(line.slice(3).trim())}"></a>`, '', line);
      continue;
    }
    if (!line.startsWith(':::')) {
      out.push(convertInline(line));
      continue;
    }
    const [kind = '', ...rest] = line.slice(3).trim().split(' ');
    const body: string[] = [];
    for (i++; i < lines.length && (lines[i] as string).trim() !== ':::'; i++) {
      body.push(lines[i] as string);
    }
    if (kind === 'tip' || kind === 'note' || kind === 'warning') {
      const title = rest.join(' ') || { tip: 'Tip', note: 'Note', warning: 'Warning' }[kind];
      const inner = toPlainMarkdown(body.join('\n')).trim().split('\n');
      out.push(`> **${title}**`, '>', ...inner.map((l) => (l ? `> ${l}` : '>')));
    } else if (kind === 'keys') {
      out.push('| Keys | Action |', '| --- | --- |');
      for (const row of body.filter((l) => l.includes('|'))) {
        const at = row.lastIndexOf('|');
        out.push(`| ${row.slice(0, at).trim()} | ${row.slice(at + 1).trim()} |`);
      }
    } else if (kind === 'glyphs') {
      out.push('| Status | Looks like | What it means |', '| --- | --- | --- |');
      for (const [, name, shape, meaning] of GLYPHS)
        out.push(`| ${name} | ${shape} | ${meaning} |`);
    } else if (kind === 'diagram') {
      out.push(
        '**Profile** (for example Work: one Claude account, `~/.claude-work`) → has → **Project** (for example api-service: a git repository, `~/Code/api-service`) → has → **Workspace** (for example ENG-1423 Fix login timeout: one task, with a worktree, a branch, Claude and terminals)',
      );
    } else {
      throw new Error(`Unknown block ":::${kind}"`);
    }
  }
  return out.join('\n');
}

/** Links between pages as `page.md#section`, actions as their web pages, screenshots as their light file. */
function convertInline(line: string): string {
  return line
    .replace(/^!\[([^\]]*)\]\(images\/([a-z0-9-]+)\.webp\)$/, '![$1](images/$2-light.webp)')
    .replace(/(?<!!)\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, text: string, href: string) => {
      if (ACTION_LINKS[href]) return `[${text}](${ACTION_LINKS[href]})`;
      if (/^[a-z]+:/.test(href) || href.startsWith('#')) return whole;
      const [page = '', section] = href.split('#');
      return `[${text}](${page}.md${section ? `#${section}` : ''})`;
    });
}

/** The first sentence of the page's first paragraph (two when it's short), as plain text. */
export function pageDescription(markdown: string): string {
  const first = markdown
    .split(/\n\n+/)
    .map((p) => p.trim())
    .find((p) => p && !/^(#|!\[|:::|\||- |\d+\. |```|<a )/.test(p));
  const text = plainText(first ?? '').replace(/<\/?kbd>/g, '');
  const sentences = text.split(/(?<=[.!?])\s+/);
  // A short first sentence ("<app> doesn't merge.") takes the next one along.
  const lead = (sentences[0] ?? '').trim();
  return lead.length < 40 && sentences[1] ? `${lead} ${sentences[1].trim()}` : lead;
}

/** The Guide's folder in the source tree. */
export const GUIDE_DIR = path.join(
  import.meta.dirname,
  '..',
  '..',
  'src',
  'renderer',
  'src',
  'guide',
);

/** The Guide's page files by id, read from the source tree. */
export function readPages(dir = path.join(GUIDE_DIR, 'pages')): Record<string, string> {
  return Object.fromEntries(
    fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => [f.slice(0, -3), fs.readFileSync(path.join(dir, f), 'utf8')]),
  );
}

/** Every page as plain Markdown, the screenshots they use, and the index. */
export function exportGuide(pages: Record<string, string>, version: string): GuideExport {
  const files: Record<string, string> = {};
  const imageFiles: string[] = [];
  const sections = SECTIONS.map((section) => ({
    title: section.title,
    pages: section.pages.map((id): ExportedPage => {
      const raw = pages[id];
      if (raw === undefined) throw new Error(`The Guide has no page ${id}.md`);
      const web = fillWeb(raw.replace('{{shortcuts}}', '@@SHORTCUTS@@')).replace(
        '@@SHORTCUTS@@',
        shortcutsWeb(),
      );
      const parsed = parsePage(web);
      const shots = images(parsed.blocks).map(({ name, alt }) => ({
        name,
        alt,
        light: `images/${name}-light.webp`,
        dark: `images/${name}-dark.webp`,
      }));
      for (const s of shots) imageFiles.push(`${s.name}-light.webp`, `${s.name}-dark.webp`);
      const markdown = toPlainMarkdown(web);
      const file = `${id}.md`;
      files[file] = `${markdown.trim()}\n`;
      return {
        id,
        file,
        title: parsed.title,
        description: pageDescription(web),
        headings: parsed.blocks.flatMap((b) => (b.t === 'h2' ? [{ id: b.id, text: b.text }] : [])),
        images: shots,
      };
    }),
  }));
  const index: GuideIndex = { app: BRAND.displayName, version, sections };
  files['index.json'] = `${JSON.stringify(index, null, 2)}\n`;
  return { files, images: imageFiles, index };
}
