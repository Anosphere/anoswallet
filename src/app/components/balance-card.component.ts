import { Component, computed, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { millionthsToAnos } from '../amounts';
import { BalancesService } from '../services/balances.service';
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
        <span class="label">Total</span>
        <button mat-icon-button type="button" (click)="balances.refresh()" [disabled]="balances.busy()" aria-label="Refresh the balances"><mat-icon>refresh</mat-icon></button>
      </div>
      @if (session.accounts().length === 0) {
        <p class="line">No anos account yet.</p>
      } @else if (balances.readAt() === null) {
        <p class="total">Reading…</p>
      } @else {
        <p class="total">{{ total() }} anos</p>
        <p class="available">Available {{ available() }} anos</p>
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

  protected readonly total = computed(() => millionthsToAnos(this.balances.totals().total));
  protected readonly available = computed(() => millionthsToAnos(this.balances.totals().available));

  /** The small lines under Available, each only when its number is above zero. */
  protected readonly lines = computed((): string[] => {
    const t = this.balances.totals();
    const lines: string[] = [];
    if (t.escrow > 0n) lines.push(`${millionthsToAnos(t.escrow)} anos in escrow trades`);
    if (t.assisted > 0n) lines.push(`${millionthsToAnos(t.assisted)} anos in assisted transfers`);
    if (t.locked > 0n) lines.push(`${millionthsToAnos(t.locked)} anos waiting out a lock`);
    if (t.pending > 0n) lines.push(`${millionthsToAnos(t.pending)} anos in pending transfers`);
    if (t.notLanded > 0) lines.push(t.notLanded === 1 ? '1 account is not on the ledger yet' : `${t.notLanded} accounts are not on the ledger yet`);
    if (t.failed > 0) lines.push(t.failed === 1 ? '1 account could not be read' : `${t.failed} accounts could not be read`);
    return lines;
  });
}
