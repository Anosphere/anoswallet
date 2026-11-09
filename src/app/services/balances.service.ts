import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { AnosApiService } from './anos-api.service';
import { CryptoService, KeyBlobLostError } from './crypto.service';
import { LanguageService } from './language.service';
import { reasonOf } from './log.service';
import { BreakGlassCaseItem, BreakGlassMove, MasterpodApiService } from './masterpod-api.service';
import { AnosAccountItem, SessionService } from './session.service';

/** What is known about one account's anos (wallet spec 8.2, Wallet): the ledger's answer and what is spoken for. */
export interface AccountBalance {
  /** /get-account answered. */
  landed: boolean;
  /** The keyBlob does not open under the session's key blob key: the keys went with an old passkey (wallet spec 8.2, 2026-11-08). Nothing is read for it; landed is false and error null. */
  lost: boolean;
  /** Millionths, when landed. */
  balance: bigint | null;
  /** 'not landed yet' (401 unknown account), else the refusal; null when landed or lost. */
  error: string | null;
  /** The pending transfer's amount (the signer's own row, sent and not yet written). */
  pending: bigint;
  /** The open escrow trades where this account is the seller. */
  escrow: bigint;
  /** The held assisted transfer. */
  assisted: bigint;
  /** The guarded or vault transfer waiting out its lock. */
  locked: bigint;
  /** The four above added up. */
  held: bigint;
  /** Balance minus held, never below zero; zero while not landed. */
  available: bigint;
  /** Landed, but a held-amount read was refused, so held may be short. */
  partial: boolean;
  /** The account's guardian votes as /get-account answers them (anossoftware 25.1), 0 while not landed or on a validator without the field; Home's fund proposal line reads it (2026-11-08). */
  guardianVotes: number;
}

/** The pod's anos added up over its landed accounts, for the balance card. A lost account counts nowhere. */
export interface Totals {
  total: bigint;
  available: bigint;
  held: bigint;
  pending: bigint;
  escrow: bigint;
  assisted: bigint;
  locked: bigint;
  /** Accounts whose error is 'not landed yet', or not read yet. */
  notLanded: number;
  /** Accounts whose read was refused for another reason. */
  failed: number;
}

/**
 * Where a lost account's break-glass move stands (wallet spec 8.2, Wallet):
 * waiting (no attestor signed yet), signed (one of two), writing (the case
 * is decided, the validators have not written the link yet), moved (the new
 * account's history lists it), dismissed (the attestors dismissed the case).
 */
export type MoveStage = 'waiting' | 'signed' | 'writing' | 'moved' | 'dismissed';

/** A lost account's move as its card shows it: the stage, how many attestor pods signed, and the new account the money goes to. */
export interface MoveState {
  stage: MoveStage;
  signOffs: number;
  accountIdTo: string;
}

/**
 * The balances (wallet spec 8.2, Wallet, and 8.3): what Home and the
 * Wallet page share. One entry per account from /get-account,
 * /list-transactions (the pending row only), /list-escrows and, by the
 * account's type, /get-assisted-transfer or /get-locked-transfer, every
 * read signed by pair one, opened from the account's keyBlob with the
 * session's key blob key (2026-11-08) and dropped, as the pages do; the
 * totals over the session's accounts; needsPoll while an account is not
 * on the ledger yet or any anos are held or pending. The validator moves a
 * balance only when a transfer is written, so a balance stays whole while
 * anos are spoken for, and available is what is left after them. An
 * account whose keyBlob does not open is lost (its keys went with an old
 * passkey): its entry says so, nothing is read for it, it counts in no
 * total and no poll, and the pickers leave it out (usableAccounts); the
 * break-glass moves of the lost accounts are read with the balances
 * (moves, moveOf).
 */
@Injectable({ providedIn: 'root' })
export class BalancesService {
  private readonly session = inject(SessionService);
  private readonly anos = inject(AnosApiService);
  private readonly masterpod = inject(MasterpodApiService);
  private readonly crypto = inject(CryptoService);
  private readonly lang = inject(LanguageService);

  /** The entries by account id. */
  readonly byAccount = signal<Record<string, AccountBalance>>({});
  /** The lost accounts' break-glass moves by the old account's id, from /list-my-break-glass-moves (masterpod 14.4.1), read by refresh while an account is lost. */
  readonly moves = signal<Record<string, MoveState>>({});
  /** True while a refresh runs. */
  readonly busy = signal(false);
  /** When the last refresh finished; null until one has. */
  readonly readAt = signal<string | null>(null);

  /** The pod whose accounts were last read, so another pod's entries are cleared first. */
  private readPod: string | null = null;

