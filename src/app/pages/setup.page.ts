import { Component, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { Router, RouterLink } from '@angular/router';
import { ChatKeys, CryptoService } from '../services/crypto.service';
import { LanguageService } from '../services/language.service';
import { reasonOf } from '../services/log.service';
import { MasterpodApiService, SetupFields } from '../services/masterpod-api.service';
import { Bytes, PasskeyService } from '../services/passkey.service';
import { SessionService } from '../services/session.service';
import { DepositError, SharesService } from '../services/shares.service';
import { unlockWithPasskey } from '../unlock';

/** One line of the progress list. */
interface Step {
  label: string;
  state: 'todo' | 'doing' | 'done' | 'failed';
}

/**
 * The setup page (wallet spec 8.2): Start runs the progress list (an unlock
 * first when the PRF output is not in RAM); the backup code is shown once in
 * groups of four with "I have written it down, complete"; Complete deposits
 * the backup code with the keyholders (section 6, backupcode), then
 * /complete-setup with the eight fields; on 200 the code is dropped and the
 * next-step rule runs. A failed deposit shows Retry, which starts over with
 * a fresh secret. 409 setup already complete means a dropped answer earlier:
 * the status is checked and, if setup is complete, the flow carries on.
 */
@Component({
  selector: 'app-setup-page',
  imports: [MatCardModule, MatButtonModule, MatListModule, MatIconModule, MatProgressBarModule, RouterLink],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>{{ t().setup.title }}</mat-card-title>
        <mat-card-subtitle>{{ t().setup.subtitle }}</mat-card-subtitle>
      </mat-card-header>
      <mat-card-content>
        @if (!session.hasIdentity()) {
          <p class="error">{{ t().setup.noIdentity }}</p>
          <a mat-flat-button routerLink="/identity">{{ t().setup.goToIdentity }}</a>
        } @else if (phase() === 'idle') {
          @if (!session.hasPrf()) {
            <p>{{ t().setup.unlockHint }}</p>
          }
          <button mat-flat-button type="button" (click)="start()">{{ t().common.start }}</button>
        } @else {
          <mat-list dense>
            @for (step of steps(); track step.label) {
              <mat-list-item>
                <mat-icon matListItemIcon>{{ icon(step.state) }}</mat-icon>
                <span matListItemTitle>{{ step.label }}</span>
              </mat-list-item>
            }
          </mat-list>
          @if (busy()) {
            <mat-progress-bar mode="indeterminate"></mat-progress-bar>
          }
          @if (error(); as text) {
            <p class="error">{{ text }}</p>
          }
          @if (phase() === 'code' && backupCodeText(); as code) {
            <h3>{{ t().setup.codeTitle }}</h3>
            <p>{{ t().setup.codeHint }}</p>
            <p class="code">{{ code }}</p>
            <button mat-flat-button type="button" (click)="complete()" [disabled]="busy()">{{ t().setup.complete }}</button>
          }
          @if (phase() === 'failed') {
            <button mat-flat-button type="button" (click)="start()" [disabled]="busy()">{{ t().common.retry }}</button>
          }
        }
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    .code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 18px; letter-spacing: 1px; line-height: 1.6; max-width: 560px; word-break: break-word; padding: 12px; border-radius: 8px; background: var(--mat-sys-surface-container); }
    .error { color: var(--mat-sys-error); }
  `,
})
export class SetupPage {
  protected readonly session = inject(SessionService);
  private readonly api = inject(MasterpodApiService);
  private readonly crypto = inject(CryptoService);
  private readonly passkey = inject(PasskeyService);
  private readonly shares = inject(SharesService);
  private readonly router = inject(Router);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  protected readonly phase = signal<'idle' | 'running' | 'code' | 'failed' | 'done'>('idle');
  protected readonly steps = signal<Step[]>(this.t().setup.steps.map((label) => ({ label, state: 'todo' })));
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly backupCodeText = computed(() => (this.backupCode ? this.crypto.backupCodeText(this.backupCode) : null));

  // The secrets of this run, in plain fields, dropped when setup is complete.
  private encryptionKey: Bytes | null = null;
  private backupCode: Bytes | null = null;
  private chat: ChatKeys | null = null;
  private fields: SetupFields | null = null;

  protected icon(state: Step['state']): string {
    return { todo: 'radio_button_unchecked', doing: 'pending', done: 'check_circle', failed: 'error' }[state];
  }

  private setStep(index: number, state: Step['state']): void {
    this.steps.update((steps) => steps.map((step, i) => (i === index ? { ...step, state } : step)));
  }

  /** Everything up to the backup code shown: fresh every time Start or Retry is pressed. */
  protected async start(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    this.phase.set('running');
    this.steps.set(this.t().setup.steps.map((label) => ({ label, state: 'todo' })));
    try {
      if (!this.session.getPrfOutput()) {
        await unlockWithPasskey({ api: this.api, crypto: this.crypto, passkey: this.passkey, session: this.session });
      }
      const prf = this.session.getPrfOutput();
      const identity = this.session.getIdentity();
      if (!prf) throw new Error(this.t().setup.noPrf);
      if (!identity) throw new Error(this.t().setup.noIdentityInRam);

      let i = 0;
      const run = async <T>(fn: () => Promise<T> | T): Promise<T> => {
        this.setStep(i, 'doing');
        const value = await fn();
        this.setStep(i, 'done');
        i += 1;
        return value;
      };
      const encryptionKey = await run(() => this.crypto.newEncryptionKey());
      const code = await run(() => this.crypto.newBackupCode());
      const backupKeys = await run(() => this.crypto.backupCodeKeys(code));
      const chat = await run(() => this.crypto.generateChatKeys());
      const kekPrf = await this.crypto.deriveKekPrf(prf);
      const blob1 = await run(() => this.crypto.encrypt(kekPrf, encryptionKey));
      const kekBackup = await this.crypto.deriveKekBackup(code);
      const blob2 = await run(() => this.crypto.encrypt(kekBackup, encryptionKey));
      const chatPrivateKeyBlob = await run(() => this.crypto.wrapChatPrivateKey(chat, encryptionKey));
      const identityBlob = await run(() => this.crypto.wrapIdentity(identity.publicLedgerId, identity.lookupId, encryptionKey));

      this.encryptionKey = encryptionKey;
      this.backupCode = code;
      this.chat = chat;
      this.fields = {
        blob1: this.crypto.toHex(blob1),
        blob2: this.crypto.toHex(blob2),
        backupCodePublicKey: this.crypto.toHex(backupKeys.p256Public),
        backupCodePublicKeyPq: this.crypto.toHex(backupKeys.mldsaPublic),
        chatPublicKey: this.crypto.toHex(chat.p256Public),
        chatPublicKeyPq: this.crypto.toHex(chat.kemPublic),
        chatPrivateKeyBlob: this.crypto.toHex(chatPrivateKeyBlob),
        identityBlob: this.crypto.toHex(identityBlob),
      };
      this.phase.set('code');
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
      this.phase.set('failed');
    } finally {
      this.busy.set(false);
    }
  }

  /** The deposit of the backup code, then /complete-setup with the eight fields. */
  protected async complete(): Promise<void> {
    const code = this.backupCode;
    const fields = this.fields;
    const encryptionKey = this.encryptionKey;
    const chat = this.chat;
    if (!code || !fields || !encryptionKey || !chat) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      try {
        await this.shares.deposit(code, 'backupcode');
      } catch (err) {
        if (err instanceof DepositError) {
          this.error.set(this.t().setup.retryFresh(err.message));
          this.phase.set('failed');
          this.dropSecrets();
          return;
        }
        throw err;
      }
      const res = await this.api.completeSetup(fields);
      if (!res.ok && res.status === 409) {
        const status = await this.api.checkAnopodStatus();
        if (status.ok && status.body.setupComplete) {
          this.session.status.set(status.body);
          this.error.set(this.t().setup.alreadyComplete);
          this.phase.set('done');
          await this.router.navigateByUrl(this.session.nextStep(status.body));
          return;
        }
      }
      if (!res.ok) throw new Error(`/complete-setup: ${reasonOf(res)}`);
      this.session.setEncryptionKey(encryptionKey);
      this.session.setChatKeys(chat);
      this.backupCode = null;
      this.fields = null;
      this.phase.set('done');
      const status = await this.api.checkAnopodStatus();
      if (status.ok) this.session.status.set(status.body);
      await this.router.navigateByUrl(this.session.nextStep(status.ok ? status.body : undefined));
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
      this.phase.set('failed');
    } finally {
      this.busy.set(false);
    }
  }

  private dropSecrets(): void {
    this.encryptionKey = null;
    this.backupCode = null;
    this.chat = null;
    this.fields = null;
  }
}
