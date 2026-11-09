import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { Router, RouterLink } from '@angular/router';
import { LanguageService } from '../services/language.service';
import { ApiResponse, reasonOf } from '../services/log.service';
import { DaoSettings, MasterpodApiService } from '../services/masterpod-api.service';

/** The masterpod's limits on a proposal (masterpod 15.3): the title and the body, in characters. */
const TITLE_MAX = 100;
const BODY_MAX = 5000;

/**
 * New proposal (wallet spec 8.2, DAO; the plan is
 * forclaude/dao-voting-plan-1.md, section 4), at /dao/new, in the frame of
 * the new-listing page: a back arrow to /dao; the title (100 characters at
 * most, a counter under it); the body as a textarea of 10 rows (5,000 at
 * most, its counter); the rule with the numbers from the masterpod's
 * settings, read quietly with /list-dao-proposals { status: 'open', limit:
 * 1 } when the page opens; Post proposal, disabled until both fields have
 * text and while busy. Post calls /create-dao-proposal with the trimmed
 * fields; a 201 opens the proposal's page. The refusals in words: not
 * enough DAO votes, a pending proposal is already open and validators
 * unreachable have their sentences, the rest show with the path.
 */
@Component({
  selector: 'app-dao-new-page',
  imports: [FormsModule, RouterLink, MatButtonModule, MatIconModule, MatFormFieldModule, MatInputModule],
  template: `
    <header class="head">
      <a mat-icon-button routerLink="/dao" [attr.aria-label]="t().common.back"><mat-icon>arrow_back</mat-icon></a>
      <h2>{{ t().daoNew.title }}</h2>
    </header>
    <mat-form-field appearance="outline" class="wide">
      <mat-label>{{ t().daoNew.titleLabel }}</mat-label>
      <input matInput [maxlength]="titleMax" [ngModel]="title()" (ngModelChange)="title.set($event)" />
      <mat-hint align="end">{{ t().daoNew.counter(title().length, titleMax) }}</mat-hint>
    </mat-form-field>
    <mat-form-field appearance="outline" class="wide">
      <mat-label>{{ t().daoNew.bodyLabel }}</mat-label>
      <textarea matInput rows="10" [maxlength]="bodyMax" [ngModel]="body()" (ngModelChange)="body.set($event)"></textarea>
      <mat-hint align="end">{{ t().daoNew.counter(body().length, bodyMax) }}</mat-hint>
    </mat-form-field>
    @if (settings(); as s) {
      <p class="muted">{{ t().daoNew.rule(s.proposalPercent, days(s.pendingMinutes), s.proposeMinVotes) }}</p>
    }
    @if (error(); as text) {
      <p class="error">{{ text }}</p>
    }
    <button mat-flat-button type="button" class="big" (click)="post()" [disabled]="busy() || !canPost()">{{ t().daoNew.post }}</button>
  `,
  styles: `
    :host { display: block; max-width: 560px; margin: 0 auto; }
    .head { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; }
    h2 { font-size: 1.25rem; font-weight: 500; margin: 0; }
    .wide { width: 100%; }
    .big { width: 100%; height: 48px; font-size: 1rem; margin-top: 8px; }
    .muted { color: var(--mat-sys-on-surface-variant); }
    .error { color: var(--mat-sys-error); }
  `,
})
export class DaoNewPage {
  private readonly api = inject(MasterpodApiService);
  private readonly router = inject(Router);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  protected readonly titleMax = TITLE_MAX;
  protected readonly bodyMax = BODY_MAX;
  protected readonly title = signal('');
  protected readonly body = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  /** The masterpod's dials for the rule, read quietly when the page opens; null until they came, and the rule waits. */
  protected readonly settings = signal<DaoSettings | null>(null);

  protected readonly canPost = computed(() => this.title().trim() !== '' && this.body().trim() !== '');

  constructor() {
    void this.api.listDaoProposals({ status: 'open', limit: 1 }, true).then((res) => {
      if (res.ok) this.settings.set(res.body.settings);
    });
  }

  /** The minutes of a setting in days, for the words. */
  protected days(minutes: number): number {
    return Math.round(minutes / 1440);
  }

  /** /create-dao-proposal with the trimmed fields; a 201 opens the proposal's page, a refusal shows in words. */
  protected async post(): Promise<void> {
    if (this.busy() || !this.canPost()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const res = await this.api.createDaoProposal(this.title().trim(), this.body().trim());
      if (res.ok) await this.router.navigate(['/dao', res.body.proposalId]);
      else this.error.set(this.refusal(res));
    } finally {
      this.busy.set(false);
    }
  }

  /** The refusal in words (masterpod 15.4): the three the plan names, the rest with the path. */
  private refusal(res: ApiResponse<unknown>): string {
    const reason = reasonOf(res);
    if (/not enough DAO votes/.test(reason)) return this.t().daoNew.notEnough(this.settings()?.proposeMinVotes ?? 1);
    if (/a pending proposal is already open/.test(reason)) return this.t().daoNew.alreadyPending;
    if (/validators unreachable/.test(reason)) return this.t().daoNew.unreachable;
    return `/create-dao-proposal: ${reason}`;
  }
}
