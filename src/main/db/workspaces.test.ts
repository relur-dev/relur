import type { Workspace } from '@shared/workspaces';
import { describe, expect, it, vi } from 'vitest';
import { openStateDb } from './state-db';
import { WorkspaceRecords } from './workspaces';

const workspace = (id: string, projectId = 'api'): Workspace => ({
  id,
  profileId: 'work',
  projectId,
  name: `Workspace ${id}`,
  task: { id: id.toUpperCase(), title: `Workspace ${id}`, url: null },
  branch: id,
  baseBranch: 'main',
  worktreePath: `/w/${id}`,
  state: 'starting',
  unread: false,
  stateMessage: null,
  background: 0,
  unfinished: null,
  lastPrompt: null,
  keepRunning: false,
  claudeMayLink: true,
  stateSince: null,
  claudeSessionId: null,
  ports: null,
  pr: null,
  repos: [
    {
      projectId: projectId,
      primary: true,
      worktreePath: `/w/${id}`,
      baseBranch: 'main',
      pr: null,
      hasCommits: false,
      merged: null,
      setupError: null,
      branchOrigin: 'new',
    },
  ],
  createdAt: `2026-10-28T10:00:0${id.length}Z`,
  lastActivityAt: null,
});

describe('WorkspaceRecords', () => {
  it('logs and does nothing once state.db is closed, instead of throwing', () => {
    const db = openStateDb(':memory:');
    const records = new WorkspaceRecords(db);
    records.insert(workspace('a'));
    db.close();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(records.get('a')).toBeNull();
    expect(records.list()).toEqual([]);
    expect(() => records.setState('a', 'working')).not.toThrow();
    expect(() => records.insert(workspace('b'))).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('lists, finds and archives workspaces', () => {
    const records = new WorkspaceRecords(openStateDb(':memory:'));
    records.insert(workspace('a'));
    records.insert(workspace('bb', 'web'));
    expect(records.list().map((w) => w.id)).toEqual(['a', 'bb']);
    expect(records.get('bb')).toEqual(workspace('bb', 'web'));
    expect(records.forProject('api').map((w) => w.id)).toEqual(['a']);

    records.archive('a');
    expect(records.get('a')).toBeNull();
    expect(records.list().map((w) => w.id)).toEqual(['bb']);
    expect(records.forProject('api')).toEqual([]);
  });

  it('records state changes as activity', () => {
    const records = new WorkspaceRecords(openStateDb(':memory:'));
    records.insert(workspace('a'));
    records.setState('a', 'exited', { at: new Date('2026-10-28T11:00:00Z') });
    expect(records.get('a')).toMatchObject({
      state: 'exited',
      lastActivityAt: '2026-10-28T11:00:00.000Z',
      stateSince: '2026-10-28T11:00:00.000Z',
    });
  });

  it('keeps state_since while the state stays, and sets the message and unread marker', () => {
    const records = new WorkspaceRecords(openStateDb(':memory:'));
    records.insert(workspace('a'));
    records.setState('a', 'working', { at: new Date('2026-10-28T11:00:00Z') });
    records.setState('a', 'working', { at: new Date('2026-10-28T11:05:00Z') });
    expect(records.get('a')?.stateSince).toBe('2026-10-28T11:00:00.000Z');
    records.setState('a', 'needs-permission', { message: 'Allow Bash?' });
    expect(records.get('a')).toMatchObject({
      state: 'needs-permission',
      stateMessage: 'Allow Bash?',
    });
    records.setState('a', 'done', { unread: true });
    expect(records.get('a')).toMatchObject({ unread: true, stateMessage: null });
    records.markRead('a');
    expect(records.get('a')?.unread).toBe(false);
  });

  it('keeps the Claude session id and transcript path from hooks, and the running flag', () => {
    const records = new WorkspaceRecords(openStateDb(':memory:'));
    records.insert(workspace('a'));
    records.setClaudeSession('a', 'sess-1', '/t/sess-1.jsonl');
    records.setClaudeSession('a', null, null);
    expect(records.get('a')?.claudeSessionId).toBe('sess-1');
    expect(records.transcriptPath('a')).toBe('/t/sess-1.jsonl');
    records.setClaudeRunning('a', true);
    expect(records.claudeWasRunning().map((w) => w.id)).toEqual(['a']);
    records.setClaudeRunning('a', false);
    expect(records.claudeWasRunning()).toEqual([]);
  });
});
