import { DatePipe } from '@angular/common';
import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { RouterLink } from '@angular/router';
import { millionthsToAnos } from '../amounts';
import { AnosApiService, TransactionItem } from '../services/anos-api.service';
import { CryptoService, PairOne } from '../services/crypto.service';
import { reasonOf } from '../services/log.service';
import { MasterpodApiService } from '../services/masterpod-api.service';
import { SessionService } from '../services/session.service';

/**
 * Transaction history (wallet spec 8.2), at /wallet/:accountId/history,
 * opened by the button on the account page (2026-11-05, section 11): the
 * list from /list-transactions, newest first, Load more with beforePosition
 * while a page came back full, the rows as the account page showed them
 * before. Read when opened and by Refresh; no poll. The reads are signed by
 * pair one, opened from the keyBlob and dropped.
 */
@Component({
  selector: 'app-transaction-history-page',
  imports: [DatePipe, RouterLink, MatCardModule, MatButtonModule, MatListModule, MatIconModule, MatProgressBarModule],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>Transaction history</mat-card-title>
        <mat-card-subtitle><code>{{ accountId() }}</code></mat-card-subtitle>
      </mat-card-header>
      <mat-card-content>
        <p><a mat-button [routerLink]="['/wallet', accountId()]"><mat-icon>arrow_back</mat-icon> Account</a></p>
        <div class="row">
          <button mat-stroked-button type="button" (click)="refresh()" [disabled]="busy()">Refresh</button>
        </div>
        @if (readError(); as text) {
          <p class="error">{{ text }}</p>
        }
        @if (busy()) {
          <mat-progress-bar mode="indeterminate"></mat-progress-bar>
        }
        <mat-list>
          @for (t of transactions(); track t.transactionId) {
            <mat-list-item lines="3">
              <mat-icon matListItemIcon>{{ t.type === 'accountCreation' ? 'add_circle' : t.accountId === accountId() ? 'call_made' : 'call_received' }}</mat-icon>
              <span matListItemTitle>{{ t.type }} · {{ t.type === 'accountCreation' ? '' : (t.accountId === accountId() ? '−' : '+') + millionthsToAnos(t.amount) + ' anos' }} · #{{ t.position }}</span>
              <span matListItemLine>{{ t.createdAt | date: 'medium' }}@if (counterpart(t); as other) { · {{ t.accountId === accountId() ? 'to' : 'from' }} <code>{{ other }}</code> }</span>
              <span matListItemLine><code>{{ t.transactionId }}</code></span>
            </mat-list-item>
          } @empty {
            @if (!busy() && !readError()) {
              <p class="muted">Nothing on the ledger for this account yet.</p>
            }
          }
        </mat-list>
        @if (canLoadMore()) {
          <button mat-button type="button" (click)="loadMore()" [disabled]="busy()">Load more</button>
        }
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 8px 0; }
    .muted { color: var(--mat-sys-on-surface-variant); }
    .error { color: var(--mat-sys-error); }
    code { font-size: 12px; word-break: break-all; }
  `,
})
export class TransactionHistoryPage {
  readonly accountId = input.required<string>();

  private readonly session = inject(SessionService);
  private readonly masterpod = inject(MasterpodApiService);
  private readonly anos = inject(AnosApiService);
  private readonly crypto = inject(CryptoService);

  protected readonly millionthsToAnos = millionthsToAnos;
  protected readonly transactions = signal<TransactionItem[]>([]);
  protected readonly canLoadMore = signal(false);
  protected readonly readError = signal<string | null>(null);
  protected readonly busy = signal(false);

  constructor() {
    effect(() => {
      this.accountId();
      untracked(() => void this.refresh());
    });
  }

  protected counterpart(t: TransactionItem): string | null {
    return t.accountId === this.accountId() ? t.accountIdTo : t.accountId;
  }

  /** Pair one, opened from the keyBlob for one signature; the caller drops it. */
  private async pairOne(): Promise<PairOne> {
    let item = this.session.accounts().find((a) => a.accountId === this.accountId());
    if (!item) {
      const res = await this.masterpod.listAnosAccounts(true);
      if (res.ok) this.session.accounts.set(res.body.accounts);
      item = this.session.accounts().find((a) => a.accountId === this.accountId());
    }
    const encryptionKey = this.session.getEncryptionKey();
    if (!item) throw new Error('This account is not one of this anoPod\'s accounts');
    if (!encryptionKey) throw new Error('The encryption key is not in RAM: unlock again');
    return this.crypto.pairOneFromKeyBlob(this.crypto.fromHex(item.keyBlob), encryptionKey);
  }

  /** The first page of /list-transactions, newest first. */
  protected async refresh(): Promise<void> {
    this.readError.set(null);
    this.busy.set(true);
    try {
      const pairOne = await this.pairOne();
      const res = await this.anos.listTransactions(pairOne, this.accountId(), {});
      if (!res.ok) {
        this.readError.set(`/list-transactions: ${reasonOf(res)}`);
        return;
      }
      this.transactions.set(res.body.transactions);
      this.canLoadMore.set(res.body.transactions.length >= 50);
    } catch (err) {
      this.readError.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }

  /** The next page, before the last row's position. */
  protected async loadMore(): Promise<void> {
    const last = this.transactions().at(-1);
    if (!last) return;
    this.busy.set(true);
    try {
      const pairOne = await this.pairOne();
      const res = await this.anos.listTransactions(pairOne, this.accountId(), { beforePosition: last.position });
      if (res.ok) {
        this.transactions.update((list) => [...list, ...res.body.transactions]);
        this.canLoadMore.set(res.body.transactions.length >= 50);
      }
    } finally {
      this.busy.set(false);
    }
  }
}
