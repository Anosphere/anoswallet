import { Injectable, inject } from '@angular/core';
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

/** Where a locked transfer is, as the validator names it (anossoftware spec 18.2). A word the wallet does not know is shown as held with no action. */
export type LockedStage = 'waiting' | 'locked' | 'due';

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
 * account-api.service.ts, base path /api/anos/<defaultValidator>), plus the
 * five signed reads of the account level (/list-escrows: anossoftware 16,
 * /get-assisted-transfer: anossoftware 17, /get-locked-transfer and the
 * date range on /list-transactions: anossoftware 18), the two attestor
 * reads (anossoftware 13, the account level plus attestor stake) and, since
 * 2026-11-08, the two public fund proposal reads (anossoftware 25), the
 * wallet's first unsigned posts to a validator. One method per endpoint;
 * every one resolves to the status and the body, never throws on an HTTP
 * error.
 */
@Injectable({ providedIn: 'root' })
export class AnosApiService {
  private readonly log = inject(LogService);
  private readonly config = inject(ConfigService);
  private readonly crypto = inject(CryptoService);

  /** POST /create-account. */
  createAccount(tx: CreateAccountTransaction): Promise<ApiResponse<Accepted>> {
    return this.post('/create-account', tx);
  }

  /** POST /anos-transfer: any of the six transfer types, the breakGlassTransfer of the recovery's finish included (2026-11-08). */
  anosTransfer(tx: AnosTransferTransaction): Promise<ApiResponse<Accepted>> {
    return this.post('/anos-transfer', tx);
  }

  /** POST /transfer-to-fund: a stake. */
  transferToFund(tx: TransferToFundTransaction): Promise<ApiResponse<Accepted>> {
    return this.post('/transfer-to-fund', tx);
  }

  /** POST /fund-proposal. */
  fundProposal(tx: FundProposalTransaction): Promise<ApiResponse<Accepted>> {
    return this.post('/fund-proposal', tx);
  }

  /** POST /attestation. */
  attestation(followUp: FollowUp<AttestationPayload>): Promise<ApiResponse<Accepted>> {
    return this.post('/attestation', followUp);
  }

  /** POST /assisted-transfer-cancel. */
  assistedTransferCancel(followUp: FollowUp<AssistedTransferCancelPayload>): Promise<ApiResponse<Accepted>> {
    return this.post('/assisted-transfer-cancel', followUp);
  }

  /** POST /guardian-vote. */
  guardianVote(followUp: FollowUp<GuardianVotePayload>): Promise<ApiResponse<Accepted>> {
    return this.post('/guardian-vote', followUp);
  }

  /** POST /escrow-signature: a success, cancel or dispute signature, or a verdict, by payload.type. */
  escrowSignature(followUp: FollowUp<EscrowSignaturePayload> | FollowUp<EscrowVerdictPayload>): Promise<ApiResponse<Accepted>> {
    return this.post('/escrow-signature', followUp);
  }

  // --- the account level (wallet spec 5.3, 5.4) --------------------------------

  /** POST /get-account, signed by pair one. */
  getAccount(pairOne: PairOne, accountId: string, quiet = false): Promise<ApiResponse<AccountAnswer>> {
    return this.getAccountAs(this.crypto.signAccountEnvelope(pairOne, accountId, '/get-account', {}), quiet);
  }

  /** POST /get-account with an envelope the caller signed: pair one's (getAccount) or, since 2026-11-08, the break-glass pair's (CryptoService.signAccountEnvelopeAsBreakGlass), which the validator accepts when pair one does not verify (anossoftware spec 22), so the recovery's finish reads a lost account's balance and latest transaction id with the recovered seed. */
  getAccountAs(envelope: Envelope, quiet = false): Promise<ApiResponse<AccountAnswer>> {
    return this.post('/get-account', envelope, quiet);
  }

  /** POST /list-transactions, signed by pair one; from and to (ISO 8601) cut the list to a date range (anossoftware spec 18.3). */
  listTransactions(pairOne: PairOne, accountId: string, body: { beforePosition?: number; limit?: number; from?: string; to?: string } = {}, quiet = false): Promise<ApiResponse<TransactionsAnswer>> {
    return this.post('/list-transactions', this.crypto.signAccountEnvelope(pairOne, accountId, '/list-transactions', body), quiet);
  }

