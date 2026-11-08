import { z } from 'zod';
import { APPEARANCES } from './appearance';
import { toProfileColor } from './profile-colors';

/** Which events play a sound (spec §10.3); the keys of SOUND_EVENTS. */
export const SoundsSchema = z.object({
  needsPermission: z.boolean().default(false),
  needsInput: z.boolean().default(false),
  awaitingApproval: z.boolean().default(false),
  done: z.boolean().default(false),
  error: z.boolean().default(false),
});
export type Sounds = z.output<typeof SoundsSchema>;

/** Lowercase id used in paths and env values: `work`, `api-service`. */
export const IdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'use lowercase letters, digits, ".", "_" or "-"');

const BranchSchema = z.string().min(1);

export const CommitIdentitySchema = z.object({
  commitName: z.string().min(1),
  commitEmail: z.string().min(1),
});

/** The default prompt for Create PR without a command (spec §3.1, §14.1). */
export const DEFAULT_CREATE_PR_PROMPT =
  'Open a pull request from this branch into {base}. Title: "{id}: {title}". Link the task: {url}.';

/** PR commands (spec §12.3, §14.1); a project's fields override its profile's. */
export const PrSettingsSchema = z.object({
  statusCommand: z.string().min(1).nullish(),
  createCommand: z.string().min(1).nullish(),
  createPrompt: z.string().min(1).nullish(),
  timeoutSec: z.number().int().positive().optional(),
});

/**
 * A skill source of a profile (spec §13.2): a local folder, or a git
 * repository the app clones. `projects` null means all of the profile's.
 */
export const SkillSourceSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
    kind: z.enum(['folder', 'git']),
    path: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
    projects: z.array(IdSchema).nullable().default(null),
  })
  .refine((s) => (s.kind === 'folder' ? !!s.path : !!s.url), {
    message: 'a folder source needs a path, a git source a url',
  });

/** The default Continue prompt (spec §13.4). */
export const DEFAULT_CONTINUE_PROMPT = 'Continue with {id}. Its status is {status}.';

/** One status of a workflow (spec §13.4): its value in the file, its label and its kind. */
export const WorkflowStatusSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(['step', 'gate', 'final']).default('step'),
  /** Shown next to the stepper at this status, e.g. "Review and approve the spec" (§13.5). */
  hint: z.string().min(1).nullish(),
  /** A gate's answer button: its label and the text it sends into Claude (§13.5). */
  answer: z.object({ label: z.string().min(1), prompt: z.string().min(1) }).nullish(),
});

/** The default prompt of a task lookup that asks Claude (spec §13.7). */
export const DEFAULT_LOOKUP_PROMPT =
  "Print only the title of the task {id}, nothing else. If you can't find it, print nothing.";

/**
 * How New workspace finds a task's title from its id (spec §13.7): a prompt
 * run with the profile's Claude non-interactively, allowed only `tools`, or a
 * command run with the profile's environment that prints the title.
 */
export const TaskLookupSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('prompt'),
    prompt: z.string().min(1).default(DEFAULT_LOOKUP_PROMPT),
    /** Unset: the profile's own model (no --model). */
    model: z.string().trim().optional(),
    /** Permission rules Claude may use: tool names, `mcp__<server>` or `Bash(<command>:*)`. */
    tools: z.array(z.string().min(1)).default([]),
    timeoutSec: z.number().int().min(5).max(600).default(60),
  }),
  z.object({
    kind: z.literal('command'),
    command: z.string().min(1),
    timeoutSec: z.number().int().min(5).max(600).default(20),
  }),
]);

/**
 * How the app reads a task's progress (spec §13.4): the status field in the
 * front matter of a file in the worktree, which the team's skills keep.
 */
export const WorkflowSchema = z.object({
  /** Relative to the worktree; `*` matches within one path segment. */
  file: z.string().min(1),
  /** Which matching file is the workspace's: its field equals the branch or the task id. */
  match: z
    .object({
      field: z.string().min(1).default('branch'),
      equals: z.enum(['branch', 'taskId']).default('branch'),
    })
    .prefault({}),
  idField: z.string().min(1).nullish(),
  titleField: z.string().min(1).nullish(),
  statusField: z.string().min(1).default('status'),
  /** The workspace tab showing the status file (§13.8); unset uses the file's name. */
  documentLabel: z.string().min(1).nullish(),
  statuses: z.array(WorkflowStatusSchema).default([]),
  /** Claude's first message in a new workspace with a task id (§13.5); a project may set its own. */
  startPrompt: z.string().min(1).nullish(),
  continuePrompt: z.string().min(1).default(DEFAULT_CONTINUE_PROMPT),
});

