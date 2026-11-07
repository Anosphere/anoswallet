import { Component, computed, inject, signal } from '@angular/core';
import { MatBottomSheet, MatBottomSheetModule } from '@angular/material/bottom-sheet';
import { MatButtonModule } from '@angular/material/button';
import { MatChipListboxChange, MatChipsModule } from '@angular/material/chips';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { anosToMillionths } from '../amounts';
import { FiltersData, FiltersSheetComponent, Ranges, emptyRanges, rangesSet } from '../components/filters-sheet.component';
import { ListingCardComponent } from '../components/listing-card.component';
import { PickerChoice, PickerData, PickerOption, PickerSheetComponent } from '../components/picker-sheet.component';
import { countryName, countryOptions } from '../countries';
import { currencyOptions, priceUnits } from '../prices';
import { LanguageService } from '../services/language.service';
import { reasonOf } from '../services/log.service';
import { MarketplaceService, SortKey } from '../services/marketplace.service';
import { ListingItem } from '../services/masterpod-api.service';

const SORT_WORDS: Record<SortKey, string> = { newest: 'Newest', priceLow: 'Price low to high', priceHigh: 'Price high to low' };

/**
 * Browse (wallet spec 8.2, Marketplace, Browse), at /marketplace: one row
 * of chips, scrolling sideways on a phone: All, Selling, Buying; Country
 * and Currency, which open the picker sheet (8.7); Sort, a menu; Filters,
 * with the number of ranges set, which opens the filters sheet (8.7). A
 * chip change reads the listings again (/list-listings: side, currency,
 * country, sort, limit 200, open only). Under the chips the Your listings
 * row, "N open · M waiting", while this pod has listings or someone waits.
 * Then the cards (8.7) in a grid, one column on a phone, the two ranges
 * applied here over the listings loaded; "No listings match." when nothing
 * is left. A round + to /marketplace/new at the bottom right on a phone, a
 * New listing button in the chip row on a desktop. The country and the
 * currency this device last picked are the ones Browse opens with.
 */
@Component({
  selector: 'app-marketplace-page',
  imports: [RouterLink, MatBottomSheetModule, MatButtonModule, MatChipsModule, MatIconModule, MatMenuModule, ListingCardComponent],
  template: `
    <div class="chips">
      <mat-chip-listbox aria-label="Side" [value]="side()" (change)="sideChanged($event)">
        <mat-chip-option value="all">All</mat-chip-option>
        <mat-chip-option value="sell">Selling</mat-chip-option>
        <mat-chip-option value="buy">Buying</mat-chip-option>
      </mat-chip-listbox>
      <mat-chip role="button" tabindex="0" [highlighted]="country() !== null" (click)="pickCountry()" (keydown.enter)="pickCountry()">{{ countryLabel() }}</mat-chip>
      <mat-chip role="button" tabindex="0" [highlighted]="currency() !== null" (click)="pickCurrency()" (keydown.enter)="pickCurrency()">{{ currency() ?? 'Currency' }}</mat-chip>
      <mat-chip role="button" tabindex="0" [matMenuTriggerFor]="sortMenu">{{ sortLabel() }}<mat-icon matChipTrailingIcon>arrow_drop_down</mat-icon></mat-chip>
      <mat-menu #sortMenu="matMenu">
        <button mat-menu-item type="button" (click)="setSort('newest')">Newest</button>
        <button mat-menu-item type="button" (click)="setSort('priceLow')">Price low to high</button>
        <button mat-menu-item type="button" (click)="setSort('priceHigh')">Price high to low</button>
      </mat-menu>
      <mat-chip role="button" tabindex="0" [highlighted]="rangeCount() > 0" (click)="openFilters()" (keydown.enter)="openFilters()">{{ rangeCount() > 0 ? 'Filters · ' + rangeCount() : 'Filters' }}</mat-chip>
      <span class="spacer"></span>
      <a mat-flat-button class="new" routerLink="/marketplace/new"><mat-icon>add</mat-icon> New listing</a>
    </div>

    @if (showMine()) {
      <a class="row" routerLink="/marketplace/mine">
        <span class="disc"><mat-icon>storefront</mat-icon></span>
        <span class="texts">
          <span class="title">Your listings</span>
          <span class="line">{{ mineLine() }}</span>
        </span>
        <mat-icon class="chevron">chevron_right</mat-icon>
      </a>
    }

    @if (error(); as text) {
      <p class="error">{{ text }}</p>
    }
    @if (loaded() && shown().length === 0 && !error()) {
      <p class="muted">No listings match.</p>
    }
    <div class="grid">
      @for (listing of shown(); track listing.listingId) {
        <app-listing-card [listing]="listing" />
      }
    </div>

    <a mat-fab class="fab" routerLink="/marketplace/new" aria-label="New listing"><mat-icon>add</mat-icon></a>
  `,
  styles: `
    :host { display: block; padding-bottom: 80px; }
    .chips { display: flex; align-items: center; gap: 8px; overflow-x: auto; padding: 4px 0 8px; scrollbar-width: none; }
    .chips > * { flex: none; }
    .chips > .spacer { flex: 1; }
    .row { display: flex; align-items: center; gap: 12px; padding: 10px 12px; margin: 4px 0 12px; border: 1px solid var(--mat-sys-outline-variant); border-radius: 12px; color: inherit; text-decoration: none; }
    .row:hover { background: var(--mat-sys-surface-container); }
    .disc { width: 48px; height: 48px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; background: var(--mat-sys-surface-container-high); color: var(--mat-sys-on-surface-variant); flex: none; }
    .texts { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .title { font-weight: 500; }
    .line { font-size: 13px; color: var(--mat-sys-on-surface-variant); }
    .chevron { color: var(--mat-sys-on-surface-variant); }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
    .fab { display: none; position: fixed; right: 16px; bottom: 16px; z-index: 1; }
    .muted { color: var(--mat-sys-on-surface-variant); }
    .error { color: var(--mat-sys-error); }
    @media (max-width: 839px) {
      .fab { display: inline-flex; }
      .new { display: none; }
    }
  `,
})
export class MarketplacePage {
  private readonly market = inject(MarketplaceService);
  private readonly sheet = inject(MatBottomSheet);
  protected readonly lang = inject(LanguageService);

