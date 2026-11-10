import { Component, DestroyRef, Injector, afterNextRender, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatStepper, MatStepperModule } from '@angular/material/stepper';
import { Router } from '@angular/router';
import { IdentityFormComponent, IdentityFormState } from '../components/identity-form.component';
import { CryptoService } from '../services/crypto.service';
import { LanguageService } from '../services/language.service';
import { reasonOf } from '../services/log.service';
import { MasterpodApiService } from '../services/masterpod-api.service';
import { PasskeyService } from '../services/passkey.service';
import { identityIdsOf } from '../services/public-ledger-id';
import { RecoveryService } from '../services/recovery.service';
import { SharesService } from '../services/shares.service';

/** True for a contact email as the masterpod takes it: 3 to 254 characters with an @ that is not first. */
function isContactEmail(value: string): boolean {
  const chars = Array.from(value).length;
  return chars >= 3 && chars <= 254 && value.indexOf('@') > 0;
}

/**
 * The locked-out stepper (wallet spec 12.3, /recover/open). 1. Your birth
 * record: the shared identity form; Next computes the lookup id on this
 * device with identityIdsOf and drops the public ledger id, asks every
 * keyholder at once who owns the lookup id (SharesService.findOwner, the
 * keyholder's /get-owner) and the masterpod for that pod's username
 * (/challenge openCase with the anoPod id; this challenge is never used
 * and expires), then drops the answers. A miss keeps the answers in the
 * form so one field can be fixed and Next pressed again. 2. Your account:
 * "We found your account: <username>" and a contact email. 3. Open my
 * case: /challenge (openCase, the anoPod id) gives a fresh challenge and
 * the username again; the passkey registration with the PRF extension,
 * the anoPod id as user handle and the username as its name; the PRF
 * output from the registration or, when it returned none, one local
 * assertion with a random challenge; KEK_prf; the recovery hybrid pair and
 * hybridKeyBlob; the ephemeral keys; /open-recovery-case, the payload
 * without a username. On 201 the recovery session is open and the page
 * goes to /recover/case.
 */
