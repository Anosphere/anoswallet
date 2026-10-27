import { DatePipe } from '@angular/common';
import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatTabsModule } from '@angular/material/tabs';
import { Router, RouterLink } from '@angular/router';
import { millionthsToAnos } from '../amounts';
import { CASES_POLL_MS } from '../constants';
import { AssistedTransferItem, DisputedEscrowItem } from '../services/anos-api.service';
import { AttestingService, attestingError } from '../services/attesting.service';
import { CryptoService } from '../services/crypto.service';
import { ApiResponse, reasonOf } from '../services/log.service';
import {
  AccountProfileItem,
  AttestorCaseStatus,
  AttestorCasesAnswer,
  AttestorDismissReason,
  CaseKeyWrap,
  DisputeCaseItem,
  MasterpodApiService,
  TradeCaseItem,
} from '../services/masterpod-api.service';
import { SessionService } from '../services/session.service';

/** The four statuses of a trade or dispute case (masterpod 13.5), the two review ones first; the filter starts with those two. */
export const CASE_STATUSES: AttestorCaseStatus[] = ['open', 'inReview', 'decided', 'dismissed'];
const DEFAULT_STATUSES: AttestorCaseStatus[] = ['open', 'inReview'];

/** The review statuses: a case in either is open for work. */
export const REVIEW_STATUSES: AttestorCaseStatus[] = ['open', 'inReview'];

/** A status in words, for the lists and the case pages. */
export const STATUS_WORDS: Record<AttestorCaseStatus, string> = {
  open: 'Open',
  inReview: 'In review',
  decided: 'Decided',
  dismissed: 'Dismissed',
};

/** The icon of a status, for the lists and the case pages. */
export const STATUS_ICONS: Record<AttestorCaseStatus, string> = {
  open: 'flag',
  inReview: 'videocam',
  decided: 'verified',
  dismissed: 'block',
};

/** A dismissal's preset reason in words, as the attestors read it (masterpod 13.4.4). */
export const DISMISS_WORDS: Record<AttestorDismissReason, string> = {
  selfieMismatch: 'the selfie did not match',
  documentsMismatch: 'the documents did not match',
  noShow: 'the person did not join the call',
  withdrawn: 'the request was withdrawn',
  settled: 'the parties settled',
  other: 'another reason',
};

/** The case state of a row: the best case among those matched by transaction id, or none; Open a case when there is none or only a dismissed one. */
interface CaseState<T extends { status: AttestorCaseStatus }> {
  item: T | null;
  canOpen: boolean;
}

/** A trade row: the validator's item, the sender as a person, and its case state. */
interface TradeRow {
  trade: AssistedTransferItem;
  sender: AccountProfileItem | null;
  state: CaseState<TradeCaseItem>;
}

/** A dispute row: the validator's item, both parties as people, who disputed, and its case state. */
interface DisputeRow {
  escrow: DisputedEscrowItem;
  seller: AccountProfileItem | null;
  buyer: AccountProfileItem | null;
  disputedBy: 'the seller' | 'the buyer' | 'an unknown account';
  state: CaseState<DisputeCaseItem>;
}

