import { Component, DestroyRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatMenuModule } from '@angular/material/menu';
import { MatSelectModule } from '@angular/material/select';
import { RouterLink } from '@angular/router';
import { anosToMillionths, millionthsToAnos } from '../amounts';
import { ACCOUNT_POLL_MS, CARD_MESSAGES_PAGE, CARD_TRANSACTIONS_PAGE } from '../constants';
import { escrowStageWords } from '../escrow-stage';
import { formatPrice, totalOf } from '../prices';
import { AnosApiService, EscrowItem, TransactionItem } from '../services/anos-api.service';
import { BalancesService } from '../services/balances.service';
import { ChatService, piecesOf } from '../services/chat.service';
import { CryptoService, PairOne } from '../services/crypto.service';
import { LanguageService } from '../services/language.service';
import { ApiResponse, reasonOf } from '../services/log.service';
import { MarketplaceService } from '../services/marketplace.service';
import { MasterpodApiService, RoomItem } from '../services/masterpod-api.service';
import { SessionService } from '../services/session.service';
import { SigningService } from '../services/signing.service';
import { AvatarComponent } from './avatar.component';

/** An account id found in a room's decrypted messages: who posted it and at which position. */
export interface FoundAccountId {
  accountId: string;
  senderAnopodId: string;
  position: number;
}

/** The chat's released trade: the amount the card shows, and what the message about it needs, the link's id, its sender and receiver, and whether this pod sent it. */
interface ReleasedTrade {
  amount: string;
  transactionId: string;
  from: string;
  to: string;
  mine: boolean;
}

/** What one check of the chat's trade found: an open trade, a released one, neither, or a read that failed. */
type Found = 'open' | 'released' | 'none' | 'unread';

/**
 * The pinned listing card (wallet spec 8.2, Chat, and 8.7), drawn by the
 * conversation page under its header, above the thread, in a private room
 * about a listing, for the room's two traders: the person who made the
 * room by pressing Connect, and the listing's owner (2026-11-12; anyone
 * else in the room is a guest and gets no card). The first line: the
 * listing in a few words, "Selling 100 anos · 35.50 THB each · 3,550 THB",
 * Closed when it is, with the other trader's avatar (8.6). The buyer's
 * "Share an account" posts one of this pod's account ids into the chat;
 * the seller's "Start the escrow trade", once the other trader has posted
 * an account id, opens a small form (From, To, Amount, the total at the
 * listing's price), asks once, and builds the escrowTransfer as the
 * account page's Send does. The roles come from the listing: the owner of
 * a sell listing and the other person of a buy listing are the seller.
 *
 * What the chat's trade is, the card reads from the validators (2026-11-10,
 * forclaude/wallet-finished-trade-plan-1.md), when the chat opens, every 5
 * seconds and once more when the seller says Yes to Start: an open trade
 * from /list-escrows, else a released one from /list-transactions since the
 * room was made, on the seller's spending accounts and this pod's accounts
 * named in the chat. A trade is the chat's when its other side is an account
 * named in the chat; the card reads the room's messages itself for those
 * ids, since the page holds the newest ones only. A released trade ends the
 * chat's trading: Released, no Share and no Start, and "Close the listing"
 * for the owner of an open listing. A trade seen open here and then gone
 * with nothing released reads Cancelled, and Share and Start come back.
 * Share and Start show only after a check that read everything; a read that
 * fails changes nothing else on the card.
 *
 * The same check tells the chat of its trade (2026-11-10,
 * forclaude/wallet-trade-message-plan-1.md): when this pod sent the trade
 * and no message in the chat carries its transaction id, the card posts
 * "Escrow trade started", or "Escrow trade released" for a trade already
 * released. Start does not post it, so an answer lost on the way, a message
 * that failed or a tab closed in between still ends with the chat told.
 *
 * The check also finds the open dispute case of the chat's trade
 * (2026-11-12, forclaude/wallet-case-chats-plan-1.md), as the escrow trade
 * page finds it, and the output disputeCase gives the page its id: with
 * one, the conversation's menu has "Invite an attestor".
 */