  /** The sums over the landed accounts of session.accounts(), and the counts of the others; a lost account, and an entry for an account no longer in the session, does not count. */
  readonly totals = computed<Totals>(() => {
    const entries = this.byAccount();
    const totals: Totals = { total: 0n, available: 0n, held: 0n, pending: 0n, escrow: 0n, assisted: 0n, locked: 0n, notLanded: 0, failed: 0 };
    for (const account of this.session.accounts()) {
      const entry = entries[account.accountId];
      if (entry?.lost) continue;
      if (!entry || entry.error === 'not landed yet') {
        totals.notLanded += 1;
      } else if (!entry.landed) {
        totals.failed += 1;
      } else {
        totals.total += entry.balance ?? 0n;
        totals.available += entry.available;
        totals.held += entry.held;
        totals.pending += entry.pending;
        totals.escrow += entry.escrow;
        totals.assisted += entry.assisted;
        totals.locked += entry.locked;
      }
    }
    return totals;
  });

  /** True while an account is not on the ledger yet or any anos are held or pending: the pages read again every 5 seconds then. A lost account is neither. */
  readonly needsPoll = computed(() => {
    const entries = this.byAccount();
    return this.session.accounts().some((a) => !entries[a.accountId]?.landed && !entries[a.accountId]?.lost) || this.totals().held > 0n;
  });

  /** The session's accounts whose keyBlob opens: what a picker or a list of usable accounts shows (wallet spec 8.2). */
  readonly usableAccounts = computed(() => {
    const entries = this.byAccount();
    return this.session.accounts().filter((a) => !entries[a.accountId]?.lost);
  });

  constructor() {
    // The lost marks do not wait for a balance read: whenever the session's
    // account list changes, every keyBlob without an entry is tried under
    // the key blob key, no ledger read, so a picker leaves a lost account
    // out at once.
    effect(() => {
      const accounts = this.session.accounts();
      untracked(() => void this.markLost(accounts));
    });
  }

  /** True when the account's keyBlob did not open under the session's key blob key (wallet spec 8.2). */
  isLost(accountId: string): boolean {
    return this.byAccount()[accountId]?.lost === true;
  }

  /** The break-glass move listed for a lost account, or null while none is. */
  moveOf(accountId: string): MoveState | null {
    return this.moves()[accountId] ?? null;
  }

  /**
   * Tries every keyBlob without an entry under the key blob key, no ledger
   * read, and gives the accounts whose blob does not open the lost entry.
   * Runs whenever the session's accounts change; a page that picks a
   * default account awaits it first. Nothing without the key in RAM.
   */
  async markLost(accounts: AnosAccountItem[] = this.session.accounts()): Promise<void> {
    const keyBlobKey = this.session.getKeyBlobKey();
    if (!keyBlobKey) return;
    for (const item of accounts) {
      if (this.byAccount()[item.accountId]) continue;
      try {
        await this.crypto.unwrapKeyBlob(this.crypto.fromHex(item.keyBlob), keyBlobKey);
      } catch (err) {
        if (err instanceof KeyBlobLostError) this.byAccount.update((all) => ({ ...all, [item.accountId]: lost() }));
      }
    }
  }

