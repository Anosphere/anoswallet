import { Component, DestroyRef, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';
import { CONFIRM_ARM_MS } from '../constants';
import { LanguageService } from '../services/language.service';

/** One row of the box: a label and a value; `code` shows the value in the id font. */
export interface ConfirmLine {
  label: string;
  value: string;
  code?: boolean;
}

/** What opens the box: its title, the rows, the notes under them, and the words on the button that says yes. */
export interface ConfirmData {
  title: string;
  lines: ConfirmLine[];
  notes: string[];
  confirmLabel: string;
}

/**
 * The confirmation box (wallet spec 8.9), the wallet's one pop-up box, opened
 * with MatDialog by askConfirm below: before a send on the account page and
 * before a new anos account on the Wallet page. The title; the lines as a
 * two-column grid, a label and its value, an id in the id font; each note as
 * a paragraph; then Cancel, which closes with false, and the button the
 * caller names, which closes with true. The box closes only by those two:
 * askConfirm opens it so that a click outside it and the Escape key do
 * nothing, and with the focus on the box itself, so the Enter key answers
 * nothing. The second button cannot be pressed for the first CONFIRM_ARM_MS,
 * so the second click of a double click on the page's button never lands on
 * it.
 */
@Component({
  selector: 'app-confirm-dialog',
  imports: [MatButtonModule, MatDialogModule],
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
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button type="button" [mat-dialog-close]="false">{{ t().common.cancel }}</button>
      <button mat-flat-button type="button" [mat-dialog-close]="true" [disabled]="!armed()">{{ data.confirmLabel }}</button>
    </mat-dialog-actions>
  `,
  styles: `
    .lines { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; }
    .lines div { display: contents; }
    .label { color: var(--mat-sys-on-surface-variant); }
    .value { color: var(--mat-sys-on-surface); word-break: break-all; }
    p { margin: 12px 0 0; }
  `,
})
export class ConfirmDialogComponent {
  protected readonly data = inject<ConfirmData>(MAT_DIALOG_DATA);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  /** False for the first CONFIRM_ARM_MS after the box was made: the second button is off until it turns true. */
  protected readonly armed = signal(false);

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
