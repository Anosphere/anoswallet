import { Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { Router } from '@angular/router';
import { IdentityFormComponent, IdentityFormState, TEXT_FIELDS } from '../components/identity-form.component';
import { LanguageService } from '../services/language.service';
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
        <mat-card-title>{{ t().identity.title }}</mat-card-title>
        <mat-card-subtitle>
          @switch (pane()) {
            @case ('why') { {{ t().identity.whySubtitle }} }
            @case ('form') { {{ t().identity.formSubtitle }} }
            @case ('review') { {{ t().identity.reviewSubtitle }} }
          }
        </mat-card-subtitle>
      </mat-card-header>
      <mat-card-content>
        @switch (pane()) {
          @case ('why') {
            <ul class="why">
              <li>{{ t().identity.why1 }}</li>
              <li>{{ t().identity.why2 }}</li>
              <li>{{ t().identity.why3 }}</li>
              <li>{{ t().identity.why4 }}</li>
              <li>{{ t().identity.why5 }}</li>
              <li>{{ t().identity.why6 }}</li>
              <li>{{ t().identity.why7 }}</li>
            </ul>
            <mat-checkbox [checked]="understood()" (change)="understood.set($event.checked)">{{ t().identity.understood }}</mat-checkbox>
            <div class="actions">
              <button mat-flat-button type="button" (click)="pane.set('form')" [disabled]="!understood()">{{ t().common.continue }}</button>
            </div>
          }
          @case ('form') {
            <app-identity-form [state]="form" />
            <div class="actions">
              <button mat-button type="button" (click)="pane.set('why')">{{ t().common.back }}</button>
              <button mat-flat-button type="button" (click)="pane.set('review')" [disabled]="!form.complete()">{{ t().identity.submit }}</button>
            </div>
          }
          @case ('review') {
            <p class="warning">{{ t().identity.warning }}</p>
            <table class="review">
              @for (field of textFields; track field.key) {
                <tr><th>{{ t().identityForm.fields[field.key] }}</th><td>{{ form.unknown()[field.key] ? t().identityForm.unknown : form.texts()[field.key] }}</td></tr>
              }
              <tr><th>{{ t().identityForm.country }}</th><td>{{ form.countryName() }}</td></tr>
              <tr><th>{{ t().identityForm.date }}</th><td>{{ form.dateText() }}</td></tr>
            </table>
            @if (computing()) {
              <mat-progress-bar mode="indeterminate"></mat-progress-bar>
            }
            @if (error(); as text) {
              <p class="error">{{ text }}</p>
            }
            <div class="actions">
              <button mat-button type="button" (click)="pane.set('form')" [disabled]="computing()">{{ t().identity.edit }}</button>
              <button mat-flat-button type="button" (click)="confirm()" [disabled]="computing()">{{ t().identity.allCorrect }}</button>
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
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

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
