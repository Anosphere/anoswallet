import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { RouterLink } from '@angular/router';
import { accountNames } from '../account-names';
import { AvatarComponent } from '../components/avatar.component';
import { BalanceCardComponent } from '../components/balance-card.component';
import { ACCOUNT_POLL_MS } from '../constants';
import { AnosApiService, FundProposalItem } from '../services/anos-api.service';
import { BalancesService } from '../services/balances.service';
import { LanguageService } from '../services/language.service';
import { reasonOf } from '../services/log.service';
import { MasterpodApiService } from '../services/masterpod-api.service';
import { NavigationService } from '../services/navigation.service';
import { SessionService } from '../services/session.service';
import { SettingsService } from '../services/settings.service';

/** One line of Things to do: where it goes, its icon and its words. */
interface TodoLine {
  path: string;
  icon: string;
  words: string;
}

/**
 * Home (wallet spec 8.2), at /home, where an unlock lands once setup is
 * complete; no outer card, the pieces sit on the page. The greeting with
 * the avatar (8.6) and the first name, the username when it is empty; the
 * balance card (balance-card.component over balances.service, shared with
 * the Wallet page); "Things to do", a short list of links, hidden when
 * none applies, "Protect your passkey" among them on an Android phone
 * while the recorded answer is skipped (2026-11-07); the tiles, one per
 * side-panel entry except Home itself
 * and Log, drawn from navigation.service so the two cannot drift apart,
 * Chat and Notifications carrying their unread counts. On open the
 * accounts are listed (/list-anos-accounts, quiet) into the session and
 * the balances read; every 5 seconds they are read again while an account
 * is not on the ledger yet or any anos are held or pending, as the Wallet
 * page does. Beside the accounts the open DAO proposals are listed
 * (quiet) for the line "2 proposals open for your vote" (2026-11-08), and
 * the open fund proposal (/list-fund-proposals, quiet) for the line "A fund
 * proposal is open for your vote", shown while one of the pod's guardian
 * accounts (guardianVotes in its balance entry) can still vote on it
 * (2026-11-08, the Guardians plan's 4.2).
 */
@Component({
  selector: 'app-home-page',
  imports: [RouterLink, MatListModule, MatIconModule, AvatarComponent, BalanceCardComponent],
  template: `
    <div class="greeting">
      <app-avatar [anopodId]="session.anopodId() ?? ''" [username]="session.username()" [size]="56" />
      <h2>{{ t().home.hello(session.firstName() || session.username()) }}</h2>
    </div>
    @if (listError(); as text) {
      <p class="error">{{ text }}</p>
    }
    <app-balance-card />
    @if (todo().length > 0) {
      <h3>{{ t().home.todoTitle }}</h3>
      <mat-nav-list>
        @for (line of todo(); track $index) {
          <a mat-list-item [routerLink]="line.path">
            <mat-icon matListItemIcon>{{ line.icon }}</mat-icon>
            <span matListItemTitle>{{ line.words }}</span>
          </a>
        }
      </mat-nav-list>
    }
    <div class="tiles">
      @for (tile of tiles(); track tile.path) {
        <a class="tile" [routerLink]="tile.path">
          @if (tile.badge) {
            <span class="badge">{{ tile.badge }}</span>
          }
          <mat-icon>{{ tile.icon }}</mat-icon>
          <span class="label">{{ tile.label }}</span>
        </a>
      }
    </div>
  `,
  styles: `
    :host { display: block; }
    .greeting { display: flex; align-items: center; gap: 16px; margin: 8px 0 16px; }
    .greeting h2 { margin: 0; font-size: 24px; font-weight: 500; }
    h3 { margin: 24px 0 4px; }
    .error { color: var(--mat-sys-error); }
    .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 12px; margin-top: 24px; }
    .tile { position: relative; aspect-ratio: 1; border-radius: 16px; background: var(--mat-sys-surface-container); color: var(--mat-sys-on-surface); text-decoration: none; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; }
    .tile mat-icon { font-size: 36px; width: 36px; height: 36px; color: var(--mat-sys-primary); }
    .label { font-weight: 500; }
    .badge { position: absolute; top: 12px; right: 12px; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px; background: var(--mat-sys-primary); color: var(--mat-sys-on-primary); font-size: 12px; font-weight: 500; display: inline-flex; align-items: center; justify-content: center; }
  `,
})
export class HomePage {
  protected readonly session = inject(SessionService);
  private readonly navigation = inject(NavigationService);
  private readonly balances = inject(BalancesService);
  private readonly masterpod = inject(MasterpodApiService);
  private readonly anos = inject(AnosApiService);
  private readonly settings = inject(SettingsService);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  protected readonly listError = signal<string | null>(null);
  /** True once /list-anos-accounts answered, so "Open your first anos account" waits for the list. */
  private readonly accountsLoaded = signal(false);
  /** The open DAO proposals this pod has votes in and has not voted on, from a quiet read of the open list when Home opens (wallet spec 8.2, DAO); 0 when the read was refused, since the line is a convenience. */
  private readonly openVotes = signal(0);
  /** The open fund proposal, from a quiet read of /list-fund-proposals when Home opens (wallet spec 8.2, Guardians); null when none is open or the read was refused, since the line is a convenience. */
  private readonly openFund = signal<FundProposalItem | null>(null);
  /** An Android phone, where the passkey is usually kept by Google: the Protect your passkey line shows while the recorded answer is skipped (wallet spec 8.2). */
  private readonly android = /Android/.test(navigator.userAgent);