@Component({
  selector: 'app-pinned-listing',
  imports: [FormsModule, RouterLink, MatButtonModule, MatMenuModule, MatFormFieldModule, MatInputModule, MatSelectModule, AvatarComponent],
  template: `
    @if (listing(); as listing) {
      <div class="card">
        <div class="first">
          @if (other(); as person) {
            <app-avatar [anopodId]="person.anopodId" [username]="person.username" [size]="24" />
          }
          <span class="summary">{{ summary() }}</span>
          @if (closed()) {
            <span class="label">{{ t().common.closed }}</span>
          }
        </div>

        @if (trade(); as open) {
          <p class="stage">{{ t().pinned.tradeLine(millionthsToAnos(open.amount), stageWords(open)) }}</p>
          <div class="buttons">
            <a mat-stroked-button [routerLink]="['/wallet', tradeAccount(), 'escrow', open.transactionId]">{{ t().pinned.seeTrade }}</a>
          </div>
        } @else if (released(); as done) {
          <p class="stage">{{ t().pinned.released(millionthsToAnos(done.amount)) }}</p>
          <p class="field hint">{{ t().pinned.finished }}</p>
          @if (isOwner() && !closed()) {
            @if (confirmClose()) {
              <p class="question">{{ t().common.askClose }}</p>
              <div class="buttons">
                <button mat-flat-button type="button" (click)="closeListing()" [disabled]="busy()">{{ t().common.yes }}</button>
                <button mat-button type="button" (click)="confirmClose.set(false)" [disabled]="busy()">{{ t().common.back }}</button>
              </div>
            } @else {
              <button mat-stroked-button type="button" (click)="confirmClose.set(true)" [disabled]="busy()">{{ t().pinned.closeListing }}</button>
            }
          }
        } @else {
          @if (cancelled()) {
            <p class="stage">{{ t().pinned.cancelled }}</p>
          }
          @if (!closed()) {
            @if (read() === null) {
              <p class="field hint">{{ t().pinned.checking }}</p>
            } @else if (read() === false) {
              <p class="field hint">{{ t().pinned.cannotCheck }}</p>
            } @else if (side() === 'buyer') {
              <div class="buttons">
                <button mat-flat-button type="button" [matMenuTriggerFor]="accountsMenu" [disabled]="busy() || balances.usableAccounts().length === 0">{{ t().pinned.shareAccount }}</button>
                @if (balances.usableAccounts().length === 0) {
                  <span class="hint">{{ t().pinned.noAccounts }}</span>
                }
              </div>
              <mat-menu #accountsMenu="matMenu">
                @for (account of balances.usableAccounts(); track account.accountId) {
                  <button mat-menu-item type="button" (click)="share(account.accountId)"><code>{{ shortId(account.accountId) }}</code> · {{ t().account.title(account.accountType) }}</button>
                }
              </mat-menu>
            } @else if (starting()) {
              <div class="form">
                @if (spendingAccounts().length === 1) {
                  <p class="field">{{ t().common.from }} <code>{{ shortId(from()) }}</code></p>
                } @else if (spendingAccounts().length === 0) {
                  <p class="field hint">{{ t().pinned.noSpending }}</p>
                } @else {
                  <mat-form-field appearance="outline" subscriptSizing="dynamic">
                    <mat-label>{{ t().common.from }}</mat-label>
                    <mat-select [value]="from()" (valueChange)="from.set($event)">
                      @for (account of spendingAccounts(); track account.accountId) {
                        <mat-option [value]="account.accountId">{{ shortId(account.accountId) }}</mat-option>
                      }
                    </mat-select>
                  </mat-form-field>
                }
                @if (theirAccountIds().length === 1) {
                  <p class="field">{{ t().common.to }} <code>{{ shortId(to()) }}</code></p>
                } @else {
                  <mat-form-field appearance="outline" subscriptSizing="dynamic">
                    <mat-label>{{ t().common.to }}</mat-label>
                    <mat-select [value]="to()" (valueChange)="to.set($event)">
                      @for (id of theirAccountIds(); track id) {
                        <mat-option [value]="id">{{ shortId(id) }}</mat-option>
                      }
                    </mat-select>
                  </mat-form-field>
                }
                <mat-form-field appearance="outline" subscriptSizing="dynamic">
                  <mat-label>{{ t().pinned.amountAnos }}</mat-label>
                  <input matInput inputmode="decimal" [ngModel]="amount()" (ngModelChange)="amount.set($event)" />
                </mat-form-field>
                @if (formTotal(); as total) {
                  <p class="field">{{ t().pinned.atListingPrice(total) }}</p>
                }
                @if (confirmStart()) {
                  <p class="question">{{ t().pinned.askStart(amount().trim(), otherName()) }}</p>
                  <div class="buttons">
                    <button mat-flat-button type="button" (click)="start()" [disabled]="busy()">{{ t().common.yes }}</button>
                    <button mat-button type="button" (click)="confirmStart.set(false)" [disabled]="busy()">{{ t().common.back }}</button>
                  </div>
                } @else {
                  <div class="buttons">
                    <button mat-flat-button type="button" (click)="confirmStart.set(true)" [disabled]="busy() || !canStart()">{{ t().common.start }}</button>
                    <button mat-button type="button" (click)="starting.set(false)" [disabled]="busy()">{{ t().common.cancel }}</button>
                  </div>
                }
              </div>
            } @else {
              <div class="buttons">
                <button mat-flat-button type="button" (click)="openForm()" [disabled]="busy() || theirAccountIds().length === 0">{{ t().pinned.startTrade }}</button>
                @if (theirAccountIds().length === 0) {
                  <span class="hint">{{ t().pinned.askShare }}</span>
                }
              </div>
            }
          }
        }
        @if (error(); as text) {
          <p class="error">{{ text }}</p>
        }
      </div>
    }
  `,
  styles: `
    :host { display: block; }
    .card { padding: 8px 12px; border-bottom: 1px solid var(--mat-sys-outline-variant); background: var(--mat-sys-surface-container-low); display: flex; flex-direction: column; gap: 6px; }
    .first { display: flex; align-items: center; gap: 8px; }
    .summary { font-weight: 500; flex: 1; min-width: 0; }
    .label { font-size: 11px; font-weight: 500; padding: 2px 8px; border-radius: 10px; background: var(--mat-sys-secondary-container); color: var(--mat-sys-on-secondary-container); white-space: nowrap; }
    .stage { margin: 0; }
    .buttons { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .form { display: flex; flex-direction: column; gap: 8px; }
    .field { margin: 0; }
    .question { margin: 0; font-weight: 500; }
    .hint { font-size: 13px; color: var(--mat-sys-on-surface-variant); }
    .error { color: var(--mat-sys-error); margin: 0; }
    code { font-size: 12px; word-break: break-all; }
  `,
})
export class PinnedListingComponent {
  readonly room = input.required<RoomItem>();
  /** The account ids found in the room's messages, newest first, from the conversation page. */
  readonly accountIds = input.required<FoundAccountId[]>();
  /**
   * The id of the open dispute case of the chat's trade, for the
   * conversation page's "Invite an attestor" (wallet spec 8.2, Chat;
   * 2026-11-12): given whenever it changes, null when the chat has no open
   * trade, when the trade is not in dispute, and when no attestor has a case
   * open on it.
   */
  readonly disputeCase = output<string | null>();

