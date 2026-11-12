import { repoNameFromUrl, repoNameProblem } from '@shared/new-repository';
import { projectSlug, projectWorktreeDir } from '@shared/projects';
import type { Profile, Project } from '@shared/schemas';
import { matchShortcut } from '@shared/shortcuts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { GuideLink } from '../guide/link';
import { type AppRouterOutputs, useTRPC } from '../trpc';
import { button, inputClass, isMac, Kbd, keyHint, labelClass } from '../ui/controls';
import { remember } from '../ui/remember';
import { StatusGlyph } from '../ui/StatusGlyph';
import {
  type AddManyResult,
  FolderImportList,
  FolderImportResults,
  useFolderRows,
} from './FolderImport';
import { Modal, ModalBody, ModalFooter, modalForm } from './Modal';
import { TerminalView } from './TerminalView';

type Candidate = AppRouterOutputs['projects']['inspect'];

const BASE_BRANCH_SOURCE: Record<Candidate['baseBranchSource'], string> = {
  'remote-head': 'from the remote default branch',
  'current-branch': 'the currently checked-out branch',
  'profile-default': "the profile default; the remote's default branch is not known locally",
};

type Mode = 'existing' | 'new' | 'clone';

const MODES: [Mode, string][] = [
  ['existing', 'Existing folder'],
  ['new', 'New repository'],
  ['clone', 'Clone from URL'],
];

const detailRow = 'grid grid-cols-[104px_1fr] items-center gap-3';
const detailInput = `${inputClass} h-6.5 font-mono text-sm`;

interface FormProps {
  profile: Profile;
  onClose: () => void;
  onAdded: (project: Project) => void;
}

/**
 * Add project (spec §6.1): an existing folder, a new repository, or a clone,
 * chosen with a segmented control at the top.
 */
export function AddProjectDialog({
  profile,
  projects,
  onClose,
  onAdded,
}: FormProps & {
  /** The profile's projects: the newest one's parent folder is the first default parent. */
  projects: Project[];
}) {
  const [mode, setMode] = useState<Mode>('existing');
  const form =
    mode === 'existing' ? (
      <ExistingFolderForm profile={profile} onClose={onClose} onAdded={onAdded} />
    ) : mode === 'new' ? (
      <NewRepositoryForm
        profile={profile}
        projects={projects}
        onClose={onClose}
        onAdded={onAdded}
      />
    ) : (
      <CloneForm profile={profile} projects={projects} onClose={onClose} onAdded={onAdded} />
    );
  return (
    <Modal
      title="Add project"
      description={
        <>
          Adds a git repository to <span className="font-medium text-fg">{profile.name}</span>.
        </>
      }
      onClose={onClose}
    >
      <ModeSwitch mode={mode} onChange={setMode} />
      {form}
    </Modal>
  );
}

/**
 * Existing folder, New repository, Clone from URL (components.md, segmented
 * control): radio inputs, so ←→ move and the selection follows focus.
 */
function ModeSwitch({ mode, onChange }: { mode: Mode; onChange: (mode: Mode) => void }) {
  return (
    <fieldset
      aria-label="Add from"
      data-add-mode={mode}
      className="mb-4 flex rounded-lg border border-line bg-surface p-0.5 text-md"
    >
      {MODES.map(([value, label]) => (
        <label
          key={value}
          className={`flex h-7 flex-1 cursor-default items-center justify-center rounded-md px-2 has-focus-visible:outline-2 has-focus-visible:outline-focus ${
            mode === value
              ? 'bg-raised font-medium text-fg ring-1 ring-line-strong'
              : 'text-fg-muted hover:text-fg'
          }`}
        >
          <input
            type="radio"
            name="add-mode"
            value={value}
            className="sr-only"
            checked={mode === value}
            onChange={() => onChange(value)}
          />
          {label}
        </label>
      ))}
    </fieldset>
  );
}

/**
 * Existing folder (spec §6.1): pick or type a folder, review what was
 * detected, confirm. A folder that isn't a repository offers the repositories
 * in it.
 */
