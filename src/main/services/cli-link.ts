import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { BRAND, envVar } from '@shared/brand';
import type { Project } from '@shared/schemas';
import { workspaceRepo } from '@shared/workspaces';
import type {
  LinkRequest,
  LinkResponse,
  ProjectsRequest,
  ProjectsResponse,
} from '../bridge/server';
import type { ConfigStore } from '../config/store';
import type { WorkspaceRecords } from '../db/workspaces';
import { expandHome } from '../paths';
import type { ProjectService } from './projects';
import type { WorkspaceService } from './workspaces';

/** A repository linked from the command line, for the app's notice (spec §21.9). */
export interface CliLinkEvent {
  workspaceId: string;
  profileId: string;
  workspaceName: string;
  repoName: string;
  /** Its new worktree. */
  worktreePath: string;
  /** Run by Claude (its Bash tool), not typed in a shell. */
  byClaude: boolean;
}

const OUTSIDE =
  'This only works inside a workspace: in its Claude, or in one of its shells or Setup tabs';
const NOT_ALLOWED =
  'Claude may not add repositories to this workspace (Let Claude add others when needed is off). Ask the user to link it: Link another repository… in the workspace’s ⋯ menu';

/**
 * `<slug> link` and `<slug> projects` (spec §21.9): Claude, or a workspace's
 * terminal, links another repository of the profile to the workspace with
 * the same steps as Link another repository…, and learns at session start
 * which repositories it could link.
 */
export class CliLinkService {
  private readonly events = new EventEmitter();

  constructor(
    private readonly config: ConfigStore,
    private readonly records: WorkspaceRecords,
    private readonly projects: ProjectService,
    private readonly workspaces: WorkspaceService,
  ) {}

  onLinked(listener: (event: CliLinkEvent) => void): () => void {
    this.events.on('linked', listener);
    return () => this.events.off('linked', listener);
  }

  /** The profile's projects, and which are in the calling workspace. */
  projectList(request: ProjectsRequest): ProjectsResponse {
    const workspace = request.workspaceId ? this.records.get(request.workspaceId) : null;
    const profileId = workspace?.profileId ?? request.profileId;
    if (!profileId) return { ok: false, error: 'Run this in one of the app’s terminals' };
    return {
      ok: true,
      projects: this.profileProjects(profileId).map((p) => {
        const repo = workspace ? workspaceRepo(workspace, p.id) : null;
        return {
          id: p.id,
          name: p.name,
          repoPath: expandHome(p.repoPath),
          inWorkspace: !workspace ? null : !repo ? 'no' : repo.primary ? 'main' : 'linked',
        };
      }),
    };
  }

