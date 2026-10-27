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
import { millionthsToAnos } from '../amounts';
import { CASES_POLL_MS } from '../constants';
import { AnosApiService } from '../services/anos-api.service';
import { AttestingService, attestingError } from '../services/attesting.service';
import { ConfigService } from '../services/config.service';
import { AttestationPayload, CryptoService, FollowUp, PairOne } from '../services/crypto.service';
import { BucketKeyAnswer, KeyholderApiService, ShareType } from '../services/keyholder-api.service';
import { ApiResponse, reasonOf } from '../services/log.service';
import {
  ATTESTOR_DISMISS_REASONS,
  AttestorDismissReason,
  CaseEvent,
  MasterpodApiService,
  SecurityRecords,
  SentResult,
  TradeCaseAnswer,
} from '../services/masterpod-api.service';
import { SessionService } from '../services/session.service';
import { SigningService } from '../services/signing.service';
import { DISMISS_WORDS, REVIEW_STATUSES, STATUS_ICONS, STATUS_WORDS } from './attesting.page';

/** The two buckets: the keyholder route, the share type and the masterpod's bucket number of each. */
type Bucket = 1 | 2;
const BUCKETS: Record<Bucket, { title: string; path: string; shareType: ShareType }> = {
  1: { title: 'Bucket one', path: '/get-security-bucket-one-key', shareType: 'securitybucket1' },
  2: { title: 'Bucket two', path: '/get-security-bucket-two-key', shareType: 'securitybucket2' },
};

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

/** A stored attestation: the signer's account id and the follow-up object, from an attestationSigned event. */
interface StoredAttestation {
  signer: string;
  attestation: FollowUp<AttestationPayload>;
}

/** The sending of a decided case: the stored attestations, the ones no validator answer has accepted yet, and the last answers. */
interface Sending {
  attestations: StoredAttestation[];
  pending: StoredAttestation[];
  tried: boolean;
  lastResults: SentResult[];
}

/** The results of a sent event's details, or none. */
function resultsOf(event: CaseEvent | undefined): SentResult[] {
  const results = event?.details['results'];
  return Array.isArray(results) ? (results as SentResult[]) : [];
}

function accepted(result: SentResult): boolean {
  return result.status >= 200 && result.status < 300;
}

/**
 * Trade case (wallet spec 13.3, /attesting/trade/:caseId, the attestor
 * edition), from /get-trade-case, refreshed by a button and every 15 s: the
 * person, the trade (the amount and the receiver from the Trades list cached
 * in AttestingService), the timeline with the acting attestors, Schedule,
 * the lookup id once the person shared it, the two buckets (the moderation
 * case page's pull, pointed at /list-trade-case-security-records: a
 * one-time hybrid pair, the account envelope signed by pair one of the
 * staked account to every keyholder in parallel, the shares opened and
 * combined, the rows decrypted), Attest (the attestation follow-up built as
 * the account page builds one, then /sign-off-trade-case), Send to the
 * validators once the case is decided (the stored attestations posted to
 * /attestation and /mark-attestor-case-sent; run at once on the page whose
 * signature decided the case), and Dismiss behind a confirmation.
 */
