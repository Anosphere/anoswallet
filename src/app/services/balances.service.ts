import { Injectable, computed, inject, signal } from '@angular/core';
import { AnosApiService } from './anos-api.service';
import { CryptoService } from './crypto.service';
import { LanguageService } from './language.service';
import { reasonOf } from './log.service';
import { AnosAccountItem, SessionService } from './session.service';

/** What is known about one account's anos (wallet spec 8.2, Wallet): the ledger's answer and what is spoken for. */
export interface AccountBalance {
  /** /get-account answered. */
  landed: boolean;
  /** Millionths, when landed. */
  balance: bigint | null;
  /** 'not landed yet' (401 unknown account), else the refusal; null when landed. */
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
}

/** The pod's anos added up over its landed accounts, for the balance card. */
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
 * The balances (wallet spec 8.2, Wallet, and 8.3): what Home and the
 * Wallet page share. One entry per account from /get-account,
 * /list-transactions (the pending row only), /list-escrows and, by the
 * account's type, /get-assisted-transfer or /get-locked-transfer, every
 * read signed by pair one, opened from the account's keyBlob with the
 * encryption key and dropped, as the pages do; the totals over the
 * session's accounts; needsPoll while an account is not on the ledger yet
 * or any anos are held or pending. The validator moves a balance only when
 * a transfer is written, so a balance stays whole while anos are spoken
 * for, and available is what is left after them.
 */
@Injectable({ providedIn: 'root' })
export class BalancesService {
  private readonly session = inject(SessionService);
  private readonly anos = inject(AnosApiService);
  private readonly crypto = inject(CryptoService);
  private readonly lang = inject(LanguageService);

  /** The entries by account id. */
  readonly byAccount = signal<Record<string, AccountBalance>>({});
  /** True while a refresh runs. */
  readonly busy = signal(false);
  /** When the last refresh finished; null until one has. */
  readonly readAt = signal<string | null>(null);

  /** The pod whose accounts were last read, so another pod's entries are cleared first. */
  private readPod: string | null = null;

  /** The sums over the landed accounts of session.accounts(), and the counts of the others; an entry for an account no longer in the session does not count. */
  readonly totals = computed<Totals>(() => {
    const entries = this.byAccount();
    const totals: Totals = { total: 0n, available: 0n, held: 0n, pending: 0n, escrow: 0n, assisted: 0n, locked: 0n, notLanded: 0, failed: 0 };
    for (const account of this.session.accounts()) {
      const entry = entries[account.accountId];
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

  /** True while an account is not on the ledger yet or any anos are held or pending: the pages read again every 5 seconds then. */
  readonly needsPoll = computed(() => {
    const entries = this.byAccount();
    return this.session.accounts().some((a) => !entries[a.accountId]?.landed) || this.totals().held > 0n;
  });

  /**
   * Reads every account of the session at the same time and replaces its
   * entry; returns at once while a refresh runs. Another pod than the one
   * last read clears the entries first.
   */
  async refresh(quiet = false): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      const pod = this.session.anopodId();
      if (pod !== this.readPod) {
        this.byAccount.set({});
        this.readPod = pod;
      }
      await Promise.all(this.session.accounts().map((item) => this.readOne(item, quiet)));
      this.readAt.set(new Date().toISOString());
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * One account's entry: pair one from the keyBlob, then together
   * /get-account, /list-transactions with limit 1 (for the pending row),
   * /list-escrows and, by the type, /get-assisted-transfer on an assisted
   * account or /get-locked-transfer on a guarded or vault one. A thrown
   * error (a bad keyBlob) becomes the entry's error.
   */
  private async readOne(item: AnosAccountItem, quiet: boolean): Promise<void> {
    const encryptionKey = this.session.getEncryptionKey();
    let entry: AccountBalance;
    if (!encryptionKey) {
      entry = notLanded(this.lang.words().common.noKeyInRam);
    } else {
      try {
        const pairOne = await this.crypto.pairOneFromKeyBlob(this.crypto.fromHex(item.keyBlob), encryptionKey);
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
            balance,
            error: null,
            pending,
            escrow,
            assisted: assistedHeld,
            locked: lockedHeld,
            held,
            available: balance > held ? balance - held : 0n,
            partial: !list.ok || !escrows.ok || (assisted !== null && !assisted.ok) || (locked !== null && !locked.ok),
          };
        }
      } catch (err) {
        entry = notLanded(err instanceof Error ? err.message : String(err));
      }
    }
    this.byAccount.update((all) => ({ ...all, [item.accountId]: entry }));
  }
}

/** The entry of an account /get-account did not answer for, or that could not be asked: nothing landed, nothing held. */
function notLanded(error: string): AccountBalance {
  return { landed: false, balance: null, error, pending: 0n, escrow: 0n, assisted: 0n, locked: 0n, held: 0n, available: 0n, partial: false };
}
