import fs from 'node:fs';
import os from 'node:os';
import { isProfileColor } from '@shared/profile-colors';
import {
  type AccountChoice,
  type AccountFolder,
  newAccountFolder,
  profileIdFor,
} from '@shared/profiles';
import { type Profile, ProfileSchema, type Sounds } from '@shared/schemas';
import { accountFolder } from '@shared/setup';
import { DEFAULT_SUSPEND_MIN, type SuspendSetting } from '@shared/suspend';
import { DEFAULT_RESUME_PROMPT } from '@shared/unfinished';
import type { ConfigStore } from '../config/store';
import { buildProcessEnv } from '../env/build-env';
import type { EnvService } from '../env/service';
import { contractHome, expandHome } from '../paths';
import { inspectAccountFolder, isDefaultFolder, listAccountFolders } from '../profiles/accounts';
import { aliasLine, appendLineOnce, hasLine, shellKind, shellRcFile } from '../profiles/alias';

type RawProfile = Record<string, unknown> & { id?: unknown };

/** Creating, editing and removing profiles in the app (spec §6.11). */
export class ProfileService {
  constructor(
    private readonly config: ConfigStore,
    private readonly env: EnvService,
  ) {}

  private async homeDir(): Promise<string> {
    return (await this.env.login()).env.HOME || os.homedir();
  }

  private profiles(): Profile[] {
    return this.config.get().config?.profiles ?? [];
  }

  private async inspect(folder: string): Promise<AccountFolder> {
    const { env } = await this.env.login();
    const homeDir = await this.homeDir();
    return inspectAccountFolder({
      folder,
      homeDir,
      profiles: this.profiles(),
      command: 'claude',
      envFor: (configDir) =>
        buildProcessEnv({
          base: env,
          profile: ProfileSchema.parse({
            id: 'account-folder',
            name: 'Account folder',
            env: configDir ? { CLAUDE_CONFIG_DIR: configDir } : {},
          }),
          homeDir,
        }),
    });
  }

  /** `~/.claude` and `~/.claude-*` in the home folder, each with its login state. */
  async accountFolders(): Promise<AccountFolder[]> {
    return Promise.all(listAccountFolders(await this.homeDir()).map((f) => this.inspect(f)));
  }

