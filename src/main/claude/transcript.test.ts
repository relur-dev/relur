import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  awaitLastResponse,
  endsWithDeniedPermission,
  isBackgroundHandBack,
  readConversation,
  readPrompts,
  readResponses,
  shownPrompt,
  watchTranscript,
} from './transcript';

let file: string;
beforeEach(() => {
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-')), 's.jsonl');
});
afterEach(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));

const line = (entry: unknown) => JSON.stringify(entry);
const user = (content: unknown, extra = {}) =>
  line({ type: 'user', message: { role: 'user', content }, ...extra });
const assistant = (content: unknown, timestamp: string) =>
  line({ type: 'assistant', message: { role: 'assistant', content }, timestamp });

describe('readResponses', () => {
  const part = (text: string, afterBackground = false) => ({ text, afterBackground });

  it("gives one entry per prompt, each of Claude's messages a part, without tool calls", () => {
    fs.writeFileSync(
      file,
      [
        line({ type: 'summary', summary: 'x' }),
        user('<command-name>/clear</command-name>', { isMeta: true }),
        user('Fix the login bug', { origin: { kind: 'human' }, timestamp: 't0' }),
        // Claude Code writes a message's blocks as entries of their own.
        line({
          type: 'assistant',
          message: { id: 'm1', content: [{ type: 'thinking', thinking: '…' }] },
          timestamp: 't1',
        }),
        line({
          type: 'assistant',
          message: { id: 'm1', content: [{ type: 'text', text: 'Looking at it.' }] },
          timestamp: 't1',
        }),
        line({
          type: 'assistant',
          message: { id: 'm1', content: [{ type: 'text', text: 'First the tests.' }] },
          timestamp: 't1',
        }),
        line({
          type: 'assistant',
          message: { id: 'm1', content: [{ type: 'tool_use', name: 'Bash' }] },
          timestamp: 't1',
        }),
        user([{ type: 'tool_result', content: 'ok' }]),
        line({
          type: 'assistant',
          message: { id: 'm2', content: [{ type: 'tool_use', name: 'Read' }] },
          timestamp: 't2',
        }),
        user([{ type: 'tool_result', content: 'ok' }]),
        assistant([{ type: 'text', text: 'Found it in `auth.ts`.' }], 't3'),
        assistant([{ type: 'tool_use', name: 'Edit' }], 't3'),
        user([{ type: 'tool_result', content: 'ok' }]),
        assistant([{ type: 'text', text: 'Fixed **it**.\n\n```ts\nx\n```' }], 't4'),
        user([{ type: 'text', text: 'Thanks' }]),
        assistant('You are welcome.', 't5'),
        'not json',
        '',
      ].join('\n'),
    );
    expect(readResponses(file)).toMatchObject([
      {
        text: 'Looking at it.\n\nFirst the tests.\n\nFound it in `auth.ts`.\n\nFixed **it**.\n\n```ts\nx\n```',
        parts: [
          part('Looking at it.\n\nFirst the tests.'),
          part('Found it in `auth.ts`.'),
          part('Fixed **it**.\n\n```ts\nx\n```'),
        ],
        at: 't4',
        prompt: 'Fix the login bug',
        interrupted: false,
      },
      {
        text: 'You are welcome.',
        parts: [part('You are welcome.')],
        at: 't5',
        prompt: 'Thanks',
        interrupted: false,
      },
    ]);
  });

  it('joins the text after background work handing back to the entry, marked', () => {
    fs.writeFileSync(
      file,
      [
        user('Run the tests in the background'),
        assistant('Started them.', 't1'),
        // A command's notification, by its text; an agent's report, by its origin.
        user('<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>'),
        assistant('The tests passed.', 't2'),
        user([{ type: 'text', text: '<agent-message from="a1">\nReport' }]),
        user('<task-notification>\n<task-id>a2</task-id>', {
          origin: { kind: 'task-notification' },
        }),
        assistant([{ type: 'tool_use', name: 'Read' }], 't3'),
        user([{ type: 'tool_result', content: 'ok' }]),
        assistant('Both agents are done.', 't4'),
        user('Thanks'),
        assistant('Welcome.', 't5'),
      ].join('\n'),
    );
    const [first, second] = readResponses(file);
    expect(first).toMatchObject({
      text: 'Started them.\n\nThe tests passed.\n\nBoth agents are done.',
      parts: [
        part('Started them.'),
        part('The tests passed.', true),
        part('Both agents are done.', true),
      ],
      at: 't4',
      prompt: 'Run the tests in the background',
      interrupted: false,
    });
    expect(second?.prompt).toBe('Thanks');
    expect(isBackgroundHandBack('<agent-message from="a1">')).toBe(true);
    expect(isBackgroundHandBack('Explain <task-notification> to me')).toBe(false);
  });

  it('keeps a prompt without text, and starts no entry at interrupt notes or a summary', () => {
    fs.writeFileSync(
      file,
      [
        user('Format the files', { timestamp: 't0' }),
        assistant([{ type: 'tool_use', name: 'Bash' }], 't1'),
        user([{ type: 'tool_result', content: 'ok' }]),
        user('Write the notes'),
        assistant('Writing them.', 't2'),
        assistant([{ type: 'tool_use', name: 'Write' }], 't2'),
        user([{ type: 'tool_result', content: 'denied', is_error: true }]),
        user([{ type: 'text', text: '[Request interrupted by user for tool use]' }]),
        user([{ type: 'text', text: '[Request interrupted by user]' }]),
        user('This session is being continued from a previous conversation…', {
          isCompactSummary: true,
          isVisibleInTranscriptOnly: true,
        }),
        assistant('Notes written.', 't3'),
      ].join('\n'),
    );
    expect(readResponses(file)).toMatchObject([
      { text: '', parts: [], at: 't1', prompt: 'Format the files', interrupted: false },
      {
        text: 'Writing them.\n\nNotes written.',
        parts: [part('Writing them.'), part('Notes written.')],
        at: 't3',
        prompt: 'Write the notes',
        interrupted: false,
      },
    ]);
  });

  it('marks an entry interrupted with Esc, its partial text kept, unless Claude wrote on', () => {
    fs.writeFileSync(
      file,
      [
        user('Explain the build', { origin: { kind: 'human' }, timestamp: 't0' }),
        assistant('The build has three steps. First', 't1'),
        user([{ type: 'text', text: '[Request interrupted by user]' }]),
        user('Run the tests', { origin: { kind: 'human' } }),
        assistant([{ type: 'tool_use', name: 'Bash' }], 't2'),
        user([{ type: 'tool_result', content: 'denied', is_error: true }]),
        user([{ type: 'text', text: '[Request interrupted by user for tool use]' }]),
        user('Say hi', { origin: { kind: 'human' } }),
        assistant('Hi.', 't3'),
      ].join('\n'),
    );
    expect(readResponses(file).map((r) => [r.prompt, r.text, r.interrupted])).toEqual([
      ['Explain the build', 'The build has three steps. First', true],
      ['Run the tests', '', true],
      ['Say hi', 'Hi.', false],
    ]);
  });

  it('takes a prompt sent by an answer button or Continue, a pasted one and a skill command', () => {
    fs.writeFileSync(
      file,
      [
        // Pasted and sent with Enter, as an answer button or Continue does.
        user('I approve the spec.', { origin: { kind: 'human' } }),
        assistant('Starting step 2.', 't1'),
        user(
          '<pasted_content id="ab12">\nContinue where you left off.\n</pasted_content id="ab12">\n',
          {
            origin: { kind: 'human' },
          },
        ),
        assistant('Continuing.', 't2'),
        user('<command-message>review</command-message>\n<command-name>/review</command-name>', {
          origin: { kind: 'human' },
        }),
        assistant('Reviewed.', 't3'),
        // A local command's output isn't a prompt: it doesn't end the entry.
        user('<local-command-stdout>Set model</local-command-stdout>'),
        assistant('Also checked.', 't4'),
      ].join('\n'),
    );
    expect(readResponses(file).map((r) => [r.prompt, r.text])).toEqual([
      ['I approve the spec.', 'Starting step 2.'],
      ['Continue where you left off.', 'Continuing.'],
      ['/review', 'Reviewed.\n\nAlso checked.'],
    ]);
  });

  it('gives a prompt without an answer yet an empty entry, none for a missing file', () => {
    expect(readResponses(path.join(path.dirname(file), 'missing.jsonl'))).toEqual([]);
    fs.writeFileSync(file, user('Hello'));
    expect(readResponses(file)).toMatchObject([
      { text: '', parts: [], at: null, prompt: 'Hello', interrupted: false },
    ]);
  });
});

