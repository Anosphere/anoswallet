import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatBottomSheet, MatBottomSheetModule } from '@angular/material/bottom-sheet';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatRadioModule } from '@angular/material/radio';
import { MatSelectModule } from '@angular/material/select';
import { firstValueFrom } from 'rxjs';
import { currencyOptions, formatPrice, perAnosOf, priceUnits } from '../prices';
import { TransactionItem } from '../services/anos-api.service';
import { LanguageService } from '../services/language.service';
import { MarketplaceService } from '../services/marketplace.service';
import { MONEY_KINDS, Note, NoteDetails, NoteKind, NotesService, OTHER_KINDS } from '../services/notes.service';
import { SessionService } from '../services/session.service';
import { PickerChoice, PickerData, PickerSheetComponent } from './picker-sheet.component';

/**
 * The note form (wallet spec 8.2, Transaction history; 2026-11-07, section
 * 11), opened under a history row for a new note and under a Noted
 * transactions row to edit one: three radio kinds (Bought, Sold, Received
 * as income), a drop-down of the other kinds with a Tag box when Other is
 * picked, the money (the total paid or received) with the currency button
 * beside it (the picker sheet, 8.7) and the price per anos under them, an
 * optional memo, Save and Cancel. The row presets the kind and the newest
 * note's currency starts the form; the money and its currency are required
 * for the three radio kinds and optional for the others. The ledger facts
 * and the private part go to the notes service, which makes the blob under
 * the encryption key.
 */
@Component({
  selector: 'app-note-form',
  imports: [FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatRadioModule, MatSelectModule, MatIconModule, MatBottomSheetModule],
  template: `
    <div class="note-form">
      <mat-radio-group class="kinds" [value]="radioKind()" (change)="kind.set($event.value)">
        <mat-radio-button value="bought">{{ t().notes.kinds.bought }}</mat-radio-button>
        <mat-radio-button value="sold">{{ t().notes.kinds.sold }}</mat-radio-button>
        <mat-radio-button value="income">{{ t().notes.kinds.income }}</mat-radio-button>
      </mat-radio-group>
      <mat-form-field appearance="outline" subscriptSizing="dynamic">
        <mat-label>{{ t().notes.otherKinds }}</mat-label>
        <mat-select [value]="otherKind()" (valueChange)="kind.set($event)">
          @for (k of otherKinds; track k) {
            <mat-option [value]="k">{{ t().notes.kinds[k] }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
      @if (kind() === 'other') {
        <mat-form-field appearance="outline" subscriptSizing="dynamic">
          <mat-label>{{ t().notes.tag }}</mat-label>
          <input matInput [ngModel]="tag()" (ngModelChange)="tag.set($event)" maxlength="60" />
        </mat-form-field>
      }
      <div class="money">
        <mat-form-field appearance="outline" subscriptSizing="dynamic">
          <mat-label>{{ t().notes.money }}</mat-label>
          <input matInput inputmode="decimal" [ngModel]="money()" (ngModelChange)="money.set($event)" />
        </mat-form-field>
        <button mat-stroked-button type="button" (click)="pickCurrency()"><mat-icon>payments</mat-icon> {{ currency() ?? t().common.currency }}</button>
      </div>
      @if (perAnos(); as price) {
        <p class="muted">{{ t().common.perAnos(price) }}</p>
      }
      @if (needsMoney()) {
        <p class="muted">{{ t().notes.moneyHint }}</p>
      }
      <mat-form-field appearance="outline" subscriptSizing="dynamic">
        <mat-label>{{ t().notes.memo }}</mat-label>
        <textarea matInput rows="2" [ngModel]="memo()" (ngModelChange)="memo.set($event)" maxlength="500"></textarea>
      </mat-form-field>
      @if (error(); as text) {
        <p class="error">{{ text }}</p>
      }
      <div class="buttons">
        <button mat-flat-button type="button" (click)="save()" [disabled]="busy() || !canSave()">{{ t().common.save }}</button>
        <button mat-button type="button" (click)="cancelled.emit()" [disabled]="busy()">{{ t().common.cancel }}</button>
      </div>
    </div>
  `,
  styles: `
    .note-form { display: flex; flex-direction: column; gap: 8px; margin: 8px 0; max-width: 480px; }
    .kinds { display: flex; flex-wrap: wrap; gap: 4px 16px; }
    .money { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .buttons { display: flex; gap: 8px; }
    .muted { color: var(--mat-sys-on-surface-variant); }
    .error { color: var(--mat-sys-error); }
  `,
})
export class NoteFormComponent {
  /** The history row of a new note; null when a note is being edited. */
  readonly row = input<TransactionItem | null>(null);
  /** The note being edited; null for a new one. One of the two is given. */
  readonly note = input<Note | null>(null);
  readonly accountId = input.required<string>();
  /** The note saved, new or edited. */
  readonly saved = output<Note>();
  readonly cancelled = output<void>();

