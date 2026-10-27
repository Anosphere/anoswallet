import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { RouterLink } from '@angular/router';
import { CASES_POLL_MS } from '../constants';
import { CryptoService } from '../services/crypto.service';
import { ApiResponse, reasonOf } from '../services/log.service';
import { EvidenceFile, ExistingEvidence, MasterpodApiService, MyCaseAnswer, MyCaseEvent, MyEvidenceItem } from '../services/masterpod-api.service';
import { SessionService } from '../services/session.service';
import { REVIEW_STATUSES, STATUS_ICONS, STATUS_WORDS } from './attesting.page';

/** The four content types the masterpod takes as evidence (masterpod 13.3). */
const CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

/** The masterpod's MAX_IMAGES_PER_REQUEST (5) and MAX_IMAGE_BYTES (10 MB, the ciphertext: 28 bytes over the plaintext). */
const FILES_PER_REQUEST = 5;
const MAX_FILE_BYTES = 10_485_760 - 28;

/** A dismissal's preset reason in words, as the person reads it (masterpod 13.4.4). */
const DISMISS_WORDS: Record<string, string> = {
  selfieMismatch: 'the selfie did not match',
  documentsMismatch: 'the documents did not match',
  noShow: 'you did not join the call',
  withdrawn: 'the request was withdrawn',
  settled: 'the parties settled',
  other: 'another reason',
};

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
 * content key to this case's key and posts it under existing.
 */
