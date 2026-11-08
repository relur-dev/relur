import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSubscription } from '@trpc/tanstack-react-query';
import {
  type KeyboardEvent,
  type MouseEvent,
  memo,
  type PointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ConversationAids } from '../terminal/conversation';
import { trpcClient, useTRPC } from '../trpc';
import { button, iconButton, keyHint } from '../ui/controls';
import { remember } from '../ui/remember';
import { renderDocument, withImages } from './SpecView';

/** Puts the Claude terminal in focus, as Esc in the Changes panel does. */
const focusTerminal = () =>
  document.querySelector<HTMLElement>('[data-terminal] .xterm-helper-textarea')?.focus();

const time = (at: string | null) =>
  at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;

/** The side panel's width: dragged by its left edge, kept in this window's storage. */
const WIDTH_KEY = 'responses-panel-width';
const MIN_WIDTH = 320;
/** At most this share of the workspace area. */
const MAX_SHARE = 0.7;

function savedWidth(): number | null {
  try {
    const value = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(value) && value >= MIN_WIDTH ? value : null;
  } catch {
    return null;
  }
}

function saveWidth(width: number): void {
  remember(WIDTH_KEY, String(Math.round(width)));
}

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

/**
 * One entry as a block: a header (number, the prompt on one line, time, Copy)
 * that expands or collapses it, then Claude's text of that turn, part by part
 * with a divider where Claude worked between them; collapsed, a few lines
 * fading out (spec §6.8).
 */
