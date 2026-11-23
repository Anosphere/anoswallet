import { Component, DestroyRef, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule, MatDialogRef, MatDialogState } from '@angular/material/dialog';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { firstValueFrom } from 'rxjs';
import { CONFIRM_ARM_MS } from '../constants';
import { checkSessionPasskey } from '../passkey-check';
import { CryptoService } from '../services/crypto.service';
import { LanguageService } from '../services/language.service';
import { PasskeyService } from '../services/passkey.service';
import { SessionService } from '../services/session.service';

/** One row of the box: a label and a value; `code` shows the value in the id font. */
export interface ConfirmLine {
  label: string;
  value: string;
  code?: boolean;
}

/** What opens the box: its title, the rows, the notes under them, the words on the button that says yes and, when given, the words on the first button, the passkey step of the button that says yes (since 2026-11-19, in place of a text the person had to type), since 2026-11-20 the caller's own step for it (`approve`) and what that button waits for (`ready`), and the red of that button. */
export interface ConfirmData {
  title: string;
  lines: ConfirmLine[];
  notes: string[];
  confirmLabel: string;
  /** The words on the first button, which closes the box with false (2026-11-11). Left out, it reads Cancel (common.cancel); the cancel of a locked transfer gives Back, since Cancel there would read as the cancel itself. So do four of the escrow trade's five boxes (escrow-boxes.ts, 2026-11-17); the fifth, the question before a cancel, gives "No, I have not paid". */
  cancelLabel?: string;
  /** True makes the second button ask for the passkey that opened the session before the box closes with true (2026-11-19; passkey-check.ts). While the device asks, both buttons are off. When the check passes, the box closes with true. When it does not, the box stays open, the reason shows under the notes in red, and the button works again. Left out, the second button closes the box with true at once. The Send form and the cancel of a locked transfer on the account page give true, and so do the box before a new anos account on the Wallet page, the Release, Dispute and Cancel boxes of an escrow trade and the Start box of the marketplace chat's pinned card (escrow-boxes.ts). Since 2026-11-20 all of them but the box before a new anos account also give `approve` below, and the passkey is then asked inside that step, for exactly what the step built; the box before a new anos account keeps the wallet's own check (checkSessionPasskey). */
  passkey?: boolean;
  /** With `passkey` (2026-11-20): the caller's own step, which the second button runs straight from its click in place of the wallet's own passkey check. The caller builds what is to be signed and asks the passkey for it there (askSigningPasskey in passkey-check.ts), and keeps both for after the box. While it runs, both buttons are off. When it resolves, the box closes with true. When it throws, the box stays open, the error's message shows under the notes in red, and the button works again. Every box that gives `passkey` gives it, but the box before a new anos account, which keeps the wallet's own check. */
  approve?: () => Promise<void>;
  /** What the second button waits for (2026-11-20): until it resolves the button is off and a moving bar shows under the notes. When it rejects, the error's message shows in red and the button stays off, so the first button is the way out. The Send box of the account page and the Start box of the marketplace chat's card give it: the read of the account's latest transaction id, started when the box opens. Left out, the button waits for CONFIRM_ARM_MS alone. */
  ready?: Promise<void>;
  /** True puts the class `danger` on the second button (2026-11-12), which the global rule in src/styles.css makes red. Left out, the button keeps the theme's colour; the cancel of a locked transfer gives true, and so do the two boxes of an escrow trade whose second button disputes, the Dispute box and "Do not cancel this trade" (escrow-boxes.ts, 2026-11-17). */
  danger?: boolean;
  /** True leaves the first button out (2026-11-22): the box has one button, the caller's, and tells something that has happened and cannot be refused. The shell's box "You are logged out" gives it (app.ts). Left out, the box has its two buttons. */
  single?: boolean;
}

