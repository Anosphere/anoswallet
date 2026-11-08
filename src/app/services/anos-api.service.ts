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
  TransferToFundTransaction,
  Verdict,
} from './crypto.service';
import { ApiResponse, LogService } from './log.service';

/** What /get-account answers (wallet spec 5.4). */
export interface AccountAnswer {
  accountId: string;
  type: string;
  balance: string;
  latestTransactionId: string | null;
  createdAt: string;
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

/** One trade waiting for attestors, as /list-assisted-transfers answers it (anossoftware 13.2): attestorIds the attestations already in the slots, slot order. */
export interface AssistedTransferItem {
  transactionId: string;
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

/** The signer's own held assisted transfer, as /get-assisted-transfer answers it (anossoftware spec 17): accountId the sender, accountIdTo the receiver, attestations the slots holding one, 0, 1 or 2; unlocksAt (2026-11-08) the moment a break-glass move out of a guarded or vault account may be written, null for every other row. */
export interface HeldAssistedTransfer {
  transactionId: string;
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

/**
 * All HTTP calls to the validators (the anos test app's
 * account-api.service.ts, base path /api/anos/<defaultValidator>), plus the
 * five signed reads of the account level (/list-escrows: anossoftware 16,
 * /get-assisted-transfer: anossoftware 17, /get-locked-transfer and the
 * date range on /list-transactions: anossoftware 18) and the two attestor
 * reads (anossoftware 13, the account level plus attestor stake). One
 * method per endpoint; every one resolves to the status and the body,
 * never throws on an HTTP error.
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
    return this.post('/get-assisted-transfer', this.crypto.signAccountEnvelope(pairOne, accountId, '/get-assisted-transfer', {}), quiet);
  }

  /** POST /get-locked-transfer, signed by pair one: the account's own guarded or vault transfer waiting out its lock, or null when none is held (anossoftware spec 18). */
  getLockedTransfer(pairOne: PairOne, accountId: string, quiet = false): Promise<ApiResponse<{ transfer: HeldLockedTransfer | null }>> {
    return this.post('/get-locked-transfer', this.crypto.signAccountEnvelope(pairOne, accountId, '/get-locked-transfer', {}), quiet);
  }

  // --- the attestor reads (anossoftware 13.2): the account envelope as getAccount builds it, the signer staked for attestor ---

  /** POST /list-assisted-transfers: the trades waiting for attestors on this validator, newest first. */
  listAssistedTransfers(pairOne: PairOne, accountId: string, quiet = false): Promise<ApiResponse<{ transfers: AssistedTransferItem[] }>> {
    return this.post('/list-assisted-transfers', this.crypto.signAccountEnvelope(pairOne, accountId, '/list-assisted-transfers', {}), quiet);
  }

  /** POST /list-disputed-escrows: the disputed escrows no verdict has decided, newest first. */
  listDisputedEscrows(pairOne: PairOne, accountId: string, quiet = false): Promise<ApiResponse<{ escrows: DisputedEscrowItem[] }>> {
    return this.post('/list-disputed-escrows', this.crypto.signAccountEnvelope(pairOne, accountId, '/list-disputed-escrows', {}), quiet);
  }

  private async post<T>(path: string, body: unknown, quiet = false): Promise<ApiResponse<T>> {
    const { defaultValidator } = await this.config.load();
    return this.log.post<T>(`/api/anos/${defaultValidator}${path}`, body, quiet);
  }
}
