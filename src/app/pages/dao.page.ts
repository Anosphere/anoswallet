import { Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTabsModule } from '@angular/material/tabs';
import { RouterLink } from '@angular/router';
import { LanguageService } from '../services/language.service';
import { reasonOf } from '../services/log.service';
import { DaoListFilters, DaoListStatus, DaoProposalItem, DaoSettings, MasterpodApiService } from '../services/masterpod-api.service';

/** The tabs in their order: Open votes, Pending, Decided (the plan's decision 15). */
const TABS: DaoListStatus[] = ['open', 'pending', 'decided'];

/** A tab reads this many proposals at a time, and Show more as many more by offset. */
const PAGE = 20;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** What one tab holds: its proposals, whether its first read is done, whether the last page came back full, and its read's refusal. */
interface Tab {
  items: DaoProposalItem[];
  loaded: boolean;
  more: boolean;
  error: string | null;
}

function emptyTabs(): Record<DaoListStatus, Tab> {
  const empty = (): Tab => ({ items: [], loaded: false, more: false, error: null });
  return { open: empty(), pending: empty(), decided: empty() };
}

/**
 * DAO (wallet spec 8.2, DAO; the plan is forclaude/dao-voting-plan-1.md,
 * section 4), at /dao. A header "DAO" with a Refresh icon button and, on a
 * desktop, the New proposal button (a round + at the bottom right on a
 * phone, as Browse). The notice, an info icon and one paragraph in the
 * plain muted style on a surface-container background, never the error
 * container, with the two numbers from the masterpod's settings once the
 * first list answered. Three tabs, Open votes, Pending and Decided: each
 * reads /list-dao-proposals for its status when it is first shown and on
 * Refresh, PAGE at a time, Show more PAGE more by offset while the last
 * page came back full; Refresh forgets every tab and reads the one on
 * screen again. The Decided tab has a date range above its cards, as the
 * history page: both days picked, or both cleared, read again, from at the
 * start of the first day and to at the start of the day after the last.
 * The cards, one column on a phone and two on a desktop: the title in
 * bold; by whom and the date posted; the state line (pending: the support
 * over the support needed with a progress bar and the time left; open: for
 * and against and when the vote closes; decided: Accepted or Rejected as a
 * small label, green or red, for and against and when); under it the
 * caller's own action with the colored thumb icon, the support on a
 * pending card, the vote on an open or decided one. A card opens
 * /dao/<id>. The tab's empty line when nothing came back; a refused read in
 * red.
 */
