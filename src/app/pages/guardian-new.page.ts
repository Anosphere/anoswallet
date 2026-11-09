import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { Router, RouterLink } from '@angular/router';
import { anosToMillionths, millionthsToAnos } from '../amounts';
import { AnosApiService, FundSettings } from '../services/anos-api.service';
import { CryptoService, Payout, STAKE_PURPOSES, StakePurpose } from '../services/crypto.service';
import { GuardianAccount, GuardianAccountsService } from '../services/guardian-accounts.service';
import { LanguageService } from '../services/language.service';
import { ApiResponse, reasonOf } from '../services/log.service';
import { SigningService } from '../services/signing.service';
import { shortId } from '../short-id';

/** One row of the payout form: the amount in anos, the purpose empty for a plain payout, the paste button's note under the recipient. */
interface PayoutRow {
  accountIdTo: string;
  amount: string;
  reason: string;
  stakeFor: StakePurpose | '';
  note: string | null;
}

/** Exactly 64 hex characters with no hex character on either side: an account id in whatever was copied (the account page's paste). */
const ACCOUNT_ID_IN_TEXT = /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/i;

const emptyRow = (): PayoutRow => ({ accountIdTo: '', amount: '', reason: '', stakeFor: '', note: null });

/**
 * New fund proposal (wallet spec 8.2, Guardians; the plan is
 * forclaude/wallet-guardians-plan-1.md, 3.6), at /dao/guardians/new, in the
 * frame of the DAO's New proposal page: a back arrow to /dao/guardians;
 * "Proposing as", a select of the caller's guardian accounts
 * (guardian-accounts.service), each option the short id and its votes, the
 * biggest first and selected (a proposal is one transaction signed by one
 * account); the payout rows, the form that left the account page: the
 * recipient (64 hex characters, with the paste button Send has), the
 * amount in anos, the reason, Returns stake (no, or one of the six
 * purposes) and a remove button, disabled on the last row; Add payout; the
 * rule with the numbers from the validator's settings, read quietly with
 * /list-fund-proposals { status: 'open' } when the page opens, which also
 * tells whether a proposal is open; Post proposal, disabled while busy,
 * without a guardian account, or while a proposal is open (the reason
 * shown). Post checks each row, opens pair one of the chosen account,
 * builds the fundProposal (crypto.buildFundProposal), has /api/sign add the
 * wallet pair and posts /fund-proposal; a 202 opens the proposal's page.
 * The refusals in words: a proposal already open, no guardian vote (the
 * proposer's weight check too); the rest "/fund-proposal: <reason>".
 */
