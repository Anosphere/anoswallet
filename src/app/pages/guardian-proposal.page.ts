import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { RouterLink } from '@angular/router';
import { millionthsToAnos } from '../amounts';
import { CopyButtonComponent } from '../components/copy-button.component';
import { AnosApiService, FundProposal, FundSettings } from '../services/anos-api.service';
import { CryptoService, GuardianVotePayload, Vote } from '../services/crypto.service';
import { GuardianAccount, GuardianAccountsService } from '../services/guardian-accounts.service';
import { LanguageService } from '../services/language.service';
import { ApiResponse, reasonOf } from '../services/log.service';
import { SessionService } from '../services/session.service';
import { SigningService } from '../services/signing.service';
import { shortId } from '../short-id';

/** One of the caller's guardian accounts against the proposal: the proposer, the vote it cast, able to vote (the status open and neither of the two), or nothing to say. */
type AccountState = 'proposed' | Vote | 'canVote' | null;

/** The validator's reason that means the vote is over (anossoftware src/fund/guardian-vote.js, "the vote on this proposal has closed"): the page says so and reads the proposal again. */
const CLOSED = /has closed/;

/**
 * Fund proposal (wallet spec 8.2, Guardians, Fund proposal; the plan is
 * forclaude/wallet-guardians-plan-1.md, 4.1), at
 * /dao/guardians/:transactionId, in the frame of the DAO's Proposal page.
 * /get-fund-proposal when the page opens, after each action and on
 * Refresh; "Loading" until the first answer, "This proposal does not
 * exist." on the validator's 404 unknown proposal, any other refusal in
 * red. A back arrow to /dao/guardians. Then, top to bottom: the status as
 * a small label (green for written, red for failed; a word the wallet
 * does not know as it is); "Fund proposal" and the short id with a copy
 * button; by whom and the date; the payouts, one row each (the amount in
 * anos to the recipient's short id with a copy button, the reason, and
 * "returns guardian stake" when the payout returns stake) and the total
 * line; the numbers (open: for and against in large type, the bar of for
 * over for plus against, the percent needed and when the vote closes;
 * waiting: for and against and when the vote closes; closing: for and
 * against; decided: for and against and when). Your part (the plan's
 * decision 8): "Voting as", a select of the caller's guardian accounts
 * (guardian-accounts.service), each option the short id, its votes and
 * its state (you proposed this, you voted for, can vote); the first
 * account that can still vote is selected, the first in the list when
 * none can; without a guardian account the become-a-guardian sentence and
 * no select. Under it the selected account's state, or, while the vote is
 * open and the account neither proposed nor voted, For and Against, the
 * DAO page's pair, asking in place; Yes opens pair one of the account for
 * the signature and drops it, builds the guardianVote follow-up, has
 * /api/sign add the wallet pair and posts /guardian-vote; the green line
 * says the vote is sent, the proposal is read again (the vote shows as
 * waiting for approval until every validator accepted it) and the select
 * moves to the next account that can still vote. The refusals in words,
 * matched on the validator's own text. Below, "Votes": the proposer's
 * row with the green thumb and "proposer · 3 votes for", then one row per
 * vote in the validator's order: the short id with a copy button (the
 * caller's own tagged "you"), approved or waiting for approval and the
 * time, the colored thumb and the votes; "No votes yet." under the
 * proposer alone.
 */