// Claude's question tool as Claude Code 2.1.319 writes it: the call, then its result.
const QUESTION = {
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
const ask = (id: string, timestamp: string) =>
  line({
    type: 'assistant',
    message: {
      id: `m-${id}`,
      content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: QUESTION }],
    },
    timestamp,
  });
const answered = (id: string, answer: string) =>
  user(
    [
      {
        type: 'tool_result',
        tool_use_id: id,
        content: `The user answered: "Which color do you prefer?"="${answer}".`,
      },
    ],
    { toolUseResult: { ...QUESTION, answers: { 'Which color do you prefer?': answer } } },
  );

describe('prompt ids and prompts taken in while Claude worked (spec §6.15)', () => {
  it("gives each entry its prompt's uuid and time, else its line", () => {
    fs.writeFileSync(
      file,
      [
        user('Fix the login', { uuid: 'u1', origin: { kind: 'human' }, timestamp: 't1' }),
        assistant([{ type: 'text', text: 'Done.' }], 't2'),
        user('And now?'),
      ].join('\n'),
    );
    const [first, second] = readResponses(file);
    expect(first).toMatchObject({ id: 'u1', promptAt: 't1', queued: [] });
    expect(second).toMatchObject({ id: 'line:3', promptAt: null });
  });

  it("adds a prompt sent while Claude worked to the running turn's entry, not one of its own", () => {
    const queued = (prompt: string, extra = {}) =>
      line({
        type: 'attachment',
        uuid: 'q1',
        timestamp: 't3',
        attachment: {
          type: 'queued_command',
          prompt,
          commandMode: 'prompt',
          origin: { kind: 'human' },
          ...extra,
        },
      });
    fs.writeFileSync(
      file,
      [
        user('Run the tests', { uuid: 'u1', origin: { kind: 'human' }, timestamp: 't1' }),
        line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }),
        user([{ type: 'tool_result', content: 'ok' }], { uuid: 'r1' }),
        queued('Also say <b>BANANA</b>.'),
        line({ type: 'attachment', uuid: 'x', attachment: { type: 'date', date: 'today' } }),
        assistant([{ type: 'text', text: 'Passed. BANANA' }], 't4'),
      ].join('\n'),
    );
    const responses = readResponses(file);
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      id: 'u1',
      prompt: 'Run the tests',
      queued: [{ id: 'q1', text: 'Also say <b>BANANA</b>.', at: 't3' }],
      text: 'Passed. BANANA',
    });
  });
});

