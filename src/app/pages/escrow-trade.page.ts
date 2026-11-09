import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { RouterLink } from '@angular/router';
import { millionthsToAnos } from '../amounts';
import { ACCOUNT_POLL_MS } from '../constants';
import { escrowStageWords } from '../escrow-stage';
import { AnosApiService, EscrowItem } from '../services/anos-api.service';
import { CryptoService, EscrowSignatureType, KeyBlobLostError, PairOne } from '../services/crypto.service';
import { LanguageService } from '../services/language.service';
import { ApiResponse, reasonOf } from '../services/log.service';
import { MasterpodApiService } from '../services/masterpod-api.service';
import { SessionService } from '../services/session.service';
import { SigningService } from '../services/signing.service';

/** The three things a party can do with a held trade, each the follow-up it sends. */
type Action = 'release' | 'cancel' | 'dispute';

const FOLLOW_UPS: Record<Action, EscrowSignatureType> = { release: 'escrowSuccess', cancel: 'escrowCancel', dispute: 'escrowDispute' };

/** How the trade ended, for someone on the page when it left the list; released null when the transactions could not be read. */
interface Closed {
  released: boolean | null;
  disputed: boolean;
}

interface Outcome {
  ok: boolean;
  text: string;
}

/**
 * One escrow trade (wallet spec 8.2, Escrow trade), opened from a row of
 * the account page's Escrow trades list. The trade is picked out of
 * /list-escrows by its id (there is no read for one trade, and the list is
 * short by the validator's rule): the amount, the other side, when it was
 * made, the stage in words and what it means for this side. While the
 * stage is held, the buttons for this side, the seller Release the anos
 * and Dispute, the buyer Cancel trade and Dispute, each asking once before
 * the escrowSuccess, escrowCancel or escrowDispute follow-up is built with
 * pair one, signed by /api/sign and posted to /escrow-signature, the path
 * the old paste form took. In dispute: who disputed it, the verdicts so
 * far and a link to the case under Cases when there is one. The page
 * refreshes every 5 seconds while the trade is open. A trade seen open and
 * then missing from the list is closed: its id on the first page of
 * /list-transactions means released, otherwise cancelled; a trade never
 * seen open only reads not open.
 */
