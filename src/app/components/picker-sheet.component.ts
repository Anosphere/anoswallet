import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_BOTTOM_SHEET_DATA, MatBottomSheetRef } from '@angular/material/bottom-sheet';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { LanguageService } from '../services/language.service';

/** One choice of the picker: an ISO code and its name. */
export interface PickerOption {
  code: string;
  name: string;
}

/** What opens the sheet: its title, the options, and whether "Any" is offered on top. */
export interface PickerData {
  title: string;
  options: PickerOption[];
  allowAny: boolean;
}

/** What the sheet closes with: the chosen code, null for Any. A sheet dismissed without a choice gives undefined. */
export interface PickerChoice {
  code: string | null;
}

/**
 * The picker sheet (wallet spec 8.7), opened with MatBottomSheet for a
 * country or a currency on Browse and on the new-listing form: a title, a
 * search box, "Any" on top when the sheet allows it, and the options whose
 * code or name contains the typed letters; tapping one closes the sheet
 * with its code. Without any option (a browser that does not know the
 * currencies) a typed three-letter code can be used as it is.
 */
@Component({
  selector: 'app-picker-sheet',
  imports: [FormsModule, MatFormFieldModule, MatInputModule],
  template: `
    <h3>{{ data.title }}</h3>
    <mat-form-field appearance="outline" class="search" subscriptSizing="dynamic">
      <mat-label>{{ t().common.search }}</mat-label>
      <input matInput [ngModel]="query()" (ngModelChange)="query.set($event)" autocomplete="off" />
    </mat-form-field>
    <div class="rows">
      @if (data.allowAny) {
        <button type="button" class="row" (click)="choose(null)"><span class="code"></span><span>{{ t().picker.any }}</span></button>
      }
      @for (option of matches(); track option.code) {
        <button type="button" class="row" (click)="choose(option.code)"><span class="code">{{ option.code }}</span><span>{{ option.name }}</span></button>
      }
      @if (typedCode(); as code) {
        <button type="button" class="row" (click)="choose(code)"><span class="code">{{ code }}</span><span>{{ t().picker.useCode }}</span></button>
      }
      @if (matches().length === 0 && !typedCode()) {
        <p class="muted">{{ t().picker.noMatch }}</p>
      }
    </div>
  `,
  styles: `
    :host { display: block; padding: 8px 16px 16px; }
    h3 { font-size: 1.1rem; font-weight: 500; margin: 8px 0 12px; }
    .search { width: 100%; }
    .rows { max-height: 55vh; overflow: auto; margin-top: 8px; }
    .row { display: flex; align-items: center; gap: 12px; width: 100%; padding: 12px 8px; border: none; border-radius: 8px; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
    .row:hover { background: var(--mat-sys-surface-container); }
    .code { width: 48px; flex: none; font-weight: 500; }
    .muted { color: var(--mat-sys-on-surface-variant); padding: 8px; }
  `,
})
export class PickerSheetComponent {
  protected readonly data = inject<PickerData>(MAT_BOTTOM_SHEET_DATA);
  private readonly ref = inject<MatBottomSheetRef<PickerSheetComponent, PickerChoice>>(MatBottomSheetRef);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  protected readonly query = signal('');

  /** The options whose code or name contains the typed letters; all of them while nothing is typed. */
  protected readonly matches = computed(() => {
    const q = this.query().trim().toLowerCase();
    if (!q) return this.data.options;
    return this.data.options.filter((o) => o.code.toLowerCase().includes(q) || o.name.toLowerCase().includes(q));
  });

  /** With no options to pick from, three typed letters are a code to use as it is. */
  protected readonly typedCode = computed(() => {
    const typed = this.query().trim();
    return this.data.options.length === 0 && /^[A-Za-z]{3}$/.test(typed) ? typed.toUpperCase() : null;
  });

  protected choose(code: string | null): void {
    this.ref.dismiss({ code });
  }
}