  /**
   * Reads every account of the session at the same time and replaces its
   * entry, then the lost accounts' moves when there is a lost account;
   * returns at once while a refresh runs. Another pod than the one last
   * read clears the entries first.
   */
  async refresh(quiet = false): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      const pod = this.session.anopodId();
      if (pod !== this.readPod) {
        this.byAccount.set({});
        this.moves.set({});
        this.readPod = pod;
      }
      const accounts = this.session.accounts();
      await Promise.all(accounts.map((item) => this.readOne(item, quiet)));
      if (accounts.some((a) => this.isLost(a.accountId))) await this.loadMoves(quiet);
      this.readAt.set(new Date().toISOString());
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * One account's entry: pair one from the keyBlob, then together
   * /get-account, /list-transactions with limit 1 (for the pending row),
   * /list-escrows and, by the type, /get-assisted-transfer on an assisted
   * account or /get-locked-transfer on a guarded or vault one. A keyBlob
   * that does not open makes the lost entry; any other thrown error
   * becomes the entry's error.
   */
  private async readOne(item: AnosAccountItem, quiet: boolean): Promise<void> {
    const keyBlobKey = this.session.getKeyBlobKey();
    let entry: AccountBalance;
    if (!keyBlobKey) {
      entry = notLanded(this.lang.words().common.noKeyBlobKey);
    } else {
      try {
        const pairOne = await this.crypto.pairOneFromKeyBlob(this.crypto.fromHex(item.keyBlob), keyBlobKey);
        const id = item.accountId;
        const [account, list, escrows, assisted, locked] = await Promise.all([
          this.anos.getAccount(pairOne, id, quiet),
          this.anos.listTransactions(pairOne, id, { limit: 1 }, quiet),
          this.anos.listEscrows(pairOne, id, quiet),
          item.accountType === 'assisted' ? this.anos.getAssistedTransfer(pairOne, id, quiet) : null,
          item.accountType === 'guarded' || item.accountType === 'vault' ? this.anos.getLockedTransfer(pairOne, id, quiet) : null,
        ]);
        if (!account.ok) {
          entry = notLanded(account.status === 401 && /unknown account/.test(reasonOf(account)) ? 'not landed yet' : reasonOf(account));
        } else {
          const balance = BigInt(account.body.balance);
          const pending = list.ok ? list.body.pending.reduce((sum, p) => sum + BigInt(p.amount), 0n) : 0n;
          const escrow = escrows.ok ? escrows.body.escrows.filter((e) => e.accountId === id).reduce((sum, e) => sum + BigInt(e.amount), 0n) : 0n;
          const assistedHeld = assisted?.ok && assisted.body.transfer ? BigInt(assisted.body.transfer.amount) : 0n;
          const lockedHeld = locked?.ok && locked.body.transfer ? BigInt(locked.body.transfer.amount) : 0n;
          const held = pending + escrow + assistedHeld + lockedHeld;
          entry = {
            landed: true,
            lost: false,
            balance,
            error: null,
            pending,
            escrow,
            assisted: assistedHeld,
            locked: lockedHeld,
            held,
            available: balance > held ? balance - held : 0n,
            partial: !list.ok || !escrows.ok || (assisted !== null && !assisted.ok) || (locked !== null && !locked.ok),
            guardianVotes: account.body.guardianVotes ?? 0,
          };
        }
      } catch (err) {
        entry = err instanceof KeyBlobLostError ? lost() : notLanded(err instanceof Error ? err.message : String(err));
      }
    }
    this.byAccount.update((all) => ({ ...all, [item.accountId]: entry }));
  }

  /**
   * The lost accounts' moves (wallet spec 8.2, Wallet): /list-my-break-glass-moves,
   * one state per old account, the newest case's when an account is in
   * several. The stage comes from the case (dismissed; decided is being
   * written; otherwise the sign-offs so far) and, for a decided case, from
   * the new account's history: its first page of /list-transactions, signed
   * by its pair one, says moved once it lists the move's transaction id. A
   * refused list keeps the states already shown.
   */
  async loadMoves(quiet = false): Promise<void> {
    const res = await this.masterpod.listMyBreakGlassMoves(quiet);
    if (!res.ok) return;
    const states: Record<string, MoveState> = {};
    for (const c of res.body.cases) {
      for (const move of c.moves) {
        if (states[move.accountId]) continue;
        states[move.accountId] = { stage: await this.stageOf(c, move), signOffs: c.signOffs, accountIdTo: move.accountIdTo };
      }
    }
    this.moves.set(states);
  }

  private async stageOf(c: BreakGlassCaseItem, move: BreakGlassMove): Promise<MoveStage> {
    if (c.status === 'dismissed') return 'dismissed';
    if (c.status !== 'decided') return c.signOffs > 0 ? 'signed' : 'waiting';
    return (await this.landedIn(move.accountIdTo, move.transactionId)) ? 'moved' : 'writing';
  }

  /** True when the new account's history (its first page, newest first) lists the move: the money has landed. False when the account is not in the session, its keyBlob does not open, or the read fails. */
  private async landedIn(accountIdTo: string, transactionId: string): Promise<boolean> {
    const item = this.session.accounts().find((a) => a.accountId === accountIdTo);
    const keyBlobKey = this.session.getKeyBlobKey();
    if (!item || !keyBlobKey) return false;
    try {
      const pairOne = await this.crypto.pairOneFromKeyBlob(this.crypto.fromHex(item.keyBlob), keyBlobKey);
      const list = await this.anos.listTransactions(pairOne, accountIdTo, {}, true);
      return list.ok && list.body.transactions.some((t) => t.transactionId === transactionId);
    } catch {
      return false;
    }
  }
}

/** The entry of an account /get-account did not answer for, or that could not be asked: nothing landed, nothing held. */
function notLanded(error: string): AccountBalance {
  return { landed: false, lost: false, balance: null, error, pending: 0n, escrow: 0n, assisted: 0n, locked: 0n, held: 0n, available: 0n, partial: false, guardianVotes: 0 };
}

/** The entry of a lost account (wallet spec 8.2): the keyBlob did not open under the key blob key, so nothing was read. */
function lost(): AccountBalance {
  return { ...notLanded(''), lost: true, error: null };
}
