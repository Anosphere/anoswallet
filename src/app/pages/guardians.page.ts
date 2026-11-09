import { Component, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTabsModule } from '@angular/material/tabs';
import { RouterLink } from '@angular/router';
import { millionthsToAnos } from '../amounts';
import { CopyButtonComponent } from '../components/copy-button.component';
import { AnosApiService, FundListFilters, FundProposalItem, FundSettings } from '../services/anos-api.service';
import { Vote } from '../services/crypto.service';
import { GuardianAccount, GuardianAccountsService } from '../services/guardian-accounts.service';
import { LanguageService } from '../services/language.service';
import { reasonOf } from '../services/log.service';
import { shortId } from '../short-id';

/** The two lists of /list-fund-proposals, the tabs in their order: Open vote, Decided. */
type ListStatus = FundListFilters['status'];
const TABS: ListStatus[] = ['open', 'decided'];

/** The Decided tab reads this many proposals at a time, and Show more as many more by offset. */
const PAGE = 20;

/** What one tab holds: its proposals, whether its first read is done, whether the last page came back full, and its read's refusal. */
interface Tab {
  items: FundProposalItem[];
  loaded: boolean;
  more: boolean;
  error: string | null;
}

function emptyTabs(): Record<ListStatus, Tab> {
  const empty = (): Tab => ({ items: [], loaded: false, more: false, error: null });
  return { open: empty(), decided: empty() };
}

/** The caller's part in a proposal, for the line under a card: the proposer, a vote, or nothing. */
type YourPart = 'proposed' | Vote | null;

/**
 * Guardians (wallet spec 8.2, Guardians; the plan is
 * forclaude/wallet-guardians-plan-1.md, section 3), at /dao/guardians, in
 * the frame of the DAO page. A header with a back arrow to /dao,
 * "Guardians", a Refresh icon button and, on a desktop, the New proposal
 * button (a round + at the bottom right on a phone). The notice, an info
 * icon and one paragraph in the plain muted style on a surface-container
 * background, never the error container, with the numbers from the
 * validator's settings once the first list answered. "Your guardian
 * accounts": when the page opens and on Refresh, /get-account for each of
 * the pod's accounts, quietly (guardian-accounts.service); the accounts
 * with guardian votes listed as the short id with a copy button and
 * "3 votes", the biggest first, every one of them able to propose and
 * vote; with none, how to become a guardian, with the least stake from the
 * settings, and a link to the Wallet. New proposal is enabled with a
 * guardian account and no proposal in the Open vote tab (a refused list
 * leaves it enabled: the validator refuses with words). Two tabs: Open
 * vote reads /list-fund-proposals { status: 'open' }, one card at most;
 * Decided reads { status: 'decided', limit: 20, offset }, Show more adds
 * 20 while the last page came back full, with a date range above its
 * cards as the DAO's Decided tab. Refresh forgets both tabs, reads the one
 * on screen again and the accounts again. The cards, one column on a phone
 * and two on a desktop: "Fund proposal" and the short id in bold; by whom
 * and the date; the payouts counted and summed; the state line (open: for
 * and against, a progress bar of for over for plus against, the percent
 * needed and when the vote closes; waiting and closing: the status words;
 * decided: the status as a small label, green for written and red for
 * failed, for and against and when); under it "You proposed this", or
 * "You voted for" with the colored thumb when one of the caller's accounts
 * voted (the biggest account's vote when they differ). A card opens
 * /dao/guardians/<id>. The tab's empty line when nothing came back; a
 * refused read in red under the tab ("/list-fund-proposals: HTTP 404: Not
 * Found" against a validator or a doorman without the route), and the
 * rest of the wallet works.
 */
