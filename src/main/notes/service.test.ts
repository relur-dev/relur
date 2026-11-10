import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WorkspaceState } from '@shared/status';
import type { SessionInfo } from '@shared/terminal-protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NoteRecords } from '../db/notes';
import { openStateDb } from '../db/state-db';
import { WorkspaceRecords } from '../db/workspaces';
import { NotesService } from './service';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function setup(state: WorkspaceState = 'working') {
  const db = openStateDb(':memory:');
  const records = new WorkspaceRecords(db);
  db.prepare(
    `INSERT INTO workspaces (id, profile_id, project_id, name, branch, base_branch, worktree_path, status, created_at)
     VALUES ('ws_a', 'work', 'p', 'n', 'b', 'main', '/w', ?, '2026-01-01')`,
  ).run(state);
  const transcript = path.join(dir, 's.jsonl');
  fs.writeFileSync(transcript, '');
  records.setClaudeSession('ws_a', 'sid', transcript);
  const notes = new NoteRecords(db);
  const sent: string[] = [];
  const claude: SessionInfo = {
    id: 'c1',
    kind: 'claude',
    title: 'Claude',
    cwd: '/w',
    profileId: 'work',
    projectId: 'p',
    workspaceId: 'ws_a',
    status: 'running',
    launching: false,
    resuming: false,
    generation: 0,
  } as SessionInfo;
  const ctx = { draft: false, fail: null as string | null, sessions: [claude] };
  const draftListeners = new Set<(workspaceId: string) => void>();
  /** The draft in Claude's prompt changes, as the suspend service reports it. */
  const setDraft = (draft: boolean) => {
    ctx.draft = draft;
    for (const listener of draftListeners) listener('ws_a');
  };
  const service = new NotesService({
    notes,
    records,
    decorate: (w) => w,
    sessions: () => ctx.sessions,
    hasDraft: () => ctx.draft,
    onDraftChange: (listener) => {
      draftListeners.add(listener);
      return () => draftListeners.delete(listener);
    },
    send: async (_id, prompt) => {
      if (ctx.fail) throw new Error(ctx.fail);
      sent.push(prompt);
    },
  });
  service.start();
  return { records, notes, service, sent, ctx, transcript, setDraft };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('NotesService (spec §6.15)', () => {
  let stop: (() => void) | null = null;
  afterEach(() => stop?.());

  it('holds items while Claude works and sends them together when it is done', async () => {
    const { records, notes, service, sent } = setup('working');
    stop = () => service.stop();
    const a = notes.add('ws_a', 'First');
    const b = notes.add('ws_a', 'Second');
    notes.hold('ws_a', [a.id, b.id]);
    await settle();
    expect(sent).toEqual([]);
    expect(service.view('ws_a').waiting).toBe('Queued · sends when Claude is done');
    service.conversation('ws_a', 'Stop', 'All tests pass.');
    records.setState('ws_a', 'done');
    await settle();
    expect(sent).toEqual(['1. First\n\n2. Second']);
    expect(notes.list('ws_a').every((n) => n.state === 'sent')).toBe(true);
  });

  it('keeps waiting when the turn ends with a question; Send now sends anyway', async () => {
    const { records, notes, service, sent } = setup('working');
    stop = () => service.stop();
    const a = notes.add('ws_a', 'Use the staging config');
    notes.hold('ws_a', [a.id]);
    service.conversation('ws_a', 'Stop', 'I found two options.\n\nShould I use the first one?');
    records.setState('ws_a', 'done');
    await settle();
    expect(sent).toEqual([]);
    expect(service.view('ws_a').waiting).toBe('Waiting: Claude asked something');
    await service.sendNow('ws_a', [a.id]);
    expect(sent).toEqual(['Use the staging config']);
  });

  it('waits through a permission request and goes after the next Done', async () => {
    const { records, notes, service, sent } = setup('working');
    stop = () => service.stop();
    const a = notes.add('ws_a', 'Later');
    notes.hold('ws_a', [a.id]);
    records.setState('ws_a', 'needs-permission');
    await settle();
    expect(sent).toEqual([]);
    await expect(service.sendNow('ws_a', [a.id])).rejects.toThrow(/permission/);
    records.setState('ws_a', 'working');
    service.conversation('ws_a', 'Stop', 'Done.');
    records.setState('ws_a', 'done');
    await settle();
    expect(sent).toEqual(['Later']);
  });

  it('never types over a draft; it goes as soon as the draft is gone', async () => {
    const { records, notes, service, sent, setDraft } = setup('done');
    stop = () => service.stop();
    setDraft(true);
    const a = notes.add('ws_a', 'Wait for the draft');
    notes.hold('ws_a', [a.id]);
    await settle();
    expect(sent).toEqual([]);
    expect(service.view('ws_a').waiting).toBe('Waiting: an unsent prompt in the terminal');
    // Claude was done already: the draft clearing is the only change.
    setDraft(false);
    await settle();
    expect(sent).toEqual(['Wait for the draft']);
    expect(records.get('ws_a')?.state).toBe('done');
  });

  it('puts items back when typing fails, with the reason', async () => {
    const { notes, service, ctx } = setup('done');
    stop = () => service.stop();
    ctx.fail = "Claude isn't running in this workspace; start it first";
    const a = notes.add('ws_a', 'Try');
    await expect(service.sendNow('ws_a', [a.id])).rejects.toThrow(/isn't running/);
    expect(notes.get(a.id)?.state).toBe('open');
    notes.hold('ws_a', [a.id]);
    await settle();
    expect(notes.get(a.id)?.state).toBe('held');
    expect(service.view('ws_a').waiting).toMatch(/isn't running/);
  });

  it('finds the sent prompt in the transcript and links its entry both ways', async () => {
    const { notes, service, transcript } = setup('done');
    stop = () => service.stop();
    const a = notes.add('ws_a', 'Explain the build');
    await service.sendNow('ws_a', [a.id]);
    const sentAt = notes.get(a.id)?.sentAt ?? '';
    expect(service.view('ws_a').sends).toEqual([
      { id: notes.get(a.id)?.sendId, sentAt, entry: null, elsewhere: false },
    ]);
    const later = new Date(Date.parse(sentAt) + 1000).toISOString();
    fs.writeFileSync(
      transcript,
      [
        {
          type: 'user',
          uuid: 'u0',
          origin: { kind: 'human' },
          timestamp: '2026-01-01T00:00:00Z',
          message: { content: 'Explain the build' },
        },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Earlier.' }] } },
        {
          type: 'user',
          uuid: 'u1',
          origin: { kind: 'human' },
          timestamp: later,
          message: { content: 'Explain the build' },
        },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Three steps.' }] } },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n'),
    );
    expect(service.view('ws_a').sends[0]?.entry).toBe(1);
    const responses = (await import('../claude/transcript')).readResponses(transcript);
    expect(service.entryNotes('ws_a', responses)).toEqual(new Map([[1, [a.id]]]));
  });
});
