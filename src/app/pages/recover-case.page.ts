import { Component, DestroyRef, Injector, afterNextRender, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatStepper, MatStepperModule } from '@angular/material/stepper';
import { Router, RouterLink } from '@angular/router';
import { ConfigService } from '../services/config.service';
import { BackupCodeKeys, CryptoService } from '../services/crypto.service';
import { LanguageService } from '../services/language.service';
import { ApiError, reasonOf } from '../services/log.service';
import { MasterpodApiService, RotationMessage } from '../services/masterpod-api.service';
import { Bytes, PasskeyService } from '../services/passkey.service';
import { RECOVERY_POLL_MS, RecoveryEvent, RecoveryPodAnswer, RecoveryService } from '../services/recovery.service';
import { SessionService } from '../services/session.service';
import { DepositError, SharesService } from '../services/shares.service';
import { unlockWithPasskey } from '../unlock';

/** One line of the timeline. */
interface TimelineItem {
  key: string;
  icon: string;
  text: string;
  link: string | null;
  when: string;
}

/** What Combine rebuilt: how many backup code candidates and break-glass seeds, and how many shares did not open. */
interface Combined {
  codes: number;
  seeds: number;
  skipped: number;
}

/** The final statuses: the poll stops there. */
const FINAL_STATUSES = ['completed', 'dismissed'];

/** The statuses in which the masterpod hands over blob2 and takes the finish (masterpod 12.5). */
const FINISH_STATUSES = ['approved', 'delivering'];

/**
 * My recovery (wallet spec 12.3, /recover/case): the case id with Copy, the
 * status in words, the timeline from the events the person may see, a
 * Refresh button, and a 15-second poll of /get-recovery-pod while the page
 * is open. When three shares of one backup code keyId are in, the finish
 * appears as a second stepper (Combine, Get back in, New backup code, Done),
 * each step retryable, the ordinary unlock reused from unlock.ts and the
 * deposit from SharesService; the combined code and seeds live in
 * RecoveryService while it runs and die with the tab. The Break-glass keys
 * step left on 2026-11-08 (break-glass plan 1, step 4): the recovered seeds
 * stay in RecoveryService unused until step 5 puts "Move your money" here.
 */
