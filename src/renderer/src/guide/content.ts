/**
 * The Guide's pages (components.md, Guide): one Markdown file per page in
 * ./pages, shipped with the app. Names and keys are placeholders filled here,
 * so the pages never spell the product name (check:name) and every key comes
 * from the shortcut definitions:
 *
 *   {{app}} {{cli}} {{helper}} {{repoDir}} {{homeDir}}  BRAND values
 *   {{oldApp}} {{oldCli}} {{oldRepoDir}} {{oldHomeDir}}  BRAND.legacy values
 *   {{workflowFile}}                                      a shared workflow's file name
 *   {{env:NAME}}                                          an app environment variable
 *   {{key:id}}                                            a shortcut's first key, from @shared/shortcuts
 *   {{keys:id}}                                           all of its keys (⌥↑ / ⌥↓, ⌘1 – ⌘9)
 *   {{reveal}}                                            Reveal in Finder, or Show in folder off macOS
 *   {{configDir}}                                         the app config dir (spec §3.4)
 *   {{repo}}                                              the GitHub repository, <owner>/<repo>
 *   {{linuxExe}}                                          the executable and desktop entry name on Linux
 *   {{mac}}…{{/mac}}  {{other}}…{{/other}}                text for macOS only, or for Linux and Windows
 *
 * A link to one of `GUIDE_ACTIONS` (`app:…`) runs that action. A screenshot,
 * `![alt](images/<name>.webp)`, has a dark and a light file in ./images
 * (scripts/guide-screenshots.ts).
 *
 * The Keyboard shortcuts page has `{{shortcuts}}`, generated from the same
 * definitions.
 */
import { BRAND, envVar } from '@shared/brand';
import {
  formatShortcut,
  hint,
  hints,
  SHORTCUTS,
  type ShortcutId,
  shortcutsByGroup,
} from '@shared/shortcuts';
import { WORKFLOW_FILE } from '@shared/workflow-file';
import { type Block, type ParsedPage, parsePage, plainText } from './markdown';

/**
 * Links that do something instead of opening a page: `[Report a Bug…](app:report-bug)`
 * opens the issue form in the browser, as the Help menu's item does (spec §6.12).
 */
export const GUIDE_ACTIONS = ['app:report-bug', 'app:request-feature'] as const;
export type GuideAction = (typeof GUIDE_ACTIONS)[number];
export const isGuideAction = (href: string): href is GuideAction =>
  (GUIDE_ACTIONS as readonly string[]).includes(href);

/** Sections and their pages, in table-of-contents order. */
export const SECTIONS: { title: string; pages: string[] }[] = [
  {
    title: 'Getting started',
    pages: ['what-it-is', 'building-blocks', 'first-steps', 'team-setup', 'linux', 'updates'],
  },
  {
    title: 'Profiles and accounts',
    pages: [
      'account-folders',
      'create-profile',
      'setup-check',
      'terminal-shortcut',
      'edit-profile',
    ],
  },
  { title: 'Projects', pages: ['add-project', 'worktrees', 'workspace-setup', 'remove-project'] },
  {
    title: 'Workspaces',
    pages: [
      'new-workspace',
      'home',
      'sidebar',
      'workspace-view',
      'tasks-across-repositories',
      'start-claude-here',
      'open-in-editor',
      'finishing-work',
      'delete-workspace',
    ],
  },
  { title: 'Skills and workflows', pages: ['skills', 'workflows', 'adopting-worktrees'] },
  {
    title: 'Status and alerts',
    pages: ['status-glyphs', 'notifications', 'plan-usage', 'memory', 'suspend', 'status-line'],
  },
  {
    title: 'Working with Claude',
    pages: ['add-files', 'copy-response', 'notes', 'prompt-navigator', 'resume'],
  },
  { title: 'Command line tool', pages: ['cli'] },
  { title: 'Keyboard shortcuts', pages: ['shortcuts'] },
  { title: 'Troubleshooting', pages: ['troubleshooting'] },
];

export interface GuidePage extends ParsedPage {
  id: string;
  section: string;
  /** 1-based section number. */
  number: number;
  /** For search. */
  text: string;
}

/** The generated body of the Keyboard shortcuts page. */
export function shortcutsMarkdown(mac: boolean): string {
  return shortcutsByGroup(mac)
    .map(
      ({ group, shortcuts }) =>
        `## ${group}\n:::keys\n${shortcuts.map((s) => `${formatShortcut(s, mac)} | ${s.label}`).join('\n')}\n:::`,
    )
    .join('\n\n');
}

/** Fills the placeholders; an unknown one throws, so a typo fails the tests. */
export function fill(markdown: string, mac: boolean): string {
  const platform = mac ? 'mac' : 'other';
  return markdown
    .replace(/\{\{(mac|other)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_whole, only: string, text: string) =>
      only === platform ? text : '',
    )
    .replace(/\{\{([a-zA-Z]+)(?::([A-Za-z_]+))?\}\}/g, (whole, name: string, arg?: string) => {
      switch (name) {
        case 'app':
          return BRAND.displayName;
        case 'cli':
          return BRAND.cliCommand;
        case 'helper':
          return BRAND.helperCommand;
        case 'repoDir':
          return BRAND.repoDirName;
        case 'homeDir':
          return BRAND.homeDirName;
        case 'workflowFile':
          return WORKFLOW_FILE;
        case 'oldApp':
          return BRAND.legacy.displayName;
        case 'oldCli':
          return BRAND.legacy.cliCommand;
        case 'oldRepoDir':
          return BRAND.legacy.repoDirName;
        case 'oldHomeDir':
          return BRAND.legacy.homeDirName;
        case 'env':
          if (arg) return envVar(arg);
          break;
        case 'key':
          if (arg && arg in SHORTCUTS) return hint(arg as ShortcutId, mac);
          break;
        case 'keys':
          if (arg && arg in SHORTCUTS) return hints(arg as ShortcutId, mac);
          break;
        case 'shortcuts':
          return shortcutsMarkdown(mac);
        case 'repo':
          return `${BRAND.github.owner}/${BRAND.github.repo}`;
        case 'linuxExe':
          return BRAND.linuxExecutable;
        case 'reveal':
          return mac ? 'Reveal in Finder' : 'Show in folder';
        case 'configDir':
          return mac
            ? `~/Library/Application Support/${BRAND.displayName}`
            : `~/.config/${BRAND.slug}`;
      }
      throw new Error(`Unknown Guide placeholder ${whole}`);
    });
}

/** Builds the pages from their Markdown files (`./pages/<id>.md` contents by id). */
export function buildPages(files: Record<string, string>, mac: boolean): GuidePage[] {
  return SECTIONS.flatMap((section, index) =>
    section.pages.map((id) => {
      const raw = files[id];
      if (raw === undefined) throw new Error(`The Guide has no page ${id}.md`);
      const markdown = fill(raw, mac);
      return {
        id,
        section: section.title,
        number: index + 1,
        ...parsePage(markdown),
        text: plainText(markdown),
      };
    }),
  );
}

/** The `##` headings of a page, for On this page and anchors. */
export const headings = (blocks: Block[]) =>
  blocks.flatMap((b) => (b.t === 'h2' ? [{ id: b.id, text: b.text }] : []));