  protected readonly session = inject(SessionService);
  /** The account lists show the usable accounts only (wallet spec 8.2, 2026-11-08). */
  protected readonly balances = inject(BalancesService);
  private readonly market = inject(MarketplaceService);
  private readonly chat = inject(ChatService);
  private readonly masterpod = inject(MasterpodApiService);
  private readonly anos = inject(AnosApiService);
  private readonly crypto = inject(CryptoService);
  private readonly signing = inject(SigningService);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  protected readonly millionthsToAnos = millionthsToAnos;

  protected readonly listing = computed(() => this.room().listing);
  protected readonly closed = computed(() => this.listing()?.status === 'closed');
  protected readonly isOwner = computed(() => this.listing()?.owner.anopodId === this.session.anopodId());
  /** This pod's side in the trade: the owner of a sell listing and the other person of a buy listing are the seller. */
  protected readonly side = computed(() => {
    const listing = this.listing();
    return listing ? this.market.mySide(listing) : 'buyer';
  });
  /** The other trader (2026-11-12): the other of the room's creator and the listing's owner, never a guest such as an attestor invited into the chat. */
  protected readonly other = computed(() => this.chat.otherTrader(this.room()));
  protected readonly otherName = computed(() => this.other()?.username ?? this.t().pinned.them);
  protected readonly summary = computed(() => {
    const listing = this.listing();
    if (!listing) return '';
    const total = formatPrice(totalOf(listing.quantity, listing.price), listing.currency, 0);
    return this.t().pinned.summary(this.market.sideWords(listing), millionthsToAnos(listing.quantity), formatPrice(listing.price, listing.currency), total);
  });
  /** The account ids the card read from the room's messages itself (readIds), since the page holds the newest messages only; null until that read is whole. */
  private readonly older = signal<FoundAccountId[] | null>(null);
  /** Every account id in the chat, newest first: the card's own read of the room and the page's, which carries what arrived since. */
  private readonly ids = computed(() => [...this.accountIds(), ...(this.older() ?? [])].sort((a, b) => b.position - a.position));
  /** The account ids the other trader posted, newest first (2026-11-12; until then the ids anyone but this pod posted), so a guest's messages never feed the trade form; with no other trader found in the room, the ids someone else posted. */
  protected readonly theirAccountIds = computed(() => {
    const me = this.session.anopodId();
    const other = this.other();
    return unique(this.ids().filter((a) => (other ? a.senderAnopodId === other.anopodId : a.senderAnopodId !== me)).map((a) => a.accountId));
  });
  /** This pod's usable accounts named in the chat (a lost account, whose keyBlob does not open, is left out; 2026-11-08). */
  private readonly myNamedAccounts = computed(() => {
    const mine = new Set(this.balances.usableAccounts().map((a) => a.accountId));
    return unique(this.ids().map((a) => a.accountId).filter((id) => mine.has(id)));
  });
  /** The usable spending accounts, for the seller's From. */
  protected readonly spendingAccounts = computed(() => this.balances.usableAccounts().filter((a) => a.accountType === 'spending'));
  /** The accounts the card reads the trade on: the seller's usable spending accounts, then this pod's usable accounts named in the chat. */
  private readonly watched = computed(() => unique([...(this.side() === 'seller' ? this.spendingAccounts().map((a) => a.accountId) : []), ...this.myNamedAccounts()]));
  private readonly watchedKey = computed(() => `${this.room().chatRoomId}|${this.watched().join(',')}`);

