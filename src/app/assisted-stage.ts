import type { Words } from './i18n/en';

/**
 * The stage of a held assisted transfer in words (wallet spec 8.2), from
 * the validator's stage word (anossoftware spec 17.2); the words come from
 * the dictionary, `words` (wallet spec 8.8). Shared by the Assisted
 * transfer row on the account page and the transfer page, so the two
 * cannot drift apart. A word the wallet does not know reads Open, and the
 * pages offer nothing to do with such a transfer. The fifth stage, locked
 * (2026-11-08, a break-glass move out of a guarded or vault account with
 * both attestations in, waiting out the lock), reads "Locked until" the
 * moment the row's unlocksAt names, which the caller passes formatted.
 */
export function assistedStageWords(stage: string, words: Words['assistedStages'], unlocksAt = ''): string {
  switch (stage) {
    case 'waiting':
      return words.waiting;
    case 'attesting':
      return words.attesting;
    case 'locked':
      return words.locked(unlocksAt);
    case 'writing':
      return words.writing;
    case 'cancelling':
      return words.cancelling;
    default:
      return words.open;
  }
}
