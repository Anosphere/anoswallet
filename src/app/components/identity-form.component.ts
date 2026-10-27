import { Component, computed, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { countryOptions } from '../countries';
import { BAR, IdentityAnswers, UNKNOWN } from '../services/public-ledger-id';

/** A text field of the form: what was typed, and whether it is Known or Unknown (the five that allow it). */
export interface TextField {
  key: keyof Omit<IdentityAnswers, 'country' | 'date'>;
  label: string;
  unknownAllowed: boolean;
}

export type TextKey = TextField['key'];

/** The seven text fields of docs/public-ledger-id.md section 1, in order. */
export const TEXT_FIELDS: TextField[] = [
  { key: 'firstname', label: 'First name', unknownAllowed: false },
  { key: 'lastname', label: 'Last name', unknownAllowed: false },
  { key: 'fatherfirstname', label: "Father's first name", unknownAllowed: true },
  { key: 'fatherlastname', label: "Father's last name", unknownAllowed: true },
  { key: 'motherfirstname', label: "Mother's first name", unknownAllowed: true },
  { key: 'mothermaidenname', label: "Mother's maiden name", unknownAllowed: true },
  { key: 'city', label: 'City of birth', unknownAllowed: true },
];

/** True when a value holds the bar character no field may contain. */
export function hasBar(value: string): boolean {
  return value.includes(BAR);
}

function emptyTexts(): Record<TextKey, string> {
  return { firstname: '', lastname: '', fatherfirstname: '', fatherlastname: '', motherfirstname: '', mothermaidenname: '', city: '' };
}

function allKnown(): Record<TextKey, boolean> {
  return { firstname: false, lastname: false, fatherfirstname: false, fatherlastname: false, motherfirstname: false, mothermaidenname: false, city: false };
}

/**
 * The answers of the nine-field form while they are typed. The page that
 * shows the form owns one (so the answers survive a pane or step change and
 * a review pane can read them), hands it to the component, and resets it
 * once the ids exist. Nothing here leaves the tab's memory.
 */
export class IdentityFormState {
  readonly countries = countryOptions();
  readonly texts = signal<Record<TextKey, string>>(emptyTexts());
  readonly unknown = signal<Record<TextKey, boolean>>(allKnown());
  readonly country = signal<string | null>(null);
  readonly date = signal<Date | null>(null);

  /** True when every field is answered (or Unknown where allowed), no bar, a country and a date. */
  readonly complete = computed(() => {
    const texts = this.texts();
    const unknown = this.unknown();
    for (const field of TEXT_FIELDS) {
      const value = texts[field.key];
      if (hasBar(value)) return false;
      if (!unknown[field.key] && value.trim() === '') return false;
    }
    return this.country() !== null && this.date() !== null;
  });

  readonly countryName = computed(() => this.countries.find((c) => c.code === this.country())?.name ?? '');
  readonly dateText = computed(() => this.date()?.toLocaleDateString(undefined, { day: '2-digit', month: 'long', year: 'numeric' }) ?? '');

  setText(key: TextKey, value: string): void {
    this.texts.update((t) => ({ ...t, [key]: value }));
  }

  setUnknown(key: TextKey, value: boolean): void {
    this.unknown.update((u) => ({ ...u, [key]: value }));
    if (value) this.setText(key, '');
  }

  /** The answers as public-ledger-id.ts takes them (Unknown fields as the literal), or null while the form is incomplete. */
  answers(): IdentityAnswers | null {
    const country = this.country();
    const date = this.date();
    if (!this.complete() || !country || !date) return null;
    const texts = this.texts();
    const unknown = this.unknown();
    const value = (key: TextKey) => (unknown[key] ? UNKNOWN : texts[key]);
    return {
      firstname: value('firstname'),
      lastname: value('lastname'),
      fatherfirstname: value('fatherfirstname'),
      fatherlastname: value('fatherlastname'),
      motherfirstname: value('motherfirstname'),
      mothermaidenname: value('mothermaidenname'),
      city: value('city'),
      country,
      date,
    };
  }

  /** Drops every answer. */
  reset(): void {
    this.texts.set(emptyTexts());
    this.unknown.set(allKnown());
    this.country.set(null);
    this.date.set(null);
  }
}

/**
 * The nine-field birth record form of docs/public-ledger-id.md (wallet spec
 * 8.2 and 12.4): the seven texts with Known / Unknown beside the five that
 * allow it, a country select, a date picker, and the guidance above them.
 * The identity page and the locked-out stepper both show it, each with its
 * own IdentityFormState.
 */
@Component({
  selector: 'app-identity-form',
  imports: [FormsModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatDatepickerModule],
  template: `
    <p class="guidance">
      Write things the common way they are written today, your best guess of your birth certificate. St. Louis or Saint Louis
      both can be tried in a recovery, but the more exact, the easier. If you do not know, choose Unknown.
    </p>
    <div class="grid">
      @for (field of textFields; track field.key) {
        <div class="field-row">
          <mat-form-field appearance="outline" class="grow">
            <mat-label>{{ field.label }}</mat-label>
            <input matInput [ngModel]="state().texts()[field.key]" (ngModelChange)="state().setText(field.key, $event)" [disabled]="state().unknown()[field.key]" />
            @if (hasBar(state().texts()[field.key])) {
              <mat-hint class="error">The bar character | is not allowed</mat-hint>
            }
          </mat-form-field>
          @if (field.unknownAllowed) {
            <mat-form-field appearance="outline" class="known">
              <mat-label>Known?</mat-label>
              <mat-select [value]="state().unknown()[field.key] ? 'unknown' : 'known'" (valueChange)="state().setUnknown(field.key, $event === 'unknown')">
                <mat-option value="known">Known</mat-option>
                <mat-option value="unknown">Unknown</mat-option>
              </mat-select>
            </mat-form-field>
          }
        </div>
      }
      <div class="field-row">
        <mat-form-field appearance="outline" class="grow">
          <mat-label>Country of birth</mat-label>
          <mat-select [value]="state().country()" (valueChange)="state().country.set($event)">
            @for (c of state().countries; track c.code) {
              <mat-option [value]="c.code">{{ c.name }} ({{ c.code }})</mat-option>
            }
          </mat-select>
        </mat-form-field>
      </div>
      <div class="field-row">
        <mat-form-field appearance="outline" class="grow">
          <mat-label>Date of birth</mat-label>
          <input matInput [matDatepicker]="picker" [value]="state().date()" (dateChange)="state().date.set($event.value)" readonly (click)="picker.open()" />
          <mat-datepicker-toggle matIconSuffix [for]="picker"></mat-datepicker-toggle>
          <mat-datepicker #picker startView="multi-year"></mat-datepicker>
        </mat-form-field>
      </div>
    </div>
  `,
  styles: `
    :host { display: block; }
    .guidance { max-width: 720px; }
    .grid { display: flex; flex-direction: column; gap: 4px; max-width: 720px; }
    .field-row { display: flex; gap: 8px; flex-wrap: wrap; }
    .grow { flex: 1; min-width: 240px; }
    .known { width: 140px; }
    .error { color: var(--mat-sys-error); }
  `,
})
export class IdentityFormComponent {
  /** The answers, owned by the page. */
  readonly state = input.required<IdentityFormState>();

  protected readonly textFields = TEXT_FIELDS;
  protected hasBar = hasBar;
}
