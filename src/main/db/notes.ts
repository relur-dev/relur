import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { MatchSend, Note, NoteCounts, NoteState } from '@shared/notes';
import { prepareOrSkip, type StateDb } from './state-db';

interface NoteRow {
  id: string;
  workspace_id: string;
  position: number;
  text: string;
  state: NoteState;
  created_at: string;
  updated_at: string;
  held_at: string | null;
  send_id: string | null;
  sent_at: string | null;
}

interface SendRow {
  id: string;
  workspace_id: string;
  text: string;
  sent_at: string;
  transcript_path: string | null;
  ref: string | null;
  ref_transcript: string | null;
}

/** A prompt notes went out in (spec §6.15), and where it was found in the transcript. */
export interface NoteSend extends MatchSend {
  workspaceId: string;
  /** The workspace's transcript when it was sent. */
  transcriptPath: string | null;
  /** The transcript it was found in; null until found. */
  refTranscript: string | null;
}

const toNote = (r: NoteRow): Note => ({
  id: r.id,
  workspaceId: r.workspace_id,
  text: r.text,
  state: r.state,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  heldAt: r.held_at,
  sendId: r.send_id,
  sentAt: r.sent_at,
});

const toSend = (r: SendRow): NoteSend => ({
  id: r.id,
  workspaceId: r.workspace_id,
  text: r.text,
  sentAt: r.sent_at,
  transcriptPath: r.transcript_path,
  ref: r.ref,
  refTranscript: r.ref_transcript,
});

const NOTE_SELECT = `SELECT n.*, s.sent_at FROM notes n LEFT JOIN note_sends s ON s.id = n.send_id`;

/**
 * Notes per workspace in `state.db` (spec §6.15): the app's own record,
 * never a file Claude could read. Deleted with the workspace.
 */
export class NoteRecords {
  private readonly events = new EventEmitter();

  constructor(private readonly db: StateDb) {}

  private prepare(sql: string) {
    return prepareOrSkip(this.db, sql);
  }

  /** Called after every change to a workspace's notes, with its id. */
  onChange(listener: (workspaceId: string) => void): () => void {
    this.events.on('change', listener);
    return () => this.events.off('change', listener);
  }

  private changed(workspaceId: string): void {
    this.events.emit('change', workspaceId);
  }

  /** Open and held items in their order, then sent ones, newest first. */
  list(workspaceId: string): Note[] {
    const rows = this.prepare(
      `${NOTE_SELECT} WHERE n.workspace_id = ?
         ORDER BY n.state = 'sent', s.sent_at DESC, n.position, n.created_at`,
    ).all(workspaceId) as NoteRow[];
    return rows.map(toNote);
  }

  get(id: string): Note | null {
    const row = this.prepare(`${NOTE_SELECT} WHERE n.id = ?`).get(id) as NoteRow | undefined;
    return row ? toNote(row) : null;
  }

  /** Unsent items (open and held) per workspace that has any. */
  counts(): Record<string, NoteCounts> {
    const rows = this.prepare(
      `SELECT workspace_id, count(*) AS unsent, sum(state = 'held') AS held FROM notes
         WHERE state != 'sent' AND trim(text) != '' GROUP BY workspace_id`,
    ).all() as { workspace_id: string; unsent: number; held: number }[];
    return Object.fromEntries(
      rows.map((r) => [r.workspace_id, { unsent: r.unsent, held: r.held ?? 0 }]),
    );
  }

  /** Workspaces with held items. */
  heldWorkspaces(): string[] {
    const rows = this.prepare(
      `SELECT DISTINCT workspace_id FROM notes WHERE state = 'held'`,
    ).all() as {
      workspace_id: string;
    }[];
    return rows.map((r) => r.workspace_id);
  }

  /** A new open item at the end of the open ones. */
  add(workspaceId: string, text = '', at = new Date()): Note {
    const id = `note_${randomUUID()}`;
    const now = at.toISOString();
    this.prepare(
      `INSERT INTO notes (id, workspace_id, position, text, state, created_at, updated_at)
         VALUES (@id, @workspaceId,
           (SELECT coalesce(max(position), 0) + 1 FROM notes WHERE workspace_id = @workspaceId),
           @text, 'open', @now, @now)`,
    ).run({ id, workspaceId, text, now });
    this.changed(workspaceId);
    return this.get(id) as Note;
  }

  /** An open item's text, as typed; held and sent ones don't change. */
  setText(id: string, text: string, at = new Date()): void {
    const note = this.get(id);
    if (note?.state !== 'open' || note.text === text) return;
    this.prepare(`UPDATE notes SET text = ?, updated_at = ? WHERE id = ?`).run(
      text,
      at.toISOString(),
      id,
    );
    this.changed(note.workspaceId);
  }

  /** Holds open items until Claude is done (spec §6.15). */
  hold(workspaceId: string, ids: readonly string[], at = new Date()): void {
    this.setStates(workspaceId, ids, 'open', 'held', at.toISOString());
  }