const ResponseItem = memo(function ResponseItem({
  number,
  text,
  parts,
  prompt,
  at,
  interrupted,
  running,
  expanded,
  onToggle,
  onReveal,
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
  expanded: boolean;
  onToggle: (number: number) => void;
  /** Scrolls the terminal to it (classic mode); null where it can't. */
  onReveal: ((text: string) => boolean) | null;
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
    if (!expanded) onToggle(number);
    if (onReveal && !empty && !onReveal(shown)) setMissing(true);
  };
  const onHeaderKey = (event: KeyboardEvent) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onToggle(number);
  };
  return (
    <article
      data-response={number}
      data-expanded={expanded ? 'true' : 'false'}
      className="border-b border-line"
    >
      {/* biome-ignore lint/a11y/useSemanticElements: it holds the Copy button, which a button can't */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        data-response-header
        className="flex cursor-pointer items-center gap-2 px-3.5 pt-2.5 pb-1.5 outline-none hover:bg-raised focus-visible:bg-raised"
        title={expanded ? 'Collapse' : 'Expand'}
        onClick={() => onToggle(number)}
        onKeyDown={onHeaderKey}
      >
        <span className="w-3 text-xs text-fg-subtle">{expanded ? '▾' : '▸'}</span>
        <span className="font-mono text-xs font-semibold text-fg-muted">{number}</span>
        <span
          className="min-w-0 flex-1 truncate text-xs text-fg-subtle"
          title={prompt ?? undefined}
        >
          {prompt ? `› ${prompt.replace(/\s+/g, ' ')}` : ''}
        </span>
        {interrupted ? (
          <span
            data-response-interrupted
            className="text-xs font-medium text-fg-muted"
            title="You interrupted Claude here; this is what it wrote before"
          >
            Interrupted
          </span>
        ) : null}
        {missing ? (
          <span className="text-xs text-fg-subtle">Not in the terminal</span>
        ) : time(at) ? (
          <span className="font-mono text-xs text-fg-subtle">{time(at)}</span>
        ) : null}
        {empty ? null : (
          <button
            type="button"
            data-response-copy
            className={button('ghost', 'sm')}
            title="Copy all of Claude's text for this prompt, as Markdown"
            onClick={(event) => {
              event.stopPropagation();
              copy(text);
            }}
            onKeyDown={(event) => event.stopPropagation()}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
      </div>
      {empty ? (
        <p data-response-empty className="mx-3.5 mb-3 px-1 text-sm text-fg-subtle italic">
          {running ? 'No text yet' : 'No text response'}
        </p>
      ) : (
        // biome-ignore lint/a11y/useKeyWithClickEvents: scrolling the terminal is a convenience; the header expands
        // biome-ignore lint/a11y/noStaticElementInteractions: as above
        <div
          data-response-body
          className={`mx-3.5 mb-3 rounded-md px-1 select-text ${
            expanded
              ? ''
              : 'max-h-[4.6em] overflow-hidden [mask-image:linear-gradient(to_bottom,black_30%,transparent)]'
          } ${onReveal || !expanded ? 'cursor-pointer hover:bg-raised' : ''}`}
          title={onReveal ? 'Show it in the terminal' : expanded ? undefined : 'Expand'}
          onClick={onClick}
        >
          {parts.map((part, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: parts only grow at the end
            <div key={i}>
              {part.afterBackground ? (
                <div
                  data-response-handback
                  className="my-2 flex items-center gap-2 text-xs text-fg-subtle"
                >
                  <span>After background work</span>
                  <span className="flex-1 border-t border-line" />
                </div>
              ) : i > 0 ? (
                <hr data-response-divider className="my-2.5 border-0 border-t border-line" />
              ) : null}
              {part.question ? (
                <div data-response-question className="mb-1 text-xs font-medium text-fg-muted">
                  Claude asked
                </div>
              ) : null}
              <PartView text={part.text} />
            </div>
          ))}
        </div>
      )}
      {expanded && parts.length > 1 ? (
        <div className="-mt-2 mb-2 flex justify-end px-3.5">
          <button
            type="button"
            data-response-copy-last
            className={button('ghost', 'sm')}
            title="Copy only Claude's last message for this prompt, as Markdown"
            onClick={() => copyLast(parts.at(-1)?.text ?? '')}
          >
            {lastCopied ? 'Copied' : 'Copy last part'}
          </button>
        </div>
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
  full,
  onToggleFull,
  onClose,
}: {
  workspaceId: string;
  /** The entry (0-based) to show at first, expanded: from a Board card (spec §6.7). */
  entry?: number | null;
  /** The Claude terminal's aids, to scroll to a response. */
  aids: ConversationAids | null;
  /** Claude is in full-screen mode: nothing to scroll to. */
  alternate: boolean;
  narrow: boolean;
  /** Claude is in a turn: the newest entry may still get text. */
  running: boolean;
  /** It fills the workspace area, the terminal hidden. */
  full: boolean;
  onToggleFull: () => void;
  onClose: () => void;
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
    entry === null ? {} : { [entry + 1]: true },
  );
  const isExpanded = (number: number) => toggled[number] ?? false;
  const toggle = useCallback(
    (number: number) => setToggled((current) => ({ ...current, [number]: !current[number] })),
    [],
  );
  const setAll = (expanded: boolean) =>
    setToggled(Object.fromEntries(list.map((r) => [r.index + 1, expanded])));

  const asideRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Keeps to the newest response while the list is scrolled to its end.
  const atEnd = useRef(true);
  // In focus when it opens and when it changes size, so Esc reaches it (the terminal may be hidden).
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when full view changes
  useEffect(() => asideRef.current?.focus(), [full]);
  // The entry asked for, once the list has it: in view from its top (spec §6.7).
  const toEntry = useRef(entry);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the responses change
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
  }, [list]);
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

  // Its width beside the terminal, between MIN_WIDTH and MAX_SHARE of the area.
  const [width, setWidth] = useState(() => savedWidth() ?? (narrow ? MIN_WIDTH : 420));
  const [areaWidth, setAreaWidth] = useState(0);
  useLayoutEffect(() => {
    const area = asideRef.current?.parentElement;
    if (!area) return;
    const observer = new ResizeObserver(() => setAreaWidth(area.clientWidth));
    observer.observe(area);
    setAreaWidth(area.clientWidth);
    return () => observer.disconnect();
  }, []);
  const clamp = (value: number) =>
    Math.max(MIN_WIDTH, Math.min(value, areaWidth > 0 ? areaWidth * MAX_SHARE : value));
  const shown = clamp(width);
  // The drag's latest width, saved on release (the render may not have caught up yet).
  const drag = useRef<{ x: number; width: number; now: number } | null>(null);
  const onDragStart = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, width: shown, now: shown };
  };
  const onDragMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current.now = clamp(drag.current.width + drag.current.x - event.clientX);
    setWidth(drag.current.now);
  };
  const onDragEnd = () => {
    if (!drag.current) return;
    saveWidth(drag.current.now);
    drag.current = null;
  };

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
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
        />
      )}
      <div className="flex h-[34px] shrink-0 items-center gap-1.5 border-b border-line bg-surface pr-2 pl-3.5">
        <span className="text-md font-semibold">Responses</span>
        <span className="font-mono text-xs text-fg-subtle">
          {responses.data ? list.length : ''}
        </span>
        <span className="flex-1" />
        {list.length > 0 ? (
          <>
            <button type="button" className={button('ghost', 'sm')} onClick={() => setAll(true)}>
              Expand all
            </button>
            <button type="button" className={button('ghost', 'sm')} onClick={() => setAll(false)}>
              Collapse all
            </button>
          </>
        ) : null}
        <button
          type="button"
          data-responses-full
          className={button('ghost', 'sm')}
          aria-pressed={full}
          title={
            full
              ? `Back to the side panel (Esc, ${keyHint('responsesFullView')})`
              : `Over the whole workspace (${keyHint('responsesFullView')})`
          }
          onClick={onToggleFull}
        >
          {full ? 'Side panel' : 'Full view'}
        </button>
        <button
          type="button"
          className={iconButton}
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
                expanded={isExpanded(r.index + 1)}
                onToggle={toggle}
                onReveal={reveal}
              />
            ))}
          </div>
        </div>
      ) : null}
    </aside>
  );
}
