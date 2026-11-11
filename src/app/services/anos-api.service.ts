import { Injectable, inject } from '@angular/core';
import { VALIDATOR_READ_TIMEOUT_MS } from '../constants';
import { ConfigService } from './config.service';
import {
  AnosTransferTransaction,
  AssistedTransferCancelPayload,
  AttestationPayload,
  CreateAccountTransaction,
  CryptoService,
  Envelope,
  EscrowSignaturePayload,
  EscrowVerdictPayload,
  FollowUp,
  FundProposalTransaction,
  GuardianVotePayload,
  LockedTransferCancelPayload,
  PairOne,
  StakePurpose,
  TransferToFundTransaction,
  Verdict,
  Vote,
} from './crypto.service';
import { ApiResponse, LogService } from './log.service';

/** What /get-account answers (wallet spec 5.4); the two stake fields since 2026-11-08 (anossoftware 25.1), which an older validator leaves out. */
export interface AccountAnswer {
  accountId: string;
  type: string;
  balance: string;
  latestTransactionId: string | null;
  createdAt: string;
  /** The account's stake per purpose, millionths as decimal strings, "0" each when it has no stakes row. */
  stakes?: Record<StakePurpose, string>;
  /** The account's guardian votes, floor(guardian stake / anosPerVote), as a number. */
  guardianVotes?: number;
}

export interface TransactionItem {
  transactionId: string;
  position: number;
  type: string;
  accountId: string | null;
  accountIdTo: string | null;
  amount: string;
  createdAt: string;
}

export interface PendingItem {
  transactionId: string;
  type: string | null;
  accountId: string;
  accountIdTo: string | null;
  amount: string;
  createdAt: string;
  approved: boolean;
}

export interface TransactionsAnswer {
  transactions: TransactionItem[];
  pending: PendingItem[];
}

/** What a submission answers: 202 { transactionId }. */
export interface Accepted {
  transactionId: string;
}

/** One held transfer waiting for attestors, as /list-assisted-transfers answers it (anossoftware 13.2): type (2026-11-08) tells a trade, assistedAnosTransfer, from a break-glass move of a recovery, breakGlassTransfer (anossoftware 22); attestorIds the attestations already in the slots, slot order. */
export interface AssistedTransferItem {
  transactionId: string;
  type: 'assistedAnosTransfer' | 'breakGlassTransfer' | string;
  accountId: string;
  accountIdTo: string;
  amount: string;
  createdAt: string;
  attestorIds: string[];
}

/** One verdict already on the validators for a disputed escrow. */
export interface EscrowVerdictItem {
  arbitratorId: string;
  verdict: Verdict;
  approved: boolean;
}

/** One disputed escrow no verdict has decided, as /list-disputed-escrows answers it (anossoftware 13.2): accountId the seller, accountIdTo the buyer. */
export interface DisputedEscrowItem {
  transactionId: string;
  accountId: string;
  accountIdTo: string;
  amount: string;
  createdAt: string;
  disputedBy: string;
  verdicts: EscrowVerdictItem[];
}

/** Where an open escrow trade is, as the validator names it (anossoftware spec 16.2). A word the wallet does not know is shown as open with no action. */
export type EscrowStage = 'waiting' | 'held' | 'releasing' | 'cancelling' | 'disputed';

/** One verdict on a disputed trade, without the attestor's id: what it says and whether every validator accepted it. */
export interface EscrowVerdictSummary {
  verdict: Verdict;
  approved: boolean;
}

/** One open escrow trade of the signer, as /list-escrows answers it (anossoftware spec 16): accountId the seller, accountIdTo the buyer. */
export interface EscrowItem {
  transactionId: string;
  accountId: string;
  accountIdTo: string;
  amount: string;
  createdAt: string;
  stage: EscrowStage | string;
  disputedBy: string | null;
  verdicts: EscrowVerdictSummary[];
}

/** Where a held assisted transfer is, as the validator names it (anossoftware spec 17.2); locked (2026-11-08) is a break-glass move out of a guarded or vault account waiting out its lock with both attestations in. A word the wallet does not know is shown as held with no action. */
export type AssistedStage = 'waiting' | 'attesting' | 'locked' | 'writing' | 'cancelling';

