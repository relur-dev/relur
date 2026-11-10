import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WorkspaceState } from '@shared/status';
import type { SessionInfo } from '@shared/terminal-protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStateDb } from '../db/state-db';
import { WorkspaceRecords } from '../db/workspaces';
import { insertFiles } from './insert-files';

let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'insert-files-')));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function setup(state: WorkspaceState, over: Partial<SessionInfo> = {}) {
  const worktree = path.join(dir, 'wt');
  fs.mkdirSync(path.join(worktree, 'src'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'src', 'a.ts'), '');
  fs.writeFileSync(path.join(dir, 'shot 1.png'), '');
  const db = openStateDb(':memory:');
  const records = new WorkspaceRecords(db);
  db.prepare(
    `INSERT INTO workspaces (id, profile_id, project_id, name, branch, base_branch, worktree_path, status, created_at)
     VALUES ('ws_a', 'work', 'p', 'n', 'b', 'main', ?, ?, '2026-01-01')`,
  ).run(worktree, state);
  const session = {
    id: 'c1',
    kind: 'claude',
    title: 'Claude',
    cwd: worktree,
    profileId: 'work',
    projectId: 'p',
    workspaceId: 'ws_a',
    status: 'running',
    launching: false,
    resuming: false,
    generation: 0,
    ...over,
  } as SessionInfo;
  const typed: string[] = [];
  const woken: string[] = [];
  const deps = {
    records,
    decorate: <T>(w: T) => w,
    sessions: () => [session],
    hasDraft: () => false,
    atPrompt: () => true,
    spaceBefore: () => false,
    mainClaude: () => null,
    wake: async (s: SessionInfo) => {
      woken.push(s.id);
      Object.assign(session, { status: 'running', resuming: false });
    },
    host: {
      list: () => [session],
      typeAsUser: (_id: string, data: string) => void typed.push(data),
      outputEnd: () => typed.length,
    },
  };
  return { deps, typed, woken, worktree, session };
}

describe('insertFiles (spec §6.16)', () => {
  it('pastes each file into Claude at its prompt, never with Enter', async () => {
    const { deps, typed, worktree } = setup('done');
    const result = await insertFiles(deps, 'c1', [
      path.join(worktree, 'src', 'a.ts'),
      path.join(dir, 'shot 1.png'),
      path.join(worktree, 'src'),
      path.join(dir, 'gone.txt'),
    ]);
    expect(result).toEqual({ inserted: 3 });
    expect(typed).toEqual([
      '\x1b[200~@src/a.ts \x1b[201~',
      `\x1b[200~'${dir}/shot 1.png' \x1b[201~`,
      '\x1b[200~@src/ \x1b[201~',
    ]);
  });

  it('puts a space first after a word in the prompt', async () => {
    const { deps, typed, worktree } = setup('done');
    await insertFiles({ ...deps, spaceBefore: () => true }, 'c1', [path.join(worktree, 'src')]);
    expect(typed).toEqual(['\x1b[200~ @src/ \x1b[201~']);
  });

  it('refuses at a permission request and types nothing', async () => {
    const { deps, typed, worktree } = setup('needs-permission');
    await expect(insertFiles(deps, 'c1', [path.join(worktree, 'src')])).rejects.toThrow(
      'Claude is asking for permission: answer it, then add the files',
    );
    expect(typed).toEqual([]);
  });

  it('resumes a suspended Claude first', async () => {
    const { deps, typed, woken, worktree } = setup('done', { status: 'suspended' });
    await insertFiles(deps, 'c1', [path.join(worktree, 'src', 'a.ts')]);
    expect(woken).toEqual(['c1']);
    expect(typed).toEqual(['\x1b[200~@src/a.ts \x1b[201~']);
  });

  it('gives a shell its quoted paths to paste, without checks', async () => {
    const { deps, typed } = setup('needs-permission', { kind: 'shell', workspaceId: 'ws_a' });
    expect(await insertFiles(deps, 'c1', [path.join(dir, 'shot 1.png')])).toEqual({
      paste: `'${dir}/shot 1.png' `,
    });
    expect(typed).toEqual([]);
  });

  it('says so when none of the files exist any more', async () => {
    const { deps } = setup('done');
    await expect(insertFiles(deps, 'c1', [path.join(dir, 'gone')])).rejects.toThrow(
      'Those files no longer exist',
    );
  });
});
