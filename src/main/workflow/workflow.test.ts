import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Workflow, WorkflowSchema } from '@shared/schemas';
import { atGate, effectiveWorkflow, fixedPrefix, segmentMatches } from '@shared/workflow';
import type { Workspace } from '@shared/workspaces';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigStore } from '../config/store';
import { openStateDb } from '../db/state-db';
import { WorkspaceRecords } from '../db/workspaces';
import { SessionHost } from '../sessions/host';
import { type Alert, StatusService } from '../status/service';
import { findStatusFiles } from './propose';
import { firstHeading, matchFiles, readStatus } from './read';
import { WorkflowService } from './service';

let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-')));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const workflow: Workflow = WorkflowSchema.parse({
  file: 'docs/specs/*/specification.md',
  match: { field: 'branch', equals: 'branch' },
  idField: 'task',
  statuses: [
    { value: 'draft', label: 'Draft' },
    { value: 'spec-review', label: 'Spec review', kind: 'gate' },
    { value: 'building', label: 'Building' },
    { value: 'done', label: 'Done', kind: 'final' },
  ],
});

const spec = (worktree: string, folder: string, fields: Record<string, string>, body = '') => {
  const file = path.join(worktree, 'docs', 'specs', folder, 'specification.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const yaml = Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  fs.writeFileSync(file, `---\n${yaml}\n---\n${body}`);
};

describe('patterns', () => {
  it('matches * within one segment and watches the fixed part', () => {
    expect(fixedPrefix('docs/specs/*/specification.md')).toBe('docs/specs');
    expect(fixedPrefix('STATUS.md')).toBe('');
    expect(fixedPrefix('a/b/status.md')).toBe('a/b');
    expect(segmentMatches('*.md', 'spec.md')).toBe(true);
    expect(segmentMatches('spec-*', 'spec-a.b')).toBe(true);
    expect(segmentMatches('*.md', 'spec.mdx')).toBe(false);
    spec(root, 'one', { branch: 'a' });
    spec(root, 'two', { branch: 'b' });
    fs.mkdirSync(path.join(root, 'docs', 'specs', '.hidden'));
    expect(matchFiles(root, workflow.file)).toEqual([
      'docs/specs/one/specification.md',
      'docs/specs/two/specification.md',
    ]);
  });
});

describe('readStatus', () => {
  const read = (branch = 'feat-a', taskId: string | null = null, wf = workflow) =>
    readStatus(root, wf, { branch, taskId });

  it('picks the file whose field equals the branch, and reads its status', () => {
    spec(root, 'one', { branch: 'feat-a', status: 'spec-review', task: 'ABC-1' }, '# Login\n');
    spec(root, 'two', { branch: 'feat-b', status: 'draft' });
    const result = read();
    expect(result.info).toEqual({
      statuses: workflow.statuses,
      status: 'spec-review',
      index: 1,
      kind: 'gate',
      label: 'Spec review',
      hint: null,
      file: 'docs/specs/one/specification.md',
      problem: null,
    });
    expect(result.fields).toEqual({ branch: 'feat-a', status: 'spec-review', task: 'ABC-1' });
    expect(result.candidates).toHaveLength(2);
    expect(firstHeading(root, 'docs/specs/one/specification.md')).toBe('Login');
  });

  it('matches by task id, and explains a missing, doubled or unknown status', () => {
    spec(root, 'one', { task: 'ABC-1', branch: 'x', status: 'building' });
    const byTask = { ...workflow, match: { field: 'task', equals: 'taskId' as const } };
    expect(read('anything', 'ABC-1', byTask).info.label).toBe('Building');
    expect(read('anything', null, byTask).info.problem).toBe(
      'This workspace has no task id to match',
    );
    expect(read('feat-z').info.problem).toBe('No status file for feat-z yet');
    spec(root, 'two', { branch: 'x', status: 'draft' });
    expect(read('x').info.problem).toBe('2 files match x');
    spec(root, 'three', { branch: 'y', status: 'reviewing' });
    expect(read('y').info).toMatchObject({ kind: 'unknown', label: 'reviewing', index: -1 });
    spec(root, 'four', { branch: 'z' });
    expect(read('z').info.problem).toMatch(/has no status field/);
    fs.writeFileSync(path.join(root, 'docs', 'specs', 'four', 'specification.md'), 'plain');
    expect(read('z').candidates.find((c) => c.file.includes('four'))?.error).toBe(
      'no front matter',
    );
  });

  it('reads a status file whose front matter strict YAML refuses', () => {
    const dir = path.join(root, 'docs', 'specs', 'colon');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'specification.md'),
      '---\nbranch: feat-c\nstatus: building\ntitle: Login: remember me\n---\n',
    );
    expect(read('feat-c').info.label).toBe('Building');
  });
});