@Component({
  selector: 'app-recover-case-page',
  imports: [MatCardModule, MatButtonModule, MatIconModule, MatListModule, MatProgressBarModule, MatStepperModule, RouterLink],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>{{ t().recoverCase.title }}</mat-card-title>
        <mat-card-subtitle class="subtitle">
          <span>{{ t().common.caseId(shortCaseId()) }}</span>
          <button mat-icon-button type="button" (click)="copyCaseId()" [attr.aria-label]="t().common.copyCaseId"><mat-icon>content_copy</mat-icon></button>
          @if (copied()) {
            <span class="muted">{{ t().copy.copied }}</span>
          }
        </mat-card-subtitle>
      </mat-card-header>
      <mat-card-content>
        <p class="status">{{ statusText() }}</p>
        <p>{{ t().recoverCase.keepDevice }}</p>
        @if (busy()) {
          <mat-progress-bar mode="indeterminate"></mat-progress-bar>
        }
        @if (error(); as text) {
          <p class="error">{{ text }}</p>
        }
        <h3>{{ t().common.timeline }}</h3>
        @if (timeline().length === 0) {
          <p class="muted">{{ t().common.nothingYet }}</p>
        }
        <mat-list dense>
          @for (item of timeline(); track item.key) {
            <mat-list-item>
              <mat-icon matListItemIcon>{{ item.icon }}</mat-icon>
              <span matListItemTitle>
                {{ item.text }}
                @if (item.link) {
                  <a [href]="item.link" target="_blank" rel="noopener">{{ t().common.meetingLink }}</a>
                }
              </span>
              <span matListItemLine>{{ item.when }}</span>
            </mat-list-item>
          }
        </mat-list>

        @if (showFinish()) {
          <h3>{{ t().recoverCase.finishTitle }}</h3>
          <p>{{ t().recoverCase.finishText }}</p>
          @if (finishBusy()) {
            <mat-progress-bar mode="indeterminate"></mat-progress-bar>
          }
          @if (finishError(); as text) {
            <p class="error">{{ text }}</p>
          }
          <mat-stepper linear orientation="vertical" #finish>
            <mat-step [completed]="combined() !== null" [editable]="false" [label]="t().recoverCase.combine">
              <p>{{ t().recoverCase.combineText }}</p>
              @if (combined(); as c) {
                <p class="result">{{ combinedText(c) }}</p>
              }
              <button mat-flat-button type="button" (click)="combine(finish)" [disabled]="finishBusy()">{{ t().recoverCase.combine }}</button>
            </mat-step>

            <mat-step [completed]="backIn()" [editable]="false" [label]="t().recoverCase.getBackIn">
              <p>{{ t().recoverCase.backInText }}</p>
              <button mat-flat-button type="button" (click)="getBackIn(finish)" [disabled]="finishBusy()">{{ t().recoverCase.getBackIn }}</button>
            </mat-step>

            <mat-step [completed]="deposited()" [editable]="false" [label]="t().recoverCase.stepNewCode">
              <p>{{ t().recoverCase.newCodeText }}</p>
              @if (newCodeText(); as code) {
                <h4>{{ t().recoverCase.newCodeTitle }}</h4>
                <p>{{ t().recoverCase.newCodeHint }}</p>
                <p class="code">{{ code }}</p>
                <button mat-flat-button type="button" (click)="completeRotation(finish)" [disabled]="finishBusy()">
                  {{ rotated() ? t().recoverCase.retryDeposit : t().common.writtenDown }}
                </button>
              } @else if (deposited()) {
                <p class="result">{{ t().recoverCase.oldCodeWorthless }}</p>
              } @else {
                <button mat-flat-button type="button" (click)="makeNewCode()" [disabled]="finishBusy()">{{ t().recoverCase.makeNewCode }}</button>
              }
            </mat-step>

            <mat-step [completed]="completed()" [label]="t().common.done">
              @if (completed()) {
                <p class="result">{{ t().recoverCase.backInDone }}</p>
                <button mat-flat-button type="button" (click)="continueToWallet()">{{ t().common.continue }}</button>
              } @else {
                <p>{{ t().recoverCase.closeCaseText }}</p>
                <button mat-flat-button type="button" (click)="complete()" [disabled]="finishBusy()">{{ t().recoverCase.completeRecovery }}</button>
              }
            </mat-step>
          </mat-stepper>
        }
      </mat-card-content>
      <mat-card-actions class="actions">
        <button mat-stroked-button type="button" (click)="refresh()" [disabled]="busy()">{{ t().common.refresh }}</button>
        <a mat-button routerLink="/recover">{{ t().common.recoverAccount }}</a>
      </mat-card-actions>
    </mat-card>
  `,
  styles: `
    .subtitle { display: flex; align-items: center; gap: 4px; }
    .status { font-weight: 500; }
    .muted { color: var(--mat-sys-on-surface-variant); }
    .error { color: var(--mat-sys-error); }
    .result { color: var(--mat-sys-primary); }
    .code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 18px; letter-spacing: 1px; line-height: 1.6; max-width: 560px; word-break: break-word; padding: 12px; border-radius: 8px; background: var(--mat-sys-surface-container); }
    .actions { padding: 16px; gap: 8px; }
    a { margin-left: 8px; }
  `,
})
export class RecoverCasePage {
  protected readonly recovery = inject(RecoveryService);
  private readonly api = inject(MasterpodApiService);
  private readonly config = inject(ConfigService);
  private readonly crypto = inject(CryptoService);
  private readonly passkey = inject(PasskeyService);
  private readonly session = inject(SessionService);
  private readonly shares = inject(SharesService);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly copied = signal(false);

  // --- the finish ------------------------------------------------------------
  protected readonly finishBusy = signal(false);
  protected readonly finishError = signal<string | null>(null);
  /** True once Combine ran in this page: the stepper stays after the case is completed. */
  private readonly finishActive = signal(false);
  protected readonly combined = signal<Combined | null>(null);
  protected readonly backIn = signal(false);
  protected readonly newCodeText = signal<string | null>(null);
  /** The rotation landed on the masterpod; only the deposit is left (a retry deposits the same new code again). */
  protected readonly rotated = signal(false);
  protected readonly deposited = signal(false);
  protected readonly completed = signal(false);

  // The finish's secrets, in plain fields, dropped as each step is done with them.
  /** The proof succeeded: a retry of Get back in only repeats the unlock. */
  private recovered = false;
  private recoveredCode: Bytes | null = null;
  private newCode: Bytes | null = null;
  private newBlob2: Bytes | null = null;
  private newKeys: BackupCodeKeys | null = null;

  protected readonly shortCaseId = computed(() => {
    const id = this.recovery.caseId();
    return id ? `${id.slice(0, 8)}…${id.slice(-8)}` : '';
  });

  /** How many backup code shares of one key id are in: the largest group. */
  protected readonly backupShares = computed(() => {
    const counts = new Map<string, number>();
    for (const share of this.recovery.pod()?.shares ?? []) {
      if (share.shareType === 'backupcode') counts.set(share.keyId, (counts.get(share.keyId) ?? 0) + 1);
    }
    return Math.max(0, ...counts.values());
  });

  protected readonly threshold = computed(() => this.config.config()?.shareThreshold ?? 3);

  /** The finish shows once enough backup code shares are in and the case takes it, and stays once it has started here. */
  protected readonly showFinish = computed(() => {
    const status = this.recovery.status();
    return this.finishActive() || (this.backupShares() >= this.threshold() && status !== null && FINISH_STATUSES.includes(status));
  });

  protected readonly statusText = computed(() => {
    const words = this.t().recoverCase;
    const email = this.recovery.contactEmail() ?? words.yourEmail;
    switch (this.recovery.status()) {
      case 'open':
        return words.statusOpen(email);
      case 'inReview':
        return words.statusInReview;
      case 'approved':
        return words.statusApproved;
      case 'delivering':
        return words.statusDelivering(this.backupShares(), this.threshold());
      case 'completed':
        return words.statusCompleted;
      case 'dismissed':
        return this.t().common.dismissed(this.dismissReason(this.recovery.pod()));
      default:
        return this.t().common.loadingCase;
    }
  });

  protected readonly timeline = computed<TimelineItem[]>(() =>
    (this.recovery.pod()?.events ?? []).map((event, i) => ({
      key: `${i}-${event.kind}-${event.createdAt}`,
      icon: this.iconOf(event),
      text: this.textOf(event),
      link: event.kind === 'scheduled' && typeof event.details['meetLink'] === 'string' ? event.details['meetLink'] : null,
      when: this.lang.dateTime(event.createdAt),
    })),
  );

  constructor() {
    void this.config.load().catch(() => undefined);
    void this.refresh();
    const timer = setInterval(() => void this.poll(), RECOVERY_POLL_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  private polling = false;

  private async poll(): Promise<void> {
    const status = this.recovery.status();
    if (!this.recovery.hasSession() || this.polling || (status && FINAL_STATUSES.includes(status))) return;
    this.polling = true;
    try {
      await this.load(true);
    } finally {
      this.polling = false;
    }
  }

  /** The Refresh button. */
  protected async refresh(): Promise<void> {
    this.busy.set(true);
    try {
      await this.load(false);
    } finally {
      this.busy.set(false);
    }
  }

  private async load(quiet: boolean): Promise<void> {
    const envelope = this.recovery.sign('/get-recovery-pod', {});
    if (!envelope) {
      this.error.set(this.t().recoverCase.noSession);
      return;
    }
    const res = await this.api.getRecoveryPod(envelope, quiet);
    if (!this.recovery.hasSession()) return;
    if (res.ok) {
      this.recovery.applyPod(res.body);
      this.error.set(null);
    } else if (res.status === 401) {
      this.error.set(this.t().recoverCase.sessionEnded);
    } else {
      this.error.set(`/get-recovery-pod: ${reasonOf(res)}`);
    }
  }

  protected async copyCaseId(): Promise<void> {
    const id = this.recovery.caseId();
    if (!id) return;
    try {
      await navigator.clipboard.writeText(id);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } catch {
      this.error.set(this.t().common.couldNotCopyId);
    }
  }

  // --- the finish (wallet spec 12.3) --------------------------------------------

  /**
   * Step 1, Combine: every share opened with the recovery hybrid private key
   * (aad lookupId || shareType || keyId), grouped by keyId; each group with
   * at least the threshold combined, the newest group first. The backup
   * code candidates and the break-glass seeds go to RecoveryService.
   */
  protected async combine(stepper: MatStepper): Promise<void> {
    await this.runStep(async () => {
      const hybrid = this.recovery.getHybridKeys();
      const pod = this.recovery.pod();
      const lookupId = this.recovery.lookupId();
      if (!hybrid || !pod || !lookupId) throw new Error(this.t().recoverCase.podNotOpen);
      const { shareThreshold } = await this.config.load();
      const groups = new Map<string, { shareType: string; newest: string; shares: Uint8Array[]; skipped: number }>();
      for (const share of pod.shares) {
        const group = groups.get(share.keyId) ?? { shareType: share.shareType, newest: share.receivedAt, shares: [], skipped: 0 };
        try {
          group.shares.push(await this.crypto.decryptFromHybrid(hybrid, this.crypto.fromHex(share.share), this.crypto.shareAad(lookupId, share.shareType, share.keyId)));
        } catch {
          group.skipped += 1;
        }
        if (share.receivedAt > group.newest) group.newest = share.receivedAt;
        groups.set(share.keyId, group);
      }
      const codes: Bytes[] = [];
      const seeds: Bytes[] = [];
      const complete = [...groups.values()].filter((g) => g.shares.length >= shareThreshold).sort((a, b) => b.newest.localeCompare(a.newest));
      for (const group of complete) {
        const secret = await this.crypto.combineShares(group.shares.slice(0, shareThreshold));
        if (group.shareType === 'backupcode') codes.push(secret);
        else if (group.shareType === 'breakglasskey') seeds.push(secret);
      }
      const skipped = [...groups.values()].reduce((n, g) => n + g.skipped, 0);
      if (codes.length === 0) throw new Error(this.t().recoverCase.noCodeRebuilt(shareThreshold));
      this.recovery.setCombined(codes, seeds);
      this.recovered = false;
      this.recoveredCode = null;
      this.combined.set({ codes: codes.length, seeds: seeds.length, skipped });
      this.finishActive.set(true);
    }, stepper);
  }

  /**
   * Step 2, Get back in: the proof (once; a retry after a failed unlock only
   * repeats the unlock), then the ordinary unlock of unlock.ts with the same
   * passkey, which opens the normal session in this tab.
   */
  protected async getBackIn(stepper: MatStepper): Promise<void> {
    await this.runStep(async () => {
      if (!this.recovered) await this.prove();
      await unlockWithPasskey({ api: this.api, crypto: this.crypto, passkey: this.passkey, session: this.session });
      if (!this.session.getEncryptionKey()) throw new Error(this.t().recoverCase.unlockNoKey);
      this.backIn.set(true);
    }, stepper);
  }

  /**
   * The proof of the backup code (masterpod 12.4.2): the candidate that
   * opens blob2 under its KEK_backup is the current code; the encryption key
   * is wrapped afresh under KEK_prf as newBlob1; /challenge (recover); the
   * payload { challenge, caseId, newBlob1 } signed by the code's keys;
   * /recover-with-backup-code.
   */
  private async prove(): Promise<void> {
    const caseId = this.recovery.caseId();
    const kekPrf = this.recovery.getKekPrf();
    const blob2 = this.recovery.pod()?.blob2;
    const codes = this.recovery.getBackupCodes();
    if (!caseId || !kekPrf) throw new Error(this.t().recoverCase.podNotOpen);
    if (!blob2) throw new Error(this.t().recoverCase.noBlob2);
    if (codes.length === 0) throw new Error(this.t().recoverCase.combineFirst);

    let code: Bytes | null = null;
    let encryptionKey: Bytes | null = null;
    for (const candidate of codes) {
      try {
        encryptionKey = await this.crypto.decrypt(await this.crypto.deriveKekBackup(candidate), this.crypto.fromHex(blob2));
        code = candidate;
        break;
      } catch {
        // Not the current code: an older deposit's shares, or a share that was changed.
      }
    }
    if (!code || !encryptionKey) {
      throw new Error(this.t().recoverCase.codeNoOpen);
    }
    const newBlob1 = await this.crypto.encrypt(kekPrf, encryptionKey);
    const challenge = await this.api.challenge('recover');
    if (!challenge.ok) throw new Error(`/challenge: ${reasonOf(challenge)}`);
    const payload = { challenge: challenge.body.challenge, caseId, newBlob1: this.crypto.toHex(newBlob1) };
    const res = await this.api.recoverWithBackupCode({ payload, signatures: await this.crypto.backupCodeProof(code, payload) });
    if (!res.ok) {
      const reason = (res.body as unknown as Partial<ApiError>)?.error;
      if (res.status === 401 && reason === 'bad signature') {
        throw new Error(this.t().recoverCase.codeNotAccepted);
      }
      if (res.status === 409) throw new Error(this.t().recoverCase.notTakingFinish(reasonOf(res)));
      throw new Error(`/recover-with-backup-code: ${reasonOf(res)}`);
    }
    this.recovered = true;
    this.recoveredCode = code;
  }

  /** Step 3, first half: a fresh backup code, its blob2 and keys, shown once as on Setup. */
  protected async makeNewCode(): Promise<void> {
    this.finishError.set(null);
    const encryptionKey = this.session.getEncryptionKey();
    if (!encryptionKey) {
      this.finishError.set(this.t().recoverCase.noKeyInTab);
      return;
    }
    const code = this.crypto.newBackupCode();
    this.newCode = code;
    this.newBlob2 = await this.crypto.encrypt(await this.crypto.deriveKekBackup(code), encryptionKey);
    this.newKeys = await this.crypto.backupCodeKeys(code);
    this.rotated.set(false);
    this.newCodeText.set(this.crypto.backupCodeText(code));
  }

  /**
   * Step 3, Complete: /rotate-backup-code with the new blob2 and keys and the
   * proof by the old code (once), then the deposit of the new code as
   * backupcode under a fresh keyId through SharesService. A failed deposit
   * leaves the rotation standing: Retry deposits the same new code again.
   */
  protected async completeRotation(stepper: MatStepper): Promise<void> {
    await this.runStep(async () => {
      const code = this.newCode;
      const blob2 = this.newBlob2;
      const keys = this.newKeys;
      const anopodId = this.session.anopodId();
      if (!code || !blob2 || !keys) throw new Error(this.t().recoverCase.makeCodeFirst);
      if (!anopodId) throw new Error(this.t().recoverCase.noSessionInTab);
      if (!this.rotated()) {
        const oldCode = this.recoveredCode;
        if (!oldCode) throw new Error(this.t().recoverCase.noCurrentCode);
        const message: RotationMessage = {
          anopodId,
          newBackupCodePublicKey: this.crypto.toHex(keys.p256Public),
          newBackupCodePublicKeyPq: this.crypto.toHex(keys.mldsaPublic),
          newBlob2: this.crypto.toHex(blob2),
        };
        const res = await this.api.rotateBackupCode({ ...message, proof: await this.crypto.backupCodeProof(oldCode, message) });
        if (!res.ok) throw new Error(`/rotate-backup-code: ${reasonOf(res)}`);
        this.rotated.set(true);
        this.recoveredCode = null;
      }
      try {
        await this.shares.deposit(code, 'backupcode');
      } catch (err) {
        if (err instanceof DepositError) throw new Error(this.t().recoverCase.retryDeposits(err.message));
        throw err;
      }
      this.deposited.set(true);
      this.newCode = null;
      this.newBlob2 = null;
      this.newKeys = null;
      this.newCodeText.set(null);
    }, stepper);
  }

  /** Step 4, Done: /complete-recovery-case with the recovery envelope; a case already completed counts as done. */
  protected async complete(): Promise<void> {
    await this.runStep(async () => {
      const envelope = this.recovery.sign('/complete-recovery-case', {});
      if (!envelope) throw new Error(this.t().recoverCase.noSessionGoTo);
      const res = await this.api.completeRecoveryCase(envelope);
      if (!res.ok) {
        await this.load(true);
        if (!(res.status === 409 && this.recovery.status() === 'completed')) throw new Error(`/complete-recovery-case: ${reasonOf(res)}`);
      }
      this.completed.set(true);
      await this.load(true);
    });
  }

  protected async continueToWallet(): Promise<void> {
    await this.router.navigateByUrl('/wallet');
  }

  /** Runs one step: busy and the error cleared around it; on success the stepper moves on once the step's completed binding has rendered. */
  private async runStep(step: () => Promise<void>, stepper?: MatStepper): Promise<void> {
    this.finishBusy.set(true);
    this.finishError.set(null);
    try {
      await step();
      if (stepper) {
        await new Promise<void>((resolve) => afterNextRender(() => resolve(), { injector: this.injector }));
        stepper.next();
      }
    } catch (err) {
      this.finishError.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.finishBusy.set(false);
    }
  }

  protected combinedText(c: Combined): string {
    const words = this.t().recoverCase;
    const codes = words.codesRecovered(c.codes);
    const seeds = words.seedsRecovered(c.seeds);
    const skipped = c.skipped > 0 ? ` · ${words.sharesSkipped(c.skipped)}` : '';
    return `${codes} · ${seeds}${skipped}`;
  }

  private dismissReason(pod: RecoveryPodAnswer | null): string {
    const event = [...(pod?.events ?? [])].reverse().find((e) => e.kind === 'dismissed');
    const reason = typeof event?.details['reason'] === 'string' ? event.details['reason'] : 'other';
    return this.t().recoverCase.dismissReasons[reason] ?? reason;
  }

  private iconOf(event: RecoveryEvent): string {
    return { opened: 'flag', scheduled: 'event', approved: 'verified', dismissed: 'block', recovered: 'key', completed: 'check_circle' }[event.kind] ?? 'circle';
  }

  private textOf(event: RecoveryEvent): string {
    const words = this.t().recoverCase;
    switch (event.kind) {
      case 'opened':
        return words.eventOpened;
      case 'scheduled': {
        const at = typeof event.details['at'] === 'string' ? this.lang.dateTime(event.details['at']) : this.t().common.timeToBeConfirmed;
        return this.t().common.videoCallScheduled(at);
      }
      case 'approved':
        return words.eventApproved;
      case 'dismissed':
        return this.t().common.dismissed(words.dismissReasons[String(event.details['reason'])] ?? String(event.details['reason'] ?? ''));
      case 'recovered':
        return words.eventRecovered;
      case 'completed':
        return words.eventCompleted;
      default:
        return event.kind;
    }
  }
}
