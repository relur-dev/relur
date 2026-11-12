import { isConnectorTool, type LookupResult, looksLikeWriteTool } from '@shared/lookup';
import { DEFAULT_LOOKUP_PROMPT, type Profile, type TaskLookup } from '@shared/schemas';
import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { GuideLink } from '../guide/link';
import { useTRPC } from '../trpc';
import { button, inputClass, labelClass } from '../ui/controls';
import { ModalBody, ModalFooter, modalForm } from './Modal';

const parseTools = (text: string) =>
  [...new Set(text.split('\n').map((t) => t.trim()))].filter(Boolean);

/** The lookup's tools, one per line; edited as text so a new line can be typed. */
function ToolList({ tools, onChange }: { tools: string[]; onChange: (tools: string[]) => void }) {
  const [text, setText] = useState(tools.join('\n'));
  // Allow this tool adds one from outside.
  if (parseTools(text).join('\n') !== tools.join('\n')) setText(tools.join('\n'));
  return (
    <textarea
      id="lookup-tools"
      className={`${inputClass} h-auto min-h-14 py-1.5 font-mono text-sm`}
      spellCheck={false}
      placeholder="mcp__tracker__get_issue"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseTools(e.target.value));
      }}
    />
  );
}

const NEW_PROMPT_LOOKUP: TaskLookup = {
  kind: 'prompt',
  prompt: DEFAULT_LOOKUP_PROMPT,
  tools: [],
  timeoutSec: 60,
};
const NEW_COMMAND_LOOKUP: TaskLookup = { kind: 'command', command: '', timeoutSec: 20 };

/** Whether a lookup draft can be saved. */
const lookupComplete = (lookup: TaskLookup | null | undefined) =>
  !lookup || (lookup.kind === 'prompt' ? !!lookup.prompt.trim() : !!lookup.command.trim());

/**
 * The task lookup (spec §13.7): none, a prompt for the profile's Claude with
 * the tools it may use, or a command. Test runs the draft for an id; a tool
 * Claude was refused can be allowed from there.
 */
