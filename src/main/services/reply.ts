import { boardColumn, type QuickReply, type QuickReplyFacts, quickReply } from '@shared/home';
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
}

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
    question: cachedConversation(deps.records.transcriptPath(workspaceId)).pending !== null,
  };
}

/** The quick reply's offer for these facts, as the card's column would give it. */
export const replyOffer = (facts: ReplyFacts): QuickReply =>
  // The card's column: what is left to ship decides only between two that both offer it.
  quickReply(facts.workspace, boardColumn(facts.workspace, null), facts);
