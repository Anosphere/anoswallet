import { Component, DestroyRef, Injector, afterNextRender, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatStepper, MatStepperModule } from '@angular/material/stepper';
import { Router } from '@angular/router';
import { IdentityFormComponent, IdentityFormState } from '../components/identity-form.component';
import { USERNAME_DEBOUNCE_MS } from '../constants';
import { CryptoService } from '../services/crypto.service';
import { reasonOf } from '../services/log.service';
import { MasterpodApiService } from '../services/masterpod-api.service';
import { PasskeyService } from '../services/passkey.service';
import { identityIdsOf } from '../services/public-ledger-id';
import { RecoveryService } from '../services/recovery.service';

/** True for a contact email as the masterpod takes it: 3 to 254 characters with an @ that is not first. */
function isContactEmail(value: string): boolean {
  const chars = Array.from(value).length;
  return chars >= 3 && chars <= 254 && value.indexOf('@') > 0;
}

/**
 * The locked-out stepper (wallet spec 12.3, /recover/open). 1. Your birth
 * record: the shared identity form; Next computes the lookup id on this
 * device with identityIdsOf and drops the public ledger id and the answers.
 * 2. Who you are: the username (lowercased; /check-username's "taken" means
 * found) and a contact email. 3. Open my case: /challenge (openCase, the
 * username) gives the challenge and the pod's id; the passkey registration
 * with the PRF extension and that id as user handle; the PRF output from
 * the registration or, when it returned none, one local assertion with a
 * random challenge; KEK_prf; the recovery hybrid pair and hybridKeyBlob;
 * the ephemeral keys; /open-recovery-case. On 201 the recovery session is
 * open and the page goes to /recover/case.
 */
