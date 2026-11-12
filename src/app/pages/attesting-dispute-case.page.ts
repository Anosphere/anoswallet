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
import { CaseChatStartComponent } from '../components/case-chat-start.component';
import { CASES_POLL_MS } from '../constants';
import { AnosApiService } from '../services/anos-api.service';
import { AttestingService, attestingError } from '../services/attesting.service';
import { BalancesService } from '../services/balances.service';
import { CryptoService, EscrowVerdictPayload, FollowUp, HybridKeys, Verdict } from '../services/crypto.service';
import { LanguageService } from '../services/language.service';
import { ApiResponse, reasonOf } from '../services/log.service';
import {
  ATTESTOR_DISMISS_REASONS,
  AttestorDismissReason,
  AttestorItem,
  CaseEvent,
  DisputeCaseAnswer,
  DisputeEvidenceItem,
  MasterpodApiService,
  Profile,
  SentResult,
} from '../services/masterpod-api.service';
import { SessionService } from '../services/session.service';
import { SigningService } from '../services/signing.service';
import { REVIEW_STATUSES, STATUS_ICONS } from './attesting.page';

/** One line of the timeline. */
interface TimelineItem {
  key: string;
  icon: string;
  text: string;
  note: string | null;
  link: string | null;
  when: string;
}

interface Outcome {
  ok: boolean;
  text: string;
}

/** One evidence file as shown: opened to an object URL when the case key is held and the copy still exists; otherwise counted. */
interface EvidenceView {
  evidenceId: string;
  side: 'seller' | 'buyer';
  who: string;
  when: string;
  contentType: string;
  isPdf: boolean;
  url: string | null;
  deleted: boolean;
}

/** A stored verdict: the signer's account id, its value and the follow-up object, from a verdictSigned event. */
interface StoredVerdict {
  signer: string;
  verdict: Verdict;
  object: FollowUp<EscrowVerdictPayload>;
}