/** The editors the app knows how to start (spec §6.13). */
export const EDITOR_KINDS = ['vscode', 'cursor', 'idea', 'webstorm', 'zed'] as const;

/**
 * An editor for Open in editor (spec §6.13): a known one, or custom commands
 * with `{path}` (a folder) and `{file}` `{line}` (a file at a line).
 */
export const EditorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.enum(EDITOR_KINDS) }),
  z.object({
    kind: z.literal('custom'),
    /** Opens a folder: `{path}`. */
    folder: z.string().trim().min(1),
    /** Opens a file at a line: `{file}`, `{line}`; without it, the file's folder opens. */
    file: z.string().trim().min(1).nullish(),
  }),
]);

/**
 * The task lookup used to be part of the workflow (`workflow.lookup`); a
 * profile without its own `taskLookup` still reads it from there (spec §13.7).
 * Saving the workflow or the lookup moves it.
 */
function liftLookup<T>(raw: T): T {
  if (!raw || typeof raw !== 'object' || 'taskLookup' in raw) return raw;
  const workflow = (raw as { workflow?: unknown }).workflow;
  const lookup =
    workflow && typeof workflow === 'object' ? (workflow as { lookup?: unknown }).lookup : null;
  return lookup ? { ...raw, taskLookup: lookup } : raw;
}

/** Spec §3.1. Fields of later milestones are added when they are implemented. */
const ProfileObjectSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  /** A palette name (§3.1); `#rrggbb` maps to the nearest name, anything else to graphite. */
  color: z.string().optional().transform(toProfileColor),
  icon: z.string().optional(),
  claude: z
    .object({
      command: z.string().min(1).default('claude'),
      args: z.array(z.string()).default([]),
      /** The profile's own status line command, run by the app's (spec §9.3). */
      statusLine: z.string().min(1).nullish(),
      /** Claude asks before running `<slug> link` (spec §21.9), in every permission mode. */
      askBeforeLink: z.boolean().default(true),
    })
    .prefault({}),
  env: z.record(z.string(), z.string()).default({}),
  defaults: z
    .object({
      baseBranch: BranchSchema.default('main'),
      branchTemplate: z.string().default('{id}-{slug}'),
      worktreeRoot: z.string().min(1).optional(),
    })
    .prefault({}),
  git: CommitIdentitySchema.nullish(),
  pr: PrSettingsSchema.nullish(),
  /** Skill sources loaded into the profile's sessions (spec §13.2). */
  skills: z.array(SkillSourceSchema).default([]),
  /** The workflow read from a status file (spec §13.4); unset means none. */
  workflow: WorkflowSchema.nullish(),
  /** Finds a title for a task id typed alone in New workspace (§13.7); unset means none. */
  taskLookup: TaskLookupSchema.nullish(),
  /** Open in editor (spec §6.13); unset until chosen. */
  editor: EditorSchema.nullish(),
  /**
   * Spec §10.3: a sound per event (SOUND_EVENTS), all off by default, and Do
   * Not Disturb (no notifications or sounds). The old single `sound` switch
   * is ignored, so profiles that had it start with all sounds off.
   */
  alerts: z
    .object({
      sounds: SoundsSchema.prefault({}),
      doNotDisturb: z.boolean().default(false),
    })
    .prefault({}),
  /**
   * Spec §9.7: continue the work the app's stop interrupted when it starts
   * again (off by default), with this prompt (unset: the default).
   */
  resume: z
    .object({
      continueAtStart: z.boolean().default(false),
      prompt: z.string().min(1).nullish(),
    })
    .prefault({}),
  /**
   * Spec §9.8: suspend idle Claude sessions after this many minutes, 0 for
   * Off. Unset means never chosen: the default, 10, which the app writes at
   * start (`suspendDelay` reads it).
   */
  suspendIdleMin: z.union([z.literal(0), z.literal(5), z.literal(10), z.literal(30)]).nullish(),
});
export const ProfileSchema = z.preprocess(
  (raw: z.input<typeof ProfileObjectSchema>) => liftLookup(raw),
  ProfileObjectSchema,
);

/**
 * Setup and teardown commands kept in the app (spec §8.3): the same shape as
 * the repository's own `.<slug>/config.json`, which wins when it exists.
 */
export const SetupSettingsSchema = z.object({
  setup: z.array(z.string().min(1)).default([]),
  teardown: z.array(z.string().min(1)).default([]),
  /** Ports per workspace (§8.4). */
  ports: z.number().int().min(1).max(100).optional(),
  startClaude: z.enum(['after-setup', 'parallel']).optional(),
});

