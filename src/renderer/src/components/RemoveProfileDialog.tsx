import { BRAND } from '@shared/brand';
import type { Profile } from '@shared/schemas';
import { accountFolder } from '@shared/setup';
import { useMutation } from '@tanstack/react-query';
import { useTRPC } from '../trpc';
import { button, Kbd } from '../ui/controls';
import { Modal, ModalBody, ModalFooter, modalForm } from './Modal';

/**
 * Remove profile… from the tab's menu (spec §6.11): the same confirmation as
 * in Edit profile, with Keep profile focused. The menu offers it only while
 * the profile has no projects.
 */
export function RemoveProfileDialog({
  profile,
  onClose,
}: {
  profile: Profile;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const remove = useMutation(trpc.profiles.remove.mutationOptions({ onSuccess: onClose }));
  return (
    <Modal
      title={`Remove ${profile.name} from ${BRAND.displayName}?`}
      description={
        <>
          Nothing on disk is deleted: <span className="font-mono">{accountFolder(profile)}</span>{' '}
          and its Claude login stay where they are.
        </>
      }
      onClose={onClose}
    >
      <form
        className={`${modalForm} text-md`}
        onSubmit={(event) => {
          event.preventDefault();
          remove.mutate({ profileId: profile.id });
        }}
      >
        <ModalBody>
          {remove.error ? (
            <p role="alert" className="text-st-error select-text">
              ✕ {remove.error.message}
            </p>
          ) : null}
        </ModalBody>
        <ModalFooter>
          <button
            type="button"
            data-autofocus
            className={button('secondary', 'lg')}
            onClick={onClose}
          >
            Keep profile <Kbd>Esc</Kbd>
          </button>
          <button type="submit" className={button('danger', 'lg')} disabled={remove.isPending}>
            {remove.isPending ? 'Removing…' : `Remove from ${BRAND.displayName}`}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
