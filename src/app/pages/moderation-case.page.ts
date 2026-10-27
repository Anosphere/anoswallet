import { DatePipe } from '@angular/common';
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
import { ConfigService } from '../services/config.service';
import { CryptoService, PairOne } from '../services/crypto.service';
import { BucketKeyAnswer, KeyholderApiService, ShareType } from '../services/keyholder-api.service';
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
import { STATUS_ICONS, STATUS_WORDS, moderationError } from './moderation.page';

/** A dismissal's preset reason in words, as the moderators read it. */
const DISMISS_WORDS: Record<DismissReason, string> = {
  selfieMismatch: 'the selfie did not match',
  documentsMismatch: 'the documents did not match',
  unknownLookupId: 'the keyholders know no identity with this lookup id',
  noShow: 'the person did not join the call',
  other: 'another reason',
};

/** The two buckets: the keyholder route, the share type and the masterpod's bucket number of each. */
type Bucket = 1 | 2;
const BUCKETS: Record<Bucket, { title: string; path: string; shareType: ShareType }> = {
  1: { title: 'Bucket one', path: '/get-security-bucket-one-key', shareType: 'securitybucket1' },
  2: { title: 'Bucket two', path: '/get-security-bucket-two-key', shareType: 'securitybucket2' },
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
  imports: [DatePipe, FormsModule, RouterLink, MatCardModule, MatButtonModule, MatListModule, MatIconModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatProgressBarModule],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>Case <code class="id">{{ caseId() }}</code></mat-card-title>
        <mat-card-subtitle>
          @if (data(); as d) {
            <mat-icon class="inline">{{ icons[d.case.status] }}</mat-icon> {{ words[d.case.status] }}
          } @else {
            Loading the case…
          }
        </mat-card-subtitle>
      </mat-card-header>
      <mat-card-content>
        <div class="row">
          <a mat-button routerLink="/moderation"><mat-icon>arrow_back</mat-icon> Cases</a>
          <button mat-stroked-button type="button" (click)="refresh()" [disabled]="busy()">Refresh</button>
          @if (busy()) {
            <mat-progress-bar mode="indeterminate" class="grow"></mat-progress-bar>
          }
        </div>
        @if (error(); as text) {
          <p class="error">{{ text }}</p>
        }

        @if (data(); as d) {
          <h3>The person</h3>
          <div class="person">
            @if (d.profile?.selfie; as selfie) {
              <img class="selfie" [src]="'data:' + selfie.contentType + ';base64,' + selfie.image" alt="public selfie" />
            }
            <div class="facts">
              <div><span class="label">Username</span><span class="value">{{ d.profile?.username ?? 'unknown pod' }}</span></div>
              <div><span class="label">Name</span><span class="value">{{ d.profile?.firstName }} {{ d.profile?.lastName }}</span></div>
              <div>
                <span class="label">Email</span>
                <span class="value">{{ d.case.contactEmail }} <button mat-icon-button type="button" (click)="copy('email', d.case.contactEmail)" aria-label="Copy the email"><mat-icon>content_copy</mat-icon></button>@if (copied() === 'email') { <span class="muted">copied</span> }</span>
              </div>
              <div>
                <span class="label">Lookup id</span>
                <span class="value"><code>{{ d.case.lookupId }}</code> <button mat-icon-button type="button" (click)="copy('lookupId', d.case.lookupId)" aria-label="Copy the lookup id"><mat-icon>content_copy</mat-icon></button>@if (copied() === 'lookupId') { <span class="muted">copied</span> }</span>
              </div>
              <div><span class="label">Status</span><span class="value">{{ words[d.case.status] }} · opened {{ d.case.createdAt | date: 'medium' }}</span></div>
            </div>
          </div>

          <h3>Timeline</h3>
          <mat-list dense>
            @for (item of timeline(); track item.key) {
              <mat-list-item [lines]="item.note ? 3 : 2">
                <mat-icon matListItemIcon>{{ item.icon }}</mat-icon>
                <span matListItemTitle>
                  {{ item.text }}
                  @if (item.link) {
                    <a [href]="item.link" target="_blank" rel="noopener">Meeting link</a>
                  }
                </span>
                @if (item.note) {
                  <span matListItemLine class="note">{{ item.note }}</span>
                }
                <span matListItemLine>{{ item.when }}</span>
              </mat-list-item>
            }
          </mat-list>

          <h3>Schedule</h3>
          <div class="form">
            <mat-form-field appearance="outline">
              <mat-label>Video call</mat-label>
              <input matInput type="datetime-local" [ngModel]="scheduleAt()" (ngModelChange)="scheduleAt.set($event)" />
            </mat-form-field>
            <mat-form-field appearance="outline" class="wide">
              <mat-label>Meeting link (https)</mat-label>
              <input matInput [ngModel]="meetLink()" (ngModelChange)="meetLink.set($event)" placeholder="https://meet.example/…" />
            </mat-form-field>
            <button mat-flat-button type="button" (click)="schedule()" [disabled]="busy() || !canSchedule()">Save</button>
          </div>
          @if (scheduleOutcome(); as o) { <p [class.error]="!o.ok" [class.ok]="o.ok">{{ o.text }}</p> }

          <h3>Your account</h3>
          <p class="muted">The spending account that holds your moderator stake signs the key requests and the sign-off.</p>
          <div class="form">
            <mat-form-field appearance="outline" class="wide">
              <mat-label>Anos account</mat-label>
              <mat-select [value]="accountId()" (valueChange)="accountId.set($event)">
                @for (account of session.accounts(); track account.accountId) {
                  <mat-option [value]="account.accountId">{{ account.accountType }} · {{ account.accountId }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
            @if (session.accounts().length === 0) {
              <span class="muted">No anos account: create one on the Wallet page and stake it for moderator.</span>
            }
          </div>

          @for (bucket of bucketNumbers; track bucket) {
            <h3>{{ bucketTitle(bucket) }}</h3>
            <div class="row">
              <button mat-flat-button type="button" (click)="pull(bucket)" [disabled]="buckets[bucket].busy() || !accountId()">Pull key</button>
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
                {{ view.answered }} keyholders answered · {{ view.keyIds.length }} key{{ view.keyIds.length === 1 ? '' : 's' }} combined ·
                {{ view.images.length }} image{{ view.images.length === 1 ? '' : 's' }}, {{ view.texts.length }} text{{ view.texts.length === 1 ? '' : 's' }} opened
                @if (view.locked > 0) { · {{ view.locked }} row{{ view.locked === 1 ? '' : 's' }} under other keys }
              </p>
              <div class="thumbs">
                @for (image of view.images; track image.url) {
                  <a [href]="image.url" target="_blank" rel="noopener"><img [src]="image.url" alt="bucket image" /></a>
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

          <h3>Sign off</h3>
          @if (signOffs().length > 0) {
            <p class="muted">Signed off so far: {{ signOffs().join(', ') }}.</p>
          }
          <div class="form">
            <mat-form-field appearance="outline">
              <mat-label>Verdict</mat-label>
              <mat-select [value]="verdict()" (valueChange)="verdict.set($event)">
                <mat-option value="approve">Approve</mat-option>
                <mat-option value="reject">Reject</mat-option>
              </mat-select>
            </mat-form-field>
            <mat-form-field appearance="outline" class="wide">
              <mat-label>Note</mat-label>
              <input matInput [ngModel]="signNote()" (ngModelChange)="signNote.set($event)" maxlength="2000" placeholder="Passport and selfie match; called at 14:00 UTC." />
            </mat-form-field>
            <button mat-flat-button type="button" (click)="signOff()" [disabled]="busy() || !accountId()">Sign</button>
          </div>
          @if (signOutcome(); as o) { <p [class.error]="!o.ok" [class.ok]="o.ok">{{ o.text }}</p> }

          <h3>Dismiss</h3>
          <div class="form">
            <mat-form-field appearance="outline">
              <mat-label>Reason</mat-label>
              <mat-select [value]="reason()" (valueChange)="reason.set($event)">
                @for (r of reasons; track r) {
                  <mat-option [value]="r">{{ reasonWords[r] }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
            <mat-form-field appearance="outline" class="wide">
              <mat-label>Note</mat-label>
              <input matInput [ngModel]="dismissNote()" (ngModelChange)="dismissNote.set($event)" maxlength="2000" />
            </mat-form-field>
            @if (confirmingDismiss()) {
              <button mat-flat-button type="button" class="danger" (click)="dismiss()" [disabled]="busy()">Confirm dismissal</button>
              <button mat-button type="button" (click)="confirmingDismiss.set(false)">Cancel</button>
            } @else {
              <button mat-stroked-button type="button" (click)="confirmingDismiss.set(true)" [disabled]="busy()">Dismiss</button>
            }
          </div>
          @if (confirmingDismiss()) {
            <p class="error">Dismissing is final: the case closes and the person must open a new one.</p>
          }
          @if (dismissOutcome(); as o) { <p [class.error]="!o.ok" [class.ok]="o.ok">{{ o.text }}</p> }

          @if (packet(); as packet) {
            <h3>Banker packet</h3>
            <p class="muted">What the bankers' GUI takes: the lookup id, the recovery pod's URL and its hybrid key.</p>
            <div class="facts">
              <div><span class="label">Lookup id</span><span class="value"><code>{{ packet.lookupId }}</code> <button mat-icon-button type="button" (click)="copy('packetLookupId', packet.lookupId)" aria-label="Copy the lookup id"><mat-icon>content_copy</mat-icon></button>@if (copied() === 'packetLookupId') { <span class="muted">copied</span> }</span></div>
              <div><span class="label">URL</span><span class="value"><code>{{ packet.url }}</code> <button mat-icon-button type="button" (click)="copy('url', packet.url)" aria-label="Copy the URL"><mat-icon>content_copy</mat-icon></button>@if (copied() === 'url') { <span class="muted">copied</span> }</span></div>
              <div><span class="label">Hybrid key</span><span class="value"><code>{{ packet.hybridKeyJson }}</code> <button mat-icon-button type="button" (click)="copy('hybridKey', packet.hybridKeyJson)" aria-label="Copy the hybrid key"><mat-icon>content_copy</mat-icon></button>@if (copied() === 'hybridKey') { <span class="muted">copied</span> }</span></div>
            </div>
            <div class="row">
              <button mat-stroked-button type="button" (click)="copy('all', packet.all)">Copy all</button>
              @if (copied() === 'all') { <span class="muted">copied</span> }
            </div>
            <h4>Shares received</h4>
            @if (d.shares.length === 0) {
              <p class="muted">None yet.</p>
            } @else {
              <ul class="texts">
                @for (share of d.shares; track share.keyholderId + share.shareType + share.keyId) {
                  <li>Keyholder {{ share.keyholderId }} · {{ share.shareType }} · key <code>{{ share.keyId.slice(0, 8) }}…</code> · {{ share.receivedAt | date: 'medium' }}</li>
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
  private readonly masterpod = inject(MasterpodApiService);
  private readonly keyholders = inject(KeyholderApiService);
  private readonly config = inject(ConfigService);
  private readonly crypto = inject(CryptoService);

  protected readonly words = STATUS_WORDS;
  protected readonly icons = STATUS_ICONS;
  protected readonly reasons = DISMISS_REASONS;
  protected readonly reasonWords = DISMISS_WORDS;
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
      .map((e) => `${e.username ?? 'a moderator'} ${e.kind === 'approvalSigned' ? 'approved' : 'rejected'}`),
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
    return BUCKETS[bucket].title;
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
      this.error.set('No case with this id.');
    } else {
      this.error.set(moderationError(res, '/get-recovery-case'));
    }
  }

  /** The moderator's anos accounts, for the picker; the first spending one is picked. */
  private async loadAccounts(): Promise<void> {
    if (this.session.accounts().length === 0) {
      const res = await this.masterpod.listAnosAccounts(true);
      if (res.ok) this.session.accounts.set(res.body.accounts);
    }
    if (this.accountId() === '') {
      const accounts = this.session.accounts();
      const first = accounts.find((a) => a.accountType === 'spending') ?? accounts[0];
      if (first) this.accountId.set(first.accountId);
    }
  }

  /** The picked account and pair one out of its keyBlob, for one signature; the caller drops it. */
  private async pairOne(): Promise<{ account: AnosAccountItem; pairOne: PairOne }> {
    const account = this.session.accounts().find((a) => a.accountId === this.accountId());
    const encryptionKey = this.session.getEncryptionKey();
    if (!account) throw new Error('Pick one of your anos accounts first.');
    if (!encryptionKey) throw new Error('The encryption key is not in RAM: unlock again.');
    return { account, pairOne: await this.crypto.pairOneFromKeyBlob(this.crypto.fromHex(account.keyBlob), encryptionKey) };
  }

  // --- schedule --------------------------------------------------------------------

  protected schedule(): Promise<void> {
    return this.act(this.scheduleOutcome, async () => {
      const at = new Date(this.scheduleAt());
      if (Number.isNaN(at.getTime())) throw new Error('Enter the time of the call.');
      const res = await this.masterpod.scheduleRecoveryCase(this.caseId(), at.toISOString(), this.meetLink().trim());
      if (!res.ok) throw new Error(this.refusal(res, '/schedule-recovery-case'));
      return `Scheduled for ${at.toLocaleString()}; the person sees the link on their case page.`;
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
      if (!d) throw new Error('The case has not loaded yet.');
      state.step.set('Opening pair one of your account…');
      const { account, pairOne } = await this.pairOne();
      state.step.set('Asking the keyholders for the bucket key…');
      const { keys, answered } = await this.pullKeys(bucket, pairOne, account.accountId, d.case.lookupId);
      state.step.set('Reading the rows from the masterpod…');
      const res = await this.masterpod.listCaseSecurityRecords(this.caseId(), bucket);
      if (!res.ok) throw new Error(moderationError(res, '/list-case-security-records'));
      state.step.set('Decrypting…');
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
            throw new Error(`A share from keyholder ${n} did not open with the response key.`);
          }
          const group = groups.get(item.keyId) ?? { createdAt: item.createdAt, shares: [] };
          if (item.createdAt > group.createdAt) group.createdAt = item.createdAt;
          group.shares.push(share);
          groups.set(item.keyId, group);
        }
      }
      const complete = [...groups.entries()].filter(([, g]) => g.shares.length >= shareThreshold).sort((a, b) => b[1].createdAt.localeCompare(a[1].createdAt));
      if (complete.length === 0) {
        throw new Error(groups.size === 0 ? 'The keyholders hold no key for this bucket.' : `No bucket key has ${shareThreshold} shares among the keyholders that answered.`);
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
    if (res.status === 403 && /not a moderator/.test(reason)) return 'This account holds no moderator stake: the keyholders refused it.';
    if (res.status === 404 && /unknown lookup id/.test(reason)) return 'The keyholders know no identity with this lookup id.';
    if (res.status === 401 && /unknown account/.test(reason)) return 'This account is not on the ledger yet.';
    return `${refused} of ${keyholders} keyholders refused or did not answer (${reason}).`;
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
      if (res.body.status === 'approved') return 'Signed. The case is approved: the banker packet is below.';
      return `Signed: ${this.verdict() === 'approve' ? 'approved' : 'rejected'}. ${res.body.approvals} of 2 approvals.`;
    });
  }

  protected dismiss(): Promise<void> {
    this.confirmingDismiss.set(false);
    return this.act(this.dismissOutcome, async () => {
      const res = await this.masterpod.dismissRecoveryCase(this.caseId(), this.reason(), this.dismissNote().trim());
      if (!res.ok) throw new Error(this.refusal(res, '/dismiss-recovery-case'));
      return 'Dismissed. The person sees the reason on their case page and may open a new case.';
    });
  }

  /** A moderator route's refusal in words. */
  private refusal(res: ApiResponse<unknown>, path: string): string {
    const reason = reasonOf(res);
    if (res.status === 409 && /already signed off/.test(reason)) return 'This anoPod already signed off on this case.';
    if (res.status === 409 && /case closed/.test(reason)) return 'This case is closed: nothing more can be done to it.';
    if (res.status === 403 && /not your account/.test(reason)) return 'This account is not one of this anoPod\'s accounts.';
    if (res.status === 401 && /bad signature/.test(reason)) return 'The masterpod refused the signature: the account\'s stored keys do not match.';
    if (res.status === 400) return `${path}: the masterpod refused the values (${reason}).`;
    return moderationError(res, path);
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
      this.error.set('Could not copy; select the text by hand.');
    }
  }

  private itemOf(event: CaseEvent): TimelineItem {
    const d = event.details;
    const who = event.username ?? (event.anopodId ? `pod ${event.anopodId.slice(0, 8)}…` : 'a moderator');
    const note = typeof d['note'] === 'string' && d['note'] !== '' ? `Note: ${d['note']}` : null;
    const keys = Array.isArray(d['keyIds']) ? d['keyIds'].length : 0;
    let icon = 'circle';
    let text = event.kind;
    let link: string | null = null;
    switch (event.kind) {
      case 'opened':
        [icon, text] = ['flag', 'Case opened by the person'];
        break;
      case 'scheduled':
        [icon, text] = ['event', `${who} scheduled the video call for ${typeof d['at'] === 'string' ? new Date(d['at']).toLocaleString() : 'a time to be confirmed'}`];
        link = typeof d['meetLink'] === 'string' ? d['meetLink'] : null;
        break;
      case 'bucketOneViewed':
      case 'bucketTwoViewed':
        [icon, text] = ['visibility', `${who} read bucket ${event.kind === 'bucketOneViewed' ? 'one' : 'two'} (${keys} key${keys === 1 ? '' : 's'})`];
        break;
      case 'approvalSigned':
        [icon, text] = ['thumb_up', `${who} approved`];
        break;
      case 'rejectionSigned':
        [icon, text] = ['thumb_down', `${who} rejected`];
        break;
      case 'approved':
        [icon, text] = ['verified', 'Approved: two moderators signed off'];
        break;
      case 'dismissed':
        [icon, text] = ['block', `${who} dismissed the case: ${DISMISS_WORDS[d['reason'] as DismissReason] ?? String(d['reason'] ?? '')}`];
        break;
      case 'shareReceived':
        [icon, text] = ['local_shipping', `Keyholder ${String(d['keyholderId'] ?? '?')} delivered a ${String(d['shareType'] ?? '')} share`];
        break;
      case 'recovered':
        [icon, text] = ['key', 'The person recovered their passkey'];
        break;
      case 'completed':
        [icon, text] = ['check_circle', 'The person completed the recovery'];
        break;
    }
    return { key: event.eventId, icon, text, note, link, when: new Date(event.createdAt).toLocaleString() };
  }
}
