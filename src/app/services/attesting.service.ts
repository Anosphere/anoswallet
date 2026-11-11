import { Injectable, effect, inject, signal } from '@angular/core';
import type { Words } from '../i18n/en';
import { AnosApiService, AssistedTransferItem, DisputedEscrowItem } from './anos-api.service';
import { BalancesService } from './balances.service';
import { CryptoService, HybridKeys, PairOne } from './crypto.service';
import { LanguageService } from './language.service';
import { ApiResponse, reasonOf } from './log.service';
import { AccountProfileItem, MasterpodApiService } from './masterpod-api.service';
import { AnosAccountItem, SessionService } from './session.service';

/** /list-anos-account-profiles takes at most this many ids in one call (masterpod 13.4.3). */
const PROFILE_IDS_PER_CALL = 200;

/**
 * The attestor's state for the session (wallet spec 13.4): the staked
 * account picked once per session (its keyBlob is opened per signature, as
 * the account page does, never kept open), the trade and dispute lists from
 * the session's validator with the people behind their account ids, and the
 * case pairs of the dispute cases while a page is open. Everything lives in
 * RAM and goes when the session closes.
 */
@Injectable({ providedIn: 'root' })
export class AttestingService {
  private readonly session = inject(SessionService);
  private readonly balances = inject(BalancesService);
  private readonly masterpod = inject(MasterpodApiService);
  private readonly anos = inject(AnosApiService);
  private readonly crypto = inject(CryptoService);
  private readonly lang = inject(LanguageService);

  /** The staked spending account that signs every validator read, keyholder pull and sign-off this session. */
  readonly accountId = signal('');
  /** The validator's two lists, as last fetched. */
  readonly trades = signal<AssistedTransferItem[]>([]);
  readonly disputes = signal<DisputedEscrowItem[]>([]);
  /** When the lists were last fetched; null before the first time. */
  readonly listedAt = signal<string | null>(null);
  /** The people behind the account ids of the lists, by account id. */
  readonly profiles = signal<ReadonlyMap<string, AccountProfileItem>>(new Map());

  /** The case pairs in RAM, by case id: the opener's at open, and the ones a case page opened from its wrapped key. */
  private readonly casePairs = new Map<string, HybridKeys>();

  constructor() {
    // A Lock, or another pod unlocking in this tab, drops everything here too.
    effect(() => {
      if (!this.session.hasSession()) this.clear();
    });
  }

  // --- the staked account ------------------------------------------------------

  /** The attestor's anos accounts, for the picker; the first usable spending one is picked when none is yet, a lost account (its keyBlob does not open, 2026-11-08) left out. */
  async loadAccounts(): Promise<void> {
    if (this.session.accounts().length === 0) {
      const res = await this.masterpod.listAnosAccounts(true);
      if (res.ok) this.session.accounts.set(res.body.accounts);
    }
    if (this.accountId() === '') {
      await this.balances.markLost();
      const accounts = this.balances.usableAccounts();
      const first = accounts.find((a) => a.accountType === 'spending') ?? accounts[0];
      if (first) this.accountId.set(first.accountId);
    }
  }

  /** The picked account and pair one out of its keyBlob, for one signature; the caller drops it. */
  async pairOne(): Promise<{ account: AnosAccountItem; pairOne: PairOne }> {
    const account = this.session.accounts().find((a) => a.accountId === this.accountId());
    const keyBlobKey = this.session.getKeyBlobKey();
    if (!account) throw new Error(this.lang.words().common.pickAccountFirst);
    if (!keyBlobKey) throw new Error(this.lang.words().common.noKeyBlobKey);
    return { account, pairOne: await this.crypto.pairOneFromKeyBlob(this.crypto.fromHex(account.keyBlob), keyBlobKey) };
  }

  // --- the lists -----------------------------------------------------------------

