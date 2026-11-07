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
import { assistedStageWords } from '../assisted-stage';
import { CopyButtonComponent } from '../components/copy-button.component';
import { ACCOUNT_POLL_MS } from '../constants';
import { escrowStageWords } from '../escrow-stage';
import { lockedStageWords } from '../locked-stage';
import { AccountAnswer, Accepted, AnosApiService, EscrowItem, HeldAssistedTransfer, HeldLockedTransfer, PendingItem } from '../services/anos-api.service';
import { ConfigService } from '../services/config.service';
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
import { LanguageService } from '../services/language.service';
import { ApiResponse, reasonOf } from '../services/log.service';
import { MasterpodApiService } from '../services/masterpod-api.service';
import { AnosAccountItem, SessionService } from '../services/session.service';
import { SigningService } from '../services/signing.service';

/** What an account of each type sends. A guarded or vault transfer is dated the lock plus the offset ahead by the proxy's numbers (minutesAhead). */
const TRANSFER_TYPES: Record<AccountType, TransferType> = {
  spending: 'anosTransfer',
  guarded: 'guardedAnosTransfer',
  vault: 'vaultAnosTransfer',
  assisted: 'assistedAnosTransfer',
};

/** What a spending account's Send does: a plain transfer, an escrow transfer, or a stake with the fund. */
const SPENDING_KINDS = ['plain', 'escrow', 'stake'] as const;

/** Exactly 64 hex characters with no hex character on either side: an account id in whatever was copied. */
const ACCOUNT_ID_IN_TEXT = /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/i;
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
 * One account (wallet spec 8.2, Account), in this order: the id in the
 * title with a copy button (8.5); balance, type, the latest transaction id,
 * created; Refresh, and a 5-second poll while something is pending, an
 * escrow trade is open or an assisted transfer is waiting; Send; Pending;
 * Escrow trades; Assisted transfer, on an assisted account; a Transaction
 * history button to /wallet/:accountId/history (2026-11-05, section 11: the
 * transaction list moved there; /list-transactions is still read here for
 * the pending list); then the follow-ups and the fund proposal panels.
 * Send: recipient account id (typed, or the 64 hex characters on the
 * clipboard by the paste button), amount in anos, and the kind the account
 * type allows; guarded and vault date the transfer lock + offset ahead by
 * the numbers /api/config gives (the proxy's env, wallet spec 2;
 * 2026-11-06, section 11), and Send waits with a line while those have
 * not loaded.
 * previousTransactionId is /get-account's latestTransactionId, fetched
 * right before building. The payload is signed by pair one (keyBlob opened
 * for the signature and dropped), /api/sign adds the wallet pair, the
 * validator gets it, the page refreshes. Send is disabled while the account
 * has a pending transaction, is the seller of an open escrow trade or holds
 * an assisted transfer (one held transaction per account). Escrow trades
 * (2026-11-05, section 11): /list-escrows is read with the other two, the
 * open trades are listed with the stage in words from this account's side,
 * and a line under the balance says what is held as the seller; the escrow
 * follow-ups left the follow-ups form for the trade page. Assisted transfer
 * (2026-11-06, section 11): on an assisted account /get-assisted-transfer
 * is read with the other three, the held transfer is one row linking to
 * its page, with the stage in words, and a line under the balance says
 * what is waiting; the attestation and the assisted cancel forms left the
 * follow-ups panel too (the attestor's trade case page posts the
 * attestation, the transfer page the cancel). Locked transfer (2026-11-06,
 * section 11): on a guarded or vault account /get-locked-transfer is read
 * with the others; the transfer waiting out its lock is one row with no
 * link, since nothing can be done with it, with the stage in words and
 * its unlock moment, and a line under the balance says what is waiting
 * out the lock. The guardian vote form and the fund proposal form are the
 * test wallet's.
 */