@Component({
  selector: 'app-escrow-trade-page',
  imports: [RouterLink, MatCardModule, MatButtonModule, MatIconModule, MatProgressBarModule],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>{{ t().escrow.title }}</mat-card-title>
        <mat-card-subtitle>
          @if (trade()) { {{ t().escrow.youAre(t().sides[side()]) }} }
          @else if (closed()) { {{ t().common.closed }} }
          @else if (!loaded()) { {{ t().common.loading }} }
          @else { {{ t().escrow.notOpen }} }
        </mat-card-subtitle>
      </mat-card-header>
      <mat-card-content>
        <p><a mat-button [routerLink]="['/wallet', accountId()]"><mat-icon>arrow_back</mat-icon> {{ t().common.account }}</a></p>
        @if (readError(); as text) {
          <p class="error">{{ text }}</p>
        }

        @if (trade(); as open) {
          <div class="summary">
            <div><span class="label">{{ t().common.amount }}</span><span class="value">{{ t().common.anos(millionthsToAnos(open.amount)) }}</span></div>
            <div><span class="label">{{ side() === 'seller' ? t().common.buyer : t().common.seller }}</span><code class="value">{{ side() === 'seller' ? open.accountIdTo : open.accountId }}</code></div>
            <div><span class="label">{{ t().common.made }}</span><span class="value">{{ lang.dateTime(open.createdAt) }}</span></div>
            <div><span class="label">{{ t().common.stage }}</span><span class="value">{{ words(open) }}</span></div>
            <div><span class="label">{{ t().common.transaction }}</span><code class="value">{{ open.transactionId }}</code></div>
          </div>
          <p>{{ explain(open) }}</p>

          @if (open.stage === 'disputed') {
            <p>{{ open.disputedBy === accountId() ? t().escrow.youDisputed : t().escrow.otherDisputed }} {{ verdictsText(open) }}</p>
            @if (caseId(); as id) {
              <p><a mat-stroked-button [routerLink]="['/cases', id]">{{ t().escrow.seeCase }}</a></p>
            }
          }

          @if (open.stage === 'held') {
            @if (asking(); as action) {
              <p class="question">{{ question(action, open) }}</p>
              <div class="row">
                <button mat-flat-button type="button" (click)="confirm()" [disabled]="busy()">{{ yesLabel(action) }}</button>
                <button mat-button type="button" (click)="asking.set(null)" [disabled]="busy()">{{ t().common.back }}</button>
              </div>
            } @else {
              <div class="row">
                @if (side() === 'seller') {
                  <button mat-flat-button type="button" (click)="ask('release')" [disabled]="busy()">{{ t().escrow.release }}</button>
                } @else {
                  <button mat-flat-button type="button" (click)="ask('cancel')" [disabled]="busy()">{{ t().escrow.cancelTrade }}</button>
                }
                <button mat-stroked-button type="button" (click)="ask('dispute')" [disabled]="busy()">{{ t().escrow.dispute }}</button>
              </div>
            }
          }
          @if (busy()) {
            <mat-progress-bar mode="indeterminate"></mat-progress-bar>
          }
          @if (outcome(); as o) {
            <p [class.error]="!o.ok" [class.ok]="o.ok">{{ o.text }}</p>
          }
          <p class="muted">{{ t().common.refreshesWhileOpen }}</p>
        } @else if (closed(); as c) {
          <p>{{ closedText(c) }}</p>
        } @else if (loaded()) {
          @if (!readError()) {
            <p>{{ t().escrow.notOpenText }}</p>
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
export class EscrowTradePage {
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

  protected readonly trade = signal<EscrowItem | null>(null);
  protected readonly loaded = signal(false);
  protected readonly closed = signal<Closed | null>(null);
  protected readonly readError = signal<string | null>(null);
  protected readonly caseId = signal<string | null>(null);
  protected readonly asking = signal<Action | null>(null);
  protected readonly busy = signal(false);
  protected readonly outcome = signal<Outcome | null>(null);

  /** Whether this page has seen the trade open, and the stage it last saw: what the closed view is built from. */
  private seenOpen = false;
  private lastStage: string | null = null;

  /** Which side of the trade this account is on: the seller sent the anos, the buyer receives them. */
  protected readonly side = computed<'seller' | 'buyer'>(() => (this.trade()?.accountId === this.accountId() ? 'seller' : 'buyer'));

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
      if (this.trade() && !this.busy()) void this.refresh(true);
    }, ACCOUNT_POLL_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  private reset(): void {
    this.trade.set(null);
    this.loaded.set(false);
    this.closed.set(null);
    this.readError.set(null);
    this.caseId.set(null);
    this.asking.set(null);
    this.outcome.set(null);
    this.seenOpen = false;
    this.lastStage = null;
  }

  protected words(t: EscrowItem): string {
    return escrowStageWords(t.stage, this.side(), this.t().escrowStages);
  }

  /** One sentence of what the stage means for this side. */
  protected explain(t: EscrowItem): string {
    const words = this.t().escrow;
    const seller = this.side() === 'seller';
    switch (t.stage) {
      case 'waiting':
        return words.explainWaiting;
      case 'held':
        return seller ? words.explainHeldSeller : words.explainHeldBuyer;
      case 'releasing':
        return words.explainReleasing;
      case 'cancelling':
        return words.explainCancelling;
      case 'disputed':
        return words.explainDisputed;
      default:
        return words.explainUnknown;
    }
  }

  /** The verdicts on a disputed trade in words: how many say what, and what comes next. */
  protected verdictsText(t: EscrowItem): string {
    const words = this.t().escrow;
    if (t.verdicts.length === 0) return words.noVerdict;
    const accepted = t.verdicts.filter((v) => v.approved);
    const release = accepted.filter((v) => v.verdict === 'success').length;
    const cancel = accepted.filter((v) => v.verdict === 'cancel').length;
    const waiting = t.verdicts.length - accepted.length;
    const parts: string[] = [];
    if (release > 0) parts.push(words.toRelease(release));
    if (cancel > 0) parts.push(words.toCancel(cancel));
    if (waiting > 0) parts.push(words.notAccepted(waiting));
    let next: string;
    if (release >= 2) next = words.beingReleased;
    else if (cancel >= 2) next = words.beingCancelled;
    else if (release === 1 && cancel === 1) next = words.thirdDecides;
    else if (release + cancel === 1) next = words.waitingOneMore;
    else next = words.waitingAttestors;
    return words.verdictsSoFar(parts.join(', '), next);
  }

  protected question(action: Action, t: EscrowItem): string {
    const amount = millionthsToAnos(t.amount);
    switch (action) {
      case 'release':
        return this.t().escrow.askRelease(amount);
      case 'cancel':
        return this.t().escrow.askCancel(amount);
      case 'dispute':
        return this.t().escrow.askDispute;
    }
  }

  protected yesLabel(action: Action): string {
    return this.t().escrow.yes[action];
  }

  protected ask(action: Action): void {
    this.outcome.set(null);
    this.asking.set(action);
  }

  protected closedText(c: Closed): string {
    const words = this.t().escrow;
    const when = c.disputed ? words.afterDecided : '';
    if (c.released === null) return `${words.closed(when)} ${words.checkTransactions}`;
    return `${words.closed(when)} ${c.released ? words.released : words.cancelled}`;
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

  /** /list-escrows, the trade picked by its id; gone after being seen open, the closed view from /list-transactions. */
  protected async refresh(quiet = false): Promise<void> {
    this.readError.set(null);
    try {
      const pairOne = await this.pairOne();
      const res = await this.anos.listEscrows(pairOne, this.accountId(), quiet);
      if (!res.ok) {
        this.readError.set(`/list-escrows: ${reasonOf(res)}`);
        return;
      }
      const found = res.body.escrows.find((e) => e.transactionId === this.transactionId()) ?? null;
      if (found) {
        this.trade.set(found);
        this.seenOpen = true;
        this.lastStage = found.stage;
        if (found.stage === 'disputed' && !this.caseId()) await this.findCase();
      } else if (this.seenOpen) {
        const list = await this.anos.listTransactions(pairOne, this.accountId(), {}, quiet);
        const released = list.ok ? list.body.transactions.some((t) => t.transactionId === this.transactionId()) : null;
        this.closed.set({ released, disputed: this.lastStage === 'disputed' });
        this.trade.set(null);
      }
    } catch (err) {
      // A keyBlob that does not open is a lost account (wallet spec 8.2, 2026-11-08): the lost line where the refusal would show.
      this.readError.set(err instanceof KeyBlobLostError ? this.t().wallet.lost : err instanceof Error ? err.message : String(err));
    } finally {
      this.loaded.set(true);
    }
  }

  /** The dispute case under Cases for this trade, if the masterpod has one. */
  private async findCase(): Promise<void> {
    const res = await this.masterpod.listMyCases(true);
    if (!res.ok) return;
    const found = res.body.disputes.find((d) => d.transactionId === this.transactionId());
    if (found) this.caseId.set(found.caseId);
  }

  /** Builds, signs and posts the follow-up the asked action stands for, then refreshes. */
  protected async confirm(): Promise<void> {
    const action = this.asking();
    const trade = this.trade();
    if (!action || !trade) return;
    this.busy.set(true);
    this.outcome.set(null);
    try {
      const pairOne = await this.pairOne();
      const signed = await this.signing.sign(this.crypto.buildFollowUp(pairOne, { type: FOLLOW_UPS[action], transactionId: trade.transactionId, accountId: this.accountId() }));
      const res = await this.anos.escrowSignature(signed);
      if (!res.ok) throw new Error(this.plainReason(res));
      this.outcome.set({ ok: true, text: this.t().escrow.sent[action] });
      this.asking.set(null);
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
    const words = this.t().escrow;
    if (/not approved yet/.test(reason)) return words.notAllAccepted;
    if (/success signature is already present/.test(reason)) return words.alreadyReleased;
    if (/cancel signature is already present/.test(reason)) return words.alreadyCancelled;
    if (/dispute signature is already present/.test(reason)) return words.alreadyDisputed;
    if (/not the seller|not the buyer|neither the seller/.test(reason)) return words.cannotSign;
    return `/escrow-signature: ${reason}`;
  }
}
