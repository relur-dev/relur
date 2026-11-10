import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BRAND, envVar } from '@shared/brand';
import { suspendDelay } from '@shared/suspend';
import type { SessionInfo } from '@shared/terminal-protocol';
import { planLimitReached } from '@shared/unfinished';
import { LATEST_RELEASE_URL } from '@shared/updates';
import { parseRateLimits } from '@shared/usage';
import { app, BrowserWindow, dialog, powerMonitor, shell } from 'electron';
import { APP_LOG_FILE, AppLog } from './app-log';
import { followAppearance } from './appearance';
import { HookBridge } from './bridge/server';
import { FinishService, PR_POLL_MS } from './changes/finish';
import { MergeService } from './changes/merge';
import { claudeSettings, writeClaudeSettings } from './claude/settings';
import { awaitLastResponse, readPrompts, shownPrompt } from './claude/transcript';
import { ConfigStore } from './config/store';
import { NoteRecords } from './db/notes';
import { openStateDb } from './db/state-db';
import { UsageRecords } from './db/usage';
import { WorkspaceRecords } from './db/workspaces';
import { EditorService } from './editor/service';
import { EnvService } from './env/service';
import { bugReportUrl, featureRequestUrl, osOption, osVersion } from './feedback';
import { logGitFailures } from './git/git';
import { killGitProcessesNow, runningGitCount, stopGitProcesses } from './git/processes';
import { helperPath, stableHelper, writeSessionBin } from './helper-files';
import {
  migrateSettings,
  noticeShown,
  pendingNotice,
  type SettingsMigration,
} from './legacy/settings';
import { parseFixedMemory } from './memory/fixed';
import { readProcessTable } from './memory/processes';
import { MemoryMonitor } from './memory/service';
import { installAppMenu } from './menu';
import { NotesService } from './notes/service';
import { markShown, wasShown } from './notices';
import { appConfigDir, contractHome } from './paths';
import { RemoteWatch } from './projects/remote-watch';
import { chromiumSandboxOff } from './sandbox';
import { installSecurityPolicies, openExternalSafe } from './security';
import { isSelfTest, runSelfTest } from './self-test';
import { CliLinkService } from './services/cli-link';
import { ProfileService } from './services/profiles';
import { ProjectService } from './services/projects';
import { TerminalService } from './services/terminals';
import { WorkspaceService } from './services/workspaces';
import { SessionHost } from './sessions/host';
import { SetupService } from './setup/service';
import { SkillService } from './skills/service';
import { ElectronStatusPlatform } from './status/electron';
import { StatusService } from './status/service';
import { SuspendDefaultNotice } from './suspend/notice';
import { SuspendService } from './suspend/service';
import { serveTrpcOverIpc } from './trpc/electron';
import { UnfinishedService } from './unfinished/service';
import { startUpdate, updateWay } from './updates/install';
import { UpdateInstaller } from './updates/installer';
import { skippedStore, UpdateService } from './updates/service';
import { updateRoot } from './updates/stage';
import {
  bringForward,
  createMainWindow,
  devIconPath,
  saveWindowState,
  testWindows,
} from './window';
import { TaskLookupService } from './workflow/lookup';
import { WorkflowSetupService } from './workflow/propose';
import { WorkflowService } from './workflow/service';
import { WorktreeNotices } from './worktrees/notices';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** The workspaces whose Claude these sessions are. */
const claudeWorkspaces = (sessions: { kind: string; workspaceId: string | null }[]) =>
  sessions.flatMap((s) => (s.kind === 'claude' && s.workspaceId ? [s.workspaceId] : []));

// Name and paths must be set before `ready`, so Electron's defaults (derived from
// package.json) are never used.
app.setName(BRAND.displayName);
// The self-test runs against a throwaway config dir, never the user's. Scripted
// tests that need the user's real HOME (to reach their Claude login) point the
// app at a separate config dir with <PREFIX>CONFIG_DIR.
const configOverride = process.env[envVar('CONFIG_DIR')];
let configDir = isSelfTest
  ? fs.mkdtempSync(path.join(os.tmpdir(), `${BRAND.slug}-self-test-`))
  : path.resolve(configOverride || appConfigDir());
// The first start after the rename copies the old app's settings (spec §3.5),
// before Electron creates the folder. While the old app runs nothing is copied,
// and this start uses a throwaway folder only to say so and quit.
const migration: SettingsMigration =
  isSelfTest || configOverride
    ? { kind: 'none' }
    : migrateSettings(appConfigDir(undefined, BRAND.legacy), configDir);
