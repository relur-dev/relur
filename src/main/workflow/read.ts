import fs from 'node:fs';
import path from 'node:path';
import type { Workflow } from '@shared/schemas';
import { segmentMatches, type WorkflowInfo } from '@shared/workflow';
import { frontMatter } from '../frontmatter';

/** Status files larger than this aren't read (spec §13.4). */
export const MAX_STATUS_FILE_BYTES = 256 * 1024;
/** At most this many matching files are looked at. */
const MAX_CANDIDATES = 500;

/** One file matching the pattern, with its front matter or why it couldn't be read. */
export interface StatusCandidate {
  /** Relative to the worktree, with `/`. */
  file: string;
  fields: Record<string, unknown> | null;
  error: string | null;
}

/** What the preview shows (spec §13.4): every matching file, the one chosen, and the result. */
export interface StatusRead {
  candidates: StatusCandidate[];
  /** The chosen file's front matter. */
  fields: Record<string, unknown> | null;
  info: WorkflowInfo;
}

/** The files under `root` matching `pattern` (`*` within one segment), sorted. */
export function matchFiles(root: string, pattern: string): string[] {
  const segments = pattern.split('/').filter(Boolean);
  const out: string[] = [];
  const walk = (dir: string, rel: string[], index: number) => {
    if (out.length >= MAX_CANDIDATES) return;
    const segment = segments[index];
    if (segment === undefined) return;
    const last = index === segments.length - 1;
    let names: string[];
    if (segment.includes('*')) {
      try {
        names = fs.readdirSync(dir).filter((n) => !n.startsWith('.') && segmentMatches(segment, n));
      } catch {
        return;
      }
    } else {
      names = [segment];
    }
    for (const name of names.sort()) {
      const full = path.join(dir, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (last) {
        if (stat.isFile()) out.push([...rel, name].join('/'));
      } else if (stat.isDirectory()) {
        walk(full, [...rel, name], index + 1);
      }
    }
  };
  walk(root, [], 0);
  return out;
}

function readCandidate(root: string, file: string): StatusCandidate {
  const full = path.join(root, file);
  try {
    if (fs.statSync(full).size > MAX_STATUS_FILE_BYTES) {
      return { file, fields: null, error: 'over 256 KB' };
    }
    const fields = frontMatter(fs.readFileSync(full, 'utf8'));
    return fields
      ? { file, fields, error: null }
      : { file, fields: null, error: 'no front matter' };
  } catch (error) {
    return { file, fields: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/** A front matter value as text, for matching and showing. */
export function fieldText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return null;
}

/** The first `# heading` of a Markdown file, for a title (spec §13.6). */
export function firstHeading(root: string, file: string): string | null {
  try {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    return /^#[ \t]+(.+?)\s*#*\s*$/m.exec(text)?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

const noStatus = (
  workflow: Workflow,
  problem: string,
  file: string | null = null,
): WorkflowInfo => ({
  statuses: workflow.statuses,
  status: null,
  index: -1,
  kind: null,
  label: null,
  file,
  problem,
});

/**
 * Finds a workspace's status file and its status (spec §13.4): among the
 * files matching the pattern, the one whose match field equals the branch
 * (or the task id). None or several give a problem instead of a status.
 */
export function readStatus(
  worktree: string,
  workflow: Workflow,
  workspace: { branch: string; taskId: string | null },
): StatusRead {
  const candidates = matchFiles(worktree, workflow.file).map((f) => readCandidate(worktree, f));
  const want = workflow.match.equals === 'taskId' ? workspace.taskId : workspace.branch;
  const what =
    workflow.match.equals === 'taskId' ? (workspace.taskId ?? 'its task id') : workspace.branch;
  if (!want) {
    return {
      candidates,
      fields: null,
      info: noStatus(workflow, 'This workspace has no task id to match'),
    };
  }
  const chosen = candidates.filter((c) => fieldText(c.fields?.[workflow.match.field]) === want);
  if (chosen.length === 0) {
    return { candidates, fields: null, info: noStatus(workflow, `No status file for ${what} yet`) };
  }
  if (chosen.length > 1) {
    return {
      candidates,
      fields: null,
      info: noStatus(workflow, `${chosen.length} files match ${what}`),
    };
  }
  const file = chosen[0] as StatusCandidate;
  const fields = file.fields ?? {};
  const status = fieldText(fields[workflow.statusField]);
  if (!status) {
    return {
      candidates,
      fields,
      info: noStatus(workflow, `${file.file} has no ${workflow.statusField} field`, file.file),
    };
  }
  const index = workflow.statuses.findIndex((s) => s.value === status);
  const known = workflow.statuses[index];
  return {
    candidates,
    fields,
    info: {
      statuses: workflow.statuses,
      status,
      index,
      kind: known ? known.kind : 'unknown',
      label: known ? known.label : status,
      hint: known?.hint ?? null,
      file: file.file,
      problem: null,
    },
  };
}
