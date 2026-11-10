import { lastParagraph } from '@shared/last-words';
import {
  composePrompt,
  entryOf,
  type HeldSendDecision,
  heldSendDecision,
  matchSends,
  type Note,
} from '@shared/notes';
import { cachedConversation } from '../claude/last-words';
import type { TranscriptResponse } from '../claude/transcript';
import type { NoteRecords, NoteSend } from '../db/notes';
import { type ReplyDeps, replyFacts, replyRefusalOf, settledReplyFacts } from '../services/reply';

export interface NotesDeps extends ReplyDeps {
  notes: NoteRecords;
  /** Types the prompt into the workspace's Claude, as the quick reply does (spec §6.7). */
  send: (workspaceId: string, prompt: string) => Promise<void>;
  /** A Claude's prompt started or stopped holding a draft (spec §9.8). */
  onDraftChange?: (listener: (workspaceId: string) => void) => () => void;
  /** A Claude session started, exited, was suspended or resumed. */
  onSessionsChange?: (listener: () => void) => () => void;
}

/** A sent item's prompt, as the Notes panel shows it (spec §6.15). */
export interface SentPrompt {
  id: string;
  sentAt: string;
  /** Its Responses entry (0-based) in the current conversation; null when it isn't there. */
  entry: number | null;
  /** Found in the transcript, but not in the conversation Claude has now (`/clear`, a new session). */
  elsewhere: boolean;
}

export interface NotesView {
  notes: Note[];
  /** What held items wait on; null without held items. */
  waiting: string | null;
  sends: SentPrompt[];
}

/**
 * How often held items look again while some wait: for what sends no event,
 * such as Claude's question tool, which shows only in the transcript.
 */
const RECHECK_MS = 2_000;

/**
 * Notes per workspace (spec §6.15): Send now through the quick reply's path
 * and rules, Send when Claude is done (held until Claude finishes its turn),
 * and each sent prompt found in the transcript, for View response and the
 * Responses panel's "from notes" label.
 */
export class NotesService {
  /** The text of each workspace's last Stop, until its next prompt: how the turn ended. */
  private readonly lastStop = new Map<string, string | null>();
  /** Held sends under way, so a change while one is typed doesn't send it twice. */
  private readonly sending = new Set<string>();
  /** Why a held send failed, until the workspace's state changes. */
  private readonly failed = new Map<string, { state: string; message: string }>();
  private timer: NodeJS.Timeout | null = null;
  private readonly offs: (() => void)[] = [];

  constructor(private readonly deps: NotesDeps) {}

