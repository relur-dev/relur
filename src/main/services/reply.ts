import {
  boardColumn,
  type QuickReply,
  type QuickReplyFacts,
  quickReply,
  replyRefusal,
} from '@shared/home';
import type { SessionInfo } from '@shared/terminal-protocol';
import type { Workspace } from '@shared/workspaces';
import { cachedConversation } from '../claude/last-words';
import type { WorkspaceRecords } from '../db/workspaces';

export interface ReplyDeps {
  records: WorkspaceRecords;
  /** The workspace with its workflow status: Awaiting approval at a gate (spec §13.5). */
  decorate: (w: Workspace) => Workspace;
  sessions: () => SessionInfo[];
  /** Text typed into this Claude's prompt and not sent (spec §9.8). */
  hasDraft: (sessionId: string) => boolean;
  /** Claude shows its prompt after its SessionStart (spec §9.8). */
  atPrompt: (sessionId: string) => boolean;
  /** Waits up to `ms` for `atPrompt` to become true (see `settledReplyFacts`). */
  whenAtPrompt?: (sessionId: string, ms: number) => Promise<boolean>;
}

/**
 * How long a reply waits for a Claude in Starting to be seen at its prompt:
 * the view reports the input box about 150 ms after it is drawn, and
 * SessionStart may come just after that.
 */
export const PROMPT_SEEN_WAIT_MS = 1000;

export interface ReplyFacts extends QuickReplyFacts {
  workspace: Workspace;
  claudeId: string | null;
}

/**
 * What decides whether text may be typed into a workspace's Claude (spec
 * §6.7, §6.15): its state, its Claude, a draft, Claude's question tool.
 * Null for a workspace that no longer exists.
 */
export function replyFacts(deps: ReplyDeps, workspaceId: string): ReplyFacts | null {
  const record = deps.records.get(workspaceId);
  if (!record) return null;
  const workspace = deps.decorate(record);
  const claude =
    deps
      .sessions()
      .find((s) => s.workspaceId === workspaceId && s.kind === 'claude' && s.status !== 'exited') ??
    null;
  return {
    workspace,
    claudeId: claude?.id ?? null,
    claude,
    draft: claude ? deps.hasDraft(claude.id) : false,
    atPrompt: claude ? deps.atPrompt(claude.id) : false,
    question: cachedConversation(deps.records.transcriptPath(workspaceId)).pending !== null,
  };
}

/**
 * `replyFacts` for an action the user just took (spec §6.7): a Claude in
 * Starting that runs but isn't seen at its prompt yet gets a moment, since
 * its prompt may already be on screen with its report on the way; the facts
 * are read again after it. Any other case is decided at once.
 */
export async function settledReplyFacts(
  deps: ReplyDeps,
  workspaceId: string,
): Promise<ReplyFacts | null> {
  const facts = replyFacts(deps, workspaceId);
  if (!facts?.claudeId || !deps.whenAtPrompt) return facts;
  const { claude } = facts;
  if (facts.workspace.state !== 'starting' || facts.atPrompt) return facts;
  if (claude?.status !== 'running' || claude.resuming) return facts;
  await deps.whenAtPrompt(facts.claudeId, PROMPT_SEEN_WAIT_MS);
  return replyFacts(deps, workspaceId);
}

/** The quick reply's offer for these facts, as the card's column would give it. */
export const replyOffer = (facts: ReplyFacts): QuickReply =>
  // The card's column: what is left to ship decides only between two that both offer it.
  quickReply(facts.workspace, boardColumn(facts.workspace, null), facts);

/** Why text can't be typed into the workspace's Claude now, by its real reason; null when it can. */
export const replyRefusalOf = (facts: ReplyFacts): string | null =>
  replyRefusal(facts.workspace, boardColumn(facts.workspace, null), facts);
