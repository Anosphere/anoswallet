import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatListModule } from '@angular/material/list';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { RouterLink } from '@angular/router';
import { BalancesService } from '../services/balances.service';
import { ConfigService } from '../services/config.service';
import { CryptoService, PairOne } from '../services/crypto.service';
import { BucketKeyAnswer, KeyholderApiService, ShareType } from '../services/keyholder-api.service';
import { LanguageService } from '../services/language.service';
import { ApiResponse, reasonOf } from '../services/log.service';
import {
  CaseEvent,
  DISMISS_REASONS,
  DismissReason,
  MasterpodApiService,
  RecoveryCaseAnswer,
  SecurityRecords,
  SignOffVerdict,
} from '../services/masterpod-api.service';
import { RECOVERY_POLL_MS } from '../services/recovery.service';
import { AnosAccountItem, SessionService } from '../services/session.service';
import { STATUS_ICONS, moderationError } from './moderation.page';

/** The two buckets: the keyholder route, the share type and the masterpod's bucket number of each; the titles are the dictionary's `buckets`. */
type Bucket = 1 | 2;
const BUCKETS: Record<Bucket, { path: string; shareType: ShareType }> = {
  1: { path: '/get-security-bucket-one-key', shareType: 'securitybucket1' },
  2: { path: '/get-security-bucket-two-key', shareType: 'securitybucket2' },
};

/** The statuses in which the banker packet shows (masterpod 12.4.3's blob2 rule, from the moderator's side). */
const PACKET_STATUSES = ['approved', 'delivering'];

/** One line of the timeline. */
interface TimelineItem {
  key: string;
  icon: string;
  text: string;
  note: string | null;
  link: string | null;
  when: string;
}

/** What a pulled bucket shows: the keys combined, the rows opened with them, and how many rows sit under keys that were not. */
interface BucketView {
  keyIds: string[];
  answered: number;
  images: { url: string; keyId: string; createdAt: string }[];
  texts: { text: string; keyId: string; createdAt: string }[];
  locked: number;
}

/** The page's state for one bucket. */
interface BucketState {
  view: ReturnType<typeof signal<BucketView | null>>;
  busy: ReturnType<typeof signal<boolean>>;
  step: ReturnType<typeof signal<string>>;
  error: ReturnType<typeof signal<string | null>>;
}

interface Outcome {
  ok: boolean;
  text: string;
}

/**
 * Case (wallet spec 12.3, /moderation/:caseId, the moderator edition), from
 * /get-recovery-case, refreshed by a button and every 15 s: the person
 * (selfie, names, the email and the lookup id with Copy, the status), the
 * timeline with the acting moderators, Schedule, the two buckets (Pull key:
 * a one-time hybrid pair, the account envelope signed by pair one of the
 * picked account to every keyholder in parallel, the shares opened and
 * combined, the rows from /list-case-security-records decrypted), Sign off
 * (the 12.6 message signed by pair one), Dismiss behind a confirmation, and
 * the banker packet with Copy once the case is approved.
 */