  protected readonly side = signal<'all' | 'sell' | 'buy'>('all');
  protected readonly country = signal<string | null>(this.market.remembered().country);
  protected readonly currency = signal<string | null>(this.market.remembered().currency);
  protected readonly sort = signal<SortKey>('newest');
  protected readonly ranges = signal<Ranges>(emptyRanges());
  protected readonly listings = signal<ListingItem[]>([]);
  protected readonly loaded = signal(false);
  protected readonly error = signal<string | null>(null);
  /** This pod's listings, counted once when the page opens: all of them, and the open ones. */
  private readonly mineCount = signal<{ total: number; open: number } | null>(null);

  protected readonly countryLabel = computed(() => {
    const code = this.country();
    return code ? countryName(code, this.lang.tag()) : 'Country';
  });
  protected readonly sortLabel = computed(() => SORT_WORDS[this.sort()]);
  protected readonly rangeCount = computed(() => rangesSet(this.ranges()));
  /** The loaded listings within the two ranges; the price range applies only with a currency. */
  protected readonly shown = computed(() => {
    const ranges = this.ranges();
    const priceApplies = this.currency() !== null;
    return this.listings().filter((listing) => inRanges(listing, ranges, priceApplies));
  });
  protected readonly showMine = computed(() => (this.mineCount()?.total ?? 0) > 0 || this.market.waitingCount() > 0);
  protected readonly mineLine = computed(() => `${this.mineCount()?.open ?? 0} open · ${this.market.waitingCount()} waiting`);

  constructor() {
    void this.load();
    void this.market.mine().then((res) => {
      if (res.ok) this.mineCount.set({ total: res.body.listings.length, open: res.body.listings.filter((l) => l.status === 'open').length });
    });
  }

  /** /list-listings with the chips' side, country, currency and sort. */
  protected async load(): Promise<void> {
    const side = this.side();
    const res = await this.market.load({ side: side === 'all' ? null : side, country: this.country(), currency: this.currency(), sort: this.sort() });
    if (res.ok) {
      this.listings.set(res.body.listings);
      this.error.set(null);
    } else {
      this.error.set(`/list-listings: ${reasonOf(res)}`);
    }
    this.loaded.set(true);
  }

  protected sideChanged(event: MatChipListboxChange): void {
    const value = event.value;
    this.side.set(value === 'sell' || value === 'buy' ? value : 'all');
    void this.load();
  }

  protected setSort(sort: SortKey): void {
    this.sort.set(sort);
    void this.load();
  }

  protected async pickCountry(): Promise<void> {
    const choice = await this.pick('Country', countryOptions(this.lang.tag()));
    if (choice === undefined) return;
    this.country.set(choice.code);
    this.market.remember({ country: choice.code });
    await this.load();
  }

  protected async pickCurrency(): Promise<void> {
    const choice = await this.pick('Currency', currencyOptions());
    if (choice === undefined) return;
    this.currency.set(choice.code);
    this.market.remember({ currency: choice.code });
    await this.load();
  }

  protected async openFilters(): Promise<void> {
    const ref = this.sheet.open<FiltersSheetComponent, FiltersData, Ranges>(FiltersSheetComponent, {
      data: { ranges: this.ranges(), hasCurrency: this.currency() !== null },
      autoFocus: 'dialog',
    });
    const result = await firstValueFrom(ref.afterDismissed());
    if (result) this.ranges.set(result);
  }

  private pick(title: string, options: PickerOption[]): Promise<PickerChoice | undefined> {
    const ref = this.sheet.open<PickerSheetComponent, PickerData, PickerChoice>(PickerSheetComponent, {
      data: { title, options, allowAny: true },
      autoFocus: 'dialog',
    });
    return firstValueFrom(ref.afterDismissed());
  }
}

/** True when the listing is within the quantity range and, when it applies, the price range; an empty or unreadable bound is no bound. */
function inRanges(listing: ListingItem, ranges: Ranges, priceApplies: boolean): boolean {
  const quantity = BigInt(listing.quantity);
  const least = anosToMillionths(ranges.quantityMin);
  const most = anosToMillionths(ranges.quantityMax);
  if (least !== null && quantity < least) return false;
  if (most !== null && quantity > most) return false;
  if (priceApplies) {
    const price = priceUnits(listing.price);
    const low = priceUnits(ranges.priceMin);
    const high = priceUnits(ranges.priceMax);
    if (low !== null && (price === null || price < low)) return false;
    if (high !== null && (price === null || price > high)) return false;
  }
  return true;
}
