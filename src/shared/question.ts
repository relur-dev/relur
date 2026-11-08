/**
 * Claude's question tool (AskUserQuestion), as the transcript has it (spec
 * §6.7, §6.8). Claude Code shows a menu for it: numbered options, then "Type
 * something." (a free answer, always there) and "Chat about this". A digit
 * typed there picks that option at once; pasted text goes into "Type
 * something" and ↵ sends it as the answer (checked live with 2.1.319).
 */

/** The tool's name in the transcript and in hook payloads. */
export const QUESTION_TOOL = 'AskUserQuestion';

export interface QuestionOption {
  label: string;
  description: string | null;
}

/** One question of a call: Claude Code shows several as tabs, then Submit. */
export interface AskedQuestion {
  question: string;
  /** Its short tab name, e.g. "Color". */
  header: string | null;
  options: QuestionOption[];
  /** Checkboxes: the options are ticked, then Submit. */
  multiSelect: boolean;
}

/** A question Claude waits on: the tool call has no result yet. */
export interface PendingQuestion {
  /** The tool call's id, so an answer goes to this question and no later one. */
  id: string;
  questions: AskedQuestion[];
}

const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The questions of the tool's input; none when it isn't one Claude Code would show. */
export function askedQuestions(input: unknown): AskedQuestion[] {
  const list = record(input)?.questions;
  if (!Array.isArray(list)) return [];
  return list.flatMap((q) => {
    const r = record(q);
    const question = text(r?.question);
    if (!r || !question) return [];
    const options = (Array.isArray(r.options) ? r.options : []).flatMap((o) => {
      const option = record(o);
      const label = text(option?.label);
      return label ? [{ label, description: text(option?.description) }] : [];
    });
    return [{ question, header: text(r.header), options, multiSelect: r.multiSelect === true }];
  });
}

/**
 * Whether the card can answer it with one key: a single question, one
 * choice, at most nine options (one digit each). Several questions or
 * checkboxes take more than a key in Claude Code's menu, so those open the
 * workspace instead (spec §6.7).
 */
export function answerable(question: PendingQuestion | null): boolean {
  const [only] = question?.questions ?? [];
  return (
    question?.questions.length === 1 &&
    !!only &&
    !only.multiSelect &&
    only.options.length > 0 &&
    only.options.length <= 9
  );
}

/** The key that picks option `index` (0-based) in Claude Code's menu. */
export const optionKey = (index: number): string => String(index + 1);

/**
 * The questions as Markdown, for the Responses panel and Copy (spec §6.8):
 * each question with its tab name, its options as a list, and the answers
 * once given.
 */
export function questionMarkdown(
  questions: AskedQuestion[],
  answers: Record<string, string> | null = null,
): string {
  return questions
    .map((q) => {
      const title = `${q.header ? `**${q.header}** · ` : ''}${q.question}${q.multiSelect ? ' (any of them)' : ''}`;
      const options = q.options.map(
        (o) => `- ${o.label}${o.description ? `: ${o.description}` : ''}`,
      );
      const answer = answers?.[q.question];
      return [title, options.join('\n'), answer ? `Answered: ${answer}` : '']
        .filter(Boolean)
        .join('\n\n');
    })
    .join('\n\n');
}