/** The signer's own held assisted transfer, as /get-assisted-transfer answers it (anossoftware spec 17): type (the validator answers it since 2026-11-08, the wallet reads it since 2026-11-10) tells an assistedAnosTransfer from a breakGlassTransfer, the move of a recovery's finish out of a lost account (anossoftware 22), which the finish looks for with the break-glass pair; accountId the sender, accountIdTo the receiver, attestations the slots holding one, 0, 1 or 2; unlocksAt (2026-11-08) the moment a break-glass move out of a guarded or vault account may be written, null for every other row. */
export interface HeldAssistedTransfer {
  transactionId: string;
  type: 'assistedAnosTransfer' | 'breakGlassTransfer' | string;
  accountId: string;
  accountIdTo: string;
  amount: string;
  createdAt: string;
  stage: AssistedStage | string;
  attestations: number;
  unlocksAt: string | null;
}

/** Where a locked transfer is, as the validator names it (anossoftware spec 18.2); cancelling (2026-11-11, anossoftware spec 28) is a transfer with the sender's cancel on it, which the validator decides right after waiting: the row is gone once every validator accepted the cancel. A word the wallet does not know is shown as held with no action. */
export type LockedStage = 'waiting' | 'locked' | 'due' | 'cancelling';

/** The signer's own locked transfer, as /get-locked-transfer answers it (anossoftware spec 18): a guarded or vault transfer waiting out its time lock, accountId the sender, accountIdTo the receiver, unlocksAt the moment it may be written. */
export interface HeldLockedTransfer {
  transactionId: string;
  accountId: string;
  accountIdTo: string;
  amount: string;
  createdAt: string;
  unlocksAt: string;
  stage: LockedStage | string;
}

// --- the public reads (anossoftware 25) ------------------------------------------

/** Where a fund proposal stands, as the validator names it (anossoftware 25.2): waiting until every validator accepted it; open while the vote runs; closing once the vote closed, until the next round tallies it; written when it passed and the round moved the money; failed when it did not. A word the wallet does not know is shown with no button. */
export type FundProposalStatus = 'waiting' | 'open' | 'closing' | 'written' | 'failed';

/** The validator's guardian dials, answered with every fund proposal read so the wallet's words carry its numbers: the anos per vote and the least stake that makes a guardian (millionths as decimal strings), the percent of the votes that passes a proposal, and the vote's length in minutes. */
export interface FundSettings {
  anosPerVote: string;
  minimumStake: string;
  percent: number;
  minutes: number;
}

/** One guardian's vote on a fund proposal: the account, the side, its weight in votes, whether every validator accepted it, and when it was cast. */
export interface FundVoteItem {
  guardianId: string;
  vote: Vote;
  weight: number;
  approved: boolean;
  votedAt: string;
}

/** One payment of a fund proposal as the validator answers it, the fields as the proposer sent them, with its index; stakeFor marks a payout that returns stake. */
export interface FundPayoutItem {
  index: number;
  accountIdTo: string;
  amount: string;
  reason: string;
  stakeFor: StakePurpose | string | null;
}

/**
 * One fund proposal as /list-fund-proposals answers it (anossoftware 25.1):
 * the proposal's id, the proposer's account, when it was made and when its
 * vote closes, the status, whether every validator accepted it, the payouts
 * counted and summed (millionths as a decimal string), the tally (forWeight
 * is the proposer's weight plus the approved votes for, againstWeight the
 * approved votes against, passing the round's own rule as it stands), when
 * it was decided (null while open) and the votes in guardian id order.
 */
export interface FundProposalItem {
  transactionId: string;
  guardianId: string;
  createdAt: string;
  voteClosesAt: string;
  status: FundProposalStatus | string;
  approved: boolean;
  payoutCount: number;
  total: string;
  forWeight: number;
  againstWeight: number;
  passing: boolean;
  decidedAt: string | null;
  votes: FundVoteItem[];
}

/** What /get-fund-proposal answers: the item plus the proposer's votes when the proposal was stored and its payouts in index order. */
export type FundProposal = FundProposalItem & { proposerWeight: number; payouts: FundPayoutItem[] };

/** The body of /list-fund-proposals: open lists the one open proposal at most (the other fields are not read); decided lists the archives newest first, limit default 20 at most 200, after offset rows, with the decision at or after from and before to (ISO 8601; to is the first moment after the range). */
export interface FundListFilters {
  status: 'open' | 'decided';
  limit?: number;
  offset?: number;
  from?: string;
  to?: string;
}

