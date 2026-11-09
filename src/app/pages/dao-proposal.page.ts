import { NgTemplateOutlet } from '@angular/common';
import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { RouterLink } from '@angular/router';
import { AvatarComponent } from '../components/avatar.component';
import { LanguageService } from '../services/language.service';
import { ApiResponse, reasonOf } from '../services/log.service';
import { DaoProposal, DaoVoteItem, MasterpodApiService } from '../services/masterpod-api.service';
import { SessionService } from '../services/session.service';

/** A list of votes reads this many rows at a time, and Show more as many more by offset. */
const PAGE = 50;

/** The two lists of /list-dao-votes: the supports of the pending stage, the votes of the official stage. */
type Stage = 'pending' | 'official';

/** What the caller is about to do, asked in place before it is sent: a support, or a vote for or against (the wire words). */
type Action = 'support' | 'for' | 'against';

/** The masterpod's reasons that mean the stage is over (masterpod 15.4): the page says so and reads the proposal again. */
const CLOSED = /proposal not pending|proposal not open|proposal expired|voting closed/;

/** One stage's rows, whether its first read answered, whether the last page came back full, and the read's refusal. */
interface VoteList {
  items: DaoVoteItem[];
  loaded: boolean;
  more: boolean;
  error: string | null;
}

const EMPTY: VoteList = { items: [], loaded: false, more: false, error: null };

/**
 * Proposal (wallet spec 8.2, DAO, Proposal; the plan is
 * forclaude/dao-voting-plan-1.md, section 5), at /dao/:proposalId, in the
 * frame of the listing page. /get-dao-proposal when the page opens, after
 * each action and on Refresh; "Loading" until the first answer, "This
 * proposal does not exist." on a 404, any other refusal in red. A back
 * arrow to /dao. Then, top to bottom: the status as a small label (the
 * result label once decided); the title as the heading; the proposer's
 * avatar (8.6, 40 px) and the by-line with the date posted; the text as
 * typed, line breaks kept, nothing rendered; the numbers (pending and
 * expired: the support over the support needed with a progress bar and
 * until when; open: for and against in large type and when the vote
 * closes; decided: for and against and when); the snapshot's total; the
 * caller's votes in it, or the no-votes sentence at 0. Then the action,
 * one per pod per stage, no undo, asked in place: on a pending proposal
 * one big button, Support with n votes; on an open one two side by side,
 * For and Against, the green thumb_up and the red thumb_down; Yes sends
 * it, the green line says it is recorded and the proposal is read again
 * (a support may have opened it); after the caller acted, "You supported
 * this" or "You voted for/against" with the icon and no button; without
 * votes in the snapshot, no button. The refusals in words. Below, the
 * public lists from /list-dao-votes, PAGE rows at a time with Show more
 * by offset: the votes once the proposal has opened, then the supporters;
 * a row is the username (the caller's own tagged "you"), the time, the
 * colored thumb and the weight in votes.
 */
