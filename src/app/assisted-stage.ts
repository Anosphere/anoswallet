/**
 * The stage of a held assisted transfer in words (wallet spec 8.2), from
 * the validator's stage word (anossoftware spec 17.2). Shared by the
 * Assisted transfer row on the account page and the transfer page, so the
 * two cannot drift apart. A word the wallet does not know reads Open, and
 * the pages offer nothing to do with such a transfer.
 */
export function assistedStageWords(stage: string): string {
  switch (stage) {
    case 'waiting':
      return 'Waiting for the validators';
    case 'attesting':
      return 'Waiting for attestors';
    case 'writing':
      return 'Attested, being written';
    case 'cancelling':
      return 'Being cancelled';
    default:
      return 'Open';
  }
}