describe('readConversation', () => {
  const asked = '**Color** · Which color do you prefer?\n\n- Red: Choose red\n- Blue: Choose blue';

  it('gives the question Claude waits on, and its part of the entry', () => {
    fs.writeFileSync(
      file,
      [
        user('Pick a color', { origin: { kind: 'human' } }),
        assistant([{ type: 'text', text: 'Let me ask.' }], 't1'),
        ask('toolu_1', 't2'),
      ].join('\n'),
    );
    const { responses, pending } = readConversation(file);
    expect(pending).toEqual({
      id: 'toolu_1',
      questions: [expect.objectContaining({ header: 'Color' })],
    });
    expect(responses[0]?.parts).toEqual([
      { text: 'Let me ask.', afterBackground: false },
      { text: asked, afterBackground: false, question: true },
    ]);
    expect(responses[0]?.text).toBe(`Let me ask.\n\n${asked}`);
  });

  it('adds the answer once given, and then nothing waits', () => {
    fs.writeFileSync(
      file,
      [
        user('Pick a color', { origin: { kind: 'human' } }),
        ask('toolu_1', 't1'),
        answered('toolu_1', 'Blue'),
        assistant([{ type: 'text', text: 'Blue' }], 't2'),
      ].join('\n'),
    );
    const { responses, pending } = readConversation(file);
    expect(pending).toBeNull();
    expect(responses[0]?.parts).toEqual([
      { text: `${asked}\n\nAnswered: Blue`, afterBackground: false, question: true },
      { text: 'Blue', afterBackground: false },
    ]);
  });

  it('nothing waits after an interrupted question or a new prompt', () => {
    const interrupted = user([
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'interrupted', is_error: true },
    ]);
    fs.writeFileSync(file, [user('Pick'), ask('toolu_1', 't1'), interrupted].join('\n'));
    expect(readConversation(file).pending).toBeNull();
    fs.writeFileSync(file, [user('Pick'), ask('toolu_1', 't1'), user('Never mind')].join('\n'));
    expect(readConversation(file).pending).toBeNull();
    expect(readConversation(path.join(path.dirname(file), 'missing.jsonl'))).toEqual({
      responses: [],
      pending: null,
    });
  });
});

// As Claude Code 2.1.318 writes a paste in the hook's prompt and the transcript.
const PASTE =
  'Context first: \n\n<pasted_content id="5780">\nReply with one word.\nLine two.\n</pasted_content id="5780">\n';

describe('shownPrompt', () => {
  it("is a prompt as Claude shows it: pasted text without Claude's tags", () => {
    expect(shownPrompt(PASTE)).toBe('Context first: \nReply with one word.\nLine two.');
    expect(
      shownPrompt('\n\n<pasted_content id="1">\nOnly pasted\n</pasted_content id="1">\n'),
    ).toBe('Only pasted');
    expect(shownPrompt('  typed <b>as is</b> ')).toBe('typed <b>as is</b>');
  });
});

