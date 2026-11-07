import { Component, DestroyRef, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatStepperModule } from '@angular/material/stepper';
import { Router } from '@angular/router';
import { CameraComponent, Photo } from '../components/camera.component';
import { USERNAME_DEBOUNCE_MS } from '../constants';
import { CryptoService } from '../services/crypto.service';
import { LanguageService } from '../services/language.service';
import { reasonOf } from '../services/log.service';
import { MasterpodApiService } from '../services/masterpod-api.service';
import { PasskeyService } from '../services/passkey.service';
import { SessionService } from '../services/session.service';

/**
 * The create stepper (wallet spec 8.2): names, a username checked as typed,
 * the selfie, then one button: /challenge (create), the passkey registration
 * with the PRF extension, the two ephemeral keys, /create-anopod. On 201 the
 * session is open and Continue goes to /vouching. If the registration
 * returned a PRF output it is kept; otherwise setup will unlock first.
 */
@Component({
  selector: 'app-create-page',
  imports: [FormsModule, MatStepperModule, MatFormFieldModule, MatInputModule, MatButtonModule, MatCardModule, MatProgressBarModule, CameraComponent],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header><mat-card-title>{{ t().create.title }}</mat-card-title></mat-card-header>
      <mat-card-content>
        <mat-stepper linear orientation="vertical" #stepper>
          <mat-step [completed]="namesDone()" [label]="t().create.stepName">
            <p>{{ t().create.intro }}</p>
            <div class="fields">
              <mat-form-field appearance="outline">
                <mat-label>{{ t().create.firstName }}</mat-label>
                <input matInput [ngModel]="firstName()" (ngModelChange)="firstName.set($event)" autocomplete="given-name" />
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>{{ t().create.lastName }}</mat-label>
                <input matInput [ngModel]="lastName()" (ngModelChange)="lastName.set($event)" autocomplete="family-name" />
              </mat-form-field>
            </div>
            <button mat-flat-button type="button" matStepperNext [disabled]="!namesDone()">{{ t().common.next }}</button>
          </mat-step>

          <mat-step [completed]="usernameAvailable()" [label]="t().create.stepUsername">
            <mat-form-field appearance="outline">
              <mat-label>{{ t().common.username }}</mat-label>
              <input matInput [ngModel]="username()" (ngModelChange)="username.set($event)" autocomplete="username" [placeholder]="t().create.usernamePlaceholder" />
              <mat-hint>{{ usernameHint() }}</mat-hint>
            </mat-form-field>
            <div>
              <button mat-button type="button" matStepperPrevious>{{ t().common.back }}</button>
              <button mat-flat-button type="button" matStepperNext [disabled]="!usernameAvailable()">{{ t().common.next }}</button>
            </div>
          </mat-step>

          <mat-step [completed]="selfie() !== null" [label]="t().common.selfieStep">
            <p>{{ t().create.selfieHint }}</p>
            @if (stepper.selectedIndex === 2) {
              <app-camera quality="normal" (photo)="selfie.set($event)" (cleared)="selfie.set(null)" />
            }
            <div>
              <button mat-button type="button" matStepperPrevious>{{ t().common.back }}</button>
              <button mat-flat-button type="button" matStepperNext [disabled]="selfie() === null">{{ t().common.next }}</button>
            </div>
          </mat-step>

          <mat-step [label]="t().common.create">
            @if (created()) {
              <p>{{ t().create.created }}</p>
              <button mat-flat-button type="button" (click)="continue()">{{ t().common.continue }}</button>
            } @else {
              <p>{{ t().create.passkeyHint }}</p>
              @if (busy()) {
                <mat-progress-bar mode="indeterminate"></mat-progress-bar>
              }
              @if (error(); as text) {
                <p class="error">{{ text }}</p>
              }
              <div>
                <button mat-button type="button" matStepperPrevious [disabled]="busy()">{{ t().common.back }}</button>
                <button mat-flat-button type="button" (click)="create()" [disabled]="busy()">{{ t().create.createButton }}</button>
              </div>
            }
          </mat-step>
        </mat-stepper>
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    .fields { display: flex; flex-wrap: wrap; gap: 8px; }
    mat-form-field { min-width: 260px; }
    .error { color: var(--mat-sys-error); }
    button + button { margin-left: 8px; }
  `,
})
export class CreatePage {
  private readonly api = inject(MasterpodApiService);
  private readonly crypto = inject(CryptoService);
  private readonly passkey = inject(PasskeyService);
  private readonly session = inject(SessionService);
  private readonly router = inject(Router);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  protected readonly firstName = signal('');
  protected readonly lastName = signal('');
  protected readonly username = signal('');
  protected readonly usernameHint = signal(this.t().create.usernameRule);
  protected readonly usernameAvailable = signal(false);
  protected readonly selfie = signal<Photo | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly created = signal(false);

  protected namesDone(): boolean {
    return this.firstName().trim() !== '' && this.lastName().trim() !== '';
  }

  constructor() {
    // The username check, debounced 400 ms, as typed.
    let timer: ReturnType<typeof setTimeout> | null = null;
    effect(() => {
      const typed = this.username().trim().toLowerCase();
      untracked(() => {
        this.usernameAvailable.set(false);
        if (timer) clearTimeout(timer);
        if (typed === '') {
          this.usernameHint.set(this.t().create.usernameRule);
          return;
        }
        this.usernameHint.set(this.t().create.checking);
        timer = setTimeout(() => void this.checkUsername(typed), USERNAME_DEBOUNCE_MS);
      });
    });
    inject(DestroyRef).onDestroy(() => {
      if (timer) clearTimeout(timer);
    });
  }

  private async checkUsername(typed: string): Promise<void> {
    const res = await this.api.checkUsername(typed, true);
    if (this.username().trim().toLowerCase() !== typed) return;
    if (!res.ok) {
      this.usernameHint.set(reasonOf(res));
      return;
    }
    this.usernameAvailable.set(res.body.available);
    this.usernameHint.set(res.body.available ? this.t().create.usernameAvailable(res.body.username) : this.t().create.usernameTaken(res.body.username));
  }

  /** Challenge, passkey with PRF, fresh session keys, the signed payload, then the id. */
  protected async create(): Promise<void> {
    const selfie = this.selfie();
    if (!selfie) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const username = this.username().trim().toLowerCase();
      const firstName = this.firstName().trim();
      const lastName = this.lastName().trim();
      const challenge = await this.api.challenge('create');
      if (!challenge.ok || !challenge.body.anopodId) throw new Error(`/challenge: ${reasonOf(challenge)}`);
      const registration = await this.passkey.register(challenge.body.challenge, challenge.body.anopodId, username, `${firstName} ${lastName}`);
      const keys = this.crypto.generateSessionKeys();
      const payload = {
        anopodId: challenge.body.anopodId,
        challenge: challenge.body.challenge,
        firstName,
        lastName,
        username,
        selfie: { contentType: selfie.contentType, image: this.crypto.toBase64(selfie.bytes) },
        passkey: registration.passkey,
        ephemeralAuthKey: this.crypto.toHex(keys.ecdsa.publicKey),
        ephemeralAuthKeyPq: this.crypto.toHex(keys.mldsa.publicKey),
      };
      const res = await this.api.createAnopod({ payload, signatures: this.crypto.signPayload(keys, payload) });
      if (!res.ok) throw new Error(`/create-anopod: ${reasonOf(res)}`);
      this.session.open(res.body.anopodId, keys, res.body.username);
      this.session.firstName.set(firstName);
      this.session.lastName.set(lastName);
      this.session.setPrfOutput(registration.prfOutput);
      const status = await this.api.checkAnopodStatus();
      if (status.ok) this.session.status.set(status.body);
      this.created.set(true);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }

  protected continue(): void {
    void this.router.navigateByUrl('/vouching');
  }
}
