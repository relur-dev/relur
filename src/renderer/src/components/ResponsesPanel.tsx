import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSubscription } from '@trpc/tanstack-react-query';
import {
  type KeyboardEvent,
  type MouseEvent,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ConversationAids } from '../terminal/conversation';
import { trpcClient, useTRPC } from '../trpc';
import { keyHint } from '../ui/controls';
import { PANEL_MIN_WIDTH, usePanelWidth } from '../ui/panel-width';
import { StatusGlyph } from '../ui/StatusGlyph';
import { renderDocument, withImages } from './SpecView';

/** Puts the Claude terminal in focus, as Esc in the Changes panel does. */
const focusTerminal = () =>
  document.querySelector<HTMLElement>('[data-terminal] .xterm-helper-textarea')?.focus();

const time = (at: string | null) =>
  at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;

/** The side panel's width, kept in this window's storage. */
const WIDTH_KEY = 'responses-panel-width';

/** One of Claude's messages in an entry (spec §6.8). */
interface Part {
  text: string;
  /** It follows Claude's background work handing back, not tool work. */
  afterBackground: boolean;
  /** Claude's question tool: the questions, options and answers. */
  question?: true;
}

/** Copies `text`; true for 1.5 s afterwards, to say so. */
function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return [
    copied,
    (text) => void trpcClient.clipboard.writeText.mutate({ text }).then(() => setCopied(true)),
  ];
}

