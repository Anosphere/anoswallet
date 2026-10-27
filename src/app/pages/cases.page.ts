import { DatePipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { RouterLink } from '@angular/router';
import { millionthsToAnos } from '../amounts';
import { AnosApiService } from '../services/anos-api.service';
import { CryptoService } from '../services/crypto.service';
import { reasonOf } from '../services/log.service';
import { AttestorCaseStatus, MasterpodApiService } from '../services/masterpod-api.service';
import { SessionService } from '../services/session.service';
import { STATUS_ICONS, STATUS_WORDS } from './attesting.page';

/** One row: a trade or dispute case this pod is a party to, with what the account's transaction list knows of the transaction. */
interface CaseRow {
  kind: 'trade' | 'dispute';
  caseId: string;
  status: AttestorCaseStatus;
  createdAt: string;
  transactionId: string;
  /** This pod's account on the case: the sender's for a trade, the seller's or the buyer's for a dispute. */
  myAccountId: string;
  role: string;
  amount: string | null;
  otherAccountId: string | null;
}

/** What /list-transactions knows of a transaction: its amount and its two accounts. */
interface KnownTransaction {
  amount: string;
  accountId: string | null;
  accountIdTo: string | null;
}

/**
 * Cases (wallet spec 13.3, /cases, every edition): /list-my-cases, the
 * trades and the disputes where this pod is a party, newest first, each row
 * the kind, the amount and the other account when the account's transaction
 * list (/list-transactions, as the account page reads it) knows the
 * transaction, otherwise the transaction id, the status in words and when
 * it was opened. A row opens /cases/:caseId. A held trade or escrow is not
 * in that list until it lands, so the id shows while a case is open.
 */
@Component({
  selector: 'app-cases-page',
  imports: [DatePipe, RouterLink, MatCardModule, MatButtonModule, MatListModule, MatIconModule, MatProgressBarModule],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>Cases</mat-card-title>
        <mat-card-subtitle>Your side of a trade an attestor is checking, or of an escrow in dispute.</mat-card-subtitle>
      </mat-card-header>
      <mat-card-content>
        <div class="row">
          <button mat-stroked-button type="button" (click)="load()" [disabled]="busy()">Refresh</button>
        </div>
        @if (busy()) {
          <mat-progress-bar mode="indeterminate"></mat-progress-bar>
        }
        @if (error(); as text) {
          <p class="error">{{ text }}</p>
        }
        <mat-list>
          @for (c of rows(); track c.caseId) {
            <mat-list-item lines="3">
              <mat-icon matListItemIcon>{{ c.kind === 'trade' ? 'group' : 'balance' }}</mat-icon>
              <a matListItemTitle [routerLink]="['/cases', c.caseId]">
                {{ c.kind === 'trade' ? 'Assisted trade' : 'Escrow dispute' }}
                @if (c.amount !== null) { · {{ millionthsToAnos(c.amount) }} anos @if (c.otherAccountId) { · with <code>{{ c.otherAccountId.slice(0, 16) }}…</code> } } @else { · transaction <code>{{ c.transactionId.slice(0, 16) }}…</code> }
              </a>
              <span matListItemLine><mat-icon class="inline">{{ icons[c.status] }}</mat-icon> {{ words[c.status] }} · {{ c.role }} · opened {{ c.createdAt | date: 'medium' }}</span>
              <span matListItemLine><code>{{ c.caseId }}</code></span>
            </mat-list-item>
          } @empty {
            @if (!busy() && !error()) {
              <p class="muted">No case concerns you.</p>
            }
          }
        </mat-list>
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 8px 0; }
    .inline { font-size: 16px; width: 16px; height: 16px; vertical-align: text-bottom; }
    .muted { color: var(--mat-sys-on-surface-variant); }
    .error { color: var(--mat-sys-error); }
    code { font-size: 12px; word-break: break-all; }
  `,
})
export class CasesPage {
  private readonly session = inject(SessionService);
  private readonly masterpod = inject(MasterpodApiService);
  private readonly anos = inject(AnosApiService);
  private readonly crypto = inject(CryptoService);

  protected readonly millionthsToAnos = millionthsToAnos;
  protected readonly words = STATUS_WORDS;
  protected readonly icons = STATUS_ICONS;
  protected readonly rows = signal<CaseRow[]>([]);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    void this.load();
  }

  /** /list-my-cases, then what each of this pod's accounts on the cases knows of the transactions. */
  protected async load(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const res = await this.masterpod.listMyCases();
      if (!res.ok) {
        this.error.set(`/list-my-cases: ${reasonOf(res)}`);
        return;
      }
      const rows: CaseRow[] = [
        ...res.body.trades.map((t): CaseRow => ({ kind: 'trade', caseId: t.caseId, status: t.status, createdAt: t.createdAt, transactionId: t.transactionId, myAccountId: t.accountId, role: 'you sent the trade', amount: null, otherAccountId: null })),
        ...res.body.disputes.map((d): CaseRow => ({ kind: 'dispute', caseId: d.caseId, status: d.status, createdAt: d.createdAt, transactionId: d.transactionId, myAccountId: d.side === 'seller' ? d.accountId : d.accountIdTo, role: `you are the ${d.side}`, amount: null, otherAccountId: null })),
      ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const known = await this.knownTransactions([...new Set(rows.map((r) => r.myAccountId))]);
      for (const row of rows) {
        const t = known.get(row.transactionId);
        if (!t) continue;
        row.amount = t.amount;
        row.otherAccountId = t.accountId === row.myAccountId ? t.accountIdTo : t.accountId;
      }
      this.rows.set(rows);
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * The transactions the account page's list knows, for each of this pod's
   * accounts on the cases: /list-transactions signed by pair one (the
   * keyBlob opened for the signature and dropped), the chain links and the
   * pending row. An account not in the session, or no encryption key in
   * RAM, knows nothing; the id shows instead.
   */
  private async knownTransactions(accountIds: string[]): Promise<Map<string, KnownTransaction>> {
    const known = new Map<string, KnownTransaction>();
    const encryptionKey = this.session.getEncryptionKey();
    if (!encryptionKey || accountIds.length === 0) return known;
    if (this.session.accounts().length === 0) {
      const listed = await this.masterpod.listAnosAccounts(true);
      if (listed.ok) this.session.accounts.set(listed.body.accounts);
    }
    for (const accountId of accountIds) {
      const item = this.session.accounts().find((a) => a.accountId === accountId);
      if (!item) continue;
      try {
        const pairOne = await this.crypto.pairOneFromKeyBlob(this.crypto.fromHex(item.keyBlob), encryptionKey);
        const res = await this.anos.listTransactions(pairOne, accountId, {}, true);
        if (!res.ok) continue;
        for (const t of res.body.transactions) known.set(t.transactionId, { amount: t.amount, accountId: t.accountId, accountIdTo: t.accountIdTo });
        for (const p of res.body.pending) known.set(p.transactionId, { amount: p.amount, accountId: p.accountId, accountIdTo: p.accountIdTo });
      } catch {
        // A keyBlob that does not open: the id shows.
      }
    }
    return known;
  }
}
