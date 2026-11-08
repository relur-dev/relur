import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { envVar } from '@shared/brand';
import type { Profile, Project } from '@shared/schemas';
import { shellQuote } from '@shared/shell';
import { NEW_CONVERSATION_NOTE } from '@shared/suspend';
import type { SessionInfo, SessionKind } from '@shared/terminal-protocol';
import { linkedRepos, type Workspace, workspaceRepo } from '@shared/workspaces';
import { app } from 'electron';
import type { ConfigStore } from '../config/store';
import { buildProcessEnv } from '../env/build-env';
import { defaultShell } from '../env/login-shell';
import type { EnvService } from '../env/service';
import { resolveExecutable } from '../env/which';
import { expandHome } from '../paths';
import type { SessionHost } from '../sessions/host';
import { terminalEnv } from '../sessions/terminal-env';
import type { LookupContext } from '../workflow/lookup';

/**
 * Arguments and variables for a workspace's Claude (spec §9.1, §21.3): the
 * settings file, the conversation to resume (or the id of a new one), and
 * `--add-dir` per linked worktree. With linked repositories, their CLAUDE.md
 * and rules load too.
 */
export function workspaceClaudeLaunch(
  workspace: Pick<Workspace, 'claudeSessionId' | 'repos'>,
  settingsFile: string,
  { resume = false, sessionId = null }: { resume?: boolean; sessionId?: string | null } = {},
): { args: string[]; env: Record<string, string> } {
  // Spec §9.4: the conversation by its session id, else the worktree's last
  // one; a new conversation gets the id the app chose.
  const resumeArgs = !resume
    ? sessionId
      ? ['--session-id', sessionId]
      : []
    : workspace.claudeSessionId
      ? ['--resume', workspace.claudeSessionId]
      : ['--continue'];
  const linked = linkedRepos(workspace);
  return {
    args: [
      '--settings',
      settingsFile,
      ...resumeArgs,
      ...linked.flatMap((r) => ['--add-dir', r.worktreePath]),
    ],
    env: linked.length > 0 ? { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1' } : {},
  };
}

/**
 * The projects whose skill sources a session gets (spec §13.3): a workspace's
 * repositories, a project's main checkout, or null outside both (home).
 */
export function sessionProjects(
  project: Pick<Project, 'id'> | undefined,
  workspace: Pick<Workspace, 'repos'> | undefined,
): string[] | null {
  if (workspace) return workspace.repos.map((r) => r.projectId);
  return project ? [project.id] : null;
}

/** Quick exits after which the profile's setup is checked again. */
const EARLY_EXIT_MS = 5000;

/**
 * What Claude Code prints, and exits with 1, when there is no conversation to
 * resume: `--resume <id>` or `--continue` (checked live with 2.1.318).
 */
const NO_CONVERSATION = /No conversation found (with session ID|to continue)/;

/**
 * Claude's arguments with `--resume <id>` or `--continue` replaced by a new
 * conversation's `--session-id`; null when they resume nothing.
 */
export function newConversationArgs(args: readonly string[]): string[] | null {
  const at = args.findIndex((a) => a === '--resume' || a === '--continue');
  if (at === -1) return null;
  const taken = args[at] === '--resume' ? 2 : 1;
  return [...args.slice(0, at), '--session-id', randomUUID(), ...args.slice(at + taken)];
}

/** Whether Claude may start in a profile: its setup check passed (spec §6.11). */
export interface ClaudeGate {
  /** Why Claude can't start in the profile, or null; waits for a running check. */
  refusal(profileId: string): Promise<string | null>;
  /** Starting Claude failed or it exited right away: the setup may have changed. */
  startFailed(profileId: string): void;
}

/**
 * The skill sources' plugin folders for a session (spec §13.3): for the
 * given projects, or for null the profile's all-projects sources.
 */
export interface SkillDirs {
  pluginDirs(
    profileId: string,
    projectIds: string[] | null,
  ): Promise<{ dirs: string[]; fingerprint: string }>;
  /** A workspace's Claude started with these skills. */
  claudeStarted(workspaceId: string, fingerprint: string): void;
}

/** The variable that loads plugins into a `claude` typed in a shell (spec §13.3). */
export const PLUGIN_DIRS_VAR = 'CLAUDE_CODE_PLUGIN_DIRS';

/** What the app adds to every session: the bridge (spec §10.1) and folders put first on PATH. */
export interface SessionAdditions {
  env: Record<string, string>;
  pathDirs: string[];
}

/** Starts terminal sessions with the right profile environment (rule R3). */
export class TerminalService {
  /** Set once the setup check exists; without it Claude always starts. */
  claudeGate: ClaudeGate | null = null;
  /** Set once the bridge runs. */
  additions: SessionAdditions = { env: {}, pathDirs: [] };
  /** Set once skill sources are known; without it no plugins are loaded. */
  skills: SkillDirs | null = null;
  /** The `--settings` file for a profile's Claude (spec §9.3); set once it is written. */
  claudeSettings: ((profileId: string) => string) | null = null;
  /**
   * Set once suspension exists (spec §9.8): resumes a suspended Claude, or
   * waits for one that resumes, until it is ready for typed text.
   */
  wake: ((session: SessionInfo) => Promise<void>) | null = null;

  /**
   * Claude Code's session id of each main-checkout Claude (spec §9.8), by the
   * app's session id: chosen at its start, then followed from hooks.
   */
  private readonly mainClaude = new Map<string, string>();

  /** Home shell session per profile id (spec §6.7). */
  private readonly homeShells = new Map<string, string>();
  private readonly startingHomeShells = new Map<string, Promise<SessionInfo>>();

  constructor(
    private readonly config: ConfigStore,
    private readonly env: EnvService,
    readonly host: SessionHost,
  ) {}

  /** The profile's home shell, started if it doesn't exist yet. Never starts a second one. */
  homeShell(profileId: string): Promise<SessionInfo> {
    const existing = this.homeShells.get(profileId);
    if (existing && this.host.has(existing)) return Promise.resolve(this.host.get(existing));

    let starting = this.startingHomeShells.get(profileId);
    if (!starting) {
      starting = (async () => {
        const profile = this.env.profile(profileId);
        const login = await this.env.login();
        const session = await this.spawnShell({
          kind: 'home',
          title: 'Home',
          profile,
          cwd: login.env.HOME || os.homedir(),
        });
        this.homeShells.set(profileId, session.id);
        return session;
      })().finally(() => this.startingHomeShells.delete(profileId));
      this.startingHomeShells.set(profileId, starting);
    }
    return starting;
  }

  /**
   * Types a prompt into the workspace's Claude, as a paste followed by Enter,
   * so a long prompt arrives as one message.
   */
  async sendToClaude(workspaceId: string, prompt: string): Promise<void> {
    const find = () =>
      this.host
        .list()
        .find((s) => s.workspaceId === workspaceId && s.kind === 'claude' && s.status !== 'exited');
    let claude = find();
    // A suspended Claude resumes first; the text waits until it is ready (spec §9.8).
    if (claude && (claude.status === 'suspended' || claude.resuming) && this.wake) {
      await this.wake(claude);
      claude = find();
    }
    if (claude?.status !== 'running') {
      throw new Error("Claude isn't running in this workspace; start it first");
    }
    this.host.write(claude.id, `\x1b[200~${prompt}\x1b[201~`);
    setTimeout(() => {
      if (this.host.has(claude.id)) this.host.write(claude.id, '\r');
    }, 200);
  }

  /**
   * Types keys into the workspace's running Claude as they are, not as a
   * paste: one digit picks an option of Claude's question menu (spec §6.7).
   * Never resumes: a suspended Claude has no menu to answer.
   */
  pressInClaude(workspaceId: string, keys: string): void {
    const claude = this.host
      .list()
      .find((s) => s.workspaceId === workspaceId && s.kind === 'claude' && s.status !== 'exited');
    if (claude?.status !== 'running' || claude.resuming) {
      throw new Error("Claude isn't running in this workspace");
    }
    this.host.write(claude.id, keys);
  }

  /** Replaces an exited (or running) home shell with a new one. */
  async restartHomeShell(profileId: string): Promise<SessionInfo> {
    const existing = this.homeShells.get(profileId);
    if (existing) {
      this.homeShells.delete(profileId);
      await this.host.remove(existing);
    }
    return this.homeShell(profileId);
  }

  /**
   * Types the profile's Claude command into its home shell, as the user would
   * (spec §6.7: `claude` there uses the profile's account).
   */
  async startClaudeInHome(profileId: string): Promise<SessionInfo> {
    const profile = this.env.profile(profileId);
    const refusal = await this.claudeGate?.refusal(profileId);
    if (refusal) throw new Error(refusal);
    const session = await this.homeShell(profileId);
    if (session.status !== 'running') throw new Error('The home shell has exited');
    const words = [profile.claude.command, ...profile.claude.args].map(shellQuote);
    this.host.typeIntoShell(session.id, words.join(' '), 'The home terminal is busy');
    return session;
  }

  /**
   * "Start Claude here" in a project: Claude in the main checkout, with the
   * profile environment, as its own session (not in a workspace).
   */
  async startClaudeInProject(projectId: string): Promise<SessionInfo> {
    const project = this.project(projectId);
    // Hooks and status line as in a workspace, and a conversation id chosen
    // here, so it can be suspended and resumed (spec §9.8).
    const claudeId = randomUUID();
    const session = await this.spawnClaude({
      title: `${project.name} · claude`,
      profile: this.env.profile(project.profileId),
      project,
      cwd: expandHome(project.repoPath),
      args: [...this.settingsArgs(project.profileId), '--session-id', claudeId],
    });
    this.mainClaude.set(session.id, claudeId);
    return session;
  }

  /** A main-checkout Claude's conversation changed (a hook's session id, after /clear). */
  followMainClaude(sessionId: string, claudeId: string): void {
    if (this.mainClaude.has(sessionId)) this.mainClaude.set(sessionId, claudeId);
  }

  /**
   * Resumes a suspended main-checkout Claude (spec §9.8) in its session, with
   * its conversation, and `restore` (the permission mode and model it had).
   */
  async resumeClaudeInProject(sessionId: string, restore: string[] = []): Promise<SessionInfo> {
    const info = this.host.get(sessionId);
    if (info.status !== 'suspended' || !info.projectId || info.workspaceId) return info;
    const project = this.project(info.projectId);
    const claudeId = this.mainClaude.get(sessionId);
    return this.spawnClaude({
      title: info.title,
      profile: this.env.profile(project.profileId),
      project,
      cwd: expandHome(project.repoPath),
      args: [
        ...this.settingsArgs(project.profileId),
        ...(claudeId ? ['--resume', claudeId] : ['--continue']),
      ],
      into: sessionId,
      restore,
    });
  }

  private settingsArgs(profileId: string): string[] {
    const file = this.claudeSettings?.(profileId);
    return file ? ['--settings', file] : [];
  }

  /**
   * Claude in a workspace's worktree (spec §9.1): the generated settings file,
   * then the profile's own arguments, with the workspace environment (§9.2).
   */
  async startClaudeInWorkspace(
    workspace: Workspace,
    settingsFile: string,
    {
      resume = false,
      prompt = null,
      sessionId = null,
      into,
      restore,
      note,
    }: {
      resume?: boolean;
      prompt?: string | null;
      sessionId?: string | null;
      /** A suspended session to resume in, or an exited one to start again in (spec §9.8). */
      into?: string;
      /** Arguments that bring back what the session had: permission mode, model (spec §9.8). */
      restore?: string[];
      /** Shown above the terminal (SessionInfo.note). */
      note?: string | null;
    } = {},
  ): Promise<SessionInfo> {
    const launch = workspaceClaudeLaunch(workspace, settingsFile, { resume, sessionId });
    return this.spawnClaude({
      into,
      restore,
      note,
      title: `${workspace.name} · claude`,
      profile: this.env.profile(workspace.profileId),
      project: this.project(workspace.projectId),
      workspace,
      cwd: workspace.worktreePath,
      args: launch.args,
      extraEnv: launch.env,
      prompt,
    });
  }

  /**
   * One repository of a workspace (the main one for null): its project and
   * worktree. Its sessions carry that project's id (spec §21.1).
   */
  private repo(workspace: Workspace, projectId: string | null) {
    const repo = workspaceRepo(workspace, projectId);
    if (!repo) throw new Error(`${projectId} isn't part of this workspace`);
    return { project: this.project(repo.projectId), cwd: repo.worktreePath };
  }

  /** A shell in one of a workspace's worktrees, with the workspace environment. */
  workspaceShell(workspace: Workspace, projectId: string | null = null): Promise<SessionInfo> {
    const { project, cwd } = this.repo(workspace, projectId);
    return this.spawnShell({
      kind: 'shell',
      title: `${workspace.name} · ${project.name} shell`,
      profile: this.env.profile(workspace.profileId),
      project,
      workspace,
      cwd,
    });
  }

  /**
   * A Setup tab of a workspace (spec §8.3): `script` run by the user's shell
   * in one repository's worktree, with the workspace environment.
   */
  async workspaceSetup(
    workspace: Workspace,
    script: string,
    projectId: string | null = null,
  ): Promise<SessionInfo> {
    const { project, cwd } = this.repo(workspace, projectId);
    const profile = this.env.profile(workspace.profileId);
    const login = await this.env.login();
    return this.host.spawn({
      kind: 'setup',
      title: `${workspace.name} · ${project.name} setup`,
      command: defaultShell(login.env),
      args: ['-c', script],
      cwd,
      env: await this.processEnv(profile, project, workspace),
      profileId: profile.id,
      projectId: project.id,
      workspaceId: workspace.id,
    });
  }

  /**
   * The user's shell and a workspace's environment, for commands without a
   * terminal in one of its repositories (commit identity from that project).
   */
  async workspaceCommandEnv(
    workspace: Workspace,
    projectId: string | null = null,
  ): Promise<{ shell: string; env: Record<string, string> }> {
    const { project } = this.repo(workspace, projectId);
    const login = await this.env.login();
    const env = await this.processEnv(this.env.profile(workspace.profileId), project, workspace);
    return { shell: defaultShell(login.env), env };
  }

  /**
   * Where a task lookup runs (spec §13.7): the profile's environment and
   * Claude, its skill sources as `--plugin-dir`, in the project's repository
   * (home without a project).
   */
  async lookupContext(profileId: string, projectId: string | null): Promise<LookupContext> {
    const profile = this.env.profile(profileId);
    const project = projectId ? this.project(projectId) : undefined;
    const login = await this.env.login();
    const env = await this.processEnv(profile, project);
    delete env[PLUGIN_DIRS_VAR];
    const skills = await this.skills?.pluginDirs(profile.id, sessionProjects(project, undefined));
    return {
      shell: defaultShell(login.env),
      env,
      cwd: project ? expandHome(project.repoPath) : login.env.HOME || os.homedir(),
      claudeCommand: resolveExecutable(profile.claude.command, env),
      pluginDirs: skills?.dirs ?? [],
    };
  }

  /**
   * A shell in a project's main checkout. With `reuse`, a running one is
   * returned if there is one; otherwise a new one is started.
   */
  async projectShell(projectId: string, { reuse }: { reuse: boolean }): Promise<SessionInfo> {
    const project = this.project(projectId);
    if (reuse) {
      const open = this.host
        .list()
        .find(
          (s) =>
            s.kind === 'shell' &&
            s.projectId === projectId &&
            s.workspaceId === null &&
            s.status === 'running',
        );
      if (open) return open;
    }
    return this.spawnShell({
      kind: 'shell',
      title: `${project.name} · shell`,
      profile: this.env.profile(project.profileId),
      project,
      cwd: expandHome(project.repoPath),
    });
  }

  /**
   * An install or sign-in command of the setup check (spec §6.11), run by the
   * user's shell in a visible terminal, with the profile environment.
   */
  async setupSession(profileId: string, title: string, commandLine: string): Promise<SessionInfo> {
    const profile = this.env.profile(profileId);
    const login = await this.env.login();
    return this.host.spawn({
      kind: 'setup',
      title,
      command: defaultShell(login.env),
      args: ['-c', commandLine],
      cwd: login.env.HOME || os.homedir(),
      env: await this.processEnv(profile),
      profileId: profile.id,
    });
  }

  /**
   * `git clone` for Add project's Clone from URL (spec §6.1), in a visible
   * terminal with the profile environment, so SSH passphrases and sign-in
   * prompts work as in the user's own terminal.
   */
  async cloneSession(profileId: string, url: string, target: string): Promise<SessionInfo> {
    const profile = this.env.profile(profileId);
    const env = await this.processEnv(profile);
    const git = resolveExecutable('git', env);
    if (!git) throw new Error('git was not found on the PATH of your login shell');
    return this.host.spawn({
      kind: 'setup',
      title: `Clone ${url}`,
      command: git,
      args: ['clone', '--', url, target],
      cwd: path.dirname(target),
      env,
      profileId: profile.id,
    });
  }

  private project(projectId: string): Project {
    const project = this.config.require().projects.find((p) => p.id === projectId);
    if (!project) throw new Error(`Unknown project "${projectId}"`);
    return project;
  }

  private async spawnClaude(options: {
    title: string;
    profile: Profile;
    project: Project;
    workspace?: Workspace;
    cwd: string;
    args: string[];
    /** Added after the inherited CLAUDE_* variables were scrubbed (spec §21.3). */
    extraEnv?: Record<string, string>;
    /** The first message, after every option (spec §9.1). */
    prompt?: string | null;
    /** A suspended session to resume in, or an exited one to start again in (spec §9.8). */
    into?: string;
    /** Added after the profile's own arguments: what the session had (spec §9.8). */
    restore?: string[];
    /** Shown above the terminal (SessionInfo.note). */
    note?: string | null;
  }): Promise<SessionInfo> {
    const { title, profile, project, workspace, cwd, args } = options;
    const env = { ...(await this.processEnv(profile, project, workspace)), ...options.extraEnv };
    // Hooks and the status line name the app's session (spec §9.2).
    const id = options.into ?? randomUUID();
    env[envVar('TERMINAL_SESSION')] = id;
    // Claude started by the app gets --plugin-dir, so nothing loads twice (spec §13.3).
    delete env[PLUGIN_DIRS_VAR];
    const skills = await this.skills?.pluginDirs(profile.id, sessionProjects(project, workspace));
    const pluginArgs = (skills?.dirs ?? []).flatMap((dir) => ['--plugin-dir', dir]);
    const refusal = await this.claudeGate?.refusal(profile.id);
    if (refusal) throw new Error(refusal);
    // The helper's status line runs the profile's own one (spec §9.3).
    if (profile.claude.statusLine) env[envVar('STATUSLINE_COMMAND')] = profile.claude.statusLine;
    const command = resolveExecutable(profile.claude.command, env);
    if (!command) {
      this.claudeGate?.startFailed(profile.id);
      throw new Error(`"${profile.claude.command}" was not found on PATH`);
    }
    const spawn = {
      id,
      kind: 'claude' as const,
      title,
      command,
      args: [
        ...args,
        ...pluginArgs,
        ...profile.claude.args,
        ...(options.restore ?? []),
        ...(options.prompt ? [options.prompt] : []),
      ],
      cwd,
      env,
      profileId: profile.id,
      projectId: project.id,
      workspaceId: workspace?.id ?? null,
      note: options.note ?? null,
    };
    const into = options.into ? this.host.get(options.into) : null;
    const session =
      into?.status === 'suspended'
        ? await this.host.resume(into.id, spawn)
        : into?.status === 'exited'
          ? this.host.relaunch(into.id, spawn)
          : this.host.spawn(spawn);
    if (workspace && skills) this.skills?.claudeStarted(workspace.id, skills.fingerprint);
    const started = Date.now();
    void this.host.waitForExit(session.id).then((exited) => {
      if (exited.status !== 'exited' || exited.exitCode === 0) return;
      if (Date.now() - started >= EARLY_EXIT_MS) return;
      // No conversation to resume (spec §9.8): once, a new one in the same tab.
      const fresh = newConversationArgs(args);
      if (fresh && NO_CONVERSATION.test(this.host.scrollback(session.id))) {
        void this.spawnClaude({
          ...options,
          args: fresh,
          into: session.id,
          note: NEW_CONVERSATION_NOTE,
        }).catch((error: unknown) => console.error('starting a new conversation failed', error));
        return;
      }
      this.claudeGate?.startFailed(profile.id);
    });
    return session;
  }

  /**
   * Environment of a process in a terminal (rule R3, spec §9.2). The
   * workspace variables describe its main repository (§21.3); `project` (the
   * repository the process runs in) gives the commit identity.
   */
  private async processEnv(profile: Profile, project?: Project, workspace?: Workspace) {
    const login = await this.env.login();
    const main = workspace
      ? (this.config.require().projects.find((p) => p.id === workspace.projectId) ?? project)
      : undefined;
    const workspaceInfo =
      workspace && main
        ? {
            id: workspace.id,
            name: workspace.name,
            rootPath: expandHome(main.repoPath),
            linkedWorktrees: linkedRepos(workspace).map((r) => r.worktreePath),
            worktreePath: workspace.worktreePath,
            branch: workspace.branch,
            baseBranch: workspace.baseBranch,
            task: {
              id: workspace.task.id ?? undefined,
              title: workspace.task.title,
              url: workspace.task.url ?? undefined,
            },
            ports: workspace.ports,
          }
        : undefined;
    const env = terminalEnv(
      buildProcessEnv({ base: login.env, profile, project, workspace: workspaceInfo }),
      { locale: app.getLocale(), appVersion: app.getVersion() },
    );
    Object.assign(env, this.additions.env);
    // A `claude` typed in a shell gets the same skills (spec §13.3).
    const skills = await this.skills?.pluginDirs(profile.id, sessionProjects(project, workspace));
    if (skills && skills.dirs.length > 0) env[PLUGIN_DIRS_VAR] = skills.dirs.join(path.delimiter);
    if (this.additions.pathDirs.length > 0) {
      env.PATH = [...this.additions.pathDirs, env.PATH].filter(Boolean).join(path.delimiter);
    }
    return env;
  }

  private async spawnShell(options: {
    kind: SessionKind;
    title: string;
    profile: Profile;
    project?: Project;
    workspace?: Workspace;
    cwd: string;
  }): Promise<SessionInfo> {
    const { kind, title, profile, project, workspace, cwd } = options;
    const login = await this.env.login();
    const env = await this.processEnv(profile, project, workspace);
    return this.host.spawn({
      kind,
      title,
      command: defaultShell(login.env),
      // macOS terminals start login shells; Linux terminals don't.
      args: process.platform === 'darwin' ? ['-l'] : [],
      cwd,
      env,
      profileId: profile.id,
      projectId: project?.id ?? null,
      workspaceId: workspace?.id ?? null,
    });
  }
}