@Component({
  selector: 'app-recover-open-page',
  imports: [FormsModule, MatStepperModule, MatFormFieldModule, MatInputModule, MatButtonModule, MatCardModule, MatProgressBarModule, IdentityFormComponent],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>{{ t().common.lockedOut }}</mat-card-title>
        <mat-card-subtitle>{{ t().recoverOpen.subtitle }}</mat-card-subtitle>
      </mat-card-header>
      <mat-card-content>
        <mat-stepper linear orientation="vertical" #stepper>
          <mat-step [completed]="anopodId() !== null" [label]="t().recoverOpen.stepRecord">
            <p>{{ t().recoverOpen.recordText }}</p>
            <app-identity-form [state]="form" />
            @if (computing()) {
              <mat-progress-bar mode="indeterminate"></mat-progress-bar>
              <p class="muted">{{ t().recoverOpen.finding }}</p>
            }
            @if (lookupError(); as text) {
              <p class="error">{{ text }}</p>
            }
            @if (anopodId() !== null && !form.complete()) {
              <p class="muted">{{ t().recoverOpen.computed }}</p>
            }
            <button mat-flat-button type="button" (click)="next(stepper)" [disabled]="computing() || (!form.complete() && anopodId() === null)">{{ t().common.next }}</button>
          </mat-step>

          <mat-step [completed]="whoDone()" [label]="t().recoverOpen.stepWho">
            <p>{{ t().recoverOpen.foundAccount(foundUsername()) }}</p>
            <div class="fields">
              <mat-form-field appearance="outline" subscriptSizing="dynamic">
                <mat-label>{{ t().recoverOpen.contactEmail }}</mat-label>
                <input matInput type="email" [ngModel]="email()" (ngModelChange)="email.set($event)" autocomplete="email" />
                <mat-hint>{{ t().recoverOpen.emailHint }}</mat-hint>
              </mat-form-field>
            </div>
            <div>
              <button mat-button type="button" matStepperPrevious>{{ t().common.back }}</button>
              <button mat-flat-button type="button" matStepperNext [disabled]="!whoDone()">{{ t().common.next }}</button>
            </div>
          </mat-step>

          <mat-step [label]="t().recoverOpen.openCase">
            <p>{{ t().recoverOpen.passkeyText }}</p>
            @if (busy()) {
              <mat-progress-bar mode="indeterminate"></mat-progress-bar>
            }
            @if (error(); as text) {
              <p class="error">{{ text }}</p>
            }
            <div>
              <button mat-button type="button" matStepperPrevious [disabled]="busy()">{{ t().common.back }}</button>
              <button mat-flat-button type="button" (click)="open()" [disabled]="busy()">{{ t().recoverOpen.openCase }}</button>
            </div>
          </mat-step>
        </mat-stepper>
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    .fields { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
    mat-form-field { width: 280px; max-width: 100%; }
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
  private readonly shares = inject(SharesService);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  protected readonly form = new IdentityFormState();
  /** What step 1 ends with: the lookup id, the anoPod id the keyholders named for it, and that pod's username from the masterpod. */
  protected readonly lookupId = signal<string | null>(null);
  protected readonly anopodId = signal<string | null>(null);
  protected readonly foundUsername = signal('');
  /** Step 1's work in progress: the lookup id, the keyholders, the masterpod. */
  protected readonly computing = signal(false);
  protected readonly lookupError = signal<string | null>(null);
  protected readonly email = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly whoDone = computed(() => isContactEmail(this.email().trim()));

  constructor() {
    inject(DestroyRef).onDestroy(() => this.form.reset());
  }

  /**
   * Step 1's Next: the lookup id from the answers (scrypt takes well under a
   * second), every keyholder asked who owns it, the masterpod asked for the
   * account's username; found, the answers are dropped and the stepper moves
   * on. Not found, no keyholder reached, or the masterpod refused: the line
   * under the form says so and the answers stay, so one field can be fixed
   * and Next pressed again.
   */
  protected async next(stepper: MatStepper): Promise<void> {
    const answers = this.form.answers();
    if (answers) {
      this.computing.set(true);
      this.lookupError.set(null);
      try {
        // Let the progress bar paint before scrypt blocks the thread.
        await new Promise((resolve) => setTimeout(resolve, 20));
        const ids = identityIdsOf(answers);
        const owner = await this.shares.findOwner(ids.lookupId);
        if (!owner.found) {
          this.lookupError.set(owner.answered > 0 ? this.t().recoverOpen.notFound : this.t().recoverOpen.keyholdersUnreachable);
          return;
        }
        // The account's username. This challenge is never used: CHALLENGE_SECONDS
        // (120) is too short to carry to step 3, and the masterpod sweeps it
        // with the expired ones.
        const challenge = await this.api.challenge('openCase', owner.anopodId);
        if (!challenge.ok) {
          this.lookupError.set(`/challenge: ${reasonOf(challenge)}`);
          return;
        }
        this.lookupId.set(ids.lookupId);
        this.anopodId.set(owner.anopodId);
        this.foundUsername.set(challenge.body.username ?? '');
        this.form.reset();
      } finally {
        this.computing.set(false);
      }
      // The linear stepper only moves once the step's [completed] binding has
      // been rendered true, so wait for that render before asking it to.
      await new Promise<void>((resolve) => afterNextRender(() => resolve(), { injector: this.injector }));
    }
    if (this.anopodId() !== null) stepper.next();
  }

  /** Step 3: the challenge, the recovery passkey named with the username, the PRF output, the hybrid pair, the signed payload, the case. */
  protected async open(): Promise<void> {
    const lookupId = this.lookupId();
    const anopodId = this.anopodId();
    if (!lookupId || !anopodId) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const contactEmail = this.email().trim();
      const challenge = await this.api.challenge('openCase', anopodId);
      if (!challenge.ok) throw new Error(`/challenge: ${reasonOf(challenge)}`);
      if (!challenge.body.anopodId) throw new Error(this.t().recoverOpen.noAnopodId);
      const username = challenge.body.username ?? this.foundUsername();
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
        throw new Error(res.status === 409 ? this.t().recoverOpen.alreadyOpen : `/open-recovery-case: ${reasonOf(res)}`);
      }
      this.recovery.open(res.body.caseId, keys, res.body.status);
      this.recovery.username.set(username);
      this.recovery.contactEmail.set(contactEmail);
      this.recovery.lookupId.set(lookupId);
      this.recovery.setPrfOutput(prf);
      this.recovery.setKekPrf(kek);
      this.recovery.setHybridKeys(hybrid);
      this.lookupId.set(null);
      this.anopodId.set(null);
      this.foundUsername.set('');
      await this.router.navigateByUrl('/recover/case');
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }
}
