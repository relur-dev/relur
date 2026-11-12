import {
  branchMatches,
  type CheckedOut,
  checkedOutText,
  type ExistingBranch,
} from '@shared/existing-branch';
import { useQuery } from '@tanstack/react-query';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { useTRPC } from '../trpc';
import { button, inputClass } from '../ui/controls';
import { ago } from '../ui/time';

/** The branch picked for New workspace's Existing branch (spec §7.6). */
export interface PickedBranch {
  branch: string;
  /** The remote it tracks; null for a local branch without one. */
  remote: string | null;
  /** The pull request URL it was pasted as, if any. */
  prUrl: string | null;
  checkedOut: CheckedOut | null;
  base: boolean;
}

const isUrl = (text: string) => /^https?:\/\//i.test(text.trim());

/** "3d ago", "now". */
const age = (iso: string) => {
  const a = ago(iso);
  return a === 'now' ? a : `${a} ago`;
};

const picked = (row: ExistingBranch, prUrl: string | null = null, remote?: string | null) => ({
  branch: row.name,
  remote: remote === undefined ? (row.remotes[0] ?? null) : remote,
  prUrl,
  checkedOut: row.checkedOut,
  base: row.base,
});

/**
 * Existing branch (spec §7.6): the project's branches, local and remote,
 * most recently updated first with the last commit's author and date, after
 * fetching every remote (shown at once as of the last fetch). One field
 * filters them, or takes a branch or pull request URL. ↑↓ choose; the
 * choice follows the highlighted row. A branch checked out elsewhere says
 * where, with a way to open that instead.
 */