@Component({
  selector: 'app-moderation-case-page',
  imports: [FormsModule, RouterLink, MatCardModule, MatButtonModule, MatListModule, MatIconModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatProgressBarModule],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>{{ t().moderationCase.title }} <code class="id">{{ caseId() }}</code></mat-card-title>
        <mat-card-subtitle>
          @if (data(); as d) {
            <mat-icon class="inline">{{ icons[d.case.status] }}</mat-icon> {{ t().recoveryStatus[d.case.status] ?? d.case.status }}
          } @else {
            {{ t().common.loadingTheCase }}
          }
        </mat-card-subtitle>
      </mat-card-header>
      <mat-card-content>
        <div class="row">
          <a mat-button routerLink="/moderation"><mat-icon>arrow_back</mat-icon> {{ t().nav.cases }}</a>
          <button mat-stroked-button type="button" (click)="refresh()" [disabled]="busy()">{{ t().common.refresh }}</button>
          @if (busy()) {
            <mat-progress-bar mode="indeterminate" class="grow"></mat-progress-bar>
          }
        </div>
        @if (error(); as text) {
          <p class="error">{{ text }}</p>
        }

        @if (data(); as d) {
          <h3>{{ t().common.thePerson }}</h3>
          <div class="person">
            @if (d.profile?.selfie; as selfie) {
              <img class="selfie" [src]="'data:' + selfie.contentType + ';base64,' + selfie.image" [alt]="t().common.publicSelfie" />
            }
            <div class="facts">
              <div><span class="label">{{ t().common.username }}</span><span class="value">{{ d.profile?.username ?? t().common.unknownPod }}</span></div>
              <div><span class="label">{{ t().common.name }}</span><span class="value">{{ d.profile?.firstName }} {{ d.profile?.lastName }}</span></div>
              @if (d.case.contactEmail; as email) {
                <div>
                  <span class="label">{{ t().common.email }}</span>
                  <span class="value">{{ email }} <button mat-icon-button type="button" (click)="copy('email', email)" [attr.aria-label]="t().moderationCase.copyEmail"><mat-icon>content_copy</mat-icon></button>@if (copied() === 'email') { <span class="muted">{{ t().copy.copied }}</span> }</span>
                </div>
              }
              @if (d.case.contactPhone; as phone) {
                <div>
                  <span class="label">{{ t().common.phone }}</span>
                  <span class="value">{{ phone }} <button mat-icon-button type="button" (click)="copy('phone', phone)" [attr.aria-label]="t().moderationCase.copyPhone"><mat-icon>content_copy</mat-icon></button>@if (copied() === 'phone') { <span class="muted">{{ t().copy.copied }}</span> }</span>
                </div>
              }
              <div>
                <span class="label">{{ t().moderationCase.lookupId }}</span>
                <span class="value"><code>{{ d.case.lookupId }}</code> <button mat-icon-button type="button" (click)="copy('lookupId', d.case.lookupId)" [attr.aria-label]="t().common.copyLookupId"><mat-icon>content_copy</mat-icon></button>@if (copied() === 'lookupId') { <span class="muted">{{ t().copy.copied }}</span> }</span>
              </div>
              <div><span class="label">{{ t().common.status }}</span><span class="value">{{ t().common.statusOpened(t().recoveryStatus[d.case.status] ?? d.case.status, lang.dateTime(d.case.createdAt)) }}</span></div>
            </div>
          </div>

          <h3>{{ t().common.timeline }}</h3>
          <mat-list dense>
            @for (item of timeline(); track item.key) {
              <mat-list-item [lines]="item.note ? 3 : 2">
                <mat-icon matListItemIcon>{{ item.icon }}</mat-icon>
                <span matListItemTitle>
                  {{ item.text }}
                  @if (item.link) {
                    <a [href]="item.link" target="_blank" rel="noopener">{{ t().common.meetingLink }}</a>
                  }
                </span>
                @if (item.note) {
                  <span matListItemLine class="note">{{ item.note }}</span>
                }
                <span matListItemLine>{{ item.when }}</span>
              </mat-list-item>
            }
          </mat-list>

          <h3>{{ t().common.schedule }}</h3>
          <div class="form">
            <mat-form-field appearance="outline">
              <mat-label>{{ t().common.videoCall }}</mat-label>
              <input matInput type="datetime-local" [ngModel]="scheduleAt()" (ngModelChange)="scheduleAt.set($event)" />
            </mat-form-field>
            <mat-form-field appearance="outline" class="wide">
              <mat-label>{{ t().common.meetingLinkHttps }}</mat-label>
              <input matInput [ngModel]="meetLink()" (ngModelChange)="meetLink.set($event)" placeholder="https://meet.example/…" />
            </mat-form-field>
            <button mat-flat-button type="button" (click)="schedule()" [disabled]="busy() || !canSchedule()">{{ t().common.save }}</button>
          </div>
          @if (scheduleOutcome(); as o) { <p [class.error]="!o.ok" [class.ok]="o.ok">{{ o.text }}</p> }

          <h3>{{ t().common.yourAccount }}</h3>
          <p class="muted">{{ t().moderationCase.accountText }}</p>
          <div class="form">
            <mat-form-field appearance="outline" class="wide">
              <mat-label>{{ t().common.anosAccount }}</mat-label>
              <mat-select [value]="accountId()" (valueChange)="accountId.set($event)">
                @for (account of balances.usableAccounts(); track account.accountId) {
                  <mat-option [value]="account.accountId">{{ t().wallet.typeOption(account.accountType) }} · {{ account.accountId }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
            @if (balances.usableAccounts().length === 0) {
              <span class="muted">{{ t().moderationCase.noAccount }}</span>
            }
          </div>

          @for (bucket of bucketNumbers; track bucket) {
            <h3>{{ bucketTitle(bucket) }}</h3>
            <div class="row">
              <button mat-flat-button type="button" (click)="pull(bucket)" [disabled]="buckets[bucket].busy() || !accountId()">{{ t().common.pullKey }}</button>
              @if (buckets[bucket].busy()) {
                <span class="muted">{{ buckets[bucket].step() }}</span>
              }
            </div>
            @if (buckets[bucket].busy()) {
              <mat-progress-bar mode="indeterminate"></mat-progress-bar>
            }
            @if (buckets[bucket].error(); as text) {
              <p class="error">{{ text }}</p>
            }
            @if (buckets[bucket].view(); as view) {
              <p class="muted">
                {{ t().common.bucketSummary(view.answered, view.keyIds.length, view.images.length, view.texts.length) }}
                @if (view.locked > 0) { {{ t().common.bucketLocked(view.locked) }} }
              </p>
              <div class="thumbs">
                @for (image of view.images; track image.url) {
                  <a [href]="image.url" target="_blank" rel="noopener"><img [src]="image.url" [alt]="t().common.bucketImage" /></a>
                }
              </div>
              @if (view.texts.length > 0) {
                <ul class="texts">
                  @for (text of view.texts; track $index) {
                    <li>{{ text.text }}</li>
                  }
                </ul>
              }
            }
          }

          <h3>{{ t().moderationCase.signOff }}</h3>
          @if (signOffs().length > 0) {
            <p class="muted">{{ t().moderationCase.signedSoFar(signOffs().join(', ')) }}</p>
          }
          <div class="form">
            <mat-form-field appearance="outline">
              <mat-label>{{ t().common.verdict }}</mat-label>
              <mat-select [value]="verdict()" (valueChange)="verdict.set($event)">
                <mat-option value="approve">{{ t().common.approve }}</mat-option>
                <mat-option value="reject">{{ t().moderationCase.reject }}</mat-option>
              </mat-select>
            </mat-form-field>
            <mat-form-field appearance="outline" class="wide">
              <mat-label>{{ t().common.note }}</mat-label>
              <input matInput [ngModel]="signNote()" (ngModelChange)="signNote.set($event)" maxlength="2000" [placeholder]="t().moderationCase.notePlaceholder" />
            </mat-form-field>
            <button mat-flat-button type="button" (click)="signOff()" [disabled]="busy() || !accountId()">{{ t().moderationCase.sign }}</button>
          </div>
          @if (signOutcome(); as o) { <p [class.error]="!o.ok" [class.ok]="o.ok">{{ o.text }}</p> }

          <h3>{{ t().common.dismiss }}</h3>
          <div class="form">
            <mat-form-field appearance="outline">
              <mat-label>{{ t().common.reason }}</mat-label>
              <mat-select [value]="reason()" (valueChange)="reason.set($event)">
                @for (r of reasons; track r) {
                  <mat-option [value]="r">{{ t().dismissReasonsStaff[r] ?? r }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
            <mat-form-field appearance="outline" class="wide">
              <mat-label>{{ t().common.note }}</mat-label>
              <input matInput [ngModel]="dismissNote()" (ngModelChange)="dismissNote.set($event)" maxlength="2000" />
            </mat-form-field>
            @if (confirmingDismiss()) {
              <button mat-flat-button type="button" class="danger" (click)="dismiss()" [disabled]="busy()">{{ t().common.confirmDismissal }}</button>
              <button mat-button type="button" (click)="confirmingDismiss.set(false)">{{ t().common.cancel }}</button>
            } @else {
              <button mat-stroked-button type="button" (click)="confirmingDismiss.set(true)" [disabled]="busy()">{{ t().common.dismiss }}</button>
            }
          </div>
          @if (confirmingDismiss()) {
            <p class="error">{{ t().moderationCase.dismissWarning }}</p>
          }
          @if (dismissOutcome(); as o) { <p [class.error]="!o.ok" [class.ok]="o.ok">{{ o.text }}</p> }

          @if (packet(); as packet) {
            <h3>{{ t().moderationCase.packetTitle }}</h3>
            <p class="muted">{{ t().moderationCase.packetText }}</p>
            <div class="facts">
              <div><span class="label">{{ t().moderationCase.lookupId }}</span><span class="value"><code>{{ packet.lookupId }}</code> <button mat-icon-button type="button" (click)="copy('packetLookupId', packet.lookupId)" [attr.aria-label]="t().common.copyLookupId"><mat-icon>content_copy</mat-icon></button>@if (copied() === 'packetLookupId') { <span class="muted">{{ t().copy.copied }}</span> }</span></div>
              <div><span class="label">{{ t().moderationCase.url }}</span><span class="value"><code>{{ packet.url }}</code> <button mat-icon-button type="button" (click)="copy('url', packet.url)" [attr.aria-label]="t().moderationCase.copyUrl"><mat-icon>content_copy</mat-icon></button>@if (copied() === 'url') { <span class="muted">{{ t().copy.copied }}</span> }</span></div>
              <div><span class="label">{{ t().moderationCase.hybridKey }}</span><span class="value"><code>{{ packet.hybridKeyJson }}</code> <button mat-icon-button type="button" (click)="copy('hybridKey', packet.hybridKeyJson)" [attr.aria-label]="t().moderationCase.copyHybridKey"><mat-icon>content_copy</mat-icon></button>@if (copied() === 'hybridKey') { <span class="muted">{{ t().copy.copied }}</span> }</span></div>
            </div>
            <div class="row">
              <button mat-stroked-button type="button" (click)="copy('all', packet.all)">{{ t().moderationCase.copyAll }}</button>
              @if (copied() === 'all') { <span class="muted">{{ t().copy.copied }}</span> }
            </div>
            <h4>{{ t().moderationCase.sharesReceived }}</h4>
            @if (d.shares.length === 0) {
              <p class="muted">{{ t().common.noneYet }}</p>
            } @else {
              <ul class="texts">
                @for (share of d.shares; track share.keyholderId + share.shareType + share.keyId) {
                  <li>{{ t().moderationCase.keyholderShare(share.keyholderId, share.shareType) }} <code>{{ share.keyId.slice(0, 8) }}…</code> · {{ lang.dateTime(share.receivedAt) }}</li>
                }
              </ul>
            }
          }
        }
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    .id { font-size: 13px; }
    .inline { font-size: 18px; width: 18px; height: 18px; vertical-align: text-bottom; }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 8px 0; }
    .grow { flex: 1; min-width: 160px; }
    .form { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 4px; }
    .wide { min-width: 360px; flex: 1; }
    .person { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
    .selfie { width: 160px; height: 160px; object-fit: cover; border-radius: 8px; }
    .facts { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; align-items: center; }
    .facts div { display: contents; }
    .label { color: var(--mat-sys-on-surface-variant); }
    .value { word-break: break-all; }
    .note { white-space: pre-wrap; }
    .thumbs { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0; }
    .thumbs img { width: 160px; height: 120px; object-fit: cover; border-radius: 8px; }
    .texts { margin: 4px 0; padding-left: 20px; }
    .danger { background: var(--mat-sys-error); color: var(--mat-sys-on-error); }
    .muted { color: var(--mat-sys-on-surface-variant); }
    .error { color: var(--mat-sys-error); }
    .ok { color: var(--mat-sys-primary); }
    code { font-size: 12px; word-break: break-all; }
  `,
})
export class ModerationCasePage {
  readonly caseId = input.required<string>();

  protected readonly session = inject(SessionService);
  /** The picker lists the usable accounts only: a lost account, whose keyBlob does not open, is left out (wallet spec 8.2, 2026-11-08). */
  protected readonly balances = inject(BalancesService);
  private readonly masterpod = inject(MasterpodApiService);
  private readonly keyholders = inject(KeyholderApiService);
  private readonly config = inject(ConfigService);
  private readonly crypto = inject(CryptoService);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  protected readonly icons = STATUS_ICONS;
  protected readonly reasons = DISMISS_REASONS;
  protected readonly bucketNumbers: Bucket[] = [1, 2];

  protected readonly data = signal<RecoveryCaseAnswer | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly copied = signal<string | null>(null);

  protected readonly accountId = signal('');
  protected readonly scheduleAt = signal('');
  protected readonly meetLink = signal('');
  protected readonly scheduleOutcome = signal<Outcome | null>(null);
  protected readonly verdict = signal<SignOffVerdict>('approve');
  protected readonly signNote = signal('');
  protected readonly signOutcome = signal<Outcome | null>(null);
  protected readonly reason = signal<DismissReason>('selfieMismatch');
  protected readonly dismissNote = signal('');
  protected readonly confirmingDismiss = signal(false);
  protected readonly dismissOutcome = signal<Outcome | null>(null);

  protected readonly buckets: Record<Bucket, BucketState> = {
    1: { view: signal<BucketView | null>(null), busy: signal(false), step: signal(''), error: signal<string | null>(null) },
    2: { view: signal<BucketView | null>(null), busy: signal(false), step: signal(''), error: signal<string | null>(null) },
  };

  protected readonly canSchedule = computed(() => this.scheduleAt() !== '' && /^https:\/\/\S+$/.test(this.meetLink().trim()) && this.meetLink().trim().length <= 500);

  protected readonly timeline = computed<TimelineItem[]>(() => (this.data()?.events ?? []).map((event) => this.itemOf(event)));

  /** Who has signed what, from the events: "moderatorjoy approved, moderatorsam rejected". */
  protected readonly signOffs = computed(() =>
    (this.data()?.events ?? [])
      .filter((e) => e.kind === 'approvalSigned' || e.kind === 'rejectionSigned')
      .map((e) => this.t().moderationCase.signOffLine(e.username ?? this.t().moderationCase.aModerator, e.kind === 'approvalSigned' ? this.t().moderationCase.approved : this.t().moderationCase.rejected)),
  );

  /** The banker packet, shown once the case is approved or delivering, with the hybrid key as JSON and the three together. */
  protected readonly packet = computed(() => {
    const d = this.data();
    if (!d || !PACKET_STATUSES.includes(d.case.status) || !d.bankerPacket.hybridKey) return null;
    const { lookupId, url, hybridKey } = d.bankerPacket;
    return { lookupId, url, hybridKeyJson: JSON.stringify(hybridKey), all: JSON.stringify({ lookupId, url, hybridKey }, null, 2) };
  });

  constructor() {
    effect(() => {
      this.caseId();
      untracked(() => void this.refresh());
    });
    void this.loadAccounts();
    const timer = setInterval(() => void this.load(true), RECOVERY_POLL_MS);
    const destroy = inject(DestroyRef);
    destroy.onDestroy(() => clearInterval(timer));
    destroy.onDestroy(() => this.dropViews());
  }

  protected bucketTitle(bucket: Bucket): string {
    return bucket === 1 ? this.t().buckets.one : this.t().buckets.two;
  }

  // --- the case ----------------------------------------------------------------

  protected async refresh(): Promise<void> {
    this.busy.set(true);
    try {
      await this.load(false);
    } finally {
      this.busy.set(false);
    }
  }

  private async load(quiet: boolean): Promise<void> {
    const res = await this.masterpod.getRecoveryCase(this.caseId(), quiet);
    if (res.ok) {
      this.data.set(res.body);
      this.error.set(null);
    } else if (res.status === 404) {
      this.error.set(this.t().moderationCase.notFound);
    } else {
      this.error.set(moderationError(res, '/get-recovery-case', this.t()));
    }
  }

  /** The moderator's anos accounts, for the picker; the first usable spending one is picked, a lost account (its keyBlob does not open, 2026-11-08) left out. */
  private async loadAccounts(): Promise<void> {
    if (this.session.accounts().length === 0) {
      const res = await this.masterpod.listAnosAccounts(true);
      if (res.ok) this.session.accounts.set(res.body.accounts);
    }
    if (this.accountId() === '') {
      await this.balances.markLost();
      const accounts = this.balances.usableAccounts();
      const first = accounts.find((a) => a.accountType === 'spending') ?? accounts[0];
      if (first) this.accountId.set(first.accountId);
    }
  }

  /** The picked account and pair one out of its keyBlob, for one signature; the caller drops it. */
  private async pairOne(): Promise<{ account: AnosAccountItem; pairOne: PairOne }> {
    const account = this.session.accounts().find((a) => a.accountId === this.accountId());
    const keyBlobKey = this.session.getKeyBlobKey();
    if (!account) throw new Error(this.t().common.pickAccountFirst);
    if (!keyBlobKey) throw new Error(this.t().common.noKeyBlobKey);
    return { account, pairOne: await this.crypto.pairOneFromKeyBlob(this.crypto.fromHex(account.keyBlob), keyBlobKey) };
  }

  // --- schedule --------------------------------------------------------------------

  protected schedule(): Promise<void> {
    return this.act(this.scheduleOutcome, async () => {
      const at = new Date(this.scheduleAt());
      if (Number.isNaN(at.getTime())) throw new Error(this.t().common.enterCallTime);
      const res = await this.masterpod.scheduleRecoveryCase(this.caseId(), at.toISOString(), this.meetLink().trim());
      if (!res.ok) throw new Error(this.refusal(res, '/schedule-recovery-case'));
      return this.t().common.scheduledPerson(this.lang.dateTime(at));
    });
  }

  // --- the buckets -----------------------------------------------------------------

  /**
   * Pull key (wallet spec 12.3): a one-time hybrid pair; the account
   * envelope for the keyholder route signed by pair one of the picked
   * account, to every keyholder in parallel; the shares opened with the pair
   * and the aad lookupId || shareType || keyId, grouped by keyId; bucket one
   * combines the newest group with at least shareThreshold shares, bucket
   * two every such group; then /list-case-security-records and the rows
   * whose keyId was combined decrypted and shown.
   */
  protected async pull(bucket: Bucket): Promise<void> {
    const state = this.buckets[bucket];
    state.busy.set(true);
    state.error.set(null);
    try {
      const d = this.data();
      if (!d) throw new Error(this.t().common.caseNotLoaded);
      state.step.set(this.t().common.openingPairOne);
      const { account, pairOne } = await this.pairOne();
      state.step.set(this.t().common.askingKeyholders);
      const { keys, answered } = await this.pullKeys(bucket, pairOne, account.accountId, d.case.lookupId);
      state.step.set(this.t().common.readingRows);
      const res = await this.masterpod.listCaseSecurityRecords(this.caseId(), bucket);
      if (!res.ok) throw new Error(moderationError(res, '/list-case-security-records', this.t()));
      state.step.set(this.t().common.decrypting);
      const view = await this.openRows(keys, answered, res.body);
      this.dropView(state.view());
      state.view.set(view);
      await this.load(true);
    } catch (err) {
      state.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      state.busy.set(false);
      state.step.set('');
    }
  }

  /** The bucket keys the keyholders' shares rebuild, by keyId, and how many keyholders answered. */
  private async pullKeys(bucket: Bucket, pairOne: PairOne, accountId: string, lookupId: string): Promise<{ keys: Map<string, Uint8Array>; answered: number }> {
    const { keyholders, shareThreshold } = await this.config.load();
    const { path, shareType } = BUCKETS[bucket];
    const response = this.crypto.generateHybridKeys();
    const responseKey = this.crypto.hybridPublicKeyOf(response);
    try {
      const answers = await Promise.all(
        Array.from({ length: keyholders }, (_, i) => i + 1).map(async (n) => {
          const envelope = this.crypto.signAccountEnvelope(pairOne, accountId, path, { lookupId, responseKey });
          const res: ApiResponse<BucketKeyAnswer> = bucket === 1 ? await this.keyholders.getSecurityBucketOneKey(n, envelope) : await this.keyholders.getSecurityBucketTwoKey(n, envelope);
          return { n, res };
        }),
      );
      const refused = answers.filter((a) => !a.res.ok);
      if (refused.length > keyholders - shareThreshold) throw new Error(this.pullRefusal(refused[0].res, refused.length, keyholders));

      const groups = new Map<string, { createdAt: string; shares: Uint8Array[] }>();
      for (const { n, res } of answers) {
        if (!res.ok) continue;
        for (const item of res.body.shares) {
          let share: Uint8Array;
          try {
            share = await this.crypto.decryptFromHybrid(response, this.crypto.fromHex(item.share), this.crypto.shareAad(lookupId, shareType, item.keyId));
          } catch {
            throw new Error(this.t().common.shareNoOpen(n));
          }
          const group = groups.get(item.keyId) ?? { createdAt: item.createdAt, shares: [] };
          if (item.createdAt > group.createdAt) group.createdAt = item.createdAt;
          group.shares.push(share);
          groups.set(item.keyId, group);
        }
      }
      const complete = [...groups.entries()].filter(([, g]) => g.shares.length >= shareThreshold).sort((a, b) => b[1].createdAt.localeCompare(a[1].createdAt));
      if (complete.length === 0) {
        throw new Error(groups.size === 0 ? this.t().common.noBucketKey : this.t().common.noBucketKeyShares(shareThreshold));
      }
      const keys = new Map<string, Uint8Array>();
      for (const [keyId, group] of bucket === 1 ? complete.slice(0, 1) : complete) {
        keys.set(keyId, await this.crypto.combineShares(group.shares.slice(0, shareThreshold)));
        for (const share of group.shares) share.fill(0);
      }
      return { keys, answered: answers.length - refused.length };
    } finally {
      response.x25519Secret.fill(0);
      response.kemSeed.fill(0);
      response.kemSecret.fill(0);
    }
  }

  /** The keyholders' refusals in words (wallet spec 12.3). */
  private pullRefusal(res: ApiResponse<unknown>, refused: number, keyholders: number): string {
    const reason = reasonOf(res);
    if (res.status === 403 && /not a moderator/.test(reason)) return this.t().moderationCase.noStake;
    if (res.status === 404 && /unknown lookup id/.test(reason)) return this.t().common.unknownLookupId;
    if (res.status === 401 && /unknown account/.test(reason)) return this.t().common.notOnLedger;
    return this.t().common.keyholdersRefused(refused, keyholders, reason);
  }

  /** The rows under a combined key decrypted; the others counted; the keys wiped. */
  private async openRows(keys: Map<string, Uint8Array>, answered: number, records: SecurityRecords): Promise<BucketView> {
    const view: BucketView = { keyIds: [...keys.keys()], answered, images: [], texts: [], locked: 0 };
    for (const image of records.images) {
      const key = keys.get(image.keyId);
      if (!key) {
        view.locked += 1;
        continue;
      }
      const bytes = await this.crypto.decrypt(key, this.crypto.fromBase64(image.image));
      view.images.push({ url: URL.createObjectURL(new Blob([bytes as BlobPart], { type: image.contentType })), keyId: image.keyId, createdAt: image.createdAt });
    }
    for (const info of records.info) {
      const key = keys.get(info.keyId);
      if (!key) {
        view.locked += 1;
        continue;
      }
      view.texts.push({ text: this.crypto.fromUtf8(await this.crypto.decrypt(key, this.crypto.fromBase64(info.info))), keyId: info.keyId, createdAt: info.createdAt });
    }
    for (const key of keys.values()) key.fill(0);
    return view;
  }

  private dropView(view: BucketView | null): void {
    for (const image of view?.images ?? []) URL.revokeObjectURL(image.url);
  }

  private dropViews(): void {
    for (const bucket of this.bucketNumbers) this.dropView(this.buckets[bucket].view());
  }

  // --- sign off and dismiss ------------------------------------------------------

  /** The 12.6 message signed by pair one of the picked account, then /sign-off-recovery-case. */
  protected signOff(): Promise<void> {
    return this.act(this.signOutcome, async () => {
      const { account, pairOne } = await this.pairOne();
      const message = { caseId: this.caseId(), accountId: account.accountId, verdict: this.verdict(), note: this.signNote().trim(), signedAt: new Date().toISOString() };
      const res = await this.masterpod.signOffRecoveryCase({ ...message, signatures: this.crypto.signSignOff(pairOne, message) });
      if (!res.ok) throw new Error(this.refusal(res, '/sign-off-recovery-case'));
      if (res.body.status === 'approved') return this.t().moderationCase.signedApproved;
      return this.t().moderationCase.signed(this.verdict() === 'approve' ? this.t().moderationCase.approved : this.t().moderationCase.rejected, res.body.approvals);
    });
  }

  protected dismiss(): Promise<void> {
    this.confirmingDismiss.set(false);
    return this.act(this.dismissOutcome, async () => {
      const res = await this.masterpod.dismissRecoveryCase(this.caseId(), this.reason(), this.dismissNote().trim());
      if (!res.ok) throw new Error(this.refusal(res, '/dismiss-recovery-case'));
      return this.t().moderationCase.dismissed;
    });
  }

  /** A moderator route's refusal in words. */
  private refusal(res: ApiResponse<unknown>, path: string): string {
    const reason = reasonOf(res);
    if (res.status === 409 && /already signed off/.test(reason)) return this.t().moderationCase.alreadySigned;
    if (res.status === 409 && /case closed/.test(reason)) return this.t().common.caseClosedDone;
    if (res.status === 403 && /not your account/.test(reason)) return this.t().common.notMyAccountSentence;
    if (res.status === 401 && /bad signature/.test(reason)) return this.t().common.badSignature;
    if (res.status === 400) return this.t().common.refusedValues(path, reason);
    return moderationError(res, path, this.t());
  }

  private async act(outcome: ReturnType<typeof signal<Outcome | null>>, action: () => Promise<string>): Promise<void> {
    this.busy.set(true);
    outcome.set(null);
    try {
      outcome.set({ ok: true, text: await action() });
    } catch (err) {
      outcome.set({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      this.busy.set(false);
    }
    await this.load(true);
  }

  // --- copy and the timeline -------------------------------------------------------

  protected async copy(what: string, text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(what);
      setTimeout(() => this.copied.set(null), 2000);
    } catch {
      this.error.set(this.t().common.couldNotCopyText);
    }
  }

  private itemOf(event: CaseEvent): TimelineItem {
    const d = event.details;
    const words = this.t().moderationCase;
    const who = event.username ?? (event.anopodId ? this.t().common.podShort(event.anopodId.slice(0, 8)) : words.aModerator);
    const note = typeof d['note'] === 'string' && d['note'] !== '' ? this.t().common.notePrefix(d['note']) : null;
    const keys = Array.isArray(d['keyIds']) ? d['keyIds'].length : 0;
    let icon = 'circle';
    let text = event.kind;
    let link: string | null = null;
    switch (event.kind) {
      case 'opened':
        [icon, text] = ['flag', words.eventOpened];
        break;
      case 'scheduled':
        [icon, text] = ['event', this.t().common.scheduledBy(who, typeof d['at'] === 'string' ? this.lang.dateTime(d['at']) : this.t().common.timeToBeConfirmed)];
        link = typeof d['meetLink'] === 'string' ? d['meetLink'] : null;
        break;
      case 'bucketOneViewed':
      case 'bucketTwoViewed':
        [icon, text] = ['visibility', this.t().common.readBucket(who, event.kind === 'bucketOneViewed' ? 1 : 2, keys)];
        break;
      case 'approvalSigned':
        [icon, text] = ['thumb_up', words.eventApproved(who)];
        break;
      case 'rejectionSigned':
        [icon, text] = ['thumb_down', words.eventRejected(who)];
        break;
      case 'approved':
        [icon, text] = ['verified', words.eventDecided];
        break;
      case 'dismissed':
        [icon, text] = ['block', this.t().common.dismissedBy(who, this.t().dismissReasonsStaff[String(d['reason'])] ?? String(d['reason'] ?? ''))];
        break;
      case 'shareReceived':
        [icon, text] = ['local_shipping', words.eventShare(String(d['keyholderId'] ?? '?'), String(d['shareType'] ?? ''))];
        break;
      case 'recovered':
        [icon, text] = ['key', words.eventRecovered];
        break;
      case 'completed':
        [icon, text] = ['check_circle', words.eventCompleted];
        break;
    }
    return { key: event.eventId, icon, text, note, link, when: this.lang.dateTime(event.createdAt) };
  }
}
