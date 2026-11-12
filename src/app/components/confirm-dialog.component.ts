import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { firstValueFrom } from 'rxjs';
import { CONFIRM_ARM_MS } from '../constants';
import { LanguageService } from '../services/language.service';

/** One row of the box: a label and a value; `code` shows the value in the id font. */
export interface ConfirmLine {
  label: string;
  value: string;
  code?: boolean;
}

/** What opens the box: its title, the rows, the notes under them, the words on the button that says yes and, when given, the words on the first button, a text the person has to type and the red of the button that says yes. */
export interface ConfirmData {
  title: string;
  lines: ConfirmLine[];
  notes: string[];
  confirmLabel: string;
  /** The words on the first button, which closes the box with false (2026-11-11). Left out, it reads Cancel (common.cancel); the cancel of a locked transfer gives Back, since Cancel there would read as the cancel itself. */
  cancelLabel?: string;
  /** A text the person types before the second button works (2026-11-12): the box shows one text box under the notes, with this label, and the button stays off until what is typed equals `expected`, both trimmed and in small letters. Left out, the box has no text box; a DAO or guardian stake on the account page gives the username. */
  typed?: { label: string; expected: string };
  /** True puts the class `danger` on the second button (2026-11-12), which the global rule in src/styles.css makes red. Left out, the button keeps the theme's colour; the cancel of a locked transfer gives true. */
  danger?: boolean;
}

/**
 * The confirmation box (wallet spec 8.9), the wallet's one pop-up box, opened
 * with MatDialog by askConfirm below: before a send on the account page,
 * before a new anos account on the Wallet page and, since 2026-11-11, before
 * the cancel of a locked transfer on the account page. The title; the lines
 * as a two-column grid, a label and its value, an id in the id font; each
 * note as a paragraph. A value wraps at a space and is cut inside a word
 * only when the word alone is too long; an id is cut anywhere, by the global
 * rule for `code`, so its 64 characters wrap on a phone. Then the first
 * button, which closes with false: Cancel, or the words the caller gives
 * (cancelLabel; the cancel of a locked transfer gives Back); and the button
 * the caller names, which closes with true. The
 * box closes only by those two:
 * askConfirm opens it so that a click outside it and the Escape key do
 * nothing, and with the focus on the box itself, so the Enter key answers
 * nothing. The second button cannot be pressed for the first CONFIRM_ARM_MS,
 * so the second click of a double click on the page's button never lands on
 * it.
 * Since 2026-11-12 a caller can ask for two more things. A text to type
 * (typed): one text box under the notes, with the caller's label, drawn
 * with FormsModule, MatFormFieldModule and MatInputModule; the second
 * button stays off until what is typed equals the expected text, both
 * trimmed and in small letters, and the first CONFIRM_ARM_MS have passed.
 * The text box stands in no form, so the Enter key in it answers nothing.
 * And a red second button (danger): it carries the class `danger`, the
 * global rule in src/styles.css. A caller that gives neither keeps the box
 * as it was.
 */
@Component({
  selector: 'app-confirm-dialog',
  imports: [FormsModule, MatButtonModule, MatDialogModule, MatFormFieldModule, MatInputModule],
  template: `
    <h2 mat-dialog-title>{{ data.title }}</h2>
    <mat-dialog-content>
      @if (data.lines.length > 0) {
        <div class="lines">
          @for (line of data.lines; track $index) {
            <div>
              <span class="label">{{ line.label }}</span>
              @if (line.code) {
                <code class="value">{{ line.value }}</code>
              } @else {
                <span class="value">{{ line.value }}</span>
              }
            </div>
          }
        </div>
      }
      @for (note of data.notes; track $index) {
        <p>{{ note }}</p>
      }
      @if (data.typed; as typed) {
        <mat-form-field appearance="outline" class="typed" subscriptSizing="dynamic">
          <mat-label>{{ typed.label }}</mat-label>
          <input matInput [ngModel]="typedText()" (ngModelChange)="typedText.set($event)" autocomplete="off" autocapitalize="none" />
        </mat-form-field>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button type="button" [mat-dialog-close]="false">{{ data.cancelLabel ?? t().common.cancel }}</button>
      <button mat-flat-button type="button" [class.danger]="data.danger" [mat-dialog-close]="true" [disabled]="!armed() || !typedOk()">{{ data.confirmLabel }}</button>
    </mat-dialog-actions>
  `,
  styles: `
    .lines { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; }
    .lines div { display: contents; }
    .label { color: var(--mat-sys-on-surface-variant); }
    .value { color: var(--mat-sys-on-surface); overflow-wrap: anywhere; }
    p { margin: 12px 0 0; }
    .typed { width: 100%; margin-top: 12px; }
  `,
})
export class ConfirmDialogComponent {
  protected readonly data = inject<ConfirmData>(MAT_DIALOG_DATA);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  /** False for the first CONFIRM_ARM_MS after the box was made: the second button is off until it turns true. */
  protected readonly armed = signal(false);

  /** What the text box holds (2026-11-12), in a box that asks for a typed text; it stays empty in every other box. */
  protected readonly typedText = signal('');

  /** True in a box that asks for no typed text; in one that does, true once what is typed equals the expected text, both trimmed and in small letters. The second button is off until this and armed are both true. */
  protected readonly typedOk = computed(() => {
    const typed = this.data.typed;
    return !typed || this.typedText().trim().toLowerCase() === typed.expected.trim().toLowerCase();
  });

  constructor() {
    const timer = setTimeout(() => this.armed.set(true), CONFIRM_ARM_MS);
    inject(DestroyRef).onDestroy(() => clearTimeout(timer));
  }
}

/** Opens the box and waits for its answer: true only when it closed with true, by its second button. A click outside the box and the Escape key do nothing (disableClose), and the focus goes to the box itself, not to a button (autoFocus). */
export function askConfirm(dialog: MatDialog, data: ConfirmData): Promise<boolean> {
  const ref = dialog.open<ConfirmDialogComponent, ConfirmData, boolean>(ConfirmDialogComponent, {
    data,
    disableClose: true,
    autoFocus: 'dialog',
    width: '480px',
    maxWidth: 'calc(100vw - 32px)',
  });
  return firstValueFrom(ref.afterClosed()).then((answer) => answer === true);
}
