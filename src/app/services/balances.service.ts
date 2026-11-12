import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { AnosApiService, EscrowItem, HeldAssistedTransfer, HeldLockedTransfer, PendingItem } from './anos-api.service';
import { CryptoService, KeyBlobLostError, STAKE_PURPOSES, StakePurpose } from './crypto.service';
import { LanguageService } from './language.service';
import { reasonOf } from './log.service';
import { BreakGlassCaseItem, BreakGlassMove, MasterpodApiService } from './masterpod-api.service';
import { AnosAccountItem, SessionService } from './session.service';

/** What is known about one account's anos (wallet spec 8.2, Wallet): the ledger's answer, what is spoken for and, since 2026-11-10, what is staked and the held items themselves, which the balance card's sheet lists. */
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
  /** The account's stake per purpose in millionths, the purposes above zero only, from stakes of the /get-account answer (anossoftware 25.1); empty while not landed or on a validator without the field (2026-11-10, the balance card). A stake is a transfer to the fund, so it is not part of balance. */
  stakes: Partial<Record<StakePurpose, bigint>>;
  /** The stakes added up. */
  staked: bigint;
  /** The open escrow trades counted in escrow, the ones this account sells in, as /list-escrows answers them; the balance sheet lists them (2026-11-10). */
  escrows: EscrowItem[];
  /** The held assisted transfer counted in assisted, as /get-assisted-transfer answers it; null when none is held. */
  assistedTransfer: HeldAssistedTransfer | null;
  /** The guarded or vault transfer counted in locked, as /get-locked-transfer answers it; null when none waits. */
  lockedTransfer: HeldLockedTransfer | null;
  /** The pending rows counted in pending, as /list-transactions answers them. */
  pendingTransfers: PendingItem[];
}

/** The pod's anos added up over its landed accounts, for the balance card. A lost account counts nowhere. */
export interface Totals {
  /** What the accounts hold on the ledger. The stakes are not in it: the card's big number is total plus staked. */
  total: bigint;
  available: bigint;
  held: bigint;
  pending: bigint;
  escrow: bigint;
  assisted: bigint;
  locked: bigint;
  /** What the accounts have staked with the fund (2026-11-10). */
  staked: bigint;
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
 * anos are spoken for, and available is what is left after them. Since
 * 2026-11-10 an entry also keeps the account's stakes, from the same
 * /get-account answer (a stake is a transfer to the fund, so it has left
 * the balance; the totals sum it apart, as staked), and the held items as
 * the reads answered them, for the balance card and its sheet. An
 * account whose keyBlob does not open is lost (its keys went with an old
 * passkey): its entry says so, nothing is read for it, it counts in no
 * total and no poll, and the pickers leave it out (usableAccounts); the
 * break-glass moves of the lost accounts are read with the balances
 * (moves, moveOf).
 *
 * Two reads (2026-11-11; the plan is forclaude/wallet-speed-plan-1.md).
 * refresh is the full read: every account of the session. poll is one
 * round of the 5-second read the two pages make while needsPoll, and it
 * reads the watched accounts only: the session's accounts that are not
 * lost and have no entry yet, an entry that is not on the ledger, or
 * anos held or pending, which is the test needsPoll makes, per account.
 * Until then a round was a full read, so one open trade on one account
 * made the page read every account every 5 seconds. A round runs under
 * busy, as a full read does, and returns at once while a read runs; with
 * no watched account it reads nothing; for another pod than the one last
 * read it is a quiet full read. After the reads of a round a full read
 * follows in two cases. One: the round changed landed, balance or held
 * in a watched account's entry, and the session has an account that is
 * not lost and was not read in the round; so a move between two of the
 * person's own accounts does not leave the total short for longer than
 * about one round. Two: a full read was asked for while the round ran.
 * refresh leaves word when it finds a round running, where it returns
 * when it finds another full read running, and the round runs that read
 * when it ends, quiet only when every refresh that left word was quiet.
 * Otherwise the round ends as a full read ends: the lost accounts' moves
 * when an account is lost, then readAt. While something is held on one
 * account, the other accounts are not read again by themselves: anos
 * that arrive on them show when Home or the Wallet page is next opened,
 * or with the card's refresh button, as it already is when nothing is
 * held. An account whose creation was never finished stays not on the
 * ledger, so it is still read every 5 seconds, alone now.
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
  /** The lost accounts' break-glass moves by the old account's id, from /list-my-break-glass-moves (masterpod 14.4.1), read by refresh, and by a poll round at its end, while an account is lost. */
  readonly moves = signal<Record<string, MoveState>>({});
  /** True while a read runs: a refresh or a poll round. */
  readonly busy = signal(false);
  /** When the last read finished, a refresh or a poll round; null until one has. */
  readonly readAt = signal<string | null>(null);

  /** The pod whose accounts were last read, so another pod's entries are cleared first. */
  private readPod: string | null = null;
  /** True while a poll round runs, from its reads to its end (poll). */
  private polling = false;
  /** The word a refresh leaves when it finds a poll round running: null while none did, else whether the full read the round runs when it ends is quiet, which it is only when every refresh that left word was. */
  private fullAsked: boolean | null = null;