  /** Links a project (by id, name or repository path) to the calling workspace. */
  async link(request: LinkRequest): Promise<LinkResponse> {
    const workspace = request.workspaceId ? this.records.get(request.workspaceId) : null;
    if (!workspace) return { ok: false, error: OUTSIDE };
    if (request.profileId && request.profileId !== workspace.profileId) {
      return { ok: false, error: OUTSIDE };
    }
    // Spec §21.9: only with Let Claude add others, and only the profile's projects.
    if (request.byClaude && !workspace.claudeMayLink) return { ok: false, error: NOT_ALLOWED };
    try {
      const { project, added } = await this.resolve(
        request.project,
        request.cwd,
        workspace.profileId,
        !request.byClaude,
      );
      const { workspace: linked, setup } = await this.workspaces.link(workspace.id, project.id, {
        restart: false,
        addedBy: request.byClaude ? 'claude' : 'terminal',
      });
      const repo = workspaceRepo(linked, project.id);
      if (!repo) throw new Error(`${project.name} wasn't linked`);
      // The answer waits until the worktree is ready to work in: its setup passed, or failed.
      const setupError = setup
        ? await this.workspaces.setupOutcome(workspace.id, project.id, setup.id)
        : (workspaceRepo(this.records.get(workspace.id) ?? linked, project.id)?.setupError ?? null);
      this.events.emit('linked', {
        workspaceId: workspace.id,
        profileId: workspace.profileId,
        workspaceName: workspace.name,
        repoName: project.name,
        worktreePath: repo.worktreePath,
        byClaude: request.byClaude,
      } satisfies CliLinkEvent);
      return {
        ok: true,
        name: project.name,
        projectId: project.id,
        added,
        worktreePath: repo.worktreePath,
        branch: linked.branch,
        baseBranch: repo.baseBranch,
        setup: setup !== null,
        setupError,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * What Claude is told at session start in a workspace: that its folder is
   * the task's worktree, on its branch (spec §13.5), its ports (§8.4), and, with Let Claude
   * add others, the profile's other projects with how to link them (§21.9). Null outside a
   * workspace.
   */
  sessionNote(workspaceId: string | null): string | null {
    const workspace = workspaceId ? this.records.get(workspaceId) : null;
    if (!workspace) return null;
    const task = [workspace.task.id, workspace.task.title].filter(Boolean).join(' ');
    const worktree = `${BRAND.displayName}: this folder, ${workspace.worktreePath}, is the git worktree of the task${task ? ` "${task}"` : ''}, on branch ${workspace.branch}. Work here: don't create another worktree or branch for this task.`;
    // The workspace's port block (spec §8.4), so parallel dev servers don't collide.
    const { ports } = workspace;
    const here = ports
      ? `${worktree}\nUse ports ${ports.base}–${ports.base + ports.count - 1} for anything you start (dev servers, tests); $${envVar('PORT')} is the first.`
      : worktree;
    if (!workspace.claudeMayLink) return here;
    const others = this.profileProjects(workspace.profileId).filter(
      (p) => !workspaceRepo(workspace, p.id),
    );
    if (others.length === 0) return here;
    const cli = BRAND.cliCommand;
    const defaultBase = this.config.get().config?.profiles.find((p) => p.id === workspace.profileId)
      ?.defaults.baseBranch;
    return [
      here,
      `Its branch ${workspace.branch} can also be checked out in the other projects of this profile:`,
      ...others.map((p) => {
        const base = p.baseBranch ?? defaultBase;
        return `- ${p.name}: ${expandHome(p.repoPath)}${base ? ` (base ${base})` : ''}`;
      }),
      `This folder's repository stays your main one and your working folder. Only when the task requires changes in one of those projects, run \`${cli} link <name>\`: it gives that project its own worktree on this branch, from its base. Then make its changes in the worktree path it prints. It answers once the worktree and its setup are ready, which can take minutes: run it with a long timeout. Only those projects can be linked, nothing outside them. Don't create worktrees yourself, and don't edit those repositories' main checkouts. \`${cli} projects\` lists them.`,
    ].join('\n');
  }

  private profileProjects(profileId: string): Project[] {
    return (this.config.get().config?.projects ?? []).filter((p) => p.profileId === profileId);
  }

  /**
   * A project of the profile by id or name; otherwise a path to a repository,
   * added to the profile first when it isn't a project yet (rule R1 applies)
   * and `mayAdd` (from a terminal, not Claude: spec §21.9).
   */
  private async resolve(
    given: string,
    cwd: string | null,
    profileId: string,
    mayAdd: boolean,
  ): Promise<{ project: Project; added: boolean }> {
    const own = this.profileProjects(profileId);
    const byId = own.find((p) => p.id === given);
    if (byId) return { project: byId, added: false };
    const byName = own.filter((p) => p.name.toLowerCase() === given.toLowerCase());
    if (byName.length === 1) return { project: byName[0] as Project, added: false };
    const folder = path.resolve(cwd ?? '/', expandHome(given));
    const looksLikePath = /[/\\]|^[.~]/.test(given) || fs.existsSync(folder);
    if (!looksLikePath || !fs.existsSync(folder)) {
      const names = own.map((p) => p.name).join(', ');
      throw new Error(
        `There is no project "${given}" in this profile${names ? ` (projects: ${names})` : ''}, nor a folder by that name`,
      );
    }
    const candidate = await this.projects.inspect(folder, profileId);
    if (candidate.conflict) {
      if (candidate.conflict.profileId !== profileId) {
        throw new Error(
          `This repository is already registered under the ${candidate.conflict.profileName} profile`,
        );
      }
      const existing = own.find((p) => p.id === candidate.conflict?.projectId);
      if (existing) return { project: existing, added: false };
    }
    if (!mayAdd) {
      throw new Error(
        `${given} isn't a project of this profile, and Claude can only link the profile's projects (\`${BRAND.cliCommand} projects\` lists them). Ask the user to add it first`,
      );
    }
    const project = await this.projects.add({
      profileId,
      repoPath: candidate.repoPath,
      name: candidate.name,
      remote: candidate.remote,
      baseBranch: candidate.baseBranch,
    });
    return { project, added: true };
  }
}
