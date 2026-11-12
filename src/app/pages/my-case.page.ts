import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { RouterLink } from '@angular/router';
import { CaseChatListComponent } from '../components/case-chat-list.component';
import { CASES_POLL_MS } from '../constants';
import { CryptoService } from '../services/crypto.service';
import { LanguageService } from '../services/language.service';
import { ApiResponse, reasonOf } from '../services/log.service';
import { EvidenceFile, ExistingEvidence, MasterpodApiService, MyCaseAnswer, MyCaseEvent, MyEvidenceItem } from '../services/masterpod-api.service';
import { SessionService } from '../services/session.service';
import { REVIEW_STATUSES, STATUS_ICONS } from './attesting.page';

/** The four content types the masterpod takes as evidence (masterpod 13.3). */
const CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

/** The masterpod's MAX_IMAGES_PER_REQUEST (5) and MAX_IMAGE_BYTES (10 MB, the ciphertext: 28 bytes over the plaintext). */
const FILES_PER_REQUEST = 5;
const MAX_FILE_BYTES = 10_485_760 - 28;

/** One line of the timeline. */
interface TimelineItem {
  key: string;
  icon: string;
  text: string;
  link: string | null;
  when: string;
}

/** One of the person's own files, opened with keyForMe to an object URL; from this case or, for Supply again, from another. */
interface FileView {
  evidenceId: string;
  caseId: string;
  contentType: string;
  isPdf: boolean;
  url: string | null;
  when: string;
}

interface Outcome {
  ok: boolean;
  text: string;
}

/**
 * My case (wallet spec 13.3, /cases/:caseId, every edition), from
 * /get-my-case, refreshed by a button and every 15 s. A trade: the status in
 * words, the timeline the person may see, and Share my lookup id, which
 * opens the identity blob in session and runs /share-lookup-id. A dispute:
 * the same frame with the person's side and Evidence: files (images and
 * PDFs) encrypted under a fresh content key each, the key under the pod's
 * encryption key (keyForMe) and to the case key (keyForCase, the case id as
 * aad), posted to /add-dispute-evidence; the person's files opened with
 * keyForMe; Supply again on a file of theirs from another case (the other
 * cases' /get-my-case answers, cached for the page), which wraps its
 * content key to this case's key and posts it under existing. Both kinds,
 * since 2026-11-12: "Chat with the attestor" and the person's chats about
 * the case (8.7), after the kind's own part and above the timeline.
 */
