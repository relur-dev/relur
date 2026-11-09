import fs from 'node:fs';
import {
  type AskedQuestion,
  askedQuestions,
  type PendingQuestion,
  QUESTION_TOOL,
  questionMarkdown,
} from '@shared/question';

/** One of Claude's messages in a turn: its text, without tool calls (spec §6.8). */
export interface ResponsePart {
  text: string;
  /** It follows background work handing back to Claude, not a prompt (spec §6.8). */
  afterBackground: boolean;
  /** Claude's question tool: the questions, their options and the answers (spec §6.8). */
  question?: true;
}

/**
 * One entry of the Responses panel: everything Claude wrote after a prompt,
 * until the next one (spec §6.8).
 */
export interface TranscriptResponse {
  /** The whole entry as Markdown: its parts, separated by blank lines. */
  text: string;
  /** Claude's messages in order; tool work came between them. Empty: no text. */
  parts: ResponsePart[];
  /** When Claude last wrote in it (ISO), else when the prompt was sent, if the transcript says. */
  at: string | null;
  /** The prompt it answers, as shown; null when the transcript doesn't have it. */
  prompt: string | null;
  /**
   * Its turn was interrupted (Esc, or a permission answered No) and Claude
   * wrote nothing after: its text is what Claude got to (spec §6.8).
   */
  interrupted: boolean;
  /**
   * Its prompt's transcript id (`uuid`), else `line:<n>` of its line; null
   * for an entry without a prompt. Notes find their prompt by it (spec §6.15).
   */
  id: string | null;
  /** When its prompt was sent, if the transcript says. */
  promptAt: string | null;
  /**
   * Prompts sent while Claude worked: Claude Code takes them into this turn
   * (a `queued_command` attachment, checked live with 2.1.321), so they have
   * no entry of their own (spec §6.15).
   */
  queued: { id: string; text: string; at: string | null }[];
}

const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * Whether a prompt is Claude Code handing background work back to Claude (a
 * command's `<task-notification>`, an agent's `<agent-message>`), which
 * starts a turn the user didn't type (spec §6.8, §10.2).
 */
export const isBackgroundHandBack = (text: string | null | undefined): boolean =>
  typeof text === 'string' && /^\s*<(task-notification|agent-message)[\s>]/.test(text);

/** Whether a user entry is such a hand-back: by its origin, else by its text. */
function isHandBack(entry: Record<string, unknown>): boolean {
  const kind = record(entry.origin)?.kind;
  if (kind === 'task-notification' || kind === 'agent-message') return true;
  const content = record(entry.message)?.content;
  if (typeof content === 'string') return isBackgroundHandBack(content);
  if (!Array.isArray(content)) return false;
  const first = content.map(record).find((p) => p?.type === 'text');
  return isBackgroundHandBack(typeof first?.text === 'string' ? first.text : null);
}