describe('effectiveWorkflow and atGate', () => {
  it('follows project → profile, and gates only while Claude is idle', () => {
    expect(effectiveWorkflow({ workflow }, { workflow: null })).toBe(workflow);
    expect(effectiveWorkflow({ workflow }, { workflow: false })).toBeNull();
    const own = { ...workflow, file: 'STATUS.md' };
    expect(effectiveWorkflow({ workflow }, { workflow: own })).toBe(own);
    const gate = { kind: 'gate' } as never;
    expect(
      ['done', 'interrupted', 'needs-input', 'exited'].every((s) => atGate(s as never, gate)),
    ).toBe(true);
    expect(atGate('working', gate)).toBe(false);
    expect(atGate('needs-permission', gate)).toBe(false);
    expect(atGate('done', { kind: 'step' } as never)).toBe(false);
  });
});

describe('WorkflowService with the status service', () => {
  let records: WorkspaceRecords;
  let config: ConfigStore;
  let service: WorkflowService;
  let status: StatusService;
  let host: SessionHost;
  let notified: Alert[];
  let badge: number;
  let sent: string[];
  let worktree: string;

  const base: Omit<Workspace, 'repos'> = {
    id: 'ws_1',
    profileId: 'work',
    projectId: 'api',
    name: 'ABC-1 Login',
    task: { id: 'ABC-1', title: 'Login', url: null },
    branch: 'feat-a',
    baseBranch: 'main',
    worktreePath: '',
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
    createdAt: '2026-10-29T10:00:00Z',
    lastActivityAt: null,
  };

  beforeEach(() => {
    worktree = path.join(root, 'tree');
    fs.mkdirSync(worktree);
    const file = path.join(root, 'config.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        profiles: [{ id: 'work', name: 'Work', workflow }],
        projects: [
          {
            id: 'api',
            profileId: 'work',
            name: 'api',
            repoPath: root,
            startPrompt: 'Start {id}: {title} on {branch}.',
          },
        ],
      }),
    );
    config = new ConfigStore(file);
    config.load();
    records = new WorkspaceRecords(openStateDb(':memory:'));
    records.insert({ ...base, worktreePath: worktree });
    sent = [];
    service = new WorkflowService(config, records, {
      sendToClaude: (_id, prompt) => {
        sent.push(prompt);
      },
    });
    host = new SessionHost({ killTimeoutMs: 300 });
    notified = [];
    badge = -1;
    status = new StatusService(records, host, {
      claudeTabInFocus: () => false,
      quiet: () => false,
      profileName: () => 'Work',
      notify: (a) => notified.push(a),
      setBadge: (n) => {
        badge = n;
      },
    });
    status.workflow = service;
    service.onChange(({ workspaceId, before, after }) =>
      status.workflowChanged(workspaceId, before, after),
    );
  });
  afterEach(() => {
    service.dispose();
    host.stopAll();
  });

  const hook = (event: string, payload: unknown = {}) =>
    status.handleHook({ event, workspaceId: 'ws_1', profileId: 'work', payload });

  it('sends only the gate notification when Claude stops at a gate', () => {
    spec(worktree, 'a', { branch: 'feat-a', status: 'draft' });
    hook('UserPromptSubmit');
    spec(worktree, 'a', { branch: 'feat-a', status: 'spec-review' });
    hook('Stop');
    expect(records.get('ws_1')?.state).toBe('done');
    expect(notified.map((a) => a.title)).toEqual(['[Work] ABC-1 waits for you: Spec review']);
    expect(notified[0]?.state).toBe('awaiting-approval');
    expect(badge).toBe(1);
    const shown = service.decorate(records.get('ws_1') as Workspace);
    expect(shown).toMatchObject({
      state: 'awaiting-approval',
      stateMessage: 'Waits for you: Spec review',
      workflow: { label: 'Spec review', kind: 'gate' },
    });
    // The idle notice a minute later changes nothing you'd notice.
    hook('Notification', {
      notification_type: 'idle_prompt',
      message: 'Claude is waiting for your input',
    });
    expect(notified).toHaveLength(1);
    expect(badge).toBe(1);

    // A gate waits for a person's own answer: no Continue, and its answer
    // button only when it has one. Working again ends Awaiting approval.
    expect(() => service.continue('ws_1')).toThrow(/waits for your answer/);
    expect(() => service.answer('ws_1')).toThrow(/no answer button/);
    config.update((raw) => {
      const statuses = (raw as { profiles: { workflow: Workflow }[] }).profiles[0]?.workflow
        .statuses as Workflow['statuses'];
      (statuses[1] as Workflow['statuses'][number]).answer = {
        label: 'Approve spec',
        prompt: 'I approve the spec of {id}.',
      };
    });
    service.answer('ws_1');
    expect(sent).toEqual(['I approve the spec of ABC-1.']);
    hook('UserPromptSubmit');
    expect(service.decorate(records.get('ws_1') as Workspace).state).toBe('working');
    expect(badge).toBe(0);
  });

  it('alerts when the file reaches a gate while Claude is idle, and says done otherwise', () => {
    spec(worktree, 'a', { branch: 'feat-a', status: 'draft' });
    hook('UserPromptSubmit');
    hook('Stop');
    expect(notified.map((a) => a.title)).toEqual(['[Work] ABC-1 is done']);
    service.info('ws_1');
    spec(worktree, 'a', { branch: 'feat-a', status: 'spec-review' });
    service.refresh('ws_1');
    expect(notified.map((a) => a.title)).toEqual([
      '[Work] ABC-1 is done',
      '[Work] ABC-1 waits for you: Spec review',
    ]);
    expect(badge).toBe(1);
  });

  it("names the gate's hint in its notification", () => {
    config.update((raw) => {
      const statuses = (raw as { profiles: { workflow: Workflow }[] }).profiles[0]?.workflow
        .statuses as Workflow['statuses'];
      (statuses[1] as Workflow['statuses'][number]).hint = 'Review and approve the spec';
    });
    spec(worktree, 'a', { branch: 'feat-a', status: 'spec-review' });
    hook('UserPromptSubmit');
    hook('Stop');
    expect(notified.map((a) => a.title)).toEqual([
      '[Work] ABC-1 waits for you: Review and approve the spec',
    ]);
  });

  it('refuses Continue while Claude works or at a final status', () => {
    spec(worktree, 'a', { branch: 'feat-a', status: 'building' });
    hook('UserPromptSubmit');
    expect(() => service.continue('ws_1')).toThrow(/busy/);
    hook('Stop');
    spec(worktree, 'a', { branch: 'feat-a', status: 'done' });
    service.refresh('ws_1');
    expect(() => service.continue('ws_1')).toThrow(/final status/);
  });

  it('fills the Start prompt, previews drafts and saves settings', () => {
    expect(service.startPrompt(records.get('ws_1') as Workspace)).toBe(
      'Start ABC-1: Login on feat-a.',
    );
    const noId: Workspace = {
      ...(records.get('ws_1') as Workspace),
      task: { id: null, title: 'Login', url: null },
    };
    expect(service.startPrompt(noId)).toBeNull();
    // Without a project prompt, the profile workflow's.
    config.update((raw) => {
      const r = raw as { profiles: { workflow: Workflow }[]; projects: object[] };
      delete (r.projects[0] as { startPrompt?: string }).startPrompt;
      (r.profiles[0] as { workflow: Workflow }).workflow.startPrompt = 'Plan {id}.';
    });
    expect(service.startPrompt(records.get('ws_1') as Workspace)).toBe('Plan ABC-1.');
    spec(worktree, 'a', { branch: 'feat-a', status: 'draft' });
    const draft = { ...workflow, statusField: 'branch' };
    expect(service.preview(draft, 'ws_1').info).toMatchObject({
      kind: 'unknown',
      status: 'feat-a',
    });

    service.saveProject('api', false, '  ');
    let raw = JSON.parse(fs.readFileSync(config.file, 'utf8'));
    expect(raw.projects[0].workflow).toBe(false);
    expect(raw.projects[0].startPrompt).toBeUndefined();
    expect(service.info('ws_1')).toBeNull();
    service.saveProject('api', null, 'Go.');
    service.saveProfile('work', null);
    raw = JSON.parse(fs.readFileSync(config.file, 'utf8'));
    expect(raw.projects[0]).not.toHaveProperty('workflow');
    expect(raw.projects[0].startPrompt).toBe('Go.');
    expect(raw.profiles[0]).not.toHaveProperty('workflow');
  });
});