function ExistingFolderForm({ profile, onClose, onAdded }: FormProps) {
  const trpc = useTRPC();
  const [folder, setFolder] = useState('');
  // Edits of the detected values; null means "use what was detected".
  const [nameEdit, setName] = useState<string | null>(null);
  const [remoteEdit, setRemote] = useState<string | null>(null);
  const [baseBranchEdit, setBaseBranch] = useState<string | null>(null);
  const inspectedFolder = useRef<string | null>(null);
  // The project's own worktree folder (§8.1); null keeps the default.
  const [worktreeRoot, setWorktreeRoot] = useState<string | null>(null);

  const pickFolder = useMutation(trpc.projects.pickFolder.mutationOptions());
  const inspect = useMutation(trpc.projects.examine.mutationOptions());
  const add = useMutation(trpc.projects.add.mutationOptions({ onSuccess: onAdded }));
  const addMany = useMutation(trpc.projects.addMany.mutationOptions());
  const [results, setResults] = useState<AddManyResult[] | null>(null);
  const check = (path: string) => {
    const trimmed = path.trim();
    if (!trimmed || trimmed === inspectedFolder.current) return;
    inspectedFolder.current = trimmed;
    setName(null);
    setRemote(null);
    setBaseBranch(null);
    add.reset();
    addMany.reset();
    setResults(null);
    inspect.mutate({ folder: trimmed, profileId: profile.id });
  };

  const browse = async () => {
    try {
      const picked = await pickFolder.mutateAsync();
      if (picked) {
        setFolder(picked);
        check(picked);
      }
    } catch {
      // Shown below from pickFolder.error.
    }
  };

  // Detection runs 250 ms after typing stops (components.md, Path field).
  const checkRef = useRef(check);
  checkRef.current = check;
  useEffect(() => {
    const timer = setTimeout(() => checkRef.current(folder), 250);
    return () => clearTimeout(timer);
  }, [folder]);

  // Details belong to the folder in the field only while it hasn't been edited.
  const examined = inspect.data && inspectedFolder.current === folder.trim() ? inspect.data : null;
  const candidate = examined?.kind === 'repository' ? examined.candidate : null;
  const scan = examined?.kind === 'folder' ? examined : null;
  const folderRows = useFolderRows(scan?.repositories ?? null, profile);
  const chosen = folderRows.rows.filter((r) => r.candidate && folderRows.selected.has(r.repoPath));
  const name = nameEdit ?? candidate?.name ?? '';
  const remote = remoteEdit ?? candidate?.remote ?? null;
  const baseBranch = baseBranchEdit ?? candidate?.baseBranch ?? '';

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (results) {
      onClose();
      return;
    }
    if (scan) {
      if (chosen.length === 0) return;
      addMany.mutate(
        {
          profileId: profile.id,
          items: chosen.map(({ candidate: c }) => ({
            repoPath: c?.repoPath ?? '',
            name: c?.name ?? '',
            remote: c?.remote ?? null,
            baseBranch: c?.baseBranch ?? '',
          })),
          worktreeRoot,
        },
        { onSuccess: setResults },
      );
      return;
    }
    if (!candidate || candidate.conflict) return;
    add.mutate({
      profileId: profile.id,
      repoPath: candidate.repoPath,
      name,
      remote,
      baseBranch,
      worktreeRoot,
    });
  };

  const error =
    pickFolder.error ?? (inspect.isPending ? null : inspect.error) ?? add.error ?? addMany.error;

  // Where the worktrees go (§8.1); for a folder of repositories, for all of them.
  const worktreeChoice = (
    <WorktreeChoice
      profile={profile}
      name={scan ? '<project>' : name}
      value={worktreeRoot}
      onChange={setWorktreeRoot}
      onClose={onClose}
    />
  );

  return (
    <form onSubmit={submit} className={`${modalForm} text-md`}>
      <ModalBody>
        <label htmlFor="add-project-folder" className={labelClass}>
          Repository path
        </label>
        <div className="flex gap-2">
          <input
            id="add-project-folder"
            className={`${inputClass} font-mono text-sm`}
            placeholder="~/code/my-repository"
            spellCheck={false}
            value={folder}
            aria-invalid={Boolean(inspect.error) || undefined}
            onChange={(e) => setFolder(e.target.value)}
            onBlur={() => check(folder)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !candidate) {
                e.preventDefault();
                check(folder);
              }
              if (matchShortcut('browse', e.nativeEvent, isMac) !== -1) {
                e.preventDefault();
                void browse();
              }
            }}
          />
          <button
            type="button"
            className={button('secondary', 'lg')}
            disabled={pickFolder.isPending}
            onClick={() => void browse()}
          >
            Browse… <Kbd>{keyHint('browse')}</Kbd>
          </button>
        </div>
        {inspect.isPending ? <p className="mt-1.5 text-sm text-fg-subtle">Checking…</p> : null}

        {candidate?.conflict ? (
          <p role="alert" className="mt-2 text-sm text-st-error">
            ✕ This repository is already registered under the {candidate.conflict.profileName}{' '}
            profile. A repository can belong to only one profile.
          </p>
        ) : null}

        {candidate && !candidate.conflict ? (
          <div className="mt-3 space-y-2 rounded-lg border border-line bg-surface p-3 text-sm">
            <div className={detailRow}>
              <span className="text-fg-muted">Detected</span>
              <span>
                <span className="text-diff-add">✓</span> Git repository
              </span>
            </div>
            {candidate.repoPath !== folder.trim() ? (
              <div className={detailRow}>
                <span className="text-fg-muted">Main checkout</span>
                <span className="truncate font-mono select-text">{candidate.repoPath}</span>
              </div>
            ) : null}
            <label className={detailRow}>
              <span className="text-fg-muted">Name</span>
              <input
                className={detailInput}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <div className={detailRow}>
              <span className="text-fg-muted">Base branch</span>
              <div>
                <input
                  aria-label="Base branch"
                  className={detailInput}
                  value={baseBranch}
                  onChange={(e) => setBaseBranch(e.target.value)}
                />
                {baseBranch === candidate.baseBranch ? (
                  <span className="mt-0.5 block text-xs text-fg-subtle">
                    {BASE_BRANCH_SOURCE[candidate.baseBranchSource]}
                  </span>
                ) : null}
              </div>
            </div>
            <div className={detailRow}>
              <span className="text-fg-muted">Remote</span>
              {candidate.remotes.length > 0 ? (
                <select
                  aria-label="Remote"
                  className={detailInput}
                  value={remote ?? ''}
                  onChange={(e) => setRemote(e.target.value)}
                >
                  {candidate.remotes.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-fg-muted">None: workspaces branch from local branches</span>
              )}
            </div>
            {worktreeChoice}
          </div>
        ) : null}

        {scan && !results ? (
          <>
            <FolderImportList profile={profile} skipped={scan.skipped} {...folderRows} />
            <div className="mt-3 rounded-lg border border-line bg-surface p-3 text-sm">
              {worktreeChoice}
            </div>
          </>
        ) : null}
        {results ? <FolderImportResults results={results} /> : null}

        {error ? (
          <p role="alert" className="mt-2 text-sm text-st-error select-text">
            ✕ {error.message}
          </p>
        ) : null}
      </ModalBody>
      <ModalFooter>
        <button type="button" className={button('ghost', 'lg')} onClick={onClose}>
          Cancel <Kbd>Esc</Kbd>
        </button>
        {results ? (
          <button type="submit" className={button('primary', 'lg')}>
            Done <Kbd onFg>{keyHint('confirm')}</Kbd>
          </button>
        ) : scan ? (
          <button
            type="submit"
            className={button('primary', 'lg')}
            disabled={chosen.length === 0 || addMany.isPending}
          >
            Add {chosen.length} {chosen.length === 1 ? 'project' : 'projects'}{' '}
            <Kbd onFg>{keyHint('confirm')}</Kbd>
          </button>
        ) : (
          <button
            type="submit"
            className={button('primary', 'lg')}
            disabled={
              !candidate ||
              candidate.conflict !== null ||
              add.isPending ||
              !name.trim() ||
              !baseBranch.trim()
            }
          >
            Add project <Kbd onFg>{keyHint('confirm')}</Kbd>
          </button>
        )}
      </ModalFooter>
    </form>
  );
}

