import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useTRPC } from '../trpc';
import { button } from '../ui/controls';
import { Modal, ModalBody, ModalFooter, modalForm } from './Modal';
import { CommandBlock } from './SetupCheck';

/**
 * The optional terminal shortcut of a profile with its own account folder
 * (spec §6.11): the alias line with Copy, and Add to <rc file>… after a
 * confirmation that shows the file and the line. Nothing for profiles on the
 * default login.
 */
export function TerminalShortcut({ profileId }: { profileId: string }) {
  const trpc = useTRPC();
  const [confirming, setConfirming] = useState(false);
  const alias = useQuery(trpc.profiles.alias.queryOptions({ profileId }));
  const addAlias = useMutation(trpc.profiles.addAlias.mutationOptions());
  if (!alias.data) return null;
  const data = alias.data;
  return (
    <div data-terminal-shortcut className="flex flex-col gap-2">
      <p className="text-md font-medium">Terminal shortcut (optional)</p>
      <p className="text-sm text-fg-muted">
        Runs Claude Code with this profile's account in any terminal.
      </p>
      <CommandBlock command={data.line} />
      {data.present || addAlias.data ? (
        <>
          <p data-alias-added className="text-sm text-diff-add">
            ✓ {addAlias.data?.added ? 'Added to the end of' : 'Already in'} {data.fileShown}
          </p>
          {addAlias.data?.added ? (
            <>
              <p className="text-sm text-fg-muted">
                The alias works in terminals you open from now on. In terminals already open, run:
              </p>
              <CommandBlock command={`source ${data.fileShown}`} />
            </>
          ) : null}
        </>
      ) : data.file ? (
        <div>
          <button type="button" className={button('secondary')} onClick={() => setConfirming(true)}>
            Add to {data.fileShown}…
          </button>
        </div>
      ) : null}
      {addAlias.error ? (
        <p role="alert" className="text-sm text-st-error">
          ✕ {addAlias.error.message}
        </p>
      ) : null}

      {/* In a portal: the block sits inside the wizard's and Edit profile's forms, and a
          form nested in another doesn't submit. */}
      {confirming && data.file
        ? createPortal(
            <Modal
              title={`Add one line to ${data.fileShown}?`}
              description={<span className="font-mono">{data.file}</span>}
              onClose={() => setConfirming(false)}
            >
              <form
                className={modalForm}
                onSubmit={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  addAlias.mutate(
                    { profileId },
                    {
                      onSettled: () => void alias.refetch(),
                      onSuccess: () => setConfirming(false),
                    },
                  );
                }}
              >
                <ModalBody>
                  <p className="text-md text-fg-muted">
                    The app appends this line to the end of the file and changes nothing else.
                  </p>
                  <pre
                    data-alias-line
                    className="mt-2 rounded-md border border-line bg-diff-add-bg px-2.5 py-1.5 font-mono text-sm break-all whitespace-pre-wrap"
                  >
                    + {data.line}
                  </pre>
                </ModalBody>
                <ModalFooter>
                  <button
                    type="button"
                    // biome-ignore lint/a11y/noAutofocus: a change to the user's file is confirmed explicitly
                    autoFocus
                    className={button('secondary')}
                    onClick={() => setConfirming(false)}
                  >
                    Cancel
                  </button>
                  <button type="submit" className={button('primary')} disabled={addAlias.isPending}>
                    Add line
                  </button>
                </ModalFooter>
              </form>
            </Modal>,
            document.body,
          )
        : null}
    </div>
  );
}