/** Spec §3.2. */
export const ProjectSchema = z.object({
  id: IdSchema,
  profileId: IdSchema,
  name: z.string().min(1),
  repoPath: z.string().min(1),
  /** `null` for a repository without remotes. */
  remote: z.string().min(1).nullable().default('origin'),
  baseBranch: BranchSchema.optional(),
  /** The folder for this project's worktrees; unset means `<profile root>/<project>` (§8.1). */
  worktreeRoot: z.string().min(1).nullish(),
  /** Setup and teardown kept in the app; unset means none (§8.3). */
  setup: SetupSettingsSchema.nullish(),
  git: CommitIdentitySchema.nullish(),
  pr: PrSettingsSchema.nullish(),
  /** The profile's skill sources switched off for this project (spec §13.2). */
  skillsOff: z.array(IdSchema).default([]),
  /** Unset uses the profile's workflow, false turns it off, an object replaces it (§13.4). */
  workflow: z.union([WorkflowSchema, z.literal(false)]).nullish(),
  /** Overrides the workflow's Start prompt for this project (§13.5). */
  startPrompt: z.string().min(1).nullish(),
  /** Its own editor; unset uses the profile's (§6.13). */
  editor: EditorSchema.nullish(),
});

/** The range workspace port blocks come from (spec §8.4). */
export const PortRangeSchema = z
  .object({ start: z.number().int().min(1024), end: z.number().int().max(65535) })
  .refine((r) => r.end > r.start, 'end must be above start');
export const DEFAULT_PORT_RANGE = { start: 20000, end: 29999 };

export const ConfigSchema = z
  .object({
    version: z.literal(1),
    /** Empty on a new install: the first launch opens the New profile wizard (spec §6.11). */
    profiles: z.array(ProfileSchema),
    projects: z.array(ProjectSchema).default([]),
    /** Workspace port blocks (spec §8.4); 20000–29999 when unset. */
    ports: PortRangeSchema.optional(),
    /** macOS: closing the window quits instead of keeping the app running (spec §5). */
    quitOnWindowClose: z.boolean().optional(),
    /** Check for Updates Automatically (spec §15.7); unset until the first-start question is answered. */
    checkForUpdates: z.boolean().optional(),
    /** View › Appearance (spec §6); unset follows the OS. */
    appearance: z.enum(APPEARANCES).optional(),
  })
  .superRefine((config, ctx) => {
    const duplicates = (values: string[]) =>
      values.filter((value, index) => values.indexOf(value) !== index);

    for (const id of duplicates(config.profiles.map((p) => p.id))) {
      ctx.addIssue({ code: 'custom', path: ['profiles'], message: `duplicate profile id "${id}"` });
    }
    for (const id of duplicates(config.projects.map((p) => p.id))) {
      ctx.addIssue({ code: 'custom', path: ['projects'], message: `duplicate project id "${id}"` });
    }
    config.profiles.forEach((profile, index) => {
      for (const id of duplicates(profile.skills.map((s) => s.id))) {
        ctx.addIssue({
          code: 'custom',
          path: ['profiles', index, 'skills'],
          message: `duplicate skill source id "${id}"`,
        });
      }
    });
    const profileIds = new Set(config.profiles.map((p) => p.id));
    config.projects.forEach((project, index) => {
      if (!profileIds.has(project.profileId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['projects', index, 'profileId'],
          message: `unknown profile "${project.profileId}"`,
        });
      }
    });
    // Rule R1: a repository belongs to exactly one profile.
    for (const repoPath of duplicates(config.projects.map((p) => p.repoPath))) {
      ctx.addIssue({
        code: 'custom',
        path: ['projects'],
        message: `repository "${repoPath}" is registered more than once`,
      });
    }
  });

export type Profile = z.infer<typeof ProfileSchema>;
export type SkillSource = z.infer<typeof SkillSourceSchema>;
export type Workflow = z.infer<typeof WorkflowSchema>;
export type WorkflowStatus = z.infer<typeof WorkflowStatusSchema>;
export type TaskLookup = z.infer<typeof TaskLookupSchema>;
export type Editor = z.infer<typeof EditorSchema>;
export type EditorKind = (typeof EDITOR_KINDS)[number];
export type Project = z.infer<typeof ProjectSchema>;
export type SetupSettings = z.infer<typeof SetupSettingsSchema>;
export type PrSettings = z.infer<typeof PrSettingsSchema>;
export type Config = z.infer<typeof ConfigSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;