describe('readPrompts', () => {
  it('lists the prompts typed or pasted, oldest first, without hand-backs or commands', () => {
    fs.writeFileSync(
      file,
      [
        user('<command-name>/model</command-name>'),
        user('AB-10247 backend: fix the login'),
        assistant('AB-10247 backend: done', 't1'),
        user([{ type: 'tool_result', content: 'ok' }]),
        user('<task-notification><task-id>b1</task-id></task-notification>'),
        user('Caveat', { isMeta: true }),
        user(PASTE),
        user([{ type: 'text', text: 'ok' }]),
        'not json',
      ].join('\n'),
    );
    expect(readPrompts(file)).toEqual([
      'AB-10247 backend: fix the login',
      'Context first: \nReply with one word.\nLine two.',
      'ok',
    ]);
    expect(readPrompts(path.join(path.dirname(file), 'missing.jsonl'))).toEqual([]);
  });
});

describe('endsWithDeniedPermission', () => {
  // As Claude Code 2.1.312 writes a permission prompt answered No.
  const denied = [
    user('Run the link command'),
    assistant([{ type: 'tool_use', name: 'Bash' }], '2026-10-29T10:00:00Z'),
    user(
      [
        {
          type: 'tool_result',
          content: "The user doesn't want to proceed with this tool use.",
          is_error: true,
        },
      ],
      { toolUseResult: 'User rejected tool use' },
    ),
    line({ type: 'attachment' }),
    user([{ type: 'text', text: '[Request interrupted by user for tool use]' }]),
    line({ type: 'system' }),
    line({ type: 'last-prompt' }),
  ];

  it('sees a denied permission at the end of the transcript', () => {
    fs.writeFileSync(file, `${denied.join('\n')}\n`);
    expect(endsWithDeniedPermission(file)).toBe(true);
  });

  it('is false once Claude goes on, or without a denial', () => {
    fs.writeFileSync(
      file,
      [...denied, user('Say ok'), assistant([{ type: 'text', text: 'ok' }], 'x')].join('\n'),
    );
    expect(endsWithDeniedPermission(file)).toBe(false);
    fs.writeFileSync(file, denied.slice(0, 2).join('\n'));
    expect(endsWithDeniedPermission(file)).toBe(false);
    expect(endsWithDeniedPermission(path.join(path.dirname(file), 'missing.jsonl'))).toBe(false);
  });
});

describe('awaitLastResponse', () => {
  it('waits until the last response ends with the Stop hook message, then gives all of it', async () => {
    fs.writeFileSync(
      file,
      `${[
        user('First'),
        assistant('Old answer.', 't0'),
        user('Fix it'),
        assistant(
          [
            { type: 'text', text: 'Looking.' },
            { type: 'tool_use', name: 'Bash' },
          ],
          't1',
        ),
      ].join('\n')}\n`,
    );
    // Claude Code writes the response after running the Stop hook.
    setTimeout(() => fs.appendFileSync(file, `${assistant('Fixed **it**.', 't2')}\n`), 250);
    expect(await awaitLastResponse(file, 'Fixed **it**.\n')).toBe('Looking.\n\nFixed **it**.');
  });

  it('starts the last response after background work handing back', async () => {
    fs.writeFileSync(
      file,
      `${[
        user('Run it in the background'),
        assistant('Started.', 't1'),
        user('<task-notification>\n<task-id>b1</task-id>'),
        assistant('It finished.', 't2'),
      ].join('\n')}\n`,
    );
    expect(await awaitLastResponse(file, 'It finished.')).toBe('It finished.');
  });

  it("gives the hook's message when the transcript doesn't get there, null without text", async () => {
    fs.writeFileSync(file, `${[user('Fix it'), assistant('Partial.', 't1')].join('\n')}\n`);
    expect(await awaitLastResponse(file, 'Done.', 300)).toBe('Done.');
    fs.writeFileSync(file, `${user('Run it')}\n`);
    expect(await awaitLastResponse(file, null, 300)).toBeNull();
    expect(
      await awaitLastResponse(path.join(path.dirname(file), 'none.jsonl'), null, 100),
    ).toBeNull();
  });
});

describe('watchTranscript', () => {
  it('tells when the file grows, appears, or another file takes its place', async () => {
    let current: string | null = null;
    let changes = 0;
    const stop = watchTranscript(
      () => current,
      () => changes++,
      20,
    );
    const settle = () => new Promise((resolve) => setTimeout(resolve, 80));
    await settle();
    expect(changes).toBe(0);
    current = file;
    await settle();
    expect(changes).toBe(1);
    fs.writeFileSync(file, `${user('Fix it')}\n`);
    await settle();
    expect(changes).toBe(2);
    await settle();
    expect(changes).toBe(2);
    const other = path.join(path.dirname(file), 'cleared.jsonl');
    fs.writeFileSync(other, '');
    current = other;
    await settle();
    expect(changes).toBe(3);
    stop();
    fs.appendFileSync(other, `${user('More')}\n`);
    await settle();
    expect(changes).toBe(3);
  });
});
