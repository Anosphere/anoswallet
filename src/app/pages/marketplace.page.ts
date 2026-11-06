import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatListModule } from '@angular/material/list';
import { MatSelectModule } from '@angular/material/select';
import { RouterLink } from '@angular/router';
import { anosToMillionths, millionthsToAnos } from '../amounts';
import { ChatService } from '../services/chat.service';
import { CryptoService } from '../services/crypto.service';
import { ApiResponse, reasonOf } from '../services/log.service';
import { ListingItem, MasterpodApiService } from '../services/masterpod-api.service';
import { SessionService } from '../services/session.service';

/**
 * Marketplace (wallet spec 8.2): the masterpod test app's section on
 * Material: listings with filters and sort, a new listing with its room (the
 * room key wrapped to this pod's own chat keys), Request to join on
 * another's open listing, Close on one's own. The owner's Room link opens
 * the listing's room; another's listing shows Open chat when this pod is in
 * its room, Requested after a request from this tab, else Request to join
 * (2026-11-05, section 11).
 */
@Component({
  selector: 'app-marketplace-page',
  imports: [FormsModule, RouterLink, MatCardModule, MatButtonModule, MatListModule, MatIconModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatExpansionModule],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>Marketplace</mat-card-title>
        <mat-card-subtitle>Anos for a currency, in person. Every listing has a room; talk there.</mat-card-subtitle>
      </mat-card-header>
      <mat-card-content>
        @if (error(); as text) { <p class="error">{{ text }}</p> }
        <mat-expansion-panel>
          <mat-expansion-panel-header><mat-panel-title>New listing</mat-panel-title></mat-expansion-panel-header>
          <div class="form">
            <mat-form-field appearance="outline"><mat-label>Side</mat-label>
              <mat-select [value]="side()" (valueChange)="side.set($event)"><mat-option value="sell">sell</mat-option><mat-option value="buy">buy</mat-option></mat-select>
            </mat-form-field>
            <mat-form-field appearance="outline"><mat-label>Quantity (anos)</mat-label><input matInput [ngModel]="quantity()" (ngModelChange)="quantity.set($event)" /></mat-form-field>
            <mat-form-field appearance="outline"><mat-label>Currency (ISO 4217)</mat-label><input matInput [ngModel]="currency()" (ngModelChange)="currency.set($event)" placeholder="USD" /></mat-form-field>
            <mat-form-field appearance="outline"><mat-label>Country (alpha-2)</mat-label><input matInput [ngModel]="country()" (ngModelChange)="country.set($event)" placeholder="US" /></mat-form-field>
            <mat-form-field appearance="outline"><mat-label>Price per anos</mat-label><input matInput [ngModel]="price()" (ngModelChange)="price.set($event)" placeholder="1.50" /></mat-form-field>
            <button mat-flat-button type="button" (click)="createListing()" [disabled]="busy() || !session.hasChatKeys()">Create listing</button>
          </div>
        </mat-expansion-panel>

        <h3>Listings</h3>
        <div class="form">
          <mat-form-field appearance="outline"><mat-label>Side</mat-label>
            <mat-select [value]="filterSide()" (valueChange)="filterSide.set($event)"><mat-option value="">any</mat-option><mat-option value="buy">buy</mat-option><mat-option value="sell">sell</mat-option></mat-select>
          </mat-form-field>
          <mat-form-field appearance="outline"><mat-label>Currency</mat-label><input matInput [ngModel]="filterCurrency()" (ngModelChange)="filterCurrency.set($event)" /></mat-form-field>
          <mat-form-field appearance="outline"><mat-label>Country</mat-label><input matInput [ngModel]="filterCountry()" (ngModelChange)="filterCountry.set($event)" /></mat-form-field>
          <mat-form-field appearance="outline"><mat-label>Status</mat-label>
            <mat-select [value]="filterStatus()" (valueChange)="filterStatus.set($event)"><mat-option value="open">open</mat-option><mat-option value="closed">closed</mat-option></mat-select>
          </mat-form-field>
          <mat-form-field appearance="outline"><mat-label>Sort by</mat-label>
            <mat-select [value]="sortBy()" (valueChange)="sortBy.set($event)"><mat-option value="createdAt">newest</mat-option><mat-option value="price">price</mat-option><mat-option value="quantity">quantity</mat-option></mat-select>
          </mat-form-field>
          <mat-form-field appearance="outline"><mat-label>Direction</mat-label>
            <mat-select [value]="sortDirection()" (valueChange)="sortDirection.set($event)"><mat-option value="desc">descending</mat-option><mat-option value="asc">ascending</mat-option></mat-select>
          </mat-form-field>
          <button mat-stroked-button type="button" (click)="loadListings()" [disabled]="busy()">List</button>
        </div>
        <mat-list>
          @for (listing of listings(); track listing.listingId) {
            <mat-list-item lines="2">
              <mat-icon matListItemIcon>{{ listing.side === 'sell' ? 'sell' : 'shopping_cart' }}</mat-icon>
              <span matListItemTitle>{{ listing.side }} {{ millionthsToAnos(listing.quantity) }} anos @ {{ listing.price }} {{ listing.currency }} · {{ listing.country }} · {{ listing.status }}</span>
              <span matListItemLine>by <code>{{ listing.owner.username }}</code></span>
              <span matListItemMeta class="meta">
                @if (listing.owner.anopodId !== session.anopodId()) {
                  @if (inRoom(listing.chatRoomId)) {
                    <a mat-stroked-button [routerLink]="['/chat', listing.chatRoomId]">Open chat</a>
                  } @else if (chat.requestedRooms().has(listing.chatRoomId)) {
                    <button mat-stroked-button type="button" disabled>Requested</button>
                  } @else {
                    <button mat-stroked-button type="button" (click)="requestToJoin(listing.chatRoomId)" [disabled]="busy() || listing.status !== 'open'">Request to join</button>
                  }
                } @else {
                  <a mat-button [routerLink]="['/chat', listing.chatRoomId]">Room</a>
                  <button mat-button type="button" (click)="closeListing(listing.listingId)" [disabled]="busy() || listing.status !== 'open'">Close</button>
                }
              </span>
            </mat-list-item>
          } @empty {
            <p class="muted">No listings match.</p>
          }
        </mat-list>
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    .form { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 8px 0; }
    mat-form-field { max-width: 180px; }
    .meta { display: flex; gap: 4px; align-items: center; }
    .muted { color: var(--mat-sys-on-surface-variant); }
    .error { color: var(--mat-sys-error); }
  `,
})
export class MarketplacePage {
  protected readonly session = inject(SessionService);
  private readonly api = inject(MasterpodApiService);
  private readonly crypto = inject(CryptoService);
  protected readonly chat = inject(ChatService);

  protected readonly millionthsToAnos = millionthsToAnos;
  protected readonly side = signal<'buy' | 'sell'>('sell');
  protected readonly quantity = signal('1');
  protected readonly currency = signal('USD');
  protected readonly country = signal('US');
  protected readonly price = signal('1.50');
  protected readonly filterSide = signal('');
  protected readonly filterCurrency = signal('');
  protected readonly filterCountry = signal('');
  protected readonly filterStatus = signal('open');
  protected readonly sortBy = signal('createdAt');
  protected readonly sortDirection = signal('desc');
  protected readonly listings = signal<ListingItem[]>([]);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    void this.loadListings();
  }

  /** A listing with its marketplace room; the room key is wrapped to this pod's own chat keys and kept. */
  protected createListing(): Promise<void> {
    return this.run(async () => {
      const chat = this.session.getChatKeys();
      if (!chat) throw new Error('No chat keys in this tab');
      const quantity = anosToMillionths(this.quantity());
      if (quantity === null) throw new Error('The quantity must be anos with up to six decimals');
      const roomKey = this.crypto.newRoomKey();
      const hpkeKey = await this.crypto.wrapRoomKey(roomKey, this.crypto.toHex(chat.p256Public), this.crypto.toHex(chat.kemPublic));
      const res = await this.api.createListing({
        side: this.side(),
        quantity: quantity.toString(),
        currency: this.currency().trim().toUpperCase(),
        country: this.country().trim().toUpperCase(),
        price: this.price().trim(),
        hpkeKey: this.crypto.toHex(hpkeKey),
      });
      if (res.ok) {
        this.session.roomKeys.set(res.body.chatRoomId, roomKey);
        await this.loadListings();
      }
      return res;
    });
  }

  protected async loadListings(): Promise<void> {
    const filters: Record<string, string | number> = { status: this.filterStatus(), sortBy: this.sortBy(), sortDirection: this.sortDirection() };
    if (this.filterSide() !== '') filters['side'] = this.filterSide();
    if (this.filterCurrency().trim() !== '') filters['currency'] = this.filterCurrency().trim().toUpperCase();
    if (this.filterCountry().trim() !== '') filters['country'] = this.filterCountry().trim().toUpperCase();
    const res = await this.api.listListings(filters);
    if (res.ok) {
      this.listings.set(res.body.listings);
      this.error.set(null);
    } else {
      this.error.set(`/list-listings: ${reasonOf(res)}`);
    }
  }

  /** True when this pod is in the listing's room: its owner, or let in. */
  protected inRoom(chatRoomId: string): boolean {
    return this.session.chatRooms()?.rooms.some((r) => r.chatRoomId === chatRoomId) ?? false;
  }

  protected requestToJoin(chatRoomId: string): Promise<void> {
    return this.run(async () => {
      const res = await this.api.requestToJoin(chatRoomId);
      if (res.ok) this.chat.markRequested(chatRoomId);
      return res;
    });
  }

  protected closeListing(listingId: string): Promise<void> {
    return this.run(async () => {
      const res = await this.api.closeListing(listingId);
      await this.loadListings();
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
