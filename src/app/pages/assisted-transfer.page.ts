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
import { CryptoService, KeyBlobLostError, PairOne } from '../services/crypto.service';
import { LanguageService } from '../services/language.service';
import { ApiResponse, reasonOf } from '../services/log.service';
import { MasterpodApiService, MyTradeCase } from '../services/masterpod-api.service';
import { SessionService } from '../services/session.service';
import { SigningService } from '../services/signing.service';

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
  imports: [RouterLink, MatCardModule, MatButtonModule, MatIconModule, MatProgressBarModule],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>{{ t().common.assistedTransfer }}</mat-card-title>
        <mat-card-subtitle>
          @if (transfer()) { {{ t().assisted.held }} }
          @else if (closed()) { {{ t().common.closed }} }
          @else if (!loaded()) { {{ t().common.loading }} }
          @else { {{ t().assisted.notHeld }} }
        </mat-card-subtitle>
      </mat-card-header>
      <mat-card-content>
        <p><a mat-button [routerLink]="['/wallet', accountId()]"><mat-icon>arrow_back</mat-icon> {{ t().common.account }}</a></p>
        @if (readError(); as text) {
          <p class="error">{{ text }}</p>
        }

        @if (transfer(); as held) {
          <div class="summary">
            <div><span class="label">{{ t().common.amount }}</span><span class="value">{{ t().common.anos(millionthsToAnos(held.amount)) }}</span></div>
            <div><span class="label">{{ t().common.to }}</span><code class="value">{{ held.accountIdTo }}</code></div>
            <div><span class="label">{{ t().common.made }}</span><span class="value">{{ lang.dateTime(held.createdAt) }}</span></div>
            <div><span class="label">{{ t().common.stage }}</span><span class="value">{{ assistedStageWords(held.stage, t().assistedStages, held.unlocksAt ? lang.dateTime(held.unlocksAt) : '') }}</span></div>
            <div><span class="label">{{ t().assisted.attestations }}</span><span class="value">{{ t().assisted.ofTwo(held.attestations) }}</span></div>
            <div><span class="label">{{ t().common.transaction }}</span><code class="value">{{ held.transactionId }}</code></div>
          </div>
          <p>{{ explain(held) }}</p>
          <p>{{ caseText() }}</p>

          @if (asking()) {
            <p class="question">{{ t().assisted.askCancel(millionthsToAnos(held.amount)) }}</p>
            <div class="row">
              <button mat-flat-button type="button" (click)="confirm()" [disabled]="busy()">{{ t().assisted.yesCancel }}</button>
              <button mat-button type="button" (click)="asking.set(false)" [disabled]="busy()">{{ t().common.back }}</button>
            </div>
          } @else {
            <div class="row">
              @if (tradeCase(); as c) {
                <a mat-flat-button [routerLink]="['/cases', c.caseId]">{{ t().assisted.goToCase }}</a>
              }
              @if (held.stage === 'attesting' || held.stage === 'writing') {
                <button mat-stroked-button type="button" (click)="ask()" [disabled]="busy()">{{ t().assisted.cancelTransfer }}</button>
              }
            </div>
          }
          @if (busy()) {
            <mat-progress-bar mode="indeterminate"></mat-progress-bar>
          }
          @if (outcome(); as o) {
            <p [class.error]="!o.ok" [class.ok]="o.ok">{{ o.text }}</p>
          }
          <p class="muted">{{ t().common.refreshesWhileHeld }}</p>
        } @else if (closed(); as c) {
          @if (c.written === true) {
            <p>{{ t().assisted.doneWentTo(millionthsToAnos(c.transfer.amount)) }} <code>{{ c.transfer.accountIdTo }}</code>{{ t().assisted.doneEnd }}</p>
          } @else if (c.written === false) {
            <p>{{ t().assisted.cancelledStayed }}</p>
          } @else {
            <p>{{ t().assisted.noLongerHeld }}</p>
          }
        } @else if (loaded()) {
          @if (!readError()) {
            <p>{{ t().assisted.notHeldText }}</p>
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
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

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
    const words = this.t().assisted;
    const c = this.tradeCase();
    if (!c) return words.noCase;
    switch (c.status) {
      case 'open':
        return words.caseOpen;
      case 'inReview':
        return words.caseInReview;
      case 'decided':
        return words.caseDecided;
      case 'dismissed':
        return words.caseDismissed(this.dismissReason() ?? this.t().common.anotherReason);
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
    const words = this.t().assisted;
    switch (t.stage) {
      case 'waiting':
        return words.explainWaiting;
      case 'attesting':
        return words.explainAttesting;
      case 'writing':
        return words.explainWriting;
      case 'cancelling':
        return words.explainCancelling;
      default:
        return words.explainUnknown;
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
    const keyBlobKey = this.session.getKeyBlobKey();
    if (!item) throw new Error(this.t().common.notMyAccount);
    if (!keyBlobKey) throw new Error(this.t().common.noKeyBlobKey);
    return this.crypto.pairOneFromKeyBlob(this.crypto.fromHex(item.keyBlob), keyBlobKey);
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
      // A keyBlob that does not open is a lost account (wallet spec 8.2, 2026-11-08): the lost line where the refusal would show.
      this.readError.set(err instanceof KeyBlobLostError ? this.t().wallet.lost : err instanceof Error ? err.message : String(err));
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
    this.dismissReason.set(typeof reason === 'string' ? (this.t().dismissReasons[reason] ?? reason) : null);
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
      this.outcome.set({ ok: true, text: this.t().assisted.sentCancel });
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
    const words = this.t().assisted;
    if (/not approved yet/.test(reason)) return words.notAllAccepted;
    if (/a cancellation is already present/.test(reason)) return words.alreadyCancelling;
    if (/no assisted_transfers transaction/.test(reason)) return words.noLongerHeldReason;
    if (/not the transfer's sender/.test(reason)) return words.cannotCancel;
    return `/assisted-transfer-cancel: ${reason}`;
  }
}