@Component({
  selector: 'app-dao-proposal-page',
  imports: [NgTemplateOutlet, RouterLink, MatButtonModule, MatIconModule, MatProgressBarModule, AvatarComponent],
  template: `
    <header class="head">
      <a mat-icon-button routerLink="/dao" [attr.aria-label]="t().common.back"><mat-icon>arrow_back</mat-icon></a>
      <span class="spacer"></span>
      <button mat-icon-button type="button" (click)="refresh()" [disabled]="busy()" [attr.aria-label]="t().common.refresh"><mat-icon>refresh</mat-icon></button>
    </header>
    @if (proposal(); as p) {
      <span class="label" [class.for]="p.status === 'accepted'" [class.against]="p.status === 'rejected'" [class.muted]="p.status === 'expired'">{{ statusLabel(p) }}</span>
      <h2>{{ p.title }}</h2>
      <div class="proposer">
        <app-avatar [anopodId]="p.proposer.anopodId" [username]="p.proposer.username ?? ''" [size]="40" />
        <span class="muted">{{ t().dao.by(p.proposer.username ?? t().common.unknownPod, dateOf(p.createdAt)) }}</span>
      </div>
      <p class="body">{{ p.body }}</p>

      <div class="numbers">
        @if (p.status === 'pending' || p.status === 'expired') {
          <span>{{ t().dao.supportLine(p.support, p.needed) }}</span>
          <mat-progress-bar mode="determinate" [value]="percentOf(p)"></mat-progress-bar>
          <span class="muted small">{{ t().dao.until(lang.dateTime(p.pendingUntil)) }}</span>
        } @else {
          <span [class.large]="p.status === 'open'">{{ t().dao.forAgainst(p.for, p.against) }}</span>
          @if (p.status === 'open' && p.voteClosesAt) {
            <span class="muted small">{{ t().dao.closes(lang.dateTime(p.voteClosesAt)) }}</span>
          }
          @if (p.status !== 'open' && p.decidedAt) {
            <span class="muted small">{{ t().dao.decidedOn(lang.dateTime(p.decidedAt)) }}</span>
          }
        }
        <span class="muted small">{{ t().dao.snapshotTotal(p.snapshotTotal) }}</span>
      </div>
      <p>{{ p.yourWeight >= 1 ? t().dao.yourWeight(p.yourWeight) : t().dao.noWeight }}</p>

      @if (p.status === 'pending' && p.yourSupport) {
        <p class="you"><mat-icon class="for">thumb_up</mat-icon> {{ t().dao.youSupported }}</p>
      } @else if (p.status !== 'pending' && p.yourVote) {
        <p class="you"><mat-icon [class.for]="p.yourVote === 'for'" [class.against]="p.yourVote === 'against'">{{ p.yourVote === 'for' ? 'thumb_up' : 'thumb_down' }}</mat-icon> {{ t().dao.youVoted(p.yourVote) }}</p>
      } @else if (p.yourWeight >= 1 && (p.status === 'pending' || p.status === 'open')) {
        @if (asking(); as action) {
          <p>{{ action === 'support' ? t().dao.askSupport(p.yourWeight) : t().dao.askVote(action, p.yourWeight) }}</p>
          <div class="buttons">
            <button mat-flat-button type="button" (click)="confirm()" [disabled]="busy()">{{ action === 'support' ? t().dao.yesSupport : t().dao.yesVote(action) }}</button>
            <button mat-button type="button" (click)="asking.set(null)" [disabled]="busy()">{{ t().common.back }}</button>
          </div>
        } @else if (p.status === 'pending') {
          <div class="action">
            <button mat-stroked-button type="button" class="big" (click)="asking.set('support')" [disabled]="busy()"><mat-icon class="for">thumb_up</mat-icon> {{ t().dao.support(p.yourWeight) }}</button>
          </div>
        } @else {
          <div class="action">
            <button mat-stroked-button type="button" class="big" (click)="asking.set('for')" [disabled]="busy()"><mat-icon class="for">thumb_up</mat-icon> {{ t().dao.for }}</button>
            <button mat-stroked-button type="button" class="big" (click)="asking.set('against')" [disabled]="busy()"><mat-icon class="against">thumb_down</mat-icon> {{ t().dao.against }}</button>
          </div>
        }
      }
      @if (done(); as text) {
        <p class="ok">{{ text }}</p>
      }
      @if (error(); as text) {
        <p class="error">{{ text }}</p>
      }

      @if (p.openedAt) {
        <h3>{{ t().dao.votes }}</h3>
        <ng-container *ngTemplateOutlet="rows; context: { $implicit: votes(), stage: 'official' }" />
      }
      <h3>{{ t().dao.supporters }}</h3>
      <ng-container *ngTemplateOutlet="rows; context: { $implicit: supports(), stage: 'pending' }" />

      <ng-template #rows let-list let-stage="stage">
        @if (list.error; as text) {
          <p class="error">{{ text }}</p>
        } @else if (list.loaded && list.items.length === 0) {
          <p class="muted">{{ t().dao.noVotesYet }}</p>
        }
        @for (v of list.items; track v.anopodId) {
          <div class="row">
            <span class="texts">
              <span class="name">{{ v.username ?? t().common.unknownPod }} @if (mine(v)) {<span class="tag">{{ t().dao.you }}</span>}</span>
              <span class="muted small">{{ lang.dateTime(v.createdAt) }}</span>
            </span>
            <span class="weight"><mat-icon [class.for]="v.vote === 'for'" [class.against]="v.vote === 'against'">{{ v.vote === 'for' ? 'thumb_up' : 'thumb_down' }}</mat-icon> {{ t().dao.votesWord(v.weight) }}</span>
          </div>
        }
        @if (list.more) {
          <button mat-button type="button" (click)="loadMore(stage)" [disabled]="busy()">{{ t().dao.showMore }}</button>
        }
      </ng-template>
    } @else if (notFound()) {
      <p class="muted">{{ t().dao.notFound }}</p>
    } @else if (error(); as text) {
      <p class="error">{{ text }}</p>
    } @else {
      <p class="muted">{{ t().common.loading }}</p>
    }
  `,
  styles: `
    :host { display: block; max-width: 560px; margin: 0 auto; }
    .head { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; }
    .spacer { flex: 1; }
    .label { display: inline-block; font-size: 11px; font-weight: 500; padding: 2px 8px; border-radius: 10px; border: 1px solid currentColor; }
    h2 { font-size: 1.25rem; font-weight: 500; margin: 8px 0; }
    h3 { font-size: 1rem; font-weight: 500; margin: 24px 0 4px; }
    .proposer { display: flex; align-items: center; gap: 12px; margin: 8px 0 16px; }
    .body { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0 0 16px; }
    .numbers { display: flex; flex-direction: column; gap: 6px; margin: 16px 0; }
    .large { font-size: 1.6rem; font-weight: 700; }
    .small { font-size: 13px; }
    .you { display: flex; align-items: center; gap: 6px; }
    .action { display: flex; gap: 8px; margin: 12px 0 4px; }
    .big { flex: 1; height: 48px; font-size: 1rem; }
    .buttons { display: flex; gap: 8px; margin: 8px 0; }
    .row { display: flex; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--mat-sys-outline-variant); }
    .texts { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .name { font-weight: 500; }
    .tag { font-size: 11px; font-weight: 400; padding: 1px 6px; border-radius: 8px; border: 1px solid currentColor; color: var(--mat-sys-on-surface-variant); }
    .weight { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
    .weight mat-icon { font-size: 18px; width: 18px; height: 18px; }
    .for { color: #2e7d32; }
    .against { color: var(--mat-sys-error); }
    .ok { color: #2e7d32; }
    .muted { color: var(--mat-sys-on-surface-variant); }
    .error { color: var(--mat-sys-error); }
  `,
})
export class DaoProposalPage {
  readonly proposalId = input.required<string>();