describe('Title from the status file', () => {
  it('fills a missing title once, from the title field', () => {
    const file = path.join(root, 'config.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        profiles: [{ id: 'work', name: 'Work', workflow: { ...workflow, titleField: 'title' } }],
        projects: [{ id: 'api', profileId: 'work', name: 'api', repoPath: root }],
      }),
    );
    const config = new ConfigStore(file);
    config.load();
    const records = new WorkspaceRecords(openStateDb(':memory:'));
    const worktree = path.join(root, 'tree3');
    records.insert({
      id: 'ws_3',
      profileId: 'work',
      projectId: 'api',
      name: 'ABC-3',
      task: { id: 'ABC-3', title: '', url: null },
      branch: 'ABC-3',
      baseBranch: 'main',
      worktreePath: worktree,
      state: 'exited',
      unread: false,
      stateMessage: null,
      background: 0,
      unfinished: null,
      lastPrompt: null,
      stateSince: null,
      claudeSessionId: null,
      ports: null,
      pr: null,
      createdAt: '2026-10-29T10:00:00Z',
      lastActivityAt: null,
    });
    records.setTitleFromStatusPending('ws_3', true);
    const service = new WorkflowService(config, records, { sendToClaude: () => {} });
    spec(worktree, 'a', { branch: 'ABC-3', status: 'draft' });
    service.refresh('ws_3');
    expect(records.get('ws_3')?.task.title).toBe('');
    spec(worktree, 'a', { branch: 'ABC-3', status: 'draft', title: 'Fill me: from the file' });
    service.refresh('ws_3');
    expect(records.get('ws_3')).toMatchObject({
      name: 'ABC-3 Fill me: from the file',
      task: { title: 'Fill me: from the file' },
    });
    spec(worktree, 'a', { branch: 'ABC-3', status: 'draft', title: 'Renamed later' });
    service.refresh('ws_3');
    expect(records.get('ws_3')?.task.title).toBe('Fill me: from the file');
    service.dispose();
  });
});

