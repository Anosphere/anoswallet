import { Component, computed, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { millionthsToAnos } from '../amounts';
import { BalancesService } from '../services/balances.service';
import { LanguageService } from '../services/language.service';
import { SessionService } from '../services/session.service';

/**
 * The balance card (wallet spec 8.2, Home and Wallet): the pod's anos
 * added up over its accounts, from balances.service. Total, with a refresh
 * button; Available, what is left after the anos spoken for; then one
 * small line per kind spoken for, each only when its number is above zero
 * (escrow trades, assisted transfers, a lock, pending transfers), and the
 * accounts not on the ledger yet or not read. "No anos account yet."
 * without an account; "Reading…" until the first read finished. The
 * amounts never show a sign. No inputs: the card reads the services
 * itself.
 */
@Component({
  selector: 'app-balance-card',
  imports: [MatButtonModule, MatIconModule],
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
        <p class="available">{{ t().balanceCard.available(available()) }}</p>
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
    .available { margin: 4px 0 0; font-size: 16px; }
    .line { margin: 6px 0 0; font-size: 13px; }
  `,
})
export class BalanceCardComponent {
  protected readonly balances = inject(BalancesService);
  protected readonly session = inject(SessionService);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  protected readonly total = computed(() => millionthsToAnos(this.balances.totals().total));
  protected readonly available = computed(() => millionthsToAnos(this.balances.totals().available));

  /** The small lines under Available, each only when its number is above zero. */
  protected readonly lines = computed((): string[] => {
    const t = this.balances.totals();
    const words = this.t().balanceCard;
    const lines: string[] = [];
    if (t.escrow > 0n) lines.push(words.inEscrow(millionthsToAnos(t.escrow)));
    if (t.assisted > 0n) lines.push(words.inAssisted(millionthsToAnos(t.assisted)));
    if (t.locked > 0n) lines.push(words.waitingOutLock(millionthsToAnos(t.locked)));
    if (t.pending > 0n) lines.push(words.inPending(millionthsToAnos(t.pending)));
    if (t.notLanded > 0) lines.push(words.notLanded(t.notLanded));
    if (t.failed > 0) lines.push(words.notRead(t.failed));
    return lines;
  });
}
