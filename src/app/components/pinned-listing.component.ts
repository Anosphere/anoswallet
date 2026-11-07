import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatMenuModule } from '@angular/material/menu';
import { MatSelectModule } from '@angular/material/select';
import { RouterLink } from '@angular/router';
import { anosToMillionths, millionthsToAnos } from '../amounts';
import { ACCOUNT_POLL_MS } from '../constants';
import { escrowStageWords } from '../escrow-stage';
import { formatPrice, totalOf } from '../prices';
import { AnosApiService, EscrowItem } from '../services/anos-api.service';
import { ChatService } from '../services/chat.service';
import { CryptoService, PairOne } from '../services/crypto.service';
import { LanguageService } from '../services/language.service';
import { reasonOf } from '../services/log.service';
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

/** The trade the card last saw open: enough to say how it ended once it leaves the list. */
interface SeenTrade {
  transactionId: string;
  myAccount: string;
  amount: string;
}

/** How a trade seen open here ended; released is null when the transactions could not be read. */
interface Ended {
  released: boolean | null;
  amount: string;
}

/**
 * The pinned listing card (wallet spec 8.2, Chat, and 8.7), drawn by the
 * conversation page under its header, above the thread, in a private room
 * about a listing. The first line: the listing in a few words, "Selling 100
 * anos · 35.50 THB each · 3,550 THB", Closed when it is, with the other
 * person's avatar (8.6). The buyer's "Share an account" posts one of this
 * pod's account ids into the chat; the seller's "Start the escrow trade",
 * once the other person has posted an account id, opens a small form (From,
 * To, Amount, the total at the listing's price), asks once, and builds the
 * escrowTransfer as the account page's Send does, then posts a message about
 * it. The stage of the newest trade between accounts named in the chat is
 * read every 5 seconds from /list-escrows on this pod's accounts named in
 * the chat, with a link to the trade page; a trade seen open and then gone
 * reads Released or Cancelled by the trade page's rule; after a release the
 * owner of an open listing gets "Close the listing". The roles come from the
 * listing: the owner of a sell listing and the other person of a buy
 * listing are the seller.
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
            <span class="label">Closed</span>
          }
        </div>

        @if (trade(); as t) {
          <p class="stage">Escrow trade: {{ millionthsToAnos(t.amount) }} anos · {{ stageWords(t) }}</p>
          <div class="buttons">
            <a mat-stroked-button [routerLink]="['/wallet', tradeAccount(), 'escrow', t.transactionId]">See the trade</a>
          </div>
        } @else {
          @if (ended(); as e) {
            <p class="stage">{{ endedText(e) }}</p>
            @if (e.released && isOwner() && !closed()) {
              @if (confirmClose()) {
                <p class="question">Close this listing? People can no longer connect; your chats stay.</p>
                <div class="buttons">
                  <button mat-flat-button type="button" (click)="closeListing()" [disabled]="busy()">Yes</button>
                  <button mat-button type="button" (click)="confirmClose.set(false)" [disabled]="busy()">Back</button>
                </div>
              } @else {
                <button mat-stroked-button type="button" (click)="confirmClose.set(true)" [disabled]="busy()">Close the listing</button>
              }
            }
          }
          @if (!closed() && !ended()?.released) {
            @if (side() === 'buyer') {
              <div class="buttons">
                <button mat-flat-button type="button" [matMenuTriggerFor]="accountsMenu" [disabled]="busy() || session.accounts().length === 0">Share an account</button>
                @if (session.accounts().length === 0) {
                  <span class="hint">This anoPod has no anos account yet.</span>
                }
              </div>
              <mat-menu #accountsMenu="matMenu">
                @for (account of session.accounts(); track account.accountId) {
                  <button mat-menu-item type="button" (click)="share(account.accountId)"><code>{{ shortId(account.accountId) }}</code> · {{ account.accountType }}</button>
                }
              </mat-menu>
            } @else if (starting()) {
              <div class="form">
                @if (spendingAccounts().length === 1) {
                  <p class="field">From <code>{{ shortId(from()) }}</code></p>
                } @else if (spendingAccounts().length === 0) {
                  <p class="field hint">This anoPod has no spending account.</p>
                } @else {
                  <mat-form-field appearance="outline" subscriptSizing="dynamic">
                    <mat-label>From</mat-label>
                    <mat-select [value]="from()" (valueChange)="from.set($event)">
                      @for (account of spendingAccounts(); track account.accountId) {
                        <mat-option [value]="account.accountId">{{ shortId(account.accountId) }}</mat-option>
                      }
                    </mat-select>
                  </mat-form-field>
                }
                @if (theirAccountIds().length === 1) {
                  <p class="field">To <code>{{ shortId(to()) }}</code></p>
                } @else {
                  <mat-form-field appearance="outline" subscriptSizing="dynamic">
                    <mat-label>To</mat-label>
                    <mat-select [value]="to()" (valueChange)="to.set($event)">
                      @for (id of theirAccountIds(); track id) {
                        <mat-option [value]="id">{{ shortId(id) }}</mat-option>
                      }
                    </mat-select>
                  </mat-form-field>
                }
                <mat-form-field appearance="outline" subscriptSizing="dynamic">
                  <mat-label>Amount, anos</mat-label>
                  <input matInput inputmode="decimal" [ngModel]="amount()" (ngModelChange)="amount.set($event)" />
                </mat-form-field>
                @if (formTotal(); as total) {
                  <p class="field">{{ total }} at the listing's price</p>
                }
                @if (confirmStart()) {
                  <p class="question">Put {{ amount().trim() }} anos into escrow for {{ otherName() }}? You release them once you have been paid. Only the buyer can cancel; either side can dispute.</p>
                  <div class="buttons">
                    <button mat-flat-button type="button" (click)="start()" [disabled]="busy()">Yes</button>
                    <button mat-button type="button" (click)="confirmStart.set(false)" [disabled]="busy()">Back</button>
                  </div>
                } @else {
                  <div class="buttons">
                    <button mat-flat-button type="button" (click)="confirmStart.set(true)" [disabled]="busy() || !canStart()">Start</button>
                    <button mat-button type="button" (click)="starting.set(false)" [disabled]="busy()">Cancel</button>
                  </div>
                }
              </div>
            } @else {
              <div class="buttons">
                <button mat-flat-button type="button" (click)="openForm()" [disabled]="busy() || theirAccountIds().length === 0">Start the escrow trade</button>
                @if (theirAccountIds().length === 0) {
                  <span class="hint">Ask them to share an account first</span>
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

  protected readonly session = inject(SessionService);
  private readonly market = inject(MarketplaceService);
  private readonly chat = inject(ChatService);
  private readonly masterpod = inject(MasterpodApiService);
  private readonly anos = inject(AnosApiService);
  private readonly crypto = inject(CryptoService);
  private readonly signing = inject(SigningService);
  protected readonly lang = inject(LanguageService);

  protected readonly millionthsToAnos = millionthsToAnos;

  protected readonly listing = computed(() => this.room().listing);
  protected readonly closed = computed(() => this.listing()?.status === 'closed');
  protected readonly isOwner = computed(() => this.listing()?.owner.anopodId === this.session.anopodId());
  /** This pod's side in the trade: the owner of a sell listing and the other person of a buy listing are the seller. */
  protected readonly side = computed(() => {
    const listing = this.listing();
    return listing ? this.market.mySide(listing) : 'buyer';
  });
  protected readonly other = computed(() => this.chat.otherPerson(this.room()));
  protected readonly otherName = computed(() => this.other()?.username ?? 'them');
  protected readonly summary = computed(() => {
    const listing = this.listing();
    if (!listing) return '';
    const total = formatPrice(totalOf(listing.quantity, listing.price), listing.currency, 0);
    return `${this.market.sideWords(listing)} ${millionthsToAnos(listing.quantity)} anos · ${formatPrice(listing.price, listing.currency)} each · ${total}`;
  });
  /** The account ids the other person posted, newest first. */
  protected readonly theirAccountIds = computed(() => {
    const me = this.session.anopodId();
    return unique(this.accountIds().filter((a) => a.senderAnopodId !== me).map((a) => a.accountId));
  });
  /** This pod's accounts named in the chat: the ones /list-escrows is read on. */
  private readonly myNamedAccounts = computed(() => {
    const mine = new Set(this.session.accounts().map((a) => a.accountId));
    return unique(this.accountIds().map((a) => a.accountId).filter((id) => mine.has(id)));
  });
  private readonly myNamedKey = computed(() => this.myNamedAccounts().join(','));
  protected readonly spendingAccounts = computed(() => this.session.accounts().filter((a) => a.accountType === 'spending'));

  protected readonly trade = signal<EscrowItem | null>(null);
  /** This pod's account in the trade shown, for the stage's side and the link. */
  protected readonly tradeAccount = signal('');
  protected readonly ended = signal<Ended | null>(null);
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

  private seen: SeenTrade | null = null;
  private polling = false;
  private roomId: string | null = null;

  constructor() {
    // Another room: the card starts over.
    effect(() => {
      const id = this.room().chatRoomId;
      if (id === this.roomId) return;
      this.roomId = id;
      untracked(() => this.reset());
    });
    // The stage is read as soon as one of this pod's accounts is named in the chat, then every 5 seconds.
    effect(() => {
      this.myNamedKey();
      untracked(() => void this.poll());
    });
    const timer = setInterval(() => void this.poll(), ACCOUNT_POLL_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  private reset(): void {
    this.trade.set(null);
    this.tradeAccount.set('');
    this.ended.set(null);
    this.starting.set(false);
    this.confirmStart.set(false);
    this.confirmClose.set(false);
    this.error.set(null);
    this.seen = null;
  }

  protected shortId(accountId: string): string {
    return `${accountId.slice(0, 8)}…${accountId.slice(-4)}`;
  }

  /** The stage in words from this pod's side of the trade (escrow-stage.ts). */
  protected stageWords(t: EscrowItem): string {
    return escrowStageWords(t.stage, t.accountId === this.tradeAccount() ? 'seller' : 'buyer', this.lang.words().escrowStages);
  }

  protected endedText(e: Ended): string {
    if (e.released === null) return "Closed. Check the account's transactions to see whether the anos moved.";
    return e.released ? `Released: ${millionthsToAnos(e.amount)} anos went to the buyer.` : 'Cancelled: the seller kept the anos.';
  }

  /** The buyer posts one of their account ids into the chat. */
  protected share(accountId: string): Promise<void> {
    return this.run(() => this.post(`Please send the anos to this account: ${accountId}`));
  }

  /** The seller's form: the first spending account, the newest account id the other person posted, the listing's quantity. */
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
   * The escrowTransfer the way the account page's Send builds it: pair one
   * from the account's keyBlob and the encryption key, /get-account for the
   * latest transaction id, buildAnosTransferTransaction with type
   * escrowTransfer, /api/sign, /anos-transfer; then the message about it.
   */
  protected start(): Promise<void> {
    return this.run(async () => {
      const from = this.from();
      const to = this.to();
      const amount = anosToMillionths(this.amount());
      if (!from || !to || amount === null) throw new Error('Pick the accounts and an amount in anos');
      const pairOne = await this.pairOne(from);
      const latest = await this.anos.getAccount(pairOne, from, true);
      if (!latest.ok || !latest.body.latestTransactionId) throw new Error('No latest transaction on the ledger yet');
      const tx = await this.signing.sign(this.crypto.buildAnosTransferTransaction(pairOne, from, latest.body.latestTransactionId, to, amount, 'escrowTransfer', new Date()));
      const res = await this.anos.anosTransfer(tx);
      if (!res.ok) throw new Error(`The validator refused the trade: ${reasonOf(res)}`);
      this.starting.set(false);
      this.confirmStart.set(false);
      await this.post(`Escrow trade started: ${millionthsToAnos(amount)} anos from ${from} to ${to}. Transaction ${res.body.transactionId}.`);
      await this.poll();
    });
  }

  /** The owner closes the listing after a release; the room list is refreshed so the card reads Closed. */
  protected closeListing(): Promise<void> {
    return this.run(async () => {
      const listing = this.listing();
      if (!listing) throw new Error('This chat is not about a listing');
      const res = await this.market.close(listing.listingId);
      if (!res.ok) throw new Error(reasonOf(res));
      this.confirmClose.set(false);
      await this.chat.refreshRooms();
    });
  }

  /** A message into the room, encrypted like any other; the thread's poll shows it. */
  private async post(text: string): Promise<void> {
    const key = await this.chat.roomKeyOf(this.room());
    if (!key) throw new Error('No room key for this room');
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
    const encryptionKey = this.session.getEncryptionKey();
    if (!item) throw new Error("This account is not one of this anoPod's accounts");
    if (!encryptionKey) throw new Error('The encryption key is not in RAM: unlock again');
    return this.crypto.pairOneFromKeyBlob(this.crypto.fromHex(item.keyBlob), encryptionKey);
  }

  /**
   * /list-escrows on each of this pod's accounts named in the chat; the
   * newest trade whose other side is an account named in the chat is shown.
   * A trade seen open and then gone is closed: its id on the first page of
   * /list-transactions of this pod's account means released, else
   * cancelled (the trade page's rule). A failed quiet read keeps the card
   * as it is.
   */
  private async poll(): Promise<void> {
    if (this.polling || !this.session.hasSession()) return;
    this.polling = true;
    try {
      const named = new Set(this.accountIds().map((a) => a.accountId));
      const found: { trade: EscrowItem; myAccount: string }[] = [];
      for (const accountId of this.myNamedAccounts()) {
        const pairOne = await this.pairOne(accountId);
        const res = await this.anos.listEscrows(pairOne, accountId, true);
        if (!res.ok) continue;
        for (const trade of res.body.escrows) {
          const otherSide = trade.accountId === accountId ? trade.accountIdTo : trade.accountId;
          if (named.has(otherSide)) found.push({ trade, myAccount: accountId });
        }
      }
      found.sort((a, b) => b.trade.createdAt.localeCompare(a.trade.createdAt));
      const newest = found[0];
      if (newest) {
        this.trade.set(newest.trade);
        this.tradeAccount.set(newest.myAccount);
        this.ended.set(null);
        this.seen = { transactionId: newest.trade.transactionId, myAccount: newest.myAccount, amount: newest.trade.amount };
      } else if (this.seen) {
        const seen = this.seen;
        this.seen = null;
        const pairOne = await this.pairOne(seen.myAccount);
        const list = await this.anos.listTransactions(pairOne, seen.myAccount, {}, true);
        const released = list.ok ? list.body.transactions.some((t) => t.transactionId === seen.transactionId) : null;
        this.trade.set(null);
        this.ended.set({ released, amount: seen.amount });
      }
    } catch {
      // No encryption key or no account in this tab: the card keeps what it shows.
    } finally {
      this.polling = false;
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