@Component({
  selector: 'app-guardian-proposal-page',
  imports: [RouterLink, MatButtonModule, MatIconModule, MatProgressBarModule, MatFormFieldModule, MatSelectModule, CopyButtonComponent],
  template: `
    <header class="head">
      <a mat-icon-button routerLink="/dao/guardians" [attr.aria-label]="t().common.back"><mat-icon>arrow_back</mat-icon></a>
      <span class="spacer"></span>
      <button mat-icon-button type="button" (click)="refresh()" [disabled]="busy()" [attr.aria-label]="t().common.refresh"><mat-icon>refresh</mat-icon></button>
    </header>
    @if (proposal(); as p) {
      <span class="label" [class.for]="p.status === 'written'" [class.against]="p.status === 'failed'">{{ statusWord(p.status) }}</span>
      <h2>
        <span>{{ t().guardians.fundProposal }} <code>{{ shortId(p.transactionId) }}</code></span>
        <app-copy-button [text]="p.transactionId" [label]="t().common.copyTransactionId" />
      </h2>
      <p class="muted">{{ t().guardians.proposedBy(shortId(p.guardianId), dateOf(p.createdAt)) }}</p>

      @for (payout of p.payouts; track payout.index) {
        <div class="row">
          <span class="texts">
            <span class="name">{{ t().guardians.payoutTo(anosOf(payout.amount), shortId(payout.accountIdTo)) }} <app-copy-button [text]="payout.accountIdTo" [label]="t().common.copyAccountId" /></span>
            @if (payout.reason) {
              <span class="muted small">{{ payout.reason }}</span>
            }
            @if (payout.stakeFor) {
              <span class="muted small">{{ t().guardians.returnsStake(payout.stakeFor) }}</span>
            }
          </span>
        </div>
      }
      <p class="total">{{ t().guardians.payouts(p.payoutCount, anosOf(p.total)) }}</p>

      <div class="numbers">
        <span [class.large]="p.status === 'open'">{{ t().guardians.forAgainst(p.forWeight, p.againstWeight) }}</span>
        @if (p.status === 'open') {
          <mat-progress-bar mode="determinate" [value]="percentOf(p)"></mat-progress-bar>
        }
        @if (p.status === 'open' || p.status === 'waiting') {
          <span class="muted small">
            @if (settings(); as s) {
              {{ t().guardians.needs(s.percent) }} ·
            }
            {{ t().guardians.closes(lang.dateTime(p.voteClosesAt)) }}
          </span>
        } @else if (p.decidedAt) {
          <span class="muted small">{{ t().guardians.decidedOn(lang.dateTime(p.decidedAt)) }}</span>
        }
      </div>

      @if (readingAccounts()) {
        <p class="muted">{{ t().common.reading }}</p>
      } @else if (accounts().length === 0) {
        @if (settings(); as s) {
          <p class="muted">{{ t().guardians.noGuardianAccount(anosOf(s.minimumStake)) }}</p>
        }
      } @else {
        <mat-form-field appearance="outline" class="wide" subscriptSizing="dynamic">
          <mat-label>{{ t().guardians.votingAs }}</mat-label>
          <mat-select [value]="voter()" (valueChange)="pick($event)">
            @for (a of accounts(); track a.accountId) {
              <mat-option [value]="a.accountId">
                {{ shortId(a.accountId) }} · {{ t().guardians.accountVotes(a.votes) }}
                @if (stateWord(a, p); as word) {
                  · {{ word }}
                }
              </mat-option>
            }
          </mat-select>
        </mat-form-field>
        @if (selected(); as a) {
          @switch (stateOf(a, p)) {
            @case ('proposed') {
              <p class="you"><mat-icon class="for">thumb_up</mat-icon> {{ t().guardians.youProposed }}</p>
            }
            @case ('for') {
              <p class="you"><mat-icon class="for">thumb_up</mat-icon> {{ t().guardians.youVoted('for') }}</p>
            }
            @case ('against') {
              <p class="you"><mat-icon class="against">thumb_down</mat-icon> {{ t().guardians.youVoted('against') }}</p>
            }
            @case ('canVote') {
              @if (asking(); as side) {
                <p>{{ t().guardians.askVote(side, a.votes, shortId(a.accountId)) }}</p>
                <div class="buttons">
                  <button mat-flat-button type="button" (click)="confirm()" [disabled]="busy()">{{ t().guardians.yesVote(side) }}</button>
                  <button mat-button type="button" (click)="asking.set(null)" [disabled]="busy()">{{ t().common.back }}</button>
                </div>
              } @else {
                <div class="action">
                  <button mat-stroked-button type="button" class="big" (click)="asking.set('for')" [disabled]="busy()"><mat-icon class="for">thumb_up</mat-icon> {{ t().guardians.for }}</button>
                  <button mat-stroked-button type="button" class="big" (click)="asking.set('against')" [disabled]="busy()"><mat-icon class="against">thumb_down</mat-icon> {{ t().guardians.against }}</button>
                </div>
              }
            }
          }
        }
      }
      @if (done(); as text) {
        <p class="ok">{{ text }}</p>
      }
      @if (error(); as text) {
        <p class="error">{{ text }}</p>
      }

      <h3>{{ t().guardians.votes }}</h3>
      <div class="row">
        <span class="texts">
          <span class="name"><code>{{ shortId(p.guardianId) }}</code> <app-copy-button [text]="p.guardianId" [label]="t().common.copyAccountId" /> @if (mine(p.guardianId)) {<span class="tag">{{ t().guardians.you }}</span>}</span>
          <span class="muted small">{{ lang.dateTime(p.createdAt) }}</span>
        </span>
        <span class="weight"><mat-icon class="for">thumb_up</mat-icon> {{ t().guardians.proposerRow(p.proposerWeight) }}</span>
      </div>
      @for (v of p.votes; track v.guardianId) {
        <div class="row">
          <span class="texts">
            <span class="name"><code>{{ shortId(v.guardianId) }}</code> <app-copy-button [text]="v.guardianId" [label]="t().common.copyAccountId" /> @if (mine(v.guardianId)) {<span class="tag">{{ t().guardians.you }}</span>}</span>
            <span class="muted small">{{ v.approved ? t().guardians.approvedWord : t().guardians.waitingWord }} · {{ lang.dateTime(v.votedAt) }}</span>
          </span>
          <span class="weight"><mat-icon [class.for]="v.vote === 'for'" [class.against]="v.vote === 'against'">{{ v.vote === 'for' ? 'thumb_up' : 'thumb_down' }}</mat-icon> {{ t().guardians.accountVotes(v.weight) }}</span>
        </div>
      }
      @if (p.votes.length === 0) {
        <p class="muted">{{ t().guardians.noVotesYet }}</p>
      }
    } @else if (notFound()) {
      <p class="muted">{{ t().guardians.notFound }}</p>
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
    h2 { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; font-size: 1.25rem; font-weight: 500; margin: 8px 0; }
    h2 code { font-size: 1rem; }
    h3 { font-size: 1rem; font-weight: 500; margin: 24px 0 4px; }
    .total { font-weight: 500; margin: 8px 0 0; }
    .numbers { display: flex; flex-direction: column; gap: 6px; margin: 16px 0; }
    .large { font-size: 1.6rem; font-weight: 700; }
    .small { font-size: 13px; }
    .wide { width: 100%; margin: 8px 0; }
    .you { display: flex; align-items: center; gap: 6px; }
    .action { display: flex; gap: 8px; margin: 12px 0 4px; }
    .big { flex: 1; height: 48px; font-size: 1rem; }
    .buttons { display: flex; gap: 8px; margin: 8px 0; }
    .row { display: flex; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--mat-sys-outline-variant); }
    .texts { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; overflow-wrap: anywhere; }
    .name { font-weight: 500; }
    .name code { font-size: 13px; }
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
export class GuardianProposalPage {
  readonly transactionId = input.required<string>();

  private readonly anos = inject(AnosApiService);
  private readonly guardians = inject(GuardianAccountsService);
  private readonly crypto = inject(CryptoService);
  private readonly signing = inject(SigningService);
  private readonly session = inject(SessionService);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  protected readonly shortId = shortId;
  protected readonly anosOf = millionthsToAnos;
  protected readonly proposal = signal<FundProposal | null>(null);
  /** The validator's dials, answered with the proposal: the percent needed beside the bar, the least stake in the become-a-guardian sentence. */
  protected readonly settings = signal<FundSettings | null>(null);
  protected readonly notFound = signal(false);
  /** The pod's accounts with guardian votes, the biggest first (guardian-accounts.service). */
  protected readonly accounts = signal<GuardianAccount[]>([]);
  protected readonly readingAccounts = signal(true);
  /** The account picked under Voting as; null until the proposal and the accounts are both known. */
  protected readonly voter = signal<string | null>(null);
  /** The side asked in place, or null while nothing is. */
  protected readonly asking = signal<Vote | null>(null);
  protected readonly busy = signal(false);
  /** The green line after a vote: it is sent to the validators. */
  protected readonly done = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);

  /** The picked account's entry, or null. */
  protected readonly selected = computed(() => this.accounts().find((a) => a.accountId === this.voter()) ?? null);

  constructor() {
    effect(() => {
      this.transactionId();
      untracked(() => this.refresh());
    });
  }

  /** The status in words; a word the wallet does not know shows as it is (anossoftware 25.2). */
  protected statusWord(status: string): string {
    return this.t().guardians.statuses[status] ?? status;
  }

  /** The date the proposal was made, without the time, in the language's own shape (the Guardians page's cards). */
  protected dateOf(iso: string): string {
    return new Date(iso).toLocaleDateString(this.lang.tag(), { dateStyle: 'medium' });
  }

  /** The votes for as a percent of the votes cast, for the progress bar; 0 before any vote. */
  protected percentOf(p: FundProposal): number {
    const cast = p.forWeight + p.againstWeight;
    return cast > 0 ? (p.forWeight / cast) * 100 : 0;
  }

  /** True for one of the pod's own accounts, the "you" tag on a row; an account that voted and has since returned its stake is still the pod's. */
  protected mine(accountId: string): boolean {
    return this.session.accounts().some((a) => a.accountId === accountId);
  }

  /** One of the caller's guardian accounts against the proposal: the proposer; the vote it cast; able to vote while the status is open and it is neither; nothing otherwise. */
  protected stateOf(account: GuardianAccount, p: FundProposal): AccountState {
    if (account.accountId === p.guardianId) return 'proposed';
    const vote = p.votes.find((v) => v.guardianId === account.accountId);
    if (vote) return vote.vote;
    return p.status === 'open' ? 'canVote' : null;
  }

  /** The state in words for an option of the select; null when there is nothing to say. */
  protected stateWord(account: GuardianAccount, p: FundProposal): string | null {
    const state = this.stateOf(account, p);
    const g = this.t().guardians;
    if (state === 'proposed') return g.youProposed;
    if (state === 'canVote') return g.canVote;
    return state ? g.youVoted(state) : null;
  }

  /** A pick in the select; a question asked for the account before closes, since it names the account. */
  protected pick(accountId: string): void {
    this.voter.set(accountId);
    this.asking.set(null);
  }

  /** Refresh, and the first read: the messages cleared, the proposal and the guardian accounts read again. */
  protected refresh(): void {
    this.done.set(null);
    this.error.set(null);
    void this.reload();
    void this.readAccounts();
  }

  /**
   * Yes, after the ask: pair one of the picked account for the signature
   * and dropped, the guardianVote follow-up (crypto.buildFollowUp), /api/sign,
   * /guardian-vote. The ask closes; the green line says the vote is sent and
   * the proposal is read again (the vote shows as waiting for approval until
   * every validator accepted it), then the select moves to the next account
   * that can still vote; a refusal in words, and one that means the vote is
   * over reads again too.
   */
  protected async confirm(): Promise<void> {
    const side = this.asking();
    const account = this.selected();
    if (!side || !account || this.busy()) return;
    this.busy.set(true);
    this.done.set(null);
    this.error.set(null);
    try {
      const payload: GuardianVotePayload = { type: 'guardianVote', transactionId: this.transactionId(), guardianId: account.accountId, vote: side };
      const pairOne = await this.guardians.pairOne(account.accountId);
      const followUp = await this.signing.sign(this.crypto.buildFollowUp(pairOne, payload));
      const res = await this.anos.guardianVote(followUp);
      this.asking.set(null);
      if (res.ok) {
        this.done.set(this.t().guardians.voted(side));
        await this.reload();
        this.moveOn();
      } else {
        this.error.set(this.refusal(res));
        if (CLOSED.test(reasonOf(res))) await this.reload();
      }
    } catch (err) {
      this.asking.set(null);
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }

  /** /get-fund-proposal for the route's id: "does not exist" on the validator's 404 unknown proposal; any other refusal in red, a doorman or a validator without the route's 404 among them. */
  private async reload(): Promise<void> {
    const res = await this.anos.getFundProposal(this.transactionId());
    if (res.ok) {
      this.proposal.set(res.body.proposal);
      this.settings.set(res.body.settings);
      this.notFound.set(false);
      this.settleVoter();
    } else if (res.status === 404 && /unknown proposal/.test(reasonOf(res))) {
      this.proposal.set(null);
      this.notFound.set(true);
    } else {
      this.error.set(`/get-fund-proposal: ${reasonOf(res)}`);
    }
  }

  /** The pod's guardian accounts, quietly; the list on screen stays until the new one is in. */
  private async readAccounts(): Promise<void> {
    this.readingAccounts.set(true);
    try {
      this.accounts.set(await this.guardians.read());
      this.settleVoter();
    } finally {
      this.readingAccounts.set(false);
    }
  }

  /** The select's pick once the proposal and the accounts are both known: a pick already made stays while its account is listed; else the first account that can still vote, else the first in the list. */
  private settleVoter(): void {
    const p = this.proposal();
    const accounts = this.accounts();
    if (!p || accounts.some((a) => a.accountId === this.voter())) return;
    const first = accounts.find((a) => this.stateOf(a, p) === 'canVote') ?? accounts[0];
    this.voter.set(first?.accountId ?? null);
  }

  /** After a vote: the select moves to the next account that can still vote, so the next vote is one pick away; it stays when none can. */
  private moveOn(): void {
    const p = this.proposal();
    const next = p && this.accounts().find((a) => this.stateOf(a, p) === 'canVote');
    if (next) this.voter.set(next.accountId);
  }

  /** The refusal in words, matched on the validator's own text (anossoftware src/fund/guardian-vote.js): the vote closed, this account already voted, no guardian vote, the proposer; the rest with the path. */
  private refusal(res: ApiResponse<unknown>): string {
    const reason = reasonOf(res);
    const g = this.t().guardians;
    if (CLOSED.test(reason)) return g.closedNow;
    if (/already voted/.test(reason)) return g.alreadyVoted;
    if (/no guardian vote/.test(reason)) return this.t().guardianNew.noVotes;
    if (/is the proposer/.test(reason)) return g.youProposed;
    return `/guardian-vote: ${reason}`;
  }
}
