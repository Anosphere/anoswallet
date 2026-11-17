import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { RouterLink } from '@angular/router';
import { millionthsToAnos } from '../amounts';
import { ConfirmData, askChoice, askConfirm } from '../components/confirm-dialog.component';
import { EscrowStripComponent } from '../components/escrow-strip.component';
import { ACCOUNT_POLL_MS } from '../constants';
import { cancelBox, disputeBox, doNotCancelBox, paidQuestionBox, releaseBox } from '../escrow-boxes';
import { EscrowGuide, escrowGuide, escrowStageWords, stateOfStage } from '../escrow-stage';
import { AnosApiService, EscrowItem } from '../services/anos-api.service';
import { CryptoService, KeyBlobLostError, PairOne } from '../services/crypto.service';
import { EscrowAction, EscrowActionsService } from '../services/escrow-actions.service';
import { LanguageService } from '../services/language.service';
import { reasonOf } from '../services/log.service';
import { MasterpodApiService } from '../services/masterpod-api.service';
import { SessionService } from '../services/session.service';

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
 * trade is open the status box (escrow-strip.component.ts) stands first,
 * under the Back link: whether the anos are in escrow, the step of the
 * four and the one thing to do or not to do, by stage and side
 * (escrowGuide in escrow-stage.ts; 2026-11-17,
 * forclaude/wallet-trade-guide-plan-1.md). While the stage is held, the
 * buttons for this side: the seller Release the anos and the red
 * "Something is wrong: dispute", the buyer the same red dispute and under
 * it the text button "I have not paid: cancel the trade"; on this page
 * red is the dispute's alone. Nothing is asked in place: each button
 * opens the confirmation box (wallet spec 8.9) with one of the five boxes
 * of escrow-boxes.ts, and Release, Dispute and Cancel each ask for the
 * username there before their button works. The cancel asks a question
 * first, "Have you sent any money to the seller?": after "Yes, I have
 * paid" a box says not to cancel and offers the dispute, and nothing is
 * cancelled on that path; after "No, I have not paid" comes the cancel
 * box; when the question closes without a button, by a step back or
 * forward in the browser's history, that is no answer, so no further box
 * opens and nothing is sent (askChoice, wallet spec 8.9). After a Yes,
 * escrow-actions.service.ts builds the escrowSuccess,
 * escrowCancel or escrowDispute follow-up with pair one, has it signed by
 * /api/sign/<n> and posts it to /escrow-signature, the path the old paste
 * form took. In dispute: who disputed it, the verdicts so
 * far and a link to the case under Cases when there is one. The page
 * refreshes every 5 seconds while the trade is open. A trade seen open and
 * then missing from the list is closed: its id on the first page of
 * /list-transactions means released, otherwise cancelled; a trade never
 * seen open only reads not open.
 */