  /**
   * Both reads from the session's validator, signed by pair one of the staked
   * account, then /list-anos-account-profiles once for every account id not
   * yet known. Throws with the refusal in words.
   */
  async loadLists(quiet = false): Promise<void> {
    const { account, pairOne } = await this.pairOne();
    const [trades, disputes] = await Promise.all([
      this.anos.listAssistedTransfers(pairOne, account.accountId, quiet),
      this.anos.listDisputedEscrows(pairOne, account.accountId, quiet),
    ]);
    if (!trades.ok) throw new Error(validatorRefusal(trades, '/list-assisted-transfers', this.lang.words()));
    if (!disputes.ok) throw new Error(validatorRefusal(disputes, '/list-disputed-escrows', this.lang.words()));
    const ids = new Set<string>();
    for (const trade of trades.body.transfers) ids.add(trade.accountId);
    for (const escrow of disputes.body.escrows) {
      ids.add(escrow.accountId);
      ids.add(escrow.accountIdTo);
    }
    await this.loadProfiles([...ids], quiet);
    this.trades.set(trades.body.transfers);
    this.disputes.set(disputes.body.escrows);
    this.listedAt.set(new Date().toISOString());
  }

  /** The people behind account ids not yet known, in calls of at most 200 ids; an account the masterpod does not know is kept with its nulls. */
  private async loadProfiles(ids: string[], quiet: boolean): Promise<void> {
    const known = this.profiles();
    const missing = ids.filter((id) => !known.has(id));
    if (missing.length === 0) return;
    const next = new Map(known);
    for (let i = 0; i < missing.length; i += PROFILE_IDS_PER_CALL) {
      const res = await this.masterpod.listAnosAccountProfiles(missing.slice(i, i + PROFILE_IDS_PER_CALL), quiet);
      if (!res.ok) throw new Error(attestingError(res, '/list-anos-account-profiles', this.lang.words()));
      for (const item of res.body.profiles) next.set(item.accountId, item);
    }
    this.profiles.set(next);
  }

  /** The trade of the list with this transaction id, or null when the validator no longer lists it (decided, or cancelled). */
  tradeOf(transactionId: string): AssistedTransferItem | null {
    return this.trades().find((trade) => trade.transactionId === transactionId) ?? null;
  }

  /** The disputed escrow of the list with this transaction id, or null. */
  disputeOf(transactionId: string): DisputedEscrowItem | null {
    return this.disputes().find((escrow) => escrow.transactionId === transactionId) ?? null;
  }

  /** The person behind an account id, or null when the lists never carried it. */
  profileOf(accountId: string): AccountProfileItem | null {
    return this.profiles().get(accountId) ?? null;
  }

  // --- the case pairs -------------------------------------------------------------

  /** Keeps a dispute case's pair while its page is open (the opener's at open; a page's once opened from its wrapped key). */
  setCasePair(caseId: string, keys: HybridKeys): void {
    this.dropCasePair(caseId);
    this.casePairs.set(caseId, keys);
  }

  getCasePair(caseId: string): HybridKeys | null {
    return this.casePairs.get(caseId) ?? null;
  }

  /** Zeroes and forgets a case's pair: what a case page does when it is left. */
  dropCasePair(caseId: string): void {
    const keys = this.casePairs.get(caseId);
    if (!keys) return;
    keys.x25519Secret.fill(0);
    keys.kemSeed.fill(0);
    keys.kemSecret.fill(0);
    this.casePairs.delete(caseId);
  }

  /** Drops everything: the session closed. */
  clear(): void {
    for (const caseId of [...this.casePairs.keys()]) this.dropCasePair(caseId);
    this.accountId.set('');
    this.trades.set([]);
    this.disputes.set([]);
    this.listedAt.set(null);
    this.profiles.set(new Map());
  }
}

/** The masterpod's 403 not an attestor in words (wallet spec 13.2), from the dictionary `words`; other refusals as they are. */
export function attestingError(res: ApiResponse<unknown>, path: string, words: Words): string {
  if (res.status === 403 && /not an attestor/.test(reasonOf(res))) return words.attesting.notAttestor;
  return `${path}: ${reasonOf(res)}`;
}

/** A validator read's refusal in words (anossoftware 13.1), from the dictionary `words`: the stake, the ledger; the rest as it is. */
export function validatorRefusal(res: ApiResponse<unknown>, path: string, words: Words): string {
  const reason = reasonOf(res);
  if (res.status === 403 && /not an attestor/.test(reason)) return words.attesting.noAttestorStake;
  if (res.status === 401 && /unknown account/.test(reason)) return words.common.notOnLedger;
  return `${path}: ${reason}`;
}
