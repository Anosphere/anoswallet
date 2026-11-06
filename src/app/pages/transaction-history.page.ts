import { DatePipe } from '@angular/common';
import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { RouterLink } from '@angular/router';
import { accountNames } from '../account-names';
import { millionthsToAnos } from '../amounts';
import { CopyButtonComponent } from '../components/copy-button.component';
import { HISTORY_PAGE } from '../constants';
import { HistoryWords, historyWords } from '../history-words';
import { AnosApiService, TransactionItem } from '../services/anos-api.service';
import { ChatService } from '../services/chat.service';
import { CryptoService, PairOne } from '../services/crypto.service';
import { reasonOf } from '../services/log.service';
import { MasterpodApiService } from '../services/masterpod-api.service';
import { SessionService } from '../services/session.service';
import { shortId } from '../short-id';

/** The rows of one day under their heading. */
interface Day {
  label: string;
  rows: TransactionItem[];
}

/** What a read of /list-transactions carries: the page size, the position to page back from, the range. */
interface ListBody {
  limit: number;
  beforePosition?: number;
  from?: string;
  to?: string;
}

/**
 * Transaction history (wallet spec 8.2), at /wallet/:accountId/history,
 * opened by the button on the account page (2026-11-05, section 11;
 * rewritten 2026-11-06): the list from /list-transactions, newest first,
 * HISTORY_PAGE rows at a time, Show more with beforePosition while a page
 * came back full; a date range (from the start of the first day to the
 * start of the day after the last, the validator's from and to) picked in
 * a Material range picker; the rows in plain words (history-words.ts)
 * under day headings in the words of ChatService.dayLabel, with the time
 * and the signed amount, and the details under a tapped row. Read when
 * opened, by Refresh and by a range change; no poll. The reads are signed
 * by pair one, opened from the keyBlob and dropped.
 */
