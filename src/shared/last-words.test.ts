import { describe, expect, it } from 'vitest';
import { chooseLastWords, lastParagraph, plainText } from './last-words';
import type { PendingQuestion } from './question';

const entry = (...parts: (string | { text: string; question: true })[]) => ({
  parts: parts.map((p) => (typeof p === 'string' ? { text: p } : p)),
});
const none = { pending: null, gate: null };
const color: PendingQuestion = {
  id: 'toolu_1',
  questions: [
    {
      question: 'Which color do you prefer?',
      header: 'Color',
      options: [
        { label: 'Red', description: null },
        { label: 'Blue', description: null },
      ],
      multiSelect: false,
    },
  ],
};

describe('chooseLastWords', () => {
  it('shows the question Claude waits on, at its entry', () => {
    const words = chooseLastWords(
      [entry('Earlier.'), entry('Let me ask.', { text: '**Color** · …', question: true })],
      { pending: color, gate: null },
    );
    expect(words).toEqual({
      kind: 'question',
      lead: 'Claude asked:',
      text: 'Which color do you prefer?',
      entry: 1,
      question: color,
    });
  });

  it('counts the further questions of one call', () => {
    const two = { ...color, questions: [...color.questions, ...color.questions] };
    expect(chooseLastWords([entry()], { pending: two, gate: null })?.text).toBe(
      'Which color do you prefer? (+1 more)',
    );
  });

  it('a question wins over a gate', () => {
    const gate = { label: 'Spec review', hint: 'Approve the spec' };
    expect(chooseLastWords([entry('Done.')], { pending: color, gate })?.kind).toBe('question');
  });

  it("at a gate, the end of Claude's last message, else the gate's hint", () => {
    const gate = { label: 'Spec review', hint: 'Review and approve the spec' };
    expect(
      chooseLastWords([entry('Wrote the spec.\n\nPlease review `spec.md` and approve.')], {
        pending: null,
        gate,
      }),
    ).toEqual({
      kind: 'gate',
      lead: 'At Spec review, Claude:',
      text: 'Please review spec.md and approve.',
      entry: 0,
      question: null,
    });
    expect(chooseLastWords([], { pending: null, gate })).toEqual({
      kind: 'gate',
      lead: 'At Spec review:',
      text: 'Review and approve the spec',
      entry: null,
      question: null,
    });
    expect(chooseLastWords([], { pending: null, gate: { ...gate, hint: null } })).toBeNull();
  });

  it("otherwise the end of Claude's last message, a question mark asking", () => {
    expect(chooseLastWords([entry('First.', 'Fixed the **links**.')], none)).toEqual({
      kind: 'said',
      lead: 'Claude:',
      text: 'Fixed the links.',
      entry: 0,
      question: null,
    });
    expect(chooseLastWords([entry('Shall I also update the tests?')], none)?.lead).toBe(
      'Claude asked:',
    );
  });

  it('goes back past entries without text and answered questions', () => {
    const words = chooseLastWords(
      [entry('Here it is.'), entry({ text: '**Color** · …', question: true }), entry()],
      none,
    );
    expect(words).toMatchObject({ text: 'Here it is.', entry: 0 });
  });

  it('is nothing for a fresh session', () => {
    expect(chooseLastWords([], none)).toBeNull();
    expect(chooseLastWords([entry()], none)).toBeNull();
    expect(chooseLastWords([entry('```\n```')], none)).toBeNull();
  });
});

describe('lastParagraph', () => {
  it('is the last paragraph with text, as plain text, its start cut when long', () => {
    expect(lastParagraph('# Summary\n\n- one\n- two\n\n')).toBe('one two');
    expect(lastParagraph('Intro.\n\n```ts\nconst a = 1;\n```')).toBe('const a = 1;');
    const long = lastParagraph(`Start ${'word '.repeat(200)}end.`);
    expect(long.startsWith('…')).toBe(true);
    expect(long.endsWith('end.')).toBe(true);
    expect(long.length).toBeLessThanOrEqual(400);
  });
});

describe('plainText', () => {
  it('drops Markdown marks and keeps the words', () => {
    expect(plainText('> See [the docs](https://example.com) and _this_ or *that*.')).toBe(
      'See the docs and this or that.',
    );
    expect(plainText('## Done\n1. `npm test` passes\n2. **all** green')).toBe(
      'Done npm test passes all green',
    );
    expect(plainText('snake_case_name stays')).toBe('snake_case_name stays');
  });
});
