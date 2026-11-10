import fs from 'node:fs';
import path from 'node:path';
import { type ClaudeRoots, claudePastes, type DroppedFile, shellText } from '@shared/dropped-paths';
import { insertRefusal } from '@shared/home';
import type { WorkspaceState } from '@shared/status';
import type { SessionInfo } from '@shared/terminal-protocol';
import type { Workspace } from '@shared/workspaces';
import type { SessionHost } from '../sessions/host';
import { PROMPT_SEEN_WAIT_MS, type ReplyDeps, settledReplyFacts } from './reply';

export interface InsertFilesDeps extends ReplyDeps {
  host: Pick<SessionHost, 'list' | 'typeAsUser' | 'outputEnd'>;
  /** A suspended Claude resumes and is ready (spec §9.8). */
  wake: (session: SessionInfo) => Promise<void>;
  /** A main checkout's Claude, from its hooks; null for a workspace's. */
  mainClaude: (sessionId: string) => { state: WorkspaceState; asking: boolean } | null;
  /** The prompt holds a draft with no space before the cursor. */
  spaceBefore: (sessionId: string) => boolean;
}

/** What the renderer does with the files: a shell's text to paste, or nothing (Claude has them). */
export type InsertResult = { paste: string } | { inserted: number };

const real = (p: string) => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
};

/** The files as they are on disk; ones that no longer exist are left out. */
export function droppedFiles(paths: string[]): DroppedFile[] {
  const files: DroppedFile[] = [];
  for (const p of paths) {
    if (!path.isAbsolute(p)) continue;
    try {
      files.push({ path: p, real: real(p), folder: fs.statSync(p).isDirectory() });
    } catch {
      // Gone since it was dropped or chosen.
    }
  }
  return files;
}

/** Where a Claude session's `@path`s are relative to, and which folders get them. */
function claudeRoots(deps: InsertFilesDeps, session: SessionInfo): ClaudeRoots {
  const record = session.workspaceId ? deps.records.get(session.workspaceId) : null;
  if (record) return workspaceRoots(record);
  // A main checkout's Claude: its checkout; Claude in the home folder: none.
  return { cwd: real(session.cwd), roots: session.projectId ? [real(session.cwd)] : [] };
}

/** A workspace's Claude: its folder is the main worktree, its roots every repository's. */
const workspaceRoots = (w: Pick<Workspace, 'worktreePath' | 'repos'>): ClaudeRoots => ({
  cwd: real(w.worktreePath),
  roots: w.repos.map((r) => real(r.worktreePath)),
});

/**
 * Files dropped on or chosen for the Notes box (spec §6.15, §6.16): the text
 * that goes into the note, as Claude's prompt would get them, so a sent note
 * gives Claude the same `@path`s. Nothing is checked: the note isn't sent.
 */
export function notePathsText(
  records: Pick<ReplyDeps['records'], 'get'>,
  workspaceId: string,
  paths: string[],
): string {
  const record = records.get(workspaceId);
  if (!record) throw new Error('This workspace no longer exists');
  const files = droppedFiles(paths);
  if (files.length === 0) throw new Error('Those files no longer exist');
  return claudePastes(files, workspaceRoots(record), false).join('');
}

/**
 * Why files can't go into this Claude's prompt now (spec §6.16), by the quick
 * reply's facts; null when they can.
 */
async function claudeRefusal(deps: InsertFilesDeps, session: SessionInfo): Promise<string | null> {
  if (session.workspaceId) {
    const facts = await settledReplyFacts(deps, session.workspaceId);
    if (!facts) return 'This workspace no longer exists';
    return insertRefusal(facts.workspace, facts);
  }
  // A main checkout's Claude just after its prompt shows: as settledReplyFacts.
  const starting = deps.mainClaude(session.id)?.state ?? 'starting';
  if (starting === 'starting' && session.status === 'running' && !session.resuming) {
    await deps.whenAtPrompt?.(session.id, PROMPT_SEEN_WAIT_MS);
  }
  const main = deps.mainClaude(session.id);
  return insertRefusal(
    { state: main?.state ?? 'starting', unfinished: null },
    {
      claude: session,
      draft: false,
      atPrompt: deps.atPrompt(session.id),
      question: main?.asking ?? false,
    },
  );
}

/** Waits until the session's output has been quiet for a moment (at most `maxMs`). */
async function settled(
  host: InsertFilesDeps['host'],
  id: string,
  quietMs = 120,
  maxMs = 2000,
): Promise<void> {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  let end = host.outputEnd(id);
  let quietSince = Date.now();
  for (const stop = Date.now() + maxMs; Date.now() < stop; ) {
    await sleep(30);
    const now = host.outputEnd(id);
    if (now !== end) {
      end = now;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= quietMs) return;
  }
}

/**
 * Inserts dropped or chosen files into a terminal (spec §6.16), never
 * followed by Enter. Claude: at its prompt only (a suspended one resumes
 * first), one bracketed paste per file, the next once Claude's output
 * settles: it takes an image path's paste in the background, and pastes
 * that follow too soon land before it (checked live with 2.1.322). A shell:
 * the renderer pastes the quoted paths through its terminal, which wraps
 * them as a paste only where the shell asked for that.
 */
export async function insertFiles(
  deps: InsertFilesDeps,
  sessionId: string,
  paths: string[],
): Promise<InsertResult> {
  const find = () => deps.host.list().find((s) => s.id === sessionId);
  let session = find();
  if (!session || session.status === 'exited') throw new Error('This terminal has ended');
  const files = droppedFiles(paths);
  if (files.length === 0) throw new Error('Those files no longer exist');
  if (session.kind === 'shell' || session.kind === 'home') return { paste: shellText(files) };
  if (session.kind !== 'claude') throw new Error("Files can't be added here");

  const refusal = await claudeRefusal(deps, session);
  if (refusal) throw new Error(refusal);
  if (session.status === 'suspended' || session.resuming) {
    await deps.wake(session);
    session = find();
    if (session?.status !== 'running' || session.resuming) {
      throw new Error("Claude didn't resume; try again");
    }
  }
  const id = session.id;
  const pastes = claudePastes(files, claudeRoots(deps, session), deps.spaceBefore(id));
  for (const [i, text] of pastes.entries()) {
    if (i > 0) await settled(deps.host, id);
    deps.host.typeAsUser(id, `\x1b[200~${text}\x1b[201~`);
  }
  return { inserted: files.length };
}
