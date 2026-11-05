import { DatePipe } from '@angular/common';
import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatListModule } from '@angular/material/list';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { RouterLink } from '@angular/router';
import { anosToMillionths, millionthsToAnos } from '../amounts';
import { ACCOUNT_POLL_MS, GUARDED_LOCK_MINUTES, LOCK_OFFSET_MINUTES, VAULT_LOCK_MINUTES } from '../constants';
import { escrowStageWords } from '../escrow-stage';
import { AccountAnswer, Accepted, AnosApiService, EscrowItem, PendingItem, TransactionItem } from '../services/anos-api.service';
import {
  AccountType,
  CryptoService,
  FollowUp,
  PairOne,
  Payout,
  STAKE_PURPOSES,
  StakePurpose,
  TransferType,
  Vote,
} from '../services/crypto.service';
import { ApiResponse, reasonOf } from '../services/log.service';
import { MasterpodApiService } from '../services/masterpod-api.service';
import { AnosAccountItem, SessionService } from '../services/session.service';
import { SigningService } from '../services/signing.service';

/** What an account of each type sends, and how many minutes ahead of now to date it (the local constants). */
const TRANSFERS: Record<AccountType, { transactionType: TransferType; minutesAhead: number }> = {
  spending: { transactionType: 'anosTransfer', minutesAhead: 0 },
  guarded: { transactionType: 'guardedAnosTransfer', minutesAhead: GUARDED_LOCK_MINUTES + LOCK_OFFSET_MINUTES },
  vault: { transactionType: 'vaultAnosTransfer', minutesAhead: VAULT_LOCK_MINUTES + LOCK_OFFSET_MINUTES },
  assisted: { transactionType: 'assistedAnosTransfer', minutesAhead: 0 },
};

/** What a spending account's Send does: a plain transfer, an escrow transfer, or a stake with the fund. */
const SPENDING_KINDS = ['plain', 'escrow', 'stake'] as const;
type SpendingKind = (typeof SPENDING_KINDS)[number];

/** One row of the fund proposal form; amounts in anos, purpose empty for a plain payout. */
interface PayoutRow {
  accountIdTo: string;
  amount: string;
  reason: string;
  stakeFor: StakePurpose | '';
}

interface Outcome {
  ok: boolean;
  text: string;
}

/**
 * One account (wallet spec 8.2, Account): balance, type, the latest
 * transaction id, the transaction list from /list-transactions (newest
 * first, Load more with beforePosition), the pending transaction if any,
 * Refresh, and a 5-second poll while something is pending. Send: recipient
 * account id, amount in anos, and the kind the account type allows; guarded
 * and vault date the transfer lock + offset ahead. previousTransactionId is
 * /get-account's latestTransactionId, fetched right before building. The
 * payload is signed by pair one (keyBlob opened for the signature and
 * dropped), /api/sign adds the wallet pair, the validator gets it, the list
 * refreshes. Send is disabled while the account has a pending transaction
 * or is the seller of an open escrow trade (one held transaction per
 * account). Escrow trades (2026-11-05, section 11): /list-escrows is read
 * with the other two, the open trades are listed between Pending and
 * Transactions with the stage in words from this account's side, a line
 * under the balance says what is held as the seller, and the 5-second poll
 * also runs while a trade is open; the escrow follow-ups left the
 * follow-ups form for the trade page (step 3). The other follow-ups and
 * the fund proposal form are the test wallet's.
 */