/**
 * The confirmation box (wallet spec 8.9), the wallet's one pop-up box, opened
 * with MatDialog by askConfirm or askChoice below: before a send on the
 * account page, before a new anos account on the Wallet page, since
 * 2026-11-11 before the cancel of a locked transfer on the account page
 * and, since 2026-11-17, before a release, a dispute and a cancel on the
 * escrow trade page, with the five boxes of escrow-boxes.ts, and before a
 * release in the pinned card of a marketplace chat, with the Release box
 * of the same file, and since 2026-11-19 before the seller puts the anos
 * in escrow from that card, with the Start box of that file (until then
 * the card asked in place). Since 2026-11-19 each of these boxes asks
 * for the
 * passkey (below), except two of the escrow trade's five, which sign
 * nothing: the question before a cancel and "Do not cancel this trade".
 * The title; the lines
 * as a two-column grid, a label and its value, an id in the id font; each
 * note as a paragraph. A value wraps at a space and is cut inside a word
 * only when the word alone is too long; an id is cut anywhere, by the global
 * rule for `code`, so its 64 characters wrap on a phone. Then the first
 * button, which closes with false: Cancel, or the words the caller gives
 * (cancelLabel; the cancel of a locked transfer gives Back); and the button
 * the caller names, which closes with true, in a box that asks for the
 * passkey only once the passkey check has passed. The
 * box closes by those two:
 * askConfirm and askChoice open it so that a click outside it and the
 * Escape key do nothing, and with the focus on the box itself, so the
 * Enter key answers nothing. One more thing closes it (put right on
 * 2026-11-17): a step back or forward in the browser's history, the Back
 * of a phone among them, as Angular Material closes every dialog then.
 * The box then closes with no answer: askConfirm answers false for it, as
 * for the first button, and askChoice answers null.
 * The second button cannot be pressed for the first CONFIRM_ARM_MS,
 * so the second click of a double click on the page's button never lands on
 * it.
 * Since 2026-11-12 a caller can ask for two more things. The first was a
 * text to type, the username; it is gone since 2026-11-19
 * (forclaude/wallet-chat-and-passkey-plan-1.md), and no box has a text
 * box any more. In its place stands the passkey step (passkey): the
 * second button asks the device for the passkey that opened the session,
 * straight from its click. Since 2026-11-20
 * (forclaude/second-key-and-signing-passkey-plan-1.md) the button runs
 * the caller's own step for that (approve): the caller builds what is to
 * be signed and asks the passkey for exactly that (askSigningPasskey in
 * passkey-check.ts), so the answer can go to a signing server. A box
 * that gives no such step, which is the box before a new anos account
 * alone, keeps the wallet's own check (checkSessionPasskey in
 * passkey-check.ts).
 * While the device asks, both buttons are off. When the check passes, the
 * box closes with true. When it does not, the box stays open, the reason
 * shows under the notes in red, and the button works again.
 * A caller can also give the box something to wait for (ready, since
 * 2026-11-20): until it is there, the second button is off and a thin
 * moving bar shows under the notes; when it fails, its reason shows
 * under the notes in red and the button stays off, so the first button
 * is the way out. The Send box of the account page and the Start box of
 * the marketplace chat's card give it: the read of the account's latest
 * transaction id, started when the box opens.
 * And a red second button (danger): it carries the class `danger`, the
 * global rule in src/styles.css. A caller that gives neither keeps the box
 * as it was. Since 2026-11-22 a caller can ask for a box with one button
 * (single), and the shell's box "You are logged out" is the one box that
 * does.
 */
