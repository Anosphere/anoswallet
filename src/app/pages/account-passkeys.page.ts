import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatListModule } from '@angular/material/list';
import { RouterLink } from '@angular/router';
import { CryptoService } from '../services/crypto.service';
import { LanguageService } from '../services/language.service';
import { ApiError, reasonOf } from '../services/log.service';
import { AddPasskeyBody, MasterpodApiService, PasskeyList } from '../services/masterpod-api.service';
import { PasskeyService, Registration } from '../services/passkey.service';
import { SessionService } from '../services/session.service';
import { SettingsService } from '../services/settings.service';

/** The name rule of a passkey, for the add and for Rename: the name trimmed when it is 1 to 40 characters, counted with Array.from; null otherwise. */
function validName(text: string): string | null {
  const name = text.trim();
  const length = Array.from(name).length;
  return length >= 1 && length <= 40 ? name : null;
}

/**
 * The Passkeys page (wallet spec 8.2; 2026-11-18, section 11), at
 * /account/passkeys: the anoPod's passkeys and the three steps that add
 * one (masterpod spec 19). The list is /list-passkeys: the main passkey
 * under its fixed name, then the added ones, oldest first, each under the
 * name the person gave it, which lives in the wallet settings
 * (settings.service, passkeyNames) and which Rename changes; the passkey
 * that opened this session is marked. The add is three taps, one button
 * each: a fresh tap of a passkey the anoPod already has, over a challenge
 * made for the add; the new passkey's registration over the same
 * challenge, with the anoPod's credential ids as the exclude list; and
 * one sign-in of the new passkey, whose PRF output wraps the new
 * passkey's own copies of the encryption key (blob1) and of the key blob
 * key. Then /add-passkey, and the name saved under the new passkey's id.
 * Nothing secret is kept between the steps: the challenge, the fresh
 * tap's JSON, the registration and the built body, which holds
 * ciphertexts only.
 */
