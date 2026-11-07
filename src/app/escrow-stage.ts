import type { Words } from './i18n/en';

/**
 * The stage of an open escrow trade in words (wallet spec 8.2), from the
 * validator's stage word (anossoftware spec 16.2) and which side of the
 * trade this account is on; the words come from the dictionary, `words`
 * (wallet spec 8.8). Shared by the Escrow trades list on the account page,
 * the trade page and the pinned listing card, so they cannot drift apart. A
 * word the wallet does not know reads Open, and the pages offer nothing to
 * do with such a trade.
 */
export function escrowStageWords(stage: string, side: 'seller' | 'buyer', words: Words['escrowStages']): string {
  switch (stage) {
    case 'waiting':
      return words.waiting;
    case 'held':
      return side === 'seller' ? words.heldSeller : words.heldBuyer;
    case 'releasing':
      return words.releasing;
    case 'cancelling':
      return words.cancelling;
    case 'disputed':
      return words.disputed;
    default:
      return words.open;
  }
}