/**
 * All HTTP calls to the validators (the anos test app's
 * account-api.service.ts, base path /api/anos/<the session's validator>), plus the
 * five signed reads of the account level (/list-escrows: anossoftware 16,
 * /get-assisted-transfer: anossoftware 17, /get-locked-transfer and the
 * date range on /list-transactions: anossoftware 18), the two attestor
 * reads (anossoftware 13, the account level plus attestor stake) and, since
 * 2026-11-08, the two public fund proposal reads (anossoftware 25), the
 * wallet's first unsigned posts to a validator. One method per endpoint;
 * every one resolves to the status and the body, never throws on an HTTP
 * error.
 *
 * The session's validator (2026-11-10, wallet spec 8.3; the plan is
 * forclaude/wallet-round-robin-plan-1.md). The wallet talks to one
 * validator per session, a session being one load of the wallet in a tab,
 * so a reload picks again. The first call picks it at random from the
 * proxy's list, a number from 1 to the `validators` of /api/config, and
 * every call goes to it: the wallet reads an account and then builds a
 * transfer on what it read, and a balance refresh makes several reads at
 * the same moment, so reads spread over several validators could disagree
 * for a moment. Until then every call went to the proxy's
 * `defaultValidator`, which this service no longer reads. When the
 * session's validator does not answer, the session moves to the next one
 * in the list, the first after the last, and stays there. No answer is:
 * nothing came back (status 0: the network failed, or a read ran into its
 * time limit), or 502, 503 or 504 (the wallet's proxy could not reach the
 * validator's doorman, the doorman could not reach its worker or got
 * nothing from it in time, or the validator has just booted and is not
 * counted yet). Every other status is an answer, a refusal included, and
 * so is a 500, which a validator gives to a submission when one of its
 * peers is down.
 *
 * The nine reads go through `read`: each waits at most
 * VALIDATOR_READ_TIMEOUT_MS and, with no answer, is asked again on the
 * next validator, each validator at most once per call; when none answers
 * the last failure is returned. The nine submissions go through `write`:
 * one try, no time limit, and never sent again by the wallet on its own,
 * because a submission that got no answer may still have been taken (a
 * validator knows it by its transaction id and refuses a second copy).
 * With no answer the session moves on and the failure is returned, so the
 * person's next try goes to the next validator.
 */
@Injectable({ providedIn: 'root' })
export class AnosApiService {
  private readonly log = inject(LogService);
  private readonly config = inject(ConfigService);
  private readonly crypto = inject(CryptoService);

  /** The session's validator: its number, from 1 to the `validators` of /api/config, by position in the proxy's list. Empty until the first call, which picks it at random (validator); a call that gets no answer moves it on (moveOn). It lives as long as this load of the wallet in its tab. */
  private sessionValidator: number | null = null;

  /** POST /create-account. */
  createAccount(tx: CreateAccountTransaction): Promise<ApiResponse<Accepted>> {
    return this.write('/create-account', tx);
  }

  /** POST /anos-transfer: any of the six transfer types, the breakGlassTransfer of the recovery's finish included (2026-11-08). */
  anosTransfer(tx: AnosTransferTransaction): Promise<ApiResponse<Accepted>> {
    return this.write('/anos-transfer', tx);
  }

  /** POST /transfer-to-fund: a stake. */
  transferToFund(tx: TransferToFundTransaction): Promise<ApiResponse<Accepted>> {
    return this.write('/transfer-to-fund', tx);
  }

  /** POST /fund-proposal. */
  fundProposal(tx: FundProposalTransaction): Promise<ApiResponse<Accepted>> {
    return this.write('/fund-proposal', tx);
  }

  /** POST /attestation. */
  attestation(followUp: FollowUp<AttestationPayload>): Promise<ApiResponse<Accepted>> {
    return this.write('/attestation', followUp);
  }

  /** POST /assisted-transfer-cancel. */
  assistedTransferCancel(followUp: FollowUp<AssistedTransferCancelPayload>): Promise<ApiResponse<Accepted>> {
    return this.write('/assisted-transfer-cancel', followUp);
  }

  /** POST /locked-transfer-cancel: the sender's cancel of a guarded or vault transfer waiting out its lock (2026-11-11, anossoftware spec 28). */
  lockedTransferCancel(followUp: FollowUp<LockedTransferCancelPayload>): Promise<ApiResponse<Accepted>> {
    return this.write('/locked-transfer-cancel', followUp);
  }

