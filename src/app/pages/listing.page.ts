import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { RouterLink } from '@angular/router';
import { millionthsToAnos } from '../amounts';
import { AvatarComponent } from '../components/avatar.component';
import { ListingPeopleComponent } from '../components/listing-people.component';
import { countryName } from '../countries';
import { formatPrice, totalOf } from '../prices';
import { LanguageService } from '../services/language.service';
import { ApiResponse, reasonOf } from '../services/log.service';
import { MarketplaceService } from '../services/marketplace.service';
import { ListingItem } from '../services/masterpod-api.service';
import { SessionService } from '../services/session.service';

/**
 * One listing (wallet spec 8.2, Marketplace, Listing), at
 * /marketplace/:listingId: /get-listing when it opens and after Connect,
 * Accept, Decline and Close; the price in large bold text, the side and
 * quantity, the total, the country, when it was posted, the owner with
 * their avatar (8.6) and name; a Closed banner when closed. Someone else's
 * listing shows, by its state for this pod, Connect (the first-message box
 * with the ready-made words, Send, Cancel), "Waiting for somchai to
 * accept", Open chat, or "somchai did not accept." with Connect again; a
 * closed listing keeps only Open chat. This pod's own listing shows the
 * people who connected (8.7) and Close listing, which asks once in place.
 */
@Component({
  selector: 'app-listing-page',
  imports: [DatePipe, NgTemplateOutlet, FormsModule, RouterLink, MatButtonModule, MatIconModule, MatFormFieldModule, MatInputModule, AvatarComponent, ListingPeopleComponent],
  template: `
    <header class="head">
      <a mat-icon-button routerLink="/marketplace" aria-label="Back to the marketplace"><mat-icon>arrow_back</mat-icon></a>
      <h2>Listing</h2>
    </header>
    @if (listing(); as listing) {
      @if (listing.status === 'closed') {
        <p class="banner">Closed</p>
      }
      <p class="price">{{ priceLine() }}</p>
      <p class="line">{{ market.sideWords(listing) }} {{ anos() }} anos</p>
      <p class="line">Total {{ total() }}</p>
      <p class="muted">{{ country() }} · posted {{ listing.createdAt | date: 'medium' }}</p>
      <div class="owner">
        <app-avatar [anopodId]="listing.owner.anopodId" [username]="listing.owner.username" [size]="56" />
        <span class="texts">
          <span class="title">{{ listing.owner.username }}</span>
          <span class="muted">{{ listing.owner.firstName }} {{ listing.owner.lastName }}</span>
        </span>
      </div>

      @if (mine()) {
        <h3>People</h3>
        <app-listing-people [listing]="listing" (changed)="reload()" />
        @if (listing.status === 'open') {
          @if (confirmClose()) {
            <p>Close this listing? People can no longer connect; your chats stay.</p>
            <div class="buttons">
              <button mat-flat-button type="button" (click)="close()" [disabled]="busy()">Yes</button>
              <button mat-button type="button" (click)="confirmClose.set(false)" [disabled]="busy()">Back</button>
            </div>
          } @else {
            <button mat-stroked-button type="button" class="big" (click)="confirmClose.set(true)" [disabled]="busy()">Close listing</button>
          }
        }
      } @else {
        @if (!session.hasChatKeys()) {
          <p class="error">No chat keys in this tab: unlock again.</p>
        }
        @switch (state()) {
          @case ('open') {
            @if (myRoom(); as room) {
              <a mat-flat-button class="big" [routerLink]="['/chat', room.chatRoomId]">Open chat</a>
            }
          }
          @case ('waiting') {
            @if (listing.status === 'closed') {
              <p class="muted">This listing is closed.</p>
            } @else {
              <button mat-flat-button class="big" type="button" disabled>Waiting for {{ listing.owner.username }} to accept</button>
            }
          }
          @case ('declined') {
            @if (listing.status === 'closed') {
              <p class="muted">This listing is closed.</p>
            } @else {
              <p class="muted">{{ listing.owner.username }} did not accept.</p>
              @if (composing()) {
                <ng-container *ngTemplateOutlet="box" />
              } @else {
                <button mat-flat-button class="big" type="button" (click)="openBox()" [disabled]="busy() || !session.hasChatKeys()">Connect again</button>
              }
            }
          }
          @default {
            @if (listing.status === 'closed') {
              <p class="muted">This listing is closed.</p>
            } @else if (composing()) {
              <ng-container *ngTemplateOutlet="box" />
            } @else {
              <button mat-flat-button class="big" type="button" (click)="openBox()" [disabled]="busy() || !session.hasChatKeys()">Connect</button>
            }
          }
        }
      }
      @if (error(); as text) {
        <p class="error">{{ text }}</p>
      }

      <ng-template #box>
        <mat-form-field appearance="outline" class="wide" subscriptSizing="dynamic">
          <mat-label>Your first message</mat-label>
          <textarea matInput rows="3" [ngModel]="text()" (ngModelChange)="text.set($event)"></textarea>
        </mat-form-field>
        <div class="buttons">
          <button mat-flat-button type="button" (click)="send()" [disabled]="busy() || !text().trim()">Send</button>
          <button mat-button type="button" (click)="composing.set(false)" [disabled]="busy()">Cancel</button>
        </div>
      </ng-template>
    } @else if (notFound()) {
      <p class="muted">This listing does not exist.</p>
    } @else {
      @if (error(); as text) {
        <p class="error">{{ text }}</p>
      } @else {
        <p class="muted">Loading</p>
      }
    }
  `,
  styles: `
    :host { display: block; max-width: 560px; margin: 0 auto; }
    .head { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; }
    h2 { font-size: 1.25rem; font-weight: 500; margin: 0; }
    h3 { font-size: 1rem; font-weight: 500; margin: 20px 0 4px; }
    .banner { display: inline-block; padding: 4px 12px; border-radius: 10px; background: var(--mat-sys-secondary-container); color: var(--mat-sys-on-secondary-container); font-weight: 500; margin: 0 0 8px; }
    .price { font-size: 1.6rem; font-weight: 700; margin: 4px 0 8px; }
    .line { font-size: 1.05rem; margin: 2px 0; }
    .owner { display: flex; align-items: center; gap: 12px; margin: 16px 0; }
    .texts { display: flex; flex-direction: column; }
    .title { font-weight: 500; font-size: 1.05rem; }
    .big { width: 100%; height: 48px; font-size: 1rem; margin: 12px 0 4px; }
    .wide { width: 100%; margin-top: 12px; }
    .buttons { display: flex; gap: 8px; margin: 8px 0; }
    .muted { color: var(--mat-sys-on-surface-variant); margin: 4px 0; }
    .error { color: var(--mat-sys-error); }
  `,
})
export class ListingPage {
  readonly listingId = input.required<string>();