@Component({
  selector: 'app-my-case-page',
  imports: [RouterLink, MatCardModule, MatButtonModule, MatIconModule, MatListModule, MatProgressBarModule],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>{{ title() }}</mat-card-title>
        <mat-card-subtitle class="subtitle">
          <span>Case {{ shortCaseId() }}</span>
          <button mat-icon-button type="button" (click)="copyCaseId()" aria-label="Copy the case id"><mat-icon>content_copy</mat-icon></button>
          @if (copied()) {
            <span class="muted">copied</span>
          }
        </mat-card-subtitle>
      </mat-card-header>
      <mat-card-content>
        <div class="row">
          <a mat-button routerLink="/cases"><mat-icon>arrow_back</mat-icon> Cases</a>
          <button mat-stroked-button type="button" (click)="refresh()" [disabled]="busy()">Refresh</button>
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
            <p>You are the {{ d.case.side }} of this escrow.</p>
          }
          <p class="muted">Transaction <code>{{ d.case.transactionId }}</code></p>

          @if (d.kind === 'trade') {
            <h3>Share my lookup id</h3>
            <p>
              The attestor checks your security buckets against you on a video call. For that they need your lookup id: the one-way hash of your
              birth record you made at setup. Nothing but the lookup id leaves this device.
            </p>
            <div class="row">
              <button mat-flat-button type="button" (click)="shareLookupId()" [disabled]="busy() || d.case.lookupIdShared || final()">
                {{ d.case.lookupIdShared ? 'Lookup id shared' : 'Share my lookup id' }}
              </button>
            </div>
            @if (shareOutcome(); as o) { <p [class.error]="!o.ok" [class.ok]="o.ok">{{ o.text }}</p> }
          }

          @if (d.kind === 'dispute') {
            <h3>Evidence</h3>
            @if (final()) {
              <p class="muted">The attestors' copies have been deleted; your copies stay.</p>
            } @else {
              <p>Screenshots, photos of receipts, PDFs: each file is encrypted on this device, once for you and once for the attestors of this case.</p>
              <div class="row">
                <input #picker type="file" multiple accept="image/jpeg,image/png,image/webp,application/pdf" (change)="picked.set(filesOf($event))" />
                <button mat-flat-button type="button" (click)="upload(picker)" [disabled]="uploadBusy() || picked().length === 0">Upload {{ picked().length || '' }}</button>
              </div>
              @if (uploadBusy()) {
                <mat-progress-bar mode="indeterminate"></mat-progress-bar>
                <p class="muted">{{ uploadStep() }}</p>
              }
              @if (uploadOutcome(); as o) { <p [class.error]="!o.ok" [class.ok]="o.ok">{{ o.text }}</p> }
            }
            <h4>Your files ({{ mine().length }})</h4>
            <div class="files">
              @for (f of mine(); track f.evidenceId) {
                <div class="file">
                  @if (f.url) {
                    @if (f.isPdf) {
                      <a [href]="f.url" target="_blank" rel="noopener" class="pdf"><mat-icon>picture_as_pdf</mat-icon> PDF</a>
                    } @else {
                      <a [href]="f.url" target="_blank" rel="noopener"><img [src]="f.url" alt="your evidence" /></a>
                    }
                  } @else {
                    <mat-icon class="locked">lock</mat-icon>
                  }
                  <div class="muted">{{ f.contentType }} · {{ f.when }}</div>
                </div>
              } @empty {
                <p class="muted">Nothing uploaded yet.</p>
              }
            </div>
            @if (!final() && others().length > 0) {
              <h4>Your files from other cases</h4>
              <p class="muted">Supplying one again wraps its key for this case's attestors; nothing is uploaded twice.</p>
              <div class="files">
                @for (f of others(); track f.evidenceId) {
                  <div class="file">
                    @if (f.url) {
                      @if (f.isPdf) {
                        <a [href]="f.url" target="_blank" rel="noopener" class="pdf"><mat-icon>picture_as_pdf</mat-icon> PDF</a>
                      } @else {
                        <a [href]="f.url" target="_blank" rel="noopener"><img [src]="f.url" alt="your evidence" /></a>
                      }
                    } @else {
                      <mat-icon class="locked">lock</mat-icon>
                    }
                    <div class="muted">{{ f.contentType }} · {{ f.when }} · case {{ f.caseId.slice(0, 8) }}…</div>
                    <button mat-stroked-button type="button" (click)="supplyAgain(f)" [disabled]="uploadBusy() || !f.url">Supply again</button>
                  </div>
                }
              </div>
            }
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

  protected readonly words = STATUS_WORDS;
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
    if (!d) return 'My case';
    return d.kind === 'trade' ? 'An attestor is checking your trade' : 'Attestors are looking at this escrow';
  });

  protected readonly final = computed(() => {
    const status = this.data()?.case.status;
    return status !== undefined && !REVIEW_STATUSES.includes(status);
  });

  protected readonly statusText = computed(() => {
    const d = this.data();
    if (!d) return 'Loading your case…';
    const trade = d.kind === 'trade';
    switch (d.case.status) {
      case 'open':
        return trade
          ? 'Open: an attestor opened a case on your trade and will meet you on a video call. Share your lookup id below.'
          : 'Open: attestors opened a case on this escrow. Upload your evidence below.';
      case 'inReview':
        return trade ? 'In review: an attestor is checking your trade.' : 'In review: attestors are looking at the evidence.';
      case 'decided': {
        if (trade) return 'Decided: two attestors signed. The attestations go to the validators and the trade completes in the next round.';
        const verdict = this.decidedVerdict(d.events);
        return `Decided: ${verdict === 'success' ? 'success, the escrow is released to the seller' : verdict === 'cancel' ? 'cancel, the escrow returns to the buyer' : 'the attestors agreed'}.`;
      }
      case 'dismissed':
        return `Dismissed: ${this.dismissReason(d.events)}.`;
    }
  });

  protected readonly timeline = computed<TimelineItem[]>(() =>
    (this.data()?.events ?? []).map((event, i) => ({
      key: `${i}-${event.kind}-${event.createdAt}`,
      icon: this.iconOf(event),
      text: this.textOf(event),
      link: event.kind === 'scheduled' && typeof event.details['meetLink'] === 'string' ? event.details['meetLink'] : null,
      when: new Date(event.createdAt).toLocaleString(),
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
      this.error.set(res.status === 404 ? 'No case of yours with this id.' : `/get-my-case: ${reasonOf(res)}`);
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
      const view: FileView = { evidenceId: row.evidenceId, caseId, contentType: row.contentType, isPdf: row.contentType === 'application/pdf', url: null, when: new Date(row.createdAt).toLocaleString() };
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
      if (!identity) throw new Error('Your identity is not in RAM: unlock again. Setup must be complete.');
      const res = await this.masterpod.shareLookupId(this.caseId(), identity.lookupId);
      if (!res.ok) throw new Error(this.refusal(res, '/share-lookup-id'));
      this.shareOutcome.set({ ok: true, text: 'Shared. The attestor can now pull your bucket keys from the keyholders and meet you on the call.' });
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
      if (!encryptionKey) throw new Error('Your encryption key is not in RAM: unlock again.');
      const aad = this.crypto.fromHex(d.case.caseId);
      const entries: EvidenceFile[] = [];
      for (const file of this.picked()) {
        if (!CONTENT_TYPES.includes(file.type)) throw new Error(`${file.name}: only JPEG, PNG and WebP images and PDFs are taken.`);
        if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name}: larger than 10 MB.`);
        this.uploadStep.set(`Encrypting ${file.name}…`);
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
        this.uploadStep.set(`Uploading ${Math.min(i + FILES_PER_REQUEST, entries.length)} of ${entries.length}…`);
        const res = await this.masterpod.addDisputeEvidence(this.caseId(), entries.slice(i, i + FILES_PER_REQUEST));
        if (!res.ok) throw new Error(this.refusal(res, '/add-dispute-evidence'));
      }
      this.picked.set([]);
      picker.value = '';
      this.uploadOutcome.set({ ok: true, text: `Uploaded ${entries.length} file${entries.length === 1 ? '' : 's'}. The attestors of this case can open them; you keep your copies.` });
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
      if (!encryptionKey) throw new Error('Your encryption key is not in RAM: unlock again.');
      const source = await this.masterpod.getMyCase(file.caseId, true);
      const row = source.ok && source.body.kind === 'dispute' ? source.body.evidence.find((e) => e.evidenceId === file.evidenceId) : undefined;
      if (!row) throw new Error('That file is no longer among your cases.');
      const contentKey = await this.crypto.decrypt(encryptionKey, this.crypto.fromHex(row.keyForMe));
      const existing: ExistingEvidence[] = [{ evidenceId: row.evidenceId, keyForCase: this.crypto.toHex(await this.crypto.encryptToHybrid(d.case.caseKey, contentKey, this.crypto.fromHex(d.case.caseId))) }];
      contentKey.fill(0);
      const res = await this.masterpod.addDisputeEvidence(this.caseId(), [], existing);
      if (!res.ok) throw new Error(this.refusal(res, '/add-dispute-evidence'));
      this.uploadOutcome.set({ ok: true, text: 'Supplied again: the attestors of this case can open it now.' });
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
    if (res.status === 409 && /already shared/.test(reason)) return 'Your lookup id is already shared on this case.';
    if (res.status === 409 && /case closed/.test(reason)) return 'This case is closed: nothing more can be added to it.';
    if (res.status === 404 && /unknown evidence/.test(reason)) return 'That file is not one of yours any more.';
    if (res.status === 400) return `${path}: the masterpod refused the values (${reason}).`;
    return `${path}: ${reason}`;
  }

  // --- copy and the timeline -------------------------------------------------------------

  protected async copyCaseId(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.caseId());
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } catch {
      this.error.set('Could not copy; select the id by hand.');
    }
  }

  private decidedVerdict(events: MyCaseEvent[]): string | null {
    const verdict = [...events].reverse().find((e) => e.kind === 'decided')?.details['verdict'];
    return typeof verdict === 'string' ? verdict : null;
  }

  private dismissReason(events: MyCaseEvent[]): string {
    const reason = [...events].reverse().find((e) => e.kind === 'dismissed')?.details['reason'];
    return typeof reason === 'string' ? (DISMISS_WORDS[reason] ?? reason) : 'another reason';
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
    switch (event.kind) {
      case 'opened':
        return 'Case opened by an attestor';
      case 'lookupIdShared':
        return 'You shared your lookup id';
      case 'evidenceAdded':
        return `You added ${files} file${files === 1 ? '' : 's'}`;
      case 'scheduled': {
        const at = typeof d['at'] === 'string' ? new Date(d['at']).toLocaleString() : 'a time to be confirmed';
        return `Video call scheduled for ${at}.`;
      }
      case 'decided':
        return typeof d['verdict'] === 'string' ? `Decided: ${d['verdict']}` : 'Decided: two attestors signed';
      case 'lookupIdCleared':
        return 'Your lookup id was cleared from the case';
      case 'evidenceDeleted':
        return "The attestors' copies of the evidence were deleted; your copies stay";
      case 'sent':
        return 'The decision was sent to the validators';
      case 'dismissed':
        return `Dismissed: ${typeof d['reason'] === 'string' ? (DISMISS_WORDS[d['reason']] ?? d['reason']) : 'another reason'}`;
      default:
        return event.kind;
    }
  }
}