  protected readonly trade = signal<EscrowItem | null>(null);
  /** This pod's account in the trade shown, for the stage's side and the link. */
  protected readonly tradeAccount = signal('');
  /** The chat's released trade; once found it stays until the card is given another room. */
  protected readonly released = signal<ReleasedTrade | null>(null);
  /** A trade seen open here went away with nothing released. */
  protected readonly cancelled = signal(false);
  /** Null until the first check ends, true when the last check read everything, false when a read in it failed. */
  protected readonly read = signal<boolean | null>(null);
  protected readonly starting = signal(false);
  protected readonly confirmStart = signal(false);
  protected readonly confirmClose = signal(false);
  protected readonly from = signal('');
  protected readonly to = signal('');
  protected readonly amount = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly canStart = computed(() => this.from() !== '' && this.to() !== '' && anosToMillionths(this.amount()) !== null);
  /** The form's total at the listing's price, once the amount reads. */
  protected readonly formTotal = computed(() => {
    const listing = this.listing();
    const quantity = anosToMillionths(this.amount());
    if (!listing || quantity === null) return null;
    return formatPrice(totalOf(quantity, listing.price), listing.currency, 0);
  });

  /** The last check that read everything showed an open trade. */
  private seen = false;
  /** The trades this card posted a message about in this room, so a check that runs before the thread shows the message does not post it again. */
  private readonly told = new Set<string>();
  /** The checks run one after another: `last` is the one before, `waiting` how many are queued or running. */
  private last: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  /** This card asked the masterpod for the pod's accounts, once, because the tab had none. */
  private accountsAsked = false;
  /** The open dispute case of the chat's trade as the page was last told (disputeCase); null when none is known. */
  private disputeCaseId: string | null = null;
  private roomId: string | null = null;

