/** A changed file in the Changes panel (spec §6.4). */
export interface ChangedFile {
  kind: 'M' | 'A' | 'D' | 'R';
  path: string;
  /** For a rename, where it came from. */
  oldPath: string | null;
  added: number;
  removed: number;
  binary: boolean;
}

export type ChangeGroup = 'committed' | 'uncommitted';

/** What the workspace changed against its base branch. */
export interface WorkspaceChanges {
  /** The ref compared with, e.g. `origin/develop`. */
  base: string;
  /** The merge base with it; null when there is none (unrelated history). */
  mergeBase: string | null;
  /** Commits since the merge base. */
  committed: ChangedFile[];
  /** Staged, unstaged and untracked changes against HEAD. */
  uncommitted: ChangedFile[];
  added: number;
  removed: number;
}

/** Both sides of one file for the diff viewer; null for a side that doesn't exist. */
export type FileDiff =
  | { binary: false; original: string | null; modified: string | null }
  | { binary: true; tooLarge: boolean };

/**
 * The first line of `modified` that differs from `original` (1-based), for
 * Open in editor at a file's first change (spec §6.13); 1 when they're the same.
 */
export function firstChangedLine(original: string | null, modified: string | null): number {
  const before = (original ?? '').split('\n');
  const after = (modified ?? '').split('\n');
  for (let i = 0; i < after.length; i++) {
    if (after[i] !== before[i]) return Math.min(i + 1, after.length);
  }
  // Only lines removed at the end: the last line of what's left.
  return before.length > after.length ? Math.max(1, after.length) : 1;
}

/** A diff's first changed line; 1 for a binary file. */
export const diffFirstLine = (diff: FileDiff) =>
  diff.binary ? 1 : firstChangedLine(diff.original, diff.modified);

/** What a rejected push's message says (spec §14.1), so the panel can offer Ask Claude to merge. */
export const PUSH_REJECTED = 'rejected the push';

/** One repository's conflicts with its base, for the workspace header's mark (spec §6.2). */
export interface BaseConflicts {
  projectId: string;
  name: string;
  baseBranch: string;
  /** The files a merge of the base would conflict in. */
  files: string[];
}
