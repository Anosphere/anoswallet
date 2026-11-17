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

/**
 * What the status box of an escrow trade can say (wallet spec 8.2, Escrow
 * trade, and 8.7; 2026-11-17, forclaude/wallet-trade-guide-plan-1.md). The
 * five stage words of an open trade, `open` for a stage word the wallet
 * does not know, and five states that are no stage: `checking` (the first
 * check is still running), `unread` (a read failed and nothing is known),
 * `noAccount` (no trade, and no account in the chat yet), `noTrade` (no
 * trade, an account is in the chat) and `released`. The escrow trade page
 * shows an open trade only, so it uses the stage words and `open`.
 */
export type EscrowGuideState = 'checking' | 'unread' | 'noAccount' | 'noTrade' | 'waiting' | 'held' | 'releasing' | 'cancelling' | 'disputed' | 'released' | 'open';

/** The colour of the status box: `ok` is green, `warn` is amber, `plain` is grey. */
export type EscrowGuideTone = 'ok' | 'warn' | 'plain';

/** What the status box shows (escrow-strip.component.ts): its colour, a Material icon name, the headline, the one sentence under it (empty for none) and the step of the four, null where the state is no step. */
export interface EscrowGuide {
  tone: EscrowGuideTone;
  icon: string;
  headline: string;
  text: string;
  step: number | null;
}

/** The state of an open trade from the validator's stage word (anossoftware spec 16.2): the word itself when it is one of the five the wallet knows, `open` for any other word. */
export function stateOfStage(stage: string): EscrowGuideState {
  switch (stage) {
    case 'waiting':
    case 'held':
    case 'releasing':
    case 'cancelling':
    case 'disputed':
      return stage;
    default:
      return 'open';
  }
}

/**
 * The status box for a state and a side (2026-11-17,
 * forclaude/wallet-trade-guide-plan-1.md, the table "The status box"): one
 * case per state. `name` stands for the other trader in the sentences that
 * name them; `anos` is the trade's amount in anos, used by `held` and
 * `released` only; the words come from the dictionary's `escrowGuide`
 * (wallet spec 8.8). Green only when the anos are in escrow for the buyer,
 * and when they are being released or are released. Amber where a person
 * must hold back: the buyer before the anos are in escrow, the seller
 * while they are in escrow, and a trade in dispute. Grey otherwise. The
 * four steps: 1 the buyer sends an account, 2 the seller puts the anos in
 * escrow, 3 the buyer pays the seller, 4 the seller releases the anos.
 */
export function escrowGuide(state: EscrowGuideState, side: 'seller' | 'buyer', name: string, anos: string, words: Words['escrowGuide']): EscrowGuide {
  const buyer = side === 'buyer';
  switch (state) {
    case 'checking':
      return { tone: 'plain', icon: 'hourglass_empty', headline: words.checking, text: '', step: null };
    case 'unread':
      return { tone: buyer ? 'warn' : 'plain', icon: 'cloud_off', headline: words.unread, text: buyer ? words.unreadBuyer : words.unreadSeller, step: null };
    case 'noAccount':
      return { tone: buyer ? 'warn' : 'plain', icon: 'lock_open', headline: words.notInEscrow, text: buyer ? words.buyerNoAccount(name) : words.sellerNoAccount(name), step: 1 };
    case 'noTrade':
      return { tone: buyer ? 'warn' : 'plain', icon: 'lock_open', headline: words.notInEscrow, text: buyer ? words.buyerNoTrade(name) : words.sellerNoTrade(name), step: 2 };
    case 'waiting':
      return { tone: buyer ? 'warn' : 'plain', icon: 'hourglass_empty', headline: words.notYet, text: buyer ? words.buyerWaiting : words.sellerWaiting, step: 2 };
    case 'held':
      return { tone: buyer ? 'ok' : 'warn', icon: 'lock', headline: words.inEscrow(anos), text: buyer ? words.buyerHeld(name) : words.sellerHeld, step: 3 };
    case 'releasing':
      return { tone: 'ok', icon: 'check_circle', headline: words.releasing, text: buyer ? words.buyerReleasing : words.sellerReleasing, step: 4 };
    case 'cancelling':
      return { tone: buyer ? 'warn' : 'plain', icon: 'cancel', headline: words.cancelling, text: buyer ? words.buyerCancelling(name) : words.sellerCancelling, step: null };
    case 'disputed':
      return { tone: 'warn', icon: 'gavel', headline: words.inDispute, text: words.disputed, step: null };
    case 'released':
      return { tone: 'ok', icon: 'check_circle', headline: words.released(anos), text: buyer ? words.buyerReleased : words.sellerReleased(name), step: 4 };
    case 'open':
      return { tone: 'plain', icon: 'help_outline', headline: words.open, text: words.openText, step: null };
  }
}