/** Where the project's worktrees go (§8.1): Default or Choose folder…. */
function WorktreeChoice({
  profile,
  name,
  value,
  onChange,
  onClose,
}: {
  profile: Profile;
  /** The project's name, or `<project>` for several. */
  name: string;
  value: string | null;
  onChange: (folder: string | null) => void;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const pick = useMutation(trpc.projects.pickWorktreeFolder.mutationOptions());
  const choose = async () => {
    try {
      const picked = await pick.mutateAsync();
      if (picked) onChange(picked);
    } catch {
      // Shown below from pick.error.
    }
  };
  const id = name === '<project>' ? name : projectSlug(name);
  return (
    <div className={`${detailRow} items-start`}>
      <span className="flex items-center gap-1.5 pt-0.5 text-fg-muted">
        Worktrees{' '}
        <GuideLink to="worktrees#a-folder-you-choose" label="Where worktrees go" before={onClose} />
      </span>
      <fieldset aria-label="Worktrees" className="min-w-0 space-y-1">
        <label className="flex min-w-0 items-center gap-2">
          <input
            type="radio"
            name="worktrees"
            checked={value === null}
            onChange={() => onChange(null)}
          />
          Default{' '}
          <span className="truncate font-mono text-fg-muted">
            {projectWorktreeDir(profile, { id })}
          </span>
        </label>
        <label className="flex min-w-0 items-center gap-2">
          <input
            type="radio"
            name="worktrees"
            checked={value !== null}
            onChange={() => void choose()}
          />
          {value ? (
            <span data-worktree-root className="truncate font-mono">
              {projectWorktreeDir(profile, { id, worktreeRoot: value })}
            </span>
          ) : (
            'Choose folder…'
          )}
          {value ? (
            <button type="button" className={button('ghost', 'sm')} onClick={() => void choose()}>
              Change…
            </button>
          ) : null}
        </label>
        {pick.error ? <p className="text-sm text-st-error">✕ {pick.error.message}</p> : null}
      </fieldset>
    </div>
  );
}

const parentKey = (profileId: string) => `addProject.parent.${profileId}`;

/**
 * The parent folder a new repository or clone starts in (spec §6.1): the last
 * one used in this profile, else the folder holding its newest project, else ~.
 */
function initialParent(profileId: string, projects: Project[]): string {
  try {
    const remembered = localStorage.getItem(parentKey(profileId));
    if (remembered) return remembered;
  } catch {
    // No local storage: the defaults below.
  }
  const newest = projects.at(-1)?.repoPath;
  const cut = newest?.replace(/\/+$/, '').lastIndexOf('/') ?? -1;
  return newest && cut > 0 ? newest.slice(0, cut) : '~';
}

/**
 * Parent folder and name of a new repository or clone, checked 250 ms after
 * typing stops (spec §6.1): the name, an existing parent, a target that
 * doesn't exist or is empty; a parent inside another repository only warns.
 */
function useNewFolder(profile: Profile, projects: Project[], name: string) {
  const trpc = useTRPC();
  const [parent, setParent] = useState(() => initialParent(profile.id, projects));
  const check = useMutation(trpc.projects.checkNewFolder.mutationOptions());
  const pick = useMutation(trpc.projects.pickParentFolder.mutationOptions());
  const asked = useRef('');
  const key = `${parent.trim()}\n${name}`;
  const checkRef = useRef(check.mutate);
  checkRef.current = check.mutate;
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!parent.trim() || repoNameProblem(name)) return;
      asked.current = key;
      checkRef.current({ profileId: profile.id, parent: parent.trim(), name });
    }, 250);
    return () => clearTimeout(timer);
  }, [key, parent, name, profile.id]);
  const browse = async () => {
    try {
      const picked = await pick.mutateAsync();
      if (picked) setParent(picked);
    } catch {
      // Shown from pick.error.
    }
  };
  const current = asked.current === key && !check.isPending;
  const result = current ? (check.data ?? null) : null;
  const nameProblem = name ? repoNameProblem(name) : null;
  const problem =
    nameProblem ??
    (!parent.trim() ? 'Enter a parent folder' : null) ??
    (current ? (check.error?.message ?? result?.problem ?? null) : null);
  return {
    parent,
    setParent,
    browse,
    browseError: pick.error?.message ?? null,
    browsing: pick.isPending,
    /** `<parent>/<name>` once checked and usable. */
    target: result && !result.problem ? result.target : null,
    problem,
    insideRepository: result?.insideRepository ?? null,
    /** The parent folder used, remembered for next time. */
    remember: () => remember(parentKey(profile.id), parent.trim()),
  };
}