/** A part rendered as Markdown; images show as their alt text (a response has no files). */
const PartView = memo(function PartView({ text }: { text: string }) {
  const html = useMemo(() => withImages(renderDocument(text).html, {}), [text]);
  return (
    <div
      data-response-part
      className="doc-markdown"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by renderDocument
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});

/** A part's words as plain text, without its code blocks: the collapsed entry's two lines. */
function plainText(markdown: string): string {
  const doc = new DOMParser().parseFromString(renderDocument(markdown).html, 'text/html');
  for (const pre of doc.querySelectorAll('pre')) pre.remove();
  for (const block of doc.body.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, td, th, br')) {
    block.append(' ');
  }
  return (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** The notes icon of the "from notes" label: a page with two lines. */
const NoteMark = () => (
  <span
    aria-hidden
    className="box-border h-2.5 w-2 shrink-0 rounded-[1.5px] border-[1.2px] border-current bg-[linear-gradient(currentColor,currentColor),linear-gradient(currentColor,currentColor)] bg-[length:4px_1px,4px_1px] bg-[position:1px_2px,1px_4.5px] bg-no-repeat"
  />
);

/** Focus ring of a frameless control: inset. */
const ringIn = 'outline-none focus-visible:shadow-[inset_0_0_0_1.5px_var(--color-focus)]';
/** A frameless control in the panel's header or an entry: muted, `band-strong` on hover. */
const quiet = `inline-flex shrink-0 items-center rounded-[5px] whitespace-nowrap text-fg-muted transition-colors duration-120 hover:bg-band-strong hover:text-fg ${ringIn}`;

/**
 * One entry as a block (spec §6.8). Collapsed: a header with its number, the
 * prompt on one line, the "from notes" label, Copy on hover and the time,
 * then Claude's latest words in two lines (Interrupted or Asks permission
 * before them) and, with several parts, a bar for each. Expanded: the header
 * stays at the top while it scrolls, and each part starts with its marker
 * (1/3) and a rule. A click on the header, ↵ or Space expands or collapses it.
 */
const ResponseItem = memo(function ResponseItem({
  number,
  text,
  parts,
  prompt,
  at,
  interrupted,
  running,
  asking,
  compact,
  expanded,
  onToggle,
  onReveal,
  fromNotes,
  onShowNotes,
}: {
  number: number;
  /** All its parts as one Markdown text: what Copy copies. */
  text: string;
  parts: Part[];
  prompt: string | null;
  at: string | null;
  /** Interrupted with Esc (or a permission answered No): its text is partial. */
  interrupted: boolean;
  /** Claude is still in this turn: no text yet isn't "no text". */
  running: boolean;
  /** Claude asks for permission in this turn (the newest entry). */
  asking: boolean;
  /** The panel is at its narrowest: Copy shows on an expanded entry only. */
  compact: boolean;
  expanded: boolean;
  onToggle: (number: number) => void;
  /** Scrolls the terminal to it (classic mode); null where it can't. */
  onReveal: ((text: string) => boolean) | null;
  /** The notes its prompt was sent from (spec §6.15); empty for any other prompt. */
  fromNotes: string[];
  onShowNotes: ((ids: string[]) => void) | null;
}) {
  const [copied, copy] = useCopy();
  const [lastCopied, copyLast] = useCopy();
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (!missing) return;
    const timer = setTimeout(() => setMissing(false), 1500);
    return () => clearTimeout(timer);
  }, [missing]);
  // In the terminal, the text after the last hand-back ends where its Copy button is.
  const shown = useMemo(() => {
    const from = Math.max(
      0,
      parts.findLastIndex((p) => p.afterBackground),
    );
    return parts
      .slice(from)
      .map((p) => p.text)
      .join('\n\n');
  }, [parts]);
  const empty = parts.length === 0;
  const lastText = parts.at(-1)?.text ?? '';
  const summary = useMemo(() => (expanded ? '' : plainText(lastText)), [expanded, lastText]);
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const link = (event.target as Element).closest('a');
    if (link) {
      event.preventDefault();
      if (link.hasAttribute('data-doc-external')) {
        void trpcClient.shell.openExternal.mutate({ url: link.getAttribute('href') ?? '' });
      }
      return;
    }
    // Selecting text to copy part of it isn't a click on the response.
    if (window.getSelection()?.toString()) return;
    if (onReveal && !onReveal(shown)) setMissing(true);
  };
  const onHeaderKey = (event: KeyboardEvent) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onToggle(number);
  };
  const pill = interrupted ? 'Interrupted' : asking ? 'Asks permission' : null;
  const copyShown = !empty && (expanded || copied || !compact);
  return (
    <article
      data-response={number}
      data-expanded={expanded ? 'true' : 'false'}
      className={`border-b border-line ${expanded ? 'bg-surface' : ''}`}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: it holds the Copy button, which a button can't */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        data-response-header
        className={`group/head flex cursor-default gap-1 pt-[9px] pr-3 pb-2.5 pl-2 ${ringIn} ${
          expanded ? 'sticky top-0 z-1 bg-surface' : 'hover:bg-band'
        }`}
        title={expanded ? 'Collapse' : 'Expand'}
        onClick={() => onToggle(number)}
        onKeyDown={onHeaderKey}
      >
        <span
          className={`mt-1 w-4 shrink-0 text-center text-[8px] transition-transform duration-120 ${
            empty ? 'text-transparent' : 'text-fg-subtle'
          } ${expanded ? 'rotate-90' : ''}`}
        >
          ▶
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <div className="flex h-5 min-w-0 items-center gap-[7px]">
            <span className="shrink-0 font-mono text-[11.5px] font-medium text-fg-subtle">
              {number}
            </span>
            <span
              className="min-w-0 flex-1 truncate text-sm text-fg-muted"
              title={prompt ?? undefined}
            >
              {prompt ? `› ${prompt.replace(/\s+/g, ' ')}` : ''}
            </span>
            {fromNotes.length > 0 && onShowNotes ? (
              <button
                type="button"
                data-response-from-notes
                className={`flex h-[17px] shrink-0 items-center gap-1 rounded-[9px] border border-line-strong px-1.5 text-[10.5px] font-medium whitespace-nowrap text-fg-muted transition-colors duration-120 hover:bg-band-strong hover:text-fg ${ringIn}`}
                title={
                  fromNotes.length > 1
                    ? `Sent from ${fromNotes.length} notes joined into one prompt; show them`
                    : 'Sent from a note; show it'
                }
                onClick={(event) => {
                  event.stopPropagation();
                  onShowNotes(fromNotes);
                }}
                onKeyDown={(event) => event.stopPropagation()}
              >
                <NoteMark />
                {fromNotes.length > 1 ? `from notes · ${fromNotes.length}` : 'from notes'}
              </button>
            ) : null}
            {copyShown ? (
              <button
                type="button"
                data-response-copy
                className={`${quiet} h-5 rounded-sm px-1.5 text-sm ${
                  expanded || copied
                    ? ''
                    : 'invisible group-focus-within/head:visible group-hover/head:visible'
                }`}
                title="Copy all of Claude's text for this prompt, as Markdown"
                onClick={(event) => {
                  event.stopPropagation();
                  copy(text);
                }}
                onKeyDown={(event) => event.stopPropagation()}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            ) : null}
            {missing ? (
              <span className="shrink-0 text-sm text-fg-subtle">Not in the terminal</span>
            ) : time(at) ? (
              <span className="shrink-0 font-mono text-[11.5px] text-fg-subtle">{time(at)}</span>
            ) : null}
          </div>
          {expanded ? null : (
            <>
              <div className="flex min-w-0 items-start gap-[7px]">
                {pill ? (
                  <span
                    data-response-interrupted={interrupted ? '' : undefined}
                    data-response-asking={interrupted ? undefined : ''}
                    className={`mt-px flex h-[18px] shrink-0 items-center rounded-sm border px-1.5 text-xs font-medium whitespace-nowrap ${
                      interrupted
                        ? 'border-line-strong text-fg-muted'
                        : 'border-st-permission/55 text-st-permission'
                    }`}
                    title={
                      interrupted
                        ? 'You interrupted Claude here; this is what it wrote before'
                        : 'Claude is asking for permission in the terminal'
                    }
                  >
                    {pill}
                  </span>
                ) : null}
                {empty ? (
                  running ? (
                    <span
                      data-response-empty
                      className="flex min-w-0 items-center gap-[7px] text-base text-fg-subtle"
                    >
                      <StatusGlyph glyph="working" title="Claude is writing" />
                      Writing… · no text yet
                    </span>
                  ) : (
                    <span data-response-empty className="text-base text-fg-subtle italic">
                      No text response
                    </span>
                  )
                ) : (
                  <span
                    data-response-summary
                    className="line-clamp-2 min-w-0 text-base leading-[19px] text-pretty text-fg"
                  >
                    {summary}
                  </span>
                )}
              </div>
              {parts.length > 1 ? (
                <div
                  data-response-parts={parts.length}
                  className="flex items-center gap-[5px] text-xs text-fg-subtle"
                >
                  {parts.map((_, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: one bar per part, parts only grow
                    <span key={i} className="h-[3px] w-3.5 rounded-[2px] bg-line-strong" />
                  ))}
                  <span className="ml-0.5">{parts.length} parts</span>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
      {expanded ? (
        empty ? (
          <p data-response-empty className="pr-3.5 pb-3.5 pl-9 text-base text-fg-subtle italic">
            {running ? 'Writing… · no text yet' : 'No text response'}
          </p>
        ) : (
          // biome-ignore lint/a11y/useKeyWithClickEvents: scrolling the terminal is a convenience; the header expands
          // biome-ignore lint/a11y/noStaticElementInteractions: as above
          <div
            data-response-body
            className={`flex flex-col pt-0.5 pr-3.5 pb-3.5 pl-9 select-text ${onReveal ? 'cursor-pointer' : ''}`}
            title={onReveal ? 'Show it in the terminal' : undefined}
            onClick={onClick}
          >
            {parts.map((part, i) => {
              const label = part.afterBackground
                ? 'After background work'
                : part.question
                  ? 'Claude asked'
                  : null;
              const marked = parts.length > 1 || label !== null;
              const last = parts.length > 1 && i === parts.length - 1;
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: parts only grow at the end
                <div key={i} className="flex flex-col gap-2">
                  {marked ? (
                    <div
                      data-response-divider={i > 0 && !part.afterBackground ? '' : undefined}
                      data-response-handback={part.afterBackground ? '' : undefined}
                      className="mt-1.5 flex h-[26px] items-center gap-2 text-xs whitespace-nowrap text-fg-subtle"
                    >
                      {parts.length > 1 ? (
                        <span className="font-mono font-medium text-fg-muted">
                          {i + 1}/{parts.length}
                        </span>
                      ) : null}
                      {label ? (
                        <span
                          data-response-question={part.question ? '' : undefined}
                          className="font-semibold text-fg-muted"
                        >
                          {label}
                        </span>
                      ) : null}
                      <span className="h-px flex-1 bg-line" />
                      {last ? (
                        <button
                          type="button"
                          data-response-copy-last
                          className={`${quiet} h-5 rounded-sm px-1.5 text-xs`}
                          title="Copy only Claude's last message for this prompt, as Markdown"
                          onClick={(event) => {
                            event.stopPropagation();
                            copyLast(part.text);
                          }}
                        >
                          {lastCopied ? 'Copied' : 'Copy last part'}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                  <PartView text={part.text} />
                </div>
              );
            })}
          </div>
        )
      ) : null}
    </article>
  );
});

/**
 * The Responses panel of a Claude tab (spec §6.8): an entry per prompt of the
 * conversation, read from the transcript, newest last, each a collapsible
 * block with all of Claude's text for that prompt, rendered as Markdown, and
 * its own Copy. It follows the transcript as Claude writes it: the newest
 * entry grows part by part. In classic mode a click on an entry scrolls the
 * terminal to it. Beside the terminal its left edge resizes it; Full view
 * gives it the whole workspace area.
 */
export function ResponsesPanel({
  workspaceId,
  entry = null,
  aids,
  alternate,
  narrow,
  running,
  asking = false,
  full,
  onToggleFull,
  onClose,
  onShowNotes = null,
}: {
  workspaceId: string;
  /**
   * The entry (0-based) to show, expanded and scrolled to its top: from a
   * Board card (spec §6.7) or a note's View response (§6.15); `at` tells a new
   * request for the same entry from the last one.
   */
  entry?: { index: number; at: number } | null;
  /** The Claude terminal's aids, to scroll to a response. */
  aids: ConversationAids | null;
  /** Claude is in full-screen mode: nothing to scroll to. */
  alternate: boolean;
  narrow: boolean;
  /** Claude is in a turn: the newest entry may still get text. */
  running: boolean;
  /** Claude asks for permission: the newest entry says so (spec §6.8). */
  asking?: boolean;
  /** It fills the workspace area, the terminal hidden. */
  full: boolean;
  onToggleFull: () => void;
  onClose: () => void;
  /** Opens the Notes panel at these items: an entry's "from notes" label (spec §6.15). */
  onShowNotes?: ((ids: string[]) => void) | null;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const responses = useQuery(
    trpc.conversation.responses.queryOptions({ workspaceId }, { staleTime: 0 }),
  );
  useSubscription(
    trpc.conversation.changes.subscriptionOptions(
      { workspaceId },
      {
        onData: () =>
          void queryClient.invalidateQueries({ queryKey: trpc.conversation.responses.queryKey() }),
      },
    ),
  );
  const list = responses.data ?? [];
  const newest = list.length;
  // Every response is collapsed, the newest too, unless toggled (spec §6.8).
  const [toggled, setToggled] = useState<Record<number, boolean>>(() =>
    entry === null ? {} : { [entry.index + 1]: true },
  );
  const isExpanded = (number: number) => toggled[number] ?? false;
  const toggle = useCallback(
    (number: number) => setToggled((current) => ({ ...current, [number]: !current[number] })),
    [],
  );
  const setAll = (expanded: boolean) =>
    setToggled(Object.fromEntries(list.map((r) => [r.index + 1, expanded])));
  // One toggle: Collapse all while any entry is expanded, else Expand all (spec §6.8).
  const anyExpanded = list.some((r) => isExpanded(r.index + 1));

  const asideRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Keeps to the newest response while the list is scrolled to its end.
  const atEnd = useRef(true);
  // In focus when it opens and when it changes size, so Esc reaches it (the terminal may be hidden).
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when full view changes
  useEffect(() => asideRef.current?.focus(), [full]);
  // The entry asked for, once the list has it: in view from its top (spec §6.7).
  const toEntry = useRef(entry?.index ?? null);
  const [scrollTick, setScrollTick] = useState(0);
  // A new request while open (View response, spec §6.15): expanded, then in view.
  const lastAsked = useRef(entry?.at ?? null);
  useEffect(() => {
    if (!entry || entry.at === lastAsked.current) return;
    lastAsked.current = entry.at;
    toEntry.current = entry.index;
    setToggled((current) => ({ ...current, [entry.index + 1]: true }));
    setScrollTick((n) => n + 1);
  }, [entry]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the responses change or an entry is asked for
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const wanted = toEntry.current;
    const item =
      wanted === null ? null : el.querySelector<HTMLElement>(`[data-response="${wanted + 1}"]`);
    if (item) {
      toEntry.current = null;
      el.scrollTop += item.getBoundingClientRect().top - el.getBoundingClientRect().top;
      atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    } else if (atEnd.current && wanted === null) el.scrollTop = el.scrollHeight;
  }, [list, scrollTick]);
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };
  const close = () => {
    onClose();
    focusTerminal();
  };
  // Esc: from full view back to the side panel; beside the terminal, closes it.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    if (full) onToggleFull();
    else close();
  };
  // Not in full view: the terminal is hidden there.
  const reveal = useMemo(
    () => (aids && !alternate && !full ? (text: string) => aids.reveal(text) : null),
    [aids, alternate, full],
  );

  // Its width beside the terminal, dragged by its left edge.
  const { width: shown, handle } = usePanelWidth(
    WIDTH_KEY,
    asideRef,
    narrow ? PANEL_MIN_WIDTH : 420,
  );
  // At its narrowest, Full view is an icon and Copy shows on expanded entries only.
  const compact = !full && shown < 360;

  return (
    <aside
      ref={asideRef}
      data-responses-panel
      data-full={full ? 'true' : 'false'}
      aria-label="Responses"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      style={full ? undefined : { width: shown }}
      className={`relative flex min-h-0 flex-col bg-canvas outline-none ${full ? 'min-w-0 flex-1' : 'shrink-0 border-l border-line'}`}
    >
      {full ? null : (
        <div
          data-responses-resize
          title="Drag to resize"
          className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-line-strong/60"
          {...handle}
        />
      )}
      <div className="flex h-[34px] shrink-0 items-center gap-1 border-b border-line pr-1.5 pl-3.5">
        <span className="text-base font-semibold">Responses</span>
        <span className="ml-1 font-mono text-sm text-fg-subtle">
          {responses.data ? list.length : ''}
        </span>
        <span className="flex-1" />
        {list.length > 0 ? (
          <button
            type="button"
            data-responses-toggle-all
            className={`${quiet} h-[26px] px-2 text-md`}
            title={anyExpanded ? 'Collapse every entry' : 'Expand every entry'}
            onClick={() => setAll(!anyExpanded)}
          >
            {anyExpanded ? 'Collapse all' : 'Expand all'}
          </button>
        ) : null}
        <button
          type="button"
          data-responses-full
          className={`${quiet} h-[26px] gap-1.5 px-2 text-md`}
          aria-pressed={full}
          aria-label={full ? 'Side panel' : 'Full view'}
          title={
            full
              ? `Back to the side panel (Esc, ${keyHint('responsesFullView')})`
              : `Full view: over the whole workspace (${keyHint('responsesFullView')})`
          }
          onClick={onToggleFull}
        >
          <span aria-hidden className="text-sm">
            {full ? '⤡' : '⤢'}
          </span>
          {compact ? null : full ? 'Side panel' : 'Full view'}
        </button>
        <button
          type="button"
          className={`${quiet} size-[26px] justify-center text-base`}
          title={`Close (${full ? '' : 'Esc, '}${keyHint('responses')})`}
          aria-label="Close responses"
          onClick={close}
        >
          ×
        </button>
      </div>
      {responses.error ? (
        <p role="alert" className="p-3 text-sm text-st-error select-text">
          ✕ {responses.error.message}
        </p>
      ) : null}
      {responses.data && list.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 p-6 text-center">
          <div className="font-medium">No responses yet</div>
          <div className="max-w-[240px] text-sm text-fg-subtle">
            Claude's responses in this conversation appear here as it writes them.
          </div>
        </div>
      ) : null}
      {list.length > 0 ? (
        <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
          <div className={full ? 'mx-auto max-w-[900px]' : undefined}>
            {list.map((r) => (
              <ResponseItem
                key={r.index}
                number={r.index + 1}
                text={r.text}
                parts={r.parts}
                prompt={r.prompt}
                at={r.at}
                interrupted={r.interrupted}
                running={running && r.index + 1 === newest}
                asking={asking && r.index + 1 === newest}
                compact={compact}
                expanded={isExpanded(r.index + 1)}
                onToggle={toggle}
                onReveal={reveal}
                fromNotes={r.notes}
                onShowNotes={onShowNotes}
              />
            ))}
          </div>
        </div>
      ) : null}
    </aside>
  );
}
