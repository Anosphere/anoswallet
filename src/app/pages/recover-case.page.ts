import { Component, DestroyRef, Injector, afterNextRender, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatStepper, MatStepperModule } from '@angular/material/stepper';
import { Router, RouterLink } from '@angular/router';
import { AccountCreationService } from '../services/account-creation.service';
import { AnosApiService } from '../services/anos-api.service';
import { ConfigService, WalletConfig } from '../services/config.service';
import { AccountType, BackupCodeKeys, BreakGlassKeys, CryptoService } from '../services/crypto.service';
import { LanguageService } from '../services/language.service';
import { ApiError, reasonOf } from '../services/log.service';
import { BreakGlassMoveToFile, MasterpodApiService, RotationMessage } from '../services/masterpod-api.service';
import { Bytes, PasskeyService } from '../services/passkey.service';
import { RECOVERY_POLL_MS, RecoveryEvent, RecoveryPodAnswer, RecoveryService } from '../services/recovery.service';
import { AnosAccountItem, SessionService } from '../services/session.service';
import { DepositError, SharesService } from '../services/shares.service';
import { shortId } from '../short-id';
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

/** What Move your money did: the moves filed (this run's and the ones found filed already), the accounts with no anos, the seeds that matched no account, and how many seeds there were (none: nothing to move). */
interface Moved {
  filed: number;
  empty: number;
  unmatched: number;
  seeds: number;
}

/** A seed matched to its account: the two break-glass keys it derives and the account whose creation names them. */
interface MatchedAccount {
  keys: BreakGlassKeys;
  account: AnosAccountItem;
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
 * appears as a second stepper (Combine, Get back in, Move your money, New
 * key for the bankers, Done; the money before the new key since
 * 2026-11-10, recovery finish order plan 1, because a reload after the new
 * key landed shut the person out of the money step), each step retryable,
 * the ordinary unlock reused from unlock.ts and the deposit from
 * SharesService; the combined code and seeds live in RecoveryService while
 * it runs and die with the tab. The backup code is the secret the
 * keyholders hold in shares, and the person never sees one (2026-11-10,
 * wallet spec 11): the screens call it the key the bankers keep, and the
 * fourth step makes the new one, deposits it with the keyholders and then
 * rotates it on the masterpod, without showing it. Move your
 * money (2026-11-08, break-glass plan 1, step 5, in place of the Break-glass
 * keys step that stored the seeds): the old accounts' keys died with the
 * lost passkey, so for each account that holds anos a new account of the
 * same type is opened (account-creation.service) and a breakGlassTransfer
 * of the whole balance into it is signed by the recovered seed's
 * break-glass pair, posted to the validator and filed on the masterpod for
 * the attestors, each move by itself as soon as it is on the validators; a
 * move the validators already hold is filed as it stands there; then the
 * seeds are wiped. The one place in the wallet that uses a break-glass key.
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

            <mat-step [completed]="moved() !== null" [editable]="false" [label]="t().recoverCase.stepMove">
              <p>{{ t().recoverCase.moveText }}</p>
              @if (moved(); as m) {
                <p class="result">{{ movedText(m) }}</p>
              }
              <button mat-flat-button type="button" (click)="moveMoney(finish)" [disabled]="finishBusy()">{{ t().recoverCase.moveMoney }}</button>
            </mat-step>