@Component({
  selector: 'app-account-page',
  imports: [DatePipe, FormsModule, RouterLink, MatCardModule, MatButtonModule, MatListModule, MatIconModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatProgressBarModule, MatExpansionModule],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>Account <code class="id">{{ accountId() }}</code></mat-card-title>
        <mat-card-subtitle>
          @if (item(); as item) { {{ item.accountType }} account }
          @if (!item()) { not one of this anoPod's accounts }
        </mat-card-subtitle>
      </mat-card-header>
      <mat-card-content>
        <p><a mat-button routerLink="/wallet"><mat-icon>arrow_back</mat-icon> Wallet</a></p>
        @if (account(); as a) {
          <div class="summary">
            <div><span class="label">Balance</span><span class="value">{{ millionthsToAnos(a.balance) }} anos</span></div>
            @if (heldAsSeller(); as held) {
              <div><span class="label"></span><span class="value muted">{{ held }} anos of this are in an open escrow trade.</span></div>
            }
            <div><span class="label">Type</span><span class="value">{{ a.type }}</span></div>
            <div><span class="label">Latest transaction</span><code class="value">{{ a.latestTransactionId ?? 'none' }}</code></div>
            <div><span class="label">Created</span><span class="value">{{ a.createdAt | date: 'medium' }}</span></div>
          </div>
        } @else if (readError(); as text) {
          <p class="error">{{ text }}</p>
        } @else {
          <mat-progress-bar mode="indeterminate"></mat-progress-bar>
        }
        <div class="row">
          <button mat-stroked-button type="button" (click)="refresh()" [disabled]="busy()">Refresh</button>
          @if (pending().length > 0) {
            <span class="muted">A transaction is pending; refreshing every 5 seconds.</span>
          } @else if (escrows().length > 0) {
            <span class="muted">An escrow trade is open; refreshing every 5 seconds.</span>
          }
        </div>

        @if (pending().length > 0) {
          <h3>Pending</h3>
          <mat-list>
            @for (p of pending(); track p.transactionId) {
              <mat-list-item lines="2">
                <mat-icon matListItemIcon>hourglass_top</mat-icon>
                <span matListItemTitle>{{ p.type }} · {{ millionthsToAnos(p.amount) }} anos · {{ p.approved ? 'approved by every validator' : 'waiting for approval' }}</span>
                <span matListItemLine><code>{{ p.transactionId }}</code> → <code>{{ p.accountIdTo ?? '' }}</code></span>
              </mat-list-item>
            }
          </mat-list>
        }

        <h3>Escrow trades</h3>
        @if (escrowsError(); as text) {
          <p class="error">{{ text }}</p>
        }
        <mat-list>
          @for (e of escrows(); track e.transactionId) {
            <mat-list-item lines="2">
              <mat-icon matListItemIcon>{{ e.accountId === accountId() ? 'call_made' : 'call_received' }}</mat-icon>
              <a matListItemTitle [routerLink]="['/wallet', accountId(), 'escrow', e.transactionId]">{{ millionthsToAnos(e.amount) }} anos {{ e.accountId === accountId() ? 'to' : 'from' }} <code>{{ e.accountId === accountId() ? e.accountIdTo : e.accountId }}</code></a>
              <span matListItemLine>{{ stageWords(e) }} · {{ e.createdAt | date: 'medium' }}</span>
            </mat-list-item>
          } @empty {
            @if (!escrowsError()) {
              <p class="muted">No open escrow trades.</p>
            }
          }
        </mat-list>

        <h3>Transactions</h3>
        <mat-list>
          @for (t of transactions(); track t.transactionId) {
            <mat-list-item lines="3">
              <mat-icon matListItemIcon>{{ t.type === 'accountCreation' ? 'add_circle' : t.accountId === accountId() ? 'call_made' : 'call_received' }}</mat-icon>
              <span matListItemTitle>{{ t.type }} · {{ t.type === 'accountCreation' ? '' : (t.accountId === accountId() ? '−' : '+') + millionthsToAnos(t.amount) + ' anos' }} · #{{ t.position }}</span>
              <span matListItemLine>{{ t.createdAt | date: 'medium' }}@if (counterpart(t); as other) { · {{ t.accountId === accountId() ? 'to' : 'from' }} <code>{{ other }}</code> }</span>
              <span matListItemLine><code>{{ t.transactionId }}</code></span>
            </mat-list-item>
          } @empty {
            <p class="muted">Nothing on the ledger for this account yet.</p>
          }
        </mat-list>
        @if (canLoadMore()) {
          <button mat-button type="button" (click)="loadMore()" [disabled]="busy()">Load more</button>
        }

        <h3>Send</h3>
        @if (item(); as item) {
          <div class="form">
            @if (item.accountType === 'spending') {
              <mat-form-field appearance="outline">
                <mat-label>Kind</mat-label>
                <mat-select [value]="spendingKind()" (valueChange)="spendingKind.set($event)">
                  @for (kind of spendingKinds; track kind) { <mat-option [value]="kind">{{ kind }}</mat-option> }
                </mat-select>
              </mat-form-field>
              @if (spendingKind() === 'stake') {
                <mat-form-field appearance="outline">
                  <mat-label>Stake for</mat-label>
                  <mat-select [value]="stakePurpose()" (valueChange)="stakePurpose.set($event)">
                    @for (purpose of stakePurposes; track purpose) { <mat-option [value]="purpose">{{ purpose }}</mat-option> }
                  </mat-select>
                </mat-form-field>
              }
            }
            @if (transferType() !== 'transferToFund') {
              <mat-form-field appearance="outline" class="wide">
                <mat-label>Recipient account id</mat-label>
                <input matInput [ngModel]="accountIdTo()" (ngModelChange)="accountIdTo.set($event)" placeholder="64 hex characters" />
              </mat-form-field>
            }
            <mat-form-field appearance="outline">
              <mat-label>Amount (anos)</mat-label>
              <input matInput [ngModel]="amount()" (ngModelChange)="amount.set($event)" placeholder="1 or 0.5" />
            </mat-form-field>
            <button mat-flat-button type="button" (click)="send()" [disabled]="busy() || pending().length > 0 || sellerEscrowOpen() || !canSend()">Send {{ transferType() }}</button>
          </div>
          @if (sellerEscrowOpen()) {
            <p class="muted">An escrow trade is open. This account can send again when it closes.</p>
          }
          @if (item.accountType === 'guarded' || item.accountType === 'vault') {
            <p class="muted">A {{ item.accountType }} transfer is dated {{ minutesAhead(item.accountType) }} minutes ahead and waits out its lock on the validators.</p>
          }
          @if (sendOutcome(); as o) { <p [class.error]="!o.ok" [class.ok]="o.ok">{{ o.text }}</p> }
        }

        <mat-accordion class="followups">
          <mat-expansion-panel>
            <mat-expansion-panel-header><mat-panel-title>Follow-ups, signed by this account</mat-panel-title></mat-expansion-panel-header>
            <div class="form">
              <mat-form-field appearance="outline" class="wide"><mat-label>Assisted transfer transactionId</mat-label><input matInput [ngModel]="attestTransactionId()" (ngModelChange)="attestTransactionId.set($event)" /></mat-form-field>
              <mat-form-field appearance="outline" class="wide"><mat-label>Sender accountId</mat-label><input matInput [ngModel]="attestAccountId()" (ngModelChange)="attestAccountId.set($event)" /></mat-form-field>
              <button mat-stroked-button type="button" (click)="sendAttestation()" [disabled]="busy() || !attestTransactionId().trim() || !attestAccountId().trim()">Send attestation</button>
            </div>
            <div class="form">
              <mat-form-field appearance="outline" class="wide"><mat-label>This account's assisted transfer transactionId</mat-label><input matInput [ngModel]="cancelTransactionId()" (ngModelChange)="cancelTransactionId.set($event)" /></mat-form-field>
              <button mat-stroked-button type="button" (click)="sendCancel()" [disabled]="busy() || !cancelTransactionId().trim()">Send assistedTransferCancel</button>
            </div>
            <div class="form">
              <mat-form-field appearance="outline" class="wide"><mat-label>Fund proposal transactionId</mat-label><input matInput [ngModel]="voteTransactionId()" (ngModelChange)="voteTransactionId.set($event)" /></mat-form-field>
              <mat-form-field appearance="outline"><mat-label>Vote</mat-label>
                <mat-select [value]="vote()" (valueChange)="vote.set($event)"><mat-option value="for">for</mat-option><mat-option value="against">against</mat-option></mat-select>
              </mat-form-field>
              <button mat-stroked-button type="button" (click)="sendVote()" [disabled]="busy() || !voteTransactionId().trim()">Send guardianVote</button>
            </div>
            @if (followUpOutcome(); as o) { <p [class.error]="!o.ok" [class.ok]="o.ok">{{ o.text }}</p> }
          </mat-expansion-panel>

          <mat-expansion-panel>
            <mat-expansion-panel-header><mat-panel-title>Fund proposal, by this account as guardian</mat-panel-title></mat-expansion-panel-header>
            @for (row of payouts(); track $index) {
              <div class="form">
                <mat-form-field appearance="outline" class="wide"><mat-label>Recipient accountId</mat-label><input matInput [ngModel]="row.accountIdTo" (ngModelChange)="updatePayout($index, 'accountIdTo', $event)" /></mat-form-field>
                <mat-form-field appearance="outline"><mat-label>Amount (anos)</mat-label><input matInput [ngModel]="row.amount" (ngModelChange)="updatePayout($index, 'amount', $event)" /></mat-form-field>
                <mat-form-field appearance="outline"><mat-label>Reason</mat-label><input matInput [ngModel]="row.reason" (ngModelChange)="updatePayout($index, 'reason', $event)" /></mat-form-field>
                <mat-form-field appearance="outline"><mat-label>Returns stake</mat-label>
                  <mat-select [value]="row.stakeFor" (valueChange)="updatePayout($index, 'stakeFor', $event)">
                    <mat-option value="">no</mat-option>
                    @for (purpose of stakePurposes; track purpose) { <mat-option [value]="purpose">{{ purpose }}</mat-option> }
                  </mat-select>
                </mat-form-field>
                <button mat-icon-button type="button" (click)="removePayout($index)" [disabled]="payouts().length === 1" aria-label="Remove"><mat-icon>close</mat-icon></button>
              </div>
            }
            <div class="row">
              <button mat-button type="button" (click)="addPayout()">Add payout</button>
              <button mat-flat-button type="button" (click)="sendFundProposal()" [disabled]="busy()">Send fundProposal</button>
            </div>
            @if (proposalOutcome(); as o) { <p [class.error]="!o.ok" [class.ok]="o.ok">{{ o.text }}</p> }
          </mat-expansion-panel>
        </mat-accordion>
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    .id { font-size: 13px; }
    .summary { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 8px 0 16px; }
    .summary div { display: contents; }
    .label { color: var(--mat-sys-on-surface-variant); }
    .value { word-break: break-all; }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 8px 0; }
    .form { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 4px; }
    .wide { min-width: 360px; flex: 1; }
    .followups { display: block; margin-top: 16px; }
    .muted { color: var(--mat-sys-on-surface-variant); }
    .error { color: var(--mat-sys-error); }
    .ok { color: var(--mat-sys-primary); }
    code { font-size: 12px; word-break: break-all; }
  `,
})
export class AccountPage {
  readonly accountId = input.required<string>();

  private readonly session = inject(SessionService);
  private readonly masterpod = inject(MasterpodApiService);
  private readonly anos = inject(AnosApiService);
  private readonly crypto = inject(CryptoService);
  private readonly signing = inject(SigningService);

  protected readonly millionthsToAnos = millionthsToAnos;
  protected readonly spendingKinds = SPENDING_KINDS;
  protected readonly stakePurposes = STAKE_PURPOSES;

  protected readonly item = computed(() => this.session.accounts().find((a) => a.accountId === this.accountId()) ?? null);
  protected readonly account = signal<AccountAnswer | null>(null);
  protected readonly transactions = signal<TransactionItem[]>([]);
  protected readonly pending = signal<PendingItem[]>([]);
  protected readonly escrows = signal<EscrowItem[]>([]);
  protected readonly escrowsError = signal<string | null>(null);
  protected readonly canLoadMore = signal(false);
  protected readonly readError = signal<string | null>(null);
  protected readonly busy = signal(false);

  protected readonly spendingKind = signal<SpendingKind>('plain');
  protected readonly stakePurpose = signal<StakePurpose>('attestor');
  protected readonly accountIdTo = signal('');
  protected readonly amount = signal('1');
  protected readonly sendOutcome = signal<Outcome | null>(null);

  protected readonly attestTransactionId = signal('');
  protected readonly attestAccountId = signal('');
  protected readonly cancelTransactionId = signal('');
  protected readonly voteTransactionId = signal('');
  protected readonly vote = signal<Vote>('for');
  protected readonly followUpOutcome = signal<Outcome | null>(null);

  protected readonly payouts = signal<PayoutRow[]>([{ accountIdTo: '', amount: '', reason: '', stakeFor: '' }]);
  protected readonly proposalOutcome = signal<Outcome | null>(null);

  /** The transaction type Send makes, from the account type and the spending kind. */
  protected readonly transferType = computed((): string => {
    const type = this.item()?.accountType as AccountType | undefined;
    if (type === 'spending') {
      const kind = this.spendingKind();
      return kind === 'stake' ? 'transferToFund' : kind === 'escrow' ? 'escrowTransfer' : 'anosTransfer';
    }
    return type ? TRANSFERS[type].transactionType : 'anosTransfer';
  });

  protected readonly canSend = computed(() => {
    if (anosToMillionths(this.amount()) === null) return false;
    return this.transferType() === 'transferToFund' || /^[0-9a-f]{64}$/i.test(this.accountIdTo().trim());
  });

  /** True while an open escrow trade has this account as the seller: the validator holds one transaction per account, so Send waits. */
  protected readonly sellerEscrowOpen = computed(() => this.escrows().some((e) => e.accountId === this.accountId()));

  /** The anos of this account held in open escrow trades as the seller (one, by the validator's rule), for the line under the balance; null when none. */
  protected readonly heldAsSeller = computed((): string | null => {
    const held = this.escrows().filter((e) => e.accountId === this.accountId()).reduce((sum, e) => sum + BigInt(e.amount), 0n);
    return held > 0n ? millionthsToAnos(held) : null;
  });

  constructor() {
    effect(() => {
      this.accountId();
      untracked(() => void this.refresh());
    });
    const timer = setInterval(() => {
      if ((this.pending().length > 0 || this.escrows().length > 0) && !this.busy()) void this.refresh(true);
    }, ACCOUNT_POLL_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  protected minutesAhead(type: AccountType): number {
    return TRANSFERS[type].minutesAhead;
  }

  protected counterpart(t: TransactionItem): string | null {
    return t.accountId === this.accountId() ? t.accountIdTo : t.accountId;
  }

  /** The stage of an open escrow trade in words, from this account's side (escrow-stage.ts, shared with the trade page). */
  protected stageWords(e: EscrowItem): string {
    return escrowStageWords(e.stage, e.accountId === this.accountId() ? 'seller' : 'buyer');
  }

  /** Pair one, opened from the keyBlob for one signature; the caller drops it. */
  private async pairOne(): Promise<PairOne> {
    let item = this.item();
    if (!item) {
      const res = await this.masterpod.listAnosAccounts(true);
      if (res.ok) this.session.accounts.set(res.body.accounts);
      item = this.item();
    }
    const encryptionKey = this.session.getEncryptionKey();
    if (!item) throw new Error('This account is not one of this anoPod\'s accounts');
    if (!encryptionKey) throw new Error('The encryption key is not in RAM: unlock again');
    return this.crypto.pairOneFromKeyBlob(this.crypto.fromHex(item.keyBlob), encryptionKey);
  }

  /** /get-account, the first page of /list-transactions and /list-escrows. A refused escrow read is shown on its own, so the rest of the page still shows. */
  protected async refresh(quiet = false): Promise<void> {
    this.readError.set(null);
    try {
      const pairOne = await this.pairOne();
      const [account, list, escrows] = await Promise.all([
        this.anos.getAccount(pairOne, this.accountId(), quiet),
        this.anos.listTransactions(pairOne, this.accountId(), {}, quiet),
        this.anos.listEscrows(pairOne, this.accountId(), quiet),
      ]);
      if (!account.ok) {
        this.readError.set(account.status === 401 && /unknown account/.test(reasonOf(account)) ? 'Not on the ledger yet: the creation has not landed.' : `/get-account: ${reasonOf(account)}`);
        return;
      }
      this.account.set(account.body);
      if (list.ok) {
        this.transactions.set(list.body.transactions);
        this.pending.set(list.body.pending);
        this.canLoadMore.set(list.body.transactions.length >= 50);
      }
      if (escrows.ok) {
        this.escrows.set(escrows.body.escrows);
        this.escrowsError.set(null);
      } else {
        this.escrowsError.set(`/list-escrows: ${reasonOf(escrows)}`);
      }
    } catch (err) {
      this.readError.set(err instanceof Error ? err.message : String(err));
    }
  }

  protected async loadMore(): Promise<void> {
    const last = this.transactions().at(-1);
    if (!last) return;
    this.busy.set(true);
    try {
      const pairOne = await this.pairOne();
      const res = await this.anos.listTransactions(pairOne, this.accountId(), { beforePosition: last.position });
      if (res.ok) {
        this.transactions.update((list) => [...list, ...res.body.transactions]);
        this.canLoadMore.set(res.body.transactions.length >= 50);
      }
    } finally {
      this.busy.set(false);
    }
  }

  /** Builds, signs (pair one here, the wallet pair at /api/sign) and posts what the account type allows. */
  protected async send(): Promise<void> {
    const item = this.item();
    const amount = anosToMillionths(this.amount());
    if (!item || amount === null) return;
    await this.act(this.sendOutcome, async () => {
      const pairOne = await this.pairOne();
      const latest = await this.anos.getAccount(pairOne, this.accountId(), true);
      if (!latest.ok || !latest.body.latestTransactionId) throw new Error('No latest transaction on the ledger yet');
      const previous = latest.body.latestTransactionId;
      const type = item.accountType as AccountType;
      let res: ApiResponse<Accepted>;
      if (type === 'spending' && this.spendingKind() === 'stake') {
        const tx = await this.signing.sign(this.crypto.buildTransferToFund(pairOne, this.accountId(), previous, amount, this.stakePurpose()));
        res = await this.anos.transferToFund(tx);
      } else {
        const transactionType = this.transferType() as TransferType;
        const createdAt = new Date(Date.now() + TRANSFERS[type].minutesAhead * 60_000);
        const tx = await this.signing.sign(this.crypto.buildAnosTransferTransaction(pairOne, this.accountId(), previous, this.accountIdTo().trim().toLowerCase(), amount, transactionType, createdAt));
        res = await this.anos.anosTransfer(tx);
      }
      if (!res.ok) throw new Error(reasonOf(res));
      return `accepted: ${res.body.transactionId}`;
    });
    await this.refresh(true);
  }

  protected sendAttestation(): Promise<void> {
    return this.followUp((pairOne, own) => this.crypto.buildFollowUp(pairOne, { type: 'attestation', transactionId: this.attestTransactionId().trim(), accountId: this.attestAccountId().trim(), attestorId: own }), (f) => this.anos.attestation(f));
  }

  protected sendCancel(): Promise<void> {
    return this.followUp((pairOne, own) => this.crypto.buildFollowUp(pairOne, { type: 'assistedTransferCancel', transactionId: this.cancelTransactionId().trim(), accountId: own }), (f) => this.anos.assistedTransferCancel(f));
  }

  protected sendVote(): Promise<void> {
    return this.followUp((pairOne, own) => this.crypto.buildFollowUp(pairOne, { type: 'guardianVote', transactionId: this.voteTransactionId().trim(), guardianId: own, vote: this.vote() }), (f) => this.anos.guardianVote(f));
  }

  private followUp<T extends FollowUp>(build: (pairOne: PairOne, own: string) => T, post: (signed: T) => Promise<ApiResponse<Accepted>>): Promise<void> {
    return this.act(this.followUpOutcome, async () => {
      const pairOne = await this.pairOne();
      const signed = await this.signing.sign(build(pairOne, this.accountId()));
      const res = await post(signed);
      if (!res.ok) throw new Error(reasonOf(res));
      return `${signed.payload.type} accepted for ${res.body.transactionId}`;
    });
  }

  protected addPayout(): void {
    this.payouts.update((rows) => [...rows, { accountIdTo: '', amount: '', reason: '', stakeFor: '' }]);
  }

  protected removePayout(index: number): void {
    this.payouts.update((rows) => rows.filter((_, i) => i !== index));
  }

  protected updatePayout(index: number, field: keyof PayoutRow, value: string): void {
    this.payouts.update((rows) => rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
  }

  protected sendFundProposal(): Promise<void> {
    return this.act(this.proposalOutcome, async () => {
      const payouts: Payout[] = [];
      for (const [i, row] of this.payouts().entries()) {
        const amount = anosToMillionths(row.amount);
        if (amount === null) throw new Error(`Payout ${i + 1}: the amount must be anos with up to six decimals`);
        const payout: Payout = { accountIdTo: row.accountIdTo.trim(), amount: amount.toString(), reason: row.reason };
        if (row.stakeFor !== '') payout.stakeFor = row.stakeFor;
        payouts.push(payout);
      }
      const pairOne = await this.pairOne();
      const tx = await this.signing.sign(this.crypto.buildFundProposal(pairOne, this.accountId(), payouts));
      const res = await this.anos.fundProposal(tx);
      if (!res.ok) throw new Error(reasonOf(res));
      return `fund proposal accepted: ${res.body.transactionId}`;
    });
  }

  private async act(outcome: ReturnType<typeof signal<Outcome | null>>, action: () => Promise<string>): Promise<void> {
    this.busy.set(true);
    outcome.set(null);
    try {
      outcome.set({ ok: true, text: await action() });
    } catch (err) {
      outcome.set({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      this.busy.set(false);
    }
  }
}

/** Keeps the AnosAccountItem import meaningful for readers of the template's item(). */
export type { AnosAccountItem };