@Component({
  selector: 'app-escrow-trade-page',
  imports: [RouterLink, MatCardModule, MatButtonModule, MatIconModule, MatProgressBarModule, EscrowStripComponent],
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
          <app-escrow-strip [guide]="guide(open)" />
          <div class="summary">
            <div><span class="label">{{ t().common.amount }}</span><span class="value">{{ t().common.anos(millionthsToAnos(open.amount)) }}</span></div>
            <div><span class="label">{{ side() === 'seller' ? t().common.buyer : t().common.seller }}</span><code class="value">{{ side() === 'seller' ? open.accountIdTo : open.accountId }}</code></div>
            <div><span class="label">{{ t().common.made }}</span><span class="value">{{ lang.dateTime(open.createdAt) }}</span></div>
            <div><span class="label">{{ t().common.stage }}</span><span class="value">{{ words(open) }}</span></div>
            <div><span class="label">{{ t().common.transaction }}</span><code class="value">{{ open.transactionId }}</code></div>
          </div>

          @if (open.stage === 'disputed') {
            <p>{{ open.disputedBy === accountId() ? t().escrow.youDisputed : t().escrow.otherDisputed }} {{ verdictsText(open) }}</p>
            @if (caseId(); as id) {
              <p><a mat-stroked-button [routerLink]="['/cases', id]">{{ t().escrow.seeCase }}</a></p>
            }
          }

          @if (open.stage === 'held') {
            <div class="row">
              @if (side() === 'seller') {
                <button mat-flat-button type="button" (click)="release(open)" [disabled]="busy()">{{ t().escrow.release }}</button>
              }
              <button mat-flat-button type="button" class="danger" (click)="dispute(open)" [disabled]="busy()">{{ t().escrow.dispute }}</button>
            </div>
            @if (side() === 'buyer') {
              <div class="row">
                <button mat-button type="button" (click)="cancel(open)" [disabled]="busy()">{{ t().escrow.cancelTrade }}</button>
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
  private readonly actions = inject(EscrowActionsService);
  private readonly dialog = inject(MatDialog);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  protected readonly millionthsToAnos = millionthsToAnos;

  protected readonly trade = signal<EscrowItem | null>(null);
  protected readonly loaded = signal(false);
  protected readonly closed = signal<Closed | null>(null);
  protected readonly readError = signal<string | null>(null);
  protected readonly caseId = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly outcome = signal<Outcome | null>(null);

  /** Whether this page has seen the trade open, and the stage it last saw: what the closed view is built from. */
  private seenOpen = false;
  private lastStage: string | null = null;

  /** True while a confirmation box is open: the page's three buttons do nothing meanwhile. */
  private boxOpen = false;

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
    this.outcome.set(null);
    this.seenOpen = false;
    this.lastStage = null;
  }

  protected words(t: EscrowItem): string {
    return escrowStageWords(t.stage, this.side(), this.t().escrowStages);
  }

  /** The status box of the open trade for this side (escrow-stage.ts, 2026-11-17): whether the anos are in escrow, the step, and what to do and not to do. The other side is named "the buyer" to the seller and "the seller" to the buyer. */
  protected guide(t: EscrowItem): EscrowGuide {
    const words = this.t().escrowGuide;
    return escrowGuide(stateOfStage(t.stage), this.side(), this.side() === 'seller' ? words.theBuyer : words.theSeller, millionthsToAnos(t.amount), words);
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

  /** Opens the confirmation box (wallet spec 8.9) with `data` and resolves to its answer: true only by its second button. boxOpen is true while the box is open and false again whatever happens. */
  private async box(data: ConfirmData): Promise<boolean> {
    this.boxOpen = true;
    try {
      return await askConfirm(this.dialog, data);
    } finally {
      this.boxOpen = false;
    }
  }

  /** Opens the confirmation box as box() does, for a box whose first button is an answer of its own (2026-11-17, decision 25 of forclaude/wallet-trade-guide-plan-1.md), and resolves to askChoice's answer: true by its second button, false by its first, null when the box closed without a button, which a step back or forward in the browser's history does. boxOpen is true while the box is open and false again whatever happens. */
  private async choice(data: ConfirmData): Promise<boolean | null> {
    this.boxOpen = true;
    try {
      return await askChoice(this.dialog, data);
    } finally {
      this.boxOpen = false;
    }
  }

  /** The seller's "Release the anos" (2026-11-17): the Release box, with the buyer's account id and the username to type; on its Yes the release is sent. Nothing happens while a box is open or a send is on its way. A "Sent. ..." or a refusal from before goes from the page when the box opens. */
  protected async release(t: EscrowItem): Promise<void> {
    if (this.boxOpen || this.busy()) return;
    this.outcome.set(null);
    if (await this.box(releaseBox(this.t(), millionthsToAnos(t.amount), t.accountIdTo, this.session.username()))) await this.act('release', t);
  }

  /** "Something is wrong: dispute", either side's (2026-11-17): the Dispute box, with the username to type; on its Yes the dispute is sent. Nothing happens while a box is open or a send is on its way. A "Sent. ..." or a refusal from before goes from the page when the box opens. */
  protected async dispute(t: EscrowItem): Promise<void> {
    if (this.boxOpen || this.busy()) return;
    this.outcome.set(null);
    if (await this.box(disputeBox(this.t(), this.session.username()))) await this.act('dispute', t);
  }

  /** The buyer's "I have not paid: cancel the trade" (2026-11-17). First the question "Have you sent any money to the seller?", opened with choice(), since its first button is an answer too. After "Yes, I have paid": the box "Do not cancel this trade", whose red button opens the Dispute box, and on that box's Yes the dispute is sent; nothing is cancelled on this path. After "No, I have not paid": the cancel box, with the username to type, and on its Yes the cancel is sent. When the question closes without a button, by a step back or forward in the browser's history, that is no answer: no further box opens and nothing is sent. Nothing happens while a box is open or a send is on its way. A "Sent. ..." or a refusal from before goes from the page when the question opens. */
  protected async cancel(t: EscrowItem): Promise<void> {
    if (this.boxOpen || this.busy()) return;
    this.outcome.set(null);
    const paid = await this.choice(paidQuestionBox(this.t()));
    if (paid === null) return;
    if (paid) {
      if (!(await this.box(doNotCancelBox(this.t())))) return;
      if (await this.box(disputeBox(this.t(), this.session.username()))) await this.act('dispute', t);
      return;
    }
    if (await this.box(cancelBox(this.t(), millionthsToAnos(t.amount), this.session.username()))) await this.act('cancel', t);
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

  /** Sends the follow-up of the action a box said Yes to, through escrow-actions.service.ts (2026-11-17), shows "Sent. ..." or the validator's refusal in plain words, then refreshes. */
  private async act(action: EscrowAction, t: EscrowItem): Promise<void> {
    this.busy.set(true);
    this.outcome.set(null);
    try {
      const res = await this.actions.send(action, this.accountId(), t.transactionId);
      if (!res.ok) throw new Error(this.actions.plainReason(res));
      this.outcome.set({ ok: true, text: this.t().escrow.sent[action] });
    } catch (err) {
      this.outcome.set({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      this.busy.set(false);
    }
    await this.refresh(true);
  }
}
