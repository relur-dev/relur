import { PROFILE_COLORS, type ProfileColor, profileColorLabel } from '@shared/profile-colors';
import {
  type AccountChoice,
  type AccountFolder,
  colorChoices,
  newAccountFolder,
  profileIdFor,
} from '@shared/profiles';
import type { Profile } from '@shared/schemas';
import { DEFAULT_ACCOUNT_FOLDER, setupPassed } from '@shared/setup';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useTRPC } from '../trpc';
import { button, inputClass, Kbd, keyHint, labelClass } from '../ui/controls';
import { PROFILE_DOT, ProfileDot } from '../ui/profile-color';
import { Modal, ModalFooter } from './Modal';
import { SetupCheckPanel } from './SetupCheck';
import { TerminalShortcut } from './TerminalShortcut';

type Step = 'name' | 'account' | 'check' | 'done';
const STEPS: { id: Step; label: string }[] = [
  { id: 'name', label: 'Name & color' },
  { id: 'account', label: 'Claude account' },
  { id: 'check', label: 'Setup check' },
  { id: 'done', label: 'Done' },
];

const STATE_TEXT: Record<AccountFolder['state'], string> = {
  'signed-in': '✓ Signed in',
  'signed-out': 'Not signed in',
  'not-used': 'Not used yet',
  unknown: 'Not checked',
};

/**
 * The twelve swatches in one row, in palette order, scrolling sideways when
 * they don't fit (spec §3.1, components.md). A radio group: Tab reaches the
 * chosen color, the arrow keys move and choose, Home and End go to the first
 * and last. Colors other
 * profiles use are dimmed and say by whom, and can still be chosen.
 */
export function ColorPicker({
  value,
  onChange,
  others,
}: {
  value: ProfileColor;
  onChange: (color: ProfileColor) => void;
  others: Profile[];
}) {
  const buttons = useRef(new Map<ProfileColor, HTMLButtonElement>());
  const choose = (color: ProfileColor) => {
    onChange(color);
    buttons.current.get(color)?.focus();
  };
  const onKeyDown = (event: ReactKeyboardEvent) => {
    const at = PROFILE_COLORS.indexOf(value);
    const last = PROFILE_COLORS.length - 1;
    const to =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? Math.min(last, at + 1)
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? Math.max(0, at - 1)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    if (to === null) return;
    event.preventDefault();
    choose(PROFILE_COLORS[to] as ProfileColor);
  };
  return (
    <div
      role="radiogroup"
      aria-label="Color"
      data-color-grid
      onKeyDown={onKeyDown}
      className="-m-1 flex min-w-0 gap-1 overflow-x-auto p-1"
    >
      {PROFILE_COLORS.map((color) => {
        const users = others.filter((p) => p.color === color).map((p) => p.name);
        const label = profileColorLabel(color);
        const chosen = value === color;
        return (
          // biome-ignore lint/a11y/useSemanticElements: a row of swatches that moves focus with the choice
          <button
            key={color}
            ref={(el) => {
              if (el) buttons.current.set(color, el);
              else buttons.current.delete(color);
            }}
            type="button"
            role="radio"
            aria-checked={chosen}
            aria-label={label}
            title={users.length > 0 ? `${label} · used by ${users.join(', ')}` : label}
            data-color={color}
            data-used={users.length > 0 || undefined}
            tabIndex={chosen ? 0 : -1}
            onClick={() => choose(color)}
            className={`flex size-7 shrink-0 items-center justify-center rounded-full ${chosen ? 'ring-2 ring-fg ring-offset-2 ring-offset-raised' : ''} ${users.length > 0 ? 'opacity-75' : ''}`}
          >
            <span className={`size-5 rounded-full ${PROFILE_DOT[color]}`} />
          </button>
        );
      })}
    </div>
  );
}

function UsedBy({ ids, profiles }: { ids: string[]; profiles: Profile[] }) {
  return (
    <>
      {profiles
        .filter((p) => ids.includes(p.id))
        .map((p) => (
          <span
            key={p.id}
            className="inline-flex items-center gap-1 rounded-sm bg-raised px-1.5 text-xs text-fg-muted"
          >
            <ProfileDot color={p.color} size={6} />
            Used by {p.name}
          </span>
        ))}
    </>
  );
}