  private readonly notes = inject(NotesService);
  private readonly session = inject(SessionService);
  private readonly market = inject(MarketplaceService);
  private readonly sheet = inject(MatBottomSheet);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  protected readonly otherKinds = OTHER_KINDS;
  protected readonly kind = signal<NoteKind | null>(null);
  protected readonly tag = signal('');
  protected readonly money = signal('');
  protected readonly currency = signal<string | null>(null);
  protected readonly memo = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  /** The kind as the radio group shows it: one of the three, else none, so a pick in the drop-down clears the radios. */
  protected readonly radioKind = computed(() => {
    const kind = this.kind();
    return kind !== null && MONEY_KINDS.includes(kind) ? kind : null;
  });
  /** The kind as the drop-down shows it: one of the five, else none, so a pick among the radios clears the drop-down. */
  protected readonly otherKind = computed(() => {
    const kind = this.kind();
    return kind !== null && OTHER_KINDS.includes(kind) ? kind : null;
  });
  /** The amount the form works with: the note's when editing, else the row's. */
  private readonly amount = computed(() => this.note()?.amount ?? this.row()?.amount ?? '0');
  /** The price per anos, "35.50 THB", once the money is a price and a currency is picked. */
  protected readonly perAnos = computed(() => {
    const currency = this.currency();
    if (currency === null || priceUnits(this.money()) === null) return null;
    const per = perAnosOf(this.money(), this.amount());
    return per === null ? null : formatPrice(per, currency);
  });
  /** True while one of the three radio kinds lacks its money or its currency. */
  protected readonly needsMoney = computed(() => {
    const kind = this.kind();
    return kind !== null && MONEY_KINDS.includes(kind) && (priceUnits(this.money()) === null || this.currency() === null);
  });
  /** A kind is picked, the money is there when it must be, the money is empty or a price, and other has its tag. */
  protected readonly canSave = computed(() => {
    const kind = this.kind();
    if (kind === null || this.needsMoney()) return false;
    if (this.money().trim() !== '' && priceUnits(this.money()) === null) return false;
    return kind !== 'other' || this.tag().trim() !== '';
  });

  constructor() {
    effect(() => {
      const note = this.note();
      const row = this.row();
      untracked(() => this.fill(note, row));
    });
  }

  /** The fields from the note's details when editing (a blob that did not open starts as other, the rest empty), else the preset kind, the starting currency and the rest empty. */
  private fill(note: Note | null, row: TransactionItem | null): void {
    if (note) {
      const details = note.details;
      this.kind.set(details?.kind ?? 'other');
      this.tag.set(details?.tag ?? '');
      this.money.set(details?.money ?? '');
      this.currency.set(details?.currency ?? null);
      this.memo.set(details?.memo ?? '');
    } else {
      this.kind.set(row ? this.notes.presetKind(row, this.accountId(), this.session.accounts()) : null);
      this.tag.set('');
      this.money.set('');
      this.currency.set(this.notes.startingCurrency(this.market.remembered().currency));
      this.memo.set('');
    }
    this.error.set(null);
  }

  /** The picker sheet (8.7) for the currency, as the new-listing page opens it. */
  protected async pickCurrency(): Promise<void> {
    const ref = this.sheet.open<PickerSheetComponent, PickerData, PickerChoice>(PickerSheetComponent, {
      data: { title: this.t().common.currency, options: currencyOptions(this.lang.tag()), allowAny: false },
      autoFocus: 'dialog',
    });
    const choice = await firstValueFrom(ref.afterDismissed());
    if (choice?.code) this.currency.set(choice.code);
  }

  /** The details, then notes.add for a new note or notes.update for an edited one; the saved note is emitted, a refusal shows in red. */
  protected async save(): Promise<void> {
    const kind = this.kind();
    const note = this.note();
    const row = this.row();
    if (kind === null || !this.canSave() || (!note && !row)) return;
    const money = this.money().trim();
    const details: NoteDetails = {
      v: 1,
      kind,
      money: money === '' ? null : money,
      currency: money === '' ? null : this.currency(),
      memo: this.memo().trim(),
      tag: kind === 'other' ? this.tag().trim() : '',
    };
    this.busy.set(true);
    this.error.set(null);
    try {
      const saved = note ? await this.notes.update(note, details) : await this.notes.add(this.notes.clearOf(row!, this.accountId()), details);
      this.saved.emit(saved);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }
}