@Component({
  selector: 'app-account-passkeys-page',
  imports: [RouterLink, FormsModule, MatCardModule, MatListModule, MatButtonModule, MatIconModule, MatFormFieldModule, MatInputModule],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>{{ t().accountPasskeys.title }}</mat-card-title>
      </mat-card-header>
      <mat-card-content>
        <p><a mat-button routerLink="/account"><mat-icon>arrow_back</mat-icon> {{ t().nav.account }}</a></p>
        <p>{{ t().accountPasskeys.intro }}</p>
        @if (listError(); as text) {
          <p class="error">{{ text }}</p>
        }
        @if (list(); as l) {
          <mat-list class="passkeys">
            <mat-list-item lines="3">
              <mat-icon matListItemIcon>key</mat-icon>
              <span matListItemTitle>{{ t().accountPasskeys.main }}</span>
              <span matListItemLine class="line">{{ t().accountPasskeys.mainLine }}</span>
              @if (l.main.credentialId === session.passkeyCredentialId()) {
                <span matListItemLine class="line">{{ t().accountPasskeys.inUse }}</span>
              }
            </mat-list-item>
            @for (p of l.added; track p.passkeyId) {
              @if (renaming() === p.passkeyId) {
                <div class="rename">
                  <mat-form-field appearance="outline" subscriptSizing="dynamic">
                    <mat-label>{{ t().common.name }}</mat-label>
                    <input matInput [ngModel]="renameText()" (ngModelChange)="renameText.set($event)" maxlength="40" autocomplete="off" />
                  </mat-form-field>
                  <button mat-flat-button type="button" (click)="saveRename(p.passkeyId)" [disabled]="busy()">{{ t().common.save }}</button>
                  <button mat-button type="button" (click)="cancelRename()" [disabled]="busy()">{{ t().common.cancel }}</button>
                </div>
                @if (renameError(); as text) {
                  <p class="error rename-error">{{ text }}</p>
                }
              } @else {
                <div class="row">
                  <mat-list-item lines="3">
                    <mat-icon matListItemIcon>key</mat-icon>
                    <span matListItemTitle>{{ nameOf(p.passkeyId) }}</span>
                    <span matListItemLine class="line">{{ t().accountPasskeys.addedOn(lang.dateTime(p.createdAt)) }}</span>
                    @if (p.credentialId === session.passkeyCredentialId()) {
                      <span matListItemLine class="line">{{ t().accountPasskeys.inUse }}</span>
                    }
                  </mat-list-item>
                  <button mat-icon-button type="button" (click)="startRename(p.passkeyId)" [disabled]="busy()" [attr.aria-label]="t().accountPasskeys.rename"><mat-icon>edit</mat-icon></button>
                </div>
              }
            }
          </mat-list>
        }

        <h3>{{ t().accountPasskeys.add }}</h3>
        <p>{{ t().accountPasskeys.addIntro }}</p>
        <p>{{ t().accountPasskeys.where }}</p>
        <mat-form-field appearance="outline" class="name">
          <mat-label>{{ t().common.name }}</mat-label>
          <input matInput [ngModel]="name()" (ngModelChange)="name.set($event)" maxlength="40" autocomplete="off" />
          <mat-hint>{{ t().accountPasskeys.nameHint }}</mat-hint>
        </mat-form-field>

        <p class="step">1. {{ t().accountPasskeys.step1 }}</p>
        <p>{{ t().accountPasskeys.step1Text }}</p>
        <button mat-flat-button type="button" (click)="confirm()" [disabled]="busy() || !list() || step() !== 1 || !nameValid()">{{ t().accountPasskeys.step1Button }}</button>

        <p class="step">2. {{ t().accountPasskeys.step2 }}</p>
        <p>{{ t().accountPasskeys.step2Text }}</p>
        <button mat-flat-button type="button" (click)="saveNew()" [disabled]="busy() || !list() || step() !== 2">{{ t().accountPasskeys.step2Button }}</button>

        <p class="step">3. {{ t().accountPasskeys.step3 }}</p>
        <p>{{ t().accountPasskeys.step3Text }}</p>
        <button mat-flat-button type="button" (click)="finish()" [disabled]="busy() || !list() || step() !== 3">{{ t().accountPasskeys.step3Button }}</button>

        <p class="again"><button mat-button type="button" (click)="startAgain()" [disabled]="busy()">{{ t().accountPasskeys.startAgain }}</button></p>
        @if (done(); as text) {
          <p class="ok">{{ text }}</p>
        }
        @if (error(); as text) {
          <p class="error">{{ text }}</p>
        }
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    p { max-width: 640px; }
    .error { color: var(--mat-sys-error); }
    .ok { color: var(--mat-sys-primary); }
    /* A Material list item has a fixed height and cuts each line at the row's width; here a row grows with its lines and a line wraps, so nothing is cut on a phone. */
    .passkeys mat-list-item { height: auto; padding-bottom: 12px; }
    .passkeys mat-list-item .line { white-space: normal; line-height: 20px; }
    .row { display: flex; align-items: center; }
    .row mat-list-item { flex: 1; min-width: 0; }
    .rename { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 16px; }
    .rename mat-form-field { flex: 1 1 220px; max-width: 360px; }
    .rename-error { margin: 0 16px 8px; }
    .name { width: 100%; max-width: 360px; }
    .step { margin: 20px 0 4px; font-weight: 500; }
    .again { margin-top: 20px; }
  `,
})
export class AccountPasskeysPage {
  private readonly api = inject(MasterpodApiService);
  private readonly crypto = inject(CryptoService);
  private readonly passkey = inject(PasskeyService);
  private readonly settings = inject(SettingsService);
  protected readonly session = inject(SessionService);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  /** The anoPod's passkeys as /list-passkeys answered them; null until read, and the three buttons stay off until then. */
  protected readonly list = signal<PasskeyList | null>(null);
  /** A refused /list-passkeys, in red where the list would be. */
  protected readonly listError = signal<string | null>(null);
  /** The names of the added passkeys, by passkey id, from the wallet settings. */
  private readonly names = computed<Record<string, string | undefined>>(() => this.settings.settings()?.passkeyNames ?? {});
  /** Every credential id of the list, hex: what the fresh tap is checked against, and the exclude list of the new passkey. */
  private readonly credentialIds = computed(() => {
    const list = this.list();
    return list ? [list.main.credentialId, ...list.added.map((p) => p.credentialId)] : [];
  });

  /** The added passkey being renamed, by its passkey id; null when none is. */
  protected readonly renaming = signal<string | null>(null);
  protected readonly renameText = signal('');
  protected readonly renameError = signal<string | null>(null);

  /** The name of the passkey being added, as typed. */
  protected readonly name = signal('');
  protected readonly nameValid = computed(() => validName(this.name()) !== null);
  /** The current step of the add: 1, 2 or 3. */
  protected readonly step = signal<1 | 2 | 3>(1);
  protected readonly busy = signal(false);
  /** The add's refusal or failure, in red under the steps. */
  protected readonly error = signal<string | null>(null);
  /** The add's success line, under the steps. */
  protected readonly done = signal<string | null>(null);

  // --- kept between the steps; no secret among them ---------------------------
  /** The challenge of /challenge addPasskey, hex: it serves the fresh tap and the registration. */
  private challenge: string | null = null;
  /** The fresh tap's WebAuthn JSON. */
  private assertion: Record<string, unknown> | null = null;
  /** The new passkey's registration. */
  private registration: Registration | null = null;
  /** The body of /add-passkey once it is built, kept so that a send that failed goes again without a tap. */
  private body: AddPasskeyBody | null = null;

  constructor() {
    void this.load();
  }

  /** The name an added passkey shows under: the one in the wallet settings, or "Passkey". */
  protected nameOf(passkeyId: string): string {
    return this.names()[passkeyId] || this.t().accountPasskeys.unnamed;
  }

  /** /list-passkeys, a refusal in red; then the wallet settings, for the names, when they were not read yet. */
  private async load(): Promise<void> {
    const res = await this.api.listPasskeys();
    if (res.ok) {
      this.list.set(res.body);
      this.listError.set(null);
    } else {
      this.listError.set(`/list-passkeys: ${reasonOf(res)}`);
    }
    if (this.settings.settings() === null) await this.settings.load();
  }

  /** The name into the wallet settings under the passkey's id, beside the names already there; the settings are read first when they were not, so no stored name is dropped. Throws as settings.save does. */
  private async saveName(passkeyId: string, name: string): Promise<void> {
    if (this.settings.settings() === null) await this.settings.load();
    await this.settings.save({ passkeyNames: { ...(this.settings.settings()?.passkeyNames ?? {}), [passkeyId]: name } });
  }

  // --- Rename -----------------------------------------------------------------

  protected startRename(passkeyId: string): void {
    this.renameText.set(this.names()[passkeyId] ?? '');
    this.renameError.set(null);
    this.renaming.set(passkeyId);
  }

  protected cancelRename(): void {
    this.renaming.set(null);
    this.renameError.set(null);
  }

  /** Save of a rename: the name rule, then the name into the wallet settings; a refusal in red under the box. */
  protected async saveRename(passkeyId: string): Promise<void> {
    const name = validName(this.renameText());
    if (name === null) {
      this.renameError.set(this.t().accountPasskeys.nameRule);
      return;
    }
    this.busy.set(true);
    this.renameError.set(null);
    try {
      await this.saveName(passkeyId, name);
      this.renaming.set(null);
    } catch (err) {
      this.renameError.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }

  // --- the add, three steps -----------------------------------------------------

  /** Step 1: the two keys must be in RAM; a challenge for the add; a fresh tap of any passkey, which has to be one of this anoPod's. */
  protected confirm(): Promise<void> {
    return this.run(async () => {
      const anopodId = this.session.anopodId();
      if (this.step() !== 1 || this.list() === null || anopodId === null) return;
      if (validName(this.name()) === null) throw new Error(this.t().accountPasskeys.nameRule);
      if (!this.session.getEncryptionKey()) throw new Error(this.t().common.noKeyInRam);
      if (!this.session.getKeyBlobKey()) throw new Error(this.t().common.noKeyBlobKey);
      const challenge = await this.api.challenge('addPasskey', anopodId);
      if (!challenge.ok) throw new Error(`/challenge: ${reasonOf(challenge)}`);
      const tap = await this.passkey.assert(challenge.body.challenge);
      if (!this.credentialIds().includes(this.crypto.toHex(tap.rawId))) throw new Error(this.t().accountPasskeys.notYours);
      this.challenge = challenge.body.challenge;
      this.assertion = tap.assertion;
      this.step.set(2);
    });
  }

  /** Step 2: the new passkey, registered over the same challenge with the anoPod's id, the username and the name of the first one, and the anoPod's credential ids as the exclude list. Its PRF output is not used. */
  protected saveNew(): Promise<void> {
    return this.run(async () => {
      const anopodId = this.session.anopodId();
      if (this.step() !== 2 || this.challenge === null || anopodId === null) return;
      const username = this.session.username();
      const displayName = `${this.session.firstName()} ${this.session.lastName()}`.trim() || username;
      const exclude = this.credentialIds().map((id) => this.crypto.fromHex(id));
      try {
        this.registration = await this.passkey.register(this.challenge, anopodId, username, displayName, exclude);
      } catch (err) {
        // The place already holds one of the excluded passkeys.
        if (err instanceof DOMException && err.name === 'InvalidStateError') throw new Error(this.t().accountPasskeys.alreadyHere);
        throw err;
      }
      this.step.set(3);
    });
  }

  /**
   * Step 3: one sign-in of the new passkey alone, over a random challenge
   * that goes nowhere, for its PRF output by the route every later unlock
   * takes; from it the new passkey's own copies of the encryption key
   * (blob1, under KEK_prf) and of the key blob key (under
   * deriveKekKeysWrap); then /add-passkey. On 201 the name is saved under
   * the new passkey's id, the steps and the name box start over and the
   * list is read again. A challenge that is gone and a fresh tap the
   * masterpod does not know start the steps over with their sentence; any
   * other refusal, or no answer, keeps the built body, so the button
   * sends it again without a tap.
   */
  protected finish(): Promise<void> {
    return this.run(async () => {
      const registration = this.registration;
      if (this.step() !== 3 || registration === null || this.challenge === null || this.assertion === null) return;
      const name = validName(this.name());
      if (name === null) throw new Error(this.t().accountPasskeys.nameRule);
      if (this.body === null) {
        const encryptionKey = this.session.getEncryptionKey();
        if (!encryptionKey) throw new Error(this.t().common.noKeyInRam);
        const keyBlobKey = this.session.getKeyBlobKey();
        if (!keyBlobKey) throw new Error(this.t().common.noKeyBlobKey);
        const tap = await this.passkey.assert(this.crypto.randomHex(32), { id: registration.rawId, transports: registration.transports });
        if (this.crypto.toHex(tap.rawId) !== this.crypto.toHex(registration.rawId)) throw new Error(this.t().accountPasskeys.notNew);
        const blob1 = await this.crypto.encrypt(await this.crypto.deriveKekPrf(tap.prfOutput), encryptionKey);
        const wrappedKeyBlobKey = await this.crypto.encrypt(await this.crypto.deriveKekKeysWrap(tap.prfOutput), keyBlobKey);
        this.body = {
          challenge: this.challenge,
          assertion: this.assertion,
          passkey: registration.passkey,
          blob1: this.crypto.toHex(blob1),
          wrappedKeyBlobKey: this.crypto.toHex(wrappedKeyBlobKey),
        };
      }
      const res = await this.api.addPasskey(this.body);
      if (!res.ok) {
        const reason = (res.body as unknown as Partial<ApiError> | null)?.error;
        if (res.status === 401 && reason === 'unknown or expired challenge') {
          this.resetSteps();
          throw new Error(this.t().accountPasskeys.tooLong);
        }
        if (res.status === 401 && reason === 'unknown passkey') {
          this.resetSteps();
          throw new Error(this.t().accountPasskeys.notYours);
        }
        throw new Error(`/add-passkey: ${reasonOf(res)}`);
      }
      let nameNotSaved: string | null = null;
      try {
        await this.saveName(res.body.passkeyId, name);
      } catch (err) {
        nameNotSaved = this.t().accountPasskeys.nameNotSaved(err instanceof Error ? err.message : String(err));
      }
      this.resetSteps();
      this.name.set('');
      await this.load();
      this.done.set(this.t().accountPasskeys.added(name));
      this.error.set(nameNotSaved);
    });
  }

  /** Start again: the steps start over, the name stays, and the lines under the steps go. */
  protected startAgain(): void {
    this.resetSteps();
    this.error.set(null);
    this.done.set(null);
  }

  /** Back to step 1 with nothing kept. */
  private resetSteps(): void {
    this.step.set(1);
    this.challenge = null;
    this.assertion = null;
    this.registration = null;
    this.body = null;
  }

  /** One step's work: busy while it runs, the lines under the steps cleared first, what it throws in red. */
  private async run(action: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    this.done.set(null);
    try {
      await action();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }
}