@Component({
  selector: 'app-guardian-new-page',
  imports: [FormsModule, RouterLink, MatButtonModule, MatIconModule, MatFormFieldModule, MatInputModule, MatSelectModule],
  template: `
    <header class="head">
      <a mat-icon-button routerLink="/dao/guardians" [attr.aria-label]="t().common.back"><mat-icon>arrow_back</mat-icon></a>
      <h2>{{ t().guardianNew.title }}</h2>
    </header>

    @if (readingAccounts()) {
      <p class="muted">{{ t().common.reading }}</p>
    } @else if (accounts().length === 0) {
      @if (settings(); as s) {
        <p class="muted">{{ t().guardians.noGuardianAccount(anosOf(s.minimumStake)) }}</p>
      }
    } @else {
      <mat-form-field appearance="outline" class="wide">
        <mat-label>{{ t().guardianNew.proposingAs }}</mat-label>
        <mat-select [value]="proposer()" (valueChange)="proposer.set($event)">
          @for (a of accounts(); track a.accountId) {
            <mat-option [value]="a.accountId">{{ shortId(a.accountId) }} · {{ t().guardians.accountVotes(a.votes) }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
    }

    @for (row of payouts(); track $index) {
      <div class="payout">
        <mat-form-field appearance="outline" class="wide" subscriptSizing="dynamic">
          <mat-label>{{ t().guardianNew.recipient }}</mat-label>
          <input matInput [ngModel]="row.accountIdTo" (ngModelChange)="update($index, 'accountIdTo', $event)" [placeholder]="t().account.recipientPlaceholder" />
          <button mat-icon-button matSuffix type="button" (click)="paste($index)" [attr.aria-label]="t().account.pasteRecipient"><mat-icon>content_paste</mat-icon></button>
          @if (row.note; as note) {
            <mat-hint>{{ note }}</mat-hint>
          }
        </mat-form-field>
        <div class="line">
          <mat-form-field appearance="outline" class="amount">
            <mat-label>{{ t().guardianNew.amountAnos }}</mat-label>
            <input matInput [ngModel]="row.amount" (ngModelChange)="update($index, 'amount', $event)" [placeholder]="t().account.amountPlaceholder" />
          </mat-form-field>
          <mat-form-field appearance="outline" class="grow">
            <mat-label>{{ t().guardianNew.reason }}</mat-label>
            <input matInput [ngModel]="row.reason" (ngModelChange)="update($index, 'reason', $event)" />
          </mat-form-field>
        </div>
        <div class="line">
          <mat-form-field appearance="outline" class="grow">
            <mat-label>{{ t().guardianNew.returnsStake }}</mat-label>
            <mat-select [value]="row.stakeFor" (valueChange)="update($index, 'stakeFor', $event)">
              <mat-option value="">{{ t().guardianNew.no }}</mat-option>
              @for (purpose of stakePurposes; track purpose) {
                <mat-option [value]="purpose">{{ t().account.stakePurposes[purpose] }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <button mat-icon-button type="button" (click)="remove($index)" [disabled]="payouts().length === 1" [attr.aria-label]="t().common.remove"><mat-icon>close</mat-icon></button>
        </div>
      </div>
    }
    <p><button mat-button type="button" (click)="add()"><mat-icon>add</mat-icon> {{ t().guardianNew.addPayout }}</button></p>

    @if (settings(); as s) {
      <p class="muted">{{ t().guardianNew.rule(s.percent, t().minutes(s.minutes)) }}</p>
    }
    @if (openAlready()) {
      <p class="muted">{{ t().guardianNew.alreadyOpen }}</p>
    }
    @if (error(); as text) {
      <p class="error">{{ text }}</p>
    }
    <button mat-flat-button type="button" class="big" (click)="post()" [disabled]="busy() || !proposer() || openAlready()">{{ t().guardianNew.post }}</button>
  `,
  styles: `
    :host { display: block; max-width: 560px; margin: 0 auto; }
    .head { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; }
    h2 { font-size: 1.25rem; font-weight: 500; margin: 0; }
    .wide { width: 100%; }
    .payout { display: flex; flex-direction: column; gap: 4px; padding: 12px 16px 0; margin: 0 0 12px; border: 1px solid var(--mat-sys-outline-variant); border-radius: 12px; }
    .line { display: flex; align-items: center; gap: 8px; }
    .amount { width: 160px; flex: none; }
    .grow { flex: 1; min-width: 0; }
    .big { width: 100%; height: 48px; font-size: 1rem; margin-top: 8px; }
    .muted { color: var(--mat-sys-on-surface-variant); }
    .error { color: var(--mat-sys-error); }
  `,
})
export class GuardianNewPage {
  private readonly api = inject(AnosApiService);
  private readonly guardians = inject(GuardianAccountsService);
  private readonly crypto = inject(CryptoService);
  private readonly signing = inject(SigningService);
  private readonly router = inject(Router);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  protected readonly shortId = shortId;
  protected readonly anosOf = millionthsToAnos;
  /** The six purposes for Returns stake: a guardian returns any account's stake, a revoked pod's among them. */
  protected readonly stakePurposes = STAKE_PURPOSES;
  /** The pod's accounts with guardian votes, the biggest first (guardian-accounts.service). */
  protected readonly accounts = signal<GuardianAccount[]>([]);
  protected readonly readingAccounts = signal(true);
  /** The account that proposes: the biggest guardian account once the list came, the person's pick after; null without one, and Post waits. */
  protected readonly proposer = signal<string | null>(null);
  protected readonly payouts = signal<PayoutRow[]>([emptyRow()]);
  /** The validator's dials for the rule, read quietly when the page opens; null until they came, and the rule waits. */
  protected readonly settings = signal<FundSettings | null>(null);
  /** True when the quiet open read listed a proposal: Post waits, with the reason shown. */
  protected readonly openAlready = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    void this.api.listFundProposals({ status: 'open' }, true).then((res) => {
      if (res.ok) {
        this.settings.set(res.body.settings);
        this.openAlready.set(res.body.proposals.length > 0);
      } else {
        this.error.set(`/list-fund-proposals: ${reasonOf(res)}`);
      }
    });
    void this.readAccounts();
  }

  protected add(): void {
    this.payouts.update((rows) => [...rows, emptyRow()]);
  }

  protected remove(index: number): void {
    this.payouts.update((rows) => rows.filter((_, i) => i !== index));
  }

  protected update(index: number, field: 'accountIdTo' | 'amount' | 'reason' | 'stakeFor', value: string): void {
    this.payouts.update((rows) => rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
  }

  /** The recipient of one row from the clipboard: the run of exactly 64 hex characters in it, lower-cased; a note under the box otherwise. Safari asks with its Paste bubble first. */
  protected async paste(index: number): Promise<void> {
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      this.setNote(index, this.t().account.clipboardRefused);
      return;
    }
    const found = ACCOUNT_ID_IN_TEXT.exec(text);
    if (!found) {
      this.setNote(index, this.t().account.clipboardNoId);
      return;
    }
    this.payouts.update((rows) => rows.map((row, i) => (i === index ? { ...row, accountIdTo: found[0].toLowerCase(), note: null } : row)));
  }

  /** Post: the rows checked, pair one of the chosen account opened for the signature and dropped, /api/sign, /fund-proposal; a 202 opens the proposal's page, a refusal shows in words. */
  protected async post(): Promise<void> {
    const proposer = this.proposer();
    if (this.busy() || !proposer || this.openAlready()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const payouts = this.checkedPayouts();
      const pairOne = await this.guardians.pairOne(proposer);
      const tx = await this.signing.sign(this.crypto.buildFundProposal(pairOne, proposer, payouts));
      const res = await this.api.fundProposal(tx);
      if (!res.ok) throw new Error(this.refusal(res));
      await this.router.navigate(['/dao/guardians', res.body.transactionId]);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }

  private setNote(index: number, note: string): void {
    this.payouts.update((rows) => rows.map((row, i) => (i === index ? { ...row, note } : row)));
  }

  /** The pod's guardian accounts, quietly; the biggest is selected when none is picked yet. */
  private async readAccounts(): Promise<void> {
    try {
      const accounts = await this.guardians.read();
      this.accounts.set(accounts);
      if (!accounts.some((a) => a.accountId === this.proposer())) this.proposer.set(accounts[0]?.accountId ?? null);
    } finally {
      this.readingAccounts.set(false);
    }
  }

  /** The rows as payouts: each recipient 64 hex characters, lower-cased; each amount anos with up to six decimals, as millionths; the reason trimmed; the purpose when one is picked. The first bad row throws its sentence, numbered from 1. */
  private checkedPayouts(): Payout[] {
    return this.payouts().map((row, i) => {
      const accountIdTo = row.accountIdTo.trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(accountIdTo)) throw new Error(this.t().guardianNew.payoutRecipient(i + 1));
      const amount = anosToMillionths(row.amount);
      if (amount === null) throw new Error(this.t().guardianNew.payoutAmount(i + 1));
      const payout: Payout = { accountIdTo, amount: amount.toString(), reason: row.reason.trim() };
      if (row.stakeFor !== '') payout.stakeFor = row.stakeFor;
      return payout;
    });
  }

  /** The refusal in words (anossoftware 4.4): a fund proposal already open; no guardian vote, the proposer's weight check included; the rest with the path. */
  private refusal(res: ApiResponse<unknown>): string {
    const reason = reasonOf(res);
    if (/already open/.test(reason)) return this.t().guardianNew.alreadyOpen;
    if (/no guardian vote/.test(reason)) return this.t().guardianNew.noVotes;
    return `/fund-proposal: ${reason}`;
  }
}