  /** The sums over the landed accounts of session.accounts(), and the counts of the others; a lost account, and an entry for an account no longer in the session, does not count. */
  readonly totals = computed<Totals>(() => {
    const entries = this.byAccount();
    const totals: Totals = { total: 0n, available: 0n, held: 0n, pending: 0n, escrow: 0n, assisted: 0n, locked: 0n, staked: 0n, notLanded: 0, failed: 0 };
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
        totals.staked += entry.staked;
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
   * read clears the entries first. While a poll round runs (2026-11-11)
   * it leaves word and returns, and the round runs this read when it ends
   * (poll), quiet only when every refresh that left word was quiet.
   */
  async refresh(quiet = false): Promise<void> {
    if (this.polling) {
      this.fullAsked = (this.fullAsked ?? true) && quiet;
      return;
    }
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
   * One round of the 5-second read (2026-11-11), which Home and the Wallet
   * page make while needsPoll: the watched accounts only, read at the same
   * time and quietly, under busy. Watched are the session's accounts that
   * are not lost and have no entry yet, an entry that is not on the
   * ledger, or anos held or pending (isWatched); with none nothing is
   * read. Returns at once while a read runs, as refresh does. For another
   * pod than the one last read the round is a quiet refresh. After the
   * reads a full read follows, a refresh, in two cases: the round changed
   * landed, balance or held in a watched account's entry (entryChanged)
   * and the session has an account that is not lost and was not read in
   * the round; or a refresh left word while the round ran, and then the
   * read is quiet only when every such refresh was. Otherwise the round
   * ends as a refresh ends: the lost accounts' moves when an account is
   * lost, then readAt.
   */
  async poll(): Promise<void> {
    if (this.busy()) return;
    if (this.session.anopodId() !== this.readPod) {
      await this.refresh(true);
      return;
    }
    const before = this.byAccount();
    const accounts = this.session.accounts();
    const watched = accounts.filter((a) => isWatched(before[a.accountId]));
    if (watched.length === 0) return;
    let full: boolean | null = null;
    this.busy.set(true);
    this.polling = true;
    try {
      await Promise.all(watched.map((item) => this.readOne(item, true)));
      const after = this.byAccount();
      const changed = watched.some((a) => entryChanged(before[a.accountId], after[a.accountId]));
      const others = accounts.some((a) => !watched.includes(a) && !this.isLost(a.accountId));
      if (!(changed && others) && this.fullAsked === null) {
        if (accounts.some((a) => this.isLost(a.accountId))) await this.loadMoves(true);
        this.readAt.set(new Date().toISOString());
      }
      // Word may have been left during the moves' read too, so it is looked at last.
      if ((changed && others) || this.fullAsked !== null) full = this.fullAsked ?? true;
    } finally {
      this.polling = false;
      this.fullAsked = null;
      this.busy.set(false);
    }
    if (full !== null) await this.refresh(full);
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
          const pendingTransfers = list.ok ? list.body.pending : [];
          const pending = pendingTransfers.reduce((sum, p) => sum + BigInt(p.amount), 0n);
          const sold = escrows.ok ? escrows.body.escrows.filter((e) => e.accountId === id) : [];
          const escrow = sold.reduce((sum, e) => sum + BigInt(e.amount), 0n);
          const assistedTransfer = assisted?.ok ? assisted.body.transfer : null;
          const assistedHeld = assistedTransfer ? BigInt(assistedTransfer.amount) : 0n;
          const lockedTransfer = locked?.ok ? locked.body.transfer : null;
          const lockedHeld = lockedTransfer ? BigInt(lockedTransfer.amount) : 0n;
          const held = pending + escrow + assistedHeld + lockedHeld;
          const stakes = stakesOf(account.body.stakes);
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
            stakes,
            staked: STAKE_PURPOSES.reduce((sum, purpose) => sum + (stakes[purpose] ?? 0n), 0n),
            escrows: sold,
            assistedTransfer,
            lockedTransfer,
            pendingTransfers,
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

/** True for the entry of an account a poll round reads (2026-11-11): no entry yet, an entry that is not on the ledger, or anos held or pending, and never a lost one. It is the test needsPoll makes, for one account. */
function isWatched(entry: AccountBalance | undefined): boolean {
  return !entry?.lost && (!entry?.landed || entry.held > 0n);
}

/** True when a poll round's read changed landed, balance or held in an account's entry (2026-11-11): the account landed, its balance moved or its held amount changed. No entry before the read counts as not landed with nothing held. */
function entryChanged(before: AccountBalance | undefined, after: AccountBalance | undefined): boolean {
  return (before?.landed ?? false) !== (after?.landed ?? false) || (before?.balance ?? null) !== (after?.balance ?? null) || (before?.held ?? 0n) !== (after?.held ?? 0n);
}

/** The stakes of a /get-account answer as the entry keeps them: the purposes above zero, in millionths; empty when the answer has no stakes (a validator without the field). */
function stakesOf(answer: Record<StakePurpose, string> | undefined): Partial<Record<StakePurpose, bigint>> {
  const stakes: Partial<Record<StakePurpose, bigint>> = {};
  if (!answer) return stakes;
  for (const purpose of STAKE_PURPOSES) {
    const amount = BigInt(answer[purpose] ?? '0');
    if (amount > 0n) stakes[purpose] = amount;
  }
  return stakes;
}

/** The entry of an account /get-account did not answer for, or that could not be asked: nothing landed, nothing held, nothing staked. */
function notLanded(error: string): AccountBalance {
  return { landed: false, lost: false, balance: null, error, pending: 0n, escrow: 0n, assisted: 0n, locked: 0n, held: 0n, available: 0n, partial: false, guardianVotes: 0, stakes: {}, staked: 0n, escrows: [], assistedTransfer: null, lockedTransfer: null, pendingTransfers: [] };
}

/** The entry of a lost account (wallet spec 8.2): the keyBlob did not open under the key blob key, so nothing was read. */
function lost(): AccountBalance {
  return { ...notLanded(''), lost: true, error: null };
}