@Component({
  selector: 'app-account-page',
  imports: [FormsModule, RouterLink, MatCardModule, MatButtonModule, MatListModule, MatIconModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatProgressBarModule, MatExpansionModule, CopyButtonComponent],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>{{ t().common.account }} <code class="id">{{ accountId() }}</code> <app-copy-button [text]="accountId()" [label]="t().common.copyAccountId" /></mat-card-title>
        <mat-card-subtitle>
          @if (item(); as item) { {{ t().account.title(item.accountType) }} }
          @if (!item()) { {{ t().account.notMine }} }
        </mat-card-subtitle>
      </mat-card-header>
      <mat-card-content>
        <p><a mat-button routerLink="/wallet"><mat-icon>arrow_back</mat-icon> {{ t().nav.wallet }}</a></p>
        @if (account(); as a) {
          <div class="summary">
            <div><span class="label">{{ t().account.balance }}</span><span class="value">{{ t().common.anos(millionthsToAnos(a.balance)) }}</span></div>
            @if (heldAsSeller(); as held) {
              <div><span class="label"></span><span class="value muted">{{ t().account.heldInEscrow(held) }}</span></div>
            }
            @if (assisted(); as held) {
              <div><span class="label"></span><span class="value muted">{{ t().account.heldInAssisted(millionthsToAnos(held.amount)) }}</span></div>
            }
            @if (locked(); as waiting) {
              <div><span class="label"></span><span class="value muted">{{ t().account.heldInLock(millionthsToAnos(waiting.amount)) }}</span></div>
            }
            <div><span class="label">{{ t().common.type }}</span><span class="value">{{ a.type }}</span></div>
            <div><span class="label">{{ t().account.latestTransaction }}</span><code class="value">{{ a.latestTransactionId ?? t().account.none }}</code></div>
            <div><span class="label">{{ t().account.created }}</span><span class="value">{{ lang.dateTime(a.createdAt) }}</span></div>
          </div>
        } @else if (readError(); as text) {
          <p class="error">{{ text }}</p>
        } @else {
          <mat-progress-bar mode="indeterminate"></mat-progress-bar>
        }
        <div class="row">
          <button mat-stroked-button type="button" (click)="refresh()" [disabled]="busy()">{{ t().common.refresh }}</button>
          @if (pending().length > 0) {
            <span class="muted">{{ t().account.pendingRefreshing }}</span>
          } @else if (escrows().length > 0) {
            <span class="muted">{{ t().account.escrowRefreshing }}</span>
          } @else if (assisted()) {
            <span class="muted">{{ t().account.assistedRefreshing }}</span>
          } @else if (locked()) {
            <span class="muted">{{ t().account.lockedRefreshing }}</span>
          }
        </div>

        <h3>{{ t().account.send }}</h3>
        @if (item(); as item) {
          <div class="form send">
            @if (item.accountType === 'spending') {
              <mat-form-field appearance="outline">
                <mat-label>{{ t().common.kind }}</mat-label>
                <mat-select [value]="spendingKind()" (valueChange)="spendingKind.set($event)">
                  @for (kind of spendingKinds; track kind) { <mat-option [value]="kind">{{ t().account.spendingKinds[kind] }}</mat-option> }
                </mat-select>
              </mat-form-field>
              @if (spendingKind() === 'stake') {
                <mat-form-field appearance="outline">
                  <mat-label>{{ t().account.stakeFor }}</mat-label>
                  <mat-select [value]="stakePurpose()" (valueChange)="stakePurpose.set($event)">
                    @for (purpose of stakePurposes; track purpose) { <mat-option [value]="purpose">{{ t().account.stakePurposes[purpose] }}</mat-option> }
                  </mat-select>
                </mat-form-field>
              }
            }
            @if (transferType() !== 'transferToFund') {
              <mat-form-field appearance="outline" class="wide" subscriptSizing="dynamic">
                <mat-label>{{ t().account.recipient }}</mat-label>
                <input matInput [ngModel]="accountIdTo()" (ngModelChange)="accountIdTo.set($event)" [placeholder]="t().account.recipientPlaceholder" />
                <button mat-icon-button matSuffix type="button" (click)="pasteRecipient()" [attr.aria-label]="t().account.pasteRecipient"><mat-icon>content_paste</mat-icon></button>
                @if (pasteNote(); as note) { <mat-hint>{{ note }}</mat-hint> }
              </mat-form-field>
            }
            <mat-form-field appearance="outline">
              <mat-label>{{ t().account.amountAnos }}</mat-label>
              <input matInput [ngModel]="amount()" (ngModelChange)="amount.set($event)" [placeholder]="t().account.amountPlaceholder" />
            </mat-form-field>
            <button mat-flat-button type="button" (click)="send()" [disabled]="busy() || pending().length > 0 || sellerEscrowOpen() || assisted() !== null || locked() !== null || minutesAhead() === null || !canSend()">{{ t().account.send }} {{ transferType() }}</button>
          </div>
          @if (sellerEscrowOpen()) {
            <p class="muted">{{ t().account.escrowOpen }}</p>
          }
          @if (assisted()) {
            <p class="muted">{{ t().account.assistedWaiting }}</p>
          }
          @if (locked()) {
            <p class="muted">{{ t().account.lockWaiting }}</p>
          }
          @if (item.accountType === 'guarded' || item.accountType === 'vault') {
            @if (minutesAhead(); as ahead) {
              <p class="muted">{{ t().account.lockLine(item.accountType, t().minutes(ahead)) }}</p>
            } @else {
              <p class="muted">{{ t().account.lockNotLoaded }}</p>
            }
          } @else if (item.accountType === 'assisted') {
            <p class="muted">{{ t().account.assistedHint }}</p>
          }
          @if (sendOutcome(); as o) { <p [class.error]="!o.ok" [class.ok]="o.ok">{{ o.text }}</p> }
        }

        @if (pending().length > 0) {
          <h3>{{ t().account.pending }}</h3>
          <mat-list>
            @for (p of pending(); track p.transactionId) {
              <mat-list-item lines="2">
                <mat-icon matListItemIcon>hourglass_top</mat-icon>
                <span matListItemTitle>{{ p.type }} · {{ t().common.anos(millionthsToAnos(p.amount)) }} · {{ p.approved ? t().account.approved : t().account.waitingApproval }}</span>
                <span matListItemLine><code>{{ p.transactionId }}</code> → <code>{{ p.accountIdTo ?? '' }}</code></span>
              </mat-list-item>
            }
          </mat-list>
        }

        <h3>{{ t().account.escrowTrades }}</h3>
        @if (escrowsError(); as text) {
          <p class="error">{{ text }}</p>
        }
        <mat-list>
          @for (e of escrows(); track e.transactionId) {
            <mat-list-item lines="2">
              <mat-icon matListItemIcon>{{ e.accountId === accountId() ? 'call_made' : 'call_received' }}</mat-icon>
              <a matListItemTitle [routerLink]="['/wallet', accountId(), 'escrow', e.transactionId]">{{ t().common.anos(millionthsToAnos(e.amount)) }} {{ e.accountId === accountId() ? t().account.to : t().account.from }} <code>{{ e.accountId === accountId() ? e.accountIdTo : e.accountId }}</code></a>
              <span matListItemLine>{{ stageWords(e) }} · {{ lang.dateTime(e.createdAt) }}</span>
            </mat-list-item>
          } @empty {
            @if (!escrowsError()) {
              <p class="muted">{{ t().account.noEscrows }}</p>
            }
          }
        </mat-list>

        @if (item()?.accountType === 'assisted') {
          <h3>{{ t().common.assistedTransfer }}</h3>
          @if (assistedError(); as text) {
            <p class="error">{{ text }}</p>
          } @else if (assisted(); as held) {
            <mat-list>
              <mat-list-item lines="2">
                <mat-icon matListItemIcon>call_made</mat-icon>
                <a matListItemTitle [routerLink]="['/wallet', accountId(), 'assisted', held.transactionId]">{{ t().common.anos(millionthsToAnos(held.amount)) }} {{ t().account.to }} <code>{{ held.accountIdTo }}</code></a>
                <span matListItemLine>{{ assistedStageWords(held.stage, t().assistedStages) }} · {{ lang.dateTime(held.createdAt) }}</span>
              </mat-list-item>
            </mat-list>
          } @else {
            <p class="muted">{{ t().account.noTransferWaiting }}</p>
          }
        }

        @if (item()?.accountType === 'guarded' || item()?.accountType === 'vault') {
          <h3>{{ t().account.lockedTransfer }}</h3>
          @if (lockedError(); as text) {
            <p class="error">{{ text }}</p>
          } @else if (locked(); as waiting) {
            <mat-list>
              <mat-list-item lines="2">
                <mat-icon matListItemIcon>lock_clock</mat-icon>
                <span matListItemTitle>{{ t().common.anos(millionthsToAnos(waiting.amount)) }} {{ t().account.to }} <code>{{ waiting.accountIdTo }}</code></span>
                <span matListItemLine>
                  @if (waiting.stage === 'locked') {
                    {{ t().account.waitingOutLockUntil(lang.dateTime(waiting.unlocksAt)) }}
                  } @else {
                    {{ lockedStageWords(waiting.stage, t().lockedStages) }} · {{ lang.dateTime(waiting.createdAt) }}
                  }
                </span>
              </mat-list-item>
            </mat-list>
          } @else {
            <p class="muted">{{ t().account.noTransferWaiting }}</p>
          }
        }

        <p><a mat-stroked-button [routerLink]="['/wallet', accountId(), 'history']"><mat-icon>history</mat-icon> {{ t().common.transactionHistory }}</a></p>

        <mat-accordion class="followups">
          <mat-expansion-panel>
            <mat-expansion-panel-header><mat-panel-title>{{ t().account.followUps }}</mat-panel-title></mat-expansion-panel-header>
            <div class="form">
              <mat-form-field appearance="outline" class="wide"><mat-label>Fund proposal transactionId</mat-label><input matInput [ngModel]="voteTransactionId()" (ngModelChange)="voteTransactionId.set($event)" /></mat-form-field>
              <mat-form-field appearance="outline"><mat-label>{{ t().account.vote }}</mat-label>
                <mat-select [value]="vote()" (valueChange)="vote.set($event)"><mat-option value="for">{{ t().account.votes['for'] }}</mat-option><mat-option value="against">{{ t().account.votes['against'] }}</mat-option></mat-select>
              </mat-form-field>
              <button mat-stroked-button type="button" (click)="sendVote()" [disabled]="busy() || !voteTransactionId().trim()">Send guardianVote</button>
            </div>
            @if (followUpOutcome(); as o) { <p [class.error]="!o.ok" [class.ok]="o.ok">{{ o.text }}</p> }
          </mat-expansion-panel>

          <mat-expansion-panel>
            <mat-expansion-panel-header><mat-panel-title>{{ t().account.fundProposal }}</mat-panel-title></mat-expansion-panel-header>
            @for (row of payouts(); track $index) {
              <div class="form">
                <mat-form-field appearance="outline" class="wide"><mat-label>Recipient accountId</mat-label><input matInput [ngModel]="row.accountIdTo" (ngModelChange)="updatePayout($index, 'accountIdTo', $event)" /></mat-form-field>
                <mat-form-field appearance="outline"><mat-label>{{ t().account.amountAnos }}</mat-label><input matInput [ngModel]="row.amount" (ngModelChange)="updatePayout($index, 'amount', $event)" /></mat-form-field>
                <mat-form-field appearance="outline"><mat-label>{{ t().common.reason }}</mat-label><input matInput [ngModel]="row.reason" (ngModelChange)="updatePayout($index, 'reason', $event)" /></mat-form-field>
                <mat-form-field appearance="outline"><mat-label>{{ t().account.returnsStake }}</mat-label>
                  <mat-select [value]="row.stakeFor" (valueChange)="updatePayout($index, 'stakeFor', $event)">
                    <mat-option value="">{{ t().account.no }}</mat-option>
                    @for (purpose of stakePurposes; track purpose) { <mat-option [value]="purpose">{{ t().account.stakePurposes[purpose] }}</mat-option> }
                  </mat-select>
                </mat-form-field>
                <button mat-icon-button type="button" (click)="removePayout($index)" [disabled]="payouts().length === 1" [attr.aria-label]="t().common.remove"><mat-icon>close</mat-icon></button>
              </div>
            }
            <div class="row">
              <button mat-button type="button" (click)="addPayout()">{{ t().account.addPayout }}</button>
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
    .send { align-items: flex-start; }
    .send > button { margin-top: 8px; }
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
  private readonly config = inject(ConfigService);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  protected readonly millionthsToAnos = millionthsToAnos;
  protected readonly assistedStageWords = assistedStageWords;
  protected readonly lockedStageWords = lockedStageWords;
  protected readonly spendingKinds = SPENDING_KINDS;
  protected readonly stakePurposes = STAKE_PURPOSES;

  protected readonly item = computed(() => this.session.accounts().find((a) => a.accountId === this.accountId()) ?? null);
  protected readonly account = signal<AccountAnswer | null>(null);
  protected readonly pending = signal<PendingItem[]>([]);
  protected readonly escrows = signal<EscrowItem[]>([]);
  protected readonly escrowsError = signal<string | null>(null);
  protected readonly assisted = signal<HeldAssistedTransfer | null>(null);
  protected readonly assistedError = signal<string | null>(null);
  protected readonly locked = signal<HeldLockedTransfer | null>(null);
  protected readonly lockedError = signal<string | null>(null);
  protected readonly readError = signal<string | null>(null);
  protected readonly busy = signal(false);

  protected readonly spendingKind = signal<SpendingKind>('plain');
  protected readonly stakePurpose = signal<StakePurpose>('attestor');
  protected readonly accountIdTo = signal('');
  protected readonly pasteNote = signal<string | null>(null);
  protected readonly amount = signal('1');
  protected readonly sendOutcome = signal<Outcome | null>(null);

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
    return type ? TRANSFER_TYPES[type] : 'anosTransfer';
  });

  protected readonly canSend = computed(() => {
    if (anosToMillionths(this.amount()) === null) return false;
    return this.transferType() === 'transferToFund' || /^[0-9a-f]{64}$/i.test(this.accountIdTo().trim());
  });

  /** How many minutes ahead Send dates a transfer: 0 on a spending or assisted account; the lock plus the offset on a guarded or vault account, from the proxy's numbers (/api/config, wallet spec 2); null while those have not loaded. */
  protected readonly minutesAhead = computed((): number | null => {
    const type = this.item()?.accountType;
    if (type !== 'guarded' && type !== 'vault') return 0;
    const c = this.config.config();
    const lock = type === 'guarded' ? c?.guardedLockMinutes : c?.vaultLockMinutes;
    const offset = c?.lockOffsetMinutes;
    return typeof lock === 'number' && typeof offset === 'number' ? lock + offset : null;
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
      if ((this.pending().length > 0 || this.escrows().length > 0 || this.assisted() !== null || this.locked() !== null) && !this.busy()) void this.refresh(true);
    }, ACCOUNT_POLL_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  /** The stage of an open escrow trade in words, from this account's side (escrow-stage.ts, shared with the trade page). */
  protected stageWords(e: EscrowItem): string {
    return escrowStageWords(e.stage, e.accountId === this.accountId() ? 'seller' : 'buyer', this.t().escrowStages);
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
    if (!item) throw new Error(this.t().common.notMyAccount);
    if (!encryptionKey) throw new Error(this.t().common.noKeyInRam);
    return this.crypto.pairOneFromKeyBlob(this.crypto.fromHex(item.keyBlob), encryptionKey);
  }

  /** /get-account, the first page of /list-transactions (for the pending list; the history page shows the transactions), /list-escrows and, on an assisted account, /get-assisted-transfer, or, on a guarded or vault account, /get-locked-transfer, and the proxy's config for the lock numbers. A refused escrow, assisted or locked read is shown on its own, so the rest of the page still shows. */
  protected async refresh(quiet = false): Promise<void> {
    this.readError.set(null);
    // the lock numbers (minutesAhead): the shell loads the config at start; this asks again after a failure, when the page opens and on Refresh
    void this.config.load().catch(() => undefined);
    try {
      const pairOne = await this.pairOne();
      const type = this.item()?.accountType;
      const assistedAccount = type === 'assisted';
      const lockedAccount = type === 'guarded' || type === 'vault';
      const [account, list, escrows, assisted, locked] = await Promise.all([
        this.anos.getAccount(pairOne, this.accountId(), quiet),
        this.anos.listTransactions(pairOne, this.accountId(), {}, quiet),
        this.anos.listEscrows(pairOne, this.accountId(), quiet),
        assistedAccount ? this.anos.getAssistedTransfer(pairOne, this.accountId(), quiet) : null,
        lockedAccount ? this.anos.getLockedTransfer(pairOne, this.accountId(), quiet) : null,
      ]);
      if (!account.ok) {
        this.readError.set(account.status === 401 && /unknown account/.test(reasonOf(account)) ? this.t().account.notLanded : `/get-account: ${reasonOf(account)}`);
        return;
      }
      this.account.set(account.body);
      if (list.ok) this.pending.set(list.body.pending);
      if (escrows.ok) {
        this.escrows.set(escrows.body.escrows);
        this.escrowsError.set(null);
      } else {
        this.escrowsError.set(`/list-escrows: ${reasonOf(escrows)}`);
      }
      if (assisted !== null) {
        if (assisted.ok) {
          this.assisted.set(assisted.body.transfer);
          this.assistedError.set(null);
        } else {
          this.assistedError.set(`/get-assisted-transfer: ${reasonOf(assisted)}`);
        }
      }
      if (locked !== null) {
        if (locked.ok) {
          this.locked.set(locked.body.transfer);
          this.lockedError.set(null);
        } else {
          this.lockedError.set(`/get-locked-transfer: ${reasonOf(locked)}`);
        }
      }
    } catch (err) {
      this.readError.set(err instanceof Error ? err.message : String(err));
    }
  }

  /** The recipient from the clipboard: the run of exactly 64 hex characters in it, lower-cased; a hint under the box otherwise. Safari asks with its Paste bubble first. */
  protected async pasteRecipient(): Promise<void> {
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      this.pasteNote.set(this.t().account.clipboardRefused);
      return;
    }
    const found = ACCOUNT_ID_IN_TEXT.exec(text);
    if (!found) {
      this.pasteNote.set(this.t().account.clipboardNoId);
      return;
    }
    this.accountIdTo.set(found[0].toLowerCase());
    this.pasteNote.set(null);
  }

  /** Builds, signs (pair one here, the wallet pair at /api/sign) and posts what the account type allows. */
  protected async send(): Promise<void> {
    const item = this.item();
    const amount = anosToMillionths(this.amount());
    if (!item || amount === null) return;
    await this.act(this.sendOutcome, async () => {
      const pairOne = await this.pairOne();
      const latest = await this.anos.getAccount(pairOne, this.accountId(), true);
      if (!latest.ok || !latest.body.latestTransactionId) throw new Error(this.t().account.noLatest);
      const previous = latest.body.latestTransactionId;
      const type = item.accountType as AccountType;
      let res: ApiResponse<Accepted>;
      if (type === 'spending' && this.spendingKind() === 'stake') {
        const tx = await this.signing.sign(this.crypto.buildTransferToFund(pairOne, this.accountId(), previous, amount, this.stakePurpose()));
        res = await this.anos.transferToFund(tx);
      } else {
        const transactionType = this.transferType() as TransferType;
        const ahead = this.minutesAhead();
        if (ahead === null) throw new Error(this.t().account.lockNotLoaded);
        const createdAt = new Date(Date.now() + ahead * 60_000);
        const tx = await this.signing.sign(this.crypto.buildAnosTransferTransaction(pairOne, this.accountId(), previous, this.accountIdTo().trim().toLowerCase(), amount, transactionType, createdAt));
        res = await this.anos.anosTransfer(tx);
      }
      if (!res.ok) throw new Error(reasonOf(res));
      return this.t().account.accepted(res.body.transactionId);
    });
    await this.refresh(true);
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
      return this.t().account.followUpAccepted(signed.payload.type, res.body.transactionId);
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
        if (amount === null) throw new Error(this.t().account.payoutAmount(i + 1));
        const payout: Payout = { accountIdTo: row.accountIdTo.trim(), amount: amount.toString(), reason: row.reason };
        if (row.stakeFor !== '') payout.stakeFor = row.stakeFor;
        payouts.push(payout);
      }
      const pairOne = await this.pairOne();
      const tx = await this.signing.sign(this.crypto.buildFundProposal(pairOne, this.accountId(), payouts));
      const res = await this.anos.fundProposal(tx);
      if (!res.ok) throw new Error(reasonOf(res));
      return this.t().account.proposalAccepted(res.body.transactionId);
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