function ParentFolderField({
  folder,
  id,
}: {
  folder: ReturnType<typeof useNewFolder>;
  id: string;
}) {
  return (
    <>
      <label htmlFor={id} className={`${labelClass} mt-3`}>
        Parent folder
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          className={`${inputClass} font-mono text-sm`}
          spellCheck={false}
          value={folder.parent}
          onChange={(e) => folder.setParent(e.target.value)}
          onKeyDown={(e) => {
            if (matchShortcut('browse', e.nativeEvent, isMac) !== -1) {
              e.preventDefault();
              void folder.browse();
            }
          }}
        />
        <button
          type="button"
          className={button('secondary', 'lg')}
          disabled={folder.browsing}
          onClick={() => void folder.browse()}
        >
          Browse… <Kbd>{keyHint('browse')}</Kbd>
        </button>
      </div>
    </>
  );
}

/** What the folder check found: where it goes, why not, or a repository around it. */
function FolderNotes({ folder }: { folder: ReturnType<typeof useNewFolder> }) {
  return (
    <>
      {folder.target ? (
        <p data-new-target className="mt-1.5 truncate text-sm text-fg-subtle">
          Creates <span className="font-mono select-text">{folder.target}</span>
        </p>
      ) : null}
      {folder.problem ? (
        <p role="alert" data-folder-problem className="mt-1.5 text-sm text-st-error">
          ✕ {folder.problem}
        </p>
      ) : null}
      {folder.insideRepository ? (
        <p data-inside-repository className="mt-1.5 text-sm text-st-permission">
          ⚠ The parent folder is inside the repository{' '}
          <span className="font-mono">{folder.insideRepository}</span>. The new one will be a
          separate repository nested in it.
        </p>
      ) : null}
      {folder.browseError ? (
        <p className="mt-1.5 text-sm text-st-error">✕ {folder.browseError}</p>
      ) : null}
    </>
  );
}

