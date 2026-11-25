import { randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { BRAND } from '@shared/brand';
import type { MergePrsPreflight, MergePrsReport } from '@shared/merge-prs';

/** A hook event as the helper forwards it (spec §10.1). */
export interface HookMessage {
  event: string;
  workspaceId: string | null;
  profileId: string | null;
  /** The app's terminal session of the Claude that sent it (spec §9.2); null from older helpers. */
  sessionId?: string | null;
  payload: unknown;
}

/** Status line data as the helper forwards it (spec §11). */
export interface StatusLineMessage {
  profileId: string | null;
  workspaceId: string | null;
  sessionId?: string | null;
  rateLimits: unknown;
  /** The session's model id (spec §9.8). */
  model?: string | null;
}

/** The command line tool's request (spec §7.5). */
export interface AddRequest {
  path: string;
  profileId: string | null;
  name: string | null;
  base: string | null;
  /** The profile of the terminal it was run from, if any (`<PREFIX>PROFILE`). */
  terminalProfileId: string | null;
  /** `--all`: add every repository one level down in `path` (spec §7.5). */
  all?: boolean;
  /** `--new`: make a new repository at `path` first (spec §7.5). */
  create?: { readme: boolean; gitignore: boolean } | null;
}

export interface AddedProject {
  id: string;
  profileId: string;
  repoPath: string;
  baseBranch: string;
}

/** One repository of `add <folder> --all`. */
export interface FolderAddLine {
  repoPath: string;
  status: 'added' | 'already-added' | 'refused';
  /** The project when added; otherwise why not. */
  project?: AddedProject;
  error?: string;
}

export type AddResult =
  | { ok: true; project: AddedProject }
  | { ok: true; results: FolderAddLine[] }
  | { ok: false; error: string };

/** `<slug> link <project>` (spec §21.9), from a workspace's Claude or terminals. */
export interface LinkRequest {
  /** A project id or name of the profile, or a path to a repository. */
  project: string;
  /** Where it was run, for a relative path. */
  cwd: string | null;
  /** `<PREFIX>WORKSPACE_ID` and `<PREFIX>PROFILE` of the caller. */
  workspaceId: string | null;
  profileId: string | null;
  /** Run by Claude's Bash tool (`CLAUDECODE` set). */
  byClaude: boolean;
}

export type LinkResponse =
  | {
      ok: true;
      name: string;
      projectId: string;
      /** The repository wasn't a project yet and was added to the profile. */
      added: boolean;
      worktreePath: string;
      branch: string;
      baseBranch: string;
      /** It had a setup, run in a Setup tab, which has finished. */
      setup: boolean;
      /** Why its setup failed (`exit 1`); null when it passed or there was none. */
      setupError: string | null;
    }
  | { ok: false; error: string };

/** `<slug> merge` (spec §21.10), from a workspace's Claude or terminals. */
export interface MergeCliRequest {
  /** `preflight` checks every repository; `merge` merges them in order. */
  action: 'preflight' | 'merge';
  workspaceId: string | null;
  /** Repository names or ids from `--order`; the rest follow in the default order. */
  order: string[];
  /** `--method <repo>=<method>`, by name or id. */
  methods: Record<string, string>;
  /** Not `--keep-branch`. */
  deleteBranch: boolean;
  /** Run by Claude's Bash tool (`CLAUDECODE` set); only for the dialog's "who asked". */
  byClaude: boolean;
}

export type MergeCliResponse =
  | { ok: true; branch: string; preflight: MergePrsPreflight | null; report: MergePrsReport | null }
  | { ok: false; error: string };

/** `<slug> projects` (spec §21.9). */
export interface ProjectsRequest {
  workspaceId: string | null;
  profileId: string | null;
}

export type ProjectsResponse =
  | {
      ok: true;
      projects: {
        id: string;
        name: string;
        repoPath: string;
        /** Its part in the calling workspace; null outside one. */
        inWorkspace: 'main' | 'linked' | 'no' | null;
      }[];
    }
  | { ok: false; error: string };

/** The handlers behind the command line tool's routes. */
export interface CliHandlers {
  add: (request: AddRequest) => Promise<AddResult>;
  link: (request: LinkRequest) => Promise<LinkResponse>;
  projects: (request: ProjectsRequest) => ProjectsResponse;
  merge: (request: MergeCliRequest) => Promise<MergeCliResponse>;
  /** Context for Claude at SessionStart in a workspace (spec §21.9), or null. */
  sessionNote: (workspaceId: string | null) => string | null;
}

const MAX_BODY = 1024 * 1024;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);

/**
 * The hook bridge (spec §10.1): an HTTP server on 127.0.0.1 and a random
 * port. Every request carries the token generated at launch. Hooks and the
 * status line are fire-and-forget (SessionStart's reply carries Claude's
 * note, §21.9); the command line tool's routes wait for their answer.
 */