  protected readonly session = inject(SessionService);
  protected readonly market = inject(MarketplaceService);
  protected readonly lang = inject(LanguageService);

  protected readonly listing = signal<ListingItem | null>(null);
  protected readonly notFound = signal(false);
  protected readonly composing = signal(false);
  protected readonly confirmClose = signal(false);
  protected readonly text = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly mine = computed(() => this.listing()?.owner.anopodId === this.session.anopodId());
  protected readonly myRoom = computed(() => {
    const listing = this.listing();
    return listing ? this.market.myRoomAbout(listing.listingId) : null;
  });
  protected readonly state = computed(() => {
    const listing = this.listing();
    return listing ? this.market.stateOf(listing) : 'connect';
  });
  protected readonly priceLine = computed(() => {
    const listing = this.listing();
    return listing ? `${formatPrice(listing.price, listing.currency)} per anos` : '';
  });
  protected readonly anos = computed(() => {
    const listing = this.listing();
    return listing ? millionthsToAnos(listing.quantity) : '';
  });
  protected readonly total = computed(() => {
    const listing = this.listing();
    return listing ? formatPrice(totalOf(listing.quantity, listing.price), listing.currency, 0) : '';
  });
  protected readonly country = computed(() => {
    const listing = this.listing();
    return listing ? countryName(listing.country, this.lang.tag()) : '';
  });

  constructor() {
    effect(() => {
      this.listingId();
      untracked(() => void this.reload());
    });
  }

  /** /get-listing for the route's id; "does not exist" on a 404. */
  protected async reload(): Promise<void> {
    const res = await this.market.get(this.listingId());
    if (res.ok) {
      this.listing.set(res.body.listing);
      this.notFound.set(false);
    } else if (res.status === 404) {
      this.listing.set(null);
      this.notFound.set(true);
    } else {
      this.error.set(`/get-listing: ${reasonOf(res)}`);
    }
  }

  /** The first-message box, with the ready-made words. */
  protected openBox(): void {
    const listing = this.listing();
    if (!listing) return;
    this.text.set(this.market.firstWords(listing));
    this.composing.set(true);
  }

  /** Connect, or Connect again into the declined room; then the listing is read again and the state follows the rooms. */
  protected send(): Promise<void> {
    return this.run(async () => {
      const listing = this.listing();
      if (!listing) throw new Error('The listing is not loaded');
      const room = this.myRoom();
      const res = room ? await this.market.connectAgain(room, this.text().trim()) : await this.market.connect(listing, this.text().trim());
      if (res.ok) this.composing.set(false);
      await this.reload();
      return res;
    });
  }

  protected close(): Promise<void> {
    return this.run(async () => {
      const listing = this.listing();
      if (!listing) throw new Error('The listing is not loaded');
      const res = await this.market.close(listing.listingId);
      this.confirmClose.set(false);
      await this.reload();
      return res;
    });
  }

  private async run(action: () => Promise<ApiResponse<unknown>>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const res = await action();
      if (!res.ok) this.error.set(reasonOf(res));
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }
}
