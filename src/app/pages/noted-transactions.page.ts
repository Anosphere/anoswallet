import { Component, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { RouterLink } from '@angular/router';
import { accountNames } from '../account-names';
import { millionthsToAnos } from '../amounts';
import { CopyButtonComponent } from '../components/copy-button.component';
import { NoteFormComponent } from '../components/note-form.component';
import { formatPrice, perAnosOf, priceUnits } from '../prices';
import { ChatService } from '../services/chat.service';
import { LanguageService } from '../services/language.service';
import { MasterpodApiService, NoteRange } from '../services/masterpod-api.service';
import { Note, NotesService } from '../services/notes.service';
import { SessionService } from '../services/session.service';
import { shortId } from '../short-id';

/** The chips: all, the three money kinds, and every other kind. */
type Chip = 'all' | 'bought' | 'sold' | 'income' | 'other';

/** The rows of one day under their heading. */
interface Day {
  label: string;
  rows: Note[];
}

/** One totals line: its currency and its words. */
interface TotalsLine {
  currency: string;
  words: string;
}

/** The sums of bought, sold and income in price units (10^-8), as priceUnits counts them. */
interface Sums {
  bought: bigint;
  sold: bigint;
  income: bigint;
}

/** One unit of money is this many price units (prices.ts, eight decimals). */
const PRICE_UNITS = 100_000_000n;

/**
 * The Noted transactions page (wallet spec 8.2; 2026-11-07, section 11),
 * at /wallet/notes, opened by the button on the Wallet page: the pod's
 * notes over every account, newest transaction first, in day headings as
 * the history page; the date range read from the masterpod
 * (/list-noted-transactions, from and to as the history page sends them);
 * the kind chips and the totals per currency on the phone, since the kind
 * and the money are inside the blob; Download as CSV, built on the phone;
 * the details under a tapped row with Edit (the note form) and Remove.
 */
@Component({
  selector: 'app-noted-transactions-page',
  imports: [RouterLink, MatCardModule, MatButtonModule, MatIconModule, MatChipsModule, MatProgressBarModule, MatFormFieldModule, MatInputModule, MatDatepickerModule, CopyButtonComponent, NoteFormComponent],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>{{ t().notes.pageTitle }}</mat-card-title>
      </mat-card-header>
      <mat-card-content>
        <p><a mat-button routerLink="/wallet"><mat-icon>arrow_back</mat-icon> {{ t().nav.wallet }}</a></p>
        <div class="row">
          <mat-form-field appearance="outline" class="dates" subscriptSizing="dynamic">
            <mat-label>{{ t().history.dates }}</mat-label>
            <mat-date-range-input [rangePicker]="rangePicker">
              <input matStartDate [placeholder]="t().common.from" [value]="from()" (dateChange)="from.set($event.value); changed()" />
              <input matEndDate [placeholder]="t().common.to" [value]="to()" (dateChange)="to.set($event.value); changed()" />
            </mat-date-range-input>
            <mat-datepicker-toggle matIconSuffix [for]="rangePicker" />
            @if (from() || to()) {
              <button mat-icon-button matIconSuffix type="button" (click)="clearDates()" [attr.aria-label]="t().history.clearDates"><mat-icon>close</mat-icon></button>
            }
            <mat-date-range-picker #rangePicker />
          </mat-form-field>
          <button mat-stroked-button type="button" (click)="refresh()" [disabled]="busy()">{{ t().common.refresh }}</button>
          <button mat-stroked-button type="button" (click)="downloadCsv()" [disabled]="shown().length === 0">{{ t().notes.download }}</button>
        </div>
        <mat-chip-listbox class="chips" [attr.aria-label]="t().common.kind" [value]="chip()" (change)="chip.set($event.value ?? 'all')">
          <mat-chip-option value="all">{{ t().common.all }}</mat-chip-option>
          <mat-chip-option value="bought">{{ t().notes.kinds.bought }}</mat-chip-option>
          <mat-chip-option value="sold">{{ t().notes.kinds.sold }}</mat-chip-option>
          <mat-chip-option value="income">{{ t().notes.incomeChip }}</mat-chip-option>
          <mat-chip-option value="other">{{ t().notes.kinds.other }}</mat-chip-option>
        </mat-chip-listbox>
        @for (line of totals(); track line.currency) {
          <p class="totals">{{ line.words }}</p>
        }
        @if (notes.more()) {
          <p class="muted">{{ t().notes.capped }}</p>
        }
        @if (error(); as text) {
          <p class="error">{{ text }}</p>
        }
        @if (busy()) {
          <mat-progress-bar mode="indeterminate"></mat-progress-bar>
        }
        @for (day of days(); track day.label) {
          <h4 class="day">{{ day.label }}</h4>
          @for (note of day.rows; track note.noteId) {
            <button type="button" class="entry" (click)="toggle(note.noteId)" [attr.aria-expanded]="expanded() === note.noteId">
              <mat-icon>{{ note.sent ? 'call_made' : 'call_received' }}</mat-icon>
              <span class="text">
                <span class="title">{{ titleOf(note) }}</span>
                <span class="muted">{{ anosOf(note) }} · {{ accountName(note) }} · {{ chat.timeOf(note.transactedAt) }}</span>
              </span>
              <span class="amount">{{ moneyOf(note) }}</span>
            </button>
            @if (expanded() === note.noteId) {
              <div class="details">
                @if (priceOf(note); as price) {
                  <div><span class="label">{{ t().common.pricePerAnos }}</span><span>{{ price }}</span></div>
                }
                @if (note.details?.memo) {
                  <div><span class="label">{{ t().notes.memo }}</span><span>{{ note.details!.memo }}</span></div>
                }
                <div><span class="label">{{ t().common.account }}</span><span>{{ accountName(note) }} · <code>{{ shortId(note.accountId) }}</code></span></div>
                @if (note.otherAccountId; as other) {
                  <div><span class="label">{{ note.sent ? t().common.to : t().common.from }}</span><span><code>{{ other }}</code> <app-copy-button [text]="other" [label]="t().common.copyAccountId" /></span></div>
                }
                <div><span class="label">{{ t().common.transaction }}</span><span><code>{{ note.transactionId }}</code> <app-copy-button [text]="note.transactionId" [label]="t().common.copyTransactionId" /></span></div>
                <div><span class="label">{{ t().history.position }}</span><span>#{{ note.position }}</span></div>
                <div><span class="label">{{ t().history.when }}</span><span>{{ lang.dateTime(note.transactedAt) }}</span></div>
              </div>
              @if (confirmRemove() === note.noteId) {
                <div class="buttons"><span>{{ t().notes.askRemove }}</span>
                  <button mat-flat-button type="button" (click)="removeNote(note)" [disabled]="noteBusy()">{{ t().common.yes }}</button>
                  <button mat-button type="button" (click)="confirmRemove.set(null)">{{ t().common.back }}</button></div>
              } @else if (editing() !== note.noteId) {
                <div class="buttons">
                  <button mat-stroked-button type="button" (click)="editing.set(note.noteId)">{{ t().notes.edit }}</button>
                  <button mat-button type="button" (click)="confirmRemove.set(note.noteId)">{{ t().common.remove }}</button></div>
              }
              @if (editing() === note.noteId) {
                <div class="form"><app-note-form [note]="note" [accountId]="note.accountId" (saved)="editing.set(null)" (cancelled)="editing.set(null)" /></div>
              }
              @if (noteError(); as text) {
                <p class="error">{{ text }}</p>
              }
            }
          }
        } @empty {
          @if (!busy() && !error()) {
            <p class="muted">{{ from() && to() ? t().notes.noneBetween : t().notes.none }}</p>
          }
        }
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 8px 0; }
    .dates { min-width: 280px; }
    .chips { margin: 4px 0 8px; }
    .totals { font-weight: 500; margin: 8px 0 0; }
    .day { margin: 16px 0 0; font-size: 13px; font-weight: 500; color: var(--mat-sys-on-surface-variant); }
    .entry { display: flex; align-items: center; gap: 12px; width: 100%; padding: 10px 4px; border: 0; border-bottom: 1px solid var(--mat-sys-outline-variant); background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
    .entry:hover { background: var(--mat-sys-surface-container-low); }
    .text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .title { font-weight: 500; }
    .amount { white-space: nowrap; font-weight: 500; }
    .details { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; padding: 8px 4px 12px 48px; border-bottom: 1px solid var(--mat-sys-outline-variant); }
    .details div { display: contents; }
    .buttons { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 0 4px 12px 48px; }
    .form { padding: 0 4px 12px 48px; }
    .label { color: var(--mat-sys-on-surface-variant); }
    .muted { color: var(--mat-sys-on-surface-variant); }
    .error { color: var(--mat-sys-error); }
    code { font-size: 12px; word-break: break-all; }
  `,
})
export class NotedTransactionsPage {
  protected readonly notes = inject(NotesService);
  private readonly session = inject(SessionService);
  private readonly masterpod = inject(MasterpodApiService);
  /** For dayLabel and timeOf, so days read the same here, in the history and in Chat. */
  protected readonly chat = inject(ChatService);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  protected readonly shortId = shortId;
  /** The range picked: with both set, or both cleared, the notes are read again; one alone waits for the other. */
  protected readonly from = signal<Date | null>(null);
  protected readonly to = signal<Date | null>(null);
  protected readonly chip = signal<Chip>('all');
  /** The note whose details are open, or null. */
  protected readonly expanded = signal<string | null>(null);
  /** The note whose form is open, or null. */
  protected readonly editing = signal<string | null>(null);
  /** The note id whose Remove asks, or null. */
  protected readonly confirmRemove = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly noteBusy = signal(false);
  protected readonly noteError = signal<string | null>(null);

  /** The accounts' names by id (account-names.ts). */
  private readonly names = computed(() => accountNames(this.session.accounts(), this.t().accountKinds));

  /** The notes the chip lets through: all; the kind for bought, sold and income; every other kind for other, a note that cannot be read among them. */
  protected readonly shown = computed((): Note[] => {
    const chip = this.chip();
    const all = this.notes.notes() ?? [];
    if (chip === 'all') return all;
    return all.filter((note) => {
      const kind = note.details?.kind;
      if (chip === 'other') return kind !== 'bought' && kind !== 'sold' && kind !== 'income';
      return kind === chip;
    });
  });

  /** The rows under day headings, in the masterpod's order (newest transaction first), so a day's rows sit together. */
  protected readonly days = computed((): Day[] => {
    const days: Day[] = [];
    for (const note of this.shown()) {
      const label = this.chat.dayLabel(note.transactedAt);
      const last = days.at(-1);
      if (last && last.label === label) last.rows.push(note);
      else days.push({ label, rows: [note] });
    }
    return days;
  });

  /** One line per currency among the shown notes with money, in the order the currencies first appear: the sums of bought, sold and income on the digits, "0" when none. */
  protected readonly totals = computed((): TotalsLine[] => {
    const sums = new Map<string, Sums>();
    for (const note of this.shown()) {
      const details = note.details;
      if (!details || details.money === null || details.currency === null) continue;
      const units = priceUnits(details.money);
      if (units === null) continue;
      const sum = sums.get(details.currency) ?? { bought: 0n, sold: 0n, income: 0n };
      if (details.kind === 'bought') sum.bought += units;
      else if (details.kind === 'sold') sum.sold += units;
      else if (details.kind === 'income') sum.income += units;
      sums.set(details.currency, sum);
    }
    return [...sums].map(([currency, sum]) => ({
      currency,
      words: this.t().notes.totalsLine(formatPrice(unitsToText(sum.bought), currency), formatPrice(unitsToText(sum.sold), currency), formatPrice(unitsToText(sum.income), currency)),
    }));
  });

  constructor() {
    void this.refresh();
  }

  /** The row's title: the kind's words, the tag for other, "(cannot read)" for a blob that did not open. */
  protected titleOf(note: Note): string {
    const details = note.details;
    if (!details) return this.t().notes.cannotRead;
    return details.kind === 'other' && details.tag !== '' ? details.tag : this.t().notes.kinds[details.kind];
  }

  /** The anos with their sign: "−5 anos" when sent, "+5 anos" otherwise. */
  protected anosOf(note: Note): string {
    const anos = millionthsToAnos(note.amount);
    return note.sent ? this.t().history.minus(anos) : this.t().history.plus(anos);
  }

  /** The money at the right, "3,550.00 THB", or nothing. */
  protected moneyOf(note: Note): string {
    const details = note.details;
    return details && details.money !== null && details.currency !== null ? formatPrice(details.money, details.currency) : '';
  }

  /** The price per anos, "35.50 THB", when the money and the amount allow it. */
  protected priceOf(note: Note): string | null {
    const details = note.details;
    if (!details || details.money === null || details.currency === null) return null;
    const per = perAnosOf(details.money, note.amount);
    return per === null ? null : formatPrice(per, details.currency);
  }

  /** The account's name by its type (account-names.ts); "Account" for one the session does not hold. */
  protected accountName(note: Note): string {
    return this.names().get(note.accountId) ?? this.t().common.account;
  }

  protected toggle(noteId: string): void {
    this.expanded.update((open) => (open === noteId ? null : noteId));
  }

  /** A date changed: both set, or both cleared, reads again; one alone waits for the other. */
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

  /** The accounts into the session when it has none (quiet, as the history page's pairOne does), then the notes in the range; a refusal in red. */
  protected async refresh(): Promise<void> {
    this.error.set(null);
    this.busy.set(true);
    try {
      if (this.session.accounts().length === 0) {
        const res = await this.masterpod.listAnosAccounts(true);
        if (res.ok) this.session.accounts.set(res.body.accounts);
      }
      await this.notes.load(this.range(), false);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }

  /** Remove, after the ask: notes.remove; the ask closes, a refusal shows in red. */
  protected async removeNote(note: Note): Promise<void> {
    this.noteBusy.set(true);
    this.noteError.set(null);
    try {
      await this.notes.remove(note);
    } catch (err) {
      this.noteError.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.confirmRemove.set(null);
      this.noteBusy.set(false);
    }
  }

  /**
   * The CSV, built on the phone: the header, then one line per shown note,
   * newest first, the fields of wallet spec 8.2 (the date as ISO 8601, the
   * kind's words as on screen, the anos, sent or received, the money as
   * typed, the currency, the price per anos, the memo, the account's name,
   * the other account, the transaction id, the position), quoted when they
   * need it; CR LF line ends and the UTF-8 byte order mark first, so a
   * spreadsheet opens Thai letters right. A Blob handed to a temporary link.
   */
  protected downloadCsv(): void {
    const words = this.t().notes;
    const lines = [words.csvHeader];
    for (const note of this.shown()) {
      const details = note.details;
      const fields = [
        note.transactedAt,
        this.titleOf(note),
        millionthsToAnos(note.amount),
        note.sent ? words.sentWord : words.receivedWord,
        details?.money ?? '',
        details?.currency ?? '',
        details && details.money !== null ? (perAnosOf(details.money, note.amount) ?? '') : '',
        details?.memo ?? '',
        this.accountName(note),
        note.otherAccountId ?? '',
        note.transactionId,
        String(note.position),
      ];
      lines.push(fields.map(csvField).join(','));
    }
    const blob = new Blob(['﻿' + lines.join('\r\n') + '\r\n'], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = this.csvName();
    link.click();
    URL.revokeObjectURL(url);
  }

  /** noted-transactions.csv, or noted-transactions-<from>-<to>.csv with a range, the dates as YYYY-MM-DD. */
  private csvName(): string {
    const from = this.from();
    const to = this.to();
    return from && to ? `noted-transactions-${dayText(from)}-${dayText(to)}.csv` : 'noted-transactions.csv';
  }

  /** The range of the read, as the history page sends it: from the start of the first day to the start of the day after the last (local midnight, ISO 8601); empty without both dates. */
  private range(): NoteRange {
    const from = this.from();
    const to = this.to();
    if (!from || !to) return {};
    return { from: startOfDay(from, 0).toISOString(), to: startOfDay(to, 1).toISOString() };
  }
}

/** A field of the CSV: in double quotes, its double quotes doubled, when it holds a comma, a double quote, a line break or a leading or trailing space. */
function csvField(value: string): string {
  return /[",\r\n]|^ | $/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** A sum of price units as a decimal string, trailing zeros trimmed: "3550" for 355000000000n, "0" for none. */
function unitsToText(units: bigint): string {
  const whole = units / PRICE_UNITS;
  const rest = units % PRICE_UNITS;
  if (rest === 0n) return `${whole}`;
  return `${whole}.${rest.toString().padStart(8, '0').replace(/0+$/, '')}`;
}

/** Local midnight at the start of the date's day, `plusDays` days on. */
function startOfDay(date: Date, plusDays: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + plusDays);
}

/** A date as YYYY-MM-DD by the local clock, for the file name. */
function dayText(date: Date): string {
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}-${`${date.getDate()}`.padStart(2, '0')}`;
}