  /** POST /list-escrows, signed by pair one: the account's open escrow trades as seller or buyer, newest first (anossoftware spec 16). */
  listEscrows(pairOne: PairOne, accountId: string, quiet = false): Promise<ApiResponse<{ escrows: EscrowItem[] }>> {
    return this.post('/list-escrows', this.crypto.signAccountEnvelope(pairOne, accountId, '/list-escrows', {}), quiet);
  }

  /** POST /get-assisted-transfer, signed by pair one: the account's own held assisted transfer, or null when none is held (anossoftware spec 17). */
  getAssistedTransfer(pairOne: PairOne, accountId: string, quiet = false): Promise<ApiResponse<{ transfer: HeldAssistedTransfer | null }>> {
    return this.getAssistedTransferAs(this.crypto.signAccountEnvelope(pairOne, accountId, '/get-assisted-transfer', {}), quiet);
  }

  /** POST /get-assisted-transfer with an envelope the caller signed: pair one's (getAssistedTransfer) or, since 2026-11-10, the break-glass pair's (CryptoService.signAccountEnvelopeAsBreakGlass), which the validator accepts when pair one does not verify (anossoftware spec 22), so the recovery's finish asks with the recovered seed whether a break-glass move is already held for a lost account, and reads its transaction id and the account it goes to. */
  getAssistedTransferAs(envelope: Envelope, quiet = false): Promise<ApiResponse<{ transfer: HeldAssistedTransfer | null }>> {
    return this.post('/get-assisted-transfer', envelope, quiet);
  }

  /** POST /get-locked-transfer, signed by pair one: the account's own guarded or vault transfer waiting out its lock, or null when none is held (anossoftware spec 18). */
  getLockedTransfer(pairOne: PairOne, accountId: string, quiet = false): Promise<ApiResponse<{ transfer: HeldLockedTransfer | null }>> {
    return this.post('/get-locked-transfer', this.crypto.signAccountEnvelope(pairOne, accountId, '/get-locked-transfer', {}), quiet);
  }

  // --- the attestor reads (anossoftware 13.2): the account envelope as getAccount builds it, the signer staked for attestor ---

  /** POST /list-assisted-transfers: the trades and, since 2026-11-08, the break-glass moves waiting for attestors on this validator, newest first, told apart by type. */
  listAssistedTransfers(pairOne: PairOne, accountId: string, quiet = false): Promise<ApiResponse<{ transfers: AssistedTransferItem[] }>> {
    return this.post('/list-assisted-transfers', this.crypto.signAccountEnvelope(pairOne, accountId, '/list-assisted-transfers', {}), quiet);
  }

  /** POST /list-disputed-escrows: the disputed escrows no verdict has decided, newest first. */
  listDisputedEscrows(pairOne: PairOne, accountId: string, quiet = false): Promise<ApiResponse<{ escrows: DisputedEscrowItem[] }>> {
    return this.post('/list-disputed-escrows', this.crypto.signAccountEnvelope(pairOne, accountId, '/list-disputed-escrows', {}), quiet);
  }

  // --- the public reads (anossoftware 25): no envelope, no signature, the plain body as the object ---

  /** POST /list-fund-proposals: the open fund proposal (one at most) or the decided ones, with the validator's settings; a validator or a doorman without the route answers 404. */
  listFundProposals(filters: FundListFilters, quiet = false): Promise<ApiResponse<{ settings: FundSettings; proposals: FundProposalItem[] }>> {
    return this.post('/list-fund-proposals', filters, quiet);
  }

  /** POST /get-fund-proposal: one fund proposal with its payouts, open or archived, with the settings; 404 unknown proposal. */
  getFundProposal(transactionId: string, quiet = false): Promise<ApiResponse<{ settings: FundSettings; proposal: FundProposal }>> {
    return this.post('/get-fund-proposal', { transactionId }, quiet);
  }

  private async post<T>(path: string, body: unknown, quiet = false): Promise<ApiResponse<T>> {
    const { defaultValidator } = await this.config.load();
    return this.log.post<T>(`/api/anos/${defaultValidator}${path}`, body, quiet);
  }
}
