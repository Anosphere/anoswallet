import { DatePipe } from '@angular/common';
import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { RouterLink } from '@angular/router';
import { millionthsToAnos } from '../amounts';
import { assistedStageWords } from '../assisted-stage';
import { ACCOUNT_POLL_MS } from '../constants';
import { AnosApiService, HeldAssistedTransfer } from '../services/anos-api.service';
import { CryptoService, PairOne } from '../services/crypto.service';
import { ApiResponse, reasonOf } from '../services/log.service';
import { MasterpodApiService, MyTradeCase } from '../services/masterpod-api.service';
import { SessionService } from '../services/session.service';
import { SigningService } from '../services/signing.service';
import { DISMISS_WORDS } from './my-case.page';

/** How the transfer ended, for someone on the page when it left the validator: the transfer as last seen held, and written null when the transactions could not be read. */
interface Closed {
  written: boolean | null;
  transfer: HeldAssistedTransfer;
}

interface Outcome {
  ok: boolean;
  text: string;
}

/**
 * One assisted transfer (wallet spec 8.2, Assisted transfer), opened from
 * the row of the account page's Assisted transfer section or from the My
 * case page of its trade case. /get-assisted-transfer answers the
 * account's one held transfer, this page's when its id is the route's: the
 * amount, the receiver, when it was made, the stage in words and what it
 * means, the attestations on the validators, and the case from
 * /list-my-cases matched by transaction id (a dismissal's reason from
 * /get-my-case, asked once per case). Two buttons: Go to the case when
 * there is one, and Cancel transfer while the stage is attesting or
 * writing, which asks once before the assistedTransferCancel follow-up is
 * built with pair one, signed by /api/sign and posted to
 * /assisted-transfer-cancel, the path the old paste form took. The page
 * refreshes every 5 seconds while the transfer is held. A transfer seen
 * held and then gone is closed: its id on the first page of
 * /list-transactions means done, otherwise cancelled; a transfer never
 * seen held only reads not held.
 */
