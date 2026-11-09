import { composePrompt } from '@shared/notes';
import { describe, expect, it } from 'vitest';
import { NoteRecords } from './notes';
import { openStateDb } from './state-db';
import { WorkspaceRecords } from './workspaces';

const at = (minute: number) => new Date(`2026-11-09T10:${String(minute).padStart(2, '0')}:00Z`);

function setup() {
  const db = openStateDb(':memory:');
  const notes = new NoteRecords(db);
  const changes: string[] = [];
  notes.onChange((id) => changes.push(id));
  return { db, notes, changes };
}

describe('NoteRecords (spec §6.15)', () => {
  it('adds items at the end, saves their text and lists them in order', () => {
    const { notes, changes } = setup();
    const a = notes.add('ws_a', '', at(0));
    const b = notes.add('ws_a', 'Second', at(1));
    notes.add('ws_b', 'Elsewhere', at(2));
    notes.setText(a.id, 'First, typed', at(3));
    expect(notes.list('ws_a').map((n) => [n.text, n.state])).toEqual([
      ['First, typed', 'open'],
      ['Second', 'open'],
    ]);
    expect(notes.get(a.id)?.updatedAt).toBe(at(3).toISOString());
    expect(notes.get(b.id)?.sendId).toBeNull();
    expect(changes).toEqual(['ws_a', 'ws_a', 'ws_b', 'ws_a']);
  });

  it('counts unsent items per workspace, held ones too, empty ones not', () => {
    const { notes } = setup();
    const a = notes.add('ws_a', 'One');
    notes.add('ws_a', 'Two');
    notes.add('ws_a', '   ');
    notes.add('ws_b', 'Other');
    notes.hold('ws_a', [a.id]);
    expect(notes.counts()).toEqual({
      ws_a: { unsent: 2, held: 1 },
      ws_b: { unsent: 1, held: 0 },
    });
    expect(notes.heldWorkspaces()).toEqual(['ws_a']);
  });

  it('holds and cancels; held and sent items keep their text', () => {
    const { notes } = setup();
    const a = notes.add('ws_a', 'Hold me');
    notes.hold('ws_a', [a.id], at(1));
    expect(notes.get(a.id)).toMatchObject({ state: 'held', heldAt: at(1).toISOString() });
    notes.setText(a.id, 'Changed');
    expect(notes.get(a.id)?.text).toBe('Hold me');
    notes.cancel('ws_a', [a.id]);
    expect(notes.get(a.id)).toMatchObject({ state: 'open', heldAt: null });
  });

  it('marks items sent in one prompt, in their order, only once', () => {
    const { notes } = setup();
    const a = notes.add('ws_a', 'First');
    const b = notes.add('ws_a', 'Second');
    notes.add('ws_a', 'Not this');
    const sent = notes.markSent('ws_a', [b.id, a.id], composePrompt, '/t.jsonl', at(5));
    expect(sent?.send).toMatchObject({
      text: '1. First\n\n2. Second',
      sentAt: at(5).toISOString(),
      transcriptPath: '/t.jsonl',
      ref: null,
    });
    expect(notes.get(a.id)).toMatchObject({
      state: 'sent',
      sendId: sent?.send.id,
      sentAt: at(5).toISOString(),
    });
    // A second click finds them sent.
    expect(notes.markSent('ws_a', [a.id, b.id], composePrompt, null)).toBeNull();
    // Open ones first, then sent ones.
    expect(notes.list('ws_a').map((n) => n.text)).toEqual(['Not this', 'First', 'Second']);
  });

  it('puts items back as they were when the send fails', () => {
    const { notes } = setup();
    const a = notes.add('ws_a', 'Open one');
    const b = notes.add('ws_a', 'Held one');
    notes.hold('ws_a', [b.id]);
    const sent = notes.markSent('ws_a', [a.id, b.id], composePrompt, null);
    if (!sent) throw new Error('not sent');
    notes.unsend('ws_a', sent.send.id, [
      { id: a.id, state: 'open' },
      { id: b.id, state: 'held' },
    ]);
    expect(notes.get(a.id)).toMatchObject({ state: 'open', sendId: null });
    expect(notes.get(b.id)).toMatchObject({ state: 'held', sendId: null });
    expect(notes.sends('ws_a')).toEqual([]);
  });

  it('keeps where a send was found; moving back or deleting drops a send left without items', () => {
    const { notes } = setup();
    const a = notes.add('ws_a', 'A');
    const b = notes.add('ws_a', 'B');
    const sent = notes.markSent('ws_a', [a.id, b.id], composePrompt, '/t.jsonl');
    if (!sent) throw new Error('not sent');
    notes.setRef(sent.send.id, 'u7', '/t.jsonl');
    expect(notes.send(sent.send.id)).toMatchObject({ ref: 'u7', refTranscript: '/t.jsonl' });
    notes.reopen('ws_a', [a.id]);
    expect(notes.get(a.id)).toMatchObject({ state: 'open', sendId: null });
    expect(notes.sends('ws_a')).toHaveLength(1);
    notes.delete('ws_a', [b.id]);
    expect(notes.get(b.id)).toBeNull();
    expect(notes.sends('ws_a')).toEqual([]);
  });

  it('deletes them with the workspace', () => {
    const { db, notes } = setup();
    const records = new WorkspaceRecords(db);
    db.prepare(
      `INSERT INTO workspaces (id, profile_id, project_id, name, branch, base_branch, worktree_path, status, created_at)
       VALUES ('ws_a', 'work', 'p', 'n', 'b', 'main', '/w', 'done', '2026-01-01')`,
    ).run();
    const a = notes.add('ws_a', 'Gone with it');
    notes.markSent('ws_a', [a.id], composePrompt, null);
    notes.add('ws_a', 'Unsent');
    notes.add('ws_b', 'Kept');
    records.archive('ws_a');
    expect(notes.list('ws_a')).toEqual([]);
    expect(notes.sends('ws_a')).toEqual([]);
    expect(notes.list('ws_b')).toHaveLength(1);
  });
});