export function ExistingBranchPicker({
  projectId,
  projectName,
  initialSearch = '',
  value,
  onPick,
  onOpenElsewhere,
}: {
  projectId: string;
  projectName: string;
  /** What the search starts with; a branch of exactly that name is picked. */
  initialSearch?: string;
  value: PickedBranch | null;
  onPick: (picked: PickedBranch | null) => void;
  /** Open the workspace, worktree or project the branch is checked out in. */
  onOpenElsewhere: (at: CheckedOut) => void;
}) {
  const trpc = useTRPC();
  const quick = useQuery(
    trpc.workspaces.existingBranches.queryOptions({ projectId, fetch: false }, { staleTime: 0 }),
  );
  const fetched = useQuery(
    trpc.workspaces.existingBranches.queryOptions(
      { projectId, fetch: true },
      { staleTime: 30_000 },
    ),
  );
  const list = fetched.data ?? quick.data;
  const [text, setText] = useState(initialSearch);
  const url = isUrl(text) ? text.trim() : null;
  const [settledUrl, setSettledUrl] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setSettledUrl(url), 300);
    return () => clearTimeout(timer);
  }, [url]);
  const resolved = useQuery(
    trpc.workspaces.resolveBranchUrl.queryOptions(
      { projectId, url: settledUrl ?? '' },
      // After the fetch, so a branch pushed a moment ago is known.
      { enabled: Boolean(settledUrl && settledUrl === url && fetched.data), staleTime: 30_000 },
    ),
  );
  const shown = url ? [] : (list?.branches ?? []).filter((b) => branchMatches(b, text));

  // A resolved URL picks its branch.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on a new answer only
  useEffect(() => {
    const answer = resolved.data;
    if (!url || !answer?.ok) return;
    const row = list?.branches.find((b) => b.name === answer.branch);
    onPick(
      row
        ? picked(row, answer.prUrl, answer.remote)
        : {
            branch: answer.branch,
            remote: answer.remote,
            prUrl: answer.prUrl,
            checkedOut: null,
            base: false,
          },
    );
  }, [resolved.data, url]);

  // A name typed or carried over in full picks that branch.
  // biome-ignore lint/correctness/useExhaustiveDependencies: when the list or the text changes
  useEffect(() => {
    if (url || value?.branch === text.trim()) return;
    const exact = list?.branches.find((b) => b.name === text.trim());
    if (exact) onPick(picked(exact));
  }, [list, text]);

  const listRef = useRef<HTMLDivElement>(null);
  const select = (row: ExistingBranch | undefined) => {
    if (!row) return;
    onPick(picked(row));
    requestAnimationFrame(() =>
      listRef.current
        ?.querySelector(`[data-branch-row="${CSS.escape(row.name)}"]`)
        ?.scrollIntoView({ block: 'nearest' }),
    );
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const at = shown.findIndex((b) => b.name === value?.branch);
    const next =
      event.key === 'ArrowDown'
        ? Math.min(shown.length - 1, at + 1)
        : Math.max(0, at === -1 ? 0 : at - 1);
    select(shown[next]);
  };

  const fetchErrors = fetched.data?.fetchErrors ?? [];
  return (
    <div data-existing-branch className="space-y-1.5">
      <input
        id="ws-existing-search"
        className={`${inputClass} font-mono text-sm`}
        placeholder="Search branches, or paste a branch or pull request URL"
        aria-label="Branch"
        // biome-ignore lint/a11y/noAutofocus: the branch is what you choose first
        autoFocus
        data-autofocus
        spellCheck={false}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (isUrl(e.target.value)) onPick(null);
        }}
        onKeyDown={onKeyDown}
      />
      {url ? (
        <div data-url-result className="text-sm">
          {resolved.data?.ok ? (
            <p className="text-fg-muted">
              <span className="text-diff-add">✓</span>{' '}
              {resolved.data.prUrl ? 'Its branch is ' : 'Branch '}
              <span className="font-mono text-fg">{resolved.data.branch}</span>
              {resolved.data.remote ? (
                <span className="text-fg-subtle"> on {resolved.data.remote}</span>
              ) : null}
            </p>
          ) : resolved.data && !resolved.data.ok ? (
            <p role="alert" className="text-st-error select-text">
              ✕ {resolved.data.message}
            </p>
          ) : resolved.error ? (
            <p role="alert" className="text-st-error select-text">
              ✕ {resolved.error.message}
            </p>
          ) : (
            <p className="text-fg-subtle">Looking up the URL…</p>
          )}
        </div>
      ) : (
        // Ten rows of 30px with their 1px gaps (fewer in a short window), then it scrolls.
        <div
          ref={listRef}
          role="listbox"
          aria-label={`Branches of ${projectName}`}
          data-branch-list
          className="scroll-visible flex max-h-[min(calc(var(--spacing)*75+9px),35vh)] flex-col gap-px overflow-y-auto rounded-md border border-line bg-line"
        >
          {shown.map((b) => {
            const selected = value?.branch === b.name;
            return (
              <button
                key={b.name}
                type="button"
                role="option"
                aria-selected={selected}
                data-branch-row={b.name}
                title={b.base ? 'The base branch: start a new branch from it instead' : b.subject}
                tabIndex={-1}
                className={`flex h-7.5 shrink-0 items-center gap-2 px-2.5 text-left text-md ${
                  selected ? 'bg-selected' : 'bg-raised hover:bg-selected'
                } ${b.base ? 'text-fg-subtle' : ''}`}
                onClick={() => select(b)}
              >
                <span className="min-w-0 truncate font-mono text-sm">{b.name}</span>
                <span className="shrink-0 font-mono text-2xs text-fg-subtle">
                  {[b.local ? 'local' : null, ...b.remotes].filter(Boolean).join(' · ')}
                  {b.base ? ' · base' : ''}
                  {b.checkedOut
                    ? b.checkedOut.kind === 'workspace'
                      ? ' · has a workspace'
                      : b.checkedOut.kind === 'main'
                        ? ' · main checkout'
                        : ' · in a worktree'
                    : ''}
                </span>
                <span className="flex-1" />
                <span className="shrink-0 truncate text-sm text-fg-muted">{b.author}</span>
                <span className="w-14 shrink-0 text-right text-xs text-fg-subtle">
                  {age(b.date)}
                </span>
              </button>
            );
          })}
          {list && shown.length === 0 ? (
            <p className="bg-raised px-2.5 py-1.5 text-sm text-fg-subtle">
              {text.trim() ? `No branch matches “${text.trim()}”` : 'No branches yet'}
            </p>
          ) : null}
          {!list ? <p className="bg-raised px-2.5 py-1.5 text-sm text-fg-subtle">…</p> : null}
        </div>
      )}
      {fetched.isPending ? (
        <p data-fetching className="text-sm text-fg-subtle">
          Fetching the remotes…
        </p>
      ) : null}
      {fetchErrors.map((f) => (
        <p key={f.remote} className="text-sm text-fg-muted select-text">
          Couldn't fetch {f.remote} ({f.reason}); showing its branches as of the last fetch.
        </p>
      ))}
      {fetched.error ? (
        <p className="text-sm text-fg-muted select-text">Couldn't fetch: {fetched.error.message}</p>
      ) : null}
      {value?.checkedOut ? (
        <div data-checked-out role="alert" className="flex items-start gap-2 text-sm">
          <p className="min-w-0 flex-1 text-st-error select-text">
            ✕ {checkedOutText(value.branch, value.checkedOut, projectName)}
          </p>
          <button
            type="button"
            className={button('secondary', 'sm')}
            onClick={() => value.checkedOut && onOpenElsewhere(value.checkedOut)}
          >
            {value.checkedOut.kind === 'workspace'
              ? 'Open workspace'
              : value.checkedOut.kind === 'worktree'
                ? 'Open as workspace'
                : 'Open project'}
          </button>
        </div>
      ) : value?.base ? (
        <p role="alert" className="text-sm text-st-error">
          ✕ {value.branch} is the base branch; start a new branch from it instead.
        </p>
      ) : null}
    </div>
  );
}
