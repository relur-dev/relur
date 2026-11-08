import { describe, expect, it } from 'vitest';
import { answerable, askedQuestions, optionKey, questionMarkdown } from './question';

const input = {
  questions: [
    {
      question: 'Which color do you prefer?',
      header: 'Color',
      options: [
        { label: 'Red', description: 'Choose red' },
        { label: 'Blue', description: 'Choose blue' },
      ],
      multiSelect: false,
    },
  ],
};

describe('askedQuestions', () => {
  it("reads the tool's questions, leniently", () => {
    expect(askedQuestions(input)).toEqual([
      {
        question: 'Which color do you prefer?',
        header: 'Color',
        options: [
          { label: 'Red', description: 'Choose red' },
          { label: 'Blue', description: 'Choose blue' },
        ],
        multiSelect: false,
      },
    ]);
    expect(
      askedQuestions({ questions: [{ question: ' ' }, { question: 'Why?', options: [{}] }] }),
    ).toEqual([{ question: 'Why?', header: null, options: [], multiSelect: false }]);
    expect(askedQuestions(null)).toEqual([]);
  });
});

describe('answerable', () => {
  const pending = (questions: unknown) => ({ id: 't', questions: askedQuestions({ questions }) });
  const one = input.questions[0];

  it('takes one question with one choice of up to nine options', () => {
    expect(answerable(pending([one]))).toBe(true);
    expect(answerable(pending([one, one]))).toBe(false);
    expect(answerable(pending([{ ...one, multiSelect: true }]))).toBe(false);
    expect(answerable(pending([{ ...one, options: [] }]))).toBe(false);
    const ten = Array.from({ length: 10 }, (_, i) => ({ label: `O${i}` }));
    expect(answerable(pending([{ ...one, options: ten }]))).toBe(false);
    expect(answerable(null)).toBe(false);
  });

  it("picks an option with its number, as Claude Code's menu does", () => {
    expect(optionKey(0)).toBe('1');
    expect(optionKey(8)).toBe('9');
  });
});

describe('questionMarkdown', () => {
  it('lists the question, its options and the answer once given', () => {
    const questions = askedQuestions(input);
    expect(questionMarkdown(questions)).toBe(
      '**Color** · Which color do you prefer?\n\n- Red: Choose red\n- Blue: Choose blue',
    );
    expect(
      questionMarkdown(
        questions.map((q) => ({ ...q, multiSelect: true })),
        {
          'Which color do you prefer?': 'Blue',
        },
      ),
    ).toBe(
      '**Color** · Which color do you prefer? (any of them)\n\n- Red: Choose red\n- Blue: Choose blue\n\nAnswered: Blue',
    );
  });
});