function LookupFields({
  lookup,
  onChange,
  profileId,
  projectId,
}: {
  lookup: TaskLookup | null;
  onChange: (lookup: TaskLookup | null) => void;
  profileId: string;
  projectId: string | null;
}) {
  const trpc = useTRPC();
  const [testId, setTestId] = useState('');
  const [result, setResult] = useState<LookupResult | null>(null);
  const test = useMutation(trpc.workflow.lookupTitle.mutationOptions());
  const mono = `${inputClass} font-mono text-sm`;
  const kind = lookup?.kind ?? 'none';
  const runTest = () => {
    if (!lookup || !testId.trim()) return;
    setResult(null);
    test.mutate(
      {
        requestId: crypto.randomUUID(),
        profileId,
        projectId,
        taskId: testId.trim(),
        lookup,
      },
      {
        onSuccess: setResult,
        onError: (e) => setResult({ ok: false, message: e.message, refused: [] }),
      },
    );
  };
  const allow = (tool: string) => {
    if (lookup?.kind !== 'prompt') return;
    onChange({ ...lookup, tools: [...new Set([...lookup.tools, tool])] });
    setResult(null);
  };
  return (
    <fieldset className="space-y-2" data-lookup-fields>
      <legend className={`${labelClass} flex items-center gap-1.5`}>
        Task lookup · fills in the title when New workspace gets a task id alone
        <GuideLink to="new-workspace#looking-up-the-title" label="New workspace" />
      </legend>
      <div className="flex gap-4" role="radiogroup" aria-label="Task lookup">
        {(
          [
            ['none', 'None', null],
            ['prompt', 'Ask Claude', NEW_PROMPT_LOOKUP],
            ['command', 'Run a command', NEW_COMMAND_LOOKUP],
          ] as const
        ).map(([value, label, initial]) => (
          <label key={value} className="flex items-center gap-2">
            <input
              type="radio"
              name="lookup-kind"
              checked={kind === value}
              onChange={() => {
                onChange(initial);
                setResult(null);
              }}
            />
            {label}
          </label>
        ))}
      </div>
      {lookup?.kind === 'prompt' ? (
        <>
          <div>
            <label className={labelClass} htmlFor="lookup-prompt">
              Prompt · {'{id}'} · run with this profile's Claude, without a terminal
            </label>
            <textarea
              id="lookup-prompt"
              className={`${inputClass} h-auto min-h-14 py-1.5 font-mono text-sm`}
              spellCheck={false}
              value={lookup.prompt}
              onChange={(e) => onChange({ ...lookup, prompt: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-[1fr_3fr] gap-2">
            <div>
              <label className={labelClass} htmlFor="lookup-model">
                Model
              </label>
              <input
                id="lookup-model"
                className={mono}
                spellCheck={false}
                placeholder="Profile's default"
                value={lookup.model ?? ''}
                onChange={(e) => onChange({ ...lookup, model: e.target.value || undefined })}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="lookup-tools">
                Tools it may use · one per line; only read tools
              </label>
              <ToolList tools={lookup.tools} onChange={(tools) => onChange({ ...lookup, tools })} />
            </div>
          </div>
          <p className="text-sm text-fg-subtle">
            The lookup reads tickets other people write, so it gets no tools but these: name a
            connector's tool that reads a ticket, or <span className="font-mono">mcp__name</span>{' '}
            for a whole connector. Test it with a real id: a tool Claude wasn't allowed shows up
            below with <b>Allow this tool</b>.
          </p>
          {lookup.tools.filter(looksLikeWriteTool).map((tool) => (
            <p key={tool} role="alert" className="text-sm text-st-permission">
              ⚠ <span className="font-mono">{tool}</span> looks like a tool that changes things.
            </p>
          ))}
        </>
      ) : null}
      {lookup?.kind === 'command' ? (
        <div>
          <label className={labelClass} htmlFor="lookup-command">
            Command · {'{id}'} · run with this profile's environment; prints the title
          </label>
          <input
            id="lookup-command"
            className={mono}
            spellCheck={false}
            placeholder="tracker issue view {id} --field title"
            value={lookup.command}
            onChange={(e) => onChange({ ...lookup, command: e.target.value })}
          />
        </div>
      ) : null}
      {lookup ? (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <label className="text-sm text-fg-muted" htmlFor="lookup-timeout">
              Timeout
            </label>
            <input
              id="lookup-timeout"
              type="number"
              min={5}
              max={600}
              className={`${mono} w-20`}
              value={lookup.timeoutSec}
              onChange={(e) =>
                onChange({
                  ...lookup,
                  timeoutSec: Math.min(600, Math.max(5, Number(e.target.value) || 5)),
                })
              }
            />
            <span className="text-sm text-fg-muted">s</span>
            <span className="flex-1" />
            <input
              aria-label="Task id to test"
              className={`${mono} w-36`}
              spellCheck={false}
              placeholder="ABC-123"
              value={testId}
              onChange={(e) => setTestId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  runTest();
                }
              }}
            />
            <button
              type="button"
              className={button('ghost', 'sm')}
              disabled={!testId.trim() || !lookupComplete(lookup) || test.isPending}
              onClick={runTest}
            >
              {test.isPending ? 'Looking up…' : 'Test'}
            </button>
          </div>
          {result?.ok ? (
            <p data-lookup-result className="text-sm text-fg-muted select-text">
              ✓ <span className="text-fg">{result.title}</span>
            </p>
          ) : null}
          {result && !result.ok ? (
            <div data-lookup-result role="alert" className="space-y-1 text-sm">
              <p className="text-st-error select-text">✕ {result.message}</p>
              {result.detail ? (
                <p data-lookup-detail className="text-fg-muted select-text">
                  Claude: {result.detail}
                </p>
              ) : null}
              {result.refused.map((tool) => (
                <p key={tool} className="flex items-center gap-2">
                  <span className="font-mono">{tool}</span>
                  {looksLikeWriteTool(tool) ? (
                    <span className="text-st-permission">looks like it changes things</span>
                  ) : null}
                  <button
                    type="button"
                    className={button('ghost', 'sm')}
                    onClick={() => allow(tool)}
                  >
                    {looksLikeWriteTool(tool) ? 'Allow anyway' : 'Allow this tool'}
                  </button>
                  {isConnectorTool(tool) ? null : (
                    <span className="text-fg-subtle">a built-in tool</span>
                  )}
                </p>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </fieldset>
  );
}

/** Edit profile › Task lookup (spec §13.7): the profile's lookup, or none. */
export function ProfileLookupEditor({
  profile,
  onSaved,
}: {
  profile: Profile;
  onSaved: () => void;
}) {
  const trpc = useTRPC();
  const [draft, setDraft] = useState<TaskLookup | null>(profile.taskLookup ?? null);
  const save = useMutation(trpc.workflow.saveLookup.mutationOptions({ onSuccess: onSaved }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!lookupComplete(draft)) return;
    save.mutate({ profileId: profile.id, lookup: draft });
  };
  return (
    <form onSubmit={submit} className={`${modalForm} text-md`} data-lookup-editor>
      <ModalBody className="space-y-3">
        <p className="text-fg-muted">
          When you type a task id alone in New workspace, the app can fill in its title: by asking
          this profile's Claude, which may use only the read tools you name, or by running a
          command.
        </p>
        <LookupFields lookup={draft} onChange={setDraft} profileId={profile.id} projectId={null} />
        {save.error ? <p className="text-sm text-st-error">✕ {save.error.message}</p> : null}
      </ModalBody>
      <ModalFooter>
        <button
          type="submit"
          className={button('primary')}
          disabled={save.isPending || !lookupComplete(draft)}
        >
          Save task lookup
        </button>
      </ModalFooter>
    </form>
  );
}