export class HookBridge {
  readonly token = randomBytes(32).toString('hex');
  private server: http.Server | null = null;
  private readonly events = new EventEmitter();
  private cli: CliHandlers | null = null;
  private port = 0;
  /** Set once quitting goes ahead: requests are refused and nothing is dispatched (spec §5). */
  private closed = false;

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    const server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    this.port = (server.address() as AddressInfo).port;
    this.server = server;
  }

  /**
   * Refuses every request from now on (503), so no hook event, status line or
   * command reaches the app while it shuts down; the helper's hooks still
   * exit 0. The server itself stops with stop().
   */
  close(): void {
    this.closed = true;
  }

  stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  onHook(listener: (message: HookMessage) => void): () => void {
    this.events.on('hook', listener);
    return () => this.events.off('hook', listener);
  }

  onStatusLine(listener: (message: StatusLineMessage) => void): () => void {
    this.events.on('statusline', listener);
    return () => this.events.off('statusline', listener);
  }

  handleCli(handlers: CliHandlers): void {
    this.cli = handlers;
  }

  /**
   * `cli.json` in the app config dir (spec §7.5): the address and token for
   * the command line tool outside the app's terminals, readable by the user
   * only. Removed on quit.
   */
  writeCliFile(file: string): void {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(
      tmp,
      `${JSON.stringify({ url: this.url, token: this.token, pid: process.pid })}\n`,
      {
        mode: 0o600,
      },
    );
    fs.renameSync(tmp, file);
  }

  private authorized(req: http.IncomingMessage): boolean {
    const header = req.headers.authorization ?? '';
    const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
    const expected = Buffer.from(this.token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST' || !this.authorized(req)) return reply(403, { error: 'forbidden' });

    // An oversized body is read to the end but not kept, so the reply arrives.
    let size = 0;
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size <= MAX_BODY) chunks.push(chunk as Buffer);
      }
    } catch {
      return;
    }
    if (size > MAX_BODY) return reply(413, { error: 'too large' });
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return reply(400, { error: 'invalid JSON' });
    }
    if (!isRecord(body)) return reply(400, { error: 'expected an object' });
    if (this.closed) return reply(503, { ok: false, error: `${BRAND.displayName} is quitting` });

    switch (req.url) {
      case '/hook': {
        const event = str(body.event);
        if (!event) return reply(400, { error: 'missing event' });
        const workspaceId = str(body.workspaceId);
        let additionalContext: string | null = null;
        if (event === 'SessionStart') {
          try {
            additionalContext = this.cli?.sessionNote(workspaceId) ?? null;
          } catch {
            // Never in the way of Claude starting.
          }
        }
        reply(200, additionalContext ? { additionalContext } : {});
        this.events.emit('hook', {
          event,
          workspaceId,
          profileId: str(body.profileId),
          sessionId: str(body.sessionId),
          payload: body.payload ?? null,
        } satisfies HookMessage);
        return;
      }
      case '/statusline':
        reply(200, {});
        this.events.emit('statusline', {
          profileId: str(body.profileId),
          workspaceId: str(body.workspaceId),
          sessionId: str(body.sessionId),
          rateLimits: body.rateLimits ?? null,
          model: str(body.model),
        } satisfies StatusLineMessage);
        return;
      case '/add': {
        if (!this.cli) return reply(503, { ok: false, error: 'not ready' });
        const path = str(body.path);
        if (!path) return reply(400, { ok: false, error: 'missing path' });
        const result = await this.cli
          .add({
            path,
            profileId: str(body.profileId),
            name: str(body.name),
            base: str(body.base),
            terminalProfileId: str(body.terminalProfileId),
            all: body.all === true,
            create:
              body.create && typeof body.create === 'object'
                ? {
                    readme: (body.create as { readme?: unknown }).readme !== false,
                    gitignore: (body.create as { gitignore?: unknown }).gitignore !== false,
                  }
                : null,
          })
          .catch((error: unknown): AddResult => ({ ok: false, error: message(error) }));
        return reply(200, result);
      }
      case '/link': {
        if (!this.cli) return reply(503, { ok: false, error: 'not ready' });
        const project = str(body.project);
        if (!project) return reply(400, { ok: false, error: 'missing project' });
        const result = await this.cli
          .link({
            project,
            cwd: str(body.cwd),
            workspaceId: str(body.workspaceId),
            profileId: str(body.profileId),
            byClaude: body.byClaude === true,
          })
          .catch((error: unknown): LinkResponse => ({ ok: false, error: message(error) }));
        return reply(200, result);
      }
      case '/merge': {
        if (!this.cli) return reply(503, { ok: false, error: 'not ready' });
        const action = body.action === 'merge' ? 'merge' : 'preflight';
        const order = Array.isArray(body.order)
          ? body.order.filter((v): v is string => typeof v === 'string')
          : [];
        const methods = isRecord(body.methods)
          ? Object.fromEntries(
              Object.entries(body.methods).filter(
                (e): e is [string, string] => typeof e[1] === 'string',
              ),
            )
          : {};
        const result = await this.cli
          .merge({
            action,
            workspaceId: str(body.workspaceId),
            order,
            methods,
            deleteBranch: body.deleteBranch !== false,
            byClaude: body.byClaude === true,
          })
          .catch((error: unknown): MergeCliResponse => ({ ok: false, error: message(error) }));
        return reply(200, result);
      }
      case '/projects': {
        if (!this.cli) return reply(503, { ok: false, error: 'not ready' });
        let result: ProjectsResponse;
        try {
          result = this.cli.projects({
            workspaceId: str(body.workspaceId),
            profileId: str(body.profileId),
          });
        } catch (error) {
          result = { ok: false, error: message(error) };
        }
        return reply(200, result);
      }
      default:
        return reply(404, { error: 'not found' });
    }
  }
}
