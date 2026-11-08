import fs from 'node:fs';
import { chooseLastWords, type LastWords } from '@shared/last-words';
import type { Workspace } from '@shared/workspaces';
import { type Conversation, parseConversation } from './transcript';

/** The transcripts read last, by path, with their size and time. */
const cache = new Map<string, { signature: string; conversation: Conversation }>();
const NONE: Conversation = { responses: [], pending: null };

/**
 * A transcript's entries and pending question, read again only when its size
 * or time changed: Home asks for every card every few seconds (spec §6.7).
 * Read-only (decision D12); a missing or unreadable file gives none.
 */
export function cachedConversation(file: string | null): Conversation {
  if (!file) return NONE;
  let signature: string;
  try {
    const stat = fs.statSync(file);
    signature = `${stat.size}:${stat.mtimeMs}`;
  } catch {
    cache.delete(file);
    return NONE;
  }
  const kept = cache.get(file);
  if (kept?.signature === signature) return kept.conversation;
  let conversation: Conversation;
  try {
    conversation = parseConversation(fs.readFileSync(file, 'utf8'));
  } catch {
    return NONE;
  }
  cache.set(file, { signature, conversation });
  return conversation;
}

/** Forgets transcripts no workspace names any more. */
export function pruneConversations(files: readonly (string | null)[]): void {
  const keep = new Set(files);
  for (const file of cache.keys()) if (!keep.has(file)) cache.delete(file);
}

/**
 * What the workspace's Board card shows above its quick reply (spec §6.7),
 * from its transcript and its workflow status; null when there's nothing.
 */
export function lastWordsOf(w: Workspace, file: string | null): LastWords | null {
  const { responses, pending } = cachedConversation(file);
  const gate =
    w.state === 'awaiting-approval' && w.workflow?.kind === 'gate'
      ? { label: w.workflow.label ?? 'the gate', hint: w.workflow.hint ?? null }
      : null;
  return chooseLastWords(responses, { pending, gate });
}
