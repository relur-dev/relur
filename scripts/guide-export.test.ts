import fs from 'node:fs';
import path from 'node:path';
import { BRAND } from '@shared/brand';
import { formatShortcut, SHORTCUTS, type Shortcut } from '@shared/shortcuts';
import { describe, expect, it } from 'vitest';
import { SECTIONS } from '../src/renderer/src/guide/content';
import {
  exportGuide,
  fillWeb,
  GUIDE_DIR,
  readPages,
  shortcutCell,
  toPlainMarkdown,
} from './lib/guide-export';

const pages = readPages();
const result = exportGuide(pages, '1.2.3');
const markdown = Object.entries(result.files).filter(([file]) => file.endsWith('.md'));
const imagesDir = path.join(GUIDE_DIR, 'images');

describe('the Guide for the web', () => {
  it('resolves every placeholder and leaves no Guide-only syntax', () => {
    for (const [file, text] of markdown) {
      expect(text, file).not.toMatch(/\{\{|\}\}/);
      expect(text, file).not.toMatch(/^:::/m);
      expect(text, file).not.toMatch(/\]\(app:/);
      expect(text, file).not.toMatch(/\]\(images\/(?![a-z0-9-]+-light\.webp\))/);
    }
  });

  it('has a working target for every link between pages and every anchor', () => {
    const anchors = new Map(
      markdown.map(([file, text]) => [
        file,
        new Set([...text.matchAll(/<a id="([^"]+)"><\/a>/g)].map((m) => m[1])),
      ]),
    );
    for (const [file, text] of markdown) {
      for (const [, bang, href] of text.matchAll(/(!?)\[[^\]]*\]\(([^)\s]+)\)/g)) {
        if (bang) continue;
        if (/^https?:/.test(href as string)) continue;
        const [page = '', section] = (href as string).split('#');
        const target = page || file;
        expect(target, `${file}: ${href}`).toMatch(/^[a-z0-9-]+\.md$/);
        expect(anchors.has(target), `${file}: ${href}`).toBe(true);
        if (section) expect(anchors.get(target)?.has(section), `${file}: ${href}`).toBe(true);
      }
    }
  });

  it('copies every screenshot a page shows, both variants', () => {
    for (const [file, text] of markdown) {
      for (const [, image] of text.matchAll(/!\[[^\]]+\]\(images\/([^)]+)\)/g)) {
        expect(result.images, `${file}: ${image}`).toContain(image);
        expect(result.images).toContain((image as string).replace('-light', '-dark'));
      }
    }
    for (const image of result.images)
      expect(fs.existsSync(path.join(imagesDir, image))).toBe(true);
    expect(result.images.length).toBe(fs.readdirSync(imagesDir).length);
  });

  it("indexes the sections and pages in the Guide's order, with titles and descriptions", () => {
    const index = JSON.parse(result.files['index.json'] as string);
    expect(index.app).toBe(BRAND.displayName);
    expect(index.version).toBe('1.2.3');
    expect(index.sections.map((s: { title: string }) => s.title)).toEqual(
      SECTIONS.map((s) => s.title),
    );
    expect(
      index.sections.map((s: { pages: { id: string }[] }) => s.pages.map((p) => p.id)),
    ).toEqual(SECTIONS.map((s) => s.pages));
    for (const section of result.index.sections) {
      for (const page of section.pages) {
        expect(result.files[page.file], page.id).toBeDefined();
        expect(result.files[page.file]?.startsWith(`# ${page.title}\n`), page.id).toBe(true);
        expect(page.description, page.id).toMatch(/^\S.{20,240}[.!?]$/);
        expect(page.description, page.id).not.toMatch(/\n|\{\{|\*\*|\]\(/);
        for (const image of page.images) {
          expect(image.alt.length, page.id).toBeGreaterThan(10);
          expect(result.images).toContain(path.basename(image.dark));
        }
      }
    }
  });

  it('gives keys, folders and platform-only text for both platforms', () => {
    const all = markdown.map(([, text]) => text).join('\n');
    expect(all).toMatch(/<kbd>⌘[A-Z]<\/kbd> \(Linux: <kbd>Ctrl\+(Shift\+)?[A-Z]<\/kbd>\)/);
    expect(all).toContain(`~/Library/Application Support/${BRAND.displayName}`);
    expect(all).toContain(`~/.config/${BRAND.slug}`);
    expect(all).toContain('Reveal in Finder (Linux: Show in folder)');
    expect(all).toMatch(/^(> )?On macOS: /m);
    expect(all).toMatch(/^(> )?On Linux: /m);
    expect(result.files['shortcuts.md']).toMatch(/\| Action \| macOS \| Linux \|/);
  });

  it("lists every shortcut on the Keyboard shortcuts page, with both platforms' keys", () => {
    const page = result.files['shortcuts.md'] as string;
    const rows = page.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Action'));
    const all: Shortcut[] = Object.values(SHORTCUTS);
    expect(rows.filter((r) => !r.startsWith('| ---'))).toHaveLength(all.length);
    for (const s of all) {
      const row = `| ${s.label} | ${shortcutCell(s, true)} | ${shortcutCell(s, false)} |`;
      expect(rows, s.label).toContain(row);
      // Both columns are filled unless the shortcut is only on one platform.
      if (s.platform !== 'other') expect(row).toContain(`<kbd>${formatShortcut(s, true)}</kbd>`);
      if (s.platform !== 'mac') expect(row).toContain(`<kbd>${formatShortcut(s, false)}</kbd>`);
    }
    expect(page).toContain('| Copy in a terminal | — | <kbd>Ctrl+Shift+C</kbd> |');
    expect(page).toContain('| New workspace | <kbd>⌘N</kbd> | <kbd>Ctrl+Shift+N</kbd> |');
  });

  it('labels platform parts by where they stand', () => {
    expect(fillWeb('{{mac}}A Mac line.{{/mac}}{{other}}A Linux line.{{/other}}\n')).toBe(
      'On macOS: A Mac line.\n\nOn Linux: A Linux line.\n',
    );
    expect(fillWeb('In the {{mac}}{{app}} menu{{/mac}}{{other}}Help menu{{/other}}: x')).toBe(
      `In the ${BRAND.displayName} menu (Linux: Help menu): x`,
    );
    expect(fillWeb('Front{{mac}} (opening it again){{/mac}}, then.')).toBe(
      'Front (on macOS: opening it again), then.',
    );
    expect(fillWeb('Press <kbd>{{mac}}⇧F10{{/mac}}{{other}}Shift+F10{{/other}}</kbd>.')).toBe(
      'Press <kbd>⇧F10</kbd> (Linux: <kbd>Shift+F10</kbd>).',
    );
    expect(fillWeb('{{mac}}## Only on a Mac\n\nText.\n{{/mac}}')).toBe(
      '## Only on a Mac\n\nText.\n',
    );
  });

  it("turns the Guide's blocks and links into plain Markdown", () => {
    expect(toPlainMarkdown(':::tip Watch out\nA **bold** [link](sidebar#the-counts).\n:::')).toBe(
      '> **Watch out**\n>\n> A **bold** [link](sidebar.md#the-counts).',
    );
    expect(toPlainMarkdown('## Two words')).toBe('<a id="two-words"></a>\n\n## Two words');
    expect(toPlainMarkdown('![The sidebar](images/sidebar.webp)')).toBe(
      '![The sidebar](images/sidebar-light.webp)',
    );
    expect(toPlainMarkdown('[Report](app:report-bug)')).toMatch(
      /\(https:\/\/github\.com\/.+\/issues\/new\?template=bug_report\.yml\)/,
    );
  });
});

describe('the README', () => {
  const readme = fs.readFileSync(path.join(import.meta.dirname, '..', 'README.md'), 'utf8');

  it('gives every key it names for both platforms, as shortcuts.ts has them', () => {
    const all: Shortcut[] = Object.values(SHORTCUTS);
    const pairs = [...readme.matchAll(/\(([^(),]*[⌘⌥⇧⌃][^(),]*), on Linux ([^()]+?)\)/g)];
    expect(pairs.length).toBeGreaterThan(3);
    for (const [whole, mac, linux] of pairs) {
      expect(
        all.some((s) => formatShortcut(s, true) === mac && formatShortcut(s, false) === linux),
        whole,
      ).toBe(true);
    }
    // No Mac key without its Linux one.
    const bare = readme.replace(/\([^()]*, on Linux [^()]+\)/g, '').replace(/<img [^>]*>/g, '');
    expect(bare).not.toMatch(/[⌘⌥⇧⌃↵]/);
    expect(readme).toContain(`https://${BRAND.slug}.dev/guide/shortcuts`);
  });
});