  /** POST /guardian-vote. */
  guardianVote(followUp: FollowUp<GuardianVotePayload>): Promise<ApiResponse<Accepted>> {
    return this.write('/guardian-vote', followUp);
  }

  /** POST /escrow-signature: a success, cancel or dispute signature, or a verdict, by payload.type. */
  escrowSignature(followUp: FollowUp<EscrowSignaturePayload> | FollowUp<EscrowVerdictPayload>): Promise<ApiResponse<Accepted>> {
    return this.write('/escrow-signature', followUp);
  }

  // --- the account level (wallet spec 5.3, 5.4) --------------------------------

  /** POST /get-account, signed by pair one. */
  getAccount(pairOne: PairOne, accountId: string, quiet = false): Promise<ApiResponse<AccountAnswer>> {
    return this.getAccountAs(this.crypto.signAccountEnvelope(pairOne, accountId, '/get-account', {}), quiet);
  }

  /** POST /get-account with an envelope the caller signed: pair one's (getAccount) or, since 2026-11-08, the break-glass pair's (CryptoService.signAccountEnvelopeAsBreakGlass), which the validator accepts when pair one does not verify (anossoftware spec 22), so the recovery's finish reads a lost account's balance and latest transaction id with the recovered seed. */
  getAccountAs(envelope: Envelope, quiet = false): Promise<ApiResponse<AccountAnswer>> {
    return this.read('/get-account', envelope, quiet);
  }

  /** POST /list-transactions, signed by pair one; from and to (ISO 8601) cut the list to a date range (anossoftware spec 18.3). */
  listTransactions(pairOne: PairOne, accountId: string, body: { beforePosition?: number; limit?: number; from?: string; to?: string } = {}, quiet = false): Promise<ApiResponse<TransactionsAnswer>> {
    return this.read('/list-transactions', this.crypto.signAccountEnvelope(pairOne, accountId, '/list-transactions', body), quiet);
  }

  /** POST /list-escrows, signed by pair one: the account's open escrow trades as seller or buyer, newest first (anossoftware spec 16). */
  listEscrows(pairOne: PairOne, accountId: string, quiet = false): Promise<ApiResponse<{ escrows: EscrowItem[] }>> {
    return this.read('/list-escrows', this.crypto.signAccountEnvelope(pairOne, accountId, '/list-escrows', {}), quiet);
  }

  /** POST /get-assisted-transfer, signed by pair one: the account's own held assisted transfer, or null when none is held (anossoftware spec 17). */
  getAssistedTransfer(pairOne: PairOne, accountId: string, quiet = false): Promise<ApiResponse<{ transfer: HeldAssistedTransfer | null }>> {
    return this.getAssistedTransferAs(this.crypto.signAccountEnvelope(pairOne, accountId, '/get-assisted-transfer', {}), quiet);
  }

  /** POST /get-assisted-transfer with an envelope the caller signed: pair one's (getAssistedTransfer) or, since 2026-11-10, the break-glass pair's (CryptoService.signAccountEnvelopeAsBreakGlass), which the validator accepts when pair one does not verify (anossoftware spec 22), so the recovery's finish asks with the recovered seed whether a break-glass move is already held for a lost account, and reads its transaction id and the account it goes to. */
  getAssistedTransferAs(envelope: Envelope, quiet = false): Promise<ApiResponse<{ transfer: HeldAssistedTransfer | null }>> {
    return this.read('/get-assisted-transfer', envelope, quiet);
  }

  /** POST /get-locked-transfer, signed by pair one: the account's own guarded or vault transfer waiting out its lock, or null when none is held (anossoftware spec 18). */
  getLockedTransfer(pairOne: PairOne, accountId: string, quiet = false): Promise<ApiResponse<{ transfer: HeldLockedTransfer | null }>> {
    return this.read('/get-locked-transfer', this.crypto.signAccountEnvelope(pairOne, accountId, '/get-locked-transfer', {}), quiet);
  }

  // --- the attestor reads (anossoftware 13.2): the account envelope as getAccount builds it, the signer staked for attestor ---

