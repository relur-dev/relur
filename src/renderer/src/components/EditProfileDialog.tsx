import { BRAND } from '@shared/brand';
import type { ProfileColor } from '@shared/profile-colors';
import type { Profile } from '@shared/schemas';
import { accountFolder, setupPassed, setupWarning } from '@shared/setup';
import { SOUND_EVENTS } from '@shared/status';
import {
  SUSPEND_CHOICES,
  type SuspendChoice,
  type SuspendSetting,
  suspendDelay,
} from '@shared/suspend';
import { resumePrompt } from '@shared/unfinished';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { GuideLink } from '../guide/link';
import { trpcClient, useTRPC } from '../trpc';
import { button, inputClass, Kbd, keyHint, labelClass } from '../ui/controls';
import { ProfileDot } from '../ui/profile-color';
import { playAlert } from '../ui/sounds';
import { draftOf, type EditorDraft, EditorPicker, editorOfDraft } from './EditorPicker';
import { Modal, ModalBody, ModalFooter, modalForm } from './Modal';
import { ColorPicker } from './NewProfileWizard';
import { SkillSourcesEditor } from './SkillSources';
import { ProfileLookupEditor } from './TaskLookupEditor';
import { TerminalShortcut } from './TerminalShortcut';
import { ProfileWorkflowEditor } from './WorkflowViews';

type EditTab = 'general' | 'skills' | 'workflow' | 'lookup';
const TABS: { id: EditTab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'skills', label: 'Skills' },
  { id: 'workflow', label: 'Workflow' },
  { id: 'lookup', label: 'Task lookup' },
];

/**
 * Edit profile (spec §6.11): General has name and color, the read-only
 * account folder and Remove (only while the profile has no projects); Skills
 * has the profile's skill sources (§13.2), Workflow its workflow (§13.4) and
 * Task lookup how New workspace finds a task's title (§13.7).
 */