if (migration.kind === 'old-app-running') {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), `${BRAND.slug}-waiting-`));
}
app.setPath('userData', configDir);
app.setPath('sessionData', path.join(configDir, 'session'));
if (process.platform === 'win32') app.setAppUserModelId(BRAND.bundleId);
// Scripted test runs: no Dock icon, and never the active app, so no key or
// menu shortcut of someone using the machine reaches it (window.ts).
if (testWindows() && process.platform === 'darwin') app.setActivationPolicy('accessory');

let mainWindow: BrowserWindow | null = null;
let env: EnvService;
const host = new SessionHost();

/** Cleanups for the app's last moment, run once no session runs (spec §5). */
const shutdownTasks: (() => void)[] = [];
const atShutdown = (task: () => void) => {
  shutdownTasks.push(task);
};
/** Closes state.db: the very last step, once nothing that uses it runs (spec §5). */
let closeDatabase: (() => void) | null = null;
/**
 * Once quitting goes ahead (spec §5): no session starts, no terminal input,
 * hook event, status line or command arrives any more, and the terminal
 * views' ports close. Terminal output and exits already stopped reaching
 * the views with host.close().
 */
const stopAccepting = () => {
  host.close();
  bridge.close();
};
// The one will-quit handler. A terminal still running here would end while
// Electron tears Node down, where node-pty's exit callback aborts the app
// ("quit unexpectedly"): it is stopped first and the quit goes on after.
// git the app started (a background fetch, say) is stopped the same way, so
// nothing it started outlives it (spec §5).
app.on('will-quit', (event) => {
  stopAccepting();
  const git = stopGitProcesses();
  if (host.runningCount() > 0 || runningGitCount() > 0) {
    event.preventDefault();
    void Promise.all([host.shutdown(), git]).then(() => app.quit());
    return;
  }
  for (const task of shutdownTasks.splice(0)) task();
  closeDatabase?.();
  closeDatabase = null;
});
// The last resort when the app ends some other way (app.exit, an uncaught
// error): git still running is killed, group and all.
process.on('exit', killGitProcessesNow);
const bridge = new HookBridge();
let status: StatusService | null = null;
/** Work the app's stop interrupts (spec §9.7); set once the app is ready. */
let unfinished: UnfinishedService | null = null;
let statusPlatform: ElectronStatusPlatform | null = null;
/** Memory of Claude sessions and the app (spec §6.14); set once the app is ready. */
let memory: MemoryMonitor | null = null;
/** Suspends idle Claude sessions and resumes them when shown (spec §9.8). */
let suspender: SuspendService | null = null;
/** Updating inside the app (spec §15.7); told when the quit question is cancelled. */
let updateInstaller: UpdateInstaller | null = null;
/** The quit dialog in the window (spec §5): asked with the busy session ids. */
const quitAsker = new EventEmitter();
let answerQuit: ((quit: boolean) => void) | null = null;
/** The notice in the window when it first closes and the app keeps running (spec §5). */
const closeNoticeAsker = new EventEmitter();
let answerCloseNotice: ((close: boolean) => void) | null = null;
/** Set once the app is ready: the config and its folder, for closing the window. */
let appConfig: ConfigStore | null = null;
let appDataDir: string | null = null;
/** A quit is under way: windows close without the notice or another question. */
let quitting = false;

/** The helper as hooks run it, for the self-test. */
let helperForSelfTest: string | null = null;

/** Main-process checks for --self-test; returns a problem description or null. */
async function selfTestCheck(): Promise<string | null> {
  // Packaged builds (scripts/linux-package-check.sh): the helper, outside the
  // asar or copied out of the AppImage, runs. state.db already opened, so
  // better-sqlite3 loads.
  if (app.isPackaged) {
    if (!helperForSelfTest) return `${BRAND.helperCommand} is missing`;
    try {
      execFileSync(helperForSelfTest, ['--version'], { stdio: 'ignore', timeout: 5000 });
    } catch (error) {
      return `${helperForSelfTest} --version failed: ${String(error)}`;
    }
  }
  // The sandbox stays on (spec §15.6): an AppImage started without it fails here.
  const sandbox = chromiumSandboxOff();
  if (sandbox) return `Chromium's sandbox is off: ${sandbox}`;
  const diagnostics = await env.diagnostics();
  if (diagnostics.source !== 'login-shell') return `login shell env: ${diagnostics.error}`;
  if (!diagnostics.git) return 'git not found on the login shell PATH';

  const session = host.spawn({
    kind: 'shell',
    title: 'self-test',
    command: '/bin/sh',
    args: ['-c', 'printf pty-$((40 + 2))'],
    cwd: os.tmpdir(),
    env: (await env.login()).env,
    profileId: 'self-test',
  });
  for (let i = 0; i < 50 && host.get(session.id).status === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!host.scrollback(session.id).includes('pty-42')) {
    return `PTY output missing: ${JSON.stringify(host.scrollback(session.id))}`;
  }
  await host.remove(session.id);
  return null;
}

function showMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    bringForward(mainWindow);
    return;
  }
  const win = createMainWindow();
  mainWindow = win;
  statusPlatform?.track(win);
  // Memory is measured only while the window is visible, and at once when it shows (spec §6.14).
  win.on('show', () => void memory?.refresh());
  win.on('restore', () => void memory?.refresh());
  // A window that shows again resumes the suspended Claude it shows (spec §9.8).
  win.on('show', () => suspender?.checkShown());
  win.on('restore', () => suspender?.checkShown());
  win.on('close', (event) => onWindowClose(win, event));
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
    answerCloseNotice = null;
  });
  if (isSelfTest) {
    runSelfTest(mainWindow, selfTestCheck, async () => {
      await Promise.all([host.shutdown(), stopGitProcesses()]);
    });
  }
}

/**
 * Closing the window (spec §5). On macOS the app keeps running, so Claude
 * finishes and notifications arrive, and says so in the window the first time
 * ever. On Linux and Windows, or with Quit When the Window Closes, closing quits
 * instead: through app.quit, which asks first while something runs, with the
 * window still there to ask in.
 */
function onWindowClose(win: BrowserWindow, event: Electron.Event): void {
  if (quitting || isSelfTest) return;
  if (process.platform !== 'darwin' || appConfig?.get().config?.quitOnWindowClose) {
    event.preventDefault();
    app.quit();
    return;
  }
  if (!appDataDir || wasShown(appDataDir, 'window-closed')) return;
  if (closeNoticeAsker.listenerCount('request') === 0) return;
  event.preventDefault();
  // Never shown again, whatever the answer.
  markShown(appDataDir, 'window-closed');
  void new Promise<boolean>((resolve) => {
    answerCloseNotice = resolve;
    closeNoticeAsker.emit('request');
  }).then((close) => {
    answerCloseNotice = null;
    if (close && !win.isDestroyed()) win.close();
  });
}

/**
 * The latest release from the GitHub API (spec §15.7): no cookies or
 * identifiers, only a User-Agent with the app's name and version. Tests point
 * it at a fake endpoint with <PREFIX>UPDATE_URL.
 */
async function fetchLatestRelease(version: string): Promise<unknown> {
  const override = process.env[envVar('UPDATE_URL')];
  const url = override && /^https?:\/\//.test(override) ? override : LATEST_RELEASE_URL;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        'User-Agent': `${BRAND.displayName}/${version}`,
        Accept: 'application/vnd.github+json',
      },
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const code = (error as { cause?: { code?: string } }).cause?.code;
    throw new Error(`GitHub couldn't be reached${code ? ` (${code})` : ''}`);
  }
  if (response.status === 404) throw new Error('GitHub has no release yet');
  if (!response.ok) throw new Error(`GitHub answered ${response.status} ${response.statusText}`);
  return response.json();
}

/** Check for Updates… (spec §15.7): the notice when there is a newer version, else a message. */
async function checkForUpdatesNow(updates: UpdateService): Promise<void> {
  const result = await updates.check({ manual: true });
  showMainWindow();
  if (result.kind === 'newer') return;
  const options = {
    type: result.kind === 'failed' ? ('warning' as const) : ('info' as const),
    message:
      result.kind === 'failed'
        ? "Couldn't check for updates"
        : `${BRAND.displayName} ${app.getVersion()} is the latest version`,
    detail: result.kind === 'failed' ? result.reason : undefined,
    buttons: ['OK'],
  };
  if (mainWindow) await dialog.showMessageBox(mainWindow, options);
  else await dialog.showMessageBox(options);
}

/** Once, after the settings were copied: where the old folder still is (spec §3.5). */
function showMigrationNotice(dataDir: string): void {
  const from = pendingNotice(dataDir);
  if (!from || !mainWindow) return;
  noticeShown(dataDir);
  const reveal = process.platform === 'darwin' ? 'Show in Finder' : 'Show in folder';
  void dialog
    .showMessageBox(mainWindow, {
      type: 'info',
      message: `Your settings were copied from ${BRAND.legacy.displayName}`,
      detail: `${BRAND.displayName} keeps its settings in ${contractHome(dataDir)}. ${BRAND.legacy.displayName}'s folder, ${contractHome(from)}, is still there, unchanged, as a backup. Delete it once everything works.`,
      buttons: ['OK', reveal],
      defaultId: 0,
    })
    .then(({ response }) => {
      if (response === 1) void shell.openPath(from);
    });
}

