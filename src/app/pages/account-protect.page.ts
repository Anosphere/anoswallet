import { Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatRadioModule } from '@angular/material/radio';
import { Router, RouterLink } from '@angular/router';
import { ADVANCED_PROTECTION_URL } from '../constants';
import { LanguageService } from '../services/language.service';
import { SettingsService } from '../services/settings.service';

/**
 * The Protect your passkey page (wallet spec 8.2; 2026-11-07, section 11),
 * at /account/protect: the setup pane again, for someone who skipped it,
 * reached from Home's Things to do on an Android phone; the same lines,
 * the button to Google's page, the two choices, and Save, which records
 * the answer in the wallet settings (settings.service) and goes to Home.
 */
@Component({
  selector: 'app-account-protect-page',
  imports: [RouterLink, MatCardModule, MatButtonModule, MatIconModule, MatRadioModule],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>{{ t().common.protectTitle }}</mat-card-title>
      </mat-card-header>
      <mat-card-content>
        <p><a mat-button routerLink="/home"><mat-icon>arrow_back</mat-icon> {{ t().nav.home }}</a></p>
        <p><strong>{{ t().common.protectRecommended }}</strong> {{ t().common.protectBenefits }}</p>
        <p>{{ t().common.protectWhy }}</p>
        <p>{{ t().common.protectWhat }}</p>
        <p>{{ t().common.protectCaution }}</p>
        <a mat-flat-button [href]="advancedProtectionUrl" target="_blank" rel="noopener">{{ t().common.protectOpen }}</a>
        <p>{{ t().common.protectThen }}</p>
        <mat-radio-group class="choices" [value]="choice()" (change)="choice.set($event.value)">
          <mat-radio-button value="done">{{ t().common.protectDone }}</mat-radio-button>
          <mat-radio-button value="skip">{{ t().common.protectSkip }}</mat-radio-button>
        </mat-radio-group>
        <button mat-flat-button type="button" (click)="save()" [disabled]="busy() || !choice()">{{ t().common.save }}</button>
        @if (error(); as text) {
          <p class="error">{{ text }}</p>
        }
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    .choices { display: flex; flex-direction: column; gap: 4px; margin: 8px 0 16px; }
    .error { color: var(--mat-sys-error); }
  `,
})
export class AccountProtectPage {
  private readonly settings = inject(SettingsService);
  private readonly router = inject(Router);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  protected readonly advancedProtectionUrl = ADVANCED_PROTECTION_URL;
  /** The choice; Save is off until one is picked. */
  protected readonly choice = signal<'done' | 'skip' | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  /** The answer into the wallet settings, then Home; a refusal in red. */
  protected async save(): Promise<void> {
    const choice = this.choice();
    if (!choice) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.settings.save({ protect: choice === 'done' ? 'on' : 'skipped' });
      await this.router.navigateByUrl('/home');
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }
}