/**
 * New repository (spec §6.1): a folder under the parent, `git init` on the
 * profile's base branch, a first commit with the profile's identity (a
 * README and .gitignore, or empty), then added without a remote.
 */
function NewRepositoryForm({
  profile,
  projects,
  onClose,
  onAdded,
}: FormProps & { projects: Project[] }) {
  const trpc = useTRPC();
  const [name, setName] = useState('');
  const [readme, setReadme] = useState(true);
  const [gitignore, setGitignore] = useState(true);
  const [worktreeRoot, setWorktreeRoot] = useState<string | null>(null);
  const folder = useNewFolder(profile, projects, name);
  const create = useMutation(
    trpc.projects.create.mutationOptions({
      onSuccess: (project) => {
        folder.remember();
        onAdded(project);
      },
    }),
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!folder.target || create.isPending) return;
    create.mutate({
      profileId: profile.id,
      parent: folder.parent.trim(),
      name,
      readme,
      gitignore,
      worktreeRoot,
    });
  };
  const identity = profile.git ? `${profile.git.commitName} <${profile.git.commitEmail}>` : null;
  return (
    <form onSubmit={submit} className={`${modalForm} text-md`}>
      <ModalBody>
        <label htmlFor="new-repository-name" className={labelClass}>
          Name
        </label>
        <input
          id="new-repository-name"
          data-autofocus
          className={`${inputClass} font-mono text-sm`}
          placeholder="my-repository"
          spellCheck={false}
          value={name}
          aria-invalid={Boolean(name && folder.problem) || undefined}
          onChange={(e) => setName(e.target.value)}
        />
        <ParentFolderField folder={folder} id="new-repository-parent" />
        <FolderNotes folder={name ? folder : { ...folder, problem: null }} />

        <div className="mt-3 space-y-2 rounded-lg border border-line bg-surface p-3 text-sm">
          <div className={`${detailRow} items-start`}>
            <span className="pt-0.5 text-fg-muted">First commit</span>
            <div className="space-y-1">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={readme}
                  onChange={(e) => setReadme(e.target.checked)}
                />
                <span>
                  A <span className="font-mono">README.md</span> with the name as its heading
                </span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={gitignore}
                  onChange={(e) => setGitignore(e.target.checked)}
                />
                <span>
                  A <span className="font-mono">.gitignore</span>
                </span>
              </label>
              {!readme && !gitignore ? (
                <span className="block text-xs text-fg-subtle">An empty commit</span>
              ) : null}
            </div>
          </div>
          <div className={detailRow}>
            <span className="text-fg-muted">Base branch</span>
            <span className="font-mono">{profile.defaults.baseBranch}</span>
          </div>
          <div className={detailRow}>
            <span className="text-fg-muted">Committed as</span>
            <span className="truncate">
              {identity ? (
                <span className="font-mono">{identity}</span>
              ) : (
                <span className="text-fg-muted">your git config's user.name and user.email</span>
              )}
            </span>
          </div>
          <div className={detailRow}>
            <span className="text-fg-muted">Remote</span>
            <span className="text-fg-muted">None: Push and Create PR need one added later</span>
          </div>
          <WorktreeChoice
            profile={profile}
            name={name || 'project'}
            value={worktreeRoot}
            onChange={setWorktreeRoot}
            onClose={onClose}
          />
        </div>

        {create.error ? (
          <p role="alert" className="mt-2 text-sm text-st-error select-text">
            ✕ {create.error.message}
          </p>
        ) : null}
      </ModalBody>
      <ModalFooter>
        <button type="button" className={button('ghost', 'lg')} onClick={onClose}>
          Cancel <Kbd>Esc</Kbd>
        </button>
        <button
          type="submit"
          className={button('primary', 'lg')}
          disabled={!folder.target || create.isPending}
        >
          {create.isPending ? 'Creating…' : 'Create repository'}{' '}
          <Kbd onFg>{keyHint('confirm')}</Kbd>
        </button>
      </ModalFooter>
    </form>
  );
}