@Component({
  selector: 'app-dao-page',
  imports: [RouterLink, MatButtonModule, MatIconModule, MatTabsModule, MatProgressBarModule, MatFormFieldModule, MatInputModule, MatDatepickerModule],
  template: `
    <header class="head">
      <h2>{{ t().dao.title }}</h2>
      <span class="spacer"></span>
      <button mat-icon-button type="button" (click)="refresh()" [disabled]="busy()" [attr.aria-label]="t().common.refresh"><mat-icon>refresh</mat-icon></button>
      <a mat-flat-button class="new" routerLink="/dao/new"><mat-icon>add</mat-icon> {{ t().dao.newProposal }}</a>
    </header>

    @if (settings(); as s) {
      <div class="notice">
        <mat-icon>info</mat-icon>
        <p class="muted">{{ t().dao.notice(s.proposalPercent, days(s.voteMinutes)) }}</p>
      </div>
    }
    @if (busy()) {
      <mat-progress-bar mode="indeterminate"></mat-progress-bar>
    }

    <mat-tab-group (selectedIndexChange)="tabChanged($event)">
      @for (status of statuses; track status) {
        <mat-tab [label]="tabLabel(status)">
          @let tab = tabs()[status];
          @if (status === 'decided') {
            <mat-form-field appearance="outline" class="dates" subscriptSizing="dynamic">
              <mat-label>{{ t().history.dates }}</mat-label>
              <mat-date-range-input [rangePicker]="rangePicker">
                <input matStartDate [placeholder]="t().common.from" [value]="from()" (dateChange)="from.set($event.value); datesChanged()" />
                <input matEndDate [placeholder]="t().common.to" [value]="to()" (dateChange)="to.set($event.value); datesChanged()" />
              </mat-date-range-input>
              <mat-datepicker-toggle matIconSuffix [for]="rangePicker" />
              @if (from() || to()) {
                <button mat-icon-button matIconSuffix type="button" (click)="clearDates()" [attr.aria-label]="t().history.clearDates"><mat-icon>close</mat-icon></button>
              }
              <mat-date-range-picker #rangePicker />
            </mat-form-field>
          }
          @if (tab.error; as text) {
            <p class="error">{{ text }}</p>
          }
          @if (tab.loaded && !tab.error && tab.items.length === 0 && !busy()) {
            <p class="muted">{{ emptyLine(status) }}</p>
          }
          <div class="grid">
            @for (p of tab.items; track p.proposalId) {
              <a class="card" [routerLink]="['/dao', p.proposalId]">
                <span class="title">{{ p.title }}</span>
                <span class="muted small">{{ t().dao.by(p.proposer.username ?? t().common.unknownPod, dateOf(p.createdAt)) }}</span>
                @if (p.status === 'pending') {
                  <span>{{ t().dao.supportLine(p.support, p.needed) }}</span>
                  <mat-progress-bar mode="determinate" [value]="percentOf(p)"></mat-progress-bar>
                  <span class="muted small">{{ timeLeft(p.pendingUntil) }}</span>
                  @if (p.yourSupport) {
                    <span class="you"><mat-icon class="for">thumb_up</mat-icon> {{ t().dao.youSupported }}</span>
                  }
                } @else {
                  @if (p.status !== 'open') {
                    <span class="result" [class.for]="p.status === 'accepted'" [class.against]="p.status !== 'accepted'">{{ p.status === 'accepted' ? t().dao.accepted : t().dao.rejected }}</span>
                  }
                  <span>{{ t().dao.forAgainst(p.for, p.against) }}</span>
                  @if (p.status === 'open' && p.voteClosesAt) {
                    <span class="muted small">{{ t().dao.closes(lang.dateTime(p.voteClosesAt)) }}</span>
                  }
                  @if (p.status !== 'open' && p.decidedAt) {
                    <span class="muted small">{{ t().dao.decidedOn(lang.dateTime(p.decidedAt)) }}</span>
                  }
                  @if (p.yourVote) {
                    <span class="you"><mat-icon [class.for]="p.yourVote === 'for'" [class.against]="p.yourVote === 'against'">{{ p.yourVote === 'for' ? 'thumb_up' : 'thumb_down' }}</mat-icon> {{ t().dao.youVoted(p.yourVote) }}</span>
                  }
                }
              </a>
            }
          </div>
          @if (tab.more) {
            <button mat-button type="button" class="more" (click)="loadMore(status)" [disabled]="busy()">{{ t().dao.showMore }}</button>
          }
        </mat-tab>
      }
    </mat-tab-group>

    <a mat-fab class="fab" routerLink="/dao/new" [attr.aria-label]="t().dao.newProposal"><mat-icon>add</mat-icon></a>
  `,
  styles: `
    :host { display: block; padding-bottom: 80px; }
    .head { display: flex; align-items: center; gap: 8px; margin: 0 0 12px; }
    h2 { font-size: 1.25rem; font-weight: 500; margin: 0; }
    .spacer { flex: 1; }
    .notice { display: flex; align-items: flex-start; gap: 12px; padding: 12px 16px; margin: 0 0 12px; border-radius: 12px; background: var(--mat-sys-surface-container); }
    .notice mat-icon { flex: none; color: var(--mat-sys-on-surface-variant); }
    .notice p { margin: 0; }
    .dates { min-width: 280px; margin: 12px 0 4px; }
    .grid { display: grid; grid-template-columns: 1fr; gap: 12px; margin-top: 12px; }
    .card { display: flex; flex-direction: column; gap: 6px; padding: 12px 16px; border: 1px solid var(--mat-sys-outline-variant); border-radius: 12px; background: var(--mat-sys-surface); color: inherit; text-decoration: none; }
    .card:hover { background: var(--mat-sys-surface-container); }
    .title { font-weight: 700; }
    .small { font-size: 13px; }
    .result { align-self: flex-start; font-size: 11px; font-weight: 500; padding: 2px 8px; border-radius: 10px; border: 1px solid currentColor; }
    .you { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; }
    .you mat-icon { font-size: 18px; width: 18px; height: 18px; }
    .for { color: #2e7d32; }
    .against { color: var(--mat-sys-error); }
    .more { margin-top: 8px; }
    .fab { display: none; position: fixed; right: 16px; bottom: 16px; z-index: 1; }
    .muted { color: var(--mat-sys-on-surface-variant); }
    .error { color: var(--mat-sys-error); }
    @media (max-width: 839px) {
      .fab { display: inline-flex; }
      .new { display: none; }
    }
    @media (min-width: 840px) {
      .grid { grid-template-columns: 1fr 1fr; }
    }
  `,
})
export class DaoPage {
  private readonly api = inject(MasterpodApiService);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  protected readonly statuses = TABS;
  protected readonly tabs = signal<Record<DaoListStatus, Tab>>(emptyTabs());
  /** The masterpod's dials, from the first list that answered; null until then, and the notice waits. */
  protected readonly settings = signal<DaoSettings | null>(null);
  protected readonly busy = signal(false);
  /** The tab on screen: the one Refresh reads again. */
  private readonly current = signal<DaoListStatus>('open');
  /** The Decided tab's range: both set, or both cleared, reads again; one alone waits for the other. */
  protected readonly from = signal<Date | null>(null);
  protected readonly to = signal<Date | null>(null);

