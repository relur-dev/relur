import { describe, expect, it } from 'vitest';
import { BRAND } from './brand';
import type { WorkspaceState } from './status';
import {
  type SuspendFacts,
  suspendBlocker,
  suspendClockNote,
  suspendDefaultNotice,
  suspendDelay,
  suspendDue,
  suspendedNote,
} from './suspend';

const idle: SuspendFacts = {
  delayMin: 10,
  shown: false,
  state: 'done',
  started: true,
  background: 0,
  keepRunning: false,
  draft: false,
  resuming: false,
  conversation: true,
};

describe('suspendBlocker (spec §9.8)', () => {
  it('allows an idle session that nothing keeps', () => {
    expect(suspendBlocker(idle)).toBeNull();
  });

  it.each<WorkspaceState>(['done', 'needs-input', 'interrupted'])('counts %s as idle', (state) => {
    expect(suspendBlocker({ ...idle, state })).toBeNull();
  });

  it.each<WorkspaceState>(['working', 'needs-permission', 'exited', 'error'])(
    'never suspends while %s',
    (state) => {
      expect(suspendBlocker({ ...idle, state })).toBe('busy');
    },
  );

  it('counts Starting as idle only once SessionStart arrived', () => {
    expect(suspendBlocker({ ...idle, state: 'starting', started: false })).toBe('busy');
    expect(suspendBlocker({ ...idle, state: 'starting', started: true })).toBeNull();
  });

  it('is off without a delay', () => {
    expect(suspendBlocker({ ...idle, delayMin: null })).toBe('off');
  });

  it('never suspends a shown, kept or resuming session', () => {
    expect(suspendBlocker({ ...idle, shown: true })).toBe('shown');
    expect(suspendBlocker({ ...idle, keepRunning: true })).toBe('kept');
    expect(suspendBlocker({ ...idle, resuming: true })).toBe('resuming');
  });

  it('never suspends a Claude without a saved conversation, which a resume needs', () => {
    expect(suspendBlocker({ ...idle, conversation: false })).toBe('no-conversation');
    expect(suspendBlocker({ ...idle, state: 'starting', conversation: false })).toBe(
      'no-conversation',
    );
    expect(suspendClockNote({ workspaceId: 'w', blocker: 'no-conversation', dueAt: null }, 0)).toBe(
      'Not suspended: no conversation yet',
    );
  });

  it('never suspends with background work', () => {
    expect(suspendBlocker({ ...idle, background: 1 })).toBe('background');
    expect(suspendBlocker({ ...idle, state: 'working', background: 2 })).toBe('busy');
  });

  it('keeps a session with an unsent draft', () => {
    expect(suspendBlocker({ ...idle, draft: true })).toBe('draft');
  });
});

describe('suspendDue', () => {
  it('is due once the whole delay has passed', () => {
    expect(suspendDue(0, 299_999, 5)).toBe(false);
    expect(suspendDue(0, 300_000, 5)).toBe(true);
    expect(suspendDue(1000, 1000 + 30 * 100, 30, 100)).toBe(true);
  });
});

describe('suspendClockNote', () => {
  const clock = { workspaceId: 'w', blocker: null, dueAt: null } as const;
  it('says why a session is kept running', () => {
    expect(suspendClockNote({ ...clock, blocker: 'draft' }, 0)).toBe(
      'Not suspended: a draft in the prompt',
    );
    expect(suspendClockNote({ ...clock, blocker: 'kept' }, 0)).toBe(
      'Not suspended: Keep Claude Running is on',
    );
  });

  it('says when a running clock ends, and nothing while suspension is off', () => {
    expect(suspendClockNote({ ...clock, dueAt: 150_000 }, 0)).toBe(
      'Suspended in 3 min if it stays idle',
    );
    expect(suspendClockNote({ ...clock, dueAt: 1000 }, 5000)).toBe(
      'Suspended in 1 min if it stays idle',
    );
    expect(suspendClockNote({ ...clock, blocker: 'off' }, 0)).toBeNull();
  });
});

describe('suspendedNote', () => {
  it('counts sessions', () => {
    expect(suspendedNote(1)).toBe('1 session suspended');
    expect(suspendedNote(3)).toBe('3 sessions suspended');
  });
});

describe('suspendDelay (spec §9.8)', () => {
  it('reads a profile that never chose as the default, 0 as Off and a number as it is', () => {
    expect(suspendDelay({})).toBe(10);
    expect(suspendDelay({ suspendIdleMin: null })).toBe(10);
    expect(suspendDelay({ suspendIdleMin: 0 })).toBeNull();
    expect(suspendDelay({ suspendIdleMin: 5 })).toBe(5);
    expect(suspendDelay({ suspendIdleMin: 30 })).toBe(30);
  });
});

describe('suspendDefaultNotice (spec §9.8)', () => {
  const text = `${BRAND.displayName} now suspends Claude sessions you haven't used for 10 minutes, to save memory. They resume when you open them.`;

  it('names the profiles only when there are several', () => {
    expect(suspendDefaultNotice(['Work'])).toBe(text);
    expect(suspendDefaultNotice(['Work', 'Personal'])).toBe(`${text} Profiles: Work and Personal.`);
    expect(suspendDefaultNotice(['A', 'B', 'C'])).toBe(`${text} Profiles: A, B and C.`);
  });
});