@Component({
  selector: 'app-attesting-trade-case-page',
  imports: [DatePipe, FormsModule, RouterLink, MatCardModule, MatButtonModule, MatListModule, MatIconModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatProgressBarModule],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>Trade case <code class="id">{{ caseId() }}</code></mat-card-title>
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
          <a mat-button routerLink="/attesting"><mat-icon>arrow_back</mat-icon> Attesting</a>
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
              <div><span class="label">Status</span><span class="value">{{ words[d.case.status] }} · opened {{ d.case.createdAt | date: 'medium' }}</span></div>
            </div>
          </div>

          <h3>The trade</h3>
          <div class="facts">
            <div>
              <span class="label">Amount</span>
              <span class="value">
                @if (trade(); as t) { {{ millionthsToAnos(t.amount) }} anos · made {{ t.createdAt | date: 'medium' }} } @else { not on the validator's list of trades waiting for attestors (decided, or cancelled) }
              </span>
            </div>
            <div><span class="label">Sender account</span><span class="value"><code>{{ d.case.accountId }}</code></span></div>
            @if (trade(); as t) {
              <div>
                <span class="label">Receiver account</span>
                <span class="value"><code>{{ t.accountIdTo }}</code> <button mat-icon-button type="button" (click)="copy('receiver', t.accountIdTo)" aria-label="Copy the receiver's account id"><mat-icon>content_copy</mat-icon></button>@if (copied() === 'receiver') { <span class="muted">copied</span> }</span>
              </div>
            }
            <div>
              <span class="label">Transaction</span>
              <span class="value"><code>{{ d.case.transactionId }}</code> <button mat-icon-button type="button" (click)="copy('transaction', d.case.transactionId)" aria-label="Copy the transaction id"><mat-icon>content_copy</mat-icon></button>@if (copied() === 'transaction') { <span class="muted">copied</span> }</span>
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
            <button mat-flat-button type="button" (click)="schedule()" [disabled]="busy() || final() || !canSchedule()">Save</button>
          </div>
          @if (scheduleOutcome(); as o) { <p [class.error]="!o.ok" [class.ok]="o.ok">{{ o.text }}</p> }

          <h3>Your account</h3>
          <p class="muted">The spending account that holds your attestor stake signs the key requests and the attestation.</p>
          <div class="form">
            <mat-form-field appearance="outline" class="wide">
              <mat-label>Anos account</mat-label>
              <mat-select [value]="attesting.accountId()" (valueChange)="attesting.accountId.set($event)">
                @for (account of session.accounts(); track account.accountId) {
                  <mat-option [value]="account.accountId">{{ account.accountType }} · {{ account.accountId }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
            @if (session.accounts().length === 0) {
              <span class="muted">No anos account: create one on the Wallet page and stake it for attestor.</span>
            }
          </div>

          <h3>The lookup id</h3>
          @if (d.case.lookupId; as lookupId) {
            <p class="value"><code>{{ lookupId }}</code> <button mat-icon-button type="button" (click)="copy('lookupId', lookupId)" aria-label="Copy the lookup id"><mat-icon>content_copy</mat-icon></button>@if (copied() === 'lookupId') { <span class="muted">copied</span> }</p>
          } @else if (final()) {
            <p class="muted">The lookup id was cleared when the case closed.</p>
          } @else {
            <p class="muted">Waiting for the person to share their lookup id from their Cases page.</p>
          }

          @for (bucket of bucketNumbers; track bucket) {
            <h3>{{ bucketTitle(bucket) }}</h3>
            <div class="row">
              <button mat-flat-button type="button" (click)="pull(bucket)" [disabled]="buckets[bucket].busy() || !attesting.accountId() || !d.case.lookupId">Pull key</button>
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

          <h3>Attest</h3>
          @if (signOffs().length > 0) {
            <p class="muted">Signed so far: {{ signOffs().join(', ') }}.</p>
          }
          <p class="muted">Your attestation is the validators' own follow-up object, signed by pair one of your staked account and by the wallet pair; the masterpod keeps it and posts it once two attestors have signed.</p>
          <div class="form">
            <button mat-flat-button type="button" (click)="attest()" [disabled]="busy() || final() || !attesting.accountId()">Sign the attestation</button>
          </div>
          @if (attestOutcome(); as o) { <p [class.error]="!o.ok" [class.ok]="o.ok">{{ o.text }}</p> }

          @if (sending(); as s) {
            <h3>Send to the validators</h3>
            @if (s.pending.length === 0) {
              <p class="ok">Sent: every attestation was accepted by the validator. The trade joins the next leader round.</p>
            } @else {
              <p class="muted">{{ s.pending.length }} of {{ s.attestations.length }} attestations still to send to the default validator.</p>
              <div class="form">
                <button mat-flat-button type="button" (click)="send()" [disabled]="sendBusy()">{{ s.tried ? 'Retry' : 'Send to the validators' }}</button>
              </div>
            }
            @if (sendBusy()) {
              <mat-progress-bar mode="indeterminate"></mat-progress-bar>
            }
            @if (s.lastResults.length > 0) {
              <ul class="texts">
                @for (r of s.lastResults; track r.signer) {
                  <li>Attestation by <code>{{ r.signer.slice(0, 16) }}…</code> → HTTP {{ r.status }}{{ r.error ? ': ' + r.error : ' accepted' }}</li>
                }
              </ul>
            }
            @if (sendOutcome(); as o) { <p [class.error]="!o.ok" [class.ok]="o.ok">{{ o.text }}</p> }
          }

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
              <button mat-stroked-button type="button" (click)="confirmingDismiss.set(true)" [disabled]="busy() || final()">Dismiss</button>
            }
          </div>
          @if (confirmingDismiss()) {
            <p class="error">Dismissing is final: the case closes, the lookup id is cleared, and the trade stays held on the validators until its sender cancels it.</p>
          }
          @if (dismissOutcome(); as o) { <p [class.error]="!o.ok" [class.ok]="o.ok">{{ o.text }}</p> }
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
export class AttestingTradeCasePage {
  readonly caseId = input.required<string>();

  protected readonly session = inject(SessionService);
  protected readonly attesting = inject(AttestingService);
  private readonly masterpod = inject(MasterpodApiService);
  private readonly keyholders = inject(KeyholderApiService);
  private readonly anos = inject(AnosApiService);
  private readonly signing = inject(SigningService);
  private readonly config = inject(ConfigService);
  private readonly crypto = inject(CryptoService);

  protected readonly millionthsToAnos = millionthsToAnos;
  protected readonly words = STATUS_WORDS;
  protected readonly icons = STATUS_ICONS;
  protected readonly reasons = ATTESTOR_DISMISS_REASONS;
  protected readonly reasonWords = DISMISS_WORDS;
  protected readonly bucketNumbers: Bucket[] = [1, 2];

  protected readonly data = signal<TradeCaseAnswer | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly copied = signal<string | null>(null);

  protected readonly scheduleAt = signal('');
  protected readonly meetLink = signal('');
  protected readonly scheduleOutcome = signal<Outcome | null>(null);
  protected readonly attestOutcome = signal<Outcome | null>(null);
  protected readonly sendBusy = signal(false);
  protected readonly sendOutcome = signal<Outcome | null>(null);
  protected readonly reason = signal<AttestorDismissReason>('selfieMismatch');
  protected readonly dismissNote = signal('');
  protected readonly confirmingDismiss = signal(false);
  protected readonly dismissOutcome = signal<Outcome | null>(null);

  protected readonly buckets: Record<Bucket, BucketState> = {
    1: { view: signal<BucketView | null>(null), busy: signal(false), step: signal(''), error: signal<string | null>(null) },
    2: { view: signal<BucketView | null>(null), busy: signal(false), step: signal(''), error: signal<string | null>(null) },
  };

  /** The validator's lists were fetched once for this page when the trade was not in the cache. */
  private listsTried = false;

  protected readonly canSchedule = computed(() => this.scheduleAt() !== '' && /^https:\/\/\S+$/.test(this.meetLink().trim()) && this.meetLink().trim().length <= 500);

  /** True once the case is decided or dismissed: nothing more is written to it. */
  protected readonly final = computed(() => {
    const status = this.data()?.case.status;
    return status !== undefined && !REVIEW_STATUSES.includes(status);
  });

  /** The trade as the validator listed it, from the service's cache: the amount, the receiver, when it was made. */
  protected readonly trade = computed(() => {
    const transactionId = this.data()?.case.transactionId;
    return transactionId ? this.attesting.tradeOf(transactionId) : null;
  });

  protected readonly timeline = computed<TimelineItem[]>(() => (this.data()?.events ?? []).map((event) => this.itemOf(event)));

  /** Who has signed, from the events: "attestorjoy, attestorsam". */
  protected readonly signOffs = computed(() =>
    (this.data()?.events ?? []).filter((e) => e.kind === 'attestationSigned').map((e) => e.username ?? 'an attestor'),
  );

  /** The sending, once the case is decided: the stored attestations, the ones not yet accepted by the validator, the last answers. */
  protected readonly sending = computed<Sending | null>(() => {
    const d = this.data();
    if (!d || d.case.status !== 'decided') return null;
    const attestations: StoredAttestation[] = [];
    for (const event of d.events) {
      if (event.kind !== 'attestationSigned') continue;
      const signer = event.details['attestorId'];
      const attestation = event.details['attestation'];
      if (typeof signer === 'string' && attestation && typeof attestation === 'object') attestations.push({ signer, attestation: attestation as FollowUp<AttestationPayload> });
    }
    const sent = d.events.filter((e) => e.kind === 'sent');
    const acceptedSigners = new Set(sent.flatMap(resultsOf).filter(accepted).map((r) => r.signer));
    return {
      attestations,
      pending: attestations.filter((a) => !acceptedSigners.has(a.signer)),
      tried: sent.length > 0,
      lastResults: resultsOf(sent.at(-1)),
    };
  });

  constructor() {
    effect(() => {
      this.caseId();
      untracked(() => void this.refresh());
    });
    void this.attesting.loadAccounts();
    const timer = setInterval(() => void this.load(true), CASES_POLL_MS);
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
    const res = await this.masterpod.getTradeCase(this.caseId(), quiet);
    if (res.ok) {
      this.data.set(res.body);
      this.error.set(null);
      if (!this.trade() && !this.listsTried && this.attesting.accountId() !== '') {
        this.listsTried = true;
        await this.attesting.loadLists(true).catch(() => undefined);
      }
    } else if (res.status === 404) {
      this.error.set('No trade case with this id.');
    } else {
      this.error.set(attestingError(res, '/get-trade-case'));
    }
  }

  // --- schedule --------------------------------------------------------------------

  protected schedule(): Promise<void> {
    return this.act(this.scheduleOutcome, async () => {
      const at = new Date(this.scheduleAt());
      if (Number.isNaN(at.getTime())) throw new Error('Enter the time of the call.');
      const res = await this.masterpod.scheduleAttestorCase(this.caseId(), at.toISOString(), this.meetLink().trim());
      if (!res.ok) throw new Error(this.refusal(res, '/schedule-attestor-case'));
      return `Scheduled for ${at.toLocaleString()}; the person sees the link on their case page.`;
    });
  }

  // --- the buckets (the moderation case page's pull, pointed at the trade case) --------

  /**
   * Pull key (wallet spec 13.3): a one-time hybrid pair; the account envelope
   * for the keyholder route signed by pair one of the staked account, to
   * every keyholder in parallel; the shares opened with the pair and the aad
   * lookupId || shareType || keyId, grouped by keyId; bucket one combines the
   * newest group with at least shareThreshold shares, bucket two every such
   * group; then /list-trade-case-security-records and the rows whose keyId
   * was combined decrypted and shown.
   */
  protected async pull(bucket: Bucket): Promise<void> {
    const state = this.buckets[bucket];
    state.busy.set(true);
    state.error.set(null);
    try {
      const d = this.data();
      if (!d) throw new Error('The case has not loaded yet.');
      if (!d.case.lookupId) throw new Error('The person has not shared their lookup id yet.');
      state.step.set('Opening pair one of your account…');
      const { account, pairOne } = await this.attesting.pairOne();
      state.step.set('Asking the keyholders for the bucket key…');
      const { keys, answered } = await this.pullKeys(bucket, pairOne, account.accountId, d.case.lookupId);
      state.step.set('Reading the rows from the masterpod…');
      const res = await this.masterpod.listTradeCaseSecurityRecords(this.caseId(), bucket);
      if (!res.ok) throw new Error(attestingError(res, '/list-trade-case-security-records'));
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

  /** The keyholders' refusals in words (wallet spec 13.3, keyholder 13.1). */
  private pullRefusal(res: ApiResponse<unknown>, refused: number, keyholders: number): string {
    const reason = reasonOf(res);
    if (res.status === 403 && /not a moderator or attestor/.test(reason)) return 'This account holds no attestor stake: the keyholders refused it.';
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

  // --- attest, send, dismiss -----------------------------------------------------

  /**
   * The attestation follow-up (wallet spec 13.3), built as the account page
   * builds one: pair one of the staked account, attestorId the account,
   * accountId the sender, transactionId the trade's, the wallet pair from
   * /api/sign; then /sign-off-trade-case. When the answer says decided this
   * signature decided the case and the sending runs at once.
   */
  protected async attest(): Promise<void> {
    let decided = false;
    await this.act(this.attestOutcome, async () => {
      const d = this.data();
      if (!d) throw new Error('The case has not loaded yet.');
      const { account, pairOne } = await this.attesting.pairOne();
      const followUp = this.crypto.buildFollowUp(pairOne, { type: 'attestation', transactionId: d.case.transactionId, accountId: d.case.accountId, attestorId: account.accountId });
      const signed = await this.signing.sign(followUp);
      const res = await this.masterpod.signOffTradeCase(this.caseId(), signed);
      if (!res.ok) throw new Error(this.refusal(res, '/sign-off-trade-case'));
      decided = res.body.status === 'decided';
      return decided ? 'Signed: two attestations, the case is decided. Sending both to the validators…' : `Signed: ${res.body.signOffs} of 2 attestations.`;
    });
    if (decided) await this.send();
  }

  /**
   * Send to the validators (wallet spec 13.3): the stored attestations no
   * validator answer has accepted yet, posted one after the other to the
   * default validator's /attestation, then /mark-attestor-case-sent with the
   * answers (a refusal recorded too); Retry posts the ones still pending.
   */
  protected async send(): Promise<void> {
    const sending = this.sending();
    if (!sending || this.sendBusy()) return;
    this.sendBusy.set(true);
    this.sendOutcome.set(null);
    try {
      if (sending.pending.length === 0) throw new Error('Every attestation has been accepted already.');
      const results: SentResult[] = [];
      for (const { signer, attestation } of sending.pending) {
        const res = await this.anos.attestation(attestation);
        results.push(res.ok ? { signer, status: res.status } : { signer, status: res.status, error: reasonOf(res).slice(0, 500) });
      }
      const { defaultValidator } = await this.config.load();
      const marked = await this.masterpod.markAttestorCaseSent(this.caseId(), defaultValidator, results);
      if (!marked.ok) throw new Error(this.refusal(marked, '/mark-attestor-case-sent'));
      const failed = results.filter((r) => !accepted(r));
      this.sendOutcome.set(
        failed.length === 0
          ? { ok: true, text: `Sent: validator ${defaultValidator} accepted ${results.length === 1 ? 'the attestation' : 'both attestations'}.` }
          : { ok: false, text: `Validator ${defaultValidator} refused ${failed.length} of ${results.length}; the answers are recorded on the case. Retry sends the refused ones again.` },
      );
    } catch (err) {
      this.sendOutcome.set({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      this.sendBusy.set(false);
      await this.load(true);
    }
  }

  protected dismiss(): Promise<void> {
    this.confirmingDismiss.set(false);
    return this.act(this.dismissOutcome, async () => {
      const res = await this.masterpod.dismissAttestorCase(this.caseId(), this.reason(), this.dismissNote().trim());
      if (!res.ok) throw new Error(this.refusal(res, '/dismiss-attestor-case'));
      return 'Dismissed. The person sees the reason on their case page; the trade stays held until its sender cancels it.';
    });
  }

  /** An attestor route's refusal in words (masterpod 13.4.2, 13.4.4). */
  private refusal(res: ApiResponse<unknown>, path: string): string {
    const reason = reasonOf(res);
    if (res.status === 409 && /already signed off/.test(reason)) return 'This anoPod already signed this case.';
    if (res.status === 409 && /case closed/.test(reason)) return 'This case is closed: nothing more can be done to it.';
    if (res.status === 409 && /case not decided/.test(reason)) return 'The case is not decided yet: nothing to send.';
    if (res.status === 403 && /not your account/.test(reason)) return 'This account is not one of this anoPod\'s accounts.';
    if (res.status === 401 && /bad signature/.test(reason)) return 'The masterpod refused the signature: the account\'s stored keys do not match.';
    if (res.status === 400 && /does not match the case/.test(reason)) return 'The attestation names another trade or sender than this case.';
    if (res.status === 400) return `${path}: the masterpod refused the values (${reason}).`;
    return attestingError(res, path);
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
    const who = event.username ?? (event.anopodId ? `pod ${event.anopodId.slice(0, 8)}…` : 'an attestor');
    const note = typeof d['note'] === 'string' && d['note'] !== '' ? `Note: ${d['note']}` : null;
    const keys = Array.isArray(d['keyIds']) ? d['keyIds'].length : 0;
    let icon = 'circle';
    let text = event.kind;
    let link: string | null = null;
    switch (event.kind) {
      case 'opened':
        [icon, text] = ['flag', `${who} opened the case`];
        break;
      case 'lookupIdShared':
        [icon, text] = ['fingerprint', 'The person shared their lookup id'];
        break;
      case 'scheduled':
        [icon, text] = ['event', `${who} scheduled the video call for ${typeof d['at'] === 'string' ? new Date(d['at']).toLocaleString() : 'a time to be confirmed'}`];
        link = typeof d['meetLink'] === 'string' ? d['meetLink'] : null;
        break;
      case 'bucketOneViewed':
      case 'bucketTwoViewed':
        [icon, text] = ['visibility', `${who} read bucket ${event.kind === 'bucketOneViewed' ? 'one' : 'two'} (${keys} key${keys === 1 ? '' : 's'})`];
        break;
      case 'attestationSigned':
        [icon, text] = ['draw', `${who} signed an attestation with account ${typeof d['attestorId'] === 'string' ? d['attestorId'].slice(0, 8) + '…' : '?'}`];
        break;
      case 'decided':
        [icon, text] = ['verified', 'Decided: two attestors signed'];
        break;
      case 'lookupIdCleared':
        [icon, text] = ['delete', 'The lookup id was cleared from the case'];
        break;
      case 'sent':
        [icon, text] = ['send', `${who} posted to validator ${String(d['validator'] ?? '?')}: ${resultsOf(event).map((r) => `${r.signer.slice(0, 8)}… HTTP ${r.status}${r.error ? ' ' + r.error : ''}`).join(', ')}`];
        break;
      case 'dismissed':
        [icon, text] = ['block', `${who} dismissed the case: ${DISMISS_WORDS[d['reason'] as AttestorDismissReason] ?? String(d['reason'] ?? '')}`];
        break;
    }
    return { key: event.eventId, icon, text, note, link, when: new Date(event.createdAt).toLocaleString() };
  }
}
