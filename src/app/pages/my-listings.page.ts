import { Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { RouterLink } from '@angular/router';
import { ListingCardComponent } from '../components/listing-card.component';
import { ListingPeopleComponent } from '../components/listing-people.component';
import { ApiResponse, reasonOf } from '../services/log.service';
import { MarketplaceService } from '../services/marketplace.service';
import { ListingItem } from '../services/masterpod-api.service';

/**
 * Your listings (wallet spec 8.2, Marketplace, Your listings), at
 * /marketplace/mine: /list-listings with mine when the page opens and after
 * a Close, the open listings first, newest first, then the closed ones.
 * Each is a card (8.7) with, under it, the people who connected (8.7) and,
 * for an open listing, Close, which asks once in place. "You have no
 * listings yet." with New listing when there are none.
 */
@Component({
  selector: 'app-my-listings-page',
  imports: [RouterLink, MatButtonModule, MatIconModule, ListingCardComponent, ListingPeopleComponent],
  template: `
    <header class="head">
      <a mat-icon-button routerLink="/marketplace" aria-label="Back to the marketplace"><mat-icon>arrow_back</mat-icon></a>
      <h2>Your listings</h2>
    </header>
    @if (error(); as text) {
      <p class="error">{{ text }}</p>
    }
    @for (listing of listings(); track listing.listingId) {
      <section class="block">
        <app-listing-card [listing]="listing" />
        <app-listing-people [listing]="listing" />
        @if (listing.status === 'open') {
          @if (closing() === listing.listingId) {
            <p>Close this listing? People can no longer connect; your chats stay.</p>
            <div class="buttons">
              <button mat-flat-button type="button" (click)="close(listing)" [disabled]="busy()">Yes</button>
              <button mat-button type="button" (click)="closing.set(null)" [disabled]="busy()">Back</button>
            </div>
          } @else {
            <button mat-stroked-button type="button" (click)="closing.set(listing.listingId)" [disabled]="busy()">Close</button>
          }
        }
      </section>
    } @empty {
      @if (loaded()) {
        <p class="muted">You have no listings yet.</p>
        <a mat-flat-button routerLink="/marketplace/new"><mat-icon>add</mat-icon> New listing</a>
      } @else if (!error()) {
        <p class="muted">Loading</p>
      }
    }
  `,
  styles: `
    :host { display: block; max-width: 560px; margin: 0 auto; }
    .head { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; }
    h2 { font-size: 1.25rem; font-weight: 500; margin: 0; }
    .block { display: flex; flex-direction: column; gap: 4px; padding: 0 0 16px; margin: 0 0 16px; border-bottom: 1px solid var(--mat-sys-outline-variant); }
    .block app-listing-people { padding: 0 8px; }
    .block > button { align-self: flex-start; }
    .buttons { display: flex; gap: 8px; }
    .muted { color: var(--mat-sys-on-surface-variant); }
    .error { color: var(--mat-sys-error); }
  `,
})
export class MyListingsPage {
  private readonly market = inject(MarketplaceService);

  protected readonly listings = signal<ListingItem[]>([]);
  protected readonly loaded = signal(false);
  protected readonly closing = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    void this.load();
  }

  /** This pod's listings: the open ones first, newest first, then the closed ones. */
  protected async load(): Promise<void> {
    const res = await this.market.mine();
    if (res.ok) {
      const newestFirst = (a: ListingItem, b: ListingItem) => b.createdAt.localeCompare(a.createdAt);
      const open = res.body.listings.filter((l) => l.status === 'open').sort(newestFirst);
      const closed = res.body.listings.filter((l) => l.status !== 'open').sort(newestFirst);
      this.listings.set([...open, ...closed]);
      this.error.set(null);
    } else {
      this.error.set(`/list-listings: ${reasonOf(res)}`);
    }
    this.loaded.set(true);
  }

  protected close(listing: ListingItem): Promise<void> {
    return this.run(async () => {
      const res = await this.market.close(listing.listingId);
      this.closing.set(null);
      await this.load();
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
