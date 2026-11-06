import type { TransactionItem } from './services/anos-api.service';
import { shortId } from './short-id';

/** A history row in words: the title, the kind for the details, the amount's sign and the icon (wallet spec 8.2, Transaction history). */
export interface HistoryWords {
  title: string;
  kind: string;
  sign: '+' | '-' | '';
  icon: string;
}

/** The kind in words of the four transfers an account sends by its type. */
const TRANSFER_KINDS: Record<string, string> = {
  anosTransfer: 'plain transfer',
  guardedAnosTransfer: 'guarded transfer',
  vaultAnosTransfer: 'vault transfer',
  assistedAnosTransfer: 'assisted transfer',
};

/**
 * A transaction in plain words (wallet spec 8.2, Transaction history),
 * from its type word and which side of it this account is on: "Sent to
 * a1b2c3d4…e5f6", "Received from …", "Account created", "Escrow released
 * to …", "Escrow received from …", "Staked with the fund", "Fund
 * proposal", "Received from the fund", "Fund payout to …". The other side
 * is accountIdTo when this account sent and accountId otherwise, shown
 * short; "to …" or "from …" is dropped when there is none. A type word
 * the wallet does not know keeps the raw word, with the sign by the side.
 */
export function historyWords(t: TransactionItem, accountId: string): HistoryWords {
  const sent = t.accountId === accountId;
  const other = sent ? t.accountIdTo : t.accountId;
  const to = other === null ? '' : ` to ${shortId(other)}`;
  const from = other === null ? '' : ` from ${shortId(other)}`;
  switch (t.type) {
    case 'accountCreation':
      return { title: 'Account created', kind: 'account creation', sign: '', icon: 'add_circle' };
    case 'anosTransfer':
    case 'guardedAnosTransfer':
    case 'vaultAnosTransfer':
    case 'assistedAnosTransfer':
      return sent
        ? { title: `Sent${to}`, kind: TRANSFER_KINDS[t.type] ?? t.type, sign: '-', icon: 'call_made' }
        : { title: `Received${from}`, kind: TRANSFER_KINDS[t.type] ?? t.type, sign: '+', icon: 'call_received' };
    case 'escrowTransfer':
      return sent
        ? { title: `Escrow released${to}`, kind: 'escrow transfer', sign: '-', icon: 'handshake' }
        : { title: `Escrow received${from}`, kind: 'escrow transfer', sign: '+', icon: 'handshake' };
    case 'transferToFund':
      return { title: 'Staked with the fund', kind: 'stake', sign: '-', icon: 'savings' };
    case 'fundProposal':
      return { title: 'Fund proposal', kind: 'fund proposal', sign: '', icon: 'how_to_vote' };
    case 'transferFromFund':
      return t.accountIdTo === accountId
        ? { title: 'Received from the fund', kind: 'fund payout', sign: '+', icon: 'account_balance' }
        : { title: `Fund payout${to}`, kind: 'fund payout', sign: '', icon: 'account_balance' };
    default:
      return { title: t.type, kind: t.type, sign: sent ? '-' : t.accountIdTo === accountId ? '+' : '', icon: 'receipt_long' };
  }
}