@Component({
  selector: 'app-recover-open-page',
  imports: [FormsModule, MatStepperModule, MatFormFieldModule, MatInputModule, MatButtonModule, MatCardModule, MatProgressBarModule, IdentityFormComponent],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>I'm locked out</mat-card-title>
        <mat-card-subtitle>Open a recovery case</mat-card-subtitle>
      </mat-card-header>
      <mat-card-content>
        <mat-stepper linear orientation="vertical" #stepper>
          <mat-step [completed]="lookupId() !== null" label="Your birth record">
            <p>We turn this into the same lookup id you made at setup, on this device; nothing you type is sent.</p>
            <app-identity-form [state]="form" />
            @if (computing()) {
              <mat-progress-bar mode="indeterminate"></mat-progress-bar>
            }
            @if (lookupId() !== null && !form.complete()) {
              <p class="muted">Your lookup id is computed and the answers are dropped. Fill the form in again to compute it afresh.</p>
            }
            <button mat-flat-button type="button" (click)="next(stepper)" [disabled]="computing() || (!form.complete() && lookupId() === null)">Next</button>
          </mat-step>

          <mat-step [completed]="whoDone()" label="Who you are">
            <div class="fields">
              <mat-form-field appearance="outline">
                <mat-label>Username</mat-label>
                <input matInput [ngModel]="username()" (ngModelChange)="username.set($event)" autocomplete="username" />
                <mat-hint>{{ usernameHint() }}</mat-hint>
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>Contact email</mat-label>
                <input matInput type="email" [ngModel]="email()" (ngModelChange)="email.set($event)" autocomplete="email" />
                <mat-hint>Where a moderator can reach you. Nothing is sent by itself.</mat-hint>
              </mat-form-field>
            </div>
            <div>
              <button mat-button type="button" matStepperPrevious>Back</button>
              <button mat-flat-button type="button" matStepperNext [disabled]="!whoDone()">Next</button>
            </div>
          </mat-step>

          <mat-step label="Open my case">
            <p>
              Your recovery passkey is created now, with this device's screen lock or biometrics. Keep this device: you unlock your case
              with that passkey while the recovery runs.
            </p>
            @if (busy()) {
              <mat-progress-bar mode="indeterminate"></mat-progress-bar>
            }
            @if (error(); as text) {
              <p class="error">{{ text }}</p>
            }
            <div>
              <button mat-button type="button" matStepperPrevious [disabled]="busy()">Back</button>
              <button mat-flat-button type="button" (click)="open()" [disabled]="busy()">Open my case</button>
            </div>
          </mat-step>
        </mat-stepper>
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    .fields { display: flex; flex-wrap: wrap; gap: 8px; }
    mat-form-field { min-width: 280px; }
    .muted { color: var(--mat-sys-on-surface-variant); }
    .error { color: var(--mat-sys-error); }
    button + button { margin-left: 8px; }
  `,
})
export class RecoverOpenPage {
  private readonly api = inject(MasterpodApiService);
  private readonly crypto = inject(CryptoService);
  private readonly passkey = inject(PasskeyService);
  private readonly recovery = inject(RecoveryService);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);

  protected readonly form = new IdentityFormState();
  protected readonly lookupId = signal<string | null>(null);
  protected readonly computing = signal(false);
  protected readonly username = signal('');
  protected readonly usernameHint = signal('the username of the anoPod you lost');
  protected readonly usernameFound = signal(false);
  protected readonly email = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly whoDone = computed(() => this.usernameFound() && isContactEmail(this.email().trim()));

  constructor() {
    // The username lookup, debounced 400 ms, as typed: "taken" means found here.
    let timer: ReturnType<typeof setTimeout> | null = null;
    effect(() => {
      const typed = this.username().trim().toLowerCase();
      untracked(() => {
        this.usernameFound.set(false);
        if (timer) clearTimeout(timer);
        if (typed === '') {
          this.usernameHint.set('the username of the anoPod you lost');
          return;
        }
        this.usernameHint.set('checking…');
        timer = setTimeout(() => void this.checkUsername(typed), USERNAME_DEBOUNCE_MS);
      });
    });
    inject(DestroyRef).onDestroy(() => {
      if (timer) clearTimeout(timer);
      this.form.reset();
    });
  }

  private async checkUsername(typed: string): Promise<void> {
    const res = await this.api.checkUsername(typed, true);
    if (this.username().trim().toLowerCase() !== typed) return;
    if (!res.ok) {
      this.usernameHint.set(reasonOf(res));
      return;
    }
    this.usernameFound.set(!res.body.available);
    this.usernameHint.set(res.body.available ? 'no anoPod has that username' : `${res.body.username} found`);
  }

  /** Step 1's Next: the lookup id from the answers (scrypt takes well under a second), the answers dropped. */
  protected async next(stepper: MatStepper): Promise<void> {
    const answers = this.form.answers();
    if (answers) {
      this.computing.set(true);
      this.error.set(null);
      try {
        // Let the progress bar paint before scrypt blocks the thread.
        await new Promise((resolve) => setTimeout(resolve, 20));
        const ids = identityIdsOf(answers);
        this.lookupId.set(ids.lookupId);
        this.form.reset();
      } finally {
        this.computing.set(false);
      }
      // The linear stepper only moves once the step's [completed] binding has
      // been rendered true, so wait for that render before asking it to.
      await new Promise<void>((resolve) => afterNextRender(() => resolve(), { injector: this.injector }));
    }
    if (this.lookupId() !== null) stepper.next();
  }

  /** Step 3: the challenge, the recovery passkey, the PRF output, the hybrid pair, the signed payload, the case. */
  protected async open(): Promise<void> {
    const lookupId = this.lookupId();
    if (!lookupId) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const username = this.username().trim().toLowerCase();
      const contactEmail = this.email().trim();
      const challenge = await this.api.challenge('openCase', username);
      if (!challenge.ok) throw new Error(challenge.status === 404 ? 'No anoPod has that username' : `/challenge: ${reasonOf(challenge)}`);
      if (!challenge.body.anopodId) throw new Error('/challenge answered no anopodId');
      const registration = await this.passkey.register(challenge.body.challenge, challenge.body.anopodId, username, username);
      let prf = registration.prfOutput;
      if (!prf) {
        // The authenticator gave no PRF output at registration: one local assertion with a random challenge gets it.
        prf = (await this.passkey.assert(this.crypto.randomHex(32))).prfOutput;
      }
      const kek = await this.crypto.deriveKekPrf(prf);
      const hybrid = this.crypto.generateHybridKeys();
      const hybridKeyBlob = await this.crypto.wrapHybridPrivateKey(hybrid, kek);
      const keys = this.crypto.generateSessionKeys();
      const payload = {
        anopodId: challenge.body.anopodId,
        challenge: challenge.body.challenge,
        username,
        lookupId,
        contactEmail,
        passkey: registration.passkey,
        hybridKey: this.crypto.hybridPublicKeyOf(hybrid),
        hybridKeyBlob: this.crypto.toHex(hybridKeyBlob),
        ephemeralAuthKey: this.crypto.toHex(keys.ecdsa.publicKey),
        ephemeralAuthKeyPq: this.crypto.toHex(keys.mldsa.publicKey),
      };
      const res = await this.api.openRecoveryCase({ payload, signatures: this.crypto.signPayload(keys, payload) });
      if (!res.ok) {
        throw new Error(res.status === 409 ? 'A case is already open for this identity' : `/open-recovery-case: ${reasonOf(res)}`);
      }
      this.recovery.open(res.body.caseId, keys, res.body.status);
      this.recovery.username.set(username);
      this.recovery.contactEmail.set(contactEmail);
      this.recovery.lookupId.set(lookupId);
      this.recovery.setPrfOutput(prf);
      this.recovery.setKekPrf(kek);
      this.recovery.setHybridKeys(hybrid);
      this.lookupId.set(null);
      await this.router.navigateByUrl('/recover/case');
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }
}
