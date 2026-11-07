import { Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { Router, RouterLink } from '@angular/router';
import { CryptoService } from '../services/crypto.service';
import { LanguageService } from '../services/language.service';
import { ApiError, reasonOf } from '../services/log.service';
import { MasterpodApiService } from '../services/masterpod-api.service';
import { PasskeyService } from '../services/passkey.service';
import { CaseStatus, RecoveryService } from '../services/recovery.service';

/**
 * /recover (wallet spec 12.3): two cards. "I'm locked out" starts the
 * locked-out stepper at /recover/open. "Continue a recovery" unlocks the
 * recovery pod with the passkey made at case open: /challenge (unlockCase),
 * the passkey assertion with the PRF salt, /unlock-recovery-pod, KEK_prf
 * from the PRF output, hybridKeyBlob opened, then /recover/case. The
 * platform's picker shows the passkeys; with none the authenticator's
 * message shows.
 */
@Component({
  selector: 'app-recover-page',
  imports: [MatCardModule, MatButtonModule, MatProgressBarModule, RouterLink],
  template: `
    <div class="cards">
      <mat-card appearance="outlined" class="card">
        <mat-card-header><mat-card-title>{{ t().common.lockedOut }}</mat-card-title></mat-card-header>
        <mat-card-content>
          <p>{{ t().recover.lockedOutText }}</p>
        </mat-card-content>
        <mat-card-actions class="actions">
          <a mat-flat-button routerLink="/recover/open" [class.disabled]="busy()">{{ t().common.start }}</a>
        </mat-card-actions>
      </mat-card>

      <mat-card appearance="outlined" class="card">
        <mat-card-header><mat-card-title>{{ t().recover.continueTitle }}</mat-card-title></mat-card-header>
        <mat-card-content>
          <p>{{ t().recover.continueText }}</p>
          @if (busy()) {
            <mat-progress-bar mode="indeterminate"></mat-progress-bar>
            <p>{{ t().recover.unlocking }}</p>
          } @else if (error(); as text) {
            <p class="error">{{ text }}</p>
          }
        </mat-card-content>
        <mat-card-actions class="actions">
          <button mat-flat-button type="button" (click)="continue()" [disabled]="busy()">{{ t().common.continue }}</button>
        </mat-card-actions>
      </mat-card>
    </div>
    <div class="back"><a mat-button routerLink="/">{{ t().common.back }}</a></div>
  `,
  styles: `
    .cards { display: flex; flex-wrap: wrap; gap: 16px; max-width: 1000px; margin: 24px auto 0; }
    .card { flex: 1 1 360px; }
    .actions { padding: 16px; }
    .back { max-width: 1000px; margin: 8px auto; }
    .error { color: var(--mat-sys-error); }
  `,
})
export class RecoverPage {
  private readonly api = inject(MasterpodApiService);
  private readonly crypto = inject(CryptoService);
  private readonly passkey = inject(PasskeyService);
  private readonly recovery = inject(RecoveryService);
  private readonly router = inject(Router);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  /** The unlockCase flow: a challenge, the assertion with the PRF salt, fresh keys, the signed payload, the blob opened. */
  protected async continue(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const challenge = await this.api.challenge('unlockCase');
      if (!challenge.ok) throw new Error(`/challenge: ${reasonOf(challenge)}`);
      const { assertion, prfOutput } = await this.passkey.assert(challenge.body.challenge);
      const keys = this.crypto.generateSessionKeys();
      const payload = {
        challenge: challenge.body.challenge,
        assertion,
        ephemeralAuthKey: this.crypto.toHex(keys.ecdsa.publicKey),
        ephemeralAuthKeyPq: this.crypto.toHex(keys.mldsa.publicKey),
      };
      const res = await this.api.unlockRecoveryPod({ payload, signatures: this.crypto.signPayload(keys, payload) });
      if (!res.ok) {
        const reason = (res.body as unknown as Partial<ApiError>)?.error;
        if (res.status === 401 && reason === 'unknown passkey') {
          throw new Error(this.t().recover.noCase);
        }
        throw new Error(`/unlock-recovery-pod: ${reasonOf(res)}`);
      }
      const kek = await this.crypto.deriveKekPrf(prfOutput);
      const hybrid = await this.crypto.unwrapHybridPrivateKey(this.crypto.fromHex(res.body.hybridKeyBlob), kek);
      this.recovery.open(res.body.caseId, keys, res.body.status as CaseStatus);
      this.recovery.setPrfOutput(prfOutput);
      this.recovery.setKekPrf(kek);
      this.recovery.setHybridKeys(hybrid);
      await this.router.navigateByUrl('/recover/case');
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }
}