@Component({
  selector: 'app-assisted-transfer-page',
  imports: [DatePipe, RouterLink, MatCardModule, MatButtonModule, MatIconModule, MatProgressBarModule],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>Assisted transfer</mat-card-title>
        <mat-card-subtitle>
          @if (transfer()) { Held }
          @else if (closed()) { Closed }
          @else if (!loaded()) { Loading }
          @else { Not held }
        </mat-card-subtitle>
      </mat-card-header>
      <mat-card-content>
        <p><a mat-button [routerLink]="['/wallet', accountId()]"><mat-icon>arrow_back</mat-icon> Account</a></p>
        @if (readError(); as text) {
          <p class="error">{{ text }}</p>
        }

        @if (transfer(); as t) {
          <div class="summary">
            <div><span class="label">Amount</span><span class="value">{{ millionthsToAnos(t.amount) }} anos</span></div>
            <div><span class="label">To</span><code class="value">{{ t.accountIdTo }}</code></div>
            <div><span class="label">Made</span><span class="value">{{ t.createdAt | date: 'medium' }}</span></div>
            <div><span class="label">Stage</span><span class="value">{{ assistedStageWords(t.stage) }}</span></div>
            <div><span class="label">Attestations</span><span class="value">{{ t.attestations }} of 2 on the validators</span></div>
            <div><span class="label">Transaction</span><code class="value">{{ t.transactionId }}</code></div>
          </div>
          <p>{{ explain(t) }}</p>
          <p>{{ caseText() }}</p>

          @if (asking()) {
            <p class="question">Cancel this transfer? The {{ millionthsToAnos(t.amount) }} anos stay in this account. It cannot be undone.</p>
            <div class="row">
              <button mat-flat-button type="button" (click)="confirm()" [disabled]="busy()">Yes, cancel the transfer</button>
              <button mat-button type="button" (click)="asking.set(false)" [disabled]="busy()">Back</button>
            </div>
          } @else {
            <div class="row">
              @if (tradeCase(); as c) {
                <a mat-flat-button [routerLink]="['/cases', c.caseId]">Go to the case</a>
              }
              @if (t.stage === 'attesting' || t.stage === 'writing') {
                <button mat-stroked-button type="button" (click)="ask()" [disabled]="busy()">Cancel transfer</button>
              }
            </div>
          }
          @if (busy()) {
            <mat-progress-bar mode="indeterminate"></mat-progress-bar>
          }
          @if (outcome(); as o) {
            <p [class.error]="!o.ok" [class.ok]="o.ok">{{ o.text }}</p>
          }
          <p class="muted">This page refreshes every 5 seconds while the transfer is held.</p>
        } @else if (closed(); as c) {
          @if (c.written === true) {
            <p>Done. The {{ millionthsToAnos(c.transfer.amount) }} anos went to <code>{{ c.transfer.accountIdTo }}</code>.</p>
          } @else if (c.written === false) {
            <p>Cancelled. The anos stayed in this account.</p>
          } @else {
            <p>This transfer is no longer held. Check the account's transactions to see whether the anos moved.</p>
          }
        } @else if (loaded()) {
          @if (!readError()) {
            <p>This transfer is not held. A written transfer is in the account's transactions.</p>
          }
        } @else {
          <mat-progress-bar mode="indeterminate"></mat-progress-bar>
        }
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    .summary { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 8px 0 16px; }
    .summary div { display: contents; }
    .label { color: var(--mat-sys-on-surface-variant); }
    .value { word-break: break-all; }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 8px 0; }
    .question { font-weight: 500; }
    .muted { color: var(--mat-sys-on-surface-variant); }
    .error { color: var(--mat-sys-error); }
    .ok { color: var(--mat-sys-primary); }
    code { font-size: 12px; word-break: break-all; }
  `,
})
export class AssistedTransferPage {
  readonly accountId = input.required<string>();
  readonly transactionId = input.required<string>();

  private readonly session = inject(SessionService);
  private readonly masterpod = inject(MasterpodApiService);
  private readonly anos = inject(AnosApiService);
  private readonly crypto = inject(CryptoService);
  private readonly signing = inject(SigningService);

  protected readonly millionthsToAnos = millionthsToAnos;
  protected readonly assistedStageWords = assistedStageWords;

  protected readonly transfer = signal<HeldAssistedTransfer | null>(null);
  protected readonly loaded = signal(false);
  protected readonly closed = signal<Closed | null>(null);
  protected readonly readError = signal<string | null>(null);
  /** The newest of the person's trade cases with this transaction id, or null while an attestor has opened none. */
  protected readonly tradeCase = signal<MyTradeCase | null>(null);
  /** A dismissed case's reason in the My case page's words, from /get-my-case; null while unknown. */
  protected readonly dismissReason = signal<string | null>(null);
  protected readonly asking = signal(false);
  protected readonly busy = signal(false);
  protected readonly outcome = signal<Outcome | null>(null);

  /** The transfer as this page last saw it held: what the closed view is built from. */
  private lastSeen: HeldAssistedTransfer | null = null;
  /** The dismissed case whose reason /get-my-case was asked for, so it is asked once per case id. */
  private reasonAskedFor: string | null = null;

  /** The case in one sentence: none yet, or its status in the words of the plan. */
  protected readonly caseText = computed((): string => {
    const c = this.tradeCase();
    if (!c) return 'No case yet. An attestor will open one and ask for your lookup id.';
    switch (c.status) {
      case 'open':
        return 'An attestor opened a case. Share your lookup id on the case page.';
      case 'inReview':
        return 'An attestor is checking your trade.';
      case 'decided':
        return 'Two attestors signed. The attestations go to the validators and the transfer is written in the next round.';
      case 'dismissed':
        return `The case was dismissed: ${this.dismissReason() ?? 'another reason'}. The anos stay held until you cancel the transfer or an attestor opens a new case.`;
    }
  });

  constructor() {
    effect(() => {
      this.accountId();
      this.transactionId();
      untracked(() => {
        this.reset();
        void this.refresh();
      });
    });
    const timer = setInterval(() => {
      if (this.transfer() && !this.busy()) void this.refresh(true);
    }, ACCOUNT_POLL_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  private reset(): void {
    this.transfer.set(null);
    this.loaded.set(false);
    this.closed.set(null);
    this.readError.set(null);
    this.tradeCase.set(null);
    this.dismissReason.set(null);
    this.asking.set(false);
    this.outcome.set(null);
    this.lastSeen = null;
    this.reasonAskedFor = null;
  }

  /** One sentence of what the stage means. */
  protected explain(t: HeldAssistedTransfer): string {
    switch (t.stage) {
      case 'waiting':
        return 'The validators are still accepting this transfer. Nothing can be done with it yet.';
      case 'attesting':
        return 'Two attestors have to check this transfer before it is written. An attestor opens a case and meets you on a video call. You can cancel the transfer until it is written.';
      case 'writing':
        return 'Both attestations are on the validators. The next write moves the anos to the receiver. You can still cancel until then.';
      case 'cancelling':
        return 'You cancelled this transfer. The anos stay in this account.';
      default:
        return 'This transfer is held. This wallet does not know this stage, so it offers nothing to do with it.';
    }
  }

  protected ask(): void {
    this.outcome.set(null);
    this.asking.set(true);
  }

  /** Pair one, opened from the keyBlob for one signature; the caller drops it. */
  private async pairOne(): Promise<PairOne> {
    let item = this.session.accounts().find((a) => a.accountId === this.accountId());
    if (!item) {
      const res = await this.masterpod.listAnosAccounts(true);
      if (res.ok) this.session.accounts.set(res.body.accounts);
      item = this.session.accounts().find((a) => a.accountId === this.accountId());
    }
    const encryptionKey = this.session.getEncryptionKey();
    if (!item) throw new Error('This account is not one of this anoPod\'s accounts');
    if (!encryptionKey) throw new Error('The encryption key is not in RAM: unlock again');
    return this.crypto.pairOneFromKeyBlob(this.crypto.fromHex(item.keyBlob), encryptionKey);
  }

  /** /get-assisted-transfer, this page's transfer when the answer's id is the route's; gone after being seen held, the closed view from /list-transactions. */
  protected async refresh(quiet = false): Promise<void> {
    this.readError.set(null);
    try {
      const pairOne = await this.pairOne();
      const res = await this.anos.getAssistedTransfer(pairOne, this.accountId(), quiet);
      if (!res.ok) {
        this.readError.set(`/get-assisted-transfer: ${reasonOf(res)}`);
        return;
      }
      const transfer = res.body.transfer;
      const found = transfer !== null && transfer.transactionId === this.transactionId() ? transfer : null;
      if (found) {
        this.transfer.set(found);
        this.lastSeen = found;
        await this.findCase();
      } else if (this.lastSeen) {
        const list = await this.anos.listTransactions(pairOne, this.accountId(), {}, quiet);
        const written = list.ok ? list.body.transactions.some((t) => t.transactionId === this.transactionId()) : null;
        this.closed.set({ written, transfer: this.lastSeen });
        this.transfer.set(null);
      }
    } catch (err) {
      this.readError.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.loaded.set(true);
    }
  }

  /** The trade case under Cases for this transfer, the newest with its id, if the masterpod has one; a dismissed case's reason from /get-my-case, once per case. */
  private async findCase(): Promise<void> {
    const res = await this.masterpod.listMyCases(true);
    if (!res.ok) return;
    const found = res.body.trades.filter((c) => c.transactionId === this.transactionId()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
    this.tradeCase.set(found);
    if (!found || found.status !== 'dismissed' || this.reasonAskedFor === found.caseId) return;
    this.reasonAskedFor = found.caseId;
    this.dismissReason.set(null);
    const detail = await this.masterpod.getMyCase(found.caseId, true);
    if (!detail.ok) return;
    const reason = [...detail.body.events].reverse().find((e) => e.kind === 'dismissed')?.details['reason'];
    this.dismissReason.set(typeof reason === 'string' ? (DISMISS_WORDS[reason] ?? reason) : null);
  }

  /** Builds, signs and posts the assistedTransferCancel follow-up, then refreshes. */
  protected async confirm(): Promise<void> {
    const transfer = this.transfer();
    if (!this.asking() || !transfer) return;
    this.busy.set(true);
    this.outcome.set(null);
    try {
      const pairOne = await this.pairOne();
      const signed = await this.signing.sign(this.crypto.buildFollowUp(pairOne, { type: 'assistedTransferCancel', transactionId: transfer.transactionId, accountId: this.accountId() }));
      const res = await this.anos.assistedTransferCancel(signed);
      if (!res.ok) throw new Error(this.plainReason(res));
      this.outcome.set({ ok: true, text: 'Sent. The transfer is being cancelled; the anos stay in this account.' });
      this.asking.set(false);
    } catch (err) {
      this.outcome.set({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      this.busy.set(false);
    }
    await this.refresh(true);
  }

  /** The validator's refusal in plain words where the reason is a known one. */
  private plainReason(res: ApiResponse<unknown>): string {
    const reason = reasonOf(res);
    if (/not approved yet/.test(reason)) return 'The validators have not all accepted this transfer yet. Try again in a moment.';
    if (/a cancellation is already present/.test(reason)) return 'This transfer is already being cancelled.';
    if (/no assisted_transfers transaction/.test(reason)) return 'This transfer is no longer held: it was written or cancelled.';
    if (/not the transfer's sender/.test(reason)) return 'This account cannot cancel this transfer.';
    return `/assisted-transfer-cancel: ${reason}`;
  }
}
