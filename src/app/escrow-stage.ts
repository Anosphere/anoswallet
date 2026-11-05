/**
 * The stage of an open escrow trade in words (wallet spec 8.2), from the
 * validator's stage word (anossoftware spec 16.2) and which side of the
 * trade this account is on. Shared by the Escrow trades list on the account
 * page and the trade page, so the two cannot drift apart. A word the wallet
 * does not know reads Open, and the pages offer nothing to do with such a
 * trade.
 */
export function escrowStageWords(stage: string, side: 'seller' | 'buyer'): string {
  switch (stage) {
    case 'waiting':
      return 'Waiting for the validators';
    case 'held':
      return side === 'seller' ? 'Waiting for you to release the anos' : 'Waiting for the seller to release the anos';
    case 'releasing':
      return 'Being released';
    case 'cancelling':
      return 'Being cancelled';
    case 'disputed':
      return 'In dispute, attestors are deciding';
    default:
      return 'Open';
  }
}
