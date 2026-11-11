import { Component, computed, inject } from '@angular/core';
import { MatBottomSheet, MatBottomSheetModule } from '@angular/material/bottom-sheet';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { millionthsToAnos } from '../amounts';
import { BalancesService } from '../services/balances.service';
import { LanguageService } from '../services/language.service';
import { SessionService } from '../services/session.service';
import { BALANCE_KINDS, BalanceKind, BalanceSheetComponent, BalanceSheetData, balanceLine } from './balance-sheet.component';

/** One row of the card: its kind, its label, its amount as "900 anos", and whether a tap opens its sheet (the amount is above zero). */
interface CardRow {
  kind: BalanceKind;
  label: string;
  amount: string;
  opens: boolean;
}

/**
 * The balance card (wallet spec 8.2, Home and Wallet): the pod's anos
 * added up over its accounts, from balances.service. Total, with a refresh
 * button, big: what the accounts hold plus what is staked. Under it the
 * rows that add up to it, the label on the left and the amount on the
 * right: Available, what is left after the anos spoken for; Staked; In
 * escrow; and Being sent (assisted transfers, a lock, pending transfers),
 * only when it is above zero. The first three always show. A row above
 * zero is a button with a small arrow and opens the sheet with its details
 * (balance-sheet.component, MatBottomSheet); a row at zero is plain. Then
 * the accounts not on the ledger yet or not read, as small lines. "No anos
 * account yet." without an account; "Reading…" until the first read
 * finished. The amounts never show a sign. No inputs: the card reads the
 * services itself.
 */
@Component({
  selector: 'app-balance-card',
  imports: [MatBottomSheetModule, MatButtonModule, MatIconModule],
  template: `
    <div class="card">
      <div class="top">
        <span class="label">{{ t().balanceCard.total }}</span>
        <button mat-icon-button type="button" (click)="balances.refresh()" [disabled]="balances.busy()" [attr.aria-label]="t().balanceCard.refreshBalances"><mat-icon>refresh</mat-icon></button>
      </div>
      @if (session.accounts().length === 0) {
        <p class="line">{{ t().balanceCard.noAccounts }}</p>
      } @else if (balances.readAt() === null) {
        <p class="total">{{ t().common.reading }}</p>
      } @else {
        <p class="total">{{ t().common.anos(total()) }}</p>
        <div class="rows">
          @for (row of rows(); track row.kind) {
            @if (row.opens) {
              <button type="button" class="row" (click)="open(row.kind)">
                <span class="name">{{ row.label }}</span>
                <span class="amount">{{ row.amount }}</span>
                <mat-icon class="arrow">chevron_right</mat-icon>
              </button>
            } @else {
              <div class="row">
                <span class="name">{{ row.label }}</span>
                <span class="amount">{{ row.amount }}</span>
                <span class="arrow"></span>
              </div>
            }
          }
        </div>
        @for (line of lines(); track line) {
          <p class="line">{{ line }}</p>
        }
      }
    </div>
  `,
  styles: `
    :host { display: block; }
    .card { border-radius: 16px; padding: 20px; background: var(--mat-sys-primary-container); color: var(--mat-sys-on-primary-container); }
    .top { display: flex; align-items: center; justify-content: space-between; }
    .top button { --mat-icon-button-icon-color: currentColor; --mdc-icon-button-icon-color: currentColor; margin: -8px -8px -8px 0; }
    .label { font-size: 14px; font-weight: 500; }
    .total { margin: 4px 0 0; font-size: 32px; font-weight: 500; line-height: 1.2; }
    .rows { margin: 8px -8px 0; }
    .row { display: flex; align-items: center; gap: 8px; box-sizing: border-box; width: 100%; padding: 8px; border: none; border-radius: 8px; background: none; color: inherit; font: inherit; font-size: 16px; line-height: 24px; text-align: left; }
    button.row { cursor: pointer; }
    button.row:hover { background: color-mix(in srgb, currentColor 8%, transparent); }
    .name { flex: 1; min-width: 0; }
    .amount { font-weight: 500; text-align: right; }
    .arrow { flex: none; width: 20px; height: 20px; font-size: 20px; }
    .line { margin: 6px 0 0; font-size: 13px; }
  `,
})
export class BalanceCardComponent {
  protected readonly balances = inject(BalancesService);
  protected readonly session = inject(SessionService);
  private readonly sheet = inject(MatBottomSheet);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  /** The big number: what the accounts hold on the ledger plus what they have staked with the fund. */
  protected readonly total = computed(() => {
    const totals = this.balances.totals();
    return millionthsToAnos(totals.total + totals.staked);
  });

  /** The rows under the total: Available, Staked and In escrow always, Being sent only when it is above zero. They add up to the total. */
  protected readonly rows = computed((): CardRow[] => {
    const totals = this.balances.totals();
    const words = this.t();
    const rows: CardRow[] = [];
    for (const kind of BALANCE_KINDS) {
      const line = balanceLine(kind, totals, words.balanceCard);
      if (kind === 'sending' && line.amount <= 0n) continue;
      rows.push({ kind, label: line.label, amount: words.common.anos(millionthsToAnos(line.amount)), opens: line.amount > 0n });
    }
    return rows;
  });

  /** The small lines under the rows, each only when its number is above zero: the accounts not on the ledger yet and the accounts that could not be read. */
  protected readonly lines = computed((): string[] => {
    const t = this.balances.totals();
    const words = this.t().balanceCard;
    const lines: string[] = [];
    if (t.notLanded > 0) lines.push(words.notLanded(t.notLanded));
    if (t.failed > 0) lines.push(words.notRead(t.failed));
    return lines;
  });

  /** A tap on a row above zero: the sheet with the row's details slides up from the bottom of the screen (balance-sheet.component). */
  protected open(kind: BalanceKind): void {
    this.sheet.open<BalanceSheetComponent, BalanceSheetData>(BalanceSheetComponent, { data: { kind }, autoFocus: 'dialog' });
  }
}
