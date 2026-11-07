import { Component, DestroyRef, inject, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { LanguageService } from '../services/language.service';

/**
 * The copy button (wallet spec 8.5): an icon button that copies `text` to
 * the clipboard and shows "copied" next to the icon for two seconds, or
 * "could not copy" when the browser refuses. Next to account ids on the
 * wallet list, the account page and in chat; the case pages keep their own
 * copy code.
 */
@Component({
  selector: 'app-copy-button',
  imports: [MatButtonModule, MatIconModule],
  template: `
    <button mat-icon-button type="button" (click)="copy()" [attr.aria-label]="label() ?? t().common.copy"><mat-icon>content_copy</mat-icon></button>
    @if (word(); as word) { <span class="word">{{ word }}</span> }
  `,
  styles: `
    :host { display: inline-flex; align-items: center; vertical-align: middle; }
    .word { font-size: 12px; color: var(--mat-sys-on-surface-variant); white-space: nowrap; }
  `,
})
export class CopyButtonComponent {
  /** What a tap copies. */
  readonly text = input.required<string>();
  /** The button's label for screen readers; the dictionary's Copy when the caller gives none. */
  readonly label = input<string | null>(null);

  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;
  protected readonly word = signal<string | null>(null);
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      if (this.timer) clearTimeout(this.timer);
    });
  }

  protected async copy(): Promise<void> {
    let word = this.t().copy.copied;
    try {
      await navigator.clipboard.writeText(this.text());
    } catch {
      word = this.t().copy.couldNotCopy;
    }
    this.word.set(word);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.word.set(null), 2000);
  }
}
