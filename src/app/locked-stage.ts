/**
 * The stage of a locked transfer in words (wallet spec 8.2), from the
 * validator's stage word (anossoftware spec 18.2): a guarded or vault
 * account's transfer waiting out its time lock. Shown by the Locked
 * transfer row on the account page; nothing can be done with such a
 * transfer, so it has no page of its own. A word the wallet does not know
 * reads Held.
 */
export function lockedStageWords(stage: string): string {
  switch (stage) {
    case 'waiting':
      return 'Waiting for the validators';
    case 'locked':
      return 'Waiting out the lock';
    case 'due':
      return 'Unlocked, being written';
    default:
      return 'Held';
  }
}