/**
 * Clone from URL (spec §6.1): `git clone` in a terminal in the dialog, with
 * the profile's environment, so prompts work; added once it exits with 0
 * (base branch: the remote's default). A failed clone adds nothing.
 */
function CloneForm({ profile, projects, onClose, onAdded }: FormProps & { projects: Project[] }) {
  const trpc = useTRPC();
  const [url, setUrl] = useState('');
  const [nameEdit, setName] = useState<string | null>(null);
  const [worktreeRoot, setWorktreeRoot] = useState<string | null>(null);
  const name = nameEdit ?? repoNameFromUrl(url);
  const folder = useNewFolder(profile, projects, name);
  const clone = useMutation(trpc.projects.clone.mutationOptions());
  const addClone = useMutation(
    trpc.projects.addClone.mutationOptions({
      onSuccess: (project) => {
        folder.remember();
        onAdded(project);
      },
    }),
  );
  const closeSession = useMutation(trpc.sessions.close.mutationOptions());
  const sessions = useQuery(trpc.sessions.list.queryOptions());
  const started = clone.data ?? null;
  const session = started ? sessions.data?.find((s) => s.id === started.session.id) : undefined;
  const running = clone.isPending || (started !== null && session?.status !== 'exited');
  const failed = session?.status === 'exited' && session.exitCode !== 0;

  // Added once git exits with 0, once per clone.
  const addedFor = useRef<string | null>(null);
  const addRef = useRef(addClone.mutate);
  addRef.current = addClone.mutate;
  useEffect(() => {
    if (!started || session?.status !== 'exited' || session.exitCode !== 0) return;
    if (addedFor.current === started.session.id) return;
    addedFor.current = started.session.id;
    addRef.current({ profileId: profile.id, path: started.target, worktreeRoot });
  }, [started, session, profile.id, worktreeRoot]);

  // The dialog's clone terminals go with it; one still running is stopped.
  const startedId = started?.session.id ?? null;
  const sessionIds = useRef(new Set<string>());
  if (startedId) sessionIds.current.add(startedId);
  const stopRef = useRef(closeSession.mutate);
  stopRef.current = closeSession.mutate;
  useEffect(
    () => () => {
      for (const sessionId of sessionIds.current) stopRef.current({ sessionId });
      sessionIds.current.clear();
    },
    [],
  );

  // The terminal has the focus while git runs (for prompts); after a failure
  // it goes back to the URL, so Esc cancels and the URL can be fixed, also
  // when git failed before the terminal connected.
  const urlRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (failed) urlRef.current?.focus();
  }, [failed]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!url.trim() || !folder.target || running || addClone.isPending) return;
    addClone.reset();
    clone.mutate({ profileId: profile.id, url: url.trim(), parent: folder.parent.trim(), name });
  };

  const locked = running || addClone.isPending;
  const error =
    clone.error?.message ??
    addClone.error?.message ??
    (failed
      ? `git clone failed (exit ${session.exitCode ?? session.signal ?? '?'}); nothing was added`
      : null);
  return (
    <form onSubmit={submit} className={`${modalForm} text-md`}>
      <ModalBody>
        <fieldset disabled={locked} className="min-w-0">
          <label htmlFor="clone-url" className={labelClass}>
            Repository URL
          </label>
          <input
            id="clone-url"
            ref={urlRef}
            data-autofocus
            className={`${inputClass} font-mono text-sm`}
            placeholder="git@host:team/repository.git"
            spellCheck={false}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <ParentFolderField folder={folder} id="clone-parent" />
          <label htmlFor="clone-name" className={`${labelClass} mt-3`}>
            Folder name
          </label>
          <input
            id="clone-name"
            className={`${inputClass} font-mono text-sm`}
            spellCheck={false}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <FolderNotes folder={name ? folder : { ...folder, problem: null }} />
          <div className="mt-3 rounded-lg border border-line bg-surface p-3 text-sm">
            <WorktreeChoice
              profile={profile}
              name={name || 'project'}
              value={worktreeRoot}
              onChange={setWorktreeRoot}
              onClose={onClose}
            />
          </div>
        </fieldset>

        {started && session ? (
          <div className="mt-3 overflow-hidden rounded-md border border-line bg-term">
            <div className="flex h-7 items-center gap-2 border-b border-line px-2.5 text-sm">
              <span className="font-mono text-fg-muted">$ git clone</span>
              <span className="ml-auto flex items-center gap-1.5 text-xs">
                {session.status === 'running' ? (
                  <>
                    <StatusGlyph glyph="working" />
                    <span className="text-fg-subtle">running</span>
                  </>
                ) : (
                  <span
                    data-exit-code={session.exitCode ?? ''}
                    className={session.exitCode === 0 ? 'text-diff-add' : 'text-st-error'}
                  >
                    exited · code {session.exitCode ?? session.signal ?? '?'}
                  </span>
                )}
              </span>
            </div>
            <div className="h-[180px]">
              <TerminalView sessionId={session.id} focusOnConnect={!failed} />
            </div>
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="mt-2 text-sm text-st-error select-text">
            ✕ {error}
          </p>
        ) : null}
      </ModalBody>
      <ModalFooter>
        <button type="button" className={button('ghost', 'lg')} onClick={onClose}>
          Cancel <Kbd>Esc</Kbd>
        </button>
        <button
          type="submit"
          className={button('primary', 'lg')}
          disabled={!url.trim() || !folder.target || locked}
        >
          {running ? 'Cloning…' : addClone.isPending ? 'Adding…' : failed ? 'Try again' : 'Clone'}{' '}
          <Kbd onFg>{keyHint('confirm')}</Kbd>
        </button>
      </ModalFooter>
    </form>
  );
}
