import { describe, expect, it } from 'vitest';
import {
  composePrompt,
  entryOf,
  type HeldSendFacts,
  heldSendDecision,
  type MatchEntry,
  matchSends,
  QUEUED,
} from './notes';

describe('composePrompt (spec §6.15)', () => {
  it('sends one item as written, trimmed', () => {
    expect(composePrompt(['  Rename the flag to\n`--dry-run`.\n'])).toBe(
      'Rename the flag to\n`--dry-run`.',
    );
  });

  it('sends several as a numbered list, each item its own point', () => {
    expect(composePrompt(['Check the README', 'Add a test'])).toBe(
      '1. Check the README\n\n2. Add a test',
    );
  });

  it("indents an item's further lines into its point and leaves blank lines blank", () => {
    expect(composePrompt(['First line\nsecond line\n\nafter a gap', 'Next'])).toBe(
      '1. First line\n   second line\n\n   after a gap\n\n2. Next',
    );
  });

  it('skips empty items; nothing gives nothing', () => {
    expect(composePrompt(['  ', 'Only this', ''])).toBe('Only this');
    expect(composePrompt([])).toBe('');
  });

  it('numbers past nine with a wider indent', () => {
    const texts = Array.from({ length: 10 }, (_, i) => `Item ${i + 1}\nmore`);
    const prompt = composePrompt(texts);
    expect(prompt).toContain('9. Item 9\n   more');
    expect(prompt).toContain('10. Item 10\n    more');
  });
});

describe('heldSendDecision (spec §6.15)', () => {
  const running = { status: 'running' as const, resuming: false };
  const facts = (over: Partial<HeldSendFacts> = {}): HeldSendFacts => ({
    state: 'done',
    gate: null,
    claude: running,
    draft: false,
    question: false,
    asked: false,
    ...over,
  });
  const waiting = (over: Partial<HeldSendFacts>) => {
    const d = heldSendDecision(facts(over));
    return d.send ? null : d.waiting;
  };

  it('sends once Claude is done and nothing is in the way', () => {
    expect(heldSendDecision(facts())).toEqual({ send: true });
  });

  it('stays queued while Claude works or starts', () => {
    expect(waiting({ state: 'working' })).toBe(QUEUED);
    expect(waiting({ state: 'starting' })).toBe(QUEUED);
  });

  it('waits at a permission request or a question, sent after the turn that follows', () => {
    expect(waiting({ state: 'needs-permission' })).toBe('Waiting: Claude is asking for permission');
    expect(waiting({ state: 'needs-answer' })).toBe('Waiting: Claude asked a question');
    // Claude Code reports its question menu as Working first.
    expect(waiting({ state: 'working', question: true })).toBe('Waiting: Claude asked a question');
  });

  it("waits when Claude's turn ends with a question in its text", () => {
    expect(waiting({ asked: true })).toBe('Waiting: Claude asked something');
  });

  it('waits at a gate, after an interrupt and while Claude waits for an answer', () => {
    expect(waiting({ state: 'awaiting-approval', gate: 'Spec review' })).toBe(
      'Waiting: Claude is at Spec review',
    );
    expect(waiting({ state: 'interrupted' })).toMatch(/interrupted/);
    expect(waiting({ state: 'needs-input' })).toBe('Waiting: Claude is waiting for your answer');
  });

  it('never types over a draft, nor resumes a suspended Claude', () => {
    expect(waiting({ draft: true })).toBe('Waiting: an unsent prompt in the terminal');
    expect(waiting({ claude: { status: 'suspended', resuming: false } })).toMatch(/suspended/);
    expect(waiting({ claude: { status: 'running', resuming: true } })).toMatch(/suspended/);
  });

  it('waits without a running Claude', () => {
    expect(waiting({ claude: null })).toBe("Waiting: Claude isn't running");
    expect(waiting({ claude: { status: 'exited', resuming: false } })).toBe(
      "Waiting: Claude isn't running",
    );
  });
});

describe('matchSends and entryOf (spec §6.15)', () => {
  const entry = (
    id: string,
    prompt: string,
    promptAt: string,
    queued: MatchEntry['queued'] = [],
  ) => ({
    id,
    prompt,
    promptAt,
    queued,
  });
  const send = (id: string, text: string, sentAt: string, ref: string | null = null) => ({
    id,
    text,
    sentAt,
    ref,
  });

  it('finds a send by its text, whitespace aside', () => {
    const entries = [
      entry('u1', 'Fix it', '2026-11-09T10:00:00Z'),
      entry('u2', '1. A\n\n2. B', '2026-11-09T10:05:01Z'),
    ];
    const found = matchSends(entries, [send('s1', '1. A\n\n2.  B ', '2026-11-09T10:05:00Z')]);
    expect(found).toEqual(new Map([['s1', 'u2']]));
    expect(entryOf(entries, 'u2')).toBe(1);
  });

  it('never matches the same text sent earlier, before the send', () => {
    const entries = [
      entry('u1', 'Run the tests', '2026-11-09T10:00:00Z'),
      entry('u2', 'Run the tests', '2026-11-09T11:00:02Z'),
    ];
    expect(matchSends(entries, [send('s1', 'Run the tests', '2026-11-09T11:00:00Z')])).toEqual(
      new Map([['s1', 'u2']]),
    );
  });

  it('gives each prompt to one send, oldest send first, and keeps earlier matches', () => {
    const entries = [
      entry('u1', 'Again', '2026-11-09T10:00:01Z'),
      entry('u2', 'Again', '2026-11-09T10:01:01Z'),
    ];
    const sends = [
      send('s2', 'Again', '2026-11-09T10:01:00Z'),
      send('s1', 'Again', '2026-11-09T10:00:00Z', 'u1'),
    ];
    expect(matchSends(entries, sends)).toEqual(new Map([['s2', 'u2']]));
  });

  it('waits for a prompt not written yet', () => {
    const entries = [entry('u1', 'Earlier', '2026-11-09T10:00:00Z')];
    expect(matchSends(entries, [send('s1', 'Later', '2026-11-09T10:01:00Z')]).size).toBe(0);
  });

  it('finds a prompt sent while Claude worked in the running entry', () => {
    const entries = [
      entry('u1', 'Run the tests', '2026-11-09T10:00:00Z', [
        { id: 'q1', text: 'Also lint', at: '2026-11-09T10:00:09Z' },
      ]),
      entry('u2', 'Thanks', '2026-11-09T10:02:00Z'),
    ];
    const found = matchSends(entries, [send('s1', 'Also lint', '2026-11-09T10:00:08Z')]);
    expect(found).toEqual(new Map([['s1', 'q1']]));
    expect(entryOf(entries, 'q1')).toBe(0);
    expect(entryOf(entries, 'gone')).toBeNull();
  });

  it('takes a prompt without a time', () => {
    const entries = [{ id: 'line:4', prompt: 'Go', promptAt: null, queued: [] }];
    expect(matchSends(entries, [send('s1', 'Go', '2026-11-09T10:00:00Z')])).toEqual(
      new Map([['s1', 'line:4']]),
    );
  });
});