if (!isSelfTest && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);

  app.whenReady().then(async () => {
    if (migration.kind === 'old-app-running') {
      await dialog.showMessageBox({
        type: 'info',
        message: `Quit ${BRAND.legacy.displayName} first`,
        detail: `${BRAND.displayName} copies ${BRAND.legacy.displayName}'s settings and workspaces when it first starts, and ${BRAND.legacy.displayName} is still running. Quit ${BRAND.legacy.displayName}, then open ${BRAND.displayName} again.`,
      });
      fs.rmSync(configDir, { recursive: true, force: true });
      app.exit(0);
      return;
    }
    const dataDir = app.getPath('userData');
    if (!app.isPackaged && fs.existsSync(devIconPath())) app.dock?.setIcon(devIconPath());
    // The hook bridge (spec §10.1) and cli.json for the command line tool (§7.5).
    await bridge.start();
    const cliFile = path.join(dataDir, 'cli.json');
    bridge.writeCliFile(cliFile);
    atShutdown(() => {
      fs.rmSync(cliFile, { force: true });
      void bridge.stop();
    });
    const bundled = helperPath({
      appPath: app.getAppPath(),
      resourcesPath: app.isPackaged ? process.resourcesPath : null,
    });
    const helper = bundled && stableHelper(bundled, dataDir, process.env.APPIMAGE);
    helperForSelfTest = helper;
    if (!helper) console.warn(`${BRAND.helperCommand} is missing: run npm run build:helper`);
    const config = new ConfigStore(path.join(dataDir, 'config.json'));
    config.load();
    appConfig = config;
    // Before the window opens, so it paints in the chosen appearance (spec §6).
    followAppearance(config);
    appDataDir = dataDir;
    // Suspension became on by default: a notice, once, for profiles that got it (spec §9.8).
    const suspendNotice = new SuspendDefaultNotice(dataDir, {
      created: config.created,
      defaulted: config.suspendDefaulted,
    });
    const db = openStateDb(path.join(dataDir, 'state.db'));
    closeDatabase = () => db.close();
    env = new EnvService(config);

    installSecurityPolicies();
    // New versions (spec §15.7): only after the user agreed, and never in the self-test.
    const skipped = skippedStore(dataDir);
    const updates = new UpdateService({
      version: app.getVersion(),
      fetchLatest: () => fetchLatestRelease(app.getVersion()),
      automatic: () => (isSelfTest ? false : config.get().config?.checkForUpdates),
      setAutomatic: (on) =>
        config.update((raw) => {
          raw.checkForUpdates = on;
        }),
      skipped: skipped.get,
      setSkipped: skipped.set,
    });
    atShutdown(() => updates.dispose());
    const menuRequests = new EventEmitter();
    // Report a Bug… and Request a Feature… (spec §6.12): the issue forms in the
    // browser, the bug report prefilled; nothing is sent.
    const feedback = {
      reportBug: () => {
        let osRelease: string | null = null;
        try {
          if (process.platform === 'linux') osRelease = fs.readFileSync('/etc/os-release', 'utf8');
        } catch {}
        openExternalSafe(
          bugReportUrl({
            appVersion: app.getVersion(),
            os: osOption({
              platform: process.platform,
              arch: process.arch,
              packaged: app.isPackaged,
              appImage: Boolean(process.env.APPIMAGE),
            }),
            osVersion: osVersion({
              platform: process.platform,
              systemVersion: process.getSystemVersion(),
              osRelease,
              env: process.env,
            }),
            // The setup check starts below, before any menu item can be chosen.
            claudeVersion: setup.claudeVersion(),
          }),
        );
      },
      requestFeature: () => openExternalSafe(featureRequestUrl()),
    };
    installAppMenu(
      config,
      (what) => {
        showMainWindow();
        menuRequests.emit('request', what);
      },
      {
        setAutomatic: (on) => updates.setAutomatic(on),
        checkNow: () => void checkForUpdatesNow(updates),
      },
      feedback,
    );
    // Updating inside the app (spec §15.7): where it runs decides how it updates.
    const testTarget = process.env[envVar('UPDATE_TARGET')] || undefined;
    const installer = new UpdateInstaller({
      dataDir,
      version: app.getVersion(),
      way: updateWay({
        platform: process.platform,
        arch: process.arch,
        translated: app.runningUnderARM64Translation,
        packaged: app.isPackaged,
        exePath: process.execPath,
        appImage: process.env.APPIMAGE,
        testTarget,
        writable: (dir) => {
          try {
            fs.accessSync(dir, fs.constants.W_OK);
            return true;
          } catch {
            return false;
          }
        },
      }),
      helper,
      allowHttp: Boolean(process.env[envVar('UPDATE_URL')]),
      quit: () => app.quit(),
      // The started app gets the user's login environment, not this one's.
      launchEnv: async () => (await env.login()).env,
      launch: process.platform === 'darwin' && !testTarget ? 'open' : 'exec',
      pid: process.pid,
    });
    updateInstaller = installer;
    // At the last moment of a normal quit, never at a signal's or logout (spec §15.7).
    atShutdown(() => installer.applyAtQuit({ normalQuit: askBeforeQuit && !sessionEnding }));
    const workspaceRecords = new WorkspaceRecords(db);
    // Workspace states from hooks (spec §10), their alerts and the Dock badge.
    statusPlatform = new ElectronStatusPlatform(config);
    // Done held for background commands watches their processes (spec §10.2);
    // scripted test runs shorten its minute.
    const minuteMs = Number(process.env[envVar('TEST_MINUTE_MS')]);
    status = new StatusService(workspaceRecords, host, statusPlatform, undefined, {
      minuteMs: testWindows() && minuteMs > 0 ? minuteMs : undefined,
      readProcesses: () => readProcessTable(),
    });
    bridge.onHook((message) => status?.handleHook(message));
    // Plan usage from the status line (spec §11).
    const usage = new UsageRecords(db);
    bridge.onStatusLine(({ profileId, rateLimits }) => {
      const snapshot = parseRateLimits(rateLimits);
      if (profileId && snapshot && config.get().config?.profiles.some((p) => p.id === profileId)) {
        usage.save(profileId, snapshot);
      }
    });
    // A clicked notification brings the window forward, or opens it (spec §10.3).
    statusPlatform.onClicked(() => showMainWindow());
    // Prompt markers and Copy buttons in Claude tabs (spec §6.8): each event is
    // marked in the Claude session's output, a prompt as Claude shows it, a
    // response with its text from the transcript once it is written there
    // (after the Stop hook). A resumed session's earlier prompts come from its
    // transcript, to be found in Claude's reprint of the conversation.
    status.onConversation(async ({ workspaceId, event, text, transcript }) => {
      const claude = () =>
        host
          .list()
          .find(
            (s) => s.workspaceId === workspaceId && s.kind === 'claude' && s.status === 'running',
          );
      if (event === 'UserPromptSubmit') {
        const session = claude();
        if (session) host.mark(session.id, { kind: 'prompt', text: text && shownPrompt(text) });
        return;
      }
      if (event === 'SessionStart') {
        const session = claude();
        const file = transcript ?? workspaceRecords.transcriptPath(workspaceId);
        if (!session || !file) return;
        for (const prompt of readPrompts(file)) {
          host.mark(session.id, { kind: 'prompt', text: prompt, resumed: true });
        }
        return;
      }
      const file = transcript ?? workspaceRecords.transcriptPath(workspaceId);
      const response = file ? await awaitLastResponse(file, text) : text?.trim() || null;
      const session = claude();
      if (session && response) host.mark(session.id, { kind: 'response', text: response });
    });
    const terminals = new TerminalService(config, env, host);
    terminals.additions = {
      env: { [envVar('BRIDGE_URL')]: bridge.url, [envVar('BRIDGE_TOKEN')]: bridge.token },
      pathDirs: helper ? [writeSessionBin(dataDir, helper)] : [],
    };
    // Skill sources (spec §13.2): plugin folders for every session of a profile.
    const skills = new SkillService(config, env, dataDir);
    terminals.skills = skills;
    host.onExit((info) => {
      if (info.kind === 'claude' && info.workspaceId) skills.claudeStopped(info.workspaceId);
    });
    const setup = new SetupService(config, env, terminals);
    terminals.claudeGate = setup;
    setup.checkAll();
    app.on('browser-window-focus', () => setup.checkUnpassedOnFocus());
    const projects = new ProjectService(config, env);
    // Two --settings files: with and without the ask rule for `<slug> link`,
    // per the profile's Ask before Claude links a repository (spec §21.9).
    const settingsOptions = {
      helper,
      // Dev flag for the §9.3 live check: the injected hooks write markers there.
      markersDir: process.env[envVar('SMOKE_MARKERS')] || undefined,
    };
    // Dev flag for the Copy buttons' live check (spec §6.8): Claude's
    // renderer, "default" or "fullscreen", over the profile's own setting.
    const smokeTui = process.env[envVar('SMOKE_TUI')];
    const withTui = (settings: Record<string, unknown>) =>
      smokeTui ? { ...settings, tui: smokeTui } : settings;
    const plainSettings = writeClaudeSettings(dataDir, withTui(claudeSettings(settingsOptions)));
    const askLinkSettings = writeClaudeSettings(
      dataDir,
      withTui(claudeSettings({ ...settingsOptions, askBeforeLink: true })),
      'settings-ask-link.json',
    );
    const settingsFor = (profileId: string) =>
      env?.profile(profileId).claude.askBeforeLink === false ? plainSettings : askLinkSettings;
    const workspaces = new WorkspaceService(config, env, workspaceRecords, terminals, settingsFor);
    // A main checkout's Claude gets the hooks too, so it can be suspended (spec §9.8).
    terminals.claudeSettings = settingsFor;
    // Create's and the task lookup's phases, timed (spec §3.4).
    const appLog = new AppLog(path.join(dataDir, APP_LOG_FILE));
    workspaces.log = appLog;
    // Network git that failed, a background fetch included (spec §7.3).
    logGitFailures((line) => appLog.write(line));
    status.onSessionStart((workspaceId) => workspaces.sessionStarted(workspaceId));
    // The workflow read from each workspace's status file (spec §13.4, §13.5).
    const workflow = new WorkflowService(config, workspaceRecords, terminals);
    status.workflow = workflow;
    workflow.lookups = new TaskLookupService(
      (profileId, projectId) => terminals.lookupContext(profileId, projectId),
      appLog,
    );
    // Set up from my skills (spec §13.10).
    const workflowSetup = new WorkflowSetupService(config, workspaceRecords, skills, (p, q) =>
      terminals.lookupContext(p, q),
    );
    workflow.onChange(({ workspaceId, before, after }) =>
      status?.workflowChanged(workspaceId, before, after),
    );
    workspaces.startPrompt = (workspace) => workflow.startPrompt(workspace);
    // Continuing interrupted work (spec §9.7).
    const runningClaude = (workspaceId: string) =>
      host
        .list()
        .some(
          (s) => s.workspaceId === workspaceId && s.kind === 'claude' && s.status === 'running',
        );
    const continuing = new UnfinishedService({
      records: workspaceRecords,
      settings: (profileId) =>
        config.get().config?.profiles.find((p) => p.id === profileId)?.resume ?? null,
      profileOrder: () => config.get().config?.profiles.map((p) => p.id) ?? [],
      limit: (profileId) => planLimitReached(usage.all()[profileId]),
      claudeRunning: runningClaude,
      startClaude: (workspaceId) => workspaces.startClaude(workspaceId),
      send: (workspaceId, prompt) => terminals.sendToClaude(workspaceId, prompt),
      // A suspended Claude's resume counts as its start (spec §9.8).
      onSpawn: (listener) => {
        const started = (info: SessionInfo) => {
          if (info.kind === 'claude' && info.workspaceId) listener(info.workspaceId);
        };
        const offSpawn = host.onSpawn(started);
        const offResume = host.onResume(started);
        return () => {
          offSpawn();
          offResume();
        };
      },
      onSessionStart: (listener) => status?.onSessionStart(listener) ?? (() => {}),
    });
    unfinished = continuing;
    // A Claude session's name: its workspace's task id or name, or its main checkout.
    const sessionLabel = (info: SessionInfo) => {
      const workspace = info.workspaceId ? workspaceRecords.get(info.workspaceId) : null;
      if (workspace) return workspace.task.id ?? workspace.name;
      const project = config.get().config?.projects.find((p) => p.id === info.projectId);
      return project ? `${project.name} (main checkout)` : info.title;
    };
    // Memory used by Claude sessions (spec §6.14).
    const monitor = new MemoryMonitor({
      sessions: () => host.processes('claude'),
      label: sessionLabel,
      readProcesses: () => readProcessTable(),
      appProcesses: () =>
        app
          .getAppMetrics()
          .map((m) => ({ pid: m.pid, fallbackBytes: m.memory.workingSetSize * 1024 })),
      visible: () => BrowserWindow.getAllWindows().some((w) => w.isVisible() && !w.isMinimized()),
      // Fixed numbers for the Guide's screenshots; scripted test runs only.
      fixed: testWindows() ? parseFixedMemory(process.env[envVar('TEST_MEMORY')]) : null,
    });
    memory = monitor;
    host.onExit(() => monitor.sessionsChanged());
    // A suspended session leaves the numbers at once (spec §9.8).
    host.onSuspend(() => monitor.sessionsChanged());
    // A new session shows in the counts within a moment, not at the next measurement.
    const measureSoon = (info: SessionInfo) => {
      if (info.kind === 'claude') setTimeout(() => void monitor.refresh(), 1_000);
    };
    host.onSpawn(measureSoon);
    host.onResume(measureSoon);
    monitor.start();
    atShutdown(() => monitor.stop());
    // Suspending idle sessions (spec §9.8). A shorter minute is for the e2e tests only.
    const minuteOverride = Number(process.env[envVar('SUSPEND_MINUTE_MS')]);
    const platform = statusPlatform;
    const suspend = new SuspendService({
      host,
      delayMin: (profileId) => {
        const profile = config.get().config?.profiles.find((p) => p.id === profileId);
        return profile ? suspendDelay(profile) : null;
      },
      workspace: (workspaceId) => workspaceRecords.get(workspaceId),
      mainCheckoutKept: (projectId) => workspaceRecords.keptMainCheckouts().includes(projectId),
      shown: () => platform.shown(),
      resume: (info) =>
        info.workspaceId
          ? workspaces.startClaude(info.workspaceId)
          : terminals.resumeClaudeInProject(info.id, suspend.restoreArgs(info.id)),
      followMainClaude: (sessionId, claudeId) => terminals.followMainClaude(sessionId, claudeId),
      // app.log (spec §3.4): "suspend Alpha (Personal): clock reset: a draft in the prompt".
      label: (info) => {
        const profile = config.get().config?.profiles.find((p) => p.id === info.profileId);
        return `${sessionLabel(info)} (${profile?.name ?? info.profileId})`;
      },
      log: appLog,
      ...(minuteOverride > 0 ? { minuteMs: minuteOverride } : {}),
    });
    suspender = suspend;
    bridge.onHook((message) => suspend.handleHook(message));
    bridge.onStatusLine((message) => suspend.handleStatusLine(message));
    terminals.wake = (info) => suspend.wake(info);
    workspaces.suspendAtStart = (profileId) => {
      const profile = config.get().config?.profiles.find((p) => p.id === profileId);
      return profile ? suspendDelay(profile) !== null : false;
    };
    workspaces.restoreArgs = (sessionId) => suspend.restoreArgs(sessionId);
    platform.onShown(() => suspend.checkShown());
    suspend.start();
    atShutdown(() => suspend.stop());
    // Notes per workspace (spec §6.15): sent through the quick reply's path,
    // held ones when Claude finishes its turn.
    const noteRecords = new NoteRecords(db);
    const notes = new NotesService({
      notes: noteRecords,
      records: workspaceRecords,
      decorate: (w) => workflow.decorate(w),
      sessions: () => host.list(),
      hasDraft: (id) => suspend.hasDraft(id),
      send: (workspaceId, prompt) => terminals.sendToClaude(workspaceId, prompt),
    });
    status.onConversation(({ workspaceId, event, text }) => {
      if (event !== 'SessionStart') notes.conversation(workspaceId, event, text);
    });
    notes.start();
    atShutdown(() => notes.stop());
    workspaces.adoptPrefill = (projectId, worktree, branch) =>
      workflow.prefill(projectId, worktree, branch);
    // Worktrees made outside the app, by a skill or by hand (spec §13.6).
    const worktreeNotices = new WorktreeNotices(config, workspaces);
    void worktreeNotices.start();
    app.on('browser-window-focus', () => worktreeNotices.focused());
    atShutdown(() => worktreeNotices.dispose());
    // A remote added to a project that had none (spec §6.10).
    const remoteWatch = new RemoteWatch(config, projects);
    remoteWatch.start();
    app.on('browser-window-focus', () => remoteWatch.focused());
    atShutdown(() => remoteWatch.dispose());
    app.on('browser-window-focus', () => workflow.refreshAll());
    atShutdown(() => {
      workflow.dispose();
      workflow.lookups?.dispose();
      workflowSetup.dispose();
    });
    // The command line tool (spec §7.5, §21.9).
    const cliLink = new CliLinkService(config, workspaceRecords, projects, workspaces);
    bridge.handleCli({
      add: (request) => projects.addFromCli(request),
      link: (request) => cliLink.link(request),
      projects: (request) => cliLink.projectList(request),
      sessionNote: (workspaceId) => cliLink.sessionNote(workspaceId),
    });
    // PR status (spec §12.4): every 5 minutes, and when the window gains focus.
    const finish = new FinishService(config, workspaceRecords, terminals);
    // Merge into the base (spec §14.4): Claude's turn ending tries again.
    const merge = new MergeService(
      workspaceRecords,
      finish,
      (workspaceId, prompt) => terminals.sendToClaude(workspaceId, prompt),
      status,
    );
    const prTimer = setInterval(() => void finish.refreshAll(), PR_POLL_MS);
    atShutdown(() => clearInterval(prTimer));
    let lastFocusCheck = 0;
    app.on('browser-window-focus', () => {
      if (Date.now() - lastFocusCheck < 60_000) return;
      lastFocusCheck = Date.now();
      void finish.refreshAll();
    });
    // Open in editor (spec §6.13), in the profile's environment.
    const editors = new EditorService(
      config,
      async (profileId, projectId) => {
        const context = await terminals.lookupContext(profileId, projectId);
        return { env: context.env, shell: context.shell };
      },
      dataDir,
    );
    serveTrpcOverIpc({
      finish,
      merge,
      editors,
      quit: { asker: quitAsker, answer: (quit: boolean) => answerQuit?.(quit) },
      unfinished: continuing,
      updates: {
        service: updates,
        installer,
        // The terminal gets the user's login environment, not the app's (AppImage paths included).
        inTerminal: async (release) =>
          startUpdate(release, {
            platform: process.platform,
            arch: process.arch,
            appImage: Boolean(process.env.APPIMAGE),
            packaged: app.isPackaged,
            env: (await env.login()).env,
            terminal: process.env[envVar('UPDATE_TERMINAL')],
            commandDir: updateRoot(dataDir),
          }),
      },
      closeNotice: {
        asker: closeNoticeAsker,
        answer: (close: boolean) => answerCloseNotice?.(close),
      },
      menuRequests,
      feedback,
      helper,
      usage,
      memory: monitor,
      suspend,
      suspendNotice,
      notes,
      noteRecords,
      status,
      statusPlatform,
      setup,
      profiles: new ProfileService(config, env),
      config,
      db,
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
    });
    showMainWindow();
    showMigrationNotice(dataDir);
    updates.start();
    // Claude resumes where it ran (spec §9.4); then interrupted work is
    // continued or asked about (§9.7).
    // With suspension on, the rest start suspended; the shown one resumes (§9.8).
    void continuing.atLaunch(workspaces.resumeAtLaunch().then(() => suspender?.checkShown()));
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) showMainWindow();
    });
  });

  // Sessions keep running without windows (spec §5). Quitting (⌘Q, the app
  // menu's and the Dock's Quit, closing the window where that quits) asks first
  // when it would interrupt something (the §5 count), then stops everything and
  // quits completely.
  let stopped = false;
  let asking = false;
  // A SIGTERM (logout, a test runner) or SIGHUP (the end of the desktop
  // session) quits without asking: nobody is there to answer. The window's
  // remembered preferences go to disk first, before anything else: at logout
  // every process of the app is signalled at once, and the app may not get far.
  let askBeforeQuit = true;
  /** The desktop session ends (logout, shutdown): a staged update waits (spec §15.7). */
  let sessionEnding = false;
  const quitBySignal = () => {
    saveWindowState();
    askBeforeQuit = false;
    app.quit();
  };
  // Chromium installs its own SIGTERM handler during startup, which quits like
  // ⌘Q (and so asks); this one replaces it once the app is ready.
  app.whenReady().then(() => {
    process.removeAllListeners('SIGTERM');
    process.on('SIGTERM', quitBySignal);
    process.removeAllListeners('SIGHUP');
    process.on('SIGHUP', quitBySignal);
    powerMonitor.on('shutdown', () => {
      sessionEnding = true;
      saveWindowState();
    });
  });
  app.on('before-quit', (event) => {
    if (stopped || host.runningCount() === 0) {
      quitting = true;
      // Nothing cancels the quit from here: no session may start (spec §5).
      stopAccepting();
      return;
    }
    event.preventDefault();
    // ⌘Q again while the dialog asks confirms it (components.md: Quit is ⌘Q).
    if (asking) {
      answerQuit?.(true);
      return;
    }
    void (async () => {
      const busySessions = host.busySessions();
      const busy = busySessions.length;
      if (busy > 0 && askBeforeQuit && quitAsker.listenerCount('request') > 0 && mainWindow) {
        // The design's dialog in the window, listing each session (spec §5).
        asking = true;
        bringForward(mainWindow);
        const quit = await new Promise<boolean>((resolve) => {
          answerQuit = resolve;
          quitAsker.emit(
            'request',
            busySessions.map((s) => s.id),
          );
        }).finally(() => {
          asking = false;
          answerQuit = null;
        });
        if (!quit) {
          updateInstaller?.quitCancelled();
          return;
        }
      } else if (busy > 0 && askBeforeQuit) {
        asking = true;
        const sessions = plural(busy, 'running session');
        const options = {
          type: 'warning' as const,
          message: `Stop ${sessions}?`,
          detail: `Quitting stops ${busy === 1 ? 'it' : 'them'}. ${
            unfinished?.quitNote(claudeWorkspaces(busySessions)) ??
            'Claude conversations can be resumed later.'
          }`,
          buttons: ['Quit', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
        };
        const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
        const { response } = await (parent
          ? dialog.showMessageBox(parent, options)
          : dialog.showMessageBox(options)
        ).finally(() => {
          asking = false;
        });
        if (response !== 0) {
          updateInstaller?.quitCancelled();
          return;
        }
      }
      if (status) status.quitting = true;
      // What Claude was doing, before it stops (spec §9.7).
      unfinished?.atQuit(claudeWorkspaces(host.list().filter((s) => s.status === 'running')));
      stopAccepting();
      await host.stopAll();
      stopped = true;
      app.quit();
    })();
  });

  // Closing the window quits on Linux and Windows (onWindowClose); this covers a
  // window that went away without a close event.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
