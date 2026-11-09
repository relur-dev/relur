import { describe, expect, it } from 'vitest';
import type { WorkspaceState } from './status';
import {
  canContinue,
  continuesAtStart,
  DEFAULT_RESUME_PROMPT,
  planLimitReached,
  quitNextStep,
  resumePrompt,
  stoppedNote,
  tickedByDefault,
  unfinishedKind,
  unfinishedReason,
  unfinishedTooltip,
} from './unfinished';

describe('unfinishedKind (spec §9.7)', () => {
  it('counts Working, Esc-interrupted and waiting for permission', () => {
    expect(unfinishedKind('working')).toBe('working');
    expect(unfinishedKind('interrupted')).toBe('interrupted');
    expect(unfinishedKind('needs-permission')).toBe('permission');
    expect(unfinishedKind('needs-answer')).toBe('question');
    expect(unfinishedReason({ kind: 'question', stopped: 0 })).toBe('Was asking a question');
    // Continued, Claude asks again; offered unticked.
    expect(canContinue('question')).toBe(true);
    expect(tickedByDefault('question')).toBe(false);
  });

  it('does not count Done, waiting for input or any other state', () => {
    const others: WorkspaceState[] = [
      'starting',
      'needs-input',
      'awaiting-approval',
      'done',
      'exited',
      'error',
    ];
    for (const state of others) expect(unfinishedKind(state)).toBeNull();
  });

  it('counts Done only while background commands still ran', () => {
    expect(unfinishedKind('done', 2)).toBe('commands');
    expect(unfinishedKind('done', 0)).toBeNull();
    expect(unfinishedKind('needs-input', 1)).toBeNull();
    expect(stoppedNote(1)).toBe('1 background command was stopped');
    expect(stoppedNote(3)).toBe('3 background commands were stopped');
    expect(unfinishedReason({ kind: 'commands', stopped: 2 })).toBe(
      '2 background commands were stopped',
    );
    expect(unfinishedTooltip({ kind: 'commands', stopped: 1 })).toMatch(
      /closed: 1 background command was stopped$/,
    );
  });

  it('never continues stopped commands by itself, and offers them unticked', () => {
    expect(continuesAtStart('commands')).toBe(false);
    expect(tickedByDefault('commands')).toBe(false);
    expect(canContinue('commands')).toBe(true);
    expect(quitNextStep([{ kind: 'commands', continues: true }])).toMatch(/^You'll be asked/);
  });
});

describe('what each kind allows', () => {
  it('continues only Working without asking, ticks only Working, never continues a permission', () => {
    expect(continuesAtStart('working')).toBe(true);
    expect(continuesAtStart('interrupted')).toBe(false);
    expect(continuesAtStart('permission')).toBe(false);
    expect(tickedByDefault('working')).toBe(true);
    expect(tickedByDefault('interrupted')).toBe(false);
    expect(canContinue('interrupted')).toBe(true);
    expect(canContinue('permission')).toBe(false);
  });

  it('uses the profile prompt, else the default', () => {
    expect(resumePrompt(null)).toBe(DEFAULT_RESUME_PROMPT);
    expect(resumePrompt({ continueAtStart: true, prompt: '  ' })).toBe(DEFAULT_RESUME_PROMPT);
    expect(resumePrompt({ continueAtStart: true, prompt: 'Go on.' })).toBe('Go on.');
    expect(DEFAULT_RESUME_PROMPT).toMatch(/was closed while you were working/);
  });
});

describe('planLimitReached (spec §11)', () => {
  const now = Date.UTC(2026, 10, 2, 12);
  const snapshot = (used: number, resetsAt: number | null) => ({
    fiveHour: { usedPercentage: used, resetsAt },
    sevenDay: { usedPercentage: 10, resetsAt: null },
    updatedAt: now,
  });

  it('is reached at 100% until the window resets', () => {
    expect(planLimitReached(snapshot(100, now + 60_000), now)).toMatch(/session limit/);
    expect(planLimitReached(snapshot(100, null), now)).toMatch(/session limit/);
    expect(planLimitReached(snapshot(100, now - 1), now)).toBeNull();
    expect(planLimitReached(snapshot(99, now + 60_000), now)).toBeNull();
    expect(planLimitReached(null, now)).toBeNull();
  });

  it('counts the week too', () => {
    expect(
      planLimitReached(
        {
          fiveHour: null,
          sevenDay: { usedPercentage: 100, resetsAt: now + 1000 },
          updatedAt: now,
        },
        now,
      ),
    ).toMatch(/week limit/);
  });
});

describe('quitNextStep (spec §5)', () => {
  it('says what comes next', () => {
    expect(quitNextStep([])).toBeNull();
    expect(quitNextStep([{ kind: 'working', continues: true }])).toMatch(/^It'll continue when/);
    expect(
      quitNextStep([
        { kind: 'working', continues: true },
        { kind: 'working', continues: true },
      ]),
    ).toMatch(/^They'll continue when .+ starts again\.$/);
    expect(quitNextStep([{ kind: 'working', continues: false }])).toMatch(
      /^You'll be asked when .+ starts again\.$/,
    );
    // Esc-interrupted and permission are never continued without asking.
    expect(quitNextStep([{ kind: 'interrupted', continues: true }])).toMatch(/^You'll be asked/);
    expect(
      quitNextStep([
        { kind: 'working', continues: true },
        { kind: 'permission', continues: true },
      ]),
    ).toMatch(/^1 will continue .+; you'll be asked about the rest\.$/);
  });
});
