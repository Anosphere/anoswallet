import { Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { Router } from '@angular/router';
import { IdentityFormComponent, IdentityFormState, TEXT_FIELDS } from '../components/identity-form.component';
import { identityIdsOf } from '../services/public-ledger-id';
import { SessionService } from '../services/session.service';

type Pane = 'why' | 'form' | 'review';

/**
 * The identity page (wallet spec 8.2, docs/public-ledger-id.md): three
 * panes. Why: the plain-English explanation and the checkbox. The form: the
 * nine fields (the shared identity form component, 12.4), Known / Unknown
 * beside the five that allow it, a country select, a date picker. Review:
 * every answer as given; "All information is correct" computes the PLID and
 * the lookup id, drops the answers, and goes to /setup. The answers never
 * leave this component's memory.
 */
@Component({
  selector: 'app-identity-page',
  imports: [MatCardModule, MatButtonModule, MatCheckboxModule, MatProgressBarModule, IdentityFormComponent],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>Your public ledger id</mat-card-title>
        <mat-card-subtitle>
          @switch (pane()) {
            @case ('why') { Why we ask, before you type anything }
            @case ('form') { Your birth record }
            @case ('review') { Check every answer }
          }
        </mat-card-subtitle>
      </mat-card-header>
      <mat-card-content>
        @switch (pane()) {
          @case ('why') {
            <ul class="why">
              <li>Step 6 of setup is your public ledger id.</li>
              <li>We do not store what you type.</li>
              <li>It is turned into a one-way hash on your device.</li>
              <li>The hash is kept encrypted by independent keyholders, not in our database.</li>
              <li>It exists so you, or one day your heirs, can prove this identity made this account after a complete lockout, and recover the account and its anos.</li>
              <li>It cannot be deleted, by anyone, ever, and you have to know that before you go on.</li>
              <li>A very sophisticated attack could leak a hash of your birth record, and there are far easier ways to learn a birthday or a maiden name.</li>
            </ul>
            <mat-checkbox [checked]="understood()" (change)="understood.set($event.checked)">I understand this record can never be deleted</mat-checkbox>
            <div class="actions">
              <button mat-flat-button type="button" (click)="pane.set('form')" [disabled]="!understood()">Continue</button>
            </div>
          }
          @case ('form') {
            <app-identity-form [state]="form" />
            <div class="actions">
              <button mat-button type="button" (click)="pane.set('why')">Back</button>
              <button mat-flat-button type="button" (click)="pane.set('review')" [disabled]="!form.complete()">Submit</button>
            </div>
          }
          @case ('review') {
            <p class="warning">
              Check that everything is right. If this is wrong, you may not be able to recover after a complete lockout, and your heirs
              may fail to recover it in the future.
            </p>
            <table class="review">
              @for (field of textFields; track field.key) {
                <tr><th>{{ field.label }}</th><td>{{ form.unknown()[field.key] ? 'Unknown' : form.texts()[field.key] }}</td></tr>
              }
              <tr><th>Country of birth</th><td>{{ form.countryName() }}</td></tr>
              <tr><th>Date of birth</th><td>{{ form.dateText() }}</td></tr>
            </table>
            @if (computing()) {
              <mat-progress-bar mode="indeterminate"></mat-progress-bar>
            }
            @if (error(); as text) {
              <p class="error">{{ text }}</p>
            }
            <div class="actions">
              <button mat-button type="button" (click)="pane.set('form')" [disabled]="computing()">Edit</button>
              <button mat-flat-button type="button" (click)="confirm()" [disabled]="computing()">All information is correct</button>
            </div>
          }
        }
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    .why { line-height: 1.6; }
    .warning { max-width: 720px; color: var(--mat-sys-error); font-weight: 500; }
    .actions { display: flex; gap: 8px; margin-top: 12px; }
    .review th { text-align: left; padding: 4px 16px 4px 0; color: var(--mat-sys-on-surface-variant); }
    .review td { padding: 4px 0; }
    .error { color: var(--mat-sys-error); }
  `,
})
export class IdentityPage {
  private readonly session = inject(SessionService);
  private readonly router = inject(Router);

  protected readonly textFields = TEXT_FIELDS;
  protected readonly form = new IdentityFormState();
  protected readonly pane = signal<Pane>('why');
  protected readonly understood = signal(false);
  protected readonly computing = signal(false);
  protected readonly error = signal<string | null>(null);

  /** Computes the two ids (scrypt takes well under a second), drops the answers, goes to /setup. */
  protected async confirm(): Promise<void> {
    const answers = this.form.answers();
    if (!answers) return;
    this.computing.set(true);
    this.error.set(null);
    try {
      // Let the progress bar paint before scrypt blocks the thread.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const ids = identityIdsOf(answers);
      this.session.setIdentity({ publicLedgerId: ids.publicLedgerId, lookupId: ids.lookupId });
      this.dropAnswers();
      await this.router.navigateByUrl('/setup');
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.computing.set(false);
    }
  }

  private dropAnswers(): void {
    this.form.reset();
    this.pane.set('why');
    this.understood.set(false);
  }
}