@Component({
  selector: 'app-guardians-page',
  imports: [RouterLink, MatButtonModule, MatIconModule, MatTabsModule, MatProgressBarModule, MatFormFieldModule, MatInputModule, MatDatepickerModule, CopyButtonComponent],
  template: `
    <header class="head">
      <a mat-icon-button routerLink="/dao" [attr.aria-label]="t().common.back"><mat-icon>arrow_back</mat-icon></a>
      <h2>{{ t().guardians.title }}</h2>
      <span class="spacer"></span>
      <button mat-icon-button type="button" (click)="refresh()" [disabled]="busy() || readingAccounts()" [attr.aria-label]="t().common.refresh"><mat-icon>refresh</mat-icon></button>
      <button mat-flat-button type="button" class="new" routerLink="/dao/guardians/new" [disabled]="!canPropose()"><mat-icon>add</mat-icon> {{ t().guardians.newProposal }}</button>
    </header>

    @if (settings(); as s) {
      <div class="notice">
        <mat-icon>info</mat-icon>
        <p class="muted">{{ t().guardians.notice(anosOf(s.anosPerVote), s.percent, t().minutes(s.minutes)) }}</p>
      </div>
    }

    <h3>{{ t().guardians.yourAccounts }}</h3>
    @if (readingAccounts()) {
      <p class="muted">{{ t().common.reading }}</p>
    } @else if (accounts().length > 0) {
      @for (a of accounts(); track a.accountId) {
        <div class="account">
          <code>{{ shortId(a.accountId) }}</code>
          <app-copy-button [text]="a.accountId" [label]="t().common.copyAccountId" />
          <span class="muted">{{ t().guardians.accountVotes(a.votes) }}</span>
        </div>
      }
    } @else if (settings(); as s) {
      <p class="muted">{{ t().guardians.noGuardianAccount(anosOf(s.minimumStake)) }}</p>
      <p><a mat-stroked-button routerLink="/wallet"><mat-icon>account_balance_wallet</mat-icon> {{ t().nav.wallet }}</a></p>
    }

    @if (busy()) {
      <mat-progress-bar mode="indeterminate"></mat-progress-bar>
    }

    <mat-tab-group (selectedIndexChange)="tabChanged($event)">
      @for (status of statuses; track status) {
        <mat-tab [label]="status === 'open' ? t().guardians.openVote : t().guardians.decided">
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
            <p class="muted">{{ status === 'open' ? t().guardians.noOpen : t().guardians.noDecided }}</p>
          }
          <div class="grid">
            @for (p of tab.items; track p.transactionId) {
              <a class="card" [routerLink]="['/dao/guardians', p.transactionId]">
                <span class="title">{{ t().guardians.fundProposal }} <code>{{ shortId(p.transactionId) }}</code></span>
                <span class="muted small">{{ t().guardians.proposedBy(shortId(p.guardianId), dateOf(p.createdAt)) }}</span>
                <span>{{ t().guardians.payouts(p.payoutCount, anosOf(p.total)) }}</span>
                @if (p.status === 'open') {
                  <span>{{ t().guardians.forAgainst(p.forWeight, p.againstWeight) }}</span>
                  <mat-progress-bar mode="determinate" [value]="percentOf(p)"></mat-progress-bar>
                  <span class="muted small">
                    @if (settings(); as s) {
                      {{ t().guardians.needs(s.percent) }} ·
                    }
                    {{ t().guardians.closes(lang.dateTime(p.voteClosesAt)) }}
                  </span>
                } @else if (p.status === 'waiting' || p.status === 'closing') {
                  <span class="muted">{{ statusWord(p.status) }}</span>
                } @else {
                  <span class="result" [class.for]="p.status === 'written'" [class.against]="p.status === 'failed'">{{ statusWord(p.status) }}</span>
                  <span>{{ t().guardians.forAgainst(p.forWeight, p.againstWeight) }}</span>
                  @if (p.decidedAt) {
                    <span class="muted small">{{ t().guardians.decidedOn(lang.dateTime(p.decidedAt)) }}</span>
                  }
                }
                @if (yourPart(p); as part) {
                  @if (part === 'proposed') {
                    <span class="you"><mat-icon class="for">thumb_up</mat-icon> {{ t().guardians.youProposed }}</span>
                  } @else {
                    <span class="you"><mat-icon [class.for]="part === 'for'" [class.against]="part === 'against'">{{ part === 'for' ? 'thumb_up' : 'thumb_down' }}</mat-icon> {{ t().guardians.youVoted(part) }}</span>
                  }
                }
              </a>
            }
          </div>
          @if (tab.more) {
            <button mat-button type="button" class="more" (click)="loadMore(status)" [disabled]="busy()">{{ t().guardians.showMore }}</button>
          }
        </mat-tab>
      }
    </mat-tab-group>

    <button mat-fab type="button" class="fab" routerLink="/dao/guardians/new" [disabled]="!canPropose()" [attr.aria-label]="t().guardians.newProposal"><mat-icon>add</mat-icon></button>
  `,
  styles: `
    :host { display: block; padding-bottom: 80px; }
    .head { display: flex; align-items: center; gap: 8px; margin: 0 0 12px; }
    h2 { font-size: 1.25rem; font-weight: 500; margin: 0; }
    h3 { font-size: 1rem; font-weight: 500; margin: 16px 0 4px; }
    .spacer { flex: 1; }
    .notice { display: flex; align-items: flex-start; gap: 12px; padding: 12px 16px; margin: 0 0 12px; border-radius: 12px; background: var(--mat-sys-surface-container); }
    .notice mat-icon { flex: none; color: var(--mat-sys-on-surface-variant); }
    .notice p { margin: 0; }
    .account { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
    .account code { font-size: 13px; }
    .dates { min-width: 280px; margin: 12px 0 4px; }
    .grid { display: grid; grid-template-columns: 1fr; gap: 12px; margin-top: 12px; }
    .card { display: flex; flex-direction: column; gap: 6px; padding: 12px 16px; border: 1px solid var(--mat-sys-outline-variant); border-radius: 12px; background: var(--mat-sys-surface); color: inherit; text-decoration: none; }
    .card:hover { background: var(--mat-sys-surface-container); }
    .title { font-weight: 700; }
    .title code { font-size: 13px; }
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
export class GuardiansPage {
  private readonly api = inject(AnosApiService);
  private readonly guardians = inject(GuardianAccountsService);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  protected readonly shortId = shortId;
  protected readonly anosOf = millionthsToAnos;
  protected readonly statuses = TABS;
  protected readonly tabs = signal<Record<ListStatus, Tab>>(emptyTabs());
  /** The validator's dials, from the first list that answered; null until then, and the notice waits. */
  protected readonly settings = signal<FundSettings | null>(null);
  /** True while a list read is out. */
  protected readonly busy = signal(false);
  /** The pod's accounts with guardian votes, the biggest first (guardian-accounts.service). */
  protected readonly accounts = signal<GuardianAccount[]>([]);
  protected readonly readingAccounts = signal(false);
  /** The tab on screen: the one Refresh reads again. */
  private readonly current = signal<ListStatus>('open');
  /** The Decided tab's range: both set, or both cleared, reads again; one alone waits for the other. */
  protected readonly from = signal<Date | null>(null);
  protected readonly to = signal<Date | null>(null);

  /** New proposal: a guardian account, and no proposal in the Open vote tab; a refused list leaves it enabled, since the validator refuses with words. */
  protected readonly canPropose = computed(() => {
    const open = this.tabs().open;
    return this.accounts().length > 0 && (open.error !== null || open.items.length === 0);
  });

  constructor() {
    void this.load('open');
    void this.readAccounts();
  }

  /** The date a proposal was made, without the time, in the language's own shape (the DAO page's cards). */
  protected dateOf(iso: string): string {
    return new Date(iso).toLocaleDateString(this.lang.tag(), { dateStyle: 'medium' });
  }

  /** The votes for as a percent of the votes cast, for the progress bar; 0 before any vote. */
  protected percentOf(p: FundProposalItem): number {
    const cast = p.forWeight + p.againstWeight;
    return cast > 0 ? (p.forWeight / cast) * 100 : 0;
  }

  /** The status in words; a word the wallet does not know shows as it is (anossoftware 25.2). */
  protected statusWord(status: string): string {
    return this.t().guardians.statuses[status] ?? status;
  }

  /** The caller's part: the proposer when one of the pod's guardian accounts proposed it, else the vote of the biggest of them that voted, else nothing. */
  protected yourPart(p: FundProposalItem): YourPart {
    const mine = this.accounts();
    if (mine.some((a) => a.accountId === p.guardianId)) return 'proposed';
    for (const a of mine) {
      const vote = p.votes.find((v) => v.guardianId === a.accountId);
      if (vote) return vote.vote;
    }
    return null;
  }

  /** A tab shown: its first read, if it has not had one. */
  protected tabChanged(index: number): void {
    const status = TABS[index] ?? 'open';
    this.current.set(status);
    if (!this.tabs()[status].loaded) void this.load(status);
  }

  /** Both tabs forgotten; the one on screen read again, the other when it is shown next; the guardian accounts read again. */
  protected refresh(): void {
    this.tabs.set(emptyTabs());
    void this.load(this.current());
    void this.readAccounts();
  }

  protected loadMore(status: ListStatus): void {
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

  /** The pod's guardian accounts, quietly; the list on screen stays until the new one is in. */
  private async readAccounts(): Promise<void> {
    this.readingAccounts.set(true);
    try {
      this.accounts.set(await this.guardians.read());
    } finally {
      this.readingAccounts.set(false);
    }
  }

  /** One read of /list-fund-proposals for a tab: open asks for the one open proposal, decided for a page of the archives (the first page replaces, a later one is added); the settings feed the notice; a refusal shows under the tab. */
  private async load(status: ListStatus, offset = 0): Promise<void> {
    const body: FundListFilters = status === 'open' ? { status } : { status, limit: PAGE, offset };
    const from = this.from();
    const to = this.to();
    if (status === 'decided' && from && to) {
      body.from = startOfDay(from, 0).toISOString();
      body.to = startOfDay(to, 1).toISOString();
    }
    this.busy.set(true);
    try {
      const res = await this.api.listFundProposals(body);
      if (res.ok) {
        const page = res.body.proposals;
        this.settings.set(res.body.settings);
        this.tabs.update((tabs) => ({
          ...tabs,
          [status]: { items: offset === 0 ? page : [...tabs[status].items, ...page], loaded: true, more: status === 'decided' && page.length >= PAGE, error: null },
        }));
      } else {
        this.tabs.update((tabs) => ({ ...tabs, [status]: { ...tabs[status], loaded: true, error: `/list-fund-proposals: ${reasonOf(res)}` } }));
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