const PASTED = /\n*<pasted_content id="[^"]*">\n?([\s\S]*?)\n?<\/pasted_content id="[^"]*">\n?/g;

/**
 * A prompt as Claude Code shows it in its terminal: pasted text, which it
 * wraps in `<pasted_content id="…">` tags in the hook's prompt and the
 * transcript (checked live with 2.1.318; the app sends its prompts as a
 * paste, spec §14.1), without the tags (spec §6.8).
 */
export const shownPrompt = (text: string): string => text.replace(PASTED, '\n$1\n').trim();

/** A skill command the user sent, as `/name args`; null for any other text. */
function commandPrompt(text: string): string | null {
  const name = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(text)?.[1];
  if (!name) return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
  return args ? `${name} ${args}` : name;
}

/** The texts of a user entry's message: its string, or its text parts. */
function userTexts(entry: Record<string, unknown>): string[] {
  const content = record(entry.message)?.content;
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content
    .map((part) => {
      const p = record(part);
      return p?.type === 'text' && typeof p.text === 'string' ? p.text : null;
    })
    .filter((t) => t !== null);
}

/**
 * A prompt the user sent while Claude worked, as Claude Code records it when
 * it takes it into the running turn: a `queued_command` attachment from a
 * human (checked live with 2.1.321); null for any other attachment.
 */
function queuedPrompt(entry: Record<string, unknown>): string | null {
  const attachment = record(entry.attachment);
  if (attachment?.type !== 'queued_command' || typeof attachment.prompt !== 'string') return null;
  const kind = record(attachment.origin)?.kind;
  if (kind !== undefined && kind !== 'human') return null;
  if (attachment.commandMode !== undefined && attachment.commandMode !== 'prompt') return null;
  return shownPrompt(attachment.prompt) || null;
}

/** Whether a user entry is a prompt the user sent (not a tool result or app note). */
function isPrompt(entry: Record<string, unknown>): boolean {
  return promptText(entry) !== null;
}

/** The note Claude Code writes when a turn is interrupted (Esc, or a permission answered No). */
const INTERRUPTED = /^\[Request interrupted by user/;

/**
 * The text of a prompt the user sent, typed or pasted (an answer button or
 * Continue pastes it), as shown in the Responses panel; null for a tool
 * result, an interrupt note, a compacted conversation's summary or an app
 * note. Claude Code marks prompts with `origin.kind` `human`; without an
 * origin (older transcripts), a text that isn't markup is one.
 */
function promptText(entry: Record<string, unknown>): string | null {
  if (entry.isMeta === true || entry.isCompactSummary === true) return null;
  const origin = record(entry.origin)?.kind;
  if (origin !== undefined && origin !== 'human') return null;
  const human = origin === 'human';
  const parts = userTexts(entry)
    .map((t) => (human && commandPrompt(t)) || shownPrompt(t))
    .filter((t) => t && (human || (!t.startsWith('<') && !INTERRUPTED.test(t))));
  return parts.length > 0 ? parts.join('\n\n') : null;
}

/**
 * A prompt as the prompt markers find it in Claude's reprint (spec §6.8): any
 * user text that isn't markup once pastes are unwrapped; null otherwise.
 */
function typedPrompt(entry: Record<string, unknown>): string | null {
  if (entry.isMeta === true) return null;
  const parts = userTexts(entry)
    .map(shownPrompt)
    .filter((t) => t && !t.startsWith('<'));
  return parts.length > 0 ? parts.join('\n\n') : null;
}

/**
 * The prompts of a session transcript the user typed (or the app sent),
 * oldest first, as Claude Code shows them; not background hand-backs, tool
 * results or commands. Read-only (decision D12); a missing or unreadable
 * file gives none.
 */
export function readPrompts(file: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const prompts: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown> | null;
    try {
      entry = record(JSON.parse(line));
    } catch {
      continue;
    }
    const prompt = entry?.type === 'user' && !isHandBack(entry) ? typedPrompt(entry) : null;
    if (prompt) prompts.push(prompt);
  }
  return prompts;
}

function assistantText(entry: Record<string, unknown>): string {
  const content = record(entry.message)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      const p = record(part);
      return p?.type === 'text' && typeof p.text === 'string' ? p.text : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

/** Parts joined as one Markdown text. */
export const joinParts = (parts: readonly { text: string }[]): string =>
  parts.map((p) => p.text).join('\n\n');

/**
 * The entries of a session transcript (JSON lines written by Claude Code),
 * oldest first: one per prompt, with the text of each of Claude's messages
 * until the next prompt as a part, without tool calls (spec §6.8). Text after
 * background work hands back joins the entry, its part marked. A prompt
 * without any text still has its entry. Read-only (decision D12); a missing
 * or unreadable file gives none.
 */
export function readResponses(file: string): TranscriptResponse[] {
  return readConversation(file).responses;
}

/** A transcript's entries and the question Claude waits on, if any. */
export interface Conversation {
  responses: TranscriptResponse[];
  /**
   * Claude's question tool waiting for its answer: its call is the last
   * thing Claude did and has no result yet (spec §6.7).
   */
  pending: PendingQuestion | null;
}

/** The question tool's calls in an assistant entry. */
function questionCalls(entry: Record<string, unknown>): PendingQuestion[] {
  const content = record(entry.message)?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    const p = record(part);
    if (p?.type !== 'tool_use' || p.name !== QUESTION_TOOL || typeof p.id !== 'string') return [];
    const questions = askedQuestions(p.input);
    return questions.length > 0 ? [{ id: p.id, questions }] : [];
  });
}