  /** Watches for Claude finishing its turn; held items go then. */
  start(): void {
    this.offs.push(this.deps.records.onChange(() => this.checkHeld()));
    this.offs.push(this.deps.notes.onChange((workspaceId) => this.checkHeld(workspaceId)));
    // A draft cleared in the terminal (⌫, ⌃U, ⌃C…): held items go at once,
    // also when Claude was done already and nothing else changes.
    if (this.deps.onDraftChange) {
      this.offs.push(this.deps.onDraftChange((workspaceId) => this.checkHeld(workspaceId)));
    }
    if (this.deps.onSessionsChange)
      this.offs.push(this.deps.onSessionsChange(() => this.checkHeld()));
    this.checkHeld();
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * A prompt or a Stop from the hooks (spec §10.1): a Stop's last message says
   * whether Claude ended its turn with a question; a prompt starts a new turn.
   */
  conversation(workspaceId: string, event: 'UserPromptSubmit' | 'Stop', text: string | null): void {
    if (event === 'Stop') this.lastStop.set(workspaceId, text);
    else this.lastStop.delete(workspaceId);
  }

  /**
   * Whether Claude's turn ended with a question in its text: its last
   * message's last paragraph ends with "?" (as the Board's "Claude asked:",
   * spec §6.7). From the Stop when there was one since the app started, else
   * from the transcript's newest entry.
   */
  private asked(workspaceId: string): boolean {
    const endsAsking = (text: string | null | undefined) =>
      !!text && lastParagraph(text).endsWith('?');
    if (this.lastStop.has(workspaceId)) return endsAsking(this.lastStop.get(workspaceId));
    const { responses } = cachedConversation(this.deps.records.transcriptPath(workspaceId));
    const last = responses
      .at(-1)
      ?.parts.filter((p) => !p.question)
      .at(-1);
    return endsAsking(last?.text);
  }

  /** Whether held items of the workspace go now, or what they wait on. */
  decision(workspaceId: string): HeldSendDecision {
    const facts = replyFacts(this.deps, workspaceId);
    if (!facts) return { send: false, waiting: 'This workspace no longer exists' };
    const w = facts.workspace;
    return heldSendDecision({
      state: w.state,
      gate: w.workflow?.kind === 'gate' ? (w.workflow.label ?? null) : null,
      claude: facts.claude,
      draft: facts.draft,
      atPrompt: facts.atPrompt,
      question: facts.question,
      asked: w.state === 'done' && this.asked(workspaceId),
    });
  }

  /** Sends the held items of every workspace (or one) whose Claude is done. */
  checkHeld(only?: string): void {
    const held = this.deps.notes.heldWorkspaces();
    this.recheckWhile(held.length > 0);
    for (const workspaceId of held) {
      if (only && workspaceId !== only) continue;
      if (this.sending.has(workspaceId)) continue;
      const state = this.deps.records.get(workspaceId)?.state ?? '';
      const failed = this.failed.get(workspaceId);
      if (failed && failed.state === state) continue;
      this.failed.delete(workspaceId);
      if (this.decision(workspaceId).send) void this.sendHeld(workspaceId, state);
    }
  }

  private recheckWhile(held: boolean): void {
    if (held && !this.timer) this.timer = setInterval(() => this.checkHeld(), RECHECK_MS);
    if (!held && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async sendHeld(workspaceId: string, state: string): Promise<void> {
    this.sending.add(workspaceId);
    try {
      const ids = this.deps.notes.held(workspaceId).map((n) => n.id);
      await this.deliver(workspaceId, ids, 'held');
    } catch (error) {
      this.failed.set(workspaceId, {
        state,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.sending.delete(workspaceId);
    }
  }

  /**
   * Send now (spec §6.15): through the quick reply's path, after its checks:
   * never into a permission menu or a question, never over a draft; a
   * suspended Claude resumes first.
   */
  async sendNow(workspaceId: string, ids: readonly string[]): Promise<void> {
    // Just after the prompt shows, its report may still be on the way.
    const facts = await settledReplyFacts(this.deps, workspaceId);
    if (!facts) throw new Error('This workspace no longer exists');
    const refusal = replyRefusalOf(facts);
    if (refusal) throw new Error(refusal);
    await this.deliver(workspaceId, ids, 'open');
  }

  /**
   * Marks the items sent (before typing, so nothing goes twice), then types
   * the prompt; if that fails, they go back to `back` and the error is thrown.
   */
  private async deliver(
    workspaceId: string,
    ids: readonly string[],
    back: 'open' | 'held',
  ): Promise<void> {
    const { notes } = this.deps;
    const before = new Map(notes.list(workspaceId).map((n) => [n.id, n.state]));
    const marked = notes.markSent(
      workspaceId,
      ids,
      composePrompt,
      this.deps.records.transcriptPath(workspaceId),
    );
    if (!marked) throw new Error('Nothing to send: the notes are empty or already sent');
    try {
      await this.deps.send(workspaceId, marked.send.text);
    } catch (error) {
      notes.unsend(
        workspaceId,
        marked.send.id,
        marked.notes.map((n) => ({
          id: n.id,
          state: back === 'held' && before.get(n.id) === 'held' ? 'held' : 'open',
        })),
      );
      throw error;
    }
  }

  /**
   * Finds the workspace's sent prompts in its transcripts (spec §6.15): the
   * one current when each was sent, then the current one. A match is kept.
   */
  private match(workspaceId: string): NoteSend[] {
    const sends = this.deps.notes.sends(workspaceId);
    const current = this.deps.records.transcriptPath(workspaceId);
    const files = new Set<string>();
    for (const s of sends) if (!s.ref && s.transcriptPath) files.add(s.transcriptPath);
    if (current && sends.some((s) => !s.ref)) files.add(current);
    for (const file of files) {
      const open = sends.filter((s) => !s.ref);
      if (open.length === 0) break;
      const { responses } = cachedConversation(file);
      for (const [sendId, ref] of matchSends(responses, open)) {
        this.deps.notes.setRef(sendId, ref, file);
        const send = sends.find((s) => s.id === sendId);
        if (send) {
          send.ref = ref;
          send.refTranscript = file;
        }
      }
    }
    return sends;
  }

  /** The Notes panel's items, what held ones wait on, and where each sent prompt is. */
  view(workspaceId: string): NotesView {
    const notes = this.deps.notes.list(workspaceId);
    const current = this.deps.records.transcriptPath(workspaceId);
    const { responses } = cachedConversation(current);
    const sends = notes.some((n) => n.state === 'sent') ? this.match(workspaceId) : [];
    const held = notes.some((n) => n.state === 'held');
    const decision = held ? this.decision(workspaceId) : null;
    const failed = this.failed.get(workspaceId)?.message;
    return {
      notes,
      waiting: failed ?? (decision && !decision.send ? decision.waiting : null),
      sends: sends.map((s) => {
        const here = s.ref !== null && s.refTranscript === current;
        return {
          id: s.id,
          sentAt: s.sentAt,
          entry: here && s.ref ? entryOf(responses, s.ref) : null,
          elsewhere: s.ref !== null && !here,
        };
      }),
    };
  }

  /**
   * The items each Responses entry was sent from (spec §6.15), by entry
   * (0-based), for the panel's "from notes" label; `responses` are the
   * current transcript's.
   */
  entryNotes(workspaceId: string, responses: readonly TranscriptResponse[]): Map<number, string[]> {
    const current = this.deps.records.transcriptPath(workspaceId);
    const notes = this.deps.notes.list(workspaceId).filter((n) => n.state === 'sent');
    const byEntry = new Map<number, string[]>();
    if (notes.length === 0) return byEntry;
    for (const s of this.match(workspaceId)) {
      if (!s.ref || s.refTranscript !== current) continue;
      const entry = entryOf(responses, s.ref);
      if (entry === null) continue;
      const ids = notes.filter((n) => n.sendId === s.id).map((n) => n.id);
      if (ids.length > 0) byEntry.set(entry, [...(byEntry.get(entry) ?? []), ...ids]);
    }
    return byEntry;
  }
}
