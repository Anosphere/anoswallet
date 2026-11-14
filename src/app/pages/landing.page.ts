import { Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { Router, RouterLink } from '@angular/router';
import { CryptoService } from '../services/crypto.service';
import { LanguageService } from '../services/language.service';
import { MasterpodApiService } from '../services/masterpod-api.service';
import { PasskeyService } from '../services/passkey.service';
import { SessionService } from '../services/session.service';
import { unlockWithPasskey } from '../unlock';

/**
 * The landing page (wallet spec 8.2): Unlock, Create account, Recover
 * account. Unlock: /challenge (unlock), the passkey assertion with the PRF
 * salt, /unlock; opens blob1, chatPrivateKeyBlob and identityBlob; then
 * /check-anopod-status and the next-step rule. The platform's passkey
 * picker is what says whether a passkey exists; with none, the
 * authenticator's own message shows and the page suggests Create. In
 * Thai, the button Switch to English under the card (wallet spec 8.8).
 */
@Component({
  selector: 'app-landing-page',
  imports: [MatCardModule, MatButtonModule, MatIconModule, MatProgressBarModule, RouterLink],
  template: `
    <mat-card appearance="outlined" class="landing">
      <mat-card-content class="body">
        <img class="logo" src="logo.png" width="72" height="72" alt="anoPod" />
        <h1 class="title">{{ t().landing.title }}</h1>
        <p class="subtitle">{{ t().landing.subtitle }}</p>
        @if (busy()) {
          <mat-progress-bar mode="indeterminate"></mat-progress-bar>
          <p>{{ t().landing.unlocking }}</p>
        } @else if (error(); as text) {
          <p class="error">{{ text }}</p>
          <p>{{ t().landing.noPasskey }}</p>
        }
        <div class="actions">
          <button mat-flat-button type="button" (click)="unlock()" [disabled]="busy()"><mat-icon>fingerprint</mat-icon>{{ t().landing.unlock }}</button>
          <a mat-stroked-button routerLink="/create" [class.disabled]="busy()">{{ t().landing.create }}</a>
        </div>
        <p class="recover">{{ t().landing.lostPasskey }} <a routerLink="/recover">{{ t().common.recoverAccount }}</a></p>
      </mat-card-content>
    </mat-card>
    @if (lang.language() === 'th') {
      <p class="switch"><button mat-button type="button" (click)="lang.useEnglish()">Switch to English</button></p>
    }
  `,
  styles: `
    .landing { max-width: 560px; margin: 24px auto; }
    .landing .body { padding: 40px 24px 24px; text-align: center; }
    .logo { display: block; margin: 0 auto; object-fit: contain; }
    .title { margin: 16px 0 8px; font-size: 1.75rem; font-weight: 500; line-height: 1.3; }
    .subtitle { margin: 0; font-size: 1rem; line-height: 1.5; color: var(--mat-sys-on-surface-variant); text-wrap: balance; }
    .subtitle:lang(th) { text-wrap: pretty; }
    mat-progress-bar, .error { margin-top: 24px; }
    .switch { text-align: center; margin: 0 0 24px; }
    .actions { display: flex; flex-direction: column; gap: 12px; margin-top: 28px; }
    .actions button, .actions a { height: 48px; font-size: 1rem; }
    .actions mat-icon { font-size: 20px; width: 20px; height: 20px; }
    .recover { margin: 20px 0 0; font-size: 0.875rem; color: var(--mat-sys-on-surface-variant); }
    .recover a { padding: 12px 0; color: var(--mat-sys-primary); font-weight: 500; text-decoration: none; }
    .recover a:hover, .recover a:focus-visible { text-decoration: underline; }
    .error { color: var(--mat-sys-error); }
  `,
})
export class LandingPage {
  private readonly api = inject(MasterpodApiService);
  private readonly crypto = inject(CryptoService);
  private readonly passkey = inject(PasskeyService);
  private readonly session = inject(SessionService);
  private readonly router = inject(Router);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected async unlock(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const status = await unlockWithPasskey({ api: this.api, crypto: this.crypto, passkey: this.passkey, session: this.session });
      // An unlock with everything done lands on Home; the rule's own answer
      // stays Wallet, so the setup steps end there (wallet spec 8.1).
      const next = this.session.nextStep(status);
      await this.router.navigateByUrl(next === '/wallet' ? '/home' : next);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }
}
