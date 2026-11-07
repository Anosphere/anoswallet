import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { DateAdapter } from '@angular/material/core';
import { MatStepperIntl } from '@angular/material/stepper';
import { en, type Words } from '../i18n/en';
import { th } from '../i18n/th';

/** The two languages of the app (wallet spec 8.8). */
export type Language = 'en' | 'th';

/** The browser's locale tag of each language. The Thai one names the Gregorian calendar, so a Thai date reads 2026, not 2569. */
const TAGS: Record<Language, string> = { en: 'en-US', th: 'th-TH-u-ca-gregory' };

/**
 * The language on screen (wallet spec 8.8): Thai when the browser's first
 * language is Thai, else English; English after the landing page's Switch to
 * English, for as long as this tab lives. Nothing is stored. The words of that
 * language (every page reads `t = this.lang.words` and writes `t().page.key`),
 * the locale tag for the browser's own formatting, the two date shapes, and
 * the page's `lang` attribute, the date pickers' calendar and Material's
 * "Optional", which follow the language.
 */
@Injectable({ providedIn: 'root' })
export class LanguageService {
  private readonly dateAdapter = inject(DateAdapter);
  private readonly stepperIntl = inject(MatStepperIntl);

  /** The language on screen. */
  readonly language = signal<Language>(detect());

  /** The words of the language on screen. */
  readonly words = computed<Words>(() => (this.language() === 'th' ? th : en));

  /** The locale tag of the language on screen, for toLocaleDateString and the like and for Intl.DisplayNames. */
  readonly tag = computed(() => TAGS[this.language()]);

  constructor() {
    effect(() => {
      document.documentElement.lang = this.language();
      this.dateAdapter.setLocale(this.tag());
      this.stepperIntl.optionalLabel = this.words().material.optional;
      this.stepperIntl.changes.next();
    });
  }

  /** Switch to English, the landing page's button while the app is in Thai: for this tab. */
  useEnglish(): void {
    this.language.set('en');
  }

  /** A moment as date and time, what `date: 'medium'` gave: "Nov 6, 2026, 3:50:12 PM", "6 พ.ย. 2026 15:50:12". */
  dateTime(moment: string | Date): string {
    return new Date(moment).toLocaleString(this.tag(), { dateStyle: 'medium', timeStyle: 'medium' });
  }

  /** A moment as a time with seconds, what `date: 'mediumTime'` gave: "3:50:12 PM", "15:50:12". */
  time(moment: string | Date): string {
    return new Date(moment).toLocaleTimeString(this.tag(), { timeStyle: 'medium' });
  }
}

/** Thai when the browser's first preferred language is Thai; else English. */
function detect(): Language {
  const first = navigator.languages?.[0] ?? navigator.language ?? '';
  return /^th(-|$)/i.test(first) ? 'th' : 'en';
}
