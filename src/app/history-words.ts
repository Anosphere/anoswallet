import type { Words } from './i18n/en';
import type { TransactionItem } from './services/anos-api.service';
import { shortId } from './short-id';

/** A history row in words: the title, the kind for the details, the amount's sign and the icon (wallet spec 8.2, Transaction history). */
export interface HistoryWords {
  title: string;
  kind: string;
  sign: '+' | '-' | '';
  icon: string;
}

/**
 * A transaction in plain words (wallet spec 8.2, Transaction history),
 * from its type word and which side of it this account is on, the words
 * from the dictionary, `words` (wallet spec 8.8): "Sent to a1b2c3d4…e5f6",
 * "Received from …", "Account created", "Escrow released to …", "Escrow
 * received from …", "Staked with the fund", "Fund proposal", "Received
 * from the fund", "Fund payout to …", and for a breakGlassTransfer
 * (2026-11-08) "Recovered from an old account" when received and "Moved to
 * a new account" when sent. The other side is accountIdTo when
 * this account sent and accountId otherwise, shown short; "to …" or
 * "from …" is dropped when there is none. A type word the wallet does not
 * know keeps the raw word, with the sign by the side.
 */
export function historyWords(t: TransactionItem, accountId: string, words: Words['historyWords']): HistoryWords {
  const sent = t.accountId === accountId;
  const other = sent ? t.accountIdTo : t.accountId;
  const short = other === null ? null : shortId(other);
  switch (t.type) {
    case 'accountCreation':
      return { title: words.accountCreated, kind: words.kinds.accountCreation, sign: '', icon: 'add_circle' };
    case 'anosTransfer':
    case 'guardedAnosTransfer':
    case 'vaultAnosTransfer':
    case 'assistedAnosTransfer':
      return sent
        ? { title: short === null ? words.sent : words.sentTo(short), kind: words.transferKinds[t.type] ?? t.type, sign: '-', icon: 'call_made' }
        : { title: short === null ? words.received : words.receivedFrom(short), kind: words.transferKinds[t.type] ?? t.type, sign: '+', icon: 'call_received' };
    case 'escrowTransfer':
      return sent
        ? { title: short === null ? words.escrowReleased : words.escrowReleasedTo(short), kind: words.kinds.escrowTransfer, sign: '-', icon: 'handshake' }
        : { title: short === null ? words.escrowReceived : words.escrowReceivedFrom(short), kind: words.kinds.escrowTransfer, sign: '+', icon: 'handshake' };
    case 'transferToFund':
      return { title: words.staked, kind: words.kinds.stake, sign: '-', icon: 'savings' };
    case 'fundProposal':
      return { title: words.fundProposal, kind: words.kinds.fundProposal, sign: '', icon: 'how_to_vote' };
    case 'transferFromFund':
      return t.accountIdTo === accountId
        ? { title: words.receivedFromFund, kind: words.kinds.fundPayout, sign: '+', icon: 'account_balance' }
        : { title: short === null ? words.fundPayout : words.fundPayoutTo(short), kind: words.kinds.fundPayout, sign: '', icon: 'account_balance' };
    case 'breakGlassTransfer':
      // The whole balance of an account whose keys were lost with its passkey, moved to a new account of the same type by its break-glass key (wallet spec 8.2, 2026-11-08).
      return sent
        ? { title: words.movedToNew, kind: words.kinds.breakGlassTransfer, sign: '-', icon: 'key_off' }
        : { title: words.recoveredFromOld, kind: words.kinds.breakGlassTransfer, sign: '+', icon: 'restore' };
    default:
      return { title: t.type, kind: t.type, sign: sent ? '-' : t.accountIdTo === accountId ? '+' : '', icon: 'receipt_long' };
  }
}
