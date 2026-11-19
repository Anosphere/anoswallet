import { Component, DestroyRef, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { RouterLink } from '@angular/router';
import { IdentityFormComponent, IdentityFormState } from '../components/identity-form.component';
import { LanguageService } from '../services/language.service';
import { identityIdsOf } from '../services/public-ledger-id';
import { SessionService } from '../services/session.service';

/** The end of an id, the only part of it this page shows: its last 12 characters. The lookup id is made from the first 16 (docs/public-ledger-id.md section 6), so the end gives none of them away. */
function endOf(id: string): string {
  return id.slice(-12);
}

/**
 * The Public ledger id page (wallet spec 8.2; 2026-11-18, section 11), at
 * /account/ledger-id, reached from the Account page's third row: a person
 * types the birth record again and sees whether it gives the public ledger
 * id of their anoPod. Back to Account, two short paragraphs on what the id
 * is and why a person would check it, the end of the id the session holds
 * (the one opened from identityBlob at log-in), the nine-field form of the
 * identity page, and Check. Check makes the id from the answers, as the
 * identity page does, and compares the two whole ids; the page then shows
 * the end of each and says that they are the same or that they are
 * different, between the form and the button, where the locked-out page
 * has its line. It cannot say which answer is off: the answers given at
 * setup were never stored. On a match the answers are dropped; on a miss
 * they stay, so one field can be fixed and Check pressed again; leaving
 * the page drops them. Nothing is sent: no server is asked, and the
 * answers and the id made from them never leave this component's memory.
 */
@Component({
  selector: 'app-account-ledger-id-page',
  imports: [RouterLink, MatCardModule, MatButtonModule, MatIconModule, MatProgressBarModule, IdentityFormComponent],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>{{ t().accountLedgerId.title }}</mat-card-title>
      </mat-card-header>
      <mat-card-content>
        <p><a mat-button routerLink="/account"><mat-icon>arrow_back</mat-icon> {{ t().nav.account }}</a></p>
        @if (mine; as id) {
          <p>{{ t().accountLedgerId.intro1 }}</p>
          <p>{{ t().accountLedgerId.intro2 }}</p>
          <p>{{ t().accountLedgerId.yours }} <code>{{ endOf(id) }}</code></p>
          <app-identity-form [state]="form" />
          @if (computing()) {
            <mat-progress-bar mode="indeterminate"></mat-progress-bar>
          }
          @if (error(); as text) {
            <p class="error">{{ text }}</p>
          }
          @if (result(); as r) {
            <p>{{ t().accountLedgerId.yours }} <code>{{ endOf(id) }}</code></p>
            <p>{{ t().accountLedgerId.typed }} <code>{{ r.typedEnd }}</code></p>
            @if (r.same) {
              <p class="ok">{{ t().accountLedgerId.same }}</p>
            } @else {
              <p class="error">{{ t().accountLedgerId.different }}</p>
            }
          }
          <div class="actions">
            <button mat-flat-button type="button" (click)="check(id)" [disabled]="!form.complete() || computing()">{{ t().accountLedgerId.check }}</button>
          </div>
        } @else {
          <p class="error">{{ t().accountLedgerId.noIdentity }}</p>
        }
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    p { max-width: 640px; }
    /* The app's code style breaks a long id anywhere; here the 12 characters stay together and go to the next line as one piece. */
    code { white-space: nowrap; }
    .actions { display: flex; gap: 8px; margin-top: 12px; }
    .error { color: var(--mat-sys-error); }
    .ok { color: var(--mat-sys-primary); }
  `,
})
export class AccountLedgerIdPage {
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  /** The public ledger id the session holds, 64 hex characters; null when it holds none (a pod that came to this address before its setup). */
  protected readonly mine = inject(SessionService).getIdentity()?.publicLedgerId ?? null;
  protected readonly form = new IdentityFormState();
  protected readonly computing = signal(false);
  protected readonly error = signal<string | null>(null);
  /** The last check: the end of the id made from the answers, and whether the two whole ids are equal. */
  protected readonly result = signal<{ typedEnd: string; same: boolean } | null>(null);
  protected readonly endOf = endOf;

  constructor() {
    // The answers leave the tab's memory when the page is left.
    inject(DestroyRef).onDestroy(() => this.form.reset());
  }

  /** Makes the id from the answers (scrypt takes well under a second) and compares it with the session's, whole id against whole id. A match drops the answers; a miss keeps them. */
  protected async check(mine: string): Promise<void> {
    const answers = this.form.answers();
    if (!answers) return;
    this.computing.set(true);
    this.error.set(null);
    this.result.set(null);
    try {
      // Let the progress bar paint before scrypt blocks the thread.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const typed = identityIdsOf(answers).publicLedgerId;
      const same = typed === mine;
      if (same) this.form.reset();
      this.result.set({ typedEnd: endOf(typed), same });
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.computing.set(false);
    }
  }
}
