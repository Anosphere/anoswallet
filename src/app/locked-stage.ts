import type { Words } from './i18n/en';

/**
 * The stage of a locked transfer in words (wallet spec 8.2), from the
 * validator's stage word (anossoftware spec 18.2): a guarded or vault
 * account's transfer waiting out its time lock; the words come from the
 * dictionary, `words` (wallet spec 8.8). Shown by the Locked transfer row
 * on the account page; such a transfer can be cancelled from its row
 * (2026-11-11, the stage cancelling until the row is gone), and still has
 * no page of its own. A word the wallet does not know reads Held.
 */
export function lockedStageWords(stage: string, words: Words['lockedStages']): string {
  switch (stage) {
    case 'waiting':
      return words.waiting;
    case 'locked':
      return words.locked;
    case 'due':
      return words.due;
    case 'cancelling':
      return words.cancelling;
    default:
      return words.held;
  }
}
