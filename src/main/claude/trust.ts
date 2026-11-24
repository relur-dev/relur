import fs from 'node:fs';
import path from 'node:path';
import type { Env } from '../env/scrub';
import { Git } from '../git/git';

/**
 * The variable that makes Claude Code ignore the trust it saved; never passed
 * to a Claude the app starts (spec §9.6).
 */
export const IGNORE_PERSISTED_TRUST = 'CLAUDE_CODE_IGNORE_PERSISTED_TRUST';

/**
 * The folder Claude Code keeps a folder's trust under (spec §9.6): a
 * repository's main checkout (for a linked worktree, the checkout it was made
 * from), else the repository's top level, else the folder itself; real path,
 * no trailing slash.
 */
export async function trustRoot(dir: string, git: Pick<Git, 'tryRun'> | null): Promise<string> {
  const ask = async (args: string[]) => {
    try {
      return (await git?.tryRun(dir, args))?.trim() || null;
    } catch {
      return null;
    }
  };
  const common = await ask(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  let root =
    common?.endsWith('/.git') || common?.endsWith(`${path.sep}.git`)
      ? path.dirname(common)
      : common
        ? await ask(['rev-parse', '--show-toplevel'])
        : null;
  root ??= dir;
  try {
    root = fs.realpathSync(root);
  } catch {
    root = path.resolve(root);
  }
  return root.length > 1 ? root.replace(/[\\/]+$/, '') : root;
}

/**
 * Claude Code's state file with every root trusted and the resume question
 * dismissed (spec §9.6); null when it already says so. Every other key stays.
 */
export function mergeClaudeState(text: string, roots: readonly string[]): string | null {
  const state: unknown = JSON.parse(text);
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('not a JSON object');
  }
  const config = state as Record<string, unknown>;
  let changed = false;
  if (config.resumeReturnDismissed !== true) {
    config.resumeReturnDismissed = true;
    changed = true;
  }
  const projects =
    config.projects && typeof config.projects === 'object' && !Array.isArray(config.projects)
      ? (config.projects as Record<string, unknown>)
      : {};
  for (const root of roots) {
    const entry = projects[root];
    const fields =
      entry && typeof entry === 'object' && !Array.isArray(entry)
        ? (entry as Record<string, unknown>)
        : {};
    if (fields.hasTrustDialogAccepted === true) continue;
    projects[root] = { ...fields, hasTrustDialogAccepted: true };
    changed = true;
  }
  if (!changed) return null;
  config.projects = projects;
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * Writes `text` over `file` all at once: a temporary file beside it with the
 * same mode (`0o644` for a new file), renamed over it, so a reader never sees
 * half of it.
 */
export function writeAtomically(file: string, text: string): void {
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o644;
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    fs.writeFileSync(temp, text, { mode });
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

export interface ReadyOptions {
  /** Claude Code's state file: `.claude.json` of the account folder (claudeStateFile). */
  stateFile: string;
  /** Absolute path of git; without it every folder is its own root. */
  gitPath: string | null;
  /** The environment git runs with (rule R3). */
  env: Env;
  /** Where a warning goes; never stops Claude from starting. */
  warn?: (message: string) => void;
}

/**
 * Before Claude starts in, or is given, these folders (spec §9.6): marks each
 * one's trust root as trusted and the resume question as answered in Claude
 * Code's state file, so neither question blocks the session. Reads the file
 * just before writing it, as running Claude Code processes write it too;
 * writes nothing when nothing changes, or when the file is missing or isn't
 * JSON. Never throws.
 */
export async function ensureClaudeCodeReady(
  workspacePaths: readonly string[],
  { stateFile, gitPath, env, warn = console.warn }: ReadyOptions,
): Promise<void> {
  try {
    const git = gitPath ? new Git({ gitPath, env }) : null;
    const roots = await Promise.all([...new Set(workspacePaths)].map((dir) => trustRoot(dir, git)));
    let file: string;
    let text: string;
    try {
      file = fs.realpathSync(stateFile);
      text = fs.readFileSync(file, 'utf8');
    } catch {
      warn(`Claude Code's state file ${stateFile} doesn't exist; folders not marked as trusted`);
      return;
    }
    let merged: string | null;
    try {
      merged = mergeClaudeState(text, [...new Set(roots)]);
    } catch (error) {
      warn(
        `Claude Code's state file ${stateFile} isn't readable JSON (${String(error)}); left as it is`,
      );
      return;
    }
    if (merged) writeAtomically(file, merged);
  } catch (error) {
    warn(`Marking folders as trusted for Claude Code failed: ${String(error)}`);
  }
}
