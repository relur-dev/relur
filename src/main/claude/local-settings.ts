import fs from 'node:fs';
import path from 'node:path';
import type { Git } from '../git/git';
import { writeAtomically } from './trust';

/** Claude Code's local settings, relative to the folder Claude started in. */
export const LOCAL_SETTINGS = path.join('.claude', 'settings.local.json');

/**
 * `settings` with `dir` added to (`add`) or removed from
 * `permissions.additionalDirectories`; null when that changes nothing. Every
 * other key stays, and the path is never listed twice.
 */
export function withAdditionalDirectory(
  text: string | null,
  dir: string,
  add: boolean,
): string | null {
  const parsed: unknown = text === null || text.trim() === '' ? {} : JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('not a JSON object');
  }
  const settings = parsed as Record<string, unknown>;
  const permissions =
    settings.permissions &&
    typeof settings.permissions === 'object' &&
    !Array.isArray(settings.permissions)
      ? (settings.permissions as Record<string, unknown>)
      : null;
  const current = Array.isArray(permissions?.additionalDirectories)
    ? (permissions.additionalDirectories as unknown[])
    : null;
  const listed = current?.includes(dir) ?? false;
  if (add === listed) return null;
  if (!add) {
    (permissions as Record<string, unknown>).additionalDirectories = (current ?? []).filter(
      (d) => d !== dir,
    );
  } else {
    settings.permissions = {
      ...permissions,
      additionalDirectories: [...(current ?? []), dir],
    };
  }
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/**
 * Adds a linked worktree to, or removes it from, the additional directories of
 * the Claude that started in `claudeDir` (spec §21.4): a running Claude Code
 * reads `.claude/settings.local.json` again and takes the folder in at once,
 * without `/add-dir` and its question. Read just before writing; nothing is
 * written when nothing changes or the file isn't JSON. Never throws.
 */
export function setAdditionalDirectory(
  claudeDir: string,
  dir: string,
  add: boolean,
  warn: (message: string) => void = console.warn,
): void {
  const file = path.join(claudeDir, LOCAL_SETTINGS);
  try {
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (text === null && !add) return;
    let next: string | null;
    try {
      next = withAdditionalDirectory(text, path.resolve(dir), add);
    } catch (error) {
      warn(`${file} isn't readable JSON (${String(error)}); left as it is`);
      return;
    }
    if (!next) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeAtomically(fs.existsSync(file) ? fs.realpathSync(file) : file, next);
  } catch (error) {
    warn(`Updating ${file} failed: ${String(error)}`);
  }
}

/**
 * Keeps `.claude/settings.local.json` out of `git status` (spec §21.4): when
 * git doesn't ignore it in `worktree` already, it goes into the repository's
 * `info/exclude`, never into its `.gitignore`.
 */
export async function excludeLocalSettings(
  git: Pick<Git, 'tryRun'>,
  worktree: string,
): Promise<void> {
  const entry = LOCAL_SETTINGS.split(path.sep).join('/');
  if ((await git.tryRun(worktree, ['check-ignore', '-q', entry])) !== null) return;
  const common = (
    await git.tryRun(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  )?.trim();
  if (!common) return;
  const exclude = path.join(common, 'info', 'exclude');
  const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  if (current.split('\n').some((l) => l.trim() === entry || l.trim() === `/${entry}`)) return;
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  const separator = current && !current.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(exclude, `${separator}${entry}\n`);
}
