import type { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { editorFor } from '@shared/editor';
import { boardColumn, QUICK_REPLY_REFUSAL, quickReply } from '@shared/home';
import type { Editor } from '@shared/schemas';
import {
  EditorSchema,
  IdSchema,
  SetupSettingsSchema,
  SoundsSchema,
  TaskLookupSchema,
  WorkflowSchema,
} from '@shared/schemas';
import type { Release } from '@shared/updates';
import { parseWorkflowFile, WORKFLOW_FILE, workflowFileText } from '@shared/workflow-file';
import { workspaceRepo } from '@shared/workspaces';
import { app, BrowserWindow, clipboard, dialog, nativeTheme, shell, webContents } from 'electron';
import { z } from 'zod';
import type { FinishService } from '../changes/finish';
import { watchWorktrees } from '../changes/watch';
import { readResponses, watchTranscript } from '../claude/transcript';
import { cliInstallInfo, installCli } from '../cli-install';
import type { ConfigStore } from '../config/store';
import { showContextMenu } from '../context-menu';
import type { StateDb } from '../db/state-db';
import type { UsageRecords } from '../db/usage';
import type { WorkspaceRecords } from '../db/workspaces';
import type { EditorService } from '../editor/service';
import type { EnvService } from '../env/service';
import type { MemoryMonitor } from '../memory/service';
import type { MenuFeedback, MenuRequest } from '../menu';
import { contractHome, expandHome } from '../paths';
import type { RemoteFound, RemoteWatch } from '../projects/remote-watch';
import { chromiumSandboxOff } from '../sandbox';
import { openExternalSafe } from '../security';
import type { CliLinkEvent, CliLinkService } from '../services/cli-link';
import type { ProfileService } from '../services/profiles';
import type { ProjectService } from '../services/projects';
import type { TerminalService } from '../services/terminals';
import type { WorkspaceService } from '../services/workspaces';
import { attachToWindow } from '../sessions/electron';
import type { SetupService } from '../setup/service';
import type { SkillService } from '../skills/service';
import type { ElectronStatusPlatform } from '../status/electron';
import type { Alert, ConversationEvent, StatusService } from '../status/service';
import type { SuspendDefaultNotice } from '../suspend/notice';
import type { SuspendService } from '../suspend/service';
import type { UnfinishedService } from '../unfinished/service';
import type { UpdateAction } from '../updates/install';
import type { UpdateInstaller } from '../updates/installer';
import type { UpdateService } from '../updates/service';
import { windowStateChanged } from '../window';
import type { WorkflowSetupService } from '../workflow/propose';
import type { WorkflowService } from '../workflow/service';
import type { NewWorktree, WorktreeNotices } from '../worktrees/notices';
import { fromListener } from './events';
import { publicProcedure, router } from './trpc';

export interface Services {
  config: ConfigStore;
  db: StateDb;
  workspaceRecords: WorkspaceRecords;
  env: EnvService;
  projects: ProjectService;
  terminals: TerminalService;
  workspaces: WorkspaceService;
  cliLink: CliLinkService;
  skills: SkillService;
  workflow: WorkflowService;
  workflowSetup: WorkflowSetupService;
  worktreeNotices: WorktreeNotices;
  remoteWatch: RemoteWatch;
  finish: FinishService;
  editors: EditorService;
  setup: SetupService;
  profiles: ProfileService;
  status: StatusService;
  statusPlatform: ElectronStatusPlatform;
  usage: UsageRecords;
  /** Memory used by Claude sessions and the app (spec §6.14). */
  memory: MemoryMonitor;
  /** Suspending idle sessions (spec §9.8). */
  suspend: SuspendService;
  /** The one-time notice that suspension is on by default (spec §9.8). */
  suspendNotice: SuspendDefaultNotice;
  /** Menu items the renderer answers with a dialog. */
  menuRequests: EventEmitter;
  /** Report a Bug… and Request a Feature… (spec §6.12), also from the Guide. */
  feedback: MenuFeedback;
  /** The compiled helper, or null when it wasn't built. */
  helper: string | null;
  /** Continuing interrupted work (spec §9.7). */
  unfinished: UnfinishedService;
  /**
   * New versions (spec §15.7): the service, updating inside the app, and
   * Update in terminal for this installation.
   */
  updates: {
    service: UpdateService;
    installer: UpdateInstaller;
    inTerminal: (release: Release) => Promise<UpdateAction>;
  };
  /** The quit dialog: requests with busy session ids, and the user's answer. */
  quit: { asker: EventEmitter; answer: (quit: boolean) => void };
  /** The notice when the window first closes and the app keeps running (spec §5). */
  closeNotice: { asker: EventEmitter; answer: (close: boolean) => void };
}

const windowOf = (windowId: number) => {
  const contents = webContents.fromId(windowId);
  return contents ? BrowserWindow.fromWebContents(contents) : null;
};

export function createAppRouter({
  config,
  workspaceRecords,
  env,
  projects,
  terminals,
  workspaces,
  cliLink,
  skills,
  workflow,
  workflowSetup,
  worktreeNotices,
  remoteWatch,
  finish,
  editors,
  setup,
  profiles,
  status,
  statusPlatform,
  usage,
  memory,
  suspend,
  suspendNotice,
  menuRequests,
  feedback,
  helper,
  quit,
  closeNotice,
  unfinished,
  updates,
}: Services) {
  const host = terminals.host;
  const sessionId = z.object({ sessionId: z.string().min(1) });
  const projectId = z.object({ projectId: IdSchema });
  const workspaceId = z.object({ workspaceId: z.string().min(1).max(100) });
  /** One repository of a workspace (spec §21); the main one when left out or null. */
  const repo = { projectId: IdSchema.nullable().optional() };
  const deleteChoice = z.object({ force: z.boolean(), deleteBranch: z.boolean() });

  return router({
    app: router({
      info: publicProcedure.query(() => ({
        version: app.getVersion(),
        platform: process.platform,
        configDir: app.getPath('userData'),
      })),
      /** Why Chromium's sandbox is off, or null; the window warns (spec §15.6). */
      sandboxOff: publicProcedure.query(() => chromiumSandboxOff()),
      /** Quitting would interrupt these sessions; the window asks (spec §5). */
      quitRequests: publicProcedure.subscription(({ signal }) =>
        fromListener<string[]>((listener) => {
          quit.asker.on('request', listener);
          return () => quit.asker.off('request', listener);
        }, signal),
      ),
      answerQuit: publicProcedure
        .input(z.object({ quit: z.boolean() }))
        .mutation(({ input }) => quit.answer(input.quit)),
      /** The window is closing for the first time ever; it says the app keeps running. */
      closeNoticeRequests: publicProcedure.subscription(({ signal }) =>
        fromListener<true>((listener) => {
          const onRequest = () => listener(true);
          closeNotice.asker.on('request', onRequest);
          return () => closeNotice.asker.off('request', onRequest);
        }, signal),
      ),
      answerCloseNotice: publicProcedure
        .input(z.object({ close: z.boolean() }))
        .mutation(({ input }) => closeNotice.answer(input.close)),
      /**
       * Suspension turned on by default: the profiles the start gave the
       * default, or null when there is no notice (spec §9.8).
       */
      suspendNotice: publicProcedure.query(() => suspendNotice.get()),
      dismissSuspendNotice: publicProcedure.mutation(() => suspendNotice.dismiss()),
      /** The OS appearance; the renderer sets data-theme from it. */
      theme: publicProcedure.query(() => ({ dark: nativeTheme.shouldUseDarkColors })),
      themeChanges: publicProcedure.subscription(({ signal }) =>
        fromListener<{ dark: boolean }>((listener) => {
          const onUpdated = () => listener({ dark: nativeTheme.shouldUseDarkColors });
          nativeTheme.on('updated', onUpdated);
          return () => nativeTheme.off('updated', onUpdated);
        }, signal),
      ),
    }),

    config: router({
      get: publicProcedure.query(() => config.get()),
      reload: publicProcedure.mutation(() => config.reload()),
      openFile: publicProcedure.mutation(async () => {
        const error = await shell.openPath(config.file);
        if (error) throw new Error(error);
      }),
      /** Emits after every reload or app-made change, valid or not. */
      changes: publicProcedure.subscription(({ signal }) =>
        fromListener((listener) => config.onChange(listener), signal),
      ),
    }),

    env: router({
      diagnostics: publicProcedure.query(() => env.diagnostics()),
    }),

    /** The setup check per profile (spec §6.11). */
    setup: router({
      /** Every profile's last result, by profile id. */
      all: publicProcedure.query(() => setup.all()),
      /** The last result; the first call starts a check. Null until it has progress. */
      get: publicProcedure
        .input(z.object({ profileId: IdSchema }))
        .query(({ input }) => setup.get(input.profileId)),
      /** Checks again now (Check again, ⌘R). */
      check: publicProcedure
        .input(z.object({ profileId: IdSchema }))
        .mutation(({ input }) => setup.check(input.profileId)),
      /** Emits the profile id whenever its result changes. */
      changes: publicProcedure.subscription(({ signal }) =>
        fromListener<string>((listener) => setup.onChange(listener), signal),
      ),
      installMethods: publicProcedure.query(() => setup.installMethods()),
      /** Starts an official installer in a terminal session (only from the Install button). */
      install: publicProcedure
        .input(z.object({ profileId: IdSchema, method: z.enum(['native', 'brew']) }))
        .mutation(({ input }) => setup.install(input.profileId, input.method)),
      /** Starts `claude auth login` in a terminal session (only from the Sign in button). */
      signIn: publicProcedure
        .input(z.object({ profileId: IdSchema }))
        .mutation(({ input }) => setup.signIn(input.profileId)),
    }),

    /** New profile wizard and Edit profile (spec §6.11). */
    /** Skill sources per profile (spec §13.2, §13.3). */
    skills: router({
      /** Every source of the profile as found on disk now. */
      list: publicProcedure
        .input(z.object({ profileId: IdSchema }))
        .query(({ input }) => skills.inspectAll(input.profileId)),
      /** The project's Skills tab: every source of its profile, on where it applies. */
      forProject: publicProcedure
        .input(projectId)
        .query(({ input }) => skills.forProject(input.projectId)),
      /** Native folder picker for a local source; null when cancelled. */
      pickFolder: publicProcedure.mutation(async ({ ctx }) => {
        const win = windowOf(ctx.windowId);
        const options = {
          title: 'Choose a skills folder',
          defaultPath: app.getPath('home'),
          properties: ['openDirectory' as const, 'showHiddenFiles' as const],
        };
        const result = win
          ? await dialog.showOpenDialog(win, options)
          : await dialog.showOpenDialog(options);
        return result.canceled ? null : (result.filePaths[0] ?? null);
      }),
      add: publicProcedure
        .input(
          z.object({
            profileId: IdSchema,
            name: z.string().max(100),
            kind: z.enum(['folder', 'git']),
            location: z.string().min(1).max(2000),
            projects: z.array(IdSchema).nullable(),
          }),
        )
        .mutation(({ input: { profileId, ...source } }) => skills.add(profileId, source)),
      edit: publicProcedure
        .input(
          z.object({
            profileId: IdSchema,
            sourceId: IdSchema,
            name: z.string().min(1).max(100),
            projects: z.array(IdSchema).nullable(),
          }),
        )
        .mutation(({ input: { profileId, sourceId, ...changes } }) =>
          skills.edit(profileId, sourceId, changes),
        ),
      remove: publicProcedure
        .input(z.object({ profileId: IdSchema, sourceId: IdSchema, deleteClone: z.boolean() }))
        .mutation(({ input }) =>
          skills.remove(input.profileId, input.sourceId, { deleteClone: input.deleteClone }),
        ),
      /** Update: `git pull --ff-only` in a git source's clone. */
      update: publicProcedure
        .input(z.object({ profileId: IdSchema, sourceId: IdSchema }))
        .mutation(({ input }) => skills.update(input.profileId, input.sourceId)),
      /** The Skills tab's switch. */
      setEnabled: publicProcedure
        .input(z.object({ projectId: IdSchema, sourceId: IdSchema, enabled: z.boolean() }))
        .mutation(({ input }) => skills.setEnabled(input.projectId, input.sourceId, input.enabled)),
      /** Workspaces whose running Claude started with other skills than it would get now. */
      changedWorkspaces: publicProcedure.query(() =>
        skills.changedWorkspaces(
          host
            .list()
            .filter((s) => s.kind === 'claude' && s.status === 'running' && s.workspaceId)
            .flatMap((s) => {
              const workspace = workspaceRecords.get(s.workspaceId as string);
              return workspace
                ? [
                    {
                      workspaceId: workspace.id,
                      profileId: workspace.profileId,
                      projectIds: workspace.repos.map((r) => r.projectId),
                    },
                  ]
                : [];
            }),
        ),
      ),
      /** Emits when sources, their contents or a session's skills change. */
      changes: publicProcedure.subscription(({ signal }) =>
        fromListener<void>((listener) => skills.onChange(() => listener()), signal),
      ),
    }),

    /** The workflow read from status files (spec §13.4, §13.5). */
    workflow: router({
      /** Continue: types the Continue prompt into the workspace's idle Claude. */
      continue: publicProcedure
        .input(workspaceId)
        .mutation(({ input }) => workflow.continue(input.workspaceId)),
      /** A gate's answer button: types its text into the workspace's idle Claude. */
      answer: publicProcedure
        .input(workspaceId)
        .mutation(({ input }) => workflow.answer(input.workspaceId)),
      /** What a workflow, saved or not, finds in one workspace's worktree. */
      preview: publicProcedure
        .input(z.object({ workflow: WorkflowSchema, workspaceId: z.string().min(1).max(100) }))
        .query(({ input }) => workflow.preview(input.workflow, input.workspaceId)),
      /** The status file for the spec view (spec §13.8), or null. */
      document: publicProcedure
        .input(workspaceId)
        .query(({ input }) => workflow.document(input.workspaceId)),
      /** Emits when the shown workspace's status file may have changed. */
      documentChanges: publicProcedure
        .input(workspaceId)
        .subscription(({ input, signal }) =>
          fromListener<true>(
            (listener) => workflow.onDocument(input.workspaceId, () => listener(true)),
            signal,
          ),
        ),
      /** Relative images of the status file as data: URLs; null for anything else. */
      documentImages: publicProcedure
        .input(workspaceId.extend({ sources: z.array(z.string().max(2000)).max(100) }))
        .query(({ input }) => workflow.documentImages(input.workspaceId, input.sources)),
      /**
       * Open in editor (the project's editor, spec §6.13; the system's default
       * app when none is set) or Reveal in Finder.
       */
      openDocument: publicProcedure
        .input(workspaceId.extend({ how: z.enum(['open', 'reveal']) }))
        .mutation(async ({ input }) => {
          const file = workflow.documentPath(input.workspaceId);
          if (input.how === 'reveal') return shell.showItemInFolder(file);
          const workspace = workspaceRecords.get(input.workspaceId);
          const project = config.require().projects.find((p) => p.id === workspace?.projectId);
          const profile = config.require().profiles.find((p) => p.id === workspace?.profileId);
          if (workspace && profile && editorFor(profile, project)) {
            return editors.open(workspace.profileId, workspace.projectId, {
              kind: 'file',
              file,
              line: 1,
            });
          }
          const error = await shell.openPath(file);
          if (error) throw new Error(error);
        }),
      /** A task's title from its id (spec §13.7); failures come back as results. */
      lookupTitle: publicProcedure
        .input(
          z.object({
            requestId: z.string().min(1).max(100),
            profileId: IdSchema,
            projectId: IdSchema.nullable(),
            taskId: z.string().min(1).max(100),
            /** A draft to test; null uses the profile's. */
            lookup: TaskLookupSchema.nullable(),
          }),
        )
        .mutation(({ input }) => workflow.lookupTitle(input)),
      cancelLookup: publicProcedure
        .input(z.object({ requestId: z.string().min(1).max(100) }))
        .mutation(({ input }) => workflow.cancelLookup(input.requestId)),
      saveProfile: publicProcedure
        .input(z.object({ profileId: IdSchema, workflow: WorkflowSchema.nullable() }))
        .mutation(({ input }) => workflow.saveProfile(input.profileId, input.workflow)),
      /** Set up from my skills (spec §13.10): workspaces whose worktree has a status file. */
      setupCandidates: publicProcedure
        .input(z.object({ profileId: IdSchema, projectId: IdSchema.nullable() }))
        .query(({ input }) => workflowSetup.candidates(input.profileId, input.projectId)),
      /** Has the profile's Claude read a skill source and a worktree, and propose a workflow. */
      propose: publicProcedure
        .input(
          z.object({
            requestId: z.string().min(1).max(100),
            profileId: IdSchema,
            sourceId: IdSchema,
            workspaceId: z.string().min(1).max(100),
            file: z.string().min(1).max(1000),
            model: z.string().trim().max(100).nullable(),
          }),
        )
        .mutation(({ input }) => workflowSetup.propose({ ...input, model: input.model || null })),
      cancelProposal: publicProcedure
        .input(z.object({ requestId: z.string().min(1).max(100) }))
        .mutation(({ input }) => workflowSetup.cancel(input.requestId)),
      /** Export… (spec §13.9): writes the workflow to a file the user picks; null when cancelled. */
      exportFile: publicProcedure
        .input(z.object({ workflow: WorkflowSchema }))
        .mutation(async ({ input, ctx }) => {
          const win = windowOf(ctx.windowId);
          const options = {
            title: 'Export the workflow',
            defaultPath: path.join(app.getPath('home'), WORKFLOW_FILE),
            filters: [{ name: 'Workflow', extensions: ['json'] }],
          };
          const result = win
            ? await dialog.showSaveDialog(win, options)
            : await dialog.showSaveDialog(options);
          if (result.canceled || !result.filePath) return null;
          await fs.promises.writeFile(result.filePath, workflowFileText(input.workflow));
          return contractHome(result.filePath);
        }),
      /** Import… (spec §13.9): the workflow in a file the user picks; null when cancelled. */
      importFile: publicProcedure.mutation(async ({ ctx }) => {
        const win = windowOf(ctx.windowId);
        const options = {
          title: 'Import a workflow',
          defaultPath: app.getPath('home'),
          properties: ['openFile' as const],
          filters: [{ name: 'Workflow', extensions: ['json'] }],
        };
        const result = win
          ? await dialog.showOpenDialog(win, options)
          : await dialog.showOpenDialog(options);
        const file = result.canceled ? undefined : result.filePaths[0];
        if (!file) return null;
        const read = parseWorkflowFile(await fs.promises.readFile(file, 'utf8'));
        if (!read.ok) throw new Error(`Couldn't import ${path.basename(file)}: ${read.message}`);
        return { file: contractHome(file), workflow: read.workflow };
      }),
      saveLookup: publicProcedure
        .input(z.object({ profileId: IdSchema, lookup: TaskLookupSchema.nullable() }))
        .mutation(({ input }) => workflow.saveLookup(input.profileId, input.lookup)),
      saveProject: publicProcedure
        .input(
          projectId.extend({
            workflow: z.union([WorkflowSchema, z.literal(false)]).nullable(),
            startPrompt: z.string().max(10_000).nullable(),
          }),
        )
        .mutation(({ input }) =>
          workflow.saveProject(input.projectId, input.workflow, input.startPrompt),
        ),
    }),

    profiles: router({
      accountFolders: publicProcedure.query(() => profiles.accountFolders()),
      accountFolder: publicProcedure
        .input(z.object({ folder: z.string().min(1) }))
        .mutation(({ input }) => profiles.accountFolder(input.folder)),
      /** Native folder picker for Choose another folder…; null when cancelled. */
      pickFolder: publicProcedure.mutation(async ({ ctx }) => {
        const win = windowOf(ctx.windowId);
        const options = {
          title: 'Choose a Claude config folder',
          defaultPath: app.getPath('home'),
          properties: ['openDirectory' as const, 'showHiddenFiles' as const],
        };
        const result = win
          ? await dialog.showOpenDialog(win, options)
          : await dialog.showOpenDialog(options);
        return result.canceled ? null : (result.filePaths[0] ?? null);
      }),
      create: publicProcedure
        .input(
          z.object({
            name: z.string().min(1).max(100),
            color: z.string(),
            account: z.discriminatedUnion('kind', [
              z.object({ kind: z.literal('default') }),
              z.object({ kind: z.literal('existing'), folder: z.string().min(1) }),
              z.object({ kind: z.literal('new') }),
            ]),
          }),
        )
        .mutation(({ input }) => profiles.create(input)),
      update: publicProcedure
        .input(
          z.object({
            profileId: IdSchema,
            name: z.string().min(1).max(100),
            color: z.string(),
            alerts: z
              .object({ sounds: SoundsSchema.required(), doNotDisturb: z.boolean() })
              .optional(),
            statusLine: z.string().max(2000).nullable().optional(),
            askBeforeLink: z.boolean().optional(),
            git: z
              .object({ commitName: z.string().max(200), commitEmail: z.string().max(200) })
              .nullable()
              .optional(),
            pr: z
              .object({ createCommand: z.string().max(2000), statusCommand: z.string().max(2000) })
              .optional(),
            resume: z
              .object({ continueAtStart: z.boolean(), prompt: z.string().max(4000) })
              .optional(),
            /** 0 is an explicit Off (spec §9.8). */
            suspendIdleMin: z
              .union([z.literal(0), z.literal(5), z.literal(10), z.literal(30)])
              .optional(),
          }),
        )
        .mutation(({ input }) => profiles.update(input.profileId, input)),
      /** Reorders the profile tabs: moves one to a position (spec §6). */
      move: publicProcedure
        .input(z.object({ profileId: IdSchema, index: z.number().int().min(0) }))
        .mutation(({ input }) => profiles.move(input.profileId, input.index)),
      removalRefusal: publicProcedure
        .input(z.object({ profileId: IdSchema }))
        .query(({ input }) => profiles.removalRefusal(input.profileId)),
      /** Removes the profile from the app; its sessions stop, nothing on disk is deleted. */
      remove: publicProcedure
        .input(z.object({ profileId: IdSchema }))
        .mutation(async ({ input }) => {
          const refusal = profiles.removalRefusal(input.profileId);
          if (refusal) throw new Error(refusal);
          for (const session of host.list()) {
            if (session.profileId === input.profileId) await host.remove(session.id);
          }
          profiles.remove(input.profileId);
        }),
      alias: publicProcedure
        .input(z.object({ profileId: IdSchema }))
        .query(({ input }) => profiles.alias(input.profileId)),
      /** Appends the alias line to the shell's startup file, after the user confirmed. */
      addAlias: publicProcedure
        .input(z.object({ profileId: IdSchema }))
        .mutation(({ input }) => profiles.addAlias(input.profileId)),
    }),

    projects: router({
      /** Native folder picker, attached to the calling window. Null when cancelled. */
      pickFolder: publicProcedure.mutation(async ({ ctx }) => {
        const win = windowOf(ctx.windowId);
        const options = { title: 'Add project', properties: ['openDirectory' as const] };
        const result = win
          ? await dialog.showOpenDialog(win, options)
          : await dialog.showOpenDialog(options);
        return result.canceled ? null : (result.filePaths[0] ?? null);
      }),
      inspect: publicProcedure
        .input(z.object({ folder: z.string().min(1), profileId: IdSchema }))
        .mutation(({ input }) => projects.inspect(input.folder, input.profileId)),
      /** One repository, or the repositories one level down in a folder (spec §6.1). */
      examine: publicProcedure
        .input(z.object({ folder: z.string().min(1), profileId: IdSchema }))
        .mutation(({ input }) => projects.examine(input.folder, input.profileId)),
      /** Adds several repositories; each result says added or why not. */
      addMany: publicProcedure
        .input(
          z.object({
            profileId: IdSchema,
            items: z.array(
              z.object({
                repoPath: z.string().min(1),
                name: z.string().min(1),
                remote: z.string().min(1).nullable(),
                baseBranch: z.string().min(1),
              }),
            ),
            worktreeRoot: z.string().min(1).nullable(),
          }),
        )
        .mutation(({ input }) =>
          projects.addMany(input.profileId, input.items, input.worktreeRoot),
        ),
      add: publicProcedure
        .input(
          z.object({
            profileId: IdSchema,
            repoPath: z.string().min(1),
            name: z.string().min(1),
            remote: z.string().min(1).nullable(),
            baseBranch: z.string().min(1),
            worktreeRoot: z.string().min(1).nullable(),
          }),
        )
        .mutation(({ input }) => projects.add(input)),
      /** Native folder picker for a new repository's or clone's parent folder. */
      pickParentFolder: publicProcedure.mutation(async ({ ctx }) => {
        const win = windowOf(ctx.windowId);
        const options = {
          title: 'Choose the parent folder',
          properties: ['openDirectory' as const, 'createDirectory' as const],
        };
        const result = win
          ? await dialog.showOpenDialog(win, options)
          : await dialog.showOpenDialog(options);
        const picked = result.canceled ? null : result.filePaths[0];
        return picked ? contractHome(picked) : null;
      }),
      /** A new repository's or clone's folder, checked while typing (spec §6.1). */
      checkNewFolder: publicProcedure
        .input(
          z.object({
            profileId: IdSchema,
            parent: z.string().min(1).max(4096),
            name: z.string().max(1000),
          }),
        )
        .mutation(({ input }) =>
          projects.checkNewFolder(input.profileId, input.parent, input.name),
        ),
      /** New repository (spec §6.1): makes it, then adds it. */
      create: publicProcedure
        .input(
          z.object({
            profileId: IdSchema,
            parent: z.string().min(1).max(4096),
            name: z.string().min(1).max(1000),
            readme: z.boolean(),
            gitignore: z.boolean(),
            worktreeRoot: z.string().min(1).nullable(),
          }),
        )
        .mutation(({ input }) => projects.create(input)),
      /**
       * Clone from URL (spec §6.1): `git clone` in a visible terminal with the
       * profile's environment. The dialog adds the clone once it exits with 0.
       */
      clone: publicProcedure
        .input(
          z.object({
            profileId: IdSchema,
            url: z.string().trim().min(1).max(4096),
            parent: z.string().min(1).max(4096),
            name: z.string().min(1).max(1000),
          }),
        )
        .mutation(async ({ input }) => {
          const { target, problem } = await projects.checkNewFolder(
            input.profileId,
            input.parent,
            input.name,
          );
          if (problem) throw new Error(problem);
          const session = await terminals.cloneSession(input.profileId, input.url, target);
          return { session, target };
        }),
      /** Adds a finished clone, with its remote's default branch as base. */
      addClone: publicProcedure
        .input(
          z.object({
            profileId: IdSchema,
            path: z.string().min(1).max(4096),
            worktreeRoot: z.string().min(1).nullable(),
          }),
        )
        .mutation(({ input }) =>
          projects.addClone(input.profileId, input.path, input.worktreeRoot),
        ),
      /** The repository's remotes, for Remote › Change… (spec §6.10). */
      remotes: publicProcedure
        .input(projectId)
        .query(({ input }) => projects.remotes(input.projectId)),
      setRemote: publicProcedure
        .input(projectId.extend({ remote: z.string().min(1).max(250).nullable() }))
        .mutation(({ input }) => projects.setRemote(input.projectId, input.remote)),
      /** A project without a remote took `origin` (spec §6.10), for the notice. */
      remoteFound: publicProcedure.subscription(({ signal }) =>
        fromListener<RemoteFound>((listener) => remoteWatch.onFound(listener), signal),
      ),
      /** Native folder picker for a project's worktree folder; null when cancelled. */
      pickWorktreeFolder: publicProcedure.mutation(async ({ ctx }) => {
        const win = windowOf(ctx.windowId);
        const options = {
          title: 'Choose the folder for worktrees',
          properties: ['openDirectory' as const, 'createDirectory' as const],
        };
        const result = win
          ? await dialog.showOpenDialog(win, options)
          : await dialog.showOpenDialog(options);
        const picked = result.canceled ? null : result.filePaths[0];
        // Shown as ~/… like the paths in config.json.
        return picked ? contractHome(picked) : null;
      }),
      /** The project's own worktree folder, or null for the default; new workspaces only. */
      setWorktreeRoot: publicProcedure
        .input(projectId.extend({ worktreeRoot: z.string().min(1).nullable() }))
        .mutation(({ input }) => projects.setWorktreeRoot(input.projectId, input.worktreeRoot)),
      /** What removing the project would delete or stop (spec §14.3). */
      removalCheck: publicProcedure
        .input(projectId)
        .query(({ input }) => workspaces.projectRemovalCheck(input.projectId)),
      /**
       * Removes the project from the app (spec §14.3): stops its sessions,
       * deletes the confirmed workspaces with their worktrees, removes the
       * emptied worktree folder. The main checkout is never touched.
       */
      remove: publicProcedure
        .input(
          projectId.extend({
            workspaces: z
              .array(
                deleteChoice.extend({
                  workspaceId: z.string().min(1).max(100),
                  repos: z
                    .array(deleteChoice.extend({ projectId: IdSchema }))
                    .max(50)
                    .optional(),
                }),
              )
              .max(500),
            /** Other projects' workspaces it is linked into: only its worktree there goes. */
            linked: z
              .array(deleteChoice.extend({ workspaceId: z.string().min(1).max(100) }))
              .max(500)
              .optional(),
          }),
        )
        .mutation(async ({ input }) => {
          const result = await workspaces.deleteProjectWorkspaces(
            input.projectId,
            input.workspaces,
            input.linked,
          );
          projects.remove(input.projectId);
          return result;
        }),
      /** What sets up its workspaces, read from the main checkout (spec §8.3). */
      setup: publicProcedure
        .input(projectId)
        .query(({ input }) => workspaces.projectSetup(input.projectId)),
      /** Setup and teardown commands kept in the app; null clears them. */
      setSetup: publicProcedure
        .input(projectId.extend({ setup: SetupSettingsSchema.nullable() }))
        .mutation(({ input }) => projects.setSetup(input.projectId, input.setup)),
    }),

    workspaces: router({
      /**
       * Workspaces that haven't been deleted, oldest first, with their
       * workflow status; Awaiting approval at a gate (spec §13.5).
       */
      list: publicProcedure.query(() => workspaceRecords.list().map((w) => workflow.decorate(w))),
      changes: publicProcedure.subscription(({ signal }) =>
        fromListener((listener) => {
          const offRecords = workspaceRecords.onChange(() => listener(true));
          const offWorkflow = workflow.onChange(() => listener(true));
          return () => {
            offRecords();
            offWorkflow();
          };
        }, signal),
      ),
      /**
       * Home's quick reply (spec §6.7): types the text into the workspace's
       * Claude, as Continue does, after the same checks as the card: never
       * on a permission request or over a draft, never on an exited Claude.
       */
      quickReply: publicProcedure
        .input(z.object({ workspaceId: IdSchema, text: z.string().trim().min(1).max(20_000) }))
        .mutation(async ({ input }) => {
          const record = workspaceRecords.get(input.workspaceId);
          if (!record) throw new Error('This workspace no longer exists');
          const w = workflow.decorate(record);
          const claude =
            host
              .list()
              .find(
                (s) => s.workspaceId === w.id && s.kind === 'claude' && s.status !== 'exited',
              ) ?? null;
          // The card's column: what is left to ship decides only between two that both offer it.
          const offer = quickReply(w, boardColumn(w, null), {
            claude,
            draft: claude ? suspend.hasDraft(claude.id) : false,
          });
          if (offer !== 'field') throw new Error(QUICK_REPLY_REFUSAL[offer]);
          await terminals.sendToClaude(w.id, input.text);
        }),
      /** The project's git worktrees no workspace uses (spec §13.6). */
      otherWorktrees: publicProcedure
        .input(projectId)
        .query(({ input }) => workspaces.otherWorktrees(input.projectId)),
      /** Open as workspace (spec §13.6). */
      adopt: publicProcedure
        .input(
          projectId.extend({
            worktreePath: z.string().min(1).max(4096),
            taskId: z.string().max(200).nullable(),
            title: z.string().max(500),
            baseBranch: z.string().max(250),
            runSetup: z.boolean(),
          }),
        )
        .mutation(({ input }) => workspaces.adopt(input)),
      /** Worktrees that appeared since launch and aren't workspaces, for the notice. */
      newWorktrees: publicProcedure.subscription(({ signal }) =>
        fromListener<NewWorktree>((listener) => worktreeNotices.onNew(listener), signal),
      ),
      /** Repositories linked with `<slug> link`, for the notice (spec §21.9). */
      linkedFromCli: publicProcedure.subscription(({ signal }) =>
        fromListener<CliLinkEvent>((listener) => cliLink.onLinked(listener), signal),
      ),
      /**
       * Why a branch name can't be used, or null, and a name to use instead
       * (local checks; Create also asks the remote).
       */
      branchCheck: publicProcedure
        .input(
          projectId.extend({
            branch: z.string(),
            linkedProjectIds: z.array(IdSchema).max(50).optional(),
          }),
        )
        .query(({ input }) =>
          workspaces.branchCheck(input.projectId, input.branch, input.linkedProjectIds),
        ),
      baseBranches: publicProcedure
        .input(projectId)
        .query(({ input }) => workspaces.baseBranches(input.projectId)),
      /** New workspace asks the remotes early, for Create to reuse (spec §7.3). */
      prepareRemotes: publicProcedure
        .input(
          projectId.extend({
            linkedProjectIds: z.array(IdSchema).max(50),
            baseBranch: z.string().max(250),
          }),
        )
        .mutation(({ input }) =>
          workspaces.prepareRemotes(input.projectId, input.linkedProjectIds, input.baseBranch),
        ),
      create: publicProcedure
        .input(
          projectId.extend({
            taskId: z.string().max(200).nullable(),
            title: z.string().max(500),
            branch: z.string().min(1).max(250),
            baseBranch: z.string().min(1).max(250),
            runSetup: z.boolean().optional(),
            /** Other projects of the profile it also spans (spec §21.2). */
            linkedProjectIds: z.array(IdSchema).max(50).optional(),
            /** Let Claude add others when needed (spec §21.9). */
            claudeMayLink: z.boolean().optional(),
            /** The branch came from the task: a taken one gets the next free name (spec §7.1). */
            uniqueBranch: z.boolean().optional(),
          }),
        )
        .mutation(({ input }) => workspaces.create(input)),
      /** Retry after a failed setup: setup again, then Claude (spec §7.3). */
      runSetup: publicProcedure
        .input(workspaceId)
        .mutation(({ input }) => workspaces.runSetup(input.workspaceId)),
      /** Stops a running Claude and starts it again with --resume (spec §13.3, §21.4). */
      restartClaude: publicProcedure
        .input(workspaceId)
        .mutation(({ input }) => workspaces.restartClaude(input.workspaceId)),
      startClaude: publicProcedure
        .input(workspaceId)
        .mutation(({ input }) => workspaces.startClaude(input.workspaceId)),
      /** Keep running (spec §9.8): its Claude is never suspended when idle. */
      setKeepRunning: publicProcedure
        .input(workspaceId.extend({ on: z.boolean() }))
        .mutation(({ input }) => workspaceRecords.setKeepRunning(input.workspaceId, input.on)),
      /** Let Claude add repositories (spec §21.9): from its next SessionStart. */
      setClaudeMayLink: publicProcedure
        .input(workspaceId.extend({ on: z.boolean() }))
        .mutation(({ input }) => workspaceRecords.setClaudeMayLink(input.workspaceId, input.on)),
      /** A shell in one of its worktrees (New shell in…). */
      shell: publicProcedure
        .input(workspaceId.extend(repo))
        .mutation(({ input }) => workspaces.shell(input.workspaceId, input.projectId ?? null)),
      /** Reveal in Finder for a repository's worktree (spec §21.4), only the workspace's own. */
      revealWorktree: publicProcedure.input(workspaceId.extend(repo)).mutation(({ input }) => {
        const workspace = workspaceRecords.get(input.workspaceId);
        const found = workspace ? workspaceRepo(workspace, input.projectId ?? null) : null;
        if (!found) throw new Error('That repository is not in this workspace');
        shell.showItemInFolder(found.worktreePath);
      }),
      /** Link another repository… (spec §21.4). */
      link: publicProcedure
        .input(workspaceId.extend({ projectId: IdSchema, restart: z.boolean() }))
        .mutation(({ input }) =>
          workspaces.link(input.workspaceId, input.projectId, { restart: input.restart }),
        ),
      unlinkCheck: publicProcedure
        .input(workspaceId.extend({ projectId: IdSchema }))
        .query(({ input }) => workspaces.unlinkCheck(input.workspaceId, input.projectId)),
      unlink: publicProcedure
        .input(workspaceId.extend({ projectId: IdSchema }).merge(deleteChoice))
        .mutation(({ input }) => workspaces.unlink(input.workspaceId, input.projectId, input)),
      deleteCheck: publicProcedure
        .input(workspaceId)
        .query(({ input }) => workspaces.deleteCheck(input.workspaceId)),
      /** `force` and `deleteBranch` for every repository, unless `repos` says otherwise. */
      delete: publicProcedure
        .input(
          workspaceId.merge(deleteChoice).extend({
            repos: z
              .array(deleteChoice.extend({ projectId: IdSchema }))
              .max(50)
              .optional(),
          }),
        )
        .mutation(async ({ input }) => {
          const result = await workspaces.delete(input.workspaceId, input);
          editors.forget(input.workspaceId);
          return result;
        }),
    }),

    /** Open in editor (spec §6.13): the editor per project, else the profile's. */
    editor: router({
      /** The known editors installed for the profile, for the settings. */
      detect: publicProcedure
        .input(z.object({ profileId: IdSchema }))
        .query(({ input }) => editors.detect(input.profileId)),
      /** The profile's editor; null clears it. */
      setProfileEditor: publicProcedure
        .input(z.object({ profileId: IdSchema, editor: EditorSchema.nullable() }))
        .mutation(({ input }) => editors.setProfileEditor(input.profileId, input.editor)),
      /** A project's own editor; null uses the profile's. */
      setProjectEditor: publicProcedure
        .input(projectId.extend({ editor: EditorSchema.nullable() }))
        .mutation(({ input }) => editors.setProjectEditor(input.projectId, input.editor)),
      /** A repository's worktree, or a file of it at a line (relative to the worktree). */
      openWorktree: publicProcedure
        .input(
          workspaceId.extend({
            ...repo,
            file: z.string().min(1).max(4000).optional(),
            line: z.number().int().min(1).optional(),
          }),
        )
        .mutation(async ({ input }) => {
          const workspace = workspaceRecords.get(input.workspaceId);
          const found = workspace ? workspaceRepo(workspace, input.projectId ?? null) : null;
          if (!workspace || !found) throw new Error('That repository is not in this workspace');
          const root = found.worktreePath;
          if (!input.file) {
            return editors.open(workspace.profileId, found.projectId, {
              kind: 'folder',
              path: root,
            });
          }
          const file = path.resolve(root, input.file);
          if (path.relative(root, file).startsWith('..'))
            throw new Error('Not a file of the worktree');
          return editors.open(workspace.profileId, found.projectId, {
            kind: 'file',
            file,
            line: input.line ?? 1,
          });
        }),
      /** A project's main checkout. */
      openProject: publicProcedure.input(projectId).mutation(({ input }) => {
        const project = config.require().projects.find((p) => p.id === input.projectId);
        if (!project) throw new Error(`Unknown project "${input.projectId}"`);
        return editors.open(project.profileId, project.id, {
          kind: 'folder',
          path: expandHome(project.repoPath),
        });
      }),
      /** Open all's checklist: each repository with the editor it would open in. */
      openAllPlan: publicProcedure.input(workspaceId).query(({ input }) => {
        const workspace = workspaceRecords.get(input.workspaceId);
        if (!workspace) throw new Error('Unknown workspace');
        return workspace.repos.map((r) => {
          const project = config.require().projects.find((p) => p.id === r.projectId);
          let editor: Editor | null = null;
          try {
            editor = editors.editorOf(workspace.profileId, r.projectId).editor;
          } catch {
            editor = null;
          }
          return { projectId: r.projectId, name: project?.name ?? r.projectId, editor };
        });
      }),
      /** Open all: the chosen repositories, each in its editor (VS Code/Cursor ones in one window). */
      openAll: publicProcedure
        .input(workspaceId.extend({ projectIds: z.array(IdSchema).min(1).max(100) }))
        .mutation(({ input }) => {
          const workspace = workspaceRecords.get(input.workspaceId);
          if (!workspace) throw new Error('Unknown workspace');
          const names = new Map(config.require().projects.map((p) => [p.id, p.name]));
          return editors.openAll(
            workspace,
            workspace.repos
              .filter((r) => input.projectIds.includes(r.projectId))
              .map((r) => ({
                projectId: r.projectId,
                worktreePath: r.worktreePath,
                name: names.get(r.projectId) ?? r.projectId,
              })),
          );
        }),
    }),

    /** The Changes panel and finishing (spec §6.4, §14.1, §12.3). */
    changes: router({
      list: publicProcedure
        .input(workspaceId.extend(repo))
        .query(({ input }) => finish.changes(input.workspaceId, input.projectId ?? null)),
      diff: publicProcedure
        .input(
          workspaceId.extend({
            ...repo,
            group: z.enum(['committed', 'uncommitted']),
            path: z.string().min(1).max(4096),
            oldPath: z.string().min(1).max(4096).nullable(),
          }),
        )
        .query(({ input }) =>
          finish.diff(input.workspaceId, input.group, input, input.projectId ?? null),
        ),
      state: publicProcedure
        .input(workspaceId.extend(repo))
        .query(({ input }) => finish.state(input.workspaceId, input.projectId ?? null)),
      commit: publicProcedure
        .input(workspaceId.extend({ ...repo, message: z.string().max(20_000) }))
        .mutation(({ input }) =>
          finish.commit(input.workspaceId, input.message, input.projectId ?? null),
        ),
      askClaudeToCommit: publicProcedure
        .input(workspaceId.extend(repo))
        .mutation(({ input }) =>
          finish.askClaudeToCommit(input.workspaceId, input.projectId ?? null),
        ),
      push: publicProcedure
        .input(workspaceId.extend(repo))
        .mutation(({ input }) => finish.push(input.workspaceId, input.projectId ?? null)),
      createPr: publicProcedure
        .input(workspaceId.extend(repo))
        .mutation(({ input }) => finish.createPr(input.workspaceId, input.projectId ?? null)),
      /**
       * Emits `changed` soon after files change in the workspace's worktrees,
       * for the repositories given (spec §6.4); only the shown workspace
       * subscribes. `limit` once when the OS has no watches left (§6.4).
       */
      watch: publicProcedure
        .input(workspaceId.extend({ projectIds: z.array(IdSchema).max(50) }))
        .subscription(({ input, signal }) =>
          fromListener<'changed' | 'limit'>((listener) => {
            const workspace = workspaceRecords.get(input.workspaceId);
            const worktrees = (workspace?.repos ?? [])
              .filter((r) => input.projectIds.includes(r.projectId))
              .map((r) => r.worktreePath);
            return watchWorktrees(
              worktrees,
              () => listener('changed'),
              () => listener('limit'),
            );
          }, signal),
        ),
      /** Checks every repository's PR (spec §21.5). */
      refreshPr: publicProcedure
        .input(workspaceId)
        .mutation(({ input }) => finish.refreshPr(input.workspaceId)),
    }),

    /** Control of terminal sessions. Their data flows over MessagePorts (see sessions/electron.ts). */
    sessions: router({
      list: publicProcedure.query(() => host.list()),
      changes: publicProcedure.subscription(({ signal }) =>
        fromListener((listener) => host.onChange(() => listener(true)), signal),
      ),
      /** The profile's home shell, started on first use (spec §6.7). */
      homeShell: publicProcedure
        .input(z.object({ profileId: IdSchema }))
        .mutation(({ input }) => terminals.homeShell(input.profileId)),
      restartHomeShell: publicProcedure
        .input(z.object({ profileId: IdSchema }))
        .mutation(({ input }) => terminals.restartHomeShell(input.profileId)),
      /** A shell in the project's main checkout; `reuse` returns a running one if any. */
      projectShell: publicProcedure
        .input(z.object({ projectId: IdSchema, reuse: z.boolean() }))
        .mutation(({ input }) => terminals.projectShell(input.projectId, input)),
      /** Quick action "Start Claude here" (spec §6.7). */
      startClaudeInHome: publicProcedure
        .input(z.object({ profileId: IdSchema }))
        .mutation(({ input }) => terminals.startClaudeInHome(input.profileId)),
      /** Project action "Start Claude here": Claude in the main checkout, as its own session. */
      startClaudeInProject: publicProcedure
        .input(projectId)
        .mutation(({ input }) => terminals.startClaudeInProject(input.projectId)),
      /** Each running workspace Claude's idle clock: why not suspended, or when (spec §9.8). */
      suspendClocks: publicProcedure.query(() => suspend.clocks()),
      /** Workspaces whose Claude's prompt holds a draft: no quick reply there (spec §6.7). */
      drafts: publicProcedure.query(() => suspend.drafts()),
      /** The projects whose main-checkout Claude is kept running (spec §9.8). */
      keptMainCheckouts: publicProcedure.query(() => workspaceRecords.keptMainCheckouts()),
      setMainCheckoutKept: publicProcedure
        .input(projectId.extend({ on: z.boolean() }))
        .mutation(({ input }) => workspaceRecords.setMainCheckoutKept(input.projectId, input.on)),
      /** Sends the calling window a MessagePort for the session, tagged with `attachId`. */
      attach: publicProcedure
        .input(sessionId.extend({ attachId: z.string().min(1) }))
        .mutation(({ input, ctx }) => {
          const contents = webContents.fromId(ctx.windowId);
          if (!contents) throw new Error('The window is gone');
          attachToWindow(host, contents, input);
        }),
      resize: publicProcedure
        .input(
          sessionId.extend({
            cols: z.number().int().min(1).max(1000),
            rows: z.number().int().min(1).max(1000),
          }),
        )
        .mutation(({ input }) => host.resize(input.sessionId, input.cols, input.rows)),
      stop: publicProcedure.input(sessionId).mutation(({ input }) => host.stop(input.sessionId)),
      close: publicProcedure.input(sessionId).mutation(({ input }) => host.remove(input.sessionId)),
    }),

    /** New versions (spec §15.7). */
    updates: router({
      /** The first-start question and the notice, with updating inside the app. */
      state: publicProcedure.query(() => ({
        ...updates.service.state(),
        ...updates.installer.view(),
      })),
      changes: publicProcedure.subscription(({ signal }) =>
        fromListener((listener) => {
          const offService = updates.service.onChange(() => listener(true));
          const offInstaller = updates.installer.onChange(() => listener(true));
          return () => {
            offService();
            offInstaller();
          };
        }, signal),
      ),
      /** Check for updates or No thanks. */
      answer: publicProcedure
        .input(z.object({ check: z.boolean() }))
        .mutation(({ input }) => updates.service.answer(input.check)),
      skip: publicProcedure.mutation(() => updates.service.skip()),
      dismiss: publicProcedure.mutation(() => updates.service.dismiss()),
      /** Update: downloads, checks and stages the offered version; progress comes through changes. */
      install: publicProcedure.mutation(() => {
        const release = updates.service.state().available;
        if (!release) throw new Error('There is no newer version to install');
        void updates.installer.install(release);
      }),
      cancel: publicProcedure.mutation(() => updates.installer.cancel()),
      later: publicProcedure.mutation(() => updates.installer.later()),
      restart: publicProcedure.mutation(() => updates.installer.restart()),
      dismissFailure: publicProcedure.mutation(() => updates.installer.dismissFailure()),
      /** Update in terminal: opens the user's terminal with the install command, or says what to run. */
      inTerminal: publicProcedure.mutation(() => {
        // After a failed replacement the notice offers it without a check having run.
        const failed = updates.installer.view().failure;
        const release =
          updates.service.state().available ??
          (failed ? { version: failed.version, url: '', assets: {} } : null);
        if (!release) throw new Error('There is no newer version to install');
        return updates.inTerminal(release);
      }),
    }),

    /** Work the app's stop interrupted (spec §9.7). */
    unfinished: router({
      /** The run of continue prompts (the notice) and the start's overview. */
      state: publicProcedure.query(() => unfinished.state()),
      changes: publicProcedure.subscription(({ signal }) =>
        fromListener((listener) => unfinished.onChange(() => listener(true)), signal),
      ),
      /** Continue selected, and the bar's Continue: one after another, a few seconds apart. */
      continue: publicProcedure
        .input(z.object({ workspaceIds: z.array(z.string().min(1).max(100)).max(500) }))
        .mutation(({ input }) => unfinished.continue(input.workspaceIds)),
      /** Stop in the notice: the prompts not yet sent are cancelled. */
      stop: publicProcedure.mutation(() => unfinished.stop()),
      /** Dismiss in the bar: the marker goes. */
      dismiss: publicProcedure
        .input(workspaceId)
        .mutation(({ input }) => unfinished.dismiss(input.workspaceId)),
      /** The overview was answered; it isn't shown again in this run. */
      closeOverview: publicProcedure.mutation(() => unfinished.closeOverview()),
    }),

    /** Workspace states and their alerts (spec §10). */
    status: router({
      /** Alerts as they happen; the renderer plays their sounds (spec §10.3). */
      alerts: publicProcedure.subscription(({ signal }) =>
        fromListener<Alert>((listener) => status.onAlert(listener), signal),
      ),
      /** UserPromptSubmit and Stop per workspace, for the conversation aids (spec §6.8). */
      conversation: publicProcedure.subscription(({ signal }) =>
        fromListener<ConversationEvent>((listener) => status.onConversation(listener), signal),
      ),
      /** A clicked notification: the renderer opens that workspace's Claude tab. */
      openRequests: publicProcedure.subscription(({ signal }) =>
        fromListener<string>((listener) => statusPlatform.onOpen(listener), signal),
      ),
      /** A click that waited for a page, as a window opened for it; asked once at start. */
      takeOpenRequest: publicProcedure.mutation(() => statusPlatform.takeOpenRequest()),
      /** What the calling window shows, for "unless that Claude tab is visible" (spec §10.3). */
      setVisible: publicProcedure
        .input(
          z.object({
            workspaceId: z.string().min(1).max(100).nullable(),
            claudeTab: z.boolean(),
            // The shown terminal session, for a main checkout's Claude (spec §9.8).
            sessionId: z.string().min(1).max(100).nullable().optional(),
          }),
        )
        .mutation(({ input, ctx }) => statusPlatform.setVisible(ctx.windowId, input)),
      /** Viewing a workspace clears its unread marker (spec §10.2). */
      markRead: publicProcedure
        .input(workspaceId)
        .mutation(({ input }) => workspaceRecords.markRead(input.workspaceId)),
    }),

    /**
     * The Responses panel and ⌥C (spec §6.8): responses read from the
     * workspace's session transcript, read-only (D12). Copying goes through
     * the main-process clipboard.
     */
    conversation: router({
      responses: publicProcedure.input(workspaceId).query(({ input }) => {
        const file = workspaceRecords.transcriptPath(input.workspaceId);
        return (file ? readResponses(file) : []).map((r, index) => ({ index, ...r }));
      }),
      /** When the transcript changes (new text, /clear, a resume), while the panel is open. */
      changes: publicProcedure.input(workspaceId).subscription(({ input, signal }) =>
        fromListener<true>(
          (listener) =>
            watchTranscript(
              () => workspaceRecords.transcriptPath(input.workspaceId),
              () => listener(true),
            ),
          signal,
        ),
      ),
      /** Copies entry `index`, or the latest one when null (⌥C), all its parts. */
      copy: publicProcedure
        .input(workspaceId.extend({ index: z.number().int().min(0).nullable() }))
        .mutation(({ input }) => {
          const file = workspaceRecords.transcriptPath(input.workspaceId);
          const responses = file ? readResponses(file) : [];
          const response = input.index === null ? responses.at(-1) : responses[input.index];
          if (!response) throw new Error('There is no response to copy yet');
          if (!response.text) throw new Error('The last prompt has no text response');
          clipboard.writeText(response.text);
          return { length: response.text.length };
        }),
    }),

    /** The command line tool for other terminals (spec §7.5). */
    cli: router({
      info: publicProcedure.query(async () => {
        const login = await env.login();
        return {
          ...cliInstallInfo(login.env.HOME || app.getPath('home'), login.env.PATH ?? '', helper),
          available: helper !== null,
        };
      }),
      /** Writes the launcher to ~/.local/bin, after the user confirmed. */
      install: publicProcedure.mutation(async () => {
        if (!helper) throw new Error('The helper is missing from this build');
        const login = await env.login();
        return installCli(login.env.HOME || app.getPath('home'), login.env.PATH ?? '', helper);
      }),
    }),

    /** Plan usage per profile, from the status line (spec §11). */
    usage: router({
      all: publicProcedure.query(() => usage.all()),
      changes: publicProcedure.subscription(({ signal }) =>
        fromListener<string>((listener) => usage.onChange(listener), signal),
      ),
    }),

    /** Memory of Claude sessions and the app (spec §6.14), measured while the window is visible. */
    memory: router({
      current: publicProcedure.query(() => memory.current()),
      changes: publicProcedure.subscription(({ signal }) =>
        fromListener<void>((listener) => memory.onChange(listener), signal),
      ),
    }),

    ui: router({
      /** Menu items that open a dialog in the window. */
      menuRequests: publicProcedure.subscription(({ signal }) =>
        fromListener<MenuRequest>((listener) => {
          menuRequests.on('request', listener);
          return () => menuRequests.off('request', listener);
        }, signal),
      ),
      /** A native context menu at the pointer; resolves with the chosen item's id or null. */
      contextMenu: publicProcedure
        .input(
          z.object({
            items: z
              .array(
                z.object({
                  id: z.string().min(1),
                  label: z.string().min(1),
                  enabled: z.boolean().optional(),
                  /** A checkbox item, ticked or not (Keep Claude Running, spec §9.8). */
                  checked: z.boolean().optional(),
                }),
              )
              .min(1)
              .max(20),
          }),
        )
        .mutation(({ input, ctx }) => showContextMenu(windowOf(ctx.windowId), input.items)),
      /** The window changed a remembered preference in its local storage (spec §5). */
      remembered: publicProcedure.mutation(() => windowStateChanged()),
    }),

    /** The renderer has no clipboard permission; terminals copy and paste through here. */
    clipboard: router({
      readText: publicProcedure.mutation(() => clipboard.readText()),
      writeText: publicProcedure
        .input(z.object({ text: z.string() }))
        .mutation(({ input }) => clipboard.writeText(input.text)),
    }),

    shell: router({
      /** Opens http and https links in the user's browser; anything else is ignored. */
      openExternal: publicProcedure
        .input(z.object({ url: z.string() }))
        .mutation(({ input }) => openExternalSafe(input.url)),
      /** The issue forms in the browser (spec §6.12); nothing is sent. */
      reportBug: publicProcedure.mutation(() => feedback.reportBug()),
      requestFeature: publicProcedure.mutation(() => feedback.requestFeature()),
    }),
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;
