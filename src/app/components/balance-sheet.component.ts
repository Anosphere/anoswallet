import { Component, computed, inject } from '@angular/core';
import { MAT_BOTTOM_SHEET_DATA, MatBottomSheetRef } from '@angular/material/bottom-sheet';
import { RouterLink } from '@angular/router';
import { accountNames } from '../account-names';
import { millionthsToAnos } from '../amounts';
import { escrowStageWords } from '../escrow-stage';
import type { Words } from '../i18n/en';
import { BalancesService, Totals } from '../services/balances.service';
import { STAKE_PURPOSES } from '../services/crypto.service';
import { LanguageService } from '../services/language.service';
import { SessionService } from '../services/session.service';
import { shortId } from '../short-id';

/** The rows of the balance card, in the card's order: what is available, staked, in escrow and being sent. Each is also a kind of sheet. */
export const BALANCE_KINDS = ['available', 'staked', 'escrow', 'sending'] as const;

export type BalanceKind = (typeof BALANCE_KINDS)[number];

/** What opens the sheet: the kind of the card's row that was tapped. */
export interface BalanceSheetData {
  kind: BalanceKind;
}

/**
 * A kind's label and its amount in millionths over the pod's accounts: the
 * card's row and the sheet's title, from one place so they cannot drift
 * apart. Being sent is the assisted transfers waiting for attestors, the
 * guarded and vault transfers waiting out their lock and the transfers sent
 * and not yet written, together.
 */
export function balanceLine(kind: BalanceKind, totals: Totals, words: Words['balanceCard']): { label: string; amount: bigint } {
  switch (kind) {
    case 'available':
      return { label: words.available, amount: totals.available };
    case 'staked':
      return { label: words.staked, amount: totals.staked };
    case 'escrow':
      return { label: words.inEscrow, amount: totals.escrow };
    case 'sending':
      return { label: words.sending, amount: totals.assisted + totals.locked + totals.pending };
  }
}

/** One row of the sheet. */
interface SheetRow {
  /** Unlike every other row of the sheet, for the list. */
  id: string;
  /** The account's name (account-names.ts). */
  name: string;
  /** The line under the name: the stake's purpose, the trade ("25 anos to") or the waiting transfer's sentence; null on an Available row. */
  text: string | null;
  /** An account id in short form after the text, in the id font: the trade's buyer; null on every other row. */
  code: string | null;
  /** The small line under that: the trade's stage in words and its date; null on every other row. */
  detail: string | null;
  /** The amount at the right, "250 anos"; null where the text says it. */
  amount: string | null;
  /** The page a tap opens; null for a row that leads nowhere. */
  link: string[] | null;
}

/**
 * The balance sheet (wallet spec 8.2, Wallet), opened with MatBottomSheet
 * by a row of the balance card: the details of one of the card's four
 * amounts. The title is the row's label and amount, "Staked · 250 anos".
 * Under it one row per item, in the accounts' order, each with its
 * account's name (account-names.ts):
 * available, an account that has anos available, with the amount; a tap
 * opens the account's page;
 * staked, an account's stake for one purpose, with the purpose and the
 * amount, the purposes in the order of STAKE_PURPOSES; nothing to tap;
 * escrow, an open escrow trade the account sells in, as the account page
 * lists it: the amount, "to" and the buyer's id in short form, then the
 * stage in words from the seller's side and the date; a tap opens the
 * trade's page;
 * sending, a waiting transfer, in the Wallet page's words for its kind
 * ("25 in an assisted transfer", "15 waiting out a lock", "5 pending"); a
 * tap opens the assisted transfer's page, or the account's page for the
 * other two.
 * A row that leads somewhere is a link, and a tap on it closes the sheet.
 * The sheet reads balances.service, the session's accounts and their names
 * itself, as the card does, so it follows a refresh while it is open, and
 * its rows add up to the amount in its title.
 */