@Component({
  selector: 'app-transaction-history-page',
  imports: [DatePipe, RouterLink, MatCardModule, MatButtonModule, MatIconModule, MatProgressBarModule, MatFormFieldModule, MatInputModule, MatDatepickerModule, CopyButtonComponent],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>Transaction history</mat-card-title>
        <mat-card-subtitle>{{ name() }} · <code>{{ shortId(accountId()) }}</code></mat-card-subtitle>
      </mat-card-header>
      <mat-card-content>
        <p><a mat-button [routerLink]="['/wallet', accountId()]"><mat-icon>arrow_back</mat-icon> Account</a></p>
        <div class="row">
          <mat-form-field appearance="outline" class="dates" subscriptSizing="dynamic">
            <mat-label>Dates</mat-label>
            <mat-date-range-input [rangePicker]="rangePicker">
              <input matStartDate placeholder="From" [value]="from()" (dateChange)="from.set($event.value); changed()" />
              <input matEndDate placeholder="To" [value]="to()" (dateChange)="to.set($event.value); changed()" />
            </mat-date-range-input>
            <mat-datepicker-toggle matIconSuffix [for]="rangePicker" />
            @if (from() || to()) {
              <button mat-icon-button matIconSuffix type="button" (click)="clearDates()" aria-label="Clear the dates"><mat-icon>close</mat-icon></button>
            }
            <mat-date-range-picker #rangePicker />
          </mat-form-field>
          <button mat-stroked-button type="button" (click)="refresh()" [disabled]="busy()">Refresh</button>
        </div>
        @if (readError(); as text) {
          <p class="error">{{ text }}</p>
        }
        @if (busy()) {
          <mat-progress-bar mode="indeterminate"></mat-progress-bar>
        }
        @for (day of days(); track day.label) {
          <h4 class="day">{{ day.label }}</h4>
          @for (t of day.rows; track t.transactionId) {
            @let w = words(t);
            <button type="button" class="entry" (click)="toggle(t.transactionId)" [attr.aria-expanded]="expanded() === t.transactionId">
              <mat-icon>{{ w.icon }}</mat-icon>
              <span class="text">
                <span class="title">{{ w.title }}</span>
                <span class="muted">{{ chat.timeOf(t.createdAt) }}</span>
              </span>
              <span class="amount" [class.plus]="w.sign === '+'" [class.muted]="w.sign === ''">{{ amountWords(t, w) }}</span>
            </button>
            @if (expanded() === t.transactionId) {
              <div class="details">
                <div><span class="label">Kind</span><span>{{ w.kind }}</span></div>
                @if (counterpart(t); as other) {
                  <div><span class="label">{{ t.accountId === accountId() ? 'To' : 'From' }}</span><span><code>{{ other }}</code> <app-copy-button [text]="other" label="Copy the account id" /></span></div>
                }
                <div><span class="label">Transaction</span><span><code>{{ t.transactionId }}</code> <app-copy-button [text]="t.transactionId" label="Copy the transaction id" /></span></div>
                <div><span class="label">Position</span><span>#{{ t.position }}</span></div>
                <div><span class="label">When</span><span>{{ t.createdAt | date: 'medium' }}</span></div>
              </div>
            }
          }
        } @empty {
          @if (!busy() && !readError()) {
            <p class="muted">{{ from() && to() ? 'No transactions between these dates.' : 'Nothing on the ledger for this account yet.' }}</p>
          }
        }
        @if (canLoadMore()) {
          <button mat-button type="button" (click)="loadMore()" [disabled]="busy()">Show more</button>
        }
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 8px 0; }
    .dates { min-width: 280px; }
    .day { margin: 16px 0 0; font-size: 13px; font-weight: 500; color: var(--mat-sys-on-surface-variant); }
    .entry { display: flex; align-items: center; gap: 12px; width: 100%; padding: 10px 4px; border: 0; border-bottom: 1px solid var(--mat-sys-outline-variant); background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
    .entry:hover { background: var(--mat-sys-surface-container-low); }
    .text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .title { font-weight: 500; }
    .amount { white-space: nowrap; font-weight: 500; }
    .plus { color: var(--mat-sys-primary); }
    .details { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; padding: 8px 4px 12px 48px; border-bottom: 1px solid var(--mat-sys-outline-variant); }
    .details div { display: contents; }
    .label { color: var(--mat-sys-on-surface-variant); }
    .muted { color: var(--mat-sys-on-surface-variant); }
    .error { color: var(--mat-sys-error); }
    code { font-size: 12px; word-break: break-all; }
  `,
})
export class TransactionHistoryPage {
  readonly accountId = input.required<string>();

  private readonly session = inject(SessionService);
  private readonly masterpod = inject(MasterpodApiService);
  private readonly anos = inject(AnosApiService);
  private readonly crypto = inject(CryptoService);
  /** For dayLabel and timeOf, so days read the same here and in Chat. */
  protected readonly chat = inject(ChatService);

  protected readonly shortId = shortId;
  protected readonly transactions = signal<TransactionItem[]>([]);
  protected readonly canLoadMore = signal(false);
  protected readonly readError = signal<string | null>(null);
  protected readonly busy = signal(false);
  /** The range picked: with both set, or both cleared, the first page is read again; one alone waits for the other. */
  protected readonly from = signal<Date | null>(null);
  protected readonly to = signal<Date | null>(null);
  /** The transaction id whose details are open, or null. */
  protected readonly expanded = signal<string | null>(null);

  /** The account's name by its type (account-names.ts); "Account" until the account is in the session. */
  protected readonly name = computed(() => accountNames(this.session.accounts()).get(this.accountId()) ?? 'Account');

  /** The rows under day headings, newest first: the rows come in position order, so a day's rows sit together. */
  protected readonly days = computed((): Day[] => {
    const days: Day[] = [];
    for (const t of this.transactions()) {
      const label = this.chat.dayLabel(t.createdAt);
      const last = days.at(-1);
      if (last && last.label === label) last.rows.push(t);
      else days.push({ label, rows: [t] });
    }
    return days;
  });

  constructor() {
    effect(() => {
      this.accountId();
      untracked(() => void this.refresh());
    });
  }

  protected counterpart(t: TransactionItem): string | null {
    return t.accountId === this.accountId() ? t.accountIdTo : t.accountId;
  }

  /** The row in plain words (history-words.ts), from this account's side. */
  protected words(t: TransactionItem): HistoryWords {
    return historyWords(t, this.accountId());
  }

  /** The amount at the right: "+5 anos", "−5 anos", "5 anos" without a sign for a payout seen by its proposer, nothing for a creation or a proposal. */
  protected amountWords(t: TransactionItem, w: HistoryWords): string {
    if (w.sign === '+') return `+${millionthsToAnos(t.amount)} anos`;
    if (w.sign === '-') return `−${millionthsToAnos(t.amount)} anos`;
    return BigInt(t.amount) > 0n ? `${millionthsToAnos(t.amount)} anos` : '';
  }

  protected toggle(transactionId: string): void {
    this.expanded.update((open) => (open === transactionId ? null : transactionId));
  }

  /** A date changed: both set, or both cleared, reads the first page again; one alone waits for the other. */
  protected changed(): void {
    const from = this.from();
    const to = this.to();
    if ((from && to) || (!from && !to)) void this.refresh();
  }

  protected clearDates(): void {
    this.from.set(null);
    this.to.set(null);
    void this.refresh();
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

  /** The body of a read: HISTORY_PAGE rows, below beforePosition when given and, with a range, from the start of the first day to the start of the day after the last. */
  private body(beforePosition?: number): ListBody {
    const body: ListBody = { limit: HISTORY_PAGE };
    if (beforePosition !== undefined) body.beforePosition = beforePosition;
    const from = this.from();
    const to = this.to();
    if (from && to) {
      body.from = startOfDay(from, 0).toISOString();
      body.to = startOfDay(to, 1).toISOString();
    }
    return body;
  }

  /** The first page of /list-transactions, newest first, within the range when one is set. */
  protected async refresh(): Promise<void> {
    this.readError.set(null);
    this.busy.set(true);
    try {
      const pairOne = await this.pairOne();
      const res = await this.anos.listTransactions(pairOne, this.accountId(), this.body());
      if (!res.ok) {
        this.readError.set(`/list-transactions: ${reasonOf(res)}`);
        return;
      }
      this.transactions.set(res.body.transactions);
      this.canLoadMore.set(res.body.transactions.length >= HISTORY_PAGE);
    } catch (err) {
      this.readError.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }

  /** The next page, before the last row's position, within the same range. */
  protected async loadMore(): Promise<void> {
    const last = this.transactions().at(-1);
    if (!last) return;
    this.busy.set(true);
    try {
      const pairOne = await this.pairOne();
      const res = await this.anos.listTransactions(pairOne, this.accountId(), this.body(last.position));
      if (res.ok) {
        this.transactions.update((list) => [...list, ...res.body.transactions]);
        this.canLoadMore.set(res.body.transactions.length >= HISTORY_PAGE);
      }
    } finally {
      this.busy.set(false);
    }
  }
}

/** Local midnight at the start of the date's day, `plusDays` days on. */
function startOfDay(date: Date, plusDays: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + plusDays);
}
