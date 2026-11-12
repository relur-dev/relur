import type { Proposal } from '@shared/proposal';
import {
  DEFAULT_CONTINUE_PROMPT,
  type Profile,
  type Project,
  type TaskLookup,
  type Workflow,
  type WorkflowStatus,
} from '@shared/schemas';
import type { WorkspaceState } from '@shared/status';
import { canContinue, effectiveWorkflow, type WorkflowInfo } from '@shared/workflow';
import { workflowChanges } from '@shared/workflow-file';
import type { Workspace } from '@shared/workspaces';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { GuideLink, SetupGuideLink } from '../guide/link';
import { useTRPC } from '../trpc';
import { button, inputClass, Kbd, keyHint, labelClass } from '../ui/controls';
import { ModalBody, ModalFooter, modalForm } from './Modal';
import { SetupFromSkills } from './SetupFromSkills';

/** How much of the stepper fits: every name, only the current one, or one pill. */
type StepperFit = 'full' | 'collapsed' | 'pill';

/**
 * The stepper's widest form that fits its width (spec §13.5), measured from
 * hidden copies of the full and collapsed forms whenever either changes size.
 */
function useStepperFit(): {
  fit: StepperFit;
  box: React.RefObject<HTMLDivElement | null>;
  full: React.RefObject<HTMLOListElement | null>;
  collapsed: React.RefObject<HTMLOListElement | null>;
} {
  const box = useRef<HTMLDivElement>(null);
  const full = useRef<HTMLOListElement>(null);
  const collapsed = useRef<HTMLOListElement>(null);
  const [fit, setFit] = useState<StepperFit>('full');
  useLayoutEffect(() => {
    const measure = () => {
      const width = box.current?.clientWidth ?? 0;
      const fullWidth = full.current?.scrollWidth ?? 0;
      const collapsedWidth = collapsed.current?.scrollWidth ?? 0;
      setFit(fullWidth <= width ? 'full' : collapsedWidth <= width ? 'collapsed' : 'pill');
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const el of [box.current, full.current, collapsed.current]) if (el) observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { fit, box, full, collapsed };
}

/** A gate's mark: the Awaiting approval glyph's diamond, where Claude will stop. */
const GateMark = () => (
  <span className="text-st-approval" title="A gate: the skill waits for you here">
    ◆
  </span>
);

/** The statuses in order, every one named, or with `collapse` only the current one. */
function StepList({
  workflow,
  collapse,
  listRef,
  hidden,
}: {
  workflow: WorkflowInfo;
  collapse: boolean;
  listRef?: React.Ref<HTMLOListElement>;
  /** A copy for measuring only. */
  hidden?: boolean;
}) {
  const current = workflow.index;
  return (
    <ol
      ref={listRef}
      aria-hidden={hidden || undefined}
      {...(hidden ? {} : { 'data-stepper': true })}
      className={`flex items-center gap-1 text-sm whitespace-nowrap ${
        hidden ? 'invisible absolute top-0 left-0' : ''
      }`}
    >
      {workflow.statuses.map((s, i) => {
        const done = i < current;
        const gate = s.kind === 'gate' ? <GateMark /> : null;
        const title = `${s.label}${s.kind === 'gate' ? ' · gate, waits for you' : ''}`;
        return (
          <li key={s.value} className="flex shrink-0 items-center gap-1" title={title}>
            {i > 0 ? <span className="text-fg-subtle">›</span> : null}
            {i === current ? (
              <span
                {...(hidden ? {} : { 'data-step-current': s.value })}
                className="inline-flex items-center gap-1 rounded-sm border border-line-strong bg-raised px-1.5 font-semibold text-fg"
              >
                {gate}
                {s.label}
              </span>
            ) : (
              <span
                {...(hidden ? {} : { 'data-step': done ? 'done' : 'upcoming' })}
                className="inline-flex items-center gap-1 text-fg-subtle"
              >
                {collapse ? (
                  <>
                    {done ? '✓' : String(i + 1)}
                    {gate}
                  </>
                ) : (
                  <>
                    {done ? '✓' : null}
                    {gate}
                    {s.label}
                  </>
                )}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The workflow stepper (spec §13.5; design: Workspace header and lifecycle
 * stepper): every status named in order, finished ones greyed with ✓, later
 * ones greyed, the current one as a pill, gates marked with a diamond. Only
 * when the names don't fit its width do the others become ✓ or their number
 * (names in the tooltips); when even that doesn't fit, one `3/7 Label` pill.
 */
export function WorkflowStepper({ workflow }: { workflow: WorkflowInfo }) {
  if (!workflow.status) {
    return (
      <span
        data-workflow-problem
        className="text-sm text-fg-subtle"
        title={workflow.file ?? undefined}
      >
        {workflow.problem}
      </span>
    );
  }
  if (workflow.kind === 'unknown') {
    return (
      <span
        data-workflow-unknown
        className="text-sm text-st-permission"
        title={workflow.file ?? undefined}
      >
        Status “{workflow.status}” isn't in the workflow's list
      </span>
    );
  }
  return <FittedStepper workflow={workflow} />;
}

/** The stepper in the widest form that fits. */
function FittedStepper({ workflow }: { workflow: WorkflowInfo }) {
  const { fit, box, full, collapsed } = useStepperFit();
  return (
    <div
      ref={box}
      data-stepper-fit={fit}
      className="relative min-w-0 flex-1 overflow-hidden"
      title={workflow.file ?? undefined}
    >
      <StepList workflow={workflow} collapse={false} listRef={full} hidden />
      <StepList workflow={workflow} collapse listRef={collapsed} hidden />
      {fit === 'pill' ? (
        <span className="inline-flex items-center gap-1 rounded-sm border border-line-strong bg-raised px-1.5 text-sm font-semibold whitespace-nowrap">
          {workflow.index + 1}/{workflow.statuses.length}
          {workflow.kind === 'gate' ? <GateMark /> : null} {workflow.label}
        </span>
      ) : (
        <StepList workflow={workflow} collapse={fit === 'collapsed'} />
      )}
    </div>
  );
}

/**
 * The workflow's actions in the header (spec §13.5): the current status's
 * hint; at a step, Continue while Claude runs and is idle; at a gate, Review
 * (when the spec view applies) and its answer button, if it has one. A gate
 * waits for a person's own decision, so it never gets Continue.
 */
export function WorkflowActions({
  workspaceId,
  workflow,
  state,
  claudeRunning,
  onReview,
}: {
  workspaceId: string;
  workflow: WorkflowInfo;
  /** The state as shown (Awaiting approval at a gate). */
  state: WorkspaceState;
  claudeRunning: boolean;
  /** At a gate: opens the spec view (spec §13.8). */
  onReview?: () => void;
}) {
  const trpc = useTRPC();
  const send = useMutation(trpc.workflow.continue.mutationOptions());
  const [answerError, setAnswerError] = useState<string | null>(null);
  if (!workflow.status) return null;
  const status = workflow.statuses[workflow.index];
  const idle = claudeRunning && (canContinue(state) || state === 'awaiting-approval');
  const error = send.error?.message ?? answerError;
  return (
    <span className="inline-flex min-w-0 shrink items-center gap-2">
      {status?.hint ? (
        <span
          data-workflow-hint
          className="min-w-0 truncate text-sm text-fg-muted"
          title={status.hint}
        >
          {status.hint}
        </span>
      ) : null}
      {workflow.kind === 'gate' && workflow.file && onReview ? (
        <button
          type="button"
          data-review
          className={button('secondary', 'sm')}
          title="Open the status file to review it"
          onClick={onReview}
        >
          Review
        </button>
      ) : null}
      <GateAnswer
        workspaceId={workspaceId}
        workflow={workflow}
        state={state}
        claudeRunning={claudeRunning}
        className={(primary) => button(primary ? 'primary' : 'secondary', 'sm')}
        onError={setAnswerError}
      />
      {workflow.kind === 'step' && idle ? (
        <button
          type="button"
          data-continue
          className={button('secondary', 'sm')}
          disabled={send.isPending}
          title={`Type the Continue prompt into Claude (${keyHint('continueWorkflow')})`}
          onClick={() => send.mutate({ workspaceId })}
        >
          Continue <Kbd>{keyHint('continueWorkflow')}</Kbd>
        </button>
      ) : null}
      {error ? <span className="shrink-0 text-sm text-st-error">✕ {error}</span> : null}
    </span>
  );
}

/**
 * A gate's answer button (spec §13.5), in the header and on Home (§6.7): it
 * types the answer's prompt into Claude while Claude runs and is idle.
 */
export function GateAnswer({
  workspaceId,
  workflow,
  state,
  claudeRunning,
  className,
  onError,
}: {
  workspaceId: string;
  workflow: WorkflowInfo;
  state: WorkspaceState;
  claudeRunning: boolean;
  /** The button's classes; primary while it is what the workspace waits for. */
  className: (primary: boolean) => string;
  onError: (message: string | null) => void;
}) {
  const trpc = useTRPC();
  const answer = useMutation(
    trpc.workflow.answer.mutationOptions({
      onMutate: () => onError(null),
      onError: (e) => onError(e.message),
    }),
  );
  const status = workflow.statuses[workflow.index];
  if (workflow.kind !== 'gate' || !status?.answer) return null;
  const idle = claudeRunning && (canContinue(state) || state === 'awaiting-approval');
  return (
    <button
      type="button"
      data-answer
      className={className(state === 'awaiting-approval')}
      disabled={!idle || answer.isPending}
      title={
        idle
          ? `Types into Claude: ${status.answer.prompt}`
          : claudeRunning
            ? 'Claude is busy; answer when it stops'
            : "Claude isn't running; start it first"
      }
      onClick={(e) => {
        e.stopPropagation();
        answer.mutate({ workspaceId });
      }}
    >
      {status.answer.label}
    </button>
  );
}

/** A new workflow's starting point: generic values to edit. */
const NEW_WORKFLOW: Workflow = {
  file: 'docs/specs/*/specification.md',
  match: { field: 'branch', equals: 'branch' },
  idField: null,
  titleField: null,
  statusField: 'status',
  statuses: [],
  startPrompt: null,
  continuePrompt: DEFAULT_CONTINUE_PROMPT,
};

const KIND_TEXT: Record<WorkflowStatus['kind'], string> = {
  step: 'Step',
  gate: 'Gate · waits for you',
  final: 'Final',
};

/** The workflow's fields (spec §13.4), edited as a draft. */
function WorkflowFields({
  draft,
  onChange,
}: {
  draft: Workflow;
  onChange: (draft: Workflow) => void;
}) {
  const set = (changes: Partial<Workflow>) => onChange({ ...draft, ...changes });
  const setStatus = (index: number, changes: Partial<WorkflowStatus>) =>
    set({
      statuses: draft.statuses.map((s, i) => (i === index ? { ...s, ...changes } : s)),
    });
  const move = (index: number, by: number) => {
    const statuses = [...draft.statuses];
    const [item] = statuses.splice(index, 1);
    if (item) statuses.splice(index + by, 0, item);
    set({ statuses });
  };
  const mono = `${inputClass} font-mono text-sm`;
  const advanced = (
    <>
      <div>
        <label className={labelClass} htmlFor="wf-document-label">
          Document label · the workspace tab that shows the status file
        </label>
        <input
          id="wf-document-label"
          className={inputClass}
          placeholder={draft.file.split('/').pop() || 'specification.md'}
          value={draft.documentLabel ?? ''}
          onChange={(e) => set({ documentLabel: e.target.value || null })}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelClass} htmlFor="wf-match-field">
            The workspace's file has the field
          </label>
          <input
            id="wf-match-field"
            className={mono}
            spellCheck={false}
            value={draft.match.field}
            onChange={(e) => set({ match: { ...draft.match, field: e.target.value } })}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="wf-match-equals">
            equal to the workspace's
          </label>
          <select
            id="wf-match-equals"
            className={inputClass}
            value={draft.match.equals}
            onChange={(e) =>
              set({ match: { ...draft.match, equals: e.target.value as 'branch' | 'taskId' } })
            }
          >
            <option value="branch">branch</option>
            <option value="taskId">task id</option>
          </select>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className={labelClass} htmlFor="wf-status-field">
            Status field
          </label>
          <input
            id="wf-status-field"
            className={mono}
            spellCheck={false}
            value={draft.statusField}
            onChange={(e) => set({ statusField: e.target.value })}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="wf-id-field">
            Task id field · optional
          </label>
          <input
            id="wf-id-field"
            className={mono}
            spellCheck={false}
            value={draft.idField ?? ''}
            onChange={(e) => set({ idField: e.target.value || null })}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="wf-title-field">
            Title field · optional
          </label>
          <input
            id="wf-title-field"
            className={mono}
            spellCheck={false}
            placeholder="first # heading"
            value={draft.titleField ?? ''}
            onChange={(e) => set({ titleField: e.target.value || null })}
          />
        </div>
      </div>
    </>
  );
  return (
    <div className="space-y-3">
      <div>
        <label className={labelClass} htmlFor="wf-file">
          Status file · relative to the worktree, * matches within one folder
        </label>
        <input
          id="wf-file"
          className={mono}
          spellCheck={false}
          value={draft.file}
          onChange={(e) => set({ file: e.target.value })}
        />
      </div>
      <fieldset>
        <legend className={labelClass}>Statuses, in order</legend>
        <table className="w-full text-md" data-status-table>
          <thead>
            <tr className="text-left text-sm text-fg-muted">
              <th className="w-[30%] pb-1 font-normal">Value in the file</th>
              <th className="pb-1 font-normal">Label</th>
              <th className="w-40 pb-1 font-normal">Kind</th>
              <th className="w-20" />
            </tr>
          </thead>
          <tbody>
            {draft.statuses.flatMap((s, i) => [
              // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place, values may repeat while typing
              <tr key={i}>
                <td className="pr-1 pb-1">
                  <input
                    aria-label={`Status ${i + 1} value`}
                    className={mono}
                    spellCheck={false}
                    value={s.value}
                    onChange={(e) => setStatus(i, { value: e.target.value })}
                  />
                </td>
                <td className="pr-1 pb-1">
                  <input
                    aria-label={`Status ${i + 1} label`}
                    className={inputClass}
                    value={s.label}
                    onChange={(e) => setStatus(i, { label: e.target.value })}
                  />
                </td>
                <td className="pr-1 pb-1">
                  <select
                    aria-label={`Status ${i + 1} kind`}
                    className={inputClass}
                    value={s.kind}
                    onChange={(e) =>
                      setStatus(i, { kind: e.target.value as WorkflowStatus['kind'] })
                    }
                  >
                    {(['step', 'gate', 'final'] as const).map((k) => (
                      <option key={k} value={k}>
                        {KIND_TEXT[k]}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="pb-1 whitespace-nowrap">
                  <button
                    type="button"
                    className={button('ghost', 'sm')}
                    aria-label="Move up"
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className={button('ghost', 'sm')}
                    aria-label="Move down"
                    disabled={i === draft.statuses.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className={button('ghost', 'sm')}
                    aria-label="Remove status"
                    onClick={() => set({ statuses: draft.statuses.filter((_s, j) => j !== i) })}
                  >
                    ✕
                  </button>
                </td>
              </tr>,
              // biome-ignore lint/suspicious/noArrayIndexKey: as the row above
              <tr key={`${i}-more`} data-status-more={i}>
                <td colSpan={4} className="pb-2">
                  <div
                    className={`grid gap-1 ${s.kind === 'gate' ? 'grid-cols-[2fr_1fr_2fr]' : ''}`}
                  >
                    <input
                      aria-label={`Status ${i + 1} hint`}
                      className={`${inputClass} text-sm`}
                      placeholder={
                        s.kind === 'gate'
                          ? 'Hint · e.g. Review and approve the spec'
                          : 'Hint · optional, shown next to the stepper'
                      }
                      value={s.hint ?? ''}
                      onChange={(e) => setStatus(i, { hint: e.target.value || null })}
                    />
                    {s.kind === 'gate' ? (
                      <>
                        <input
                          aria-label={`Status ${i + 1} answer label`}
                          className={`${inputClass} text-sm`}
                          placeholder="Button · e.g. Approve spec"
                          value={s.answer?.label ?? ''}
                          onChange={(e) =>
                            setStatus(i, {
                              answer: answerOf(e.target.value, s.answer?.prompt ?? ''),
                            })
                          }
                        />
                        <input
                          aria-label={`Status ${i + 1} answer text`}
                          className={`${inputClass} text-sm`}
                          placeholder="It sends · e.g. I approve the spec."
                          value={s.answer?.prompt ?? ''}
                          onChange={(e) =>
                            setStatus(i, {
                              answer: answerOf(s.answer?.label ?? '', e.target.value),
                            })
                          }
                        />
                      </>
                    ) : null}
                  </div>
                </td>
              </tr>,
            ])}
          </tbody>
        </table>
        <button
          type="button"
          className={button('ghost', 'sm')}
          onClick={() =>
            set({ statuses: [...draft.statuses, { value: '', label: '', kind: 'step' }] })
          }
        >
          + Add status
        </button>
      </fieldset>
      <div>
        <label className={labelClass} htmlFor="wf-start">
          <span className="inline-flex items-center gap-1.5">
            Start prompt · optional, Claude's first message in a new workspace with a task id
            <GuideLink to="workflows#the-start-prompt" label="Workflows" />
          </span>
        </label>
        <textarea
          id="wf-start"
          className={`${inputClass} h-auto min-h-14 py-1.5 font-mono text-sm`}
          spellCheck={false}
          placeholder="Start the task {id}: {title}."
          value={draft.startPrompt ?? ''}
          onChange={(e) => set({ startPrompt: e.target.value || null })}
        />
      </div>
      <div>
        <label className={labelClass} htmlFor="wf-continue">
          Continue prompt · {'{id}'} {'{title}'} {'{branch}'} {'{status}'}
        </label>
        <textarea
          id="wf-continue"
          className={`${inputClass} h-auto min-h-14 py-1.5 font-mono text-sm`}
          spellCheck={false}
          value={draft.continuePrompt}
          onChange={(e) => set({ continuePrompt: e.target.value })}
        />
      </div>
      <details className="rounded-lg border border-line" data-workflow-advanced>
        <summary className="cursor-pointer px-3 py-2 text-sm text-fg-muted select-none">
          <span className="text-fg">Advanced</span> · {advancedSummary(draft)}
        </summary>
        <div className="space-y-3 border-t border-line px-3 py-3">{advanced}</div>
      </details>
    </div>
  );
}

/** What Advanced holds, as it is now: shown while it's collapsed. */
function advancedSummary(draft: Workflow): string {
  const parts = [
    `the file whose ${draft.match.field || '…'} is the ${draft.match.equals === 'taskId' ? 'task id' : 'branch'}`,
    `status in ${draft.statusField || '…'}`,
  ];
  if (draft.idField) parts.push(`id in ${draft.idField}`);
  parts.push(draft.titleField ? `title in ${draft.titleField}` : 'title from the first heading');
  parts.push(`tab ${draft.documentLabel || draft.file.split('/').pop() || '…'}`);
  return parts.join(', ');
}

/**
 * A gate's answer while it's typed: kept with only one half filled in, so
 * the other can follow; nothing when both are empty.
 */
const answerOf = (label: string, prompt: string) => (label || prompt ? { label, prompt } : null);

/** Whether a draft can be saved: every status has a value and a label. */
const complete = (draft: Workflow) =>
  !!draft.file.trim() &&
  !!draft.match.field.trim() &&
  !!draft.statusField.trim() &&
  !!draft.continuePrompt.trim() &&
  draft.statuses.every(
    (s) =>
      s.value.trim() &&
      s.label.trim() &&
      (!s.answer || (s.kind === 'gate' && s.answer.label.trim() && s.answer.prompt.trim())),
  );

/**
 * The preview (spec §13.4): pick a workspace and see which files match, the
 * one chosen, its front matter and the status the draft gives it.
 */
function WorkflowPreview({
  draft,
  workspaces,
  focus,
  onAddStatus,
}: {
  draft: Workflow;
  workspaces: Workspace[];
  /** A workspace to show, when it changes: the one a proposal read. */
  focus?: string;
  onAddStatus: (value: string) => void;
}) {
  const trpc = useTRPC();
  const [workspaceId, setWorkspaceId] = useState(focus ?? workspaces[0]?.id ?? '');
  useEffect(() => {
    if (focus) setWorkspaceId(focus);
  }, [focus]);
  const ready = complete(draft) && workspaces.some((w) => w.id === workspaceId);
  const preview = useQuery(
    trpc.workflow.preview.queryOptions(
      { workflow: draft, workspaceId },
      { enabled: ready, staleTime: 0, retry: false },
    ),
  );
  const info = preview.data?.info;
  return (
    <div className="space-y-2 rounded-lg border border-line bg-surface p-3" data-workflow-preview>
      <div className="flex items-center gap-2">
        <span className="font-medium">Preview</span>
        <GuideLink to="workflows#the-preview" label="Workflows" />
        {workspaces.length > 0 ? (
          <select
            aria-label="Workspace to preview"
            className={`${inputClass} ml-auto w-auto`}
            value={workspaceId}
            onChange={(e) => setWorkspaceId(e.target.value)}
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} · {w.branch}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      {workspaces.length === 0 ? (
        <p className="text-sm text-fg-subtle">No workspaces to preview yet.</p>
      ) : !complete(draft) ? (
        <p className="text-sm text-fg-subtle">Fill in every field and status to preview.</p>
      ) : preview.error ? (
        <p className="text-sm text-st-error">✕ {preview.error.message}</p>
      ) : !preview.data ? (
        <p className="text-sm text-fg-subtle">Reading…</p>
      ) : (
        <>
          <p className="text-sm text-fg-muted">
            {preview.data.candidates.length === 0
              ? 'No files match the pattern in this worktree.'
              : `${preview.data.candidates.length} matching ${preview.data.candidates.length === 1 ? 'file' : 'files'}:`}
          </p>
          <ul className="space-y-0.5 font-mono text-sm">
            {preview.data.candidates.slice(0, 20).map((c) => (
              <li key={c.file} className={c.file === info?.file ? 'text-fg' : 'text-fg-subtle'}>
                {c.file === info?.file ? '→ ' : '  '}
                {c.file}
                {c.error ? <span className="text-st-error"> · {c.error}</span> : null}
              </li>
            ))}
          </ul>
          {preview.data.fields ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 font-mono text-sm">
              {Object.entries(preview.data.fields)
                .slice(0, 12)
                .map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-fg-muted">{k}</dt>
                    <dd className="truncate select-text">{JSON.stringify(v)}</dd>
                  </div>
                ))}
            </dl>
          ) : null}
          <p data-preview-result className="text-md">
            {info?.problem ? (
              info.problem
            ) : info?.kind === 'unknown' ? (
              <>
                Status <span className="font-mono">{info.status}</span> isn't in the list.{' '}
                <button
                  type="button"
                  className={button('secondary', 'sm')}
                  onClick={() => onAddStatus(info.status as string)}
                >
                  Add to list
                </button>
              </>
            ) : info ? (
              `Status ${info.label} (${KIND_TEXT[info.kind as WorkflowStatus['kind']]}), ${info.index + 1} of ${info.statuses.length}`
            ) : null}
          </p>
        </>
      )}
    </div>
  );
}

/** A draft with an unknown status appended to its list. */
const withStatus = (draft: Workflow, value: string): Workflow => ({
  ...draft,
  statuses: [...draft.statuses, { value, label: value, kind: 'step' }],
});

/** The statuses in order, gates marked, and the Start prompt: what a workflow is, at a glance. */
export function WorkflowSummary({ workflow }: { workflow: Workflow }) {
  return (
    <div className="space-y-0.5 text-sm" data-workflow-summary>
      <p>
        {workflow.statuses.map((s, i) => (
          <span key={s.value}>
            {i > 0 ? <span className="text-fg-subtle"> › </span> : null}
            {s.kind === 'gate' ? <GateMark /> : null}
            {s.label}
          </span>
        ))}
      </p>
      <p className="text-fg-muted">
        Status file <span className="font-mono">{workflow.file}</span>
        {workflow.startPrompt ? (
          <>
            {' '}
            · Start prompt <span className="font-mono">{workflow.startPrompt}</span>
          </>
        ) : null}
      </p>
    </div>
  );
}

/** What replacing `current` with `next` changes (spec §13.9), one line each. */
export function WorkflowChangeList({ current, next }: { current: Workflow; next: Workflow }) {
  const lines = workflowChanges(current, next);
  if (lines.length === 0) {
    return <p className="text-sm text-fg-muted">The same as the current workflow.</p>;
  }
  return (
    <ul data-workflow-changes className="list-disc space-y-0.5 pl-5 text-sm select-text">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

/** Where an unsaved draft came from, shown above the form until it's saved. */
interface DraftSource {
  /** "~/Downloads/x.json", say. */
  from: string;
  /** The saved workflow it replaces, to list what changes; null when there's none. */
  saved: Workflow | null;
  /** Set up from my skills: what Claude couldn't determine (spec §13.10). */
  undetermined?: string[];
  /** Set up from my skills: the task lookup it found. */
  lookup?: TaskLookup | null;
  /** Set up from my skills: the workspace it read, for the preview. */
  workspaceId?: string;
}

function DraftNotice({
  source,
  draft,
  children,
}: {
  source: DraftSource;
  draft: Workflow;
  children?: React.ReactNode;
}) {
  return (
    <div
      data-draft-notice
      className="space-y-1.5 rounded-lg border border-line-strong bg-surface p-3 text-md"
    >
      <p>
        Filled in from <span className="select-text">{source.from}</span>. Nothing is saved yet:
        review it, then save.
      </p>
      {source.saved ? (
        <>
          <p className="text-sm text-fg-muted">Compared with the saved workflow:</p>
          <WorkflowChangeList current={source.saved} next={draft} />
        </>
      ) : null}
      {source.undetermined?.length ? (
        <div data-undetermined>
          <p className="text-sm font-medium text-st-permission">Couldn't determine:</p>
          <ul className="list-disc space-y-0.5 pl-5 text-sm select-text">
            {source.undetermined.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {children}
    </div>
  );
}

/** The task lookup a proposal found, as its one tool. */
const lookupTool = (lookup: TaskLookup | null | undefined) =>
  lookup?.kind === 'prompt' ? (lookup.tools[0] ?? null) : null;

/** Import… and Export… (spec §13.9): a workflow file to share. */
function WorkflowFileButtons({
  draft,
  canExport,
  onImport,
}: {
  draft: Workflow;
  canExport: boolean;
  onImport: (workflow: Workflow, file: string) => void;
}) {
  const trpc = useTRPC();
  const [exported, setExported] = useState<string | null>(null);
  const importFile = useMutation(trpc.workflow.importFile.mutationOptions());
  const exportFile = useMutation(trpc.workflow.exportFile.mutationOptions());
  const error = (importFile.error ?? exportFile.error)?.message;
  return (
    <div className="flex flex-wrap items-center gap-2" data-workflow-file-buttons>
      <button
        type="button"
        className={button('secondary', 'sm')}
        disabled={importFile.isPending}
        onClick={async () => {
          setExported(null);
          exportFile.reset();
          const read = await importFile.mutateAsync().catch(() => null);
          if (read) onImport(read.workflow, read.file);
        }}
      >
        Import…
      </button>
      <button
        type="button"
        className={button('secondary', 'sm')}
        disabled={!canExport || exportFile.isPending}
        title={canExport ? 'Save this workflow to a file to share' : 'Fill in every field first'}
        onClick={async () => {
          importFile.reset();
          setExported(await exportFile.mutateAsync({ workflow: draft }).catch(() => null));
        }}
      >
        Export…
      </button>
      {exported ? (
        <span data-exported className="text-sm text-fg-muted select-text">
          ✓ Exported to <span className="font-mono">{exported}</span>
        </span>
      ) : null}
      {error ? (
        <span role="alert" className="text-sm text-st-error select-text">
          ✕ {error}
        </span>
      ) : null}
    </div>
  );
}

/** Edit profile › Workflow (spec §13.4): the profile's workflow, or none. */
export function ProfileWorkflowEditor({
  profile,
  workspaces,
  onGuide,
  onSaved,
}: {
  profile: Profile;
  workspaces: Workspace[];
  onGuide: () => void;
  onSaved: () => void;
}) {
  const trpc = useTRPC();
  const [on, setOn] = useState(!!profile.workflow);
  const [draft, setDraft] = useState<Workflow>(profile.workflow ?? NEW_WORKFLOW);
  const [source, setSource] = useState<DraftSource | null>(null);
  // A proposal's task lookup is saved with the workflow when ticked (spec §13.10).
  const [takeLookup, setTakeLookup] = useState(false);
  const save = useMutation(trpc.workflow.saveProfile.mutationOptions());
  const saveLookup = useMutation(trpc.workflow.saveLookup.mutationOptions());
  const fill = (workflow: Workflow, from: string) => {
    setOn(true);
    setDraft(workflow);
    setSource({ from, saved: profile.workflow ?? null });
  };
  const fillProposal = (proposal: Proposal, from: string, workspaceId: string) => {
    setOn(true);
    setDraft(proposal.workflow);
    setSource({
      from,
      saved: profile.workflow ?? null,
      undetermined: proposal.undetermined,
      lookup: proposal.lookup,
      workspaceId,
    });
    setTakeLookup(!!proposal.lookup && !profile.taskLookup);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (on && !complete(draft)) return;
    try {
      await save.mutateAsync({ profileId: profile.id, workflow: on ? draft : null });
      if (on && takeLookup && source?.lookup) {
        await saveLookup.mutateAsync({ profileId: profile.id, lookup: source.lookup });
      }
      onSaved();
    } catch {
      // Shown below.
    }
  };
  const tool = lookupTool(source?.lookup);
  return (
    <form
      onSubmit={(e) => void submit(e)}
      className={`${modalForm} text-md`}
      data-workflow-editor="profile"
    >
      <ModalBody className="space-y-3">
        <p className="text-fg-muted">
          <span className="float-right ml-2">
            <GuideLink to="workflows#setting-it-up" label="Workflows" before={onGuide} />
          </span>
          Your skills keep each task's status in a file in its worktree. The app reads it, shows it
          as a stepper, tells you when the skills wait for you, and types the Continue prompt for
          you. Projects use this workflow unless they set their own.
        </p>
        <SetupGuideLink before={onGuide} />
        <SetupFromSkills profile={profile} projectId={null} onProposal={fillProposal} />
        <WorkflowFileButtons draft={draft} canExport={on && complete(draft)} onImport={fill} />
        {source ? (
          <DraftNotice source={source} draft={draft}>
            {tool ? (
              <label className="flex items-start gap-2 text-sm" data-take-lookup>
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={takeLookup}
                  onChange={(e) => setTakeLookup(e.target.checked)}
                />
                <span>
                  Also set up the task lookup: ask Claude, with{' '}
                  <span className="font-mono">{tool}</span>
                  {profile.taskLookup ? ' (replaces your current task lookup)' : ''}. Test it in the
                  Task lookup tab.
                </span>
              </label>
            ) : null}
          </DraftNotice>
        ) : null}
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
          Read a workflow status in this profile's workspaces
        </label>
        {on ? (
          <>
            <WorkflowFields draft={draft} onChange={setDraft} />
            <WorkflowPreview
              draft={draft}
              workspaces={workspaces}
              focus={source?.workspaceId}
              onAddStatus={(value) => setDraft(withStatus(draft, value))}
            />
          </>
        ) : null}
        {(save.error ?? saveLookup.error) ? (
          <p className="text-sm text-st-error">✕ {(save.error ?? saveLookup.error)?.message}</p>
        ) : null}
      </ModalBody>
      <ModalFooter>
        <button
          type="submit"
          className={button('primary')}
          disabled={save.isPending || saveLookup.isPending || (on && !complete(draft))}
        >
          Save workflow
        </button>
      </ModalFooter>
    </form>
  );
}

type ProjectMode = 'profile' | 'override' | 'none';

/**
 * Project view › Workflow (spec §13.4, §13.5): the profile's workflow, its
 * own, or none; and the project's Start prompt.
 */
export function ProjectWorkflowEditor({
  profile,
  project,
  workspaces,
}: {
  profile: Profile;
  project: Project;
  workspaces: Workspace[];
}) {
  const trpc = useTRPC();
  const [mode, setMode] = useState<ProjectMode>(
    project.workflow === false ? 'none' : project.workflow ? 'override' : 'profile',
  );
  const [draft, setDraft] = useState<Workflow>(
    project.workflow || profile.workflow || NEW_WORKFLOW,
  );
  const [startPrompt, setStartPrompt] = useState(project.startPrompt ?? '');
  const [saved, setSaved] = useState(false);
  const [source, setSource] = useState<DraftSource | null>(null);
  const save = useMutation(
    trpc.workflow.saveProject.mutationOptions({
      onSuccess: () => {
        setSaved(true);
        setSource(null);
      },
    }),
  );
  const fill = (workflow: Workflow, from: string, more: Partial<DraftSource> = {}) => {
    setMode('override');
    setDraft(workflow);
    setSaved(false);
    setSource({ from, saved: effectiveWorkflow(profile, project), ...more });
  };
  const tool = lookupTool(source?.lookup);
  const shown = mode === 'override' ? draft : effectiveWorkflow(profile, { workflow: null });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    if (mode === 'override' && !complete(draft)) return;
    save.mutate({
      projectId: project.id,
      workflow: mode === 'override' ? draft : mode === 'none' ? false : null,
      startPrompt: startPrompt.trim() || null,
    });
  };
  return (
    <form
      onSubmit={submit}
      className="max-w-[760px] space-y-3 py-4 text-md"
      data-workflow-editor="project"
    >
      <p className="text-fg-muted">
        <span className="float-right ml-2">
          <GuideLink to="workflows#per-project" label="Workflows" />
        </span>
        Kept in the app's settings, never in the repository.
      </p>
      <SetupGuideLink />
      <SetupFromSkills
        profile={profile}
        projectId={project.id}
        onProposal={(proposal, from, workspaceId) =>
          fill(proposal.workflow, from, {
            undetermined: proposal.undetermined,
            lookup: proposal.lookup,
            workspaceId,
          })
        }
      />
      <WorkflowFileButtons
        draft={shown ?? draft}
        canExport={mode !== 'none' && !!shown && complete(shown)}
        onImport={fill}
      />
      {source && mode === 'override' ? (
        <DraftNotice source={source} draft={draft}>
          {tool ? (
            <p className="text-sm text-fg-muted">
              It also found a task lookup through <span className="font-mono">{tool}</span>. Task
              lookups belong to the profile: set it up in Edit profile › Task lookup.
            </p>
          ) : null}
        </DraftNotice>
      ) : null}
      <div className="flex gap-4" role="radiogroup" aria-label="Workflow">
        {(
          [
            ['profile', `Use ${profile.name}'s workflow`],
            ['override', 'Override for this project'],
            ['none', 'None'],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="flex items-center gap-2">
            <input
              type="radio"
              name="project-workflow"
              checked={mode === value}
              onChange={() => setMode(value)}
            />
            {label}
          </label>
        ))}
      </div>
      {mode === 'profile' && !profile.workflow ? (
        <p className="text-sm text-fg-subtle">
          {profile.name} has no workflow. Set one in Edit profile › Workflow, or override it here.
        </p>
      ) : null}
      {mode === 'override' ? <WorkflowFields draft={draft} onChange={setDraft} /> : null}
      {mode !== 'none' && shown ? (
        <WorkflowPreview
          draft={shown}
          workspaces={workspaces}
          focus={source?.workspaceId}
          onAddStatus={(value) => {
            setMode('override');
            setDraft(withStatus(shown, value));
          }}
        />
      ) : null}
      <div>
        <label className={labelClass} htmlFor="wf-project-start">
          <span className="inline-flex items-center gap-1.5">
            Start prompt for this project · optional, replaces the workflow's
            <GuideLink to="workflows#the-start-prompt" label="Workflows" />
          </span>
        </label>
        <textarea
          id="wf-project-start"
          className={`${inputClass} h-auto min-h-14 py-1.5 font-mono text-sm`}
          spellCheck={false}
          placeholder={shown?.startPrompt ?? 'Start the task {id}: {title}.'}
          value={startPrompt}
          onChange={(e) => setStartPrompt(e.target.value)}
        />
      </div>
      {save.error ? <p className="text-sm text-st-error">✕ {save.error.message}</p> : null}
      <div className="flex items-center gap-3">
        <button
          type="submit"
          className={button('primary')}
          disabled={save.isPending || (mode === 'override' && !complete(draft))}
        >
          Save
        </button>
        {saved ? <span className="text-sm text-fg-muted">Saved</span> : null}
      </div>
    </form>
  );
}
