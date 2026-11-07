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
 * The landing page (wallet spec 8.2): the test-site notice (English, then
 * Thai) above the card, then Unlock, Create account, Recover account.
 * Unlock: /challenge (unlock), the passkey assertion with the PRF
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
    <div class="notice">
      <mat-icon class="notice-icon" aria-hidden="true">warning</mat-icon>
      <div>
        <p class="notice-headline">{{ t().landing.noticeHeadline }}</p>
        <p class="notice-text" lang="en">There are no real Anos here, do not pay money to anyone in order to buy Anos. This is for testing purposes only.</p>
        <p class="notice-text" lang="th">นี่เป็นเพียงเว็บไซต์ทดสอบเท่านั้น ไม่มี Anos จริงอยู่ที่นี่ อย่าจ่ายเงินให้ใครเพื่อซื้อ Anos เว็บไซต์นี้มีไว้เพื่อการทดสอบเท่านั้น</p>
      </div>
    </div>
    <mat-card appearance="outlined" class="landing">
      <mat-card-header>
        <mat-card-title>{{ t().landing.title }}</mat-card-title>
        <mat-card-subtitle>{{ t().landing.subtitle }}</mat-card-subtitle>
      </mat-card-header>
      <mat-card-content>
        @if (busy()) {
          <mat-progress-bar mode="indeterminate"></mat-progress-bar>
          <p>{{ t().landing.unlocking }}</p>
        } @else if (error(); as text) {
          <p class="error">{{ text }}</p>
          <p>{{ t().landing.noPasskey }}</p>
        }
      </mat-card-content>
      <mat-card-actions class="actions">
        <button mat-flat-button type="button" (click)="unlock()" [disabled]="busy()">{{ t().landing.unlock }}</button>
        <a mat-stroked-button routerLink="/create" [class.disabled]="busy()">{{ t().landing.create }}</a>
        <a mat-button routerLink="/recover">{{ t().landing.recover }}</a>
      </mat-card-actions>
    </mat-card>
    @if (lang.language() === 'th') {
      <p class="switch"><button mat-button type="button" (click)="lang.useEnglish()">Switch to English</button></p>
    }
  `,
  styles: `
    .notice { display: flex; gap: 16px; align-items: flex-start; margin: 8px 0 0; padding: 20px 24px; border-radius: 12px; background: var(--mat-sys-error-container); color: var(--mat-sys-on-error-container); }
    .notice-icon { flex: none; font-size: 40px; width: 40px; height: 40px; }
    .notice-headline { margin: 0 0 8px; font-size: 1.75rem; font-weight: 700; line-height: 1.2; }
    .notice-text { margin: 0 0 8px; font-size: 1.125rem; line-height: 1.5; }
    .notice-text:last-child { margin-bottom: 0; }
    .landing { max-width: 560px; margin: 24px auto; }
    .switch { text-align: center; margin: 0 0 24px; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; padding: 16px; }
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
