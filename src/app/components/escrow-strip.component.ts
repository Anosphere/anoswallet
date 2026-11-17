import { Component, inject, input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { EscrowGuide } from '../escrow-stage';
import { LanguageService } from '../services/language.service';

/**
 * The status box of an escrow trade (wallet spec 8.7; 2026-11-17,
 * forclaude/wallet-trade-guide-plan-1.md): one box that says whether the
 * anos are in escrow, which of the four steps the trade is at, and the one
 * thing to do or not to do. What it shows is the `guide` it is given, built
 * by escrowGuide (escrow-stage.ts) from the trade's state and this pod's
 * side: an icon, the headline, the step ("Step 3 of 4") when the state is
 * one, and the sentence under them when there is one. Green (`ok`), amber
 * (`warn`) or grey; the words carry the meaning as well, so the colour is
 * never alone. The box reads the dictionary itself for the step label
 * only. On the escrow trade page it stands first, under the Back link,
 * while the trade is open.
 */
@Component({
  selector: 'app-escrow-strip',
  imports: [MatIconModule],
  template: `
    <div class="strip" role="status" [class.ok]="guide().tone === 'ok'" [class.warn]="guide().tone === 'warn'">
      <mat-icon aria-hidden="true">{{ guide().icon }}</mat-icon>
      <div class="texts">
        <div class="top">
          <span class="headline">{{ guide().headline }}</span>
          @if (guide().step; as step) {
            <span class="step">{{ t().escrowGuide.stepOf(step) }}</span>
          }
        </div>
        @if (guide().text) {
          <div class="text">{{ guide().text }}</div>
        }
      </div>
    </div>
  `,
  styles: `
    :host { display: block; }
    .strip { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border-radius: 12px; background: var(--mat-sys-surface-container-high); color: var(--mat-sys-on-surface); }
    .strip.ok { background: #e8f5e9; color: #1b5e20; }
    .strip.warn { background: #fff8e1; color: #7a5200; }
    .texts { flex: 1; min-width: 0; }
    .top { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
    .headline { font-size: 16px; font-weight: 500; }
    .step { font-size: 12px; white-space: nowrap; }
    .text { font-size: 14px; line-height: 1.4; margin-top: 2px; }
  `,
})
export class EscrowStripComponent {
  /** What the box shows: its colour, icon, headline, sentence and step. */
  readonly guide = input.required<EscrowGuide>();

  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;
}
