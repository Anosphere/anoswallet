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
import { LanguageService } from '../services/language.service';
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
import { REVIEW_STATUSES, STATUS_ICONS } from './attesting.page';

/** The two buckets: the keyholder route, the share type and the masterpod's bucket number of each; the titles are the dictionary's `buckets`. */
type Bucket = 1 | 2;
const BUCKETS: Record<Bucket, { path: string; shareType: ShareType }> = {
  1: { path: '/get-security-bucket-one-key', shareType: 'securitybucket1' },
  2: { path: '/get-security-bucket-two-key', shareType: 'securitybucket2' },
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
  imports: [FormsModule, RouterLink, MatCardModule, MatButtonModule, MatListModule, MatIconModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatProgressBarModule],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>{{ t().tradeCase.title }} <code class="id">{{ caseId() }}</code></mat-card-title>
        <mat-card-subtitle>
          @if (data(); as d) {
            <mat-icon class="inline">{{ icons[d.case.status] }}</mat-icon> {{ t().caseStatus[d.case.status] ?? d.case.status }}
          } @else {
            {{ t().common.loadingTheCase }}
          }
        </mat-card-subtitle>
      </mat-card-header>
      <mat-card-content>
        <div class="row">
          <a mat-button routerLink="/attesting"><mat-icon>arrow_back</mat-icon> {{ t().nav.attesting }}</a>
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
              <div><span class="label">{{ t().common.status }}</span><span class="value">{{ t().common.statusOpened(t().caseStatus[d.case.status] ?? d.case.status, lang.dateTime(d.case.createdAt)) }}</span></div>
            </div>
          </div>

          <h3>{{ t().tradeCase.theTrade }}</h3>
          <div class="facts">
            <div>
              <span class="label">{{ t().common.amount }}</span>
              <span class="value">
                @if (trade(); as held) { {{ t().attesting.amountMade(millionthsToAnos(held.amount), lang.dateTime(held.createdAt)) }} } @else { {{ t().tradeCase.notListed }} }
              </span>
            </div>
            <div><span class="label">{{ t().tradeCase.senderAccount }}</span><span class="value"><code>{{ d.case.accountId }}</code></span></div>
            @if (trade(); as held) {
              <div>
                <span class="label">{{ t().tradeCase.receiverAccount }}</span>
                <span class="value"><code>{{ held.accountIdTo }}</code> <button mat-icon-button type="button" (click)="copy('receiver', held.accountIdTo)" [attr.aria-label]="t().tradeCase.copyReceiver"><mat-icon>content_copy</mat-icon></button>@if (copied() === 'receiver') { <span class="muted">{{ t().copy.copied }}</span> }</span>
              </div>
            }
            <div>
              <span class="label">{{ t().common.transaction }}</span>
              <span class="value"><code>{{ d.case.transactionId }}</code> <button mat-icon-button type="button" (click)="copy('transaction', d.case.transactionId)" [attr.aria-label]="t().common.copyTransactionId"><mat-icon>content_copy</mat-icon></button>@if (copied() === 'transaction') { <span class="muted">{{ t().copy.copied }}</span> }</span>
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
            <button mat-flat-button type="button" (click)="schedule()" [disabled]="busy() || final() || !canSchedule()">{{ t().common.save }}</button>
          </div>
          @if (scheduleOutcome(); as o) { <p [class.error]="!o.ok" [class.ok]="o.ok">{{ o.text }}</p> }

          <h3>{{ t().common.yourAccount }}</h3>
          <p class="muted">{{ t().tradeCase.accountText }}</p>
          <div class="form">
            <mat-form-field appearance="outline" class="wide">
              <mat-label>{{ t().common.anosAccount }}</mat-label>
              <mat-select [value]="attesting.accountId()" (valueChange)="attesting.accountId.set($event)">
                @for (account of session.accounts(); track account.accountId) {
                  <mat-option [value]="account.accountId">{{ t().wallet.typeOption(account.accountType) }} · {{ account.accountId }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
            @if (session.accounts().length === 0) {
              <span class="muted">{{ t().attesting.noAccount }}</span>
            }
          </div>

          <h3>{{ t().tradeCase.lookupIdTitle }}</h3>
          @if (d.case.lookupId; as lookupId) {
            <p class="value"><code>{{ lookupId }}</code> <button mat-icon-button type="button" (click)="copy('lookupId', lookupId)" [attr.aria-label]="t().common.copyLookupId"><mat-icon>content_copy</mat-icon></button>@if (copied() === 'lookupId') { <span class="muted">{{ t().copy.copied }}</span> }</p>
          } @else if (final()) {
            <p class="muted">{{ t().tradeCase.lookupIdCleared }}</p>
          } @else {
            <p class="muted">{{ t().tradeCase.waitingLookupId }}</p>
          }

          @for (bucket of bucketNumbers; track bucket) {
            <h3>{{ bucketTitle(bucket) }}</h3>
            <div class="row">
              <button mat-flat-button type="button" (click)="pull(bucket)" [disabled]="buckets[bucket].busy() || !attesting.accountId() || !d.case.lookupId">{{ t().common.pullKey }}</button>
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

          <h3>{{ t().tradeCase.attest }}</h3>
          @if (signOffs().length > 0) {
            <p class="muted">{{ t().tradeCase.signedSoFar(signOffs().join(', ')) }}</p>
          }
          <p class="muted">{{ t().tradeCase.attestText }}</p>
          <div class="form">
            <button mat-flat-button type="button" (click)="attest()" [disabled]="busy() || final() || !attesting.accountId()">{{ t().tradeCase.signAttestation }}</button>
          </div>
          @if (attestOutcome(); as o) { <p [class.error]="!o.ok" [class.ok]="o.ok">{{ o.text }}</p> }

          @if (sending(); as s) {
            <h3>{{ t().attesting.sendTitle }}</h3>
            @if (s.pending.length === 0) {
              <p class="ok">{{ t().tradeCase.sentAll }}</p>
            } @else {
              <p class="muted">{{ t().tradeCase.stillToSend(s.pending.length, s.attestations.length) }}</p>
              <div class="form">
                <button mat-flat-button type="button" (click)="send()" [disabled]="sendBusy()">{{ s.tried ? t().common.retry : t().attesting.sendTitle }}</button>
              </div>
            }
            @if (sendBusy()) {
              <mat-progress-bar mode="indeterminate"></mat-progress-bar>
            }
            @if (s.lastResults.length > 0) {
              <ul class="texts">
                @for (r of s.lastResults; track r.signer) {
                  <li>{{ t().tradeCase.attestationBy }} <code>{{ r.signer.slice(0, 16) }}…</code> → HTTP {{ r.status }}{{ r.error ? ': ' + r.error : t().attesting.accepted }}</li>
                }
              </ul>
            }
            @if (sendOutcome(); as o) { <p [class.error]="!o.ok" [class.ok]="o.ok">{{ o.text }}</p> }
          }

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
              <button mat-stroked-button type="button" (click)="confirmingDismiss.set(true)" [disabled]="busy() || final()">{{ t().common.dismiss }}</button>
            }
          </div>
          @if (confirmingDismiss()) {
            <p class="error">{{ t().tradeCase.dismissWarning }}</p>
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
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  protected readonly millionthsToAnos = millionthsToAnos;
  protected readonly icons = STATUS_ICONS;
  protected readonly reasons = ATTESTOR_DISMISS_REASONS;
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
    (this.data()?.events ?? []).filter((e) => e.kind === 'attestationSigned').map((e) => e.username ?? this.t().attesting.anAttestor),
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
    const res = await this.masterpod.getTradeCase(this.caseId(), quiet);
    if (res.ok) {
      this.data.set(res.body);
      this.error.set(null);
      if (!this.trade() && !this.listsTried && this.attesting.accountId() !== '') {
        this.listsTried = true;
        await this.attesting.loadLists(true).catch(() => undefined);
      }
    } else if (res.status === 404) {
      this.error.set(this.t().tradeCase.notFound);
    } else {
      this.error.set(attestingError(res, '/get-trade-case', this.t()));
    }
  }

  // --- schedule --------------------------------------------------------------------

  protected schedule(): Promise<void> {
    return this.act(this.scheduleOutcome, async () => {
      const at = new Date(this.scheduleAt());
      if (Number.isNaN(at.getTime())) throw new Error(this.t().common.enterCallTime);
      const res = await this.masterpod.scheduleAttestorCase(this.caseId(), at.toISOString(), this.meetLink().trim());
      if (!res.ok) throw new Error(this.refusal(res, '/schedule-attestor-case'));
      return this.t().common.scheduledPerson(this.lang.dateTime(at));
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
      if (!d) throw new Error(this.t().common.caseNotLoaded);
      if (!d.case.lookupId) throw new Error(this.t().tradeCase.noLookupIdYet);
      state.step.set(this.t().common.openingPairOne);
      const { account, pairOne } = await this.attesting.pairOne();
      state.step.set(this.t().common.askingKeyholders);
      const { keys, answered } = await this.pullKeys(bucket, pairOne, account.accountId, d.case.lookupId);
      state.step.set(this.t().common.readingRows);
      const res = await this.masterpod.listTradeCaseSecurityRecords(this.caseId(), bucket);
      if (!res.ok) throw new Error(attestingError(res, '/list-trade-case-security-records', this.t()));
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

  /** The keyholders' refusals in words (wallet spec 13.3, keyholder 13.1). */
  private pullRefusal(res: ApiResponse<unknown>, refused: number, keyholders: number): string {
    const reason = reasonOf(res);
    if (res.status === 403 && /not a moderator or attestor/.test(reason)) return this.t().tradeCase.noStake;
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
      if (!d) throw new Error(this.t().common.caseNotLoaded);
      const { account, pairOne } = await this.attesting.pairOne();
      const followUp = this.crypto.buildFollowUp(pairOne, { type: 'attestation', transactionId: d.case.transactionId, accountId: d.case.accountId, attestorId: account.accountId });
      const signed = await this.signing.sign(followUp);
      const res = await this.masterpod.signOffTradeCase(this.caseId(), signed);
      if (!res.ok) throw new Error(this.refusal(res, '/sign-off-trade-case'));
      decided = res.body.status === 'decided';
      return decided ? this.t().tradeCase.signedDecided : this.t().tradeCase.signedCount(res.body.signOffs);
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
      if (sending.pending.length === 0) throw new Error(this.t().tradeCase.allAccepted);
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
          ? { ok: true, text: this.t().attesting.sentAccepted(defaultValidator, results.length === 1 ? this.t().tradeCase.theAttestation : this.t().tradeCase.bothAttestations) }
          : { ok: false, text: this.t().attesting.validatorRefused(defaultValidator, failed.length, results.length) },
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
      return this.t().tradeCase.dismissed;
    });
  }

  /** An attestor route's refusal in words (masterpod 13.4.2, 13.4.4). */
  private refusal(res: ApiResponse<unknown>, path: string): string {
    const reason = reasonOf(res);
    if (res.status === 409 && /already signed off/.test(reason)) return this.t().tradeCase.alreadySigned;
    if (res.status === 409 && /case closed/.test(reason)) return this.t().common.caseClosedDone;
    if (res.status === 409 && /case not decided/.test(reason)) return this.t().attesting.notDecided;
    if (res.status === 403 && /not your account/.test(reason)) return this.t().common.notMyAccountSentence;
    if (res.status === 401 && /bad signature/.test(reason)) return this.t().common.badSignature;
    if (res.status === 400 && /does not match the case/.test(reason)) return this.t().tradeCase.mismatch;
    if (res.status === 400) return this.t().common.refusedValues(path, reason);
    return attestingError(res, path, this.t());
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
    const words = this.t().tradeCase;
    const who = event.username ?? (event.anopodId ? this.t().common.podShort(event.anopodId.slice(0, 8)) : this.t().attesting.anAttestor);
    const note = typeof d['note'] === 'string' && d['note'] !== '' ? this.t().common.notePrefix(d['note']) : null;
    const keys = Array.isArray(d['keyIds']) ? d['keyIds'].length : 0;
    let icon = 'circle';
    let text = event.kind;
    let link: string | null = null;
    switch (event.kind) {
      case 'opened':
        [icon, text] = ['flag', words.eventOpened(who)];
        break;
      case 'lookupIdShared':
        [icon, text] = ['fingerprint', words.eventShared];
        break;
      case 'scheduled':
        [icon, text] = ['event', this.t().common.scheduledBy(who, typeof d['at'] === 'string' ? this.lang.dateTime(d['at']) : this.t().common.timeToBeConfirmed)];
        link = typeof d['meetLink'] === 'string' ? d['meetLink'] : null;
        break;
      case 'bucketOneViewed':
      case 'bucketTwoViewed':
        [icon, text] = ['visibility', this.t().common.readBucket(who, event.kind === 'bucketOneViewed' ? 1 : 2, keys)];
        break;
      case 'attestationSigned':
        [icon, text] = ['draw', words.eventSigned(who, typeof d['attestorId'] === 'string' ? d['attestorId'].slice(0, 8) + '…' : '?')];
        break;
      case 'decided':
        [icon, text] = ['verified', this.t().common.decidedSigned];
        break;
      case 'lookupIdCleared':
        [icon, text] = ['delete', words.eventCleared];
        break;
      case 'sent':
        [icon, text] = ['send', this.t().attesting.eventSent(who, String(d['validator'] ?? '?'), resultsOf(event).map((r) => `${r.signer.slice(0, 8)}… HTTP ${r.status}${r.error ? ' ' + r.error : ''}`).join(', '))];
        break;
      case 'dismissed':
        [icon, text] = ['block', this.t().common.dismissedBy(who, this.t().dismissReasonsStaff[String(d['reason'])] ?? String(d['reason'] ?? ''))];
        break;
    }
    return { key: event.eventId, icon, text, note, link, when: this.lang.dateTime(event.createdAt) };
  }
}