  /** A folder the user picked with Choose another folder…. */
  async accountFolder(folder: string): Promise<AccountFolder> {
    const absolute = expandHome(folder, await this.homeDir());
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) {
      throw new Error(`${folder} is not a folder`);
    }
    return this.inspect(absolute);
  }

  /**
   * Adds a profile to config.json, keeping fields the app doesn't know. A new
   * account gets an empty `~/.claude-<id>`; an existing one isn't touched.
   */
  async create(input: { name: string; color: string; account: AccountChoice }): Promise<Profile> {
    const name = input.name.trim();
    if (!name) throw new Error('Give the profile a name');
    if (!isProfileColor(input.color)) throw new Error(`Unknown color "${input.color}"`);
    const homeDir = await this.homeDir();
    const id = profileIdFor(
      name,
      this.profiles().map((p) => p.id),
    );

    let folder: string | null = null;
    if (input.account.kind === 'existing') {
      const absolute = expandHome(input.account.folder, homeDir);
      if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) {
        throw new Error(`${input.account.folder} is not a folder`);
      }
      folder = isDefaultFolder(absolute, homeDir) ? null : contractHome(absolute, homeDir);
    } else if (input.account.kind === 'new') {
      folder = newAccountFolder(id);
      const absolute = expandHome(folder, homeDir);
      if (fs.existsSync(absolute)) {
        throw new Error(`${folder} already exists. Choose it under "Use an existing login".`);
      }
      fs.mkdirSync(absolute, { mode: 0o700 });
    }

    const config = this.config.update((raw) => {
      if (!Array.isArray(raw.profiles)) raw.profiles = [];
      (raw.profiles as unknown[]).push({
        id,
        name,
        color: input.color,
        env: folder ? { CLAUDE_CONFIG_DIR: folder } : {},
        // Written, so the start never counts it as a profile from before (spec §9.8).
        suspendIdleMin: DEFAULT_SUSPEND_MIN,
      });
    });
    return config.profiles.find((p) => p.id === id) as Profile;
  }

  /**
   * Name, color, alerts, the profile's own status line command, whether
   * Claude asks before linking a repository, and its
   * commit identity (null clears it); the account folder of a profile never
   * changes (spec §6.11).
   */
  update(
    profileId: string,
    changes: {
      name: string;
      color: string;
      alerts?: { sounds: Sounds; doNotDisturb: boolean };
      statusLine?: string | null;
      /** Ask before Claude links a repository (spec §21.9). */
      askBeforeLink?: boolean;
      git?: { commitName: string; commitEmail: string } | null;
      /** The PR commands (spec §12.3, §14.1); an empty one is removed. */
      pr?: { createCommand: string; statusCommand: string; mergeCommand?: string };
      /** Continue interrupted work at start (spec §9.7); the default prompt isn't written. */
      resume?: { continueAtStart: boolean; prompt: string };
      /** Suspend idle sessions after this many minutes, 0 for Off (spec §9.8). */
      suspendIdleMin?: SuspendSetting;
    },
  ): Profile {
    const name = changes.name.trim();
    if (!name) throw new Error('Give the profile a name');
    if (!isProfileColor(changes.color)) throw new Error(`Unknown color "${changes.color}"`);
    // Only what changed is written, so config.json stays as the user keeps it.
    const current = this.env.profile(profileId);
    const alertsChanged =
      changes.alerts !== undefined &&
      (JSON.stringify(changes.alerts.sounds) !== JSON.stringify(current.alerts.sounds) ||
        changes.alerts.doNotDisturb !== current.alerts.doNotDisturb);
    const statusLine = changes.statusLine?.trim() || null;
    const statusLineChanged =
      changes.statusLine !== undefined && statusLine !== (current.claude.statusLine ?? null);
    const askChanged =
      changes.askBeforeLink !== undefined && changes.askBeforeLink !== current.claude.askBeforeLink;
    let git: { commitName: string; commitEmail: string } | null | undefined = changes.git;
    if (git) {
      git = { commitName: git.commitName.trim(), commitEmail: git.commitEmail.trim() };
      if (!git.commitName && !git.commitEmail) git = null;
      else if (!git.commitName || !git.commitEmail) {
        throw new Error('Give the commit identity both a name and an email, or leave both empty');
      }
    }
    const gitChanged =
      (git !== undefined && (git?.commitName ?? null) !== (current.git?.commitName ?? null)) ||
      (git !== undefined && (git?.commitEmail ?? null) !== (current.git?.commitEmail ?? null));
    const pr = changes.pr && {
      createCommand: changes.pr.createCommand.trim() || null,
      statusCommand: changes.pr.statusCommand.trim() || null,
      // Unset keeps the profile's merge command (spec §12.5).
      mergeCommand:
        changes.pr.mergeCommand === undefined
          ? (current.pr?.mergeCommand ?? null)
          : changes.pr.mergeCommand.trim() || null,
    };
    const prChanged =
      pr !== undefined &&
      (pr.createCommand !== (current.pr?.createCommand ?? null) ||
        pr.statusCommand !== (current.pr?.statusCommand ?? null) ||
        pr.mergeCommand !== (current.pr?.mergeCommand ?? null));
    const resumePromptText = changes.resume?.prompt.trim();
    const resume = changes.resume && {
      continueAtStart: changes.resume.continueAtStart,
      prompt:
        resumePromptText && resumePromptText !== DEFAULT_RESUME_PROMPT ? resumePromptText : null,
    };
    const resumeChanged =
      resume !== undefined &&
      (resume.continueAtStart !== current.resume.continueAtStart ||
        resume.prompt !== (current.resume.prompt ?? null));
    const suspendChanged =
      changes.suspendIdleMin !== undefined && changes.suspendIdleMin !== current.suspendIdleMin;
    const config = this.config.update((raw) => {
      const entry = this.rawProfile(raw.profiles, profileId);
      entry.name = name;
      // Off is written as 0, so it stays apart from a profile that never chose.
      if (suspendChanged) entry.suspendIdleMin = changes.suspendIdleMin;
      if (resumeChanged && resume) {
        // Off and the default prompt aren't written.
        const fields: Record<string, unknown> = {};
        if (resume.continueAtStart) fields.continueAtStart = true;
        if (resume.prompt) fields.prompt = resume.prompt;
        if (Object.keys(fields).length > 0) entry.resume = fields;
        else delete entry.resume;
      }
      if (prChanged && pr) {
        // Other pr fields (createPrompt, mergeMethod, timeoutSec) are kept as they are.
        const fields = { ...(entry.pr as Record<string, unknown> | undefined) };
        for (const key of ['createCommand', 'statusCommand', 'mergeCommand'] as const) {
          if (pr[key]) fields[key] = pr[key];
          else delete fields[key];
        }
        if (Object.keys(fields).length > 0) entry.pr = fields;
        else delete entry.pr;
      }
      if (gitChanged) {
        if (git) entry.git = git;
        else delete entry.git;
      }
      entry.color = changes.color;
      if (alertsChanged && changes.alerts) {
        // The old single switch goes once the sounds are set (spec §10.3).
        const { sound: _old, ...alerts } = (entry.alerts as Record<string, unknown>) ?? {};
        entry.alerts = { ...alerts, ...changes.alerts };
      }
      if (statusLineChanged || askChanged) {
        const claude = { ...(entry.claude as Record<string, unknown> | undefined) };
        if (statusLineChanged) {
          if (statusLine) claude.statusLine = statusLine;
          else delete claude.statusLine;
        }
        // On is the default, so only off is written.
        if (askChanged) {
          if (changes.askBeforeLink === false) claude.askBeforeLink = false;
          else delete claude.askBeforeLink;
        }
        if (Object.keys(claude).length > 0) entry.claude = claude;
        else delete entry.claude;
      }
    });
    return config.profiles.find((p) => p.id === profileId) as Profile;
  }

  /** Why the profile can't be removed, or null: it still has projects. */
  removalRefusal(profileId: string): string | null {
    const projects = (this.config.get().config?.projects ?? []).filter(
      (p) => p.profileId === profileId,
    ).length;
    if (projects === 0) return null;
    const name = this.env.profile(profileId).name;
    return `${name} still has ${projects} ${projects === 1 ? 'project' : 'projects'}`;
  }

  /** Removes the profile from config.json. Nothing on disk is deleted. */
  remove(profileId: string): void {
    const refusal = this.removalRefusal(profileId);
    if (refusal) throw new Error(refusal);
    this.config.update((raw) => {
      this.rawProfile(raw.profiles, profileId);
      raw.profiles = (raw.profiles as RawProfile[]).filter((p) => p.id !== profileId);
    });
  }

  /**
   * Moves a profile to `index` in config.json's list, the order of the
   * profile tabs and ⌘1…⌘9 (spec §6). The index is clamped to the list.
   */
  move(profileId: string, index: number): void {
    this.config.update((raw) => {
      const list = raw.profiles as RawProfile[];
      const profile = this.rawProfile(list, profileId);
      const rest = list.filter((p) => p !== profile);
      rest.splice(Math.max(0, Math.min(rest.length, index)), 0, profile);
      raw.profiles = rest;
    });
  }

  /**
   * The optional shortcut for a profile with its own folder, and the startup
   * file it can be added to (null for shells other than zsh, bash and fish).
   */
  async alias(profileId: string) {
    const profile = this.env.profile(profileId);
    const homeDir = await this.homeDir();
    if (isDefaultFolder(accountFolder(profile), homeDir)) return null;
    const login = await this.env.login();
    const kind = shellKind(login.shell);
    const line = aliasLine(profile.id, accountFolder(profile), kind);
    if (!line) return null;
    const file = shellRcFile(kind, login.env, homeDir);
    return {
      line,
      file,
      fileShown: file ? contractHome(file, homeDir) : null,
      present: file ? hasLine(file, line) : false,
    };
  }

  /** Appends the alias line to the shell's startup file, once (after the user confirmed). */
  async addAlias(profileId: string): Promise<{ added: boolean }> {
    const alias = await this.alias(profileId);
    if (!alias?.file) throw new Error('There is no shell startup file to add the alias to');
    return { added: appendLineOnce(alias.file, alias.line) };
  }

  private rawProfile(profiles: unknown, profileId: string): RawProfile {
    const entry = Array.isArray(profiles)
      ? (profiles as RawProfile[]).find((p) => p && p.id === profileId)
      : undefined;
    if (!entry) throw new Error(`Unknown profile "${profileId}"`);
    return entry;
  }
}