describe('Start prompt records', () => {
  it('is pending only when set, and old workspaces never get one', () => {
    const records = new WorkspaceRecords(openStateDb(':memory:'));
    records.insert({
      id: 'ws_2',
      profileId: 'work',
      projectId: 'api',
      name: 'x',
      task: { id: null, title: 'x', url: null },
      branch: 'x',
      baseBranch: 'main',
      worktreePath: '/w/x',
      state: 'starting',
      unread: false,
      stateMessage: null,
      background: 0,
      unfinished: null,
      lastPrompt: null,
      stateSince: null,
      claudeSessionId: null,
      ports: null,
      pr: null,
      createdAt: '2026-10-29T10:00:00Z',
      lastActivityAt: null,
    });
    expect(records.startPromptPending('ws_2')).toBe(false);
    records.setStartPromptPending('ws_2', true);
    expect(records.startPromptPending('ws_2')).toBe(true);
    records.setStartPromptPending('ws_2', false);
    expect(records.startPromptPending('ws_2')).toBe(false);
  });
});

describe('The task lookup kept in the profile', () => {
  const lookup = { kind: 'command', command: 'tracker title {id}', timeoutSec: 20 };
  const setUp = (profile: Record<string, unknown>) => {
    const file = path.join(root, 'config.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, profiles: [{ id: 'work', name: 'Work', ...profile }] }),
    );
    const config = new ConfigStore(file);
    config.load();
    const service = new WorkflowService(config, new WorkspaceRecords(openStateDb(':memory:')), {
      sendToClaude: () => {},
    });
    const raw = () => JSON.parse(fs.readFileSync(file, 'utf8')).profiles[0];
    const parsed = () => config.get().config?.profiles[0];
    return { service, raw, parsed };
  };

  it("is still read from the workflow when the profile hasn't its own", () => {
    const { parsed } = setUp({ workflow: { ...workflow, lookup } });
    expect(parsed()?.taskLookup).toEqual(lookup);
    expect(parsed()?.workflow).not.toHaveProperty('lookup');
  });

  it('moves out of the workflow when the workflow is saved', () => {
    const { service, raw, parsed } = setUp({ workflow: { ...workflow, lookup } });
    service.saveProfile('work', { ...workflow, continuePrompt: 'Go on.' });
    expect(raw().taskLookup).toEqual(lookup);
    expect(raw().workflow).not.toHaveProperty('lookup');
    expect(parsed()?.taskLookup).toEqual(lookup);
  });

  it('stays when the workflow is removed', () => {
    const { service, raw } = setUp({ workflow: { ...workflow, lookup } });
    service.saveProfile('work', null);
    expect(raw()).not.toHaveProperty('workflow');
    expect(raw().taskLookup).toEqual(lookup);
  });

  it('is removed from both places by saving none', () => {
    const { service, raw, parsed } = setUp({ workflow: { ...workflow, lookup } });
    service.saveLookup('work', null);
    expect(raw()).not.toHaveProperty('taskLookup');
    expect(raw().workflow).not.toHaveProperty('lookup');
    expect(parsed()?.taskLookup).toBeUndefined();
  });

  it('wins over one left in the workflow, which the next save drops', () => {
    const own = { ...lookup, command: 'own {id}' };
    const { service, raw, parsed } = setUp({ taskLookup: own, workflow: { ...workflow, lookup } });
    expect(parsed()?.taskLookup).toEqual(own);
    service.saveProfile('work', workflow);
    expect(raw().taskLookup).toEqual(own);
    expect(raw().workflow).not.toHaveProperty('lookup');
  });
});

describe('Status files for Set up from my skills', () => {
  it('finds Markdown files with a status field, skipping hidden and dependency folders', () => {
    const tree = path.join(root, 'tree-scan');
    spec(tree, 'login', { branch: 'ABC-1', status: 'draft' });
    const write = (rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(tree, rel)), { recursive: true });
      fs.writeFileSync(path.join(tree, rel), text);
    };
    write('README.md', '# Readme\n');
    write('docs/adr/1.md', '---\ntitle: An ADR\n---\n');
    write('notes/plan.md', '---\nphase: planning\n---\n');
    write('node_modules/x/README.md', '---\nstatus: draft\n---\n');
    write('.claude/specs/a.md', '---\nstatus: draft\n---\n');
    expect(findStatusFiles(tree)).toEqual(['docs/specs/login/specification.md', 'notes/plan.md']);
  });
});