/** The best case for a row: a review one first, then a decided one, then a dismissed one, the newest of each. */
function stateOf<T extends { status: AttestorCaseStatus; createdAt: string }>(items: T[]): CaseState<T> {
  const newest = [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const item = newest.find((c) => REVIEW_STATUSES.includes(c.status)) ?? newest.find((c) => c.status === 'decided') ?? newest[0] ?? null;
  return { item, canOpen: item === null || item.status === 'dismissed' };
}

/** Whether the filter shows a row: one with no case counts as waiting work (a review status); one with a case goes by the case's status. */
function shown(state: CaseState<{ status: AttestorCaseStatus }>, statuses: AttestorCaseStatus[]): boolean {
  return state.item === null ? statuses.some((s) => REVIEW_STATUSES.includes(s)) : statuses.includes(state.item.status);
}

function groupByTransaction<T extends { transactionId: string }>(items: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(item.transactionId, [...(groups.get(item.transactionId) ?? []), item]);
  return groups;
}

/**
 * Attesting (wallet spec 13.3, /attesting, the attestor edition). The page
 * asks for the staked account once per session (the moderation case page's
 * picker, copied; AttestingService keeps the choice). The Trades tab lists
 * /list-assisted-transfers from the default validator, the Disputes tab
 * /list-disputed-escrows, each row the people behind the account ids from
 * /list-anos-account-profiles, the amount, when, what is already on the
 * validators, and the case state from /list-attestor-cases matched by
 * transaction id: No case yet with Open a case, or the status in words
 * linking to the case page. Open a case on a trade runs /open-trade-case; on
 * a dispute it makes the case pair, wraps its secret to every attestor's
 * chat key and runs /open-dispute-case, keeping the pair in RAM. A status
 * filter above both tabs, Refresh, and a quiet 15 s poll.
 */
@Component({
  selector: 'app-attesting-page',
  imports: [DatePipe, RouterLink, MatCardModule, MatButtonModule, MatIconModule, MatFormFieldModule, MatSelectModule, MatProgressBarModule, MatTabsModule],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>Attesting</mat-card-title>
        <mat-card-subtitle>The trades and the disputes waiting for attestors on the validators. Open a case to start on one.</mat-card-subtitle>
      </mat-card-header>
      <mat-card-content>
        <h3>Your account</h3>
        <p class="muted">The spending account that holds your attestor stake signs the validator reads, the key requests and the sign-offs for this session.</p>
        <div class="form">
          <mat-form-field appearance="outline" class="wide">
            <mat-label>Anos account</mat-label>
            <mat-select [value]="attesting.accountId()" (valueChange)="pickAccount($event)">
              @for (account of session.accounts(); track account.accountId) {
                <mat-option [value]="account.accountId">{{ account.accountType }} · {{ account.accountId }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          @if (session.accounts().length === 0) {
            <span class="muted">No anos account: create one on the Wallet page and stake it for attestor.</span>
          }
        </div>

        <div class="row">
          <mat-form-field appearance="outline" class="filter">
            <mat-label>Case status</mat-label>
            <mat-select multiple [value]="statuses()" (valueChange)="statuses.set($event)">
              @for (status of allStatuses; track status) {
                <mat-option [value]="status">{{ words[status] }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <button mat-stroked-button type="button" (click)="load()" [disabled]="busy()">Refresh</button>
          @if (attesting.listedAt(); as at) {
            <span class="muted">Lists from the validator at {{ at | date: 'mediumTime' }}; refreshed every 15 seconds.</span>
          }
        </div>
        @if (busy()) {
          <mat-progress-bar mode="indeterminate"></mat-progress-bar>
        }
        @if (error(); as text) {
          <p class="error">{{ text }}</p>
        }

        <mat-tab-group>
          <mat-tab label="Trades ({{ tradeRows().length }})">
            @for (row of tradeRows(); track row.trade.transactionId) {
              <div class="item">
                @if (selfieOf(row.sender); as url) {
                  <img class="avatar" [src]="url" alt="public selfie" />
                } @else {
                  <mat-icon class="avatar-icon">person_off</mat-icon>
                }
                <div class="facts">
                  <div class="title">{{ personText(row.sender, row.trade.accountId) }} · {{ millionthsToAnos(row.trade.amount) }} anos</div>
                  <div class="muted">
                    Trade made {{ row.trade.createdAt | date: 'medium' }} · to <code>{{ row.trade.accountIdTo }}</code>
                  </div>
                  <div class="muted">{{ attestationsText(row.trade) }} · <code>{{ row.trade.transactionId }}</code></div>
                  <div>
                    @if (row.state.item; as c) {
                      <mat-icon class="inline">{{ icons[c.status] }}</mat-icon>
                      <a [routerLink]="['/attesting/trade', c.caseId]">{{ words[c.status] }}</a>
                      · {{ c.signOffs }} of 2 sign-offs · opened by {{ c.openedBy ?? 'an attestor' }}
                      @if (c.status === 'dismissed') { · a new case may be opened }
                    } @else {
                      No case yet
                    }
                  </div>
                </div>
                @if (row.state.canOpen) {
                  <button mat-flat-button type="button" (click)="openTrade(row)" [disabled]="busy() || opening() !== null || !attesting.accountId()">Open a case</button>
                }
              </div>
            } @empty {
              @if (!busy() && !error()) {
                <p class="muted">No trades waiting with these statuses.</p>
              }
            }
          </mat-tab>

          <mat-tab label="Disputes ({{ disputeRows().length }})">
            @for (row of disputeRows(); track row.escrow.transactionId) {
              <div class="item">
                <div class="pair">
                  @if (selfieOf(row.seller); as url) { <img class="avatar" [src]="url" alt="the seller" /> } @else { <mat-icon class="avatar-icon">person_off</mat-icon> }
                  @if (selfieOf(row.buyer); as url) { <img class="avatar" [src]="url" alt="the buyer" /> } @else { <mat-icon class="avatar-icon">person_off</mat-icon> }
                </div>
                <div class="facts">
                  <div class="title">{{ millionthsToAnos(row.escrow.amount) }} anos in escrow · disputed by {{ row.disputedBy }}</div>
                  <div><span class="label">Seller</span> {{ personText(row.seller, row.escrow.accountId) }}</div>
                  <div><span class="label">Buyer</span> {{ personText(row.buyer, row.escrow.accountIdTo) }}</div>
                  <div class="muted">Escrow made {{ row.escrow.createdAt | date: 'medium' }} · {{ verdictsText(row.escrow) }} · <code>{{ row.escrow.transactionId }}</code></div>
                  <div>
                    @if (row.state.item; as c) {
                      <mat-icon class="inline">{{ icons[c.status] }}</mat-icon>
                      <a [routerLink]="['/attesting/dispute', c.caseId]">{{ words[c.status] }}</a>
                      · {{ c.signOffs }} of 2 sign-offs · {{ c.evidenceCount }} evidence file{{ c.evidenceCount === 1 ? '' : 's' }} · opened by {{ c.openedBy ?? 'an attestor' }}
                      @if (c.status === 'dismissed') { · a new case may be opened }
                    } @else {
                      No case yet
                    }
                  </div>
                </div>
                @if (row.state.canOpen) {
                  <button mat-flat-button type="button" (click)="openDispute(row)" [disabled]="busy() || opening() !== null || !attesting.accountId()">Open a case</button>
                }
              </div>
            } @empty {
              @if (!busy() && !error()) {
                <p class="muted">No disputed escrows with these statuses.</p>
              }
            }
          </mat-tab>
        </mat-tab-group>
        @if (opening(); as id) {
          <p class="muted">Opening a case on <code>{{ id }}</code>…</p>
        }
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 8px 0; }
    .form { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 4px; }
    .wide { min-width: 360px; flex: 1; }
    .filter { min-width: 320px; }
    .item { display: flex; gap: 16px; align-items: flex-start; padding: 12px 0; border-bottom: 1px solid var(--mat-sys-outline-variant); }
    .avatar { width: 56px; height: 56px; object-fit: cover; border-radius: 50%; flex-shrink: 0; }
    .avatar-icon { width: 56px; height: 56px; font-size: 56px; color: var(--mat-sys-on-surface-variant); flex-shrink: 0; }
    .pair { display: flex; gap: 4px; flex-shrink: 0; }
    .facts { flex: 1; min-width: 0; display: grid; gap: 2px; }
    .title { font-weight: 500; }
    .label { color: var(--mat-sys-on-surface-variant); margin-right: 6px; }
    .inline { font-size: 18px; width: 18px; height: 18px; vertical-align: text-bottom; }
    .muted { color: var(--mat-sys-on-surface-variant); }
    .error { color: var(--mat-sys-error); }
    code { font-size: 12px; word-break: break-all; }
  `,
})
export class AttestingPage {
  protected readonly session = inject(SessionService);
  protected readonly attesting = inject(AttestingService);
  private readonly masterpod = inject(MasterpodApiService);
  private readonly crypto = inject(CryptoService);
  private readonly router = inject(Router);

  protected readonly millionthsToAnos = millionthsToAnos;
  protected readonly allStatuses = CASE_STATUSES;
  protected readonly words = STATUS_WORDS;
  protected readonly icons = STATUS_ICONS;

  protected readonly statuses = signal<AttestorCaseStatus[]>(DEFAULT_STATUSES);
  /** The cases of every status from the masterpod; the filter is applied on the page, so a decided case is never taken for No case yet. */
  protected readonly cases = signal<AttestorCasesAnswer | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  /** The transaction id a case is being opened on, while it is. */
  protected readonly opening = signal<string | null>(null);

  protected readonly tradeRows = computed<TradeRow[]>(() => {
    const byTransaction = groupByTransaction(this.cases()?.trades ?? []);
    const statuses = this.statuses();
    return this.attesting
      .trades()
      .map((trade) => ({ trade, sender: this.attesting.profileOf(trade.accountId), state: stateOf(byTransaction.get(trade.transactionId) ?? []) }))
      .filter((row) => shown(row.state, statuses));
  });

  protected readonly disputeRows = computed<DisputeRow[]>(() => {
    const byTransaction = groupByTransaction(this.cases()?.disputes ?? []);
    const statuses = this.statuses();
    return this.attesting
      .disputes()
      .map((escrow) => ({
        escrow,
        seller: this.attesting.profileOf(escrow.accountId),
        buyer: this.attesting.profileOf(escrow.accountIdTo),
        disputedBy: (escrow.disputedBy === escrow.accountId ? 'the seller' : escrow.disputedBy === escrow.accountIdTo ? 'the buyer' : 'an unknown account') as DisputeRow['disputedBy'],
        state: stateOf(byTransaction.get(escrow.transactionId) ?? []),
      }))
      .filter((row) => shown(row.state, statuses));
  });

  constructor() {
    void this.load();
    const timer = setInterval(() => {
      if (!this.busy() && this.opening() === null && this.attesting.accountId() !== '') void this.load(true);
    }, CASES_POLL_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  /** Another staked account: the lists are read again with it. */
  protected pickAccount(accountId: string): void {
    this.attesting.accountId.set(accountId);
    void this.load();
  }

  /** The accounts (once), both validator lists with the people behind them, and the cases of every status. */
  protected async load(quiet = false): Promise<void> {
    this.busy.set(true);
    if (!quiet) this.error.set(null);
    try {
      await this.attesting.loadAccounts();
      if (this.attesting.accountId() === '') {
        this.error.set('No anos account: create one on the Wallet page and stake it for attestor.');
        return;
      }
      const [, cases] = await Promise.all([this.attesting.loadLists(quiet), this.masterpod.listAttestorCases(CASE_STATUSES, quiet)]);
      if (!cases.ok) throw new Error(attestingError(cases, '/list-attestor-cases'));
      this.cases.set(cases.body);
      this.error.set(null);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }

  // --- the people -----------------------------------------------------------------

  protected personText(item: AccountProfileItem | null, accountId: string): string {
    if (!item?.profile) return `${accountId.slice(0, 16)}… · not on this masterpod`;
    return `${item.profile.username} · ${item.profile.firstName} ${item.profile.lastName}`;
  }

  protected selfieOf(item: AccountProfileItem | null): string | null {
    const selfie = item?.profile?.selfie;
    return selfie ? `data:${selfie.contentType};base64,${selfie.image}` : null;
  }

  /** What the validators already hold for a trade: the attestations in the slots. */
  protected attestationsText(trade: AssistedTransferItem): string {
    const n = trade.attestorIds.length;
    return n === 0 ? 'No attestation on the validators yet' : `${n} attestation${n === 1 ? '' : 's'} on the validators`;
  }

  /** What the validators already hold for an escrow: the verdicts, with their value and whether every validator approved them. */
  protected verdictsText(escrow: DisputedEscrowItem): string {
    if (escrow.verdicts.length === 0) return 'No verdict on the validators yet';
    const parts = escrow.verdicts.map((v) => `${v.verdict} by ${v.arbitratorId.slice(0, 8)}…${v.approved ? '' : ' (not yet approved)'}`);
    return `${escrow.verdicts.length} verdict${escrow.verdicts.length === 1 ? '' : 's'} on the validators: ${parts.join(', ')}`;
  }

  // --- opening a case -----------------------------------------------------------------

  /** /open-trade-case: the request to the sender for their lookup id; then the case page. */
  protected async openTrade(row: TradeRow): Promise<void> {
    this.opening.set(row.trade.transactionId);
    this.error.set(null);
    try {
      const res = await this.masterpod.openTradeCase(row.trade.transactionId, row.trade.accountId);
      if (!res.ok) throw new Error(this.openRefusal(res, '/open-trade-case'));
      await this.router.navigate(['/attesting/trade', res.body.caseId]);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
      await this.load(true);
    } finally {
      this.opening.set(null);
    }
  }

  /**
   * A dispute case (wallet spec 13.3): the case pair, /list-attestors, the
   * 96 secret bytes wrapped to every attestor's chat key (the opener
   * included), /open-dispute-case with the public halves and the wraps; the
   * pair stays in RAM for the case page.
   */
  protected async openDispute(row: DisputeRow): Promise<void> {
    this.opening.set(row.escrow.transactionId);
    this.error.set(null);
    const keys = this.crypto.generateHybridKeys();
    const secret = new Uint8Array(96);
    secret.set(keys.x25519Secret, 0);
    secret.set(keys.kemSeed, 32);
    try {
      const attestors = await this.masterpod.listAttestors();
      if (!attestors.ok) throw new Error(attestingError(attestors, '/list-attestors'));
      const wraps: CaseKeyWrap[] = [];
      for (const attestor of attestors.body.attestors) {
        if (!attestor.chatPublicKey || !attestor.chatPublicKeyPq) continue;
        wraps.push({ anopodId: attestor.anopodId, wrappedKey: this.crypto.toHex(await this.crypto.wrapCaseSecret(secret, attestor.chatPublicKey, attestor.chatPublicKeyPq)) });
      }
      if (wraps.length === 0) throw new Error('No attestor pod has chat keys to wrap the case key to.');
      const res = await this.masterpod.openDisputeCase({
        transactionId: row.escrow.transactionId,
        accountId: row.escrow.accountId,
        accountIdTo: row.escrow.accountIdTo,
        disputedBy: row.escrow.disputedBy,
        caseKey: this.crypto.hybridPublicKeyOf(keys),
        keys: wraps,
      });
      if (!res.ok) throw new Error(this.openRefusal(res, '/open-dispute-case'));
      this.attesting.setCasePair(res.body.caseId, keys);
      await this.router.navigate(['/attesting/dispute', res.body.caseId]);
    } catch (err) {
      keys.x25519Secret.fill(0);
      keys.kemSeed.fill(0);
      keys.kemSecret.fill(0);
      this.error.set(err instanceof Error ? err.message : String(err));
      await this.load(true);
    } finally {
      secret.fill(0);
      this.opening.set(null);
    }
  }

  /** An open's refusal in words (masterpod 13.4.4). */
  private openRefusal(res: ApiResponse<unknown>, path: string): string {
    const reason = reasonOf(res);
    if (res.status === 409 && /case already open/.test(reason)) return 'A case is already open on this transaction; the list is refreshed.';
    if (res.status === 409 && /not an assisted account/.test(reason)) return 'The masterpod does not hold this account as an assisted account.';
    if (res.status === 404 && /unknown (seller |buyer )?account/.test(reason)) return 'The masterpod knows no anoPod behind one of these accounts.';
    if (res.status === 400) return `${path}: the masterpod refused the values (${reason}).`;
    return attestingError(res, path);
  }
}