export function EditProfileDialog({
  profile,
  profiles,
  onClose,
  onCheckSetup,
  initialTab = 'general',
}: {
  profile: Profile;
  profiles: Profile[];
  onClose: () => void;
  onCheckSetup: () => void;
  initialTab?: EditTab;
}) {
  const trpc = useTRPC();
  const [tab, setTab] = useState<EditTab>(initialTab);
  const config = useQuery(trpc.config.get.queryOptions());
  const projects = (config.data?.config?.projects ?? []).filter((p) => p.profileId === profile.id);
  const allWorkspaces = useQuery(trpc.workspaces.list.queryOptions());
  const workspaces = (allWorkspaces.data ?? []).filter((w) => w.profileId === profile.id);
  const [name, setName] = useState(profile.name);
  const [color, setColor] = useState<ProfileColor>(profile.color);
  const [sounds, setSounds] = useState(profile.alerts.sounds);
  const [doNotDisturb, setDoNotDisturb] = useState(profile.alerts.doNotDisturb);
  const [continueAtStart, setContinueAtStart] = useState(profile.resume.continueAtStart);
  const [continuePrompt, setContinuePrompt] = useState(resumePrompt(profile.resume));
  // A profile that never chose shows the default (spec §9.8).
  const [suspendIdleMin, setSuspendIdleMin] = useState<SuspendSetting>(suspendDelay(profile) ?? 0);
  const [statusLine, setStatusLine] = useState(profile.claude.statusLine ?? '');
  const [askBeforeLink, setAskBeforeLink] = useState(profile.claude.askBeforeLink);
  const [editor, setEditor] = useState<EditorDraft>(draftOf(profile.editor));
  const [editorError, setEditorError] = useState<string | null>(null);
  const [commitName, setCommitName] = useState(profile.git?.commitName ?? '');
  const [commitEmail, setCommitEmail] = useState(profile.git?.commitEmail ?? '');
  const [prCreate, setPrCreate] = useState(profile.pr?.createCommand ?? '');
  const [prStatus, setPrStatus] = useState(profile.pr?.statusCommand ?? '');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const setup = useQuery(trpc.setup.get.queryOptions({ profileId: profile.id }));
  const refusal = useQuery(trpc.profiles.removalRefusal.queryOptions({ profileId: profile.id }));
  const update = useMutation(trpc.profiles.update.mutationOptions({ onSuccess: onClose }));
  const remove = useMutation(trpc.profiles.remove.mutationOptions({ onSuccess: onClose }));
  const folder = accountFolder(profile);

  const state = setupPassed(setup.data)
    ? setup.data?.signedIn.state === 'passed'
      ? `✓ Signed in${setup.data.signedIn.value.email ? ` as ${setup.data.signedIn.value.email}` : ''}`
      : '✓ Ready'
    : (setupWarning(setup.data) ?? 'Checking…');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    // The editor (spec §6.13) is saved first; a custom one needs its folder command.
    setEditorError(null);
    try {
      const chosen = editorOfDraft(editor);
      if (JSON.stringify(chosen) !== JSON.stringify(profile.editor ?? null)) {
        await trpcClient.editor.setProfileEditor.mutate({ profileId: profile.id, editor: chosen });
      }
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : String(error));
      setTab('general');
      return;
    }
    update.mutate({
      profileId: profile.id,
      name: name.trim(),
      color,
      alerts: { sounds, doNotDisturb },
      statusLine: statusLine.trim() || null,
      askBeforeLink,
      git: commitName.trim() || commitEmail.trim() ? { commitName, commitEmail } : null,
      pr: { createCommand: prCreate, statusCommand: prStatus },
      resume: { continueAtStart, prompt: continuePrompt },
      suspendIdleMin,
    });
  };

  return (
    <Modal title="Edit profile" icon={<ProfileDot color={color} />} onClose={onClose} wide tall>
      <div
        role="tablist"
        aria-label="Edit profile"
        className="-mt-1 mb-4 flex gap-0.5 border-b border-line"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            data-edit-tab={t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px h-8 border-b-2 px-2.5 text-md ${
              tab === t.id
                ? 'border-fg font-medium text-fg'
                : 'border-transparent text-fg-muted hover:text-fg'
            }`}
          >
            {t.label}
            {t.id === 'skills' && profile.skills.length > 0 ? (
              <span className="ml-1.5 font-mono text-xs text-fg-subtle">
                {profile.skills.length}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      {tab === 'workflow' ? (
        <ProfileWorkflowEditor
          profile={profile}
          workspaces={workspaces}
          onGuide={onClose}
          onSaved={onClose}
        />
      ) : tab === 'lookup' ? (
        <ProfileLookupEditor profile={profile} onSaved={onClose} />
      ) : tab === 'skills' ? (
        <>
          <ModalBody>
            <SkillSourcesEditor
              profileId={profile.id}
              sources={profile.skills}
              projects={projects}
              workflow={profile.workflow ?? null}
              onGuide={onClose}
            />
          </ModalBody>
          <ModalFooter>
            <button type="button" className={button('secondary')} onClick={onClose}>
              Close
            </button>
          </ModalFooter>
        </>
      ) : (
        <form onSubmit={(e) => void submit(e)} className={modalForm}>
          <ModalBody className="flex flex-col gap-4">
            <div>
              <label className={labelClass} htmlFor="edit-profile-name">
                Name
              </label>
              <input
                id="edit-profile-name"
                className={inputClass}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div>
              <span className={labelClass}>Color</span>
              <ColorPicker
                value={color}
                onChange={setColor}
                others={profiles.filter((p) => p.id !== profile.id)}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="edit-profile-folder">
                Claude account folder <span className="text-fg-subtle">· read-only</span>
              </label>
              <div className="flex gap-2">
                <input
                  id="edit-profile-folder"
                  className={`${inputClass} font-mono`}
                  value={folder}
                  readOnly
                  disabled
                />
                <button type="button" className={button('secondary', 'lg')} onClick={onCheckSetup}>
                  Check setup
                </button>
              </div>
              <p data-account-state className="mt-1.5 text-sm text-fg-muted">
                {state}
              </p>
              <p className="mt-0.5 text-sm text-fg-subtle">
                To use a different Claude account, create a new profile.
              </p>
            </div>

            <TerminalShortcut profileId={profile.id} />

            <div>
              <span className={labelClass}>
                Commit identity <span className="text-fg-subtle">· optional</span>
              </span>
              <div className="grid grid-cols-2 gap-2">
                <input
                  id="edit-profile-commit-name"
                  aria-label="Commit name"
                  className={inputClass}
                  placeholder="Your Name"
                  value={commitName}
                  onChange={(e) => setCommitName(e.target.value)}
                />
                <input
                  id="edit-profile-commit-email"
                  aria-label="Commit email"
                  className={inputClass}
                  placeholder="you@example.com"
                  spellCheck={false}
                  value={commitEmail}
                  onChange={(e) => setCommitEmail(e.target.value)}
                />
              </div>
              <p className="mt-1 text-sm text-fg-subtle">
                Used as the author and committer of commits in this profile's terminals and of the
                app's own commits. Leave empty to use your git config.
              </p>
            </div>

            <fieldset data-pr-commands>
              <legend className={labelClass}>
                <span className="inline-flex items-center gap-1.5">
                  Pull request commands <span className="text-fg-subtle">· optional</span>
                  <GuideLink to="finishing-work#pr-commands" label="PR commands" before={onClose} />
                </span>
              </legend>
              <label className="block text-sm text-fg-muted" htmlFor="edit-profile-pr-create">
                Create PR
              </label>
              <input
                id="edit-profile-pr-create"
                className={`${inputClass} font-mono text-sm`}
                placeholder={`gh pr create --fill --base "$${BRAND.envPrefix}BASE_BRANCH"`}
                spellCheck={false}
                value={prCreate}
                onChange={(e) => setPrCreate(e.target.value)}
              />
              <label className="mt-2 block text-sm text-fg-muted" htmlFor="edit-profile-pr-status">
                PR status
              </label>
              <input
                id="edit-profile-pr-status"
                className={`${inputClass} font-mono text-sm`}
                placeholder="prints { &quot;state&quot;: &quot;open&quot;, &quot;url&quot;: &quot;…&quot; }"
                spellCheck={false}
                value={prStatus}
                onChange={(e) => setPrStatus(e.target.value)}
              />
              <p data-pr-hint className="mt-1 text-sm text-fg-subtle">
                Leave both empty: Claude opens pull requests and git tells when they're merged. A
                project's own commands in config.json override these.
              </p>
            </fieldset>

            <fieldset data-sounds>
              <legend className={labelClass}>Sounds</legend>
              {SOUND_EVENTS.map((event) => (
                <label key={event.key} className="mt-1 flex items-center gap-2 text-md first:mt-0">
                  <input
                    type="checkbox"
                    checked={sounds[event.key]}
                    onChange={(e) => {
                      const on = e.target.checked;
                      setSounds((current) => ({ ...current, [event.key]: on }));
                      // Ticked: play it once, so you know what it sounds like.
                      if (on) playAlert(event.state);
                    }}
                  />
                  {event.label}
                  {'note' in event ? (
                    <span className="text-sm text-fg-subtle">{event.note}</span>
                  ) : null}
                </label>
              ))}
            </fieldset>
            <div>
              <span className={labelClass}>Alerts</span>
              <label className="flex items-center gap-2 text-md">
                <input
                  type="checkbox"
                  checked={doNotDisturb}
                  onChange={(e) => setDoNotDisturb(e.target.checked)}
                />
                Do Not Disturb{' '}
                <span className="text-sm text-fg-subtle">no notifications or sounds</span>
              </label>
            </div>
            <div data-resume-settings>
              <span className={labelClass}>When {BRAND.displayName} starts</span>
              <label className="flex items-center gap-2 text-md">
                <input
                  id="edit-profile-continue"
                  type="checkbox"
                  checked={continueAtStart}
                  onChange={(e) => setContinueAtStart(e.target.checked)}
                />
                Continue interrupted work when {BRAND.displayName} starts
                <GuideLink
                  to="resume#continuing-it"
                  label="Continuing interrupted work"
                  before={onClose}
                />
              </label>
              <label
                className="mt-2 block text-sm text-fg-muted"
                htmlFor="edit-profile-continue-prompt"
              >
                Continue prompt
              </label>
              <textarea
                id="edit-profile-continue-prompt"
                className={`${inputClass} h-auto min-h-14 py-1.5 text-sm`}
                rows={3}
                value={continuePrompt}
                onChange={(e) => setContinuePrompt(e.target.value)}
              />
              <p className="mt-1 text-sm text-fg-subtle">
                Sent to each workspace where Claude was working when {BRAND.displayName} stopped, a
                few seconds apart and never while plan usage is at its limit. Work you interrupted
                with Esc, and permission requests, are never continued by themselves. Off: you're
                asked when {BRAND.displayName} starts.
              </p>
            </div>
            <div data-suspend-settings>
              <label className={labelClass} htmlFor="edit-profile-suspend">
                Suspend idle sessions
              </label>
              <div className="flex items-center gap-2">
                <select
                  id="edit-profile-suspend"
                  className={`${inputClass} w-auto`}
                  value={suspendIdleMin || 'off'}
                  onChange={(e) =>
                    setSuspendIdleMin(
                      e.target.value === 'off' ? 0 : (Number(e.target.value) as SuspendChoice),
                    )
                  }
                >
                  <option value="off">Off</option>
                  {SUSPEND_CHOICES.map((minutes) => (
                    <option key={minutes} value={minutes}>
                      After {minutes} minutes
                    </option>
                  ))}
                </select>
                <GuideLink to="suspend" label="Suspending idle sessions" before={onClose} />
              </div>
              <p className="mt-1 text-sm text-fg-subtle">
                Stops Claude, and everything it started, in workspaces you aren't looking at once it
                has been idle that long, to save memory. Opening the workspace resumes the
                conversation.
              </p>
            </div>
            <div>
              <span className={labelClass}>Editor</span>
              <EditorPicker
                profileId={profile.id}
                value={editor}
                onChange={setEditor}
                none="Not set: the first Open in editor asks"
              />
              <p className="mt-1 text-sm text-fg-subtle">
                Open in editor uses it for this profile's projects; a project can choose its own in
                its Setup tab.
              </p>
              {editorError ? <p className="mt-1 text-sm text-st-error">✕ {editorError}</p> : null}
            </div>
            <div>
              <span className={labelClass}>Linking repositories</span>
              <label className="flex items-center gap-2 text-md">
                <input
                  type="checkbox"
                  checked={askBeforeLink}
                  onChange={(e) => setAskBeforeLink(e.target.checked)}
                />
                Ask before Claude links a repository
                <GuideLink
                  to="tasks-across-repositories#when-claude-links-one-itself"
                  label="Tasks across repositories"
                  before={onClose}
                />
              </label>
              <p className="mt-1 text-sm text-fg-subtle">
                Claude asks you before it runs{' '}
                <span className="font-mono">{BRAND.cliCommand} link</span>, even in auto mode.
                Applies the next time Claude starts in a workspace.
              </p>
            </div>
            <div>
              <label className={labelClass} htmlFor="edit-profile-statusline">
                <span className="inline-flex items-center gap-1.5">
                  Your status line command <span className="text-fg-subtle">· optional</span>
                  <GuideLink
                    to="status-line#when-to-set-your-own-command"
                    label="The status line"
                    before={onClose}
                  />
                </span>
              </label>
              <input
                id="edit-profile-statusline"
                className={`${inputClass} font-mono text-sm`}
                placeholder="~/.claude/statusline.sh"
                spellCheck={false}
                value={statusLine}
                onChange={(e) => setStatusLine(e.target.value)}
              />
              <p data-statusline-hint className="mt-1 text-sm text-fg-subtle">
                Only needed if you customized Claude Code's status line: paste the command from the{' '}
                <span className="font-mono">statusLine</span> setting in your Claude settings.
                Otherwise leave it empty.
              </p>
            </div>

            <div className="border-t border-line pt-3">
              {confirmRemove ? (
                <div className="rounded-md border border-line bg-surface p-3">
                  <p className="text-md">
                    Remove {profile.name} from {BRAND.displayName}? Nothing on disk is deleted:{' '}
                    <span className="font-mono">{folder}</span> and its Claude login stay where they
                    are.
                  </p>
                  <div className="mt-3 flex justify-end gap-2">
                    <button
                      type="button"
                      // biome-ignore lint/a11y/noAutofocus: the safe choice of a removal
                      autoFocus
                      className={button('ghost')}
                      onClick={() => setConfirmRemove(false)}
                    >
                      Keep profile
                    </button>
                    <button
                      type="button"
                      className={button('secondary')}
                      disabled={remove.isPending}
                      onClick={() => remove.mutate({ profileId: profile.id })}
                    >
                      Remove from {BRAND.displayName}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    className={button('danger-quiet')}
                    disabled={refusal.data !== null}
                    onClick={() => setConfirmRemove(true)}
                  >
                    Remove profile…
                  </button>
                  <span className="text-sm text-fg-subtle">
                    {refusal.data ??
                      `Removes the profile from ${BRAND.displayName}. Nothing on disk is deleted.`}
                  </span>
                </div>
              )}
            </div>

            {(update.error ?? remove.error)?.message ? (
              <p className="text-md text-st-error">{(update.error ?? remove.error)?.message}</p>
            ) : null}
          </ModalBody>
          <ModalFooter>
            <button type="button" className={button('ghost')} onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className={button('primary')}
              disabled={!name.trim() || update.isPending}
            >
              Save <Kbd onFg>{keyHint('confirm')}</Kbd>
            </button>
          </ModalFooter>
        </form>
      )}
    </Modal>
  );
}