  /** True while a fund proposal is open for the vote and one of the pod's accounts with guardian votes (its balance entry's guardianVotes, from the /get-account read Home makes) neither proposed it nor voted on it. */
  private readonly openFundVote = computed(() => {
    const p = this.openFund();
    if (!p || p.status !== 'open') return false;
    const entries = this.balances.byAccount();
    return this.session.accounts().some((a) => (entries[a.accountId]?.guardianVotes ?? 0) >= 1 && a.accountId !== p.guardianId && !p.votes.some((v) => v.guardianId === a.accountId));
  });

  /** The tiles: the side panel's entries except Home itself and Log. */
  protected readonly tiles = computed(() => this.navigation.items().filter((i) => i.path !== '/home' && i.path !== '/log'));

  /** The Things to do lines, in the plan's order, each only when it applies; a lost account (its keyBlob does not open, 2026-11-08) gets no line. */
  protected readonly todo = computed((): TodoLine[] => {
    const home = this.t().home;
    const lines: TodoLine[] = [];
    const status = this.session.status();
    if (status?.bucketOneImages === 0) lines.push({ path: '/account/recovery/selfie', icon: 'photo_camera', words: home.addSelfie });
    if (status && (status.bucketTwoImages === 0 || status.bucketTwoInfos < 3)) {
      lines.push({ path: '/account/recovery/details', icon: 'badge', words: home.addDetails });
    }
    if (this.android && this.settings.settings()?.protect === 'skipped') lines.push({ path: '/account/protect', icon: 'security', words: home.protectPasskey });
    const accounts = this.session.accounts();
    if (this.accountsLoaded() && accounts.length === 0) lines.push({ path: '/wallet', icon: 'account_balance_wallet', words: home.openFirst });
    const names = accountNames(accounts, this.t().accountKinds);
    for (const account of accounts) {
      if (!account.submittedAt && !this.balances.isLost(account.accountId)) lines.push({ path: '/wallet', icon: 'error', words: home.finishCreating(names.get(account.accountId) ?? '') });
    }
    const unreadRooms = this.session.unreadRoomCount();
    if (unreadRooms > 0) lines.push({ path: '/chat', icon: 'chat', words: home.unreadChats(unreadRooms) });
    const rooms = this.session.chatRooms();
    const requests = rooms ? rooms.invites.length + rooms.joinRequests.length : 0;
    if (requests > 0) lines.push({ path: '/chat/requests', icon: 'mail', words: home.chatRequests(requests) });
    const openVotes = this.openVotes();
    if (openVotes > 0) lines.push({ path: '/dao', icon: 'how_to_vote', words: home.openVotes(openVotes) });
    if (this.openFundVote()) lines.push({ path: '/dao/guardians', icon: 'shield', words: home.openFundVote });
    const unread = this.session.unread().length;
    if (unread > 0) lines.push({ path: '/notifications', icon: 'notifications', words: home.unreadNotifications(unread) });
    return lines;
  });

  constructor() {
    void this.load();
    // The balances are read again every 5 seconds while an account is not
    // on the ledger yet or any anos are held or pending, as the Wallet page does.
    const timer = setInterval(() => {
      if (this.balances.needsPoll() && !this.balances.busy()) void this.balances.refresh(true);
    }, ACCOUNT_POLL_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  /** The accounts from the masterpod into the session (a refusal shown in red), then the balances; beside them the open DAO proposals for the open-votes line and the open fund proposal for the fund line (both quiet, a refusal shows nothing). */
  private async load(): Promise<void> {
    this.listError.set(null);
    void this.masterpod.listDaoProposals({ status: 'open', limit: 100 }, true).then((open) => {
      if (open.ok) this.openVotes.set(open.body.proposals.filter((p) => p.yourWeight >= 1 && p.yourVote === null).length);
    });
    void this.anos.listFundProposals({ status: 'open' }, true).then((open) => {
      if (open.ok) this.openFund.set(open.body.proposals[0] ?? null);
    });
    const res = await this.masterpod.listAnosAccounts(true);
    if (res.ok) {
      this.session.accounts.set(res.body.accounts);
      this.accountsLoaded.set(true);
    } else {
      this.listError.set(`/list-anos-accounts: ${reasonOf(res)}`);
    }
    void this.settings.load();
    await this.balances.refresh();
  }
}
