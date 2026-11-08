import type { Profile, Project, Workflow, WorkflowStatus } from './schemas';
import type { WorkspaceState } from './status';

/**
 * A workspace's workflow as read from its status file (spec §13.4, §13.5),
 * for the stepper, the status label and Continue.
 */
export interface WorkflowInfo {
  /** The statuses in order, for the stepper. */
  statuses: WorkflowStatus[];
  /** The status value in the file; null without a usable file. */
  status: string | null;
  /** Its position in `statuses`; -1 when unknown or none. */
  index: number;
  /** Null without a status; `unknown` for a value not in the list. */
  kind: WorkflowStatus['kind'] | 'unknown' | null;
  /** The status's label, or the raw value when unknown. */
  label: string | null;
  /** The status's hint (spec §13.5); null without one. */
  hint?: string | null;
  /** The file used, relative to the worktree. */
  file: string | null;
  /** Why there's no status: no file yet, several files, unreadable front matter. */
  problem: string | null;
}

/** A project's workflow (spec §13.4): its own, none (false), or its profile's. */
export function effectiveWorkflow(
  profile: Pick<Profile, 'workflow'>,
  project: Pick<Project, 'workflow'>,
): Workflow | null {
  if (project.workflow === false) return null;
  return project.workflow ?? profile.workflow ?? null;
}

/**
 * The part of a pattern before its first `*` segment: the folder watched for
 * changes (`docs/specs/*\/specification.md` → `docs/specs`).
 */
export function fixedPrefix(pattern: string): string {
  const segments = pattern.split('/').filter(Boolean);
  const first = segments.findIndex((s) => s.includes('*'));
  return (first === -1 ? segments.slice(0, -1) : segments.slice(0, first)).join('/');
}

/** Whether a path segment matches a pattern segment, `*` standing for any run of characters. */
export function segmentMatches(pattern: string, name: string): boolean {
  const re = new RegExp(
    `^${pattern
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  );
  return re.test(name);
}

/** Claude states in which the workspace waits for the developer at a gate (spec §13.5). */
const IDLE: readonly WorkspaceState[] = ['done', 'interrupted', 'needs-input', 'exited'];

/**
 * Whether the workspace is at a gate and Claude isn't working (spec §13.5):
 * it then shows as Awaiting approval. Needing permission stays as it is.
 */
export function atGate(state: WorkspaceState, workflow: WorkflowInfo | null): boolean {
  return workflow?.kind === 'gate' && IDLE.includes(state);
}

/** Whether Continue may type its prompt now: Claude runs and is idle (spec §13.5). */
export const canContinue = (state: WorkspaceState) =>
  state === 'done' || state === 'interrupted' || state === 'needs-input';

/** The values a workflow prompt is filled with (spec §13.4). */
export function promptValues(
  workspace: { branch: string; task: { id: string | null; title: string } },
  status: string | null,
): Record<string, string> {
  return {
    id: workspace.task.id ?? '',
    title: workspace.task.title,
    branch: workspace.branch,
    status: status ?? '',
  };
}

/** The status file as the spec view shows it (spec §13.8). */
export interface StatusDocument {
  /** Relative to the worktree, with `/`. */
  file: string;
  /** The tab's name: the workflow's document label, else the file's name. */
  label: string;
  /** The text after the front matter. */
  markdown: string;
  /** The front matter's values as text, for the header. */
  fields: Record<string, string>;
}

/** The tab's name for a workflow's status file (spec §13.8). */
export const documentLabel = (workflow: Pick<Workflow, 'documentLabel'>, file: string) =>
  workflow.documentLabel?.trim() || file.split('/').pop() || file;

/** Whether a front matter value is a web address the header shows as a link. */
export const isWebUrl = (value: string) => /^https?:\/\/[^\s]+$/i.test(value);