function AccountCard({
  checked,
  onSelect,
  title,
  folder,
  children,
}: {
  checked: boolean;
  onSelect: () => void;
  title: string;
  folder?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={`rounded-lg border p-3 ${checked ? 'border-fg-subtle bg-surface' : 'border-line'}`}
    >
      <label className="flex items-center gap-2 text-base">
        <input type="radio" name="account" checked={checked} onChange={onSelect} />
        <span className="font-medium">{title}</span>
        {folder ? <span className="font-mono text-sm text-fg-muted">{folder}</span> : null}
      </label>
      {children ? <div className="mt-2 flex flex-col gap-2 pl-6">{children}</div> : null}
    </div>
  );
}

/**
 * New profile (spec §6.11): name and color, the Claude account folder, the
 * setup check, then the optional terminal shortcut.
 */
export function NewProfileWizard({
  profiles,
  onClose,
  onOpen,
}: {
  profiles: Profile[];
  onClose: () => void;
  /** Open the created profile ("Open <name>"). */
  onOpen: (profile: Profile) => void;
}) {
  const trpc = useTRPC();
  const [first] = useState(profiles.length === 0);
  const [step, setStep] = useState<Step>('name');
  const [name, setName] = useState('');
  const [color, setColor] = useState<ProfileColor>(
    () => colorChoices(profiles.map((p) => p.color)).free[0] ?? 'blue',
  );
  const [kind, setKind] = useState<AccountChoice['kind']>('default');
  const [existing, setExisting] = useState<string | null>(null);
  const [picked, setPicked] = useState<AccountFolder[]>([]);
  const [created, setCreated] = useState<Profile | null>(null);

  const folders = useQuery(trpc.profiles.accountFolders.queryOptions());
  const pickFolder = useMutation(trpc.profiles.pickFolder.mutationOptions());
  const inspectFolder = useMutation(trpc.profiles.accountFolder.mutationOptions());
  const create = useMutation(trpc.profiles.create.mutationOptions());
  const setup = useQuery({
    ...trpc.setup.get.queryOptions({ profileId: created?.id ?? '' }),
    enabled: Boolean(created),
  });

  const id = profileIdFor(
    name.trim(),
    profiles.map((p) => p.id),
  );
  const listed = [
    ...(folders.data ?? []),
    ...picked.filter((p) => !folders.data?.some((f) => f.folder === p.folder)),
  ];
  const defaultFolder = listed.find((f) => f.folder === DEFAULT_ACCOUNT_FOLDER) ?? {
    folder: DEFAULT_ACCOUNT_FOLDER,
    state: 'not-used' as const,
    email: null,
    usedBy: profiles.filter((p) => !p.env.CLAUDE_CONFIG_DIR).map((p) => p.id),
  };
  const newFolder = newAccountFolder(id);
  const newFolderTaken = listed.some((f) => f.folder === newFolder);
  const chosen: AccountFolder | null =
    kind === 'default'
      ? defaultFolder
      : kind === 'existing'
        ? (listed.find((f) => f.folder === existing) ?? null)
        : null;
  const chosenFolder = kind === 'new' ? newFolder : (chosen?.folder ?? null);
  const shared = chosen ? profiles.filter((p) => chosen.usedBy.includes(p.id)) : [];

  const browse = async () => {
    try {
      const path = await pickFolder.mutateAsync();
      if (!path) return;
      const folder = await inspectFolder.mutateAsync({ folder: path });
      setPicked((current) => [...current.filter((f) => f.folder !== folder.folder), folder]);
      setKind('existing');
      setExisting(folder.folder);
    } catch {
      // Shown below from the mutation errors.
    }
  };
  useEffect(() => {
    if (step !== 'account') return;
    const listener = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyB') {
        e.preventDefault();
        void browse();
      }
    };
    window.addEventListener('keydown', listener, true);
    return () => window.removeEventListener('keydown', listener, true);
  });

  const account: AccountChoice | null =
    kind === 'default'
      ? { kind: 'default' }
      : kind === 'new'
        ? newFolderTaken
          ? null
          : { kind: 'new' }
        : existing
          ? { kind: 'existing', folder: existing }
          : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (step === 'name' && name.trim()) setStep('account');
    else if (step === 'account' && account) {
      create.mutate(
        { name: name.trim(), color, account },
        {
          onSuccess: (profile) => {
            setCreated(profile);
            setStep('check');
          },
        },
      );
    } else if (step === 'check' && setupPassed(setup.data)) setStep('done');
    else if (step === 'done' && created) onOpen(created);
  };

  const stepIndex = STEPS.findIndex((s) => s.id === step);
  const primary: Record<Step, { label: string; disabled: boolean }> = {
    name: { label: 'Next', disabled: !name.trim() },
    account: { label: 'Create profile', disabled: !account || create.isPending },
    check: { label: 'Continue', disabled: !setupPassed(setup.data) },
    done: { label: `Open ${created?.name ?? name}`, disabled: false },
  };
  const error = (create.error ?? pickFolder.error ?? inspectFolder.error)?.message;

  return (
    <Modal
      title={first ? 'Create your first profile' : 'New profile'}
      icon={<ProfileDot color={color} />}
      wide
      onClose={onClose}
    >
      <ol className="-mt-1 mb-4 flex gap-4 border-b border-line text-sm">
        {STEPS.map((s, index) => (
          <li
            key={s.id}
            aria-current={s.id === step ? 'step' : undefined}
            className={`-mb-px pb-2 ${s.id === step ? 'border-b-2 border-fg font-medium text-fg' : index < stepIndex ? 'text-fg-muted' : 'text-fg-subtle'}`}
          >
            {index < stepIndex ? '✓ ' : ''}
            {s.label}
          </li>
        ))}
      </ol>
      <form onSubmit={submit}>
        <div className="max-h-[calc(100vh-290px)] overflow-y-auto pr-1">
          {step === 'name' ? (
            <div className="flex flex-col gap-4">
              <div>
                <label className={labelClass} htmlFor="profile-name">
                  Name
                </label>
                <input
                  id="profile-name"
                  className={inputClass}
                  value={name}
                  placeholder="Personal"
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div>
                <span className={labelClass}>Color</span>
                <ColorPicker value={color} onChange={setColor} others={profiles} />
                <p className="mt-1.5 text-sm text-fg-subtle">
                  You can change the color later in Edit profile.
                </p>
              </div>
              <div
                aria-hidden
                className="flex items-end gap-0.5 overflow-x-auto rounded-md border border-line bg-chrome px-2 pt-2"
              >
                {profiles.map((p) => (
                  <span
                    key={p.id}
                    className="flex h-7 shrink-0 items-center gap-2 whitespace-nowrap px-3 text-sm text-fg-muted"
                  >
                    <ProfileDot color={p.color} />
                    {p.name}
                  </span>
                ))}
                <span className="flex h-7.5 shrink-0 items-center gap-2 whitespace-nowrap rounded-t-lg border border-b-0 border-line bg-canvas px-3 text-sm font-medium">
                  <ProfileDot color={color} />
                  {name.trim() || 'New profile'}
                </span>
              </div>
            </div>
          ) : null}

          {step === 'account' ? (
            <div role="radiogroup" aria-label="Claude account" className="flex flex-col gap-2">
              <AccountCard
                checked={kind === 'default'}
                onSelect={() => setKind('default')}
                title="Use my default Claude login"
                folder={DEFAULT_ACCOUNT_FOLDER}
              >
                <p className="text-sm text-fg-muted">
                  The folder Claude Code uses when CLAUDE_CONFIG_DIR is not set.
                </p>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-fg-muted">{STATE_TEXT[defaultFolder.state]}</span>
                  {defaultFolder.email ? (
                    <span className="font-mono text-fg-muted">{defaultFolder.email}</span>
                  ) : null}
                  <UsedBy ids={defaultFolder.usedBy} profiles={profiles} />
                </div>
              </AccountCard>
              <AccountCard
                checked={kind === 'existing'}
                onSelect={() => setKind('existing')}
                title="Use an existing login"
              >
                {kind === 'existing' ? (
                  <>
                    <p className="text-sm text-fg-muted">
                      Pick a Claude config folder found in your home folder.
                    </p>
                    <ul
                      data-account-folders
                      className="flex flex-col overflow-hidden rounded-md border border-line"
                    >
                      {folders.isPending ? (
                        <li className="px-3 py-2 text-sm text-fg-subtle">Looking for folders…</li>
                      ) : null}
                      {listed.map((f) => (
                        <li key={f.folder} className="border-line not-first:border-t">
                          <label className="flex min-h-8 items-center gap-2 px-3 py-1.5 text-sm">
                            <input
                              type="radio"
                              name="existing-folder"
                              checked={existing === f.folder}
                              onChange={() => setExisting(f.folder)}
                            />
                            <span className="font-mono">{f.folder}</span>
                            <span
                              data-folder-state={f.state}
                              className={
                                f.state === 'signed-in' ? 'text-diff-add' : 'text-fg-muted'
                              }
                            >
                              {STATE_TEXT[f.state]}
                            </span>
                            {f.email ? (
                              <span className="truncate font-mono text-fg-muted">{f.email}</span>
                            ) : null}
                            <span className="ml-auto flex gap-1">
                              <UsedBy ids={f.usedBy} profiles={profiles} />
                            </span>
                          </label>
                        </li>
                      ))}
                      <li className="border-t border-line">
                        <button
                          type="button"
                          className="flex h-8 w-full items-center gap-2 px-3 text-left text-sm text-fg-muted hover:bg-raised hover:text-fg"
                          onClick={() => void browse()}
                        >
                          Choose another folder… <Kbd>{keyHint('browse')}</Kbd>
                        </button>
                      </li>
                    </ul>
                  </>
                ) : null}
              </AccountCard>
              <AccountCard
                checked={kind === 'new'}
                onSelect={() => setKind('new')}
                title="Sign in to a new account"
                folder={newFolder}
              >
                <p className="text-sm text-fg-muted">
                  Creates a new folder for a separate login. You sign in during the setup check.
                </p>
                {kind === 'new' && newFolderTaken ? (
                  <p className="text-sm text-st-error">
                    {newFolder} already exists. Choose it under "Use an existing login".
                  </p>
                ) : null}
              </AccountCard>
              {shared.length > 0 ? (
                <div className="rounded-md border border-st-permission/40 bg-st-permission/10 px-3 py-2 text-sm">
                  <p className="font-medium">
                    {chosenFolder} is used by {shared.map((p) => p.name).join(' and ')}
                  </p>
                  <p className="mt-0.5 text-fg-muted">
                    Both profiles share one login, settings, history and plan usage. Signing out in
                    one signs out both.
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}

          {step === 'check' && created ? <SetupCheckPanel profile={created} header={null} /> : null}

          {step === 'done' && created ? (
            <div className="flex flex-col gap-4">
              <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 text-md">
                <dt className="text-fg-muted">Profile</dt>
                <dd className="flex items-center gap-2">
                  <ProfileDot color={created.color} />
                  {created.name}
                </dd>
                <dt className="text-fg-muted">Account</dt>
                <dd>
                  {setup.data?.signedIn.state === 'passed'
                    ? (setup.data.signedIn.value.email ?? 'Signed in')
                    : 'Not signed in yet'}
                </dd>
                <dt className="text-fg-muted">Folder</dt>
                <dd className="font-mono">{setup.data?.folder ?? chosenFolder}</dd>
              </dl>
              {created ? <TerminalShortcut profileId={created.id} /> : null}
            </div>
          ) : null}
        </div>

        {error ? <p className="mt-3 text-md text-st-error">{error}</p> : null}
        <ModalFooter>
          {step === 'account' ? (
            <button
              type="button"
              className={`${button('ghost')} mr-auto`}
              onClick={() => setStep('name')}
            >
              Back
            </button>
          ) : null}
          {step === 'check' ? (
            <button type="button" className={button('ghost')} onClick={() => setStep('done')}>
              Finish later
            </button>
          ) : (
            <button type="button" className={button('ghost')} onClick={onClose}>
              {created ? 'Close' : 'Cancel'}
            </button>
          )}
          <button type="submit" className={button('primary')} disabled={primary[step].disabled}>
            {primary[step].label} <Kbd onFg>{keyHint('confirm')}</Kbd>
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