  private readonly api = inject(MasterpodApiService);
  private readonly session = inject(SessionService);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  protected readonly proposal = signal<DaoProposal | null>(null);
  protected readonly notFound = signal(false);
  /** The official stage's rows, read once the proposal has opened. */
  protected readonly votes = signal<VoteList>(EMPTY);
  /** The pending stage's rows, every one a support. */
  protected readonly supports = signal<VoteList>(EMPTY);
  /** What is asked in place, or null while nothing is. */
  protected readonly asking = signal<Action | null>(null);
  protected readonly busy = signal(false);
  /** The green line after an action: the support or the vote is recorded. */
  protected readonly done = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);

  constructor() {
    effect(() => {
      this.proposalId();
      untracked(() => this.refresh());
    });
  }

  /** The status as a label; Accepted and Rejected are the result once decided. */
  protected statusLabel(p: DaoProposal): string {
    const dao = this.t().dao;
    switch (p.status) {
      case 'pending':
        return dao.pendingLabel;
      case 'open':
        return dao.openForVotes;
      case 'accepted':
        return dao.accepted;
      case 'rejected':
        return dao.rejected;
      default:
        return dao.expired;
    }
  }

  /** The date the proposal was posted, without the time, in the language's own shape (the DAO page's cards). */
  protected dateOf(iso: string): string {
    return new Date(iso).toLocaleDateString(this.lang.tag(), { dateStyle: 'medium' });
  }

  /** The support as a percent of the support needed, for the progress bar, 100 at most. */
  protected percentOf(p: DaoProposal): number {
    return p.needed > 0 ? Math.min(100, (p.support / p.needed) * 100) : 0;
  }

  /** The caller's own row, by the pod id against the session's. */
  protected mine(row: DaoVoteItem): boolean {
    return row.anopodId === this.session.anopodId();
  }

  /** Refresh, and the first read: the messages cleared, the proposal and its lists read again. */
  protected refresh(): void {
    this.done.set(null);
    this.error.set(null);
    void this.reload();
  }

  /** /get-dao-proposal for the route's id, then the lists: the supports always, the votes once the proposal has opened; "does not exist" on a 404. */
  private async reload(): Promise<void> {
    const res = await this.api.getDaoProposal(this.proposalId());
    if (res.ok) {
      this.proposal.set(res.body.proposal);
      this.notFound.set(false);
      const reads = [this.loadVotes('pending')];
      if (res.body.proposal.openedAt) reads.push(this.loadVotes('official'));
      else this.votes.set(EMPTY);
      await Promise.all(reads);
    } else if (res.status === 404) {
      this.proposal.set(null);
      this.notFound.set(true);
    } else {
      this.error.set(`/get-dao-proposal: ${reasonOf(res)}`);
    }
  }

  /** One page of /list-dao-votes for a stage: the first page replaces, a later one is added; a refusal shows under the heading. */
  private async loadVotes(stage: Stage, offset = 0): Promise<void> {
    const list = stage === 'official' ? this.votes : this.supports;
    const res = await this.api.listDaoVotes(this.proposalId(), stage, PAGE, offset);
    if (res.ok) {
      const page = res.body.votes;
      list.update((l) => ({ items: offset === 0 ? page : [...l.items, ...page], loaded: true, more: page.length >= PAGE, error: null }));
    } else {
      list.update((l) => ({ ...l, loaded: true, error: `/list-dao-votes: ${reasonOf(res)}` }));
    }
  }

  protected loadMore(stage: Stage): void {
    const list = stage === 'official' ? this.votes() : this.supports();
    void this.loadVotes(stage, list.items.length);
  }

  /** Yes, after the ask: /support-dao-proposal or /vote-dao-proposal; the ask closes, the green line says it is recorded and the proposal is read again (its status may now be open); a refusal in words, and one that means the stage is over reads again too. */
  protected async confirm(): Promise<void> {
    const action = this.asking();
    if (!action || this.busy()) return;
    this.busy.set(true);
    this.done.set(null);
    this.error.set(null);
    try {
      const id = this.proposalId();
      const res = action === 'support' ? await this.api.supportDaoProposal(id) : await this.api.voteDaoProposal(id, action);
      this.asking.set(null);
      if (res.ok) {
        this.done.set(action === 'support' ? this.t().dao.supported : this.t().dao.voted(action));
        await this.reload();
      } else {
        this.error.set(this.refusal(res, action === 'support' ? '/support-dao-proposal' : '/vote-dao-proposal'));
        if (CLOSED.test(reasonOf(res))) await this.reload();
      }
    } finally {
      this.busy.set(false);
    }
  }

  /** The refusal in words (the plan's 5.1, masterpod 15.4): already acted, no votes, the stage over, the validators; the rest with the path. */
  private refusal(res: ApiResponse<unknown>, path: string): string {
    const reason = reasonOf(res);
    const dao = this.t().dao;
    if (/already supported|already voted/.test(reason)) return dao.alreadyActed;
    if (/no DAO votes in this proposal/.test(reason)) return dao.noWeight;
    if (CLOSED.test(reason)) return dao.closedNow;
    if (/validators unreachable/.test(reason)) return this.t().daoNew.unreachable;
    return `${path}: ${reason}`;
  }
}