/** The sending of a decided case: the agreeing verdicts, the ones not yet accepted by the validator, and the last answers. */
interface Sending {
  verdict: Verdict;
  verdicts: StoredVerdict[];
  pending: StoredVerdict[];
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
 * Dispute case (wallet spec 13.3, /attesting/dispute/:caseId, the attestor
 * edition), from /get-dispute-case, refreshed by a button and every 15 s:
 * the parties and who disputed, each with a Start chat button under its
 * facts (8.7, 2026-11-12), the escrow (the amount from the Disputes
 * list cached in AttestingService), the case key (opened from myKey with the
 * session's chat keys, or asked from a holder; Share to an attestor who
 * holds none), the timeline, the evidence in two columns opened with the
 * case key (keyForCase under the case pair with the case id as aad, then the
 * file under the content key), Schedule, Verdict (the escrowVerdict
 * follow-up built as the account page builds one, then
 * /sign-off-dispute-case), Send to the validators once the case is decided
 * (the two agreeing verdicts to /escrow-signature and
 * /mark-attestor-case-sent; run at once on the deciding attestor's page),
 * and Dismiss behind a confirmation. The case pair and the opened evidence
 * are zeroed when the page is left.
 */
@Component({
  selector: 'app-attesting-dispute-case-page',
  imports: [FormsModule, RouterLink, MatCardModule, MatButtonModule, MatListModule, MatIconModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatProgressBarModule, CaseChatStartComponent],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>{{ t().disputeCase.title }} <code class="id">{{ caseId() }}</code></mat-card-title>
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
          <h3>{{ t().disputeCase.theParties }}</h3>
          <div class="parties">
            @for (party of parties(); track party.side) {
              <div class="person">
                @if (party.profile?.selfie; as selfie) {
                  <img class="selfie" [src]="'data:' + selfie.contentType + ';base64,' + selfie.image" [alt]="t().sides[party.side]" />
                }
                <div>
                  <div class="facts">
                    <div><span class="label">{{ t().common.side }}</span><span class="value">{{ t().sides[party.side] }}{{ party.disputed ? t().disputeCase.disputedTheEscrow : '' }}</span></div>
                    <div><span class="label">{{ t().common.username }}</span><span class="value">{{ party.profile?.username ?? t().common.unknownPod }}</span></div>
                    <div><span class="label">{{ t().common.name }}</span><span class="value">{{ party.profile?.firstName }} {{ party.profile?.lastName }}</span></div>
                    <div><span class="label">{{ t().common.account }}</span><span class="value"><code>{{ party.accountId }}</code></span></div>
                  </div>
                  <app-case-chat-start [caseId]="caseId()" [person]="party.profile" [open]="!final()" />
                </div>
              </div>
            }
          </div>
          <p class="muted">{{ t().disputeCase.marketChatHint }}</p>
          <p class="muted">{{ t().common.statusOpened(t().caseStatus[d.case.status] ?? d.case.status, lang.dateTime(d.case.createdAt)) }}</p>

          <h3>{{ t().disputeCase.theEscrow }}</h3>
          <div class="facts">
            <div>
              <span class="label">{{ t().common.amount }}</span>
              <span class="value">
                @if (escrow(); as e) { {{ t().attesting.amountMade(millionthsToAnos(e.amount), lang.dateTime(e.createdAt)) }} } @else { {{ t().disputeCase.notListed }} }
              </span>
            </div>
            <div>
              <span class="label">{{ t().common.transaction }}</span>
              <span class="value"><code>{{ d.case.transactionId }}</code> <button mat-icon-button type="button" (click)="copy('transaction', d.case.transactionId)" [attr.aria-label]="t().common.copyTransactionId"><mat-icon>content_copy</mat-icon></button>@if (copied() === 'transaction') { <span class="muted">{{ t().copy.copied }}</span> }</span>
            </div>
          </div>

          <h3>{{ t().disputeCase.theCaseKey }}</h3>
          @if (keyHeld()) {
            <p class="ok">{{ t().disputeCase.keyHeld }}</p>
            @if (!final()) {
              <div class="form">
                <mat-form-field appearance="outline" class="wide">
                  <mat-label>{{ t().disputeCase.shareWith }}</mat-label>
                  <mat-select [value]="shareTo()" (valueChange)="shareTo.set($event)">
                    @for (a of shareable(); track a.anopodId) {
                      <mat-option [value]="a.anopodId">{{ t().common.personLine(a.username, a.firstName, a.lastName) }}</mat-option>
                    }
                  </mat-select>
                </mat-form-field>
                <button mat-stroked-button type="button" (click)="share()" [disabled]="busy() || !shareTo()">{{ t().disputeCase.share }}</button>
                @if (shareable().length === 0) {
                  <span class="muted">{{ t().disputeCase.everyoneHolds }}</span>
                }
              </div>
              @if (shareOutcome(); as o) { <p [class.error]="!o.ok" [class.ok]="o.ok">{{ o.text }}</p> }
            }
          } @else if (final()) {
            <p class="muted">{{ t().disputeCase.keyDeleted }}</p>
          } @else if (keyError(); as text) {
            <p class="error">{{ text }}</p>
          } @else {
            <p class="error">{{ t().disputeCase.noKeyAsk(holderNames()) }}</p>
          }

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

          <h3>{{ t().common.evidence }}</h3>
          @if (final()) {
            <p class="muted">{{ t().disputeCase.copiesDeleted }}</p>
          } @else if (!keyHeld()) {
            <p class="muted">{{ t().disputeCase.countedNotShown }}</p>
          }
          <div class="columns">
            @for (side of sides; track side) {
              <div class="column">
                <h4>{{ t().disputeCase.sideFiles(t().sides[side], evidenceOf(side).length) }}</h4>
                @for (e of evidenceOf(side); track e.evidenceId) {
                  <div class="file">
                    @if (e.url) {
                      @if (e.isPdf) {
                        <a [href]="e.url" target="_blank" rel="noopener" class="pdf"><mat-icon>picture_as_pdf</mat-icon> PDF</a>
                      } @else {
                        <a [href]="e.url" target="_blank" rel="noopener"><img [src]="e.url" [alt]="t().disputeCase.evidenceAlt" /></a>
                      }
                    } @else {
                      <mat-icon class="locked">{{ e.deleted ? 'delete' : 'lock' }}</mat-icon>
                    }
                    <div class="muted">{{ e.contentType }} · {{ e.who }} · {{ e.when }}{{ e.deleted ? t().disputeCase.copyDeleted : '' }}</div>
                  </div>
                } @empty {
                  <p class="muted">{{ t().disputeCase.nothingUploaded }}</p>
                }
              </div>
            }
          </div>

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
          <p class="muted">{{ t().disputeCase.accountText }}</p>
          <div class="form">
            <mat-form-field appearance="outline" class="wide">
              <mat-label>{{ t().common.anosAccount }}</mat-label>
              <mat-select [value]="attesting.accountId()" (valueChange)="attesting.accountId.set($event)">
                @for (account of balances.usableAccounts(); track account.accountId) {
                  <mat-option [value]="account.accountId">{{ t().wallet.typeOption(account.accountType) }} · {{ account.accountId }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
            @if (balances.usableAccounts().length === 0) {
              <span class="muted">{{ t().attesting.noAccount }}</span>
            }
          </div>

          <h3>{{ t().common.verdict }}</h3>
          @if (signOffs().length > 0) {
            <p class="muted">{{ t().disputeCase.verdictsSoFar(signOffs().join(', ')) }}</p>
          }
          <p class="muted">{{ t().disputeCase.verdictText }}</p>
          <div class="form">
            <mat-form-field appearance="outline">
              <mat-label>{{ t().common.verdict }}</mat-label>
              <mat-select [value]="verdict()" (valueChange)="verdict.set($event)">
                <mat-option value="success">{{ t().disputeCase.success }}</mat-option>
                <mat-option value="cancel">{{ t().common.cancel }}</mat-option>
              </mat-select>
            </mat-form-field>
            <button mat-flat-button type="button" (click)="sign()" [disabled]="busy() || final() || !attesting.accountId()">{{ t().disputeCase.signVerdict }}</button>
          </div>
          @if (verdictOutcome(); as o) { <p [class.error]="!o.ok" [class.ok]="o.ok">{{ o.text }}</p> }

          @if (sending(); as s) {
            <h3>{{ t().attesting.sendTitle }}</h3>
            @if (s.pending.length === 0) {
              <p class="ok">{{ t().disputeCase.sentAll(s.verdict) }}</p>
            } @else {
              <p class="muted">{{ t().disputeCase.stillToSend(s.verdict, s.pending.length, s.verdicts.length) }}</p>
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
                  <li>{{ t().disputeCase.verdictBy }} <code>{{ r.signer.slice(0, 16) }}…</code> → HTTP {{ r.status }}{{ r.error ? ': ' + r.error : t().attesting.accepted }}</li>
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
            <p class="error">{{ t().disputeCase.dismissWarning }}</p>
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
    .parties { display: flex; gap: 24px; flex-wrap: wrap; }
    .person { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
    .selfie { width: 120px; height: 120px; object-fit: cover; border-radius: 8px; }
    .facts { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; align-items: center; }
    .facts div { display: contents; }
    .label { color: var(--mat-sys-on-surface-variant); }
    .value { word-break: break-all; }
    .note { white-space: pre-wrap; }
    .columns { display: flex; gap: 24px; flex-wrap: wrap; }
    .column { flex: 1; min-width: 280px; }
    .file { margin: 8px 0; }
    .file img { width: 200px; max-height: 160px; object-fit: cover; border-radius: 8px; display: block; }
    .pdf { display: inline-flex; align-items: center; gap: 4px; }
    .locked { color: var(--mat-sys-on-surface-variant); }
    .texts { margin: 4px 0; padding-left: 20px; }
    .danger { background: var(--mat-sys-error); color: var(--mat-sys-on-error); }
    .muted { color: var(--mat-sys-on-surface-variant); }
    .error { color: var(--mat-sys-error); }
    .ok { color: var(--mat-sys-primary); }
    code { font-size: 12px; word-break: break-all; }
  `,
})
export class AttestingDisputeCasePage {
  readonly caseId = input.required<string>();

  protected readonly session = inject(SessionService);
  /** The picker lists the usable accounts only: a lost account, whose keyBlob does not open, is left out (wallet spec 8.2, 2026-11-08). */
  protected readonly balances = inject(BalancesService);
  protected readonly attesting = inject(AttestingService);
  private readonly masterpod = inject(MasterpodApiService);
  private readonly anos = inject(AnosApiService);
  private readonly signing = inject(SigningService);
  private readonly crypto = inject(CryptoService);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  protected readonly millionthsToAnos = millionthsToAnos;
  protected readonly icons = STATUS_ICONS;
  protected readonly reasons = ATTESTOR_DISMISS_REASONS;
  protected readonly sides: ('seller' | 'buyer')[] = ['seller', 'buyer'];

  protected readonly data = signal<DisputeCaseAnswer | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly copied = signal<string | null>(null);

  /** True while the case pair is in RAM for this case. */
  protected readonly keyHeld = signal(false);
  protected readonly keyError = signal<string | null>(null);
  /** Every attestor pod, for the share picker and the holders' names. */
  protected readonly attestors = signal<AttestorItem[]>([]);
  protected readonly shareTo = signal('');
  protected readonly shareOutcome = signal<Outcome | null>(null);
  /** The evidence as shown, by evidence id; opened once and kept until the page is left. */
  protected readonly evidence = signal<EvidenceView[]>([]);

  protected readonly scheduleAt = signal('');
  protected readonly meetLink = signal('');
  protected readonly scheduleOutcome = signal<Outcome | null>(null);
  protected readonly verdict = signal<Verdict>('success');
  protected readonly verdictOutcome = signal<Outcome | null>(null);
  protected readonly sendBusy = signal(false);
  protected readonly sendOutcome = signal<Outcome | null>(null);
  protected readonly reason = signal<AttestorDismissReason>('settled');
  protected readonly dismissNote = signal('');
  protected readonly confirmingDismiss = signal(false);
  protected readonly dismissOutcome = signal<Outcome | null>(null);

  private listsTried = false;
  private attestorsTried = false;

  protected readonly canSchedule = computed(() => this.scheduleAt() !== '' && /^https:\/\/\S+$/.test(this.meetLink().trim()) && this.meetLink().trim().length <= 500);

  protected readonly final = computed(() => {
    const status = this.data()?.case.status;
    return status !== undefined && !REVIEW_STATUSES.includes(status);
  });

  /** The escrow as the validator listed it, from the service's cache: the amount, when it was made. */
  protected readonly escrow = computed(() => {
    const transactionId = this.data()?.case.transactionId;
    return transactionId ? this.attesting.disputeOf(transactionId) : null;
  });

  /** The seller and the buyer with their profiles, their accounts and who disputed. */
  protected readonly parties = computed(() => {
    const d = this.data();
    if (!d) return [];
    return [
      { side: 'seller' as const, profile: d.seller as Profile | null, accountId: d.case.accountId, disputed: d.case.disputedBy === d.case.accountId },
      { side: 'buyer' as const, profile: d.buyer as Profile | null, accountId: d.case.accountIdTo, disputed: d.case.disputedBy === d.case.accountIdTo },
    ];
  });

  /** The usernames of the pods that hold the case key (the ids the case answers, named through /list-attestors). */
  protected readonly holderNames = computed(() => {
    const names = this.attestors();
    const holders = this.data()?.keyHolders ?? [];
    if (holders.length === 0) return this.t().disputeCase.nobodyHolds;
    return holders.map((id) => names.find((a) => a.anopodId === id)?.username ?? this.t().common.podShort(id.slice(0, 8))).join(', ');
  });

  /** The attestors who hold no key yet, with chat keys to wrap to. */
  protected readonly shareable = computed(() => {
    const holders = new Set(this.data()?.keyHolders ?? []);
    return this.attestors().filter((a) => !holders.has(a.anopodId) && a.chatPublicKey && a.chatPublicKeyPq);
  });

  protected readonly timeline = computed<TimelineItem[]>(() => (this.data()?.events ?? []).map((event) => this.itemOf(event)));

  /** Each attestor's verdict, from the events: "attestorjoy: success, attestorsam: cancel". */
  protected readonly signOffs = computed(() =>
    (this.data()?.events ?? []).filter((e) => e.kind === 'verdictSigned').map((e) => `${e.username ?? this.t().attesting.anAttestor}: ${String(e.details['verdict'] ?? '?')}`),
  );

  /** The sending, once the case is decided: the verdicts of the decided value, the ones not yet accepted by the validator, the last answers. */
  protected readonly sending = computed<Sending | null>(() => {
    const d = this.data();
    if (!d || d.case.status !== 'decided') return null;
    const decided = d.events.find((e) => e.kind === 'decided');
    const verdict = decided?.details['verdict'];
    if (verdict !== 'success' && verdict !== 'cancel') return null;
    const verdicts: StoredVerdict[] = [];
    for (const event of d.events) {
      if (event.kind !== 'verdictSigned' || event.details['verdict'] !== verdict) continue;
      const signer = event.details['arbitratorId'];
      const object = event.details['object'];
      if (typeof signer === 'string' && object && typeof object === 'object') verdicts.push({ signer, verdict, object: object as FollowUp<EscrowVerdictPayload> });
    }
    const sent = d.events.filter((e) => e.kind === 'sent');
    const acceptedSigners = new Set(sent.flatMap(resultsOf).filter(accepted).map((r) => r.signer));
    return { verdict, verdicts, pending: verdicts.filter((v) => !acceptedSigners.has(v.signer)), tried: sent.length > 0, lastResults: resultsOf(sent.at(-1)) };
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
    destroy.onDestroy(() => this.dropAll());
  }

  protected evidenceOf(side: 'seller' | 'buyer'): EvidenceView[] {
    return this.evidence().filter((e) => e.side === side);
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

  /** /get-dispute-case, then the case pair (kept, or opened from myKey), the evidence not yet opened, the attestors once, the validator's list once. */
  private async load(quiet: boolean): Promise<void> {
    const res = await this.masterpod.getDisputeCase(this.caseId(), quiet);
    if (!res.ok) {
      this.error.set(res.status === 404 ? this.t().disputeCase.notFound : attestingError(res, '/get-dispute-case', this.t()));
      return;
    }
    this.data.set(res.body);
    this.error.set(null);
    const pair = await this.casePair(res.body);
    await this.openEvidence(res.body, pair);
    if (!this.attestorsTried) {
      this.attestorsTried = true;
      const attestors = await this.masterpod.listAttestors(true);
      if (attestors.ok) this.attestors.set(attestors.body.attestors);
    }
    if (!this.escrow() && !this.listsTried && this.attesting.accountId() !== '') {
      this.listsTried = true;
      await this.attesting.loadLists(true).catch(() => undefined);
    }
  }

  /** The case pair: the one kept in the service (the opener's, or opened earlier), else myKey opened with the session's chat keys. */
  private async casePair(d: DisputeCaseAnswer): Promise<HybridKeys | null> {
    const kept = this.attesting.getCasePair(this.caseId());
    if (kept) {
      this.keyHeld.set(true);
      return kept;
    }
    if (!d.myKey) {
      this.keyHeld.set(false);
      return null;
    }
    const chat = this.session.getChatKeys();
    if (!chat) {
      this.keyError.set(this.t().disputeCase.noChatKeys);
      return null;
    }
    try {
      const secret = await this.crypto.unwrapCaseSecret(this.crypto.fromHex(d.myKey), chat);
      const keys = this.crypto.hybridKeysFromSecret(secret);
      this.attesting.setCasePair(this.caseId(), keys);
      this.keyHeld.set(true);
      this.keyError.set(null);
      return keys;
    } catch {
      this.keyError.set(this.t().disputeCase.keyNoOpen);
      return null;
    }
  }

  /**
   * The evidence rows not yet shown: each keyForCase opened with the case
   * pair (aad the case id's bytes) to the content key, the file under it to
   * an object URL, the content key zeroed; a row without a case-key copy, or
   * without the pair, is counted. Rows that left the answer are dropped.
   */
  private async openEvidence(d: DisputeCaseAnswer, pair: HybridKeys | null): Promise<void> {
    const present = new Set(d.evidence.map((e) => e.evidenceId));
    const kept = this.evidence().filter((e) => present.has(e.evidenceId));
    for (const view of this.evidence()) {
      if (!present.has(view.evidenceId) && view.url) URL.revokeObjectURL(view.url);
    }
    const known = new Map(kept.map((e) => [e.evidenceId, e]));
    const aad = this.crypto.fromHex(d.case.caseId);
    const views: EvidenceView[] = [];
    for (const row of d.evidence) {
      const seen = known.get(row.evidenceId);
      if (seen && (seen.url || !row.keyForCase || !pair)) {
        views.push(seen.url || row.keyForCase ? seen : { ...seen, deleted: true });
        continue;
      }
      if (seen?.url) URL.revokeObjectURL(seen.url);
      views.push(await this.openRow(row, pair, aad));
    }
    this.evidence.set(views);
  }

  private async openRow(row: DisputeEvidenceItem, pair: HybridKeys | null, aad: Uint8Array): Promise<EvidenceView> {
    const view: EvidenceView = {
      evidenceId: row.evidenceId,
      side: row.side,
      who: row.username ?? this.t().common.podShort(row.anopodId.slice(0, 8)),
      when: this.lang.dateTime(row.createdAt),
      contentType: row.contentType,
      isPdf: row.contentType === 'application/pdf',
      url: null,
      deleted: row.keyForCase === null,
    };
    if (!row.keyForCase || !pair) return view;
    try {
      const contentKey = await this.crypto.decryptFromHybrid(pair, this.crypto.fromHex(row.keyForCase), aad);
      const bytes = await this.crypto.decrypt(contentKey, this.crypto.fromBase64(row.file));
      contentKey.fill(0);
      view.url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: row.contentType }));
    } catch {
      view.who += this.t().disputeCase.didNotOpen;
    }
    return view;
  }

  /** What the page leaves behind: the object URLs revoked, the case pair zeroed. */
  private dropAll(): void {
    for (const view of this.evidence()) {
      if (view.url) URL.revokeObjectURL(view.url);
    }
    this.evidence.set([]);
    this.attesting.dropCasePair(this.caseId());
  }

  // --- the case key ------------------------------------------------------------------

  /** Share the case key (wallet spec 13.3): the 96 secret bytes wrapped to the picked attestor's chat key, then /share-case-key. */
  protected share(): Promise<void> {
    return this.act(this.shareOutcome, async () => {
      const pair = this.attesting.getCasePair(this.caseId());
      const target = this.attestors().find((a) => a.anopodId === this.shareTo());
      if (!pair) throw new Error(this.t().disputeCase.noKey);
      if (!target?.chatPublicKey || !target.chatPublicKeyPq) throw new Error(this.t().disputeCase.pickAttestor);
      const secret = new Uint8Array(96);
      secret.set(pair.x25519Secret, 0);
      secret.set(pair.kemSeed, 32);
      try {
        const wrapped = await this.crypto.wrapCaseSecret(secret, target.chatPublicKey, target.chatPublicKeyPq);
        const res = await this.masterpod.shareCaseKey(this.caseId(), target.anopodId, this.crypto.toHex(wrapped));
        if (!res.ok) throw new Error(this.refusal(res, '/share-case-key'));
      } finally {
        secret.fill(0);
      }
      this.shareTo.set('');
      return this.t().disputeCase.sharedWith(target.username);
    });
  }

  // --- schedule, verdict, send, dismiss ------------------------------------------------

  protected schedule(): Promise<void> {
    return this.act(this.scheduleOutcome, async () => {
      const at = new Date(this.scheduleAt());
      if (Number.isNaN(at.getTime())) throw new Error(this.t().common.enterCallTime);
      const res = await this.masterpod.scheduleAttestorCase(this.caseId(), at.toISOString(), this.meetLink().trim());
      if (!res.ok) throw new Error(this.refusal(res, '/schedule-attestor-case'));
      return this.t().disputeCase.scheduled(this.lang.dateTime(at));
    });
  }

  /**
   * The escrowVerdict follow-up (wallet spec 13.3), built as the account
   * page builds one: pair one of the staked account, arbitratorId the
   * account, the wallet pair from /api/sign; then /sign-off-dispute-case.
   * When the answer says decided this signature decided the case and the
   * sending runs at once.
   */
  protected async sign(): Promise<void> {
    let decided = false;
    await this.act(this.verdictOutcome, async () => {
      const d = this.data();
      if (!d) throw new Error(this.t().common.caseNotLoaded);
      const { account, pairOne } = await this.attesting.pairOne();
      const followUp = this.crypto.buildFollowUp(pairOne, { type: 'escrowVerdict', transactionId: d.case.transactionId, arbitratorId: account.accountId, verdict: this.verdict() });
      const signed = await this.signing.sign(followUp);
      const res = await this.masterpod.signOffDisputeCase(this.caseId(), signed);
      if (!res.ok) throw new Error(this.refusal(res, '/sign-off-dispute-case'));
      decided = res.body.status === 'decided';
      return decided ? this.t().disputeCase.signedDecided(String(res.body.decidedVerdict)) : this.t().disputeCase.signedCount(this.verdict(), res.body.signOffs);
    });
    if (decided) await this.send();
  }

  /**
   * Send to the validators (wallet spec 13.3): the agreeing verdicts no
   * validator answer has accepted yet, posted one after the other to the
   * session's validator's /escrow-signature, then /mark-attestor-case-sent
   * with the answers; Retry posts the ones still pending.
   */
  protected async send(): Promise<void> {
    const sending = this.sending();
    if (!sending || this.sendBusy()) return;
    this.sendBusy.set(true);
    this.sendOutcome.set(null);
    try {
      if (sending.pending.length === 0) throw new Error(this.t().disputeCase.allAccepted);
      const results: SentResult[] = [];
      for (const { signer, object } of sending.pending) {
        const res = await this.anos.escrowSignature(object);
        results.push(res.ok ? { signer, status: res.status } : { signer, status: res.status, error: reasonOf(res).slice(0, 500) });
      }
      const validator = await this.anos.validator();
      const marked = await this.masterpod.markAttestorCaseSent(this.caseId(), validator, results);
      if (!marked.ok) throw new Error(this.refusal(marked, '/mark-attestor-case-sent'));
      const failed = results.filter((r) => !accepted(r));
      this.sendOutcome.set(
        failed.length === 0
          ? { ok: true, text: this.t().attesting.sentAccepted(validator, results.length === 1 ? this.t().disputeCase.theVerdict : this.t().disputeCase.bothVerdicts) }
          : { ok: false, text: this.t().attesting.validatorRefused(validator, failed.length, results.length) },
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
      return this.t().disputeCase.dismissed;
    });
  }

  /** An attestor route's refusal in words (masterpod 13.4.2, 13.4.4). */
  private refusal(res: ApiResponse<unknown>, path: string): string {
    const reason = reasonOf(res);
    if (res.status === 409 && /already signed off/.test(reason)) return this.t().disputeCase.alreadySigned;
    if (res.status === 409 && /case closed/.test(reason)) return this.t().common.caseClosedDone;
    if (res.status === 409 && /case not decided/.test(reason)) return this.t().attesting.notDecided;
    if (res.status === 409 && /key already shared/.test(reason)) return this.t().disputeCase.alreadyHolds;
    if (res.status === 403 && /no key for this case/.test(reason)) return this.t().disputeCase.noKeyRefused;
    if (res.status === 403 && /a party to the escrow/.test(reason)) return this.t().disputeCase.isParty;
    if (res.status === 403 && /not your account/.test(reason)) return this.t().common.notMyAccountSentence;
    if (res.status === 401 && /bad signature/.test(reason)) return this.t().common.badSignature;
    if (res.status === 400 && /does not match the case/.test(reason)) return this.t().disputeCase.mismatch;
    if (res.status === 400 && /not an attestor/.test(reason)) return this.t().disputeCase.notAttestor;
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
    const words = this.t().disputeCase;
    const who = event.username ?? (event.anopodId ? this.t().common.podShort(event.anopodId.slice(0, 8)) : this.t().attesting.anAttestor);
    const note = typeof d['note'] === 'string' && d['note'] !== '' ? this.t().common.notePrefix(d['note']) : null;
    const files = Array.isArray(d['evidenceIds']) ? d['evidenceIds'].length : 0;
    let icon = 'circle';
    let text = event.kind;
    let link: string | null = null;
    switch (event.kind) {
      case 'opened':
        [icon, text] = ['flag', words.eventOpened(who, d['keyHolders'])];
        break;
      case 'evidenceAdded':
        [icon, text] = ['upload_file', words.eventAdded(who, files)];
        break;
      case 'scheduled':
        [icon, text] = ['event', this.t().common.scheduledBy(who, typeof d['at'] === 'string' ? this.lang.dateTime(d['at']) : this.t().common.timeToBeConfirmed)];
        link = typeof d['meetLink'] === 'string' ? d['meetLink'] : null;
        break;
      case 'caseKeyShared':
        [icon, text] = ['key', words.eventShared(who, this.attestors().find((a) => a.anopodId === d['anopodId'])?.username ?? this.t().common.podShort(String(d['anopodId'] ?? '').slice(0, 8)))];
        break;
      case 'verdictSigned':
        [icon, text] = ['draw', words.eventSigned(who, String(d['verdict'] ?? '?'), typeof d['arbitratorId'] === 'string' ? d['arbitratorId'].slice(0, 8) + '…' : '?')];
        break;
      case 'decided':
        [icon, text] = ['verified', words.eventDecided(String(d['verdict'] ?? '?'))];
        break;
      case 'evidenceDeleted':
        [icon, text] = ['delete', words.eventDeleted(d['evidence'], d['keys'])];
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
