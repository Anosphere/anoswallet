import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatBottomSheet, MatBottomSheetModule } from '@angular/material/bottom-sheet';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleChange, MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { anosToMillionths } from '../amounts';
import { PickerChoice, PickerData, PickerOption, PickerSheetComponent } from '../components/picker-sheet.component';
import { countryName, countryOptions } from '../countries';
import { currencyOptions, formatPrice, priceUnits, totalOf } from '../prices';
import { ApiResponse, reasonOf } from '../services/log.service';
import { MarketplaceService } from '../services/marketplace.service';
import { MasterpodApiService } from '../services/masterpod-api.service';

/**
 * New listing (wallet spec 8.2, Marketplace, New listing), at
 * /marketplace/new: two large toggle buttons, "I am selling anos" and "I am
 * buying anos" (selling at first); the quantity in anos (up to six
 * decimals); the price per anos (a decimal, up to eight decimals); Currency
 * and Country as buttons that open the picker sheet (8.7) and show the
 * chosen name, the ones this device remembers at first; a live "Total 3,550
 * THB" once the three are in; Create listing, which calls /create-listing
 * (no key work: a listing has no room of its own) and opens the listing's
 * page. The refusal shows in red.
 */
@Component({
  selector: 'app-listing-new-page',
  imports: [FormsModule, RouterLink, MatBottomSheetModule, MatButtonModule, MatButtonToggleModule, MatIconModule, MatFormFieldModule, MatInputModule],
  template: `
    <header class="head">
      <a mat-icon-button routerLink="/marketplace" aria-label="Back to the marketplace"><mat-icon>arrow_back</mat-icon></a>
      <h2>New listing</h2>
    </header>
    <mat-button-toggle-group class="sides" [value]="side()" (change)="sideChanged($event)" hideSingleSelectionIndicator aria-label="Side">
      <mat-button-toggle value="sell">I am selling anos</mat-button-toggle>
      <mat-button-toggle value="buy">I am buying anos</mat-button-toggle>
    </mat-button-toggle-group>
    <mat-form-field appearance="outline" class="wide">
      <mat-label>Quantity, anos</mat-label>
      <input matInput inputmode="decimal" [ngModel]="quantity()" (ngModelChange)="quantity.set($event)" />
    </mat-form-field>
    <mat-form-field appearance="outline" class="wide">
      <mat-label>Price per anos</mat-label>
      <input matInput inputmode="decimal" [ngModel]="price()" (ngModelChange)="price.set($event)" />
    </mat-form-field>
    <div class="pickers">
      <button mat-stroked-button type="button" (click)="pickCurrency()"><mat-icon>payments</mat-icon> {{ currencyLabel() }}</button>
      <button mat-stroked-button type="button" (click)="pickCountry()"><mat-icon>public</mat-icon> {{ countryLabel() }}</button>
    </div>
    @if (total(); as total) {
      <p class="total">Total {{ total }}</p>
    }
    @if (error(); as text) {
      <p class="error">{{ text }}</p>
    }
    <button mat-flat-button type="button" class="big" (click)="create()" [disabled]="busy() || !canCreate()">Create listing</button>
  `,
  styles: `
    :host { display: block; max-width: 560px; margin: 0 auto; }
    .head { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; }
    h2 { font-size: 1.25rem; font-weight: 500; margin: 0; }
    .sides { display: flex; width: 100%; margin: 4px 0 16px; }
    .sides mat-button-toggle { flex: 1; }
    .wide { width: 100%; }
    .pickers { display: flex; gap: 8px; flex-wrap: wrap; margin: 4px 0 12px; }
    .pickers button { flex: 1; min-width: 160px; height: 44px; }
    .total { font-size: 1.1rem; font-weight: 500; margin: 8px 0; }
    .big { width: 100%; height: 48px; font-size: 1rem; margin-top: 8px; }
    .error { color: var(--mat-sys-error); }
  `,
})
export class ListingNewPage {
  private readonly market = inject(MarketplaceService);
  private readonly api = inject(MasterpodApiService);
  private readonly sheet = inject(MatBottomSheet);
  private readonly router = inject(Router);

  protected readonly side = signal<'buy' | 'sell'>('sell');
  protected readonly quantity = signal('');
  protected readonly price = signal('');
  protected readonly currency = signal<string | null>(this.market.remembered().currency);
  protected readonly country = signal<string | null>(this.market.remembered().country);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly currencyLabel = computed(() => this.currency() ?? 'Currency');
  protected readonly countryLabel = computed(() => {
    const code = this.country();
    return code ? countryName(code) : 'Country';
  });
  protected readonly canCreate = computed(
    () => anosToMillionths(this.quantity()) !== null && (priceUnits(this.price()) ?? 0n) > 0n && this.currency() !== null && this.country() !== null,
  );
  /** "Total 3,550 THB" once the quantity, the price and the currency are in. */
  protected readonly total = computed(() => {
    const quantity = anosToMillionths(this.quantity());
    const currency = this.currency();
    if (quantity === null || !currency || (priceUnits(this.price()) ?? 0n) <= 0n) return null;
    return formatPrice(totalOf(quantity, this.price()), currency, 0);
  });

  protected sideChanged(event: MatButtonToggleChange): void {
    if (event.value === 'buy' || event.value === 'sell') this.side.set(event.value);
  }

  protected async pickCurrency(): Promise<void> {
    const choice = await this.pick('Currency', currencyOptions());
    if (choice?.code) this.currency.set(choice.code);
  }

  protected async pickCountry(): Promise<void> {
    const choice = await this.pick('Country', countryOptions());
    if (choice?.code) this.country.set(choice.code);
  }

  private pick(title: string, options: PickerOption[]): Promise<PickerChoice | undefined> {
    const ref = this.sheet.open<PickerSheetComponent, PickerData, PickerChoice>(PickerSheetComponent, {
      data: { title, options, allowAny: false },
      autoFocus: 'dialog',
    });
    return firstValueFrom(ref.afterDismissed());
  }

  /** /create-listing; the country and currency are remembered and the listing's page opens. */
  protected create(): Promise<void> {
    return this.run(async () => {
      const quantity = anosToMillionths(this.quantity());
      if (quantity === null) throw new Error('The quantity must be anos with up to six decimals');
      const price = this.price().trim();
      if ((priceUnits(price) ?? 0n) <= 0n) throw new Error('The price must be a number above zero with up to eight decimals');
      const currency = this.currency();
      const country = this.country();
      if (!currency || !country) throw new Error('Pick a currency and a country');
      const res = await this.api.createListing({ side: this.side(), quantity: quantity.toString(), currency, country, price });
      if (res.ok) {
        this.market.remember({ country, currency });
        await this.router.navigate(['/marketplace', res.body.listingId]);
      }
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