@Component({
  selector: 'app-confirm-dialog',
  imports: [MatButtonModule, MatDialogModule, MatProgressBarModule],
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
      @if (passkeyError(); as text) {
        <p class="error">{{ text }}</p>
      }
      @if (waiting()) {
        <mat-progress-bar mode="indeterminate"></mat-progress-bar>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      @if (!data.single) {
        <button mat-button type="button" [mat-dialog-close]="false" [disabled]="asking()">{{ data.cancelLabel ?? t().common.cancel }}</button>
      }
      <button mat-flat-button type="button" [class.danger]="data.danger" (click)="yes()" [disabled]="!armed() || asking() || waiting() || blocked()">{{ data.confirmLabel }}</button>
    </mat-dialog-actions>
  `,
  styles: `
    .lines { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; }
    .lines div { display: contents; }
    .label { color: var(--mat-sys-on-surface-variant); }
    .value { color: var(--mat-sys-on-surface); overflow-wrap: anywhere; }
    p { margin: 12px 0 0; }
    .error { color: var(--mat-sys-error); }
    mat-progress-bar { margin-top: 12px; }
  `,
})
export class ConfirmDialogComponent {
  protected readonly data = inject<ConfirmData>(MAT_DIALOG_DATA);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;
  private readonly ref = inject<MatDialogRef<ConfirmDialogComponent, boolean>>(MatDialogRef);
  private readonly crypto = inject(CryptoService);
  private readonly passkey = inject(PasskeyService);
  private readonly session = inject(SessionService);

  /** False for the first CONFIRM_ARM_MS after the box was made: the second button is off until it turns true. */
  protected readonly armed = signal(false);

  /** True while the device is asked for the passkey: both buttons are off. */
  protected readonly asking = signal(false);
  /** Why the passkey check did not pass, shown under the notes in red; null before a check and while one runs. Since 2026-11-20 it also holds the reason of a `ready` that was rejected, the read that failed, which shows in the same place. */
  protected readonly passkeyError = signal<string | null>(null);
  /** True while the caller's `ready` has not settled: the second button is off and the moving bar shows. False from the start in a box without `ready`. */
  protected readonly waiting = signal(this.data.ready !== undefined);
  /** True once the caller's `ready` rejected: its reason shows in red and the second button stays off. */
  protected readonly blocked = signal(false);

  constructor() {
    const timer = setTimeout(() => this.armed.set(true), CONFIRM_ARM_MS);
    inject(DestroyRef).onDestroy(() => clearTimeout(timer));
    this.data.ready?.then(
      () => this.waiting.set(false),
      (err: unknown) => {
        this.waiting.set(false);
        this.blocked.set(true);
        this.passkeyError.set(err instanceof Error ? err.message : String(err));
      },
    );
  }

  /** The second button. In a box without `passkey` it closes the box with true. In a box with it, the passkey step runs first, straight from this click: the caller's `approve` when the box was given one (2026-11-20), which builds what is to be signed and asks the passkey for it, and else the wallet's own check (checkSessionPasskey). A box that was closed meanwhile, by a step back in the browser's history, stays closed with no answer. */
  protected async yes(): Promise<void> {
    if (!this.data.passkey) {
      this.ref.close(true);
      return;
    }
    this.asking.set(true);
    this.passkeyError.set(null);
    try {
      if (this.data.approve) await this.data.approve();
      else await checkSessionPasskey({ crypto: this.crypto, passkey: this.passkey, session: this.session }, this.t());
    } catch (err) {
      this.passkeyError.set(err instanceof Error ? err.message : String(err));
      this.asking.set(false);
      return;
    }
    if (this.ref.getState() === MatDialogState.OPEN) this.ref.close(true);
  }
}

/** Opens the box and waits for its answer: true only when it closed with true, by its second button. A click outside the box and the Escape key do nothing (disableClose), and the focus goes to the box itself, not to a button (autoFocus). A step back or forward in the browser's history closes the box too, with no answer (Angular Material's closeOnNavigation, on by default), and askConfirm then answers false, as for the first button; askChoice below answers null for it. */
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

/** Opens the box as askConfirm does and tells its three ways of closing apart (2026-11-17, forclaude/wallet-trade-guide-plan-1.md, decision 25): true when it closed with true, by its second button; false when it closed with false, by its first button; null when it closed with neither, which a step back or forward in the browser's history does. For a box whose first button is an answer of its own, as in the question before the cancel of an escrow trade ("No, I have not paid"): the caller stops on null, so a close without a button is never read as that answer. */
export function askChoice(dialog: MatDialog, data: ConfirmData): Promise<boolean | null> {
  const ref = dialog.open<ConfirmDialogComponent, ConfirmData, boolean>(ConfirmDialogComponent, {
    data,
    disableClose: true,
    autoFocus: 'dialog',
    width: '480px',
    maxWidth: 'calc(100vw - 32px)',
  });
  return firstValueFrom(ref.afterClosed()).then((answer) => (answer === true ? true : answer === false ? false : null));
}
