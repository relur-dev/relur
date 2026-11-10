/**
 * Files dropped on a terminal or chosen with Add files, as the text inserted
 * there (spec §6.16). Paths are POSIX (macOS and Linux); no `node:path`, as
 * the renderer imports this too.
 */
import { shellQuote } from './shell';

export interface DroppedFile {
  /** Absolute path, as the system gave it. */
  path: string;
  /** Its real path (symbolic links resolved), to tell whether it lies inside a root. */
  real: string;
  folder: boolean;
}

/** Where Claude runs: its folder, and the folders whose files it gets as `@path`. */
export interface ClaudeRoots {
  /** Claude's working folder: `@path`s are relative to it (real path). */
  cwd: string;
  /** The workspace's worktrees, the main one and linked ones (real paths). */
  roots: string[];
}

/** Characters Claude Code takes as they are in an `@path`. */
const PLAIN = /^[\w@%+=:,./-]+$/;

const inside = (file: string, root: string) =>
  file === root || file.startsWith(root.endsWith('/') ? root : `${root}/`);

/** `to` relative to the folder `from`, both absolute and normalized. */
export function relativePath(from: string, to: string): string {
  const a = from.split('/').filter(Boolean);
  const b = to.split('/').filter(Boolean);
  let same = 0;
  while (same < a.length && same < b.length && a[same] === b[same]) same++;
  const up = a.slice(same).map(() => '..');
  return [...up, ...b.slice(same)].join('/') || '.';
}

/**
 * One file as text for Claude's prompt (spec §6.16): inside the worktree or
 * a linked repository's, Claude Code's `@path`, relative to Claude's folder
 * (`@"…"` with spaces, `/` after a folder), which attaches the file when sent;
 * elsewhere the absolute path, quoted when needed: Claude Code makes a pasted
 * image path an `[Image #N]` (checked live with 2.1.322).
 */
export function claudePath(file: DroppedFile, where: ClaudeRoots): string {
  if (where.roots.some((root) => inside(file.real, root))) {
    const rel = relativePath(where.cwd, file.real) + (file.folder ? '/' : '');
    if (PLAIN.test(rel)) return `@${rel}`;
    // Claude Code's quoted form has no escapes: a name with " goes absolute.
    if (!rel.includes('"') && !/[\r\n]/.test(rel)) return `@"${rel}"`;
  }
  return shellQuote(file.path);
}

/**
 * The pastes that insert the files into Claude's prompt (spec §6.16): one per
 * file, so an image path stays an image of its own and a long list never folds
 * into "[Pasted text]"; each ends with a space. `spaceFirst`: the prompt
 * holds a draft with no space before the cursor, so the first starts with one.
 */
export function claudePastes(
  files: DroppedFile[],
  where: ClaudeRoots,
  spaceFirst: boolean,
): string[] {
  return files.map((f, i) => `${i === 0 && spaceFirst ? ' ' : ''}${claudePath(f, where)} `);
}

/** The text a shell gets (spec §6.16): the quoted absolute paths, as a terminal's own drop. */
export function shellText(files: Pick<DroppedFile, 'path'>[]): string {
  return files.map((f) => `${shellQuote(f.path)} `).join('');
}