  constructor() {
    // Another room: the card starts over.
    effect(() => {
      const id = this.room().chatRoomId;
      if (id === this.roomId) return;
      this.roomId = id;
      untracked(() => this.reset());
    });
    // The trade is checked when the chat opens and whenever the accounts the card reads change, then every 5 seconds unless a check is still waiting or running.
    effect(() => {
      this.watchedKey();
      untracked(() => void this.poll());
    });
    const timer = setInterval(() => {
      if (this.waiting === 0) void this.poll();
    }, ACCOUNT_POLL_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  private reset(): void {
    this.older.set(null);
    this.trade.set(null);
    this.tradeAccount.set('');
    this.released.set(null);
    this.cancelled.set(false);
    this.read.set(null);
    this.starting.set(false);
    this.confirmStart.set(false);
    this.confirmClose.set(false);
    this.error.set(null);
    this.seen = false;
    this.told.clear();
    this.tellDisputeCase(null);
  }

  protected shortId(accountId: string): string {
    return `${accountId.slice(0, 8)}…${accountId.slice(-4)}`;
  }

  /** The stage in words from this pod's side of the trade (escrow-stage.ts). */
  protected stageWords(t: EscrowItem): string {
    return escrowStageWords(t.stage, t.accountId === this.tradeAccount() ? 'seller' : 'buyer', this.lang.words().escrowStages);
  }

  /** The buyer posts one of their account ids into the chat. */
  protected share(accountId: string): Promise<void> {
    return this.run(() => this.post(this.t().pinned.shareMessage(accountId)));
  }

  /** The seller's form: the first spending account, the newest account id the other trader posted, the listing's quantity. */
  protected openForm(): void {
    const listing = this.listing();
    if (!listing) return;
    this.from.set(this.spendingAccounts()[0]?.accountId ?? '');
    this.to.set(this.theirAccountIds()[0] ?? '');
    this.amount.set(millionthsToAnos(listing.quantity));
    this.confirmStart.set(false);
    this.error.set(null);
    this.starting.set(true);
  }

  /**
   * The last guard against sending twice (2026-11-10): one fresh check
   * first. A check that cannot be read sends nothing; a trade open or
   * released in this chat sends nothing either, and the card shows it. Then
   * the escrowTransfer the way the account page's Send builds it: pair one
   * from the account's keyBlob and the encryption key, /get-account for the
   * latest transaction id, buildAnosTransferTransaction with type
   * escrowTransfer, /api/sign/<n>, /anos-transfer. A 4xx answer is a refusal
   * (refusal). After any other answer, accepted or lost on the way (no
   * network, a 502 or 504: the validator stores the trade before it
   * answers), one more check shows the trade and posts its message (tell);
   * an answer that failed with no trade found open says so, and the form
   * stays for another try.
   */
  protected start(): Promise<void> {
    return this.run(async () => {
      const from = this.from();
      const to = this.to();
      const amount = anosToMillionths(this.amount());
      if (!from || !to || amount === null) throw new Error(this.t().pinned.pickAccounts);
      const found = await this.poll();
      if (found === 'unread') throw new Error(this.t().pinned.notSentUnread);
      if (found !== 'none') {
        this.starting.set(false);
        this.confirmStart.set(false);
        throw new Error(this.t().pinned.notSentAlready);
      }
      const pairOne = await this.pairOne(from);
      const latest = await this.anos.getAccount(pairOne, from, true);
      if (!latest.ok || !latest.body.latestTransactionId) throw new Error(this.t().common.noLatest);
      const tx = await this.signing.sign(this.crypto.buildAnosTransferTransaction(pairOne, from, latest.body.latestTransactionId, to, amount, 'escrowTransfer', new Date()), from);
      const res = await this.anos.anosTransfer(tx);
      if (!res.ok && res.status >= 400 && res.status < 500) throw new Error(this.refusal(res));
      const after = await this.poll();
      if (!res.ok && after !== 'open') throw new Error(this.t().pinned.noAnswer);
      this.starting.set(false);
      this.confirmStart.set(false);
    });
  }

  /** A refusal of the trade in words: plain words for an account that already has something waiting on the validators, anything else with its reason as the account page shows it. */
  private refusal(res: ApiResponse<unknown>): string {
    const reason = reasonOf(res);
    if (/for this accountId is already (pending|held|locked)/.test(reason)) return this.t().pinned.alreadyHeld;
    return this.t().pinned.refused(reason);
  }

  /** The owner closes the listing after a release; the room list is refreshed so the card reads Closed. */
  protected closeListing(): Promise<void> {
    return this.run(async () => {
      const listing = this.listing();
      if (!listing) throw new Error(this.t().common.notAboutListing);
      const res = await this.market.close(listing.listingId);
      if (!res.ok) throw new Error(reasonOf(res));
      this.confirmClose.set(false);
      await this.chat.refreshRooms();
    });
  }

  /** A message into the room, encrypted like any other; the thread's poll shows it. */
  private async post(text: string): Promise<void> {
    const key = await this.chat.roomKeyOf(this.room());
    if (!key) throw new Error(this.t().common.noRoomKey);
    const res = await this.masterpod.sendMessage(this.room().chatRoomId, await this.crypto.encryptText(key, text));
    if (!res.ok) throw new Error(`/send-message: ${reasonOf(res)}`);
  }

  /** Pair one of one of this pod's accounts, opened from its keyBlob for one call; the caller drops it. */
  private async pairOne(accountId: string): Promise<PairOne> {
    let item = this.session.accounts().find((a) => a.accountId === accountId);
    if (!item) {
      const res = await this.masterpod.listAnosAccounts(true);
      if (res.ok) this.session.accounts.set(res.body.accounts);
      item = this.session.accounts().find((a) => a.accountId === accountId);
    }
    const keyBlobKey = this.session.getKeyBlobKey();
    if (!item) throw new Error(this.t().common.notMyAccount);
    if (!keyBlobKey) throw new Error(this.t().common.noKeyBlobKey);
    return this.crypto.pairOneFromKeyBlob(this.crypto.fromHex(item.keyBlob), keyBlobKey);
  }

  /**
   * One check of the chat's trade, run after the checks before it: the
   * timer's, the one a change in the accounts read asks for, and the guard
   * of Start go one at a time. Resolves to what the check found; never
   * rejects.
   */
  private poll(): Promise<Found> {
    this.waiting += 1;
    const next = this.last
      .then(() => this.check())
      .finally(() => {
        this.waiting -= 1;
      });
    this.last = next.catch(() => undefined);
    return next;
  }

  /**
   * What the chat's trade is, read from the validators (wallet spec 8.2,
   * Chat; 2026-11-10). First the pod's accounts, when this tab has none
   * yet, and the room's account ids, once (readIds). Then /list-escrows on
   * each watched account: the newest open trade whose other side is an
   * account named in the chat is shown. With none open and none released
   * yet, /list-transactions on each watched account since the room was made
   * (releasedLink): an escrowTransfer whose other side is an account named
   * in the chat is the chat's released trade, and it stays. /list-escrows
   * is read first because the validators write a release before the trade
   * leaves that list, so a trade gone from it is already on the chain. A
   * trade seen open and then gone with nothing released is cancelled. A
   * trade this pod sent, found open or released, gets its message posted
   * when the chat has none for it (tell). A trade found also closes the
   * Start form, so its question does not come back by itself once that
   * trade is cancelled. An open trade in dispute has its dispute case
   * looked for, for the page's "Invite an attestor" (findDisputeCase,
   * 2026-11-12); a check that finds no open trade tells the page that
   * there is no such case. A read that fails, or anything thrown (no key
   * blob key in this tab, a keyBlob that does not open), is unread: the
   * card keeps the trade it shows and the dispute case it told, and Share
   * and Start wait for a check that reads everything. A check that ends
   * after the card was given another room changes nothing.
   */
  private async check(): Promise<Found> {
    const room = this.room();
    try {
      if (!this.session.hasSession()) return 'unread';
      if (!this.accountsAsked && this.session.accounts().length === 0) {
        const res = await this.masterpod.listAnosAccounts(true);
        if (!res.ok) return this.unread(room);
        this.accountsAsked = true;
        this.session.accounts.set(res.body.accounts);
      }
      if (this.older() === null) {
        const older = await this.readIds(room);
        if (older === null) return this.unread(room);
        if (this.roomId !== room.chatRoomId) return 'unread';
        this.older.set(older);
      }
      const named = new Set(this.ids().map((a) => a.accountId));
      // With no account id in the chat there is nothing to look for, and nothing is read.
      const watched = named.size > 0 ? this.watched() : [];
      const opened: { accountId: string; pairOne: PairOne }[] = [];
      const open: { trade: EscrowItem; myAccount: string }[] = [];
      for (const accountId of watched) {
        const pairOne = await this.pairOne(accountId);
        opened.push({ accountId, pairOne });
        const res = await this.anos.listEscrows(pairOne, accountId, true);
        if (!res.ok) return this.unread(room);
        for (const trade of res.body.escrows) {
          const otherSide = trade.accountId === accountId ? trade.accountIdTo : trade.accountId;
          if (named.has(otherSide)) open.push({ trade, myAccount: accountId });
        }
      }
      let link: TransactionItem | null = null;
      let linkAccount = '';
      if (open.length === 0 && this.released() === null) {
        for (const { accountId, pairOne } of opened) {
          const found = await this.releasedLink(pairOne, accountId, room.createdAt, named);
          if (found === undefined) return this.unread(room);
          if (found !== null && (link === null || found.position > link.position)) {
            link = found;
            linkAccount = accountId;
          }
        }
      }
      if (this.roomId !== room.chatRoomId) return 'unread';
      this.read.set(true);
      open.sort((a, b) => b.trade.createdAt.localeCompare(a.trade.createdAt));
      const newest = open[0];
      if (newest) {
        const { trade, myAccount } = newest;
        this.trade.set(trade);
        this.tradeAccount.set(myAccount);
        this.cancelled.set(false);
        this.seen = true;
        this.starting.set(false);
        this.confirmStart.set(false);
        if (trade.accountId === myAccount) {
          await this.tell(room, named, trade.transactionId, this.t().pinned.startedMessage(millionthsToAnos(trade.amount), trade.accountId, trade.accountIdTo, trade.transactionId));
        }
        await this.findDisputeCase(room, trade);
        return 'open';
      }
      this.trade.set(null);
      this.tellDisputeCase(null);
      if (link !== null && this.released() === null) {
        this.released.set({ amount: link.amount, transactionId: link.transactionId, from: link.accountId ?? '', to: link.accountIdTo ?? '', mine: link.accountId === linkAccount });
      }
      const done = this.released();
      if (done !== null) {
        this.cancelled.set(false);
        this.seen = false;
        this.starting.set(false);
        this.confirmStart.set(false);
        if (done.mine) {
          await this.tell(room, named, done.transactionId, this.t().pinned.releasedMessage(millionthsToAnos(done.amount), done.from, done.to, done.transactionId));
        }
        return 'released';
      }
      if (this.seen) {
        this.seen = false;
        this.cancelled.set(true);
      }
      return 'none';
    } catch {
      return this.unread(room);
    }
  }

  /** A check that could not be read in full: the card keeps what it shows, and Share and Start wait for one that reads. */
  private unread(room: RoomItem): Found {
    if (this.roomId === room.chatRoomId) this.read.set(false);
    return 'unread';
  }

  /**
   * The chat's message about a trade this pod sent, posted when no message
   * in the chat carries the trade's transaction id and this card has not
   * posted one (2026-11-10, forclaude/wallet-trade-message-plan-1.md): the
   * answer to the transfer may have been lost on the way, the message may
   * have failed, or the tab was closed in between. Encrypted with the room
   * key and sent into the room the check started with, so a room change in
   * between cannot send it into another chat. No key, a refusal or anything
   * thrown changes nothing: the next check tries again.
   */
  private async tell(room: RoomItem, named: Set<string>, transactionId: string, text: string): Promise<void> {
    if (named.has(transactionId) || this.told.has(transactionId)) return;
    try {
      const key = await this.chat.roomKeyOf(room);
      if (!key) return;
      const res = await this.masterpod.sendMessage(room.chatRoomId, await this.crypto.encryptText(key, text));
      if (res.ok && this.roomId === room.chatRoomId) this.told.add(transactionId);
    } catch {
      // The next check posts it.
    }
  }

  /**
   * The dispute case of the chat's trade (wallet spec 8.2, Chat;
   * 2026-11-12), found as the escrow trade page finds it (findCase there):
   * on a check that shows the trade in dispute while no case is known,
   * /list-my-cases, quiet, and of its disputes the one on the trade's
   * transaction that is open or in review. A case found stays until the
   * trade is no longer in dispute. A trade that is not in dispute has none.
   * A read that fails, or a dispute no attestor has a case open on, leaves
   * none known, and the next check asks again. A check that ends after the
   * card was given another room changes nothing.
   */
  private async findDisputeCase(room: RoomItem, trade: EscrowItem): Promise<void> {
    if (this.roomId !== room.chatRoomId) return;
    if (trade.stage !== 'disputed') {
      this.tellDisputeCase(null);
      return;
    }
    if (this.disputeCaseId !== null) return;
    try {
      const res = await this.masterpod.listMyCases(true);
      if (!res.ok || this.roomId !== room.chatRoomId) return;
      const found = res.body.disputes.find((d) => d.transactionId === trade.transactionId && (d.status === 'open' || d.status === 'inReview'));
      if (found) this.tellDisputeCase(found.caseId);
    } catch {
      // The next check asks again.
    }
  }

  /** The page is told the dispute case of the chat's trade, or null for none, when it is another than the one it was last told; a card that is gone (a check can end after the chat was left) tells nothing. */
  private tellDisputeCase(caseId: string | null): void {
    if (caseId === this.disputeCaseId || this.destroyRef.destroyed) return;
    this.disputeCaseId = caseId;
    this.disputeCase.emit(caseId);
  }

  /**
   * Every account id in the room's messages, read from the first message
   * on, CARD_MESSAGES_PAGE at a time, each with its sender and position as
   * the page feeds them: the page holds the room's newest messages only,
   * and an account shared further back still counts. A message that does
   * not open is skipped. Null when this tab has no key for the room or a
   * read fails.
   */
  private async readIds(room: RoomItem): Promise<FoundAccountId[] | null> {
    if (!(await this.chat.roomKeyOf(room))) return null;
    const found: FoundAccountId[] = [];
    let afterPosition = 0;
    for (;;) {
      const res = await this.masterpod.listMessages(room.chatRoomId, { afterPosition, limit: CARD_MESSAGES_PAGE }, true);
      if (!res.ok) return null;
      const messages = res.body.messages;
      for (const m of messages) {
        const text = await this.chat.decryptMessage(room, m.message);
        if (text === null) continue;
        for (const piece of piecesOf(text)) {
          if (piece.accountId) found.push({ accountId: piece.text.toLowerCase(), senderAnopodId: m.senderAnopodId, position: m.position });
        }
      }
      if (messages.length < CARD_MESSAGES_PAGE) return found;
      afterPosition = messages[messages.length - 1].position;
    }
  }

  /**
   * The newest escrowTransfer written since the room was made between this
   * account and an account named in the chat: /list-transactions with from
   * the room's createdAt, CARD_TRANSACTIONS_PAGE rows at a time, newest
   * first, paging back while a page comes back full. Null when there is
   * none, undefined when a read fails.
   */
  private async releasedLink(pairOne: PairOne, accountId: string, from: string, named: Set<string>): Promise<TransactionItem | null | undefined> {
    let beforePosition: number | null = null;
    for (;;) {
      const body: { from: string; limit: number; beforePosition?: number } = { from, limit: CARD_TRANSACTIONS_PAGE };
      if (beforePosition !== null) body.beforePosition = beforePosition;
      const res = await this.anos.listTransactions(pairOne, accountId, body, true);
      if (!res.ok) return undefined;
      const rows = res.body.transactions;
      const link = rows.find((t) => {
        const otherSide = t.accountId === accountId ? t.accountIdTo : t.accountId;
        return t.type === 'escrowTransfer' && otherSide !== null && named.has(otherSide);
      });
      if (link) return link;
      if (rows.length < CARD_TRANSACTIONS_PAGE) return null;
      beforePosition = rows[rows.length - 1].position;
    }
  }

  private async run(action: () => Promise<void>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await action();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }
}

/** The ids once each, in the order first seen. */
function unique(ids: string[]): string[] {
  return [...new Set(ids)];
}