@Component({
  selector: 'app-balance-sheet',
  imports: [RouterLink],
  template: `
    <h3>{{ title() }}</h3>
    <div class="rows">
      @for (row of rows(); track row.id) {
        @if (row.link) {
          <a class="row" [routerLink]="row.link" (click)="close()">
            <span class="what">
              <span class="name">{{ row.name }}</span>
              @if (row.text) {
                <span>{{ row.text }} @if (row.code) {<code>{{ row.code }}</code>}</span>
              }
              @if (row.detail) {
                <span class="detail">{{ row.detail }}</span>
              }
            </span>
            @if (row.amount) {
              <span class="amount">{{ row.amount }}</span>
            }
          </a>
        } @else {
          <div class="row">
            <span class="what">
              <span class="name">{{ row.name }}</span>
              @if (row.text) {
                <span>{{ row.text }} @if (row.code) {<code>{{ row.code }}</code>}</span>
              }
              @if (row.detail) {
                <span class="detail">{{ row.detail }}</span>
              }
            </span>
            @if (row.amount) {
              <span class="amount">{{ row.amount }}</span>
            }
          </div>
        }
      }
    </div>
  `,
  styles: `
    :host { display: block; padding: 8px 16px 16px; }
    h3 { font-size: 1.1rem; font-weight: 500; margin: 8px 0 12px; }
    .rows { max-height: 55vh; overflow: auto; }
    .row { display: flex; align-items: center; gap: 12px; padding: 12px 8px; border-radius: 8px; color: inherit; text-decoration: none; }
    a.row:hover { background: var(--mat-sys-surface-container); }
    .what { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .name { font-weight: 500; }
    .detail { color: var(--mat-sys-on-surface-variant); font-size: 13px; line-height: 18px; }
    .amount { flex: none; max-width: 60%; text-align: right; }
  `,
})
export class BalanceSheetComponent {
  private readonly data = inject<BalanceSheetData>(MAT_BOTTOM_SHEET_DATA);
  private readonly ref = inject<MatBottomSheetRef<BalanceSheetComponent>>(MatBottomSheetRef);
  private readonly balances = inject(BalancesService);
  private readonly session = inject(SessionService);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  /** The row's label and its amount over the pod's accounts, "Staked · 250 anos". */
  protected readonly title = computed((): string => {
    const line = balanceLine(this.data.kind, this.balances.totals(), this.t().balanceCard);
    return `${line.label} · ${this.t().common.anos(millionthsToAnos(line.amount))}`;
  });

  /** The rows of this sheet's kind over the landed accounts, in the accounts' order: what the totals count, item by item. */
  protected readonly rows = computed((): SheetRow[] => {
    const t = this.t();
    const entries = this.balances.byAccount();
    const accounts = this.session.accounts();
    const names = accountNames(accounts, t.accountKinds);
    const anos = (millionths: string | bigint): string => t.common.anos(millionthsToAnos(millionths));
    const rows: SheetRow[] = [];
    for (const account of accounts) {
      const entry = entries[account.accountId];
      if (!entry?.landed) continue;
      const id = account.accountId;
      const name = names.get(id) ?? shortId(id);
      const page = ['/wallet', id];
      const none = { text: null, code: null, detail: null, amount: null };
      switch (this.data.kind) {
        case 'available':
          if (entry.available > 0n) rows.push({ ...none, id, name, amount: anos(entry.available), link: page });
          break;
        case 'staked':
          for (const purpose of STAKE_PURPOSES) {
            const stake = entry.stakes[purpose];
            if (stake) rows.push({ ...none, id: `${id}/${purpose}`, name, text: t.account.stakePurposes[purpose], amount: anos(stake), link: null });
          }
          break;
        case 'escrow':
          for (const e of entry.escrows) {
            rows.push({
              ...none,
              id: e.transactionId,
              name,
              text: `${anos(e.amount)} ${t.account.to}`,
              code: shortId(e.accountIdTo),
              detail: `${escrowStageWords(e.stage, 'seller', t.escrowStages)} · ${this.lang.dateTime(e.createdAt)}`,
              link: [...page, 'escrow', e.transactionId],
            });
          }
          break;
        case 'sending': {
          const assisted = entry.assistedTransfer;
          if (assisted) rows.push({ ...none, id: assisted.transactionId, name, text: t.wallet.inAssisted(millionthsToAnos(assisted.amount)), link: [...page, 'assisted', assisted.transactionId] });
          const locked = entry.lockedTransfer;
          if (locked) rows.push({ ...none, id: locked.transactionId, name, text: t.wallet.waitingOutLock(millionthsToAnos(locked.amount)), link: page });
          // a pending row with no amount (the validator answers "0") sends no anos, so it is no row here
          for (const p of entry.pendingTransfers) {
            if (BigInt(p.amount) > 0n) rows.push({ ...none, id: p.transactionId, name, text: t.wallet.pending(millionthsToAnos(p.amount)), link: page });
          }
          break;
        }
      }
    }
    return rows;
  });

  /** A tap on a row that leads somewhere: the sheet closes, and the row's link opens its page. */
  protected close(): void {
    this.ref.dismiss();
  }
}