@Component({
  selector: 'app-my-case-page',
  imports: [RouterLink, MatCardModule, MatButtonModule, MatIconModule, MatListModule, MatProgressBarModule, CaseChatListComponent],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>{{ title() }}</mat-card-title>
        <mat-card-subtitle class="subtitle">
          <span>{{ t().common.caseId(shortCaseId()) }}</span>
          <button mat-icon-button type="button" (click)="copyCaseId()" [attr.aria-label]="t().common.copyCaseId"><mat-icon>content_copy</mat-icon></button>
          @if (copied()) {
            <span class="muted">{{ t().copy.copied }}</span>
          }
        </mat-card-subtitle>
      </mat-card-header>
      <mat-card-content>
        <div class="row">
          <a mat-button routerLink="/cases"><mat-icon>arrow_back</mat-icon> {{ t().nav.cases }}</a>
          <button mat-stroked-button type="button" (click)="refresh()" [disabled]="busy()">{{ t().common.refresh }}</button>
        </div>
        @if (busy()) {
          <mat-progress-bar mode="indeterminate"></mat-progress-bar>
        }
        @if (error(); as text) {
          <p class="error">{{ text }}</p>
        }
        @if (data(); as d) {
          <p class="status"><mat-icon class="inline">{{ icons[d.case.status] }}</mat-icon> {{ statusText() }}</p>
          @if (d.kind === 'dispute') {
            <p>{{ t().myCase.youAre(t().sides[d.case.side]) }}</p>
          }
          <p class="muted">{{ t().common.transaction }} <code>{{ d.case.transactionId }}</code></p>

          @if (d.kind === 'trade') {
            <p><a mat-stroked-button [routerLink]="['/wallet', d.case.accountId, 'assisted', d.case.transactionId]"><mat-icon>call_made</mat-icon> {{ t().myCase.seeTransfer }}</a></p>
            <h3>{{ t().myCase.shareLookupId }}</h3>
            <p>{{ t().myCase.shareText }}</p>
            <div class="row">
              <button mat-flat-button type="button" (click)="shareLookupId()" [disabled]="busy() || d.case.lookupIdShared || final()">
                {{ d.case.lookupIdShared ? t().myCase.lookupIdShared : t().myCase.shareLookupId }}
              </button>
            </div>
            @if (shareOutcome(); as o) { <p [class.error]="!o.ok" [class.ok]="o.ok">{{ o.text }}</p> }
          }

          @if (d.kind === 'dispute') {
            <h3>{{ t().common.evidence }}</h3>
            @if (final()) {
              <p class="muted">{{ t().myCase.copiesDeleted }}</p>
            } @else {
              <p>{{ t().myCase.evidenceText }}</p>
              <div class="row">
                <input #picker type="file" multiple accept="image/jpeg,image/png,image/webp,application/pdf" (change)="picked.set(filesOf($event))" />
                <button mat-flat-button type="button" (click)="upload(picker)" [disabled]="uploadBusy() || picked().length === 0">{{ t().myCase.upload(picked().length) }}</button>
              </div>
              @if (uploadBusy()) {
                <mat-progress-bar mode="indeterminate"></mat-progress-bar>
                <p class="muted">{{ uploadStep() }}</p>
              }
              @if (uploadOutcome(); as o) { <p [class.error]="!o.ok" [class.ok]="o.ok">{{ o.text }}</p> }
            }
            <h4>{{ t().myCase.yourFiles(mine().length) }}</h4>
            <div class="files">
              @for (f of mine(); track f.evidenceId) {
                <div class="file">
                  @if (f.url) {
                    @if (f.isPdf) {
                      <a [href]="f.url" target="_blank" rel="noopener" class="pdf"><mat-icon>picture_as_pdf</mat-icon> PDF</a>
                    } @else {
                      <a [href]="f.url" target="_blank" rel="noopener"><img [src]="f.url" [alt]="t().myCase.yourEvidence" /></a>
                    }
                  } @else {
                    <mat-icon class="locked">lock</mat-icon>
                  }
                  <div class="muted">{{ f.contentType }} · {{ f.when }}</div>
                </div>
              } @empty {
                <p class="muted">{{ t().myCase.nothingUploaded }}</p>
              }
            </div>
            @if (!final() && others().length > 0) {
              <h4>{{ t().myCase.otherFiles }}</h4>
              <p class="muted">{{ t().myCase.supplyText }}</p>
              <div class="files">
                @for (f of others(); track f.evidenceId) {
                  <div class="file">
                    @if (f.url) {
                      @if (f.isPdf) {
                        <a [href]="f.url" target="_blank" rel="noopener" class="pdf"><mat-icon>picture_as_pdf</mat-icon> PDF</a>
                      } @else {
                        <a [href]="f.url" target="_blank" rel="noopener"><img [src]="f.url" [alt]="t().myCase.yourEvidence" /></a>
                      }
                    } @else {
                      <mat-icon class="locked">lock</mat-icon>
                    }
                    <div class="muted">{{ f.contentType }} · {{ f.when }} {{ t().myCase.fromCase(f.caseId.slice(0, 8)) }}</div>
                    <button mat-stroked-button type="button" (click)="supplyAgain(f)" [disabled]="uploadBusy() || !f.url">{{ t().myCase.supplyAgain }}</button>
                  </div>
                }
              </div>
            }
          }

          <h3>{{ t().caseChat.title }}</h3>
          <app-case-chat-list [caseId]="caseId()" />

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
        }
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    .subtitle { display: flex; align-items: center; gap: 4px; }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 8px 0; }
    .status { font-weight: 500; }
    .inline { font-size: 18px; width: 18px; height: 18px; vertical-align: text-bottom; }
    .files { display: flex; flex-wrap: wrap; gap: 16px; margin: 8px 0; }
    .file { display: grid; gap: 4px; max-width: 220px; }
    .file img { width: 200px; max-height: 160px; object-fit: cover; border-radius: 8px; display: block; }
    .pdf { display: inline-flex; align-items: center; gap: 4px; }
    .locked { color: var(--mat-sys-on-surface-variant); }
    .muted { color: var(--mat-sys-on-surface-variant); }
    .error { color: var(--mat-sys-error); }
    .ok { color: var(--mat-sys-primary); }
    code { font-size: 12px; word-break: break-all; }
  `,
})
export class MyCasePage {
  readonly caseId = input.required<string>();

  private readonly session = inject(SessionService);
  private readonly masterpod = inject(MasterpodApiService);
  private readonly crypto = inject(CryptoService);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  protected readonly icons = STATUS_ICONS;

  protected readonly data = signal<MyCaseAnswer | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly copied = signal(false);
  protected readonly shareOutcome = signal<Outcome | null>(null);

  protected readonly picked = signal<File[]>([]);
  protected readonly uploadBusy = signal(false);
  protected readonly uploadStep = signal('');
  protected readonly uploadOutcome = signal<Outcome | null>(null);
  /** This case's files of the person, opened once and kept until the page is left. */
  protected readonly mine = signal<FileView[]>([]);
  /** The person's files from their other dispute cases, from those cases' /get-my-case answers (cached for the page), for Supply again. */
  protected readonly others = signal<FileView[]>([]);
  private othersTried = false;

  protected readonly shortCaseId = computed(() => `${this.caseId().slice(0, 8)}…${this.caseId().slice(-8)}`);

  protected readonly title = computed(() => {
    const d = this.data();
    if (!d) return this.t().myCase.title;
    return d.kind === 'trade' ? this.t().myCase.tradeTitle : this.t().myCase.disputeTitle;
  });

  protected readonly final = computed(() => {
    const status = this.data()?.case.status;
    return status !== undefined && !REVIEW_STATUSES.includes(status);
  });

  protected readonly statusText = computed(() => {
    const d = this.data();
    if (!d) return this.t().common.loadingCase;
    const words = this.t().myCase;
    const trade = d.kind === 'trade';
    switch (d.case.status) {
      case 'open':
        return trade ? words.openTrade : words.openDispute;
      case 'inReview':
        return trade ? words.inReviewTrade : words.inReviewDispute;
      case 'decided': {
        if (trade) return words.decidedTrade;
        const verdict = this.decidedVerdict(d.events);
        return words.decidedDispute(verdict === 'success' ? words.decidedSuccess : verdict === 'cancel' ? words.decidedCancel : words.decidedAgreed);
      }
      case 'dismissed':
        return words.statusDismissed(this.dismissReason(d.events));
    }
  });

  protected readonly timeline = computed<TimelineItem[]>(() =>
    (this.data()?.events ?? []).map((event, i) => ({
      key: `${i}-${event.kind}-${event.createdAt}`,
      icon: this.iconOf(event),
      text: this.textOf(event),
      link: event.kind === 'scheduled' && typeof event.details['meetLink'] === 'string' ? event.details['meetLink'] : null,
      when: this.lang.dateTime(event.createdAt),
    })),
  );

  constructor() {
    effect(() => {
      this.caseId();
      untracked(() => {
        this.dropFiles();
        this.othersTried = false;
        void this.refresh();
      });
    });
    const timer = setInterval(() => void this.load(true), CASES_POLL_MS);
    const destroy = inject(DestroyRef);
    destroy.onDestroy(() => clearInterval(timer));
    destroy.onDestroy(() => this.dropFiles());
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
    const res = await this.masterpod.getMyCase(this.caseId(), quiet);
    if (!res.ok) {
      this.error.set(res.status === 404 ? this.t().myCase.notFound : `/get-my-case: ${reasonOf(res)}`);
      return;
    }
    this.data.set(res.body);
    this.error.set(null);
    if (res.body.kind === 'dispute') {
      this.mine.set(await this.openFiles(res.body.evidence, this.caseId(), this.mine()));
      if (!this.othersTried && REVIEW_STATUSES.includes(res.body.case.status)) {
        this.othersTried = true;
        await this.loadOthers();
      }
    }
  }

  /** The person's files from their other dispute cases: /list-my-cases, then /get-my-case for each, opened with keyForMe. */
  private async loadOthers(): Promise<void> {
    const list = await this.masterpod.listMyCases(true);
    if (!list.ok) return;
    const views: FileView[] = [];
    for (const dispute of list.body.disputes) {
      if (dispute.caseId === this.caseId()) continue;
      const res = await this.masterpod.getMyCase(dispute.caseId, true);
      if (!res.ok || res.body.kind !== 'dispute') continue;
      views.push(...(await this.openFiles(res.body.evidence, dispute.caseId, [])));
    }
    this.others.set(views);
  }

  /** Each row not yet open: keyForMe under the encryption key to the content key, the file under it to an object URL; the content key zeroed. */
  private async openFiles(rows: MyEvidenceItem[], caseId: string, known: FileView[]): Promise<FileView[]> {
    const present = new Set(rows.map((r) => r.evidenceId));
    for (const view of known) {
      if (!present.has(view.evidenceId) && view.url) URL.revokeObjectURL(view.url);
    }
    const encryptionKey = this.session.getEncryptionKey();
    const views: FileView[] = [];
    for (const row of rows) {
      const seen = known.find((v) => v.evidenceId === row.evidenceId);
      if (seen?.url) {
        views.push(seen);
        continue;
      }
      const view: FileView = { evidenceId: row.evidenceId, caseId, contentType: row.contentType, isPdf: row.contentType === 'application/pdf', url: null, when: this.lang.dateTime(row.createdAt) };
      if (encryptionKey) {
        try {
          const contentKey = await this.crypto.decrypt(encryptionKey, this.crypto.fromHex(row.keyForMe));
          const bytes = await this.crypto.decrypt(contentKey, this.crypto.fromBase64(row.file));
          contentKey.fill(0);
          view.url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: row.contentType }));
        } catch {
          // A key that does not open: the lock shows.
        }
      }
      views.push(view);
    }
    return views;
  }

  private dropFiles(): void {
    for (const view of [...this.mine(), ...this.others()]) {
      if (view.url) URL.revokeObjectURL(view.url);
    }
    this.mine.set([]);
    this.others.set([]);
  }

  // --- the lookup id ------------------------------------------------------------------

  /** Share my lookup id (wallet spec 13.3): the identity blob is open in session; its lookup id goes to /share-lookup-id, nothing else. */
  protected async shareLookupId(): Promise<void> {
    this.busy.set(true);
    this.shareOutcome.set(null);
    try {
      const identity = this.session.getIdentity();
      if (!identity) throw new Error(this.t().myCase.noIdentity);
      const res = await this.masterpod.shareLookupId(this.caseId(), identity.lookupId);
      if (!res.ok) throw new Error(this.refusal(res, '/share-lookup-id'));
      this.shareOutcome.set({ ok: true, text: this.t().myCase.shared });
    } catch (err) {
      this.shareOutcome.set({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      this.busy.set(false);
      await this.load(true);
    }
  }

  // --- the evidence --------------------------------------------------------------------

  protected filesOf(event: Event): File[] {
    return Array.from((event.target as HTMLInputElement).files ?? []);
  }

  /**
   * Upload (wallet spec 13.3): for each file a content key, the file under it,
   * the key under the pod's encryption key (keyForMe) and to the case key
   * (keyForCase, encryptToHybrid with the case id as aad), posted to
   * /add-dispute-evidence five files at a time.
   */
  protected async upload(picker: HTMLInputElement): Promise<void> {
    const d = this.data();
    if (!d || d.kind !== 'dispute') return;
    this.uploadBusy.set(true);
    this.uploadOutcome.set(null);
    try {
      const encryptionKey = this.session.getEncryptionKey();
      if (!encryptionKey) throw new Error(this.t().myCase.noKeyInRam);
      const aad = this.crypto.fromHex(d.case.caseId);
      const entries: EvidenceFile[] = [];
      for (const file of this.picked()) {
        if (!CONTENT_TYPES.includes(file.type)) throw new Error(this.t().myCase.badType(file.name));
        if (file.size > MAX_FILE_BYTES) throw new Error(this.t().myCase.tooLarge(file.name));
        this.uploadStep.set(this.t().myCase.encrypting(file.name));
        const contentKey = this.crypto.newContentKey();
        entries.push({
          contentType: file.type,
          file: await this.crypto.encryptToBase64(contentKey, new Uint8Array(await file.arrayBuffer())),
          keyForMe: this.crypto.toHex(await this.crypto.encrypt(encryptionKey, contentKey)),
          keyForCase: this.crypto.toHex(await this.crypto.encryptToHybrid(d.case.caseKey, contentKey, aad)),
        });
        contentKey.fill(0);
      }
      for (let i = 0; i < entries.length; i += FILES_PER_REQUEST) {
        this.uploadStep.set(this.t().myCase.uploading(Math.min(i + FILES_PER_REQUEST, entries.length), entries.length));
        const res = await this.masterpod.addDisputeEvidence(this.caseId(), entries.slice(i, i + FILES_PER_REQUEST));
        if (!res.ok) throw new Error(this.refusal(res, '/add-dispute-evidence'));
      }
      this.picked.set([]);
      picker.value = '';
      this.uploadOutcome.set({ ok: true, text: this.t().myCase.uploaded(entries.length) });
    } catch (err) {
      this.uploadOutcome.set({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      this.uploadBusy.set(false);
      this.uploadStep.set('');
      await this.load(true);
    }
  }

  /** Supply again (wallet spec 13.3): the file's content key out of keyForMe, wrapped to this case's key, posted under existing; nothing is re-sent. */
  protected async supplyAgain(file: FileView): Promise<void> {
    const d = this.data();
    if (!d || d.kind !== 'dispute') return;
    this.uploadBusy.set(true);
    this.uploadOutcome.set(null);
    try {
      const encryptionKey = this.session.getEncryptionKey();
      if (!encryptionKey) throw new Error(this.t().myCase.noKeyInRam);
      const source = await this.masterpod.getMyCase(file.caseId, true);
      const row = source.ok && source.body.kind === 'dispute' ? source.body.evidence.find((e) => e.evidenceId === file.evidenceId) : undefined;
      if (!row) throw new Error(this.t().myCase.fileGone);
      const contentKey = await this.crypto.decrypt(encryptionKey, this.crypto.fromHex(row.keyForMe));
      const existing: ExistingEvidence[] = [{ evidenceId: row.evidenceId, keyForCase: this.crypto.toHex(await this.crypto.encryptToHybrid(d.case.caseKey, contentKey, this.crypto.fromHex(d.case.caseId))) }];
      contentKey.fill(0);
      const res = await this.masterpod.addDisputeEvidence(this.caseId(), [], existing);
      if (!res.ok) throw new Error(this.refusal(res, '/add-dispute-evidence'));
      this.uploadOutcome.set({ ok: true, text: this.t().myCase.suppliedAgain });
    } catch (err) {
      this.uploadOutcome.set({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      this.uploadBusy.set(false);
      await this.load(true);
    }
  }

  /** A person route's refusal in words (masterpod 13.4.5). */
  private refusal(res: ApiResponse<unknown>, path: string): string {
    const reason = reasonOf(res);
    const words = this.t().myCase;
    if (res.status === 409 && /already shared/.test(reason)) return words.alreadyShared;
    if (res.status === 409 && /case closed/.test(reason)) return words.caseClosed;
    if (res.status === 404 && /unknown evidence/.test(reason)) return words.fileNotYours;
    if (res.status === 400) return this.t().common.refusedValues(path, reason);
    return `${path}: ${reason}`;
  }

  // --- copy and the timeline -------------------------------------------------------------

  protected async copyCaseId(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.caseId());
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } catch {
      this.error.set(this.t().common.couldNotCopyId);
    }
  }

  private decidedVerdict(events: MyCaseEvent[]): string | null {
    const verdict = [...events].reverse().find((e) => e.kind === 'decided')?.details['verdict'];
    return typeof verdict === 'string' ? verdict : null;
  }

  private dismissReason(events: MyCaseEvent[]): string {
    const reason = [...events].reverse().find((e) => e.kind === 'dismissed')?.details['reason'];
    return typeof reason === 'string' ? (this.t().dismissReasons[reason] ?? reason) : this.t().common.anotherReason;
  }

  private iconOf(event: MyCaseEvent): string {
    return (
      {
        opened: 'flag',
        lookupIdShared: 'fingerprint',
        evidenceAdded: 'upload_file',
        scheduled: 'event',
        decided: 'verified',
        lookupIdCleared: 'delete',
        evidenceDeleted: 'delete',
        sent: 'send',
        dismissed: 'block',
      }[event.kind] ?? 'circle'
    );
  }

  private textOf(event: MyCaseEvent): string {
    const d = event.details;
    const files = Array.isArray(d['evidenceIds']) ? d['evidenceIds'].length : 0;
    const words = this.t().myCase;
    switch (event.kind) {
      case 'opened':
        return words.eventOpened;
      case 'lookupIdShared':
        return words.eventShared;
      case 'evidenceAdded':
        return words.eventAdded(files);
      case 'scheduled': {
        const at = typeof d['at'] === 'string' ? this.lang.dateTime(d['at']) : this.t().common.timeToBeConfirmed;
        return this.t().common.videoCallScheduled(at);
      }
      case 'decided':
        return typeof d['verdict'] === 'string' ? words.eventDecided(d['verdict']) : this.t().common.decidedSigned;
      case 'lookupIdCleared':
        return words.eventCleared;
      case 'evidenceDeleted':
        return words.eventDeleted;
      case 'sent':
        return words.eventSent;
      case 'dismissed':
        return this.t().common.dismissed(typeof d['reason'] === 'string' ? (this.t().dismissReasons[d['reason']] ?? d['reason']) : this.t().common.anotherReason);
      default:
        return event.kind;
    }
  }
}