/** The ids of the tool calls a user entry gives results for. */
function toolResultIds(entry: Record<string, unknown>): string[] {
  const content = record(entry.message)?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    const p = record(part);
    return p?.type === 'tool_result' && typeof p.tool_use_id === 'string' ? [p.tool_use_id] : [];
  });
}

/** The answers Claude Code records with the question tool's result, by question. */
function questionAnswers(entry: Record<string, unknown>): Record<string, string> | null {
  const answers = record(record(entry.toolUseResult)?.answers);
  if (!answers) return null;
  return Object.fromEntries(
    Object.entries(answers).filter((a): a is [string, string] => typeof a[1] === 'string'),
  );
}

/**
 * The entries of a session transcript and the question Claude waits on, as
 * `readResponses`, which gives the entries only. Claude's questions are parts
 * of their own, marked, with the answers once given (spec §6.8).
 */
export function readConversation(file: string): Conversation {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { responses: [], pending: null };
  }
  return parseConversation(text);
}

/** `readConversation` of the transcript's text. */
export function parseConversation(text: string): Conversation {
  const responses: TranscriptResponse[] = [];
  /** The questions asked so far, by their tool call's id, to add the answers. */
  const asked = new Map<string, { part: ResponsePart; questions: AskedQuestion[] }>();
  let pending: PendingQuestion | null = null;
  let current: {
    parts: ResponsePart[];
    at: string | null;
    prompt: string | null;
    id: string | null;
    promptAt: string | null;
    queued: TranscriptResponse['queued'];
    /** The message the last part is from; null once something came after it. */
    message: string | null;
    /** A hand-back came since the last part. */
    handBack: boolean;
    interrupted: boolean;
  } | null = null;
  const open = (prompt: string | null, at: unknown, id: string | null = null) => ({
    parts: [],
    at: typeof at === 'string' ? at : null,
    prompt,
    id,
    promptAt: typeof at === 'string' ? at : null,
    queued: [],
    message: null,
    handBack: false,
    interrupted: false,
  });
  const close = () => {
    if (current && (current.prompt !== null || current.parts.length > 0)) {
      responses.push({
        text: joinParts(current.parts),
        parts: current.parts,
        at: current.at,
        prompt: current.prompt,
        interrupted: current.interrupted,
        id: current.id,
        promptAt: current.promptAt,
        queued: current.queued,
      });
    }
    current = null;
  };
  for (const [lineIndex, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown> | null;
    try {
      entry = record(JSON.parse(line));
    } catch {
      continue;
    }
    if (!entry) continue;
    const prompt = entry.type === 'user' ? promptText(entry) : null;
    const id = typeof entry.uuid === 'string' ? entry.uuid : `line:${lineIndex + 1}`;
    const queued = entry.type === 'attachment' ? queuedPrompt(entry) : null;
    if (prompt !== null) {
      close();
      current = open(prompt, entry.timestamp, id);
      pending = null;
    } else if (queued !== null) {
      current ??= open(null, null);
      current.queued.push({
        id,
        text: queued,
        at: typeof entry.timestamp === 'string' ? entry.timestamp : null,
      });
    } else if (entry.type === 'user') {
      // Tool work, or background work handing back: the next text is a part of its own.
      current ??= open(null, null);
      current.message = null;
      for (const id of toolResultIds(entry)) {
        const question = asked.get(id);
        if (question)
          question.part.text = questionMarkdown(question.questions, questionAnswers(entry));
        if (pending?.id === id) pending = null;
      }
      if (isHandBack(entry)) current.handBack = true;
      if (userTexts(entry).some((t) => INTERRUPTED.test(t.trim()))) current.interrupted = true;
    } else if (entry.type === 'assistant') {
      current ??= open(null, null);
      const part = assistantText(entry).trim();
      // Claude Code writes a message's blocks as entries of their own, with its id.
      const id = record(entry.message)?.id;
      const message = typeof id === 'string' ? id : 'same';
      const last = current.parts.at(-1);
      if (part && last && current.message === message) {
        last.text = `${last.text}\n\n${part}`;
      } else if (part) {
        // Claude wrote on after an interruption (background work handing back).
        current.interrupted = false;
        current.parts.push({ text: part, afterBackground: current.handBack });
        current.handBack = false;
        current.message = message;
      }
      for (const call of questionCalls(entry)) {
        const question: ResponsePart = {
          text: questionMarkdown(call.questions),
          afterBackground: current.handBack,
          question: true,
        };
        current.parts.push(question);
        current.handBack = false;
        // Text after it is a message of its own.
        current.message = null;
        asked.set(call.id, { part: question, questions: call.questions });
        pending = call;
      }
      if (typeof entry.timestamp === 'string') current.at = entry.timestamp;
    }
  }
  close();
  return { responses, pending };
}

/**
 * The text of the transcript's last response once it is written: Claude Code
 * runs the Stop hook before it writes the response to the transcript, so this
 * waits (up to `timeoutMs`) until the response after the last prompt ends with
 * `last`, the hook's last assistant message. Without `last`, until the last
 * response has text. Null if it doesn't get there (a turn without text).
 */
export async function awaitLastResponse(
  file: string,
  last: string | null,
  timeoutMs = 5000,
): Promise<string | null> {
  const wanted = last?.trim() || null;
  for (const end = Date.now() + timeoutMs; ; ) {
    const text = lastTurnText(file);
    if (text && (!wanted || text.endsWith(wanted))) return text;
    if (Date.now() >= end) return wanted;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * The text of the response to the last prompt or background hand-back, or
 * null when it has none (yet).
 */
function lastTurnText(file: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const parts: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown> | null;
    try {
      entry = record(JSON.parse(line));
    } catch {
      continue;
    }
    if (entry?.type === 'user' && (isPrompt(entry) || isHandBack(entry))) parts.length = 0;
    else if (entry?.type === 'assistant') {
      const part = assistantText(entry).trim();
      if (part) parts.push(part);
    }
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}

/** The note Claude Code writes after a permission prompt is answered No (or Esc). */
const DENIED_NOTE = '[Request interrupted by user for tool use]';

/**
 * Whether the session's last exchange ended with a permission request the
 * user turned down (spec §10.2): Claude Code then waits for input without a
 * hook event, and the transcript's last user entry is its interrupt note.
 * Reads the file's tail only; a missing or unreadable file says no.
 */
export function endsWithDeniedPermission(file: string): boolean {
  let text: string;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const length = Math.min(size, 256 * 1024);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      text = buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: Record<string, unknown> | null;
    try {
      entry = record(JSON.parse(lines[i] as string));
    } catch {
      continue;
    }
    if (entry?.type === 'assistant') return false;
    if (entry?.type !== 'user') continue;
    const content = record(entry.message)?.content;
    if (typeof content === 'string') return content.trim() === DENIED_NOTE;
    if (!Array.isArray(content)) return false;
    return content.some((part) => {
      const p = record(part);
      return p?.type === 'text' && typeof p.text === 'string' && p.text.trim() === DENIED_NOTE;
    });
  }
  return false;
}

/**
 * Calls `onChange` when the transcript changes: the file `path()` names (it
 * changes with /clear or a resume) or its size or time. Checks every
 * `intervalMs`; returns the function that stops it.
 */
export function watchTranscript(
  path: () => string | null,
  onChange: () => void,
  intervalMs = 1000,
): () => void {
  const signature = () => {
    const file = path();
    if (!file) return '';
    try {
      const stat = fs.statSync(file);
      return `${file}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return `${file}:-`;
    }
  };
  let last = signature();
  const timer = setInterval(() => {
    const now = signature();
    if (now === last) return;
    last = now;
    onChange();
  }, intervalMs);
  return () => clearInterval(timer);
}
