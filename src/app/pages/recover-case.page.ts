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
import { ApiError, reasonOf } from '../services/log.service';
import { AnosAccountListItem, MasterpodApiService, RotationMessage } from '../services/masterpod-api.service';
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

/** What Break-glass keys did: the accounts that got their seed, and the seeds that matched no account. */
interface BreakGlassResult {
  stored: string[];
  unmatched: number;
}

/** A dismissal's preset reason in words (masterpod 12.4.4). */
const DISMISS_REASONS: Record<string, string> = {
  selfieMismatch: 'the selfie did not match',
  documentsMismatch: 'the documents did not match',
  unknownLookupId: 'the keyholders know no identity with this lookup id',
  noShow: 'you did not join the call',
  other: 'another reason',
};

/** The final statuses: the poll stops there. */
const FINAL_STATUSES = ['completed', 'dismissed'];

/** The statuses in which the masterpod hands over blob2 and takes the finish (masterpod 12.5). */
const FINISH_STATUSES = ['approved', 'delivering'];

/**
 * My recovery (wallet spec 12.3, /recover/case): the case id with Copy, the
 * status in words, the timeline from the events the person may see, a
 * Refresh button, and a 15-second poll of /get-recovery-pod while the page
 * is open. When three shares of one backup code keyId are in, the finish
 * appears as a second stepper (Combine, Get back in, Break-glass keys, New
 * backup code, Done), each step retryable, the ordinary unlock reused from
 * unlock.ts and the deposit from SharesService; the combined code and seeds
 * live in RecoveryService while it runs and die with the tab.
 */