            <mat-step [completed]="rotated()" [editable]="false" [label]="t().recoverCase.stepNewCode">
              <p>{{ t().recoverCase.newCodeText }}</p>
              @if (rotated()) {
                <p class="result">{{ t().recoverCase.oldCodeWorthless }}</p>
              } @else {
                <button mat-flat-button type="button" (click)="completeRotation(finish)" [disabled]="finishBusy()">
                  {{ deposited() ? t().common.retry : depositFailed() ? t().recoverCase.retryDeposit : t().recoverCase.makeNewCode }}
                </button>
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
    .actions { padding: 16px; gap: 8px; }
    a { margin-left: 8px; }
  `,
})
export class RecoverCasePage {
  protected readonly recovery = inject(RecoveryService);
  private readonly api = inject(MasterpodApiService);
  private readonly anos = inject(AnosApiService);
  private readonly creation = inject(AccountCreationService);
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
  /** The new key's shares are with the keyholders; only the masterpod call is left (a retry repeats that call alone). */
  protected readonly deposited = signal(false);
  /** A deposit of the new key was tried and failed (a retry deposits the same new code again). */
  protected readonly depositFailed = signal(false);
  /** The masterpod took the new key: the step is done. */
  protected readonly rotated = signal(false);
  protected readonly moved = signal<Moved | null>(null);
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

  /** Step 4, first half: a fresh backup code, its blob2 and keys, kept in this page's fields and never shown. Run by completeRotation when none is held yet; a missing encryption key throws, as a step's failure does. */
  private async makeNewCode(): Promise<void> {
    const encryptionKey = this.session.getEncryptionKey();
    if (!encryptionKey) throw new Error(this.t().recoverCase.noKeyInTab);
    const code = this.crypto.newBackupCode();
    this.newCode = code;
    this.newBlob2 = await this.crypto.encrypt(await this.crypto.deriveKekBackup(code), encryptionKey);
    this.newKeys = await this.crypto.backupCodeKeys(code);
  }

  /**
   * Step 4, the one button (the keyholders first since 2026-11-10, recovery
   * finish order plan 1: until then the masterpod was told first, and a tab
   * closed between the two left an anoPod whose shares rebuilt a key the
   * masterpod no longer held):
   * 1. The new code made when none is held yet (makeNewCode).
   * 2. The old code is still in the tab, checked before anything is
   *    deposited: the masterpod call needs it for the proof.
   * 3. The deposit of the new code as backupcode under a fresh keyId
   *    through SharesService, once. A failed deposit: Retry deposits the
   *    same new code again.
   * 4. /rotate-backup-code with the new blob2 and keys and the proof by the
   *    old code. A failure here: Retry repeats this call alone. A call that
   *    was refused or got no answer may have landed all the same (a lost
   *    answer, after which the old code's proof is refused), so the case is
   *    read again (rotationLanded): with the new blob2 on the masterpod the
   *    step is done, else the refusal is thrown.
   * 5. The old code, the new code, its blob2 and its keys dropped.
   */
  protected async completeRotation(stepper: MatStepper): Promise<void> {
    await this.runStep(async () => {
      if (!this.newCode) await this.makeNewCode();
      const code = this.newCode;
      const blob2 = this.newBlob2;
      const keys = this.newKeys;
      const anopodId = this.session.anopodId();
      if (!code || !blob2 || !keys) throw new Error(this.t().recoverCase.makeCodeFirst);
      if (!anopodId) throw new Error(this.t().recoverCase.noSessionInTab);
      const oldCode = this.recoveredCode;
      if (!oldCode) throw new Error(this.t().recoverCase.noCurrentCode);
      if (!this.deposited()) {
        try {
          await this.shares.deposit(code, 'backupcode');
        } catch (err) {
          this.depositFailed.set(true);
          if (err instanceof DepositError) throw new Error(this.t().recoverCase.retryDeposits(err.message));
          throw err;
        }
        this.depositFailed.set(false);
        this.deposited.set(true);
      }
      const message: RotationMessage = {
        anopodId,
        newBackupCodePublicKey: this.crypto.toHex(keys.p256Public),
        newBackupCodePublicKeyPq: this.crypto.toHex(keys.mldsaPublic),
        newBlob2: this.crypto.toHex(blob2),
      };
      const res = await this.api.rotateBackupCode({ ...message, proof: await this.crypto.backupCodeProof(oldCode, message) });
      if (!res.ok && !(await this.rotationLanded(blob2))) throw new Error(`/rotate-backup-code: ${reasonOf(res)}`);
      this.rotated.set(true);
      this.recoveredCode = null;
      this.newCode = null;
      this.newBlob2 = null;
      this.newKeys = null;
    }, stepper);
  }

  /**
   * Whether the masterpod holds `blob2`, the new code's, as the pod's blob2
   * right now: asked when /rotate-backup-code was refused or got no answer.
   * /get-recovery-pod with the recovery envelope, quietly; true when the
   * answer is ok and its blob2 is the hex of `blob2`, false in every other
   * case, a missing recovery session included. An ok answer is kept as the
   * poll keeps one.
   */
  private async rotationLanded(blob2: Bytes): Promise<boolean> {
    const envelope = this.recovery.sign('/get-recovery-pod', {});
    if (!envelope) return false;
    const res = await this.api.getRecoveryPod(envelope, true);
    if (!this.recovery.hasSession() || !res.ok) return false;
    this.recovery.applyPod(res.body);
    this.error.set(null);
    return res.body.blob2 === this.crypto.toHex(blob2);
  }

  /**
   * Step 3, Move your money (wallet spec 12.3; break-glass plan 1, 5.4;
   * before the new key, with the read of the held move and a filing per
   * move, since 2026-11-10, recovery finish order plan 1):
   * 1. /list-anos-accounts into the session; each recovered seed's two
   *    break-glass public keys find the account whose creation names them;
   *    a seed that matches none is unmatched.
   * 2. The moves /list-my-break-glass-moves already lists count as filed.
   * 3. Every other matched account is read with /get-assisted-transfer and
   *    /get-account, both signed by its break-glass pair (the validator
   *    accepts it since the user keys are gone). A held breakGlassTransfer
   *    is a move to file, with the transaction id and the receiving account
   *    the validator holds: an earlier run posted it and its filing never
   *    reached the masterpod. Else a balance of 0 is empty. Else the
   *    account is one to move. An account the validators do not know (the
   *    first read refused with 401 unknown account, the test
   *    balances.service uses for an account that has not landed) never
   *    reached the ledger: it is empty too, and its second read is not
   *    made. Every other refused read stops the step. Every read is made
   *    before anything is written.
   * 4. Each move to file is filed (fileMove), and no new account is made
   *    for its old account.
   * 5. For each account to move: a new account of the same type through
   *    account-creation.service, waited for on the ledger; the
   *    breakGlassTransfer of the whole balance into it, chained on the
   *    latest transaction id read, dated the type's lock plus the offset
   *    ahead (guarded, vault) or now, signed by the break-glass pair alone,
   *    to /anos-transfer. When the validator refuses it or gives no answer,
   *    /get-assisted-transfer is read again: a breakGlassTransfer held there
   *    is the move, as the validator holds it; anything else is the refusal
   *    it is, so an account's own transaction still waiting on the
   *    validators stops the step. Then the move is filed (fileMove), before
   *    the next account is touched.
   * 6. The seeds wiped and dropped from RecoveryService; the result line.
   * The step is complete when the run ended without an error, even with
   * nothing to move; Retry runs it again and skips what is filed. A page
   * refresh loses the seeds: Combine again, and the step then files what
   * the validators hold without a second new account.
   */
  protected async moveMoney(stepper: MatStepper): Promise<void> {
    await this.runStep(async () => {
      const words = this.t().recoverCase;
      const caseId = this.recovery.caseId();
      if (!caseId) throw new Error(words.podNotOpen);
      if (!this.session.anopodId()) throw new Error(words.noSessionInTab);

      // 1. The accounts and the seeds.
      const listed = await this.api.listAnosAccounts();
      if (!listed.ok) throw new Error(`/list-anos-accounts: ${reasonOf(listed)}`);
      this.session.accounts.set(listed.body.accounts);
      const seeds = this.recovery.getBreakGlassSeeds();
      const matched: MatchedAccount[] = [];
      let unmatched = 0;
      for (const seed of seeds) {
        const keys = await this.crypto.breakGlassKeys(seed);
        const account = this.accountOfBreakGlassKeys(listed.body.accounts, this.crypto.toHex(keys.breakGlassKey.publicKey), this.crypto.toHex(keys.breakGlassPostQuantumKey.publicKey));
        if (account) matched.push({ keys, account });
        else unmatched += 1;
      }

      // 2. What is filed already.
      const cases = await this.api.listMyBreakGlassMoves();
      if (!cases.ok) throw new Error(`/list-my-break-glass-moves: ${reasonOf(cases)}`);
      const filedBefore = new Set(cases.body.cases.flatMap((c) => c.moves.map((m) => m.accountId)));

      // 3. The reads, with each other account's break-glass pair: a break-glass move the validators already hold, else the balance.
      const config = await this.config.load();
      let filed = 0;
      let empty = 0;
      const toFile: BreakGlassMoveToFile[] = [];
      const toMove: { keys: BreakGlassKeys; account: AnosAccountItem; balance: bigint; previous: string; ahead: number }[] = [];
      for (const { keys, account } of matched) {
        if (filedBefore.has(account.accountId)) {
          filed += 1;
          continue;
        }
        const held = await this.anos.getAssistedTransferAs(this.crypto.signAccountEnvelopeAsBreakGlass(keys, account.accountId, '/get-assisted-transfer', {}));
        if (!held.ok) {
          // An account the validators do not know never reached the ledger, so it holds nothing: empty, and on to the next account.
          if (held.status === 401 && /unknown account/.test(reasonOf(held))) {
            empty += 1;
            continue;
          }
          throw new Error(`/get-assisted-transfer: ${reasonOf(held)}`);
        }
        const read = await this.anos.getAccountAs(this.crypto.signAccountEnvelopeAsBreakGlass(keys, account.accountId, '/get-account', {}));
        if (!read.ok) throw new Error(`/get-account: ${reasonOf(read)}`);
        const transfer = held.body.transfer;
        if (transfer?.type === 'breakGlassTransfer') {
          toFile.push({ accountId: account.accountId, accountIdTo: transfer.accountIdTo, transactionId: transfer.transactionId });
          continue;
        }
        const balance = BigInt(read.body.balance);
        if (balance === 0n) {
          empty += 1;
          continue;
        }
        if (!read.body.latestTransactionId) throw new Error(this.t().common.noLatest);
        const ahead = this.minutesAhead(account.accountType, config);
        if (ahead === null) throw new Error(this.t().account.lockNotLoaded);
        toMove.push({ keys, account, balance, previous: read.body.latestTransactionId, ahead });
      }

      // 4. The moves the validators already hold, filed as they stand there.
      for (const move of toFile) {
        await this.fileMove(caseId, move);
        filed += 1;
      }

      // 5. A new account of the same type, the move into it, and its filing, before the next account.
      for (const { keys, account, balance, previous, ahead } of toMove) {
        const created = await this.creation.createAccount(account.accountType as AccountType);
        const createdAt = new Date(Date.now() + ahead * 60_000);
        const tx = this.crypto.buildBreakGlassTransferTransaction(keys, account.accountId, previous, created.accountId, balance, createdAt);
        const res = await this.anos.anosTransfer(tx);
        let move: BreakGlassMoveToFile = { accountId: account.accountId, accountIdTo: created.accountId, transactionId: tx.payload.transactionId };
        if (!res.ok) {
          const held = await this.anos.getAssistedTransferAs(this.crypto.signAccountEnvelopeAsBreakGlass(keys, account.accountId, '/get-assisted-transfer', {}));
          const transfer = held.ok ? held.body.transfer : null;
          if (transfer?.type !== 'breakGlassTransfer') throw new Error(words.moveRefused(shortId(account.accountId), reasonOf(res)));
          move = { accountId: account.accountId, accountIdTo: transfer.accountIdTo, transactionId: transfer.transactionId };
        }
        await this.fileMove(caseId, move);
        filed += 1;
      }

      // 6. The seeds wiped.
      for (const seed of seeds) seed.fill(0);
      this.recovery.setCombined([], []);
      this.moved.set({ filed, empty, unmatched, seeds: seeds.length });
    }, stepper);
  }

  /** One break-glass move filed with the masterpod for the attestors (masterpod 14.4.1), in a call of its own, as soon as the move is on the validators: an ok answer, or 409 move already filed, counts as filed; anything else throws. */
  private async fileMove(caseId: string, move: BreakGlassMoveToFile): Promise<void> {
    const res = await this.api.fileBreakGlassMoves(caseId, [move]);
    if (!res.ok && !(res.status === 409 && /move already filed/.test(reasonOf(res)))) throw new Error(`/file-break-glass-moves: ${reasonOf(res)}`);
  }

  /** The account whose creation.payload.publicKeys names these two break-glass keys (hex), or undefined. */
  private accountOfBreakGlassKeys(accounts: AnosAccountItem[], p256Hex: string, mldsaHex: string): AnosAccountItem | undefined {
    return accounts.find((account) => {
      const keys = account.creation.payload['publicKeys'];
      if (typeof keys !== 'object' || keys === null) return false;
      const named = keys as Record<string, unknown>;
      return named['breakGlassKey'] === p256Hex && named['breakGlassPostQuantumKey'] === mldsaHex;
    });
  }

  /** How many minutes ahead a move out of an account of this type is dated, as the account page dates the account's own transfers: 0 from a spending or assisted account; the lock plus the offset from a guarded or vault one, by the proxy's numbers; null when the proxy sent none. */
  private minutesAhead(type: string, config: WalletConfig): number | null {
    if (type !== 'guarded' && type !== 'vault') return 0;
    const lock = type === 'guarded' ? config.guardedLockMinutes : config.vaultLockMinutes;
    const offset = config.lockOffsetMinutes;
    return typeof lock === 'number' && typeof offset === 'number' ? lock + offset : null;
  }

  /** The result line of Move your money: the counts, or that there were no seeds to move with. */
  protected movedText(m: Moved): string {
    const words = this.t().recoverCase;
    return m.seeds === 0 ? words.moveNoSeeds : words.moveResult(m.filed, m.empty, m.unmatched);
  }

  /** Step 5, Done: /complete-recovery-case with the recovery envelope; a case already completed counts as done. */
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
