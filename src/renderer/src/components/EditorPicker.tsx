import {
  editorLabel,
  editorWindows,
  KNOWN_EDITORS,
  NO_EDITOR,
  OPEN_ALL_CONFIRM_ABOVE,
} from '@shared/editor';
import {
  EDITOR_KINDS,
  type Editor,
  type EditorKind,
  type Profile,
  type Project,
} from '@shared/schemas';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { trpcClient, useTRPC } from '../trpc';
import { button, inputClass, labelClass } from '../ui/controls';
import { Modal, ModalBody, ModalFooter, modalForm } from './Modal';

/** What a picker holds while it's edited: a known editor, custom commands, or none. */
export type EditorDraft =
  | { kind: 'none' }
  | { kind: EditorKind }
  | { kind: 'custom'; folder: string; file: string };

export const draftOf = (editor: Editor | null | undefined): EditorDraft =>
  !editor
    ? { kind: 'none' }
    : editor.kind === 'custom'
      ? { kind: 'custom', folder: editor.folder, file: editor.file ?? '' }
      : { kind: editor.kind };

/** The editor a draft saves, null for none; throws when a custom one has no folder command. */
export function editorOfDraft(draft: EditorDraft): Editor | null {
  if (draft.kind === 'none') return null;
  if (draft.kind !== 'custom') return { kind: draft.kind };
  if (!draft.folder.includes('{path}')) {
    throw new Error('The folder command needs {path}, where the folder goes');
  }
  return { kind: 'custom', folder: draft.folder.trim(), file: draft.file.trim() || null };
}

/**
 * The editor setting (spec §6.13): the known editors found for the profile
 * (one chosen earlier stays listed, marked when it isn't found), or Custom
 * with a folder command and an optional file command. `none` is the label of
 * the empty choice: "Not set" for a profile, "Use the profile's editor" for a project.
 */