@Component({
  selector: 'app-recover-case-page',
  imports: [MatCardModule, MatButtonModule, MatIconModule, MatListModule, MatProgressBarModule, MatStepperModule, RouterLink],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>My recovery</mat-card-title>
        <mat-card-subtitle class="subtitle">
          <span>Case {{ shortCaseId() }}</span>
          <button mat-icon-button type="button" (click)="copyCaseId()" aria-label="Copy the case id"><mat-icon>content_copy</mat-icon></button>
          @if (copied()) {
            <span class="muted">copied</span>
          }
        </mat-card-subtitle>
      </mat-card-header>
      <mat-card-content>
        <p class="status">{{ statusText() }}</p>
        <p>Keep this device: you unlock this case with the passkey you just made.</p>
        @if (busy()) {
          <mat-progress-bar mode="indeterminate"></mat-progress-bar>
        }
        @if (error(); as text) {
          <p class="error">{{ text }}</p>
        }
        <h3>Timeline</h3>
        @if (timeline().length === 0) {
          <p class="muted">Nothing yet.</p>
        }
        <mat-list dense>
          @for (item of timeline(); track item.key) {
            <mat-list-item>
              <mat-icon matListItemIcon>{{ item.icon }}</mat-icon>
              <span matListItemTitle>
                {{ item.text }}
                @if (item.link) {
                  <a [href]="item.link" target="_blank" rel="noopener">Meeting link</a>
                }
              </span>
              <span matListItemLine>{{ item.when }}</span>
            </mat-list-item>
          }
        </mat-list>

        @if (showFinish()) {
          <h3>Finish your recovery</h3>
          <p>Enough backup code shares are in. Everything below happens in this tab; a step that fails can be run again.</p>
          @if (finishBusy()) {
            <mat-progress-bar mode="indeterminate"></mat-progress-bar>
          }
          @if (finishError(); as text) {
            <p class="error">{{ text }}</p>
          }
          <mat-stepper linear orientation="vertical" #finish>
            <mat-step [completed]="combined() !== null" [editable]="false" label="Combine">
              <p>The shares the bankers sent are opened with this case's key and put back together: your backup code and your break-glass seeds.</p>
              @if (combined(); as c) {
                <p class="result">{{ combinedText(c) }}</p>
              }
              <button mat-flat-button type="button" (click)="combine(finish)" [disabled]="finishBusy()">Combine</button>
            </mat-step>

            <mat-step [completed]="backIn()" [editable]="false" label="Get back in">
              <p>
                Your backup code opens your encryption key and proves itself to the masterpod, which makes this case's passkey your anoPod's
                passkey. Then you unlock as usual, here, with that passkey: pick it when asked.
              </p>
              <button mat-flat-button type="button" (click)="getBackIn(finish)" [disabled]="finishBusy()">Get back in</button>
            </mat-step>

            <mat-step [completed]="breakGlass() !== null" [editable]="false" label="Break-glass keys">
              <p>Each recovered break-glass seed is matched to its anos account and stored there under your encryption key.</p>
              @if (breakGlass(); as b) {
                <p class="result">{{ breakGlassText(b) }}</p>
              }
              <button mat-flat-button type="button" (click)="storeBreakGlass(finish)" [disabled]="finishBusy()">Store break-glass keys</button>
            </mat-step>

            <mat-step [completed]="deposited()" [editable]="false" label="New backup code">
              <p>Your old backup code went through the bankers' hands: make a new one. It replaces the old one on the masterpod and is deposited with the keyholders.</p>
              @if (newCodeText(); as code) {
                <h4>Your new backup code</h4>
                <p>Write it down and keep it somewhere safe. It is shown once and never again.</p>
                <p class="code">{{ code }}</p>
                <button mat-flat-button type="button" (click)="completeRotation(finish)" [disabled]="finishBusy()">
                  {{ rotated() ? 'Retry the deposit' : 'I have written it down, complete' }}
                </button>
              } @else if (deposited()) {
                <p class="result">Your old backup code is now worthless.</p>
              } @else {
                <button mat-flat-button type="button" (click)="makeNewCode()" [disabled]="finishBusy()">Make a new backup code</button>
              }
            </mat-step>

            <mat-step [completed]="completed()" label="Done">
              @if (completed()) {
                <p class="result">You're back in.</p>
                <button mat-flat-button type="button" (click)="continueToWallet()">Continue</button>
              } @else {
                <p>Close the case: the lost device's passkey and session no longer unlock anything.</p>
                <button mat-flat-button type="button" (click)="complete()" [disabled]="finishBusy()">Complete my recovery</button>
              }
            </mat-step>
          </mat-stepper>
        }
      </mat-card-content>
      <mat-card-actions class="actions">
        <button mat-stroked-button type="button" (click)="refresh()" [disabled]="busy()">Refresh</button>
        <a mat-button routerLink="/recover">Recover account</a>
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
  protected readonly breakGlass = signal<BreakGlassResult | null>(null);
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
    const email = this.recovery.contactEmail() ?? 'your email';
    switch (this.recovery.status()) {
      case 'open':
        return `Open: a moderator will contact you at ${email} and meet you on a video call`;
      case 'inReview':
        return 'In review: a moderator is checking your case';
      case 'approved':
        return 'Approved: the bankers are sending your keys';
      case 'delivering':
        return `Delivering: ${this.backupShares()} of ${this.threshold()} backup code shares received`;
      case 'completed':
        return 'Completed: you are back in';
      case 'dismissed':
        return `Dismissed: ${this.dismissReason(this.recovery.pod())}`;
      default:
        return 'Loading your case…';
    }
  });

  protected readonly timeline = computed<TimelineItem[]>(() =>
    (this.recovery.pod()?.events ?? []).map((event, i) => ({
      key: `${i}-${event.kind}-${event.createdAt}`,
      icon: this.iconOf(event),
      text: this.textOf(event),
      link: event.kind === 'scheduled' && typeof event.details['meetLink'] === 'string' ? event.details['meetLink'] : null,
      when: new Date(event.createdAt).toLocaleString(),
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
      this.error.set('No recovery session: continue the recovery with your passkey.');
      return;
    }
    const res = await this.api.getRecoveryPod(envelope, quiet);
    if (!this.recovery.hasSession()) return;
    if (res.ok) {
      this.recovery.applyPod(res.body);
      this.error.set(null);
    } else if (res.status === 401) {
      this.error.set('Your recovery session has ended. Go to Recover account and continue the recovery with your passkey.');
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
      this.error.set('Could not copy; select the id by hand.');
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
      if (!hybrid || !pod || !lookupId) throw new Error('The recovery pod is not open in this tab: go to Recover account and continue the recovery with your passkey.');
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
      if (codes.length === 0) throw new Error(`No backup code could be rebuilt: ${shareThreshold} shares of one key id that open with this case's key are needed.`);
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
      if (!this.session.getEncryptionKey()) throw new Error('The unlock did not open your encryption key; pick the passkey made for this case and try again.');
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
    if (!caseId || !kekPrf) throw new Error('The recovery pod is not open in this tab: go to Recover account and continue the recovery with your passkey.');
    if (!blob2) throw new Error('The masterpod has not handed over your second key blob yet; refresh once the case is approved.');
    if (codes.length === 0) throw new Error('Combine first.');

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
      throw new Error('The rebuilt backup code does not open your key blob. If you already rotated your backup code in an earlier attempt, you are not locked out any more: unlock from the start page with this passkey.');
    }
    const newBlob1 = await this.crypto.encrypt(kekPrf, encryptionKey);
    const challenge = await this.api.challenge('recover');
    if (!challenge.ok) throw new Error(`/challenge: ${reasonOf(challenge)}`);
    const payload = { challenge: challenge.body.challenge, caseId, newBlob1: this.crypto.toHex(newBlob1) };
    const res = await this.api.recoverWithBackupCode({ payload, signatures: await this.crypto.backupCodeProof(code, payload) });
    if (!res.ok) {
      const reason = (res.body as unknown as Partial<ApiError>)?.error;
      if (res.status === 401 && reason === 'bad signature') {
        throw new Error('The masterpod does not accept the rebuilt backup code as this anoPod\'s current one. If you already rotated it in an earlier attempt, unlock from the start page with this passkey.');
      }
      if (res.status === 409) throw new Error(`The case does not take the finish right now (${reasonOf(res)}); refresh and try again.`);
      throw new Error(`/recover-with-backup-code: ${reasonOf(res)}`);
    }
    this.recovered = true;
    this.recoveredCode = code;
  }

  /**
   * Step 3, Break-glass keys: /list-anos-accounts; each recovered seed finds
   * the account whose creation names its two derived public keys and is
   * stored there under the encryption key.
   */
  protected async storeBreakGlass(stepper: MatStepper): Promise<void> {
    await this.runStep(async () => {
      const encryptionKey = this.session.getEncryptionKey();
      if (!encryptionKey) throw new Error('Your encryption key is not in this tab: get back in first.');
      const listed = await this.api.listAnosAccounts();
      if (!listed.ok) throw new Error(`/list-anos-accounts: ${reasonOf(listed)}`);
      this.session.accounts.set(listed.body.accounts);
      const stored: string[] = [];
      let unmatched = 0;
      for (const seed of this.recovery.getBreakGlassSeeds()) {
        const keys = await this.crypto.breakGlassKeys(seed);
        const account = this.accountOfBreakGlassKeys(listed.body.accounts, this.crypto.toHex(keys.breakGlassKey.publicKey), this.crypto.toHex(keys.breakGlassPostQuantumKey.publicKey));
        if (!account) {
          unmatched += 1;
          continue;
        }
        const blob = await this.crypto.wrapBreakGlassSeed(seed, encryptionKey);
        const res = await this.api.storeBreakGlassBlob(account.accountId, this.crypto.toHex(blob));
        if (!res.ok) throw new Error(`/store-break-glass-blob: ${reasonOf(res)}`);
        stored.push(account.accountId);
      }
      this.breakGlass.set({ stored, unmatched });
    }, stepper);
  }

  /** The account whose creation.payload.publicKeys names these two break-glass keys (masterpod 12.6), or undefined. */
  private accountOfBreakGlassKeys(accounts: AnosAccountListItem[], p256Hex: string, mldsaHex: string): AnosAccountListItem | undefined {
    return accounts.find((account) => {
      const keys = account.creation.payload['publicKeys'];
      if (typeof keys !== 'object' || keys === null) return false;
      const named = keys as Record<string, unknown>;
      return named['breakGlassKey'] === p256Hex && named['breakGlassPostQuantumKey'] === mldsaHex;
    });
  }

  /** Step 4, first half: a fresh backup code, its blob2 and keys, shown once as on Setup. */
  protected async makeNewCode(): Promise<void> {
    this.finishError.set(null);
    const encryptionKey = this.session.getEncryptionKey();
    if (!encryptionKey) {
      this.finishError.set('Your encryption key is not in this tab: get back in first.');
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
   * Step 4, Complete: /rotate-backup-code with the new blob2 and keys and the
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
      if (!code || !blob2 || !keys) throw new Error('Make a new backup code first.');
      if (!anopodId) throw new Error('No session in this tab: get back in first.');
      if (!this.rotated()) {
        const oldCode = this.recoveredCode;
        if (!oldCode) throw new Error('The current backup code is not in this tab: combine and get back in first.');
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
        if (err instanceof DepositError) throw new Error(`${err.message}. Retry deposits the same new code again under a fresh key id.`);
        throw err;
      }
      this.deposited.set(true);
      this.newCode = null;
      this.newBlob2 = null;
      this.newKeys = null;
      this.newCodeText.set(null);
    }, stepper);
  }

  /** Step 5, Done: /complete-recovery-case with the recovery envelope; a case already completed counts as done. */
  protected async complete(): Promise<void> {
    await this.runStep(async () => {
      const envelope = this.recovery.sign('/complete-recovery-case', {});
      if (!envelope) throw new Error('No recovery session: go to Recover account and continue the recovery with your passkey.');
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
    const codes = c.codes === 1 ? 'backup code recovered' : `${c.codes} backup code candidates recovered (the newest is tried first)`;
    const seeds = `${c.seeds} break-glass ${c.seeds === 1 ? 'seed' : 'seeds'} recovered`;
    const skipped = c.skipped > 0 ? ` · ${c.skipped} ${c.skipped === 1 ? 'share' : 'shares'} did not open with this case's key` : '';
    return `${codes} · ${seeds}${skipped}`;
  }

  protected breakGlassText(b: BreakGlassResult): string {
    const stored = b.stored.length === 0 ? 'No break-glass seed was stored' : `Stored on ${b.stored.map((id) => id.slice(0, 8) + '…').join(', ')}`;
    const unmatched = b.unmatched > 0 ? ` · ${b.unmatched} ${b.unmatched === 1 ? 'seed' : 'seeds'} matched no account of yours` : '';
    return `${stored}${unmatched}`;
  }

  private dismissReason(pod: RecoveryPodAnswer | null): string {
    const event = [...(pod?.events ?? [])].reverse().find((e) => e.kind === 'dismissed');
    const reason = typeof event?.details['reason'] === 'string' ? event.details['reason'] : 'other';
    return DISMISS_REASONS[reason] ?? reason;
  }

  private iconOf(event: RecoveryEvent): string {
    return { opened: 'flag', scheduled: 'event', approved: 'verified', dismissed: 'block', recovered: 'key', completed: 'check_circle' }[event.kind] ?? 'circle';
  }

  private textOf(event: RecoveryEvent): string {
    switch (event.kind) {
      case 'opened':
        return 'Case opened';
      case 'scheduled': {
        const at = typeof event.details['at'] === 'string' ? new Date(event.details['at']).toLocaleString() : 'a time to be confirmed';
        return `Video call scheduled for ${at}.`;
      }
      case 'approved':
        return 'Approved by two moderators';
      case 'dismissed':
        return `Dismissed: ${DISMISS_REASONS[String(event.details['reason'])] ?? String(event.details['reason'] ?? '')}`;
      case 'recovered':
        return 'Your passkey is restored: you are back in';
      case 'completed':
        return 'Recovery completed';
      default:
        return event.kind;
    }
  }
}
