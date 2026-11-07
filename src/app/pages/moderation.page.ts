import { Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { RouterLink } from '@angular/router';
import type { Words } from '../i18n/en';
import { LanguageService } from '../services/language.service';
import { ApiResponse, reasonOf } from '../services/log.service';
import { MasterpodApiService, RecoveryCaseItem } from '../services/masterpod-api.service';
import { CaseStatus } from '../services/recovery.service';

/** The six statuses of a case (masterpod 12.5), the four in-progress ones first; the filter starts with those four. */
export const CASE_STATUSES: CaseStatus[] = ['open', 'inReview', 'approved', 'delivering', 'completed', 'dismissed'];
const DEFAULT_STATUSES: CaseStatus[] = ['open', 'inReview', 'approved', 'delivering'];

/** The icon of a status, for the list and the case page. */
export const STATUS_ICONS: Record<CaseStatus, string> = {
  open: 'flag',
  inReview: 'videocam',
  approved: 'verified',
  delivering: 'local_shipping',
  completed: 'check_circle',
  dismissed: 'block',
};

/** The masterpod's 403 not a moderator in words (wallet spec 12.2), from the dictionary `words`; other refusals as they are. */
export function moderationError(res: ApiResponse<unknown>, path: string, words: Words): string {
  if (res.status === 403 && /not a moderator/.test(reasonOf(res))) return words.moderation.notModerator;
  return `${path}: ${reasonOf(res)}`;
}

/**
 * Moderation (wallet spec 12.3, /moderation, the moderator edition): the
 * cases from /list-recovery-cases with a status filter (the four open
 * statuses by default, plus completed and dismissed), each row the username,
 * the names, the status, the approvals and when it was opened. A row opens
 * /moderation/:caseId.
 */
@Component({
  selector: 'app-moderation-page',
  imports: [RouterLink, MatCardModule, MatButtonModule, MatListModule, MatIconModule, MatFormFieldModule, MatSelectModule, MatProgressBarModule],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>{{ t().moderation.title }}</mat-card-title>
        <mat-card-subtitle>{{ t().moderation.subtitle }}</mat-card-subtitle>
      </mat-card-header>
      <mat-card-content>
        <div class="row">
          <mat-form-field appearance="outline" class="filter">
            <mat-label>{{ t().common.status }}</mat-label>
            <mat-select multiple [value]="statuses()" (valueChange)="filter($event)">
              @for (status of allStatuses; track status) {
                <mat-option [value]="status">{{ t().recoveryStatus[status] ?? status }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <button mat-stroked-button type="button" (click)="load()" [disabled]="busy()">{{ t().common.refresh }}</button>
        </div>
        @if (busy()) {
          <mat-progress-bar mode="indeterminate"></mat-progress-bar>
        }
        @if (error(); as text) {
          <p class="error">{{ text }}</p>
        }
        <mat-list>
          @for (c of cases(); track c.caseId) {
            <mat-list-item lines="3">
              <mat-icon matListItemIcon>{{ icons[c.status] }}</mat-icon>
              <a matListItemTitle [routerLink]="['/moderation', c.caseId]">{{ t().common.personLine(c.username ?? t().common.unknownPod, c.firstName, c.lastName) }}</a>
              <span matListItemLine>{{ t().recoveryStatus[c.status] ?? c.status }} · {{ t().moderation.approvalsLine(c.approvals, lang.dateTime(c.createdAt)) }}</span>
              <span matListItemLine><code>{{ c.caseId }}</code></span>
            </mat-list-item>
          } @empty {
            @if (!busy() && !error()) {
              <p class="muted">{{ t().moderation.none }}</p>
            }
          }
        </mat-list>
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .filter { min-width: 320px; }
    .muted { color: var(--mat-sys-on-surface-variant); }
    .error { color: var(--mat-sys-error); }
    code { font-size: 12px; word-break: break-all; }
  `,
})
export class ModerationPage {
  private readonly api = inject(MasterpodApiService);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  protected readonly allStatuses = CASE_STATUSES;
  protected readonly icons = STATUS_ICONS;
  protected readonly statuses = signal<CaseStatus[]>(DEFAULT_STATUSES);
  protected readonly cases = signal<RecoveryCaseItem[]>([]);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    void this.load();
  }

  protected filter(statuses: CaseStatus[]): void {
    this.statuses.set(statuses);
    void this.load();
  }

  protected async load(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const res = await this.api.listRecoveryCases(this.statuses());
      if (res.ok) this.cases.set(res.body.cases);
      else this.error.set(moderationError(res, '/list-recovery-cases', this.t()));
    } finally {
      this.busy.set(false);
    }
  }
}