  /** Cancels held items: open again. */
  cancel(workspaceId: string, ids: readonly string[]): void {
    this.setStates(workspaceId, ids, 'held', 'open', null);
  }

  private setStates(
    workspaceId: string,
    ids: readonly string[],
    from: NoteState,
    to: NoteState,
    heldAt: string | null,
  ): void {
    const update = this.prepare(
      `UPDATE notes SET state = ?, held_at = ? WHERE id = ? AND workspace_id = ? AND state = ?`,
    );
    this.db.transaction(() => {
      for (const id of ids) update.run(to, heldAt, id, workspaceId, from);
    })();
    this.changed(workspaceId);
  }

  /** The workspace's held items, in their order. */
  held(workspaceId: string): Note[] {
    return this.list(workspaceId).filter((n) => n.state === 'held');
  }

  /**
   * Marks items sent in one prompt and records it, in one transaction, before
   * anything is typed into Claude: a second click finds them sent. Only items
   * still open or held count; null when none is.
   */
  markSent(
    workspaceId: string,
    ids: readonly string[],
    compose: (texts: string[]) => string,
    transcriptPath: string | null,
    at = new Date(),
  ): { send: NoteSend; notes: Note[] } | null {
    const sendId = `send_${randomUUID()}`;
    const sentAt = at.toISOString();
    const result = this.db.transaction(() => {
      const wanted = new Set(ids);
      const notes = this.list(workspaceId).filter(
        (n) => wanted.has(n.id) && n.state !== 'sent' && n.text.trim(),
      );
      if (notes.length === 0) return null;
      const text = compose(notes.map((n) => n.text));
      this.prepare(
        `INSERT INTO note_sends (id, workspace_id, text, sent_at, transcript_path)
           VALUES (?, ?, ?, ?, ?)`,
      ).run(sendId, workspaceId, text, sentAt, transcriptPath);
      const mark = this.prepare(
        `UPDATE notes SET state = 'sent', held_at = NULL, send_id = ? WHERE id = ?`,
      );
      for (const n of notes) mark.run(sendId, n.id);
      return { send: this.send(sendId) as NoteSend, notes };
    })();
    if (result) this.changed(workspaceId);
    return result;
  }

  /**
   * A send that didn't reach Claude: its items go back to the state each had
   * (open, or held), and the send is forgotten.
   */
  unsend(
    workspaceId: string,
    sendId: string,
    restore: readonly { id: string; state: 'open' | 'held' }[],
    at = new Date(),
  ): void {
    const update = this.prepare(
      `UPDATE notes SET state = ?, send_id = NULL, held_at = ? WHERE id = ? AND workspace_id = ?`,
    );
    this.db.transaction(() => {
      for (const r of restore) {
        update.run(r.state, r.state === 'held' ? at.toISOString() : null, r.id, workspaceId);
      }
      this.prepare(`DELETE FROM note_sends WHERE id = ?`).run(sendId);
    })();
    this.changed(workspaceId);
  }

  /** Sent items back to open, at the end of the open ones; their link to Responses goes. */
  reopen(workspaceId: string, ids: readonly string[]): void {
    const update = this.prepare(
      `UPDATE notes SET state = 'open', send_id = NULL, held_at = NULL,
         position = (SELECT coalesce(max(position), 0) + 1 FROM notes WHERE workspace_id = @workspaceId)
       WHERE id = @id AND workspace_id = @workspaceId AND state = 'sent'`,
    );
    this.db.transaction(() => {
      for (const id of ids) update.run({ id, workspaceId });
      this.pruneSends(workspaceId);
    })();
    this.changed(workspaceId);
  }

  /** Sends no item points to any more. */
  private pruneSends(workspaceId: string): void {
    this.prepare(
      `DELETE FROM note_sends WHERE workspace_id = ?
         AND id NOT IN (SELECT send_id FROM notes WHERE send_id IS NOT NULL)`,
    ).run(workspaceId);
  }

  /** Removes items, and the sends left without one. */
  delete(workspaceId: string, ids: readonly string[]): void {
    const remove = this.prepare(`DELETE FROM notes WHERE id = ? AND workspace_id = ?`);
    this.db.transaction(() => {
      for (const id of ids) remove.run(id, workspaceId);
      this.pruneSends(workspaceId);
    })();
    this.changed(workspaceId);
  }

  send(id: string): NoteSend | null {
    const row = this.prepare(`SELECT * FROM note_sends WHERE id = ?`).get(id) as
      | SendRow
      | undefined;
    return row ? toSend(row) : null;
  }

  sends(workspaceId: string): NoteSend[] {
    const rows = this.prepare(
      `SELECT * FROM note_sends WHERE workspace_id = ? ORDER BY sent_at`,
    ).all(workspaceId) as SendRow[];
    return rows.map(toSend);
  }

  /** Where a send was found in the transcript (spec §6.15). */
  setRef(sendId: string, ref: string, transcript: string): void {
    this.prepare(`UPDATE note_sends SET ref = ?, ref_transcript = ? WHERE id = ?`).run(
      ref,
      transcript,
      sendId,
    );
  }
}
