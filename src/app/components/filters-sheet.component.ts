import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_BOTTOM_SHEET_DATA, MatBottomSheetRef } from '@angular/material/bottom-sheet';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { LanguageService } from '../services/language.service';

/** The two ranges of Browse, as typed: anos for the quantity, the currency's units for the price; empty when not set. */
export interface Ranges {
  quantityMin: string;
  quantityMax: string;
  priceMin: string;
  priceMax: string;
}

/** What opens the sheet: the ranges as they are, and whether Browse has a currency (the price range needs one). */
export interface FiltersData {
  ranges: Ranges;
  hasCurrency: boolean;
}

export function emptyRanges(): Ranges {
  return { quantityMin: '', quantityMax: '', priceMin: '', priceMax: '' };
}

/** How many of the two ranges have a bound: the number on the Filters chip. */
export function rangesSet(ranges: Ranges): number {
  return (ranges.quantityMin.trim() || ranges.quantityMax.trim() ? 1 : 0) + (ranges.priceMin.trim() || ranges.priceMax.trim() ? 1 : 0);
}

/**
 * The filters sheet (wallet spec 8.7), opened with MatBottomSheet from
 * Browse: the quantity range (least and most anos) and the price range
 * (least and most, disabled with the hint "Pick a currency first" while
 * Browse has no currency), Apply, which closes with the ranges, and Clear,
 * which closes with none. The ranges are applied on the phone over the
 * listings loaded.
 */
@Component({
  selector: 'app-filters-sheet',
  imports: [FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule],
  template: `
    <h3>{{ t().common.filters }}</h3>
    <p class="group">{{ t().common.quantityAnos }}</p>
    <div class="pair">
      <mat-form-field appearance="outline" subscriptSizing="dynamic"><mat-label>{{ t().filters.least }}</mat-label><input matInput inputmode="decimal" [ngModel]="quantityMin()" (ngModelChange)="quantityMin.set($event)" /></mat-form-field>
      <mat-form-field appearance="outline" subscriptSizing="dynamic"><mat-label>{{ t().filters.most }}</mat-label><input matInput inputmode="decimal" [ngModel]="quantityMax()" (ngModelChange)="quantityMax.set($event)" /></mat-form-field>
    </div>
    <p class="group">{{ t().common.pricePerAnos }}</p>
    <div class="pair">
      <mat-form-field appearance="outline" subscriptSizing="dynamic"><mat-label>{{ t().filters.least }}</mat-label><input matInput inputmode="decimal" [ngModel]="priceMin()" (ngModelChange)="priceMin.set($event)" [disabled]="!data.hasCurrency" /></mat-form-field>
      <mat-form-field appearance="outline" subscriptSizing="dynamic"><mat-label>{{ t().filters.most }}</mat-label><input matInput inputmode="decimal" [ngModel]="priceMax()" (ngModelChange)="priceMax.set($event)" [disabled]="!data.hasCurrency" /></mat-form-field>
    </div>
    @if (!data.hasCurrency) {
      <p class="muted">{{ t().filters.pickCurrencyFirst }}</p>
    }
    <div class="buttons">
      <button mat-flat-button type="button" (click)="apply()">{{ t().filters.apply }}</button>
      <button mat-button type="button" (click)="clear()">{{ t().common.clear }}</button>
    </div>
  `,
  styles: `
    :host { display: block; padding: 8px 16px 16px; }
    h3 { font-size: 1.1rem; font-weight: 500; margin: 8px 0 4px; }
    .group { margin: 12px 0 8px; font-weight: 500; }
    .pair { display: flex; gap: 8px; }
    .pair mat-form-field { flex: 1; min-width: 0; }
    .muted { color: var(--mat-sys-on-surface-variant); font-size: 13px; margin: 6px 0 0; }
    .buttons { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
  `,
})
export class FiltersSheetComponent {
  protected readonly data = inject<FiltersData>(MAT_BOTTOM_SHEET_DATA);
  private readonly ref = inject<MatBottomSheetRef<FiltersSheetComponent, Ranges>>(MatBottomSheetRef);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  protected readonly quantityMin = signal(this.data.ranges.quantityMin);
  protected readonly quantityMax = signal(this.data.ranges.quantityMax);
  protected readonly priceMin = signal(this.data.hasCurrency ? this.data.ranges.priceMin : '');
  protected readonly priceMax = signal(this.data.hasCurrency ? this.data.ranges.priceMax : '');

  protected apply(): void {
    this.ref.dismiss({ quantityMin: this.quantityMin(), quantityMax: this.quantityMax(), priceMin: this.priceMin(), priceMax: this.priceMax() });
  }

  protected clear(): void {
    this.ref.dismiss(emptyRanges());
  }
}
