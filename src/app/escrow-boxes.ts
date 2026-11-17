import type { ConfirmData } from './components/confirm-dialog.component';
import type { Words } from './i18n/en';

/**
 * The five boxes of an escrow trade (wallet spec 8.2, Escrow trade, and
 * 8.9; 2026-11-17, forclaude/wallet-trade-guide-plan-1.md): what askConfirm
 * is given before a release, a dispute and a cancel, and askChoice for the
 * question before a cancel, built from the
 * dictionary, `words` (wallet spec 8.8), in one place so that every page
 * that opens one opens the same box. Release, Dispute and Cancel each ask
 * for the username before their button works (`typed`). The first button
 * reads Back in four of them. Red (`danger`) is on the two buttons that
 * dispute and on no other: "Yes, cancel the trade" keeps the theme's
 * colour.
 */

/** Release, the seller's: the amount and the buyer's account id, when to do it, that it cannot be undone, and the username to type. */
export function releaseBox(words: Words, anos: string, buyerAccountId: string, username: string): ConfirmData {
  return {
    title: words.escrowBoxes.releaseTitle(anos),
    lines: [
      { label: words.common.amount, value: words.common.anos(anos) },
      { label: words.common.buyer, value: buyerAccountId, code: true },
    ],
    notes: [words.escrowBoxes.releaseNote, words.escrowBoxes.cannotBeUndone, words.escrowBoxes.typeNote],
    confirmLabel: words.escrow.yes.release,
    cancelLabel: words.common.back,
    typed: { label: words.common.yourUsername, expected: username },
  };
}

/** Dispute, either side's: when to use it, what follows, and the username to type. Its button is red. */
export function disputeBox(words: Words, username: string): ConfirmData {
  return {
    title: words.escrowBoxes.disputeTitle,
    lines: [],
    notes: [words.escrowBoxes.disputeWhen, words.escrowBoxes.disputeWhat, words.escrowBoxes.typeNote],
    confirmLabel: words.escrow.yes.dispute,
    cancelLabel: words.common.back,
    danger: true,
    typed: { label: words.common.yourUsername, expected: username },
  };
}

/** The question before a cancel, the buyer's: "Have you sent any money to the seller?". The first button, which closes with false, is "No, I have not paid"; the second, which closes with true, is "Yes, I have paid". The caller opens it with askChoice, not askConfirm, since the first button is an answer here: a box closed without a button, by a step back or forward in the browser's history, is then no answer (2026-11-17, decision 25 of the plan). */
export function paidQuestionBox(words: Words): ConfirmData {
  return {
    title: words.escrowBoxes.paidTitle,
    lines: [],
    notes: [words.escrowBoxes.paidNote],
    cancelLabel: words.escrowBoxes.paidNo,
    confirmLabel: words.escrowBoxes.paidYes,
  };
}

/** After "Yes, I have paid": do not cancel, and why. Its second button is the red "Something is wrong: dispute"; the caller opens the Dispute box on it. */
export function doNotCancelBox(words: Words): ConfirmData {
  return {
    title: words.escrowBoxes.doNotCancelTitle,
    lines: [],
    notes: [words.escrowBoxes.doNotCancelWhy, words.escrowBoxes.doNotCancelWhat],
    cancelLabel: words.common.back,
    confirmLabel: words.escrow.dispute,
    danger: true,
  };
}

/** After "No, I have not paid": the cancel, the buyer's. The amount, where the anos go, when to cancel and when not, that it cannot be undone, and the username to type. Its button is not red. */
export function cancelBox(words: Words, anos: string, username: string): ConfirmData {
  return {
    title: words.escrowBoxes.cancelTitle,
    lines: [{ label: words.common.amount, value: words.common.anos(anos) }],
    notes: [words.escrowBoxes.cancelNote(anos), words.escrowBoxes.cancelOnlyIf, words.escrowBoxes.cannotBeUndone, words.escrowBoxes.typeNote],
    confirmLabel: words.escrow.yes.cancel,
    cancelLabel: words.common.back,
    typed: { label: words.common.yourUsername, expected: username },
  };
}