export function EditorPicker({
  profileId,
  value,
  onChange,
  none,
}: {
  profileId: string;
  value: EditorDraft;
  onChange: (draft: EditorDraft) => void;
  none: string;
}) {
  const trpc = useTRPC();
  const found = useQuery(trpc.editor.detect.queryOptions({ profileId }, { staleTime: 30_000 }));
  const id = useId();
  const kinds = EDITOR_KINDS.filter(
    (k) => found.data?.some((f) => f.kind === k) || value.kind === k,
  );
  return (
    <div className="space-y-2" data-editor-picker>
      <select
        id={`${id}-kind`}
        aria-label="Editor"
        className={inputClass}
        value={value.kind}
        onChange={(e) => {
          const kind = e.target.value as EditorDraft['kind'];
          onChange(
            kind === 'custom'
              ? {
                  kind,
                  folder: value.kind === 'custom' ? value.folder : '',
                  file: value.kind === 'custom' ? value.file : '',
                }
              : ({ kind } as EditorDraft),
          );
        }}
      >
        <option value="none">{none}</option>
        {kinds.map((k) => (
          <option key={k} value={k}>
            {KNOWN_EDITORS[k].label}
            {found.data && !found.data.some((f) => f.kind === k) ? ' (not found)' : ''}
          </option>
        ))}
        <option value="custom">Custom command…</option>
      </select>
      {found.data && found.data.length === 0 && value.kind !== 'custom' ? (
        <p className="text-sm text-fg-subtle">
          None of VS Code, Cursor, IntelliJ IDEA, WebStorm or Zed was found; use a custom command.
        </p>
      ) : null}
      {value.kind === 'custom' ? (
        <div className="space-y-2">
          <div>
            <label className={labelClass} htmlFor={`${id}-folder`}>
              Open a folder · <span className="font-mono">{'{path}'}</span>
            </label>
            <input
              id={`${id}-folder`}
              className={`${inputClass} font-mono`}
              spellCheck={false}
              placeholder="code {path}"
              value={value.folder}
              onChange={(e) => onChange({ ...value, folder: e.target.value })}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor={`${id}-file`}>
              Open a file at a line · <span className="font-mono">{'{file}'}</span>{' '}
              <span className="font-mono">{'{line}'}</span> · optional
            </label>
            <input
              id={`${id}-file`}
              className={`${inputClass} font-mono`}
              spellCheck={false}
              placeholder="code -g {file}:{line}"
              value={value.file}
              onChange={(e) => onChange({ ...value, file: e.target.value })}
            />
            <p className="mt-1 text-sm text-fg-subtle">
              Without it, a file opens as its folder with the folder command.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Project view › Setup › Editor (spec §6.13): the profile's editor, or the
 * project's own. Saved when changed.
 */
export function ProjectEditor({ project, profile }: { project: Project; profile: Profile }) {
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const [draft, setDraft] = useState<EditorDraft>(draftOf(project.editor));
  const [status, setStatus] = useState<{ saved?: boolean; error?: string }>({});
  // Custom commands are saved once typing pauses.
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const save = (next: EditorDraft) => {
    setDraft(next);
    setStatus({});
    clearTimeout(timer.current);
    if (next.kind === 'custom') timer.current = setTimeout(() => store(next), 700);
    else store(next);
  };
  const store = (next: EditorDraft) => {
    let editor: Editor | null;
    try {
      editor = editorOfDraft(next);
    } catch (error) {
      setStatus({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    void trpcClient.editor.setProjectEditor.mutate({ projectId: project.id, editor }).then(
      () => {
        setStatus({ saved: true });
        void queryClient.invalidateQueries({ queryKey: trpc.config.get.queryKey() });
      },
      (error: unknown) =>
        setStatus({ error: error instanceof Error ? error.message : String(error) }),
    );
  };
  const inherited = profile.editor ? editorLabel(profile.editor) : 'not set yet';
  return (
    <section
      data-project-editor
      className="max-w-[640px] space-y-1.5 border-b border-line pt-4 pb-4"
    >
      <span className={labelClass}>Editor</span>
      <EditorPicker
        profileId={profile.id}
        value={draft}
        onChange={save}
        none={`Use the profile's editor (${inherited})`}
      />
      <p className="text-sm text-fg-subtle">
        Open in editor uses it for this project's checkout and worktrees. Kept in {`the app's`}{' '}
        settings, not in the repository.
        {status.saved ? <span className="ml-2 text-fg-muted">Saved</span> : null}
      </p>
      {status.error ? <p className="text-sm text-st-error">✕ {status.error}</p> : null}
    </section>
  );
}

/**
 * Choose an editor (spec §6.13): the first Open in editor without one set
 * asks here, saves it to the profile (or only the project), then opens.
 */
export function ChooseEditorDialog({
  profileId,
  project,
  onChosen,
  onClose,
}: {
  profileId: string;
  project: { id: string; name: string } | null;
  onChosen: () => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const found = useQuery(trpc.editor.detect.queryOptions({ profileId }, { staleTime: 30_000 }));
  const [draft, setDraft] = useState<EditorDraft>({ kind: 'none' });
  const [onlyProject, setOnlyProject] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = found.data?.[0]?.kind;
  const shown: EditorDraft = draft.kind === 'none' && first ? { kind: first } : draft;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      const editor = editorOfDraft(shown);
      if (!editor) throw new Error('Choose an editor');
      if (onlyProject && project) {
        await trpcClient.editor.setProjectEditor.mutate({ projectId: project.id, editor });
      } else {
        await trpcClient.editor.setProfileEditor.mutate({ profileId, editor });
      }
      void queryClient.invalidateQueries({ queryKey: trpc.config.get.queryKey() });
      onChosen();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Modal title="Choose an editor" onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className={modalForm} data-choose-editor>
        <ModalBody className="space-y-3">
          <p className="text-md text-fg-muted">
            Open in editor opens worktrees and files in it. You can change it later in Edit profile
            › General, or per project in its Setup tab.
          </p>
          <EditorPicker profileId={profileId} value={shown} onChange={setDraft} none="Choose…" />
          {project ? (
            <label className="flex items-center gap-2 text-md">
              <input
                type="checkbox"
                checked={onlyProject}
                onChange={(e) => setOnlyProject(e.target.checked)}
              />
              Only for {project.name}
            </label>
          ) : null}
          {error ? <p className="text-sm text-st-error">✕ {error}</p> : null}
        </ModalBody>
        <ModalFooter>
          <button type="button" className={button('secondary')} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={button('primary')}>
            Save and open
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

/** Shows a message in the window's notice bar (App listens); `info` for news that isn't a problem. */
export const APP_NOTICE_EVENT = 'app-notice';
export const showAppNotice = (text: string, info = false) =>
  window.dispatchEvent(new CustomEvent(APP_NOTICE_EVENT, { detail: { text, info } }));

/**
 * Open in editor from anywhere (spec §6.13): runs `open`; without an editor
 * set, asks with Choose an editor first and then runs it; a failure shows
 * in the window's notice bar. Render `dialog`.
 */
export function useOpenInEditor() {
  const [asking, setAsking] = useState<{
    profileId: string;
    project: { id: string; name: string } | null;
    open: () => Promise<unknown>;
  } | null>(null);
  const run = (
    open: () => Promise<unknown>,
    where: { profileId: string; project: { id: string; name: string } | null },
  ) =>
    open().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (message === NO_EDITOR) setAsking({ ...where, open });
      else showAppNotice(message);
    });
  const dialog = asking ? (
    <ChooseEditorDialog
      profileId={asking.profileId}
      project={asking.project}
      onClose={() => setAsking(null)}
      onChosen={() => {
        const { open } = asking;
        setAsking(null);
        void open().catch((error: unknown) =>
          showAppNotice(error instanceof Error ? error.message : String(error)),
        );
      }}
    />
  ) : null;
  return { run, dialog };
}

/**
 * Open all (spec §6.13): the workspace's repositories, each with the editor
 * it will use, all ticked; asks again before more than OPEN_ALL_CONFIRM_ABOVE
 * windows (VS Code and Cursor repositories share one each).
 */
export function OpenAllDialog({
  workspaceId,
  onClose,
}: {
  workspaceId: string;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const plan = useQuery(trpc.editor.openAllPlan.queryOptions({ workspaceId }, { staleTime: 0 }));
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const repos = plan.data ?? [];
  const chosen = repos.filter(
    (r): r is typeof r & { editor: Editor } => r.editor !== null && !unticked.has(r.projectId),
  );
  const windows = editorWindows(chosen).length;
  const open = async () => {
    setOpening(true);
    setError(null);
    try {
      await trpcClient.editor.openAll.mutate({
        workspaceId,
        projectIds: chosen.map((r) => r.projectId),
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setConfirming(false);
    } finally {
      setOpening(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (chosen.length === 0) return;
    if (windows > OPEN_ALL_CONFIRM_ABOVE && !confirming) setConfirming(true);
    else void open();
  };
  return (
    <Modal title="Open all in editors" onClose={onClose}>
      <form onSubmit={submit} className={modalForm} data-open-all>
        <ModalBody className="space-y-3">
          <ul className="space-y-1">
            {repos.map((r) => (
              <li key={r.projectId}>
                <label className="flex items-center gap-2 text-md">
                  <input
                    type="checkbox"
                    disabled={!r.editor}
                    checked={r.editor !== null && !unticked.has(r.projectId)}
                    onChange={(e) => {
                      setConfirming(false);
                      setUnticked((current) => {
                        const next = new Set(current);
                        if (e.target.checked) next.delete(r.projectId);
                        else next.add(r.projectId);
                        return next;
                      });
                    }}
                  />
                  <span className="font-mono">{r.name}</span>
                  <span className="text-sm text-fg-subtle">
                    {r.editor
                      ? editorLabel(r.editor)
                      : 'no editor set: choose one in Edit profile › General'}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {confirming ? (
            <p role="alert" data-open-all-confirm className="text-md text-st-permission">
              Open {windows} editor windows?
            </p>
          ) : (
            <p className="text-sm text-fg-subtle">
              {chosen.length === 0
                ? 'Nothing ticked.'
                : `${windows} window${windows === 1 ? '' : 's'}: repositories on VS Code or Cursor share one.`}
            </p>
          )}
          {error ? <p className="text-sm whitespace-pre-line text-st-error">✕ {error}</p> : null}
        </ModalBody>
        <ModalFooter>
          <button
            type="button"
            className={button('secondary')}
            onClick={confirming ? () => setConfirming(false) : onClose}
          >
            {confirming ? 'Back' : 'Cancel'}
          </button>
          <button
            type="submit"
            className={button('primary')}
            disabled={chosen.length === 0 || opening}
          >
            {confirming ? `Open ${windows} windows` : 'Open'}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