  /** POST /list-assisted-transfers: the trades and, since 2026-11-08, the break-glass moves waiting for attestors on this validator, newest first, told apart by type. */
  listAssistedTransfers(pairOne: PairOne, accountId: string, quiet = false): Promise<ApiResponse<{ transfers: AssistedTransferItem[] }>> {
    return this.read('/list-assisted-transfers', this.crypto.signAccountEnvelope(pairOne, accountId, '/list-assisted-transfers', {}), quiet);
  }

  /** POST /list-disputed-escrows: the disputed escrows no verdict has decided, newest first. */
  listDisputedEscrows(pairOne: PairOne, accountId: string, quiet = false): Promise<ApiResponse<{ escrows: DisputedEscrowItem[] }>> {
    return this.read('/list-disputed-escrows', this.crypto.signAccountEnvelope(pairOne, accountId, '/list-disputed-escrows', {}), quiet);
  }

  // --- the public reads (anossoftware 25): no envelope, no signature, the plain body as the object ---

  /** POST /list-fund-proposals: the open fund proposal (one at most) or the decided ones, with the validator's settings; a validator or a doorman without the route answers 404. */
  listFundProposals(filters: FundListFilters, quiet = false): Promise<ApiResponse<{ settings: FundSettings; proposals: FundProposalItem[] }>> {
    return this.read('/list-fund-proposals', filters, quiet);
  }

  /** POST /get-fund-proposal: one fund proposal with its payouts, open or archived, with the settings; 404 unknown proposal. */
  getFundProposal(transactionId: string, quiet = false): Promise<ApiResponse<{ settings: FundSettings; proposal: FundProposal }>> {
    return this.read('/get-fund-proposal', { transactionId }, quiet);
  }

  // --- the session's validator (wallet spec 8.3, 2026-11-10) --------------------

  /** The session's validator, picked now when none is set yet: one of the proxy's list, at random (Math.random is enough, nothing secret hangs on it). The attestor case pages name it after their posts (wallet spec 13.3). */
  async validator(): Promise<number> {
    const { validators } = await this.config.load();
    this.sessionValidator ??= 1 + Math.floor(Math.random() * validators);
    return this.sessionValidator;
  }

  /** A read: the call goes to the session's validator and waits at most VALIDATOR_READ_TIMEOUT_MS. An answer is returned. With no answer the session moves on and the call is made again on the validator it is on then, each validator at most once per call, so at most `validators` tries; when none answers, the last failure is returned. */
  private async read<T>(path: string, body: unknown, quiet = false): Promise<ApiResponse<T>> {
    const { validators } = await this.config.load();
    const asked = new Set<number>();
    let validator = await this.validator();
    let res: ApiResponse<T>;
    do {
      asked.add(validator);
      res = await this.log.post<T>(`/api/anos/${validator}${path}`, body, quiet, VALIDATOR_READ_TIMEOUT_MS);
      if (!noAnswer(res)) return res;
      this.moveOn(validator, validators);
      validator = await this.validator();
    } while (!asked.has(validator));
    return res;
  }

  /** A submission: one try on the session's validator, no time limit. With no answer the session moves on. The result is returned as it is: the wallet never sends a submission again on its own, since one that got no answer may still have been taken. */
  private async write<T>(path: string, body: unknown, quiet = false): Promise<ApiResponse<T>> {
    const { validators } = await this.config.load();
    const validator = await this.validator();
    const res = await this.log.post<T>(`/api/anos/${validator}${path}`, body, quiet);
    if (noAnswer(res)) this.moveOn(validator, validators);
    return res;
  }

  /** The session moves on from a validator that did not answer, to the next one in the list, the first after the last, and stays there. Only while it is still on that validator: calls that got no answer from the same validator at the same moment (the reads of a balance refresh) move the session on by one place between them, not by one each. */
  private moveOn(from: number, validators: number): void {
    if (this.sessionValidator === from) this.sessionValidator = (from % validators) + 1;
  }
}

/** True when a validator call got no answer (decision 4 of forclaude/wallet-round-robin-plan-1.md): status 0, nothing came back, because the network failed or a read ran into its time limit; 502, the wallet's proxy could not reach the validator's doorman, or the doorman its worker; 503, a validator that has just booted and is not counted yet; 504, the doorman got nothing from its worker in time. Every other status is an answer, a refusal and a 500 included. */
function noAnswer(res: ApiResponse<unknown>): boolean {
  return res.status === 0 || res.status === 502 || res.status === 503 || res.status === 504;
}