  constructor() {
    void this.load('open');
  }

  /** The minutes of a setting in days, for the words. */
  protected days(minutes: number): number {
    return Math.round(minutes / 1440);
  }

  protected tabLabel(status: DaoListStatus): string {
    return status === 'open' ? this.t().dao.openVotes : status === 'pending' ? this.t().dao.pending : this.t().dao.decided;
  }

  protected emptyLine(status: DaoListStatus): string {
    return status === 'open' ? this.t().dao.noOpen : status === 'pending' ? this.t().dao.noPending : this.t().dao.noDecided;
  }

  /** The date a proposal was posted, without the time, in the language's own shape. */
  protected dateOf(iso: string): string {
    return new Date(iso).toLocaleDateString(this.lang.tag(), { dateStyle: 'medium' });
  }

  /** The support as a percent of the support needed, for the progress bar, 100 at most. */
  protected percentOf(p: DaoProposalItem): number {
    return p.needed > 0 ? Math.min(100, (p.support / p.needed) * 100) : 0;
  }

  /** The time to `until` in whole days, or in hours (rounded up) under a day; nothing below zero. */
  protected timeLeft(until: string): string {
    const ms = Math.max(0, new Date(until).getTime() - Date.now());
    return this.t().dao.timeLeft(Math.floor(ms / DAY_MS), Math.ceil(ms / HOUR_MS));
  }

  /** A tab shown: its first read, if it has not had one. */
  protected tabChanged(index: number): void {
    const status = TABS[index] ?? 'open';
    this.current.set(status);
    if (!this.tabs()[status].loaded) void this.load(status);
  }

  /** Every tab forgotten; the one on screen read again, the others when they are shown next. */
  protected refresh(): void {
    this.tabs.set(emptyTabs());
    void this.load(this.current());
  }

  protected loadMore(status: DaoListStatus): void {
    void this.load(status, this.tabs()[status].items.length);
  }

  protected datesChanged(): void {
    const from = this.from();
    const to = this.to();
    if ((from && to) || (!from && !to)) void this.load('decided');
  }

  protected clearDates(): void {
    this.from.set(null);
    this.to.set(null);
    void this.load('decided');
  }

  /** One page of /list-dao-proposals for a tab: the first page replaces, a later one is added; the settings feed the notice; a refusal shows under the tab. */
  private async load(status: DaoListStatus, offset = 0): Promise<void> {
    const body: DaoListFilters = { status, limit: PAGE, offset };
    const from = this.from();
    const to = this.to();
    if (status === 'decided' && from && to) {
      body.from = startOfDay(from, 0).toISOString();
      body.to = startOfDay(to, 1).toISOString();
    }
    this.busy.set(true);
    try {
      const res = await this.api.listDaoProposals(body);
      if (res.ok) {
        const page = res.body.proposals;
        this.settings.set(res.body.settings);
        this.tabs.update((tabs) => ({
          ...tabs,
          [status]: { items: offset === 0 ? page : [...tabs[status].items, ...page], loaded: true, more: page.length >= PAGE, error: null },
        }));
      } else {
        this.tabs.update((tabs) => ({ ...tabs, [status]: { ...tabs[status], loaded: true, error: `/list-dao-proposals: ${reasonOf(res)}` } }));
      }
    } finally {
      this.busy.set(false);
    }
  }
}

/** Local midnight at the start of the date's day, `plusDays` days on (the history page's shape of a range). */
function startOfDay(date: Date, plusDays: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + plusDays);
}
