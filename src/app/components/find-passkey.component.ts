import { NgTemplateOutlet } from '@angular/common';
import { Component, ElementRef, afterRenderEffect, computed, inject, output, signal, viewChild } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { Router, RouterLink } from '@angular/router';
import { ConfigService } from '../services/config.service';
import { CryptoService } from '../services/crypto.service';
import { LanguageService } from '../services/language.service';
import { MasterpodApiService } from '../services/masterpod-api.service';
import { PasskeyService } from '../services/passkey.service';
import { SessionService } from '../services/session.service';
import { unlockWithPasskey } from '../unlock';

/** The screens of the walk-through, in order. */
type Screen = 1 | 2 | 3 | 4 | 5;

/** How many screens there are, for the line "2 of 5". */
const SCREENS = 5;

/** How a try of Log in ended when it did not log the person in: the device used no passkey, the passkey opens no anoPod, or anything else, with what was thrown. */
interface TryResult {
  kind: 'none' | 'unknown' | 'other';
  reason: string;
}

/**
 * Reads what a failed unlockWithPasskey threw. The browser's
 * NotAllowedError: the person closed the device's passkey box, the device
 * has no passkey for the site, or the browser does not allow passkeys
 * where the page is shown (a page inside another app); the page cannot
 * tell these apart. "/unlock: HTTP 401: unknown passkey": the masterpod
 * knows no anoPod with the passkey that signed, which it also answers for
 * the passkey of an open recovery case. Anything else is a fault, kept
 * with its text.
 */
function tryResultOf(err: unknown): TryResult {
  if (err instanceof DOMException && err.name === 'NotAllowedError') return { kind: 'none', reason: '' };
  const reason = err instanceof Error ? err.message : String(err);
  if (/^\/unlock: .*unknown passkey$/.test(reason)) return { kind: 'unknown', reason };
  return { kind: 'other', reason };
}

/**
 * The walk-through "Find your passkey first" (wallet spec 12.3;
 * 2026-11-18, section 11): what a person goes through on /recover/open
 * before the locked-out stepper shows. Six people of the first days of
 * production opened a recovery case without having lost their passkey,
 * and the check at "Open my case" sees only the device in the person's
 * hand, at the last tap. Five screens, one at a time, each naming one
 * place a passkey may be. 1: this device, with a real Log in (the start
 * page's, unlockWithPasskey); the button that goes on shows only after a
 * try that did not log the person in. 2: the device where the anoPod was
 * made; a person who still has it is sent there and the walk ends. 3:
 * the Apple or Google account, and where to look. 4: a spare passkey. 5:
 * what a recovery is, and a box to tick. Screens 2 to 4 ask with two
 * buttons; the answer that ends the walk puts the screen's ending in the
 * place of the question, and Back on an ending shows the question again.
 * A try that works opens the session and goes where the start page's Log
 * in goes. A try that does not shows one of three sentences: no passkey
 * was used, the passkey opens no anoPod, or the fault with its reason.
 * done is given when the person ticks the box of screen 5 and presses
 * Next. Nothing is kept: every field dies with the page, so a reload or
 * a new visit starts at screen 1. The component asks the masterpod only
 * what a Log in asks, and nothing at all until "Try Log in now" is
 * pressed.
 */
@Component({
  selector: 'app-find-passkey',
  imports: [NgTemplateOutlet, RouterLink, MatCardModule, MatButtonModule, MatCheckboxModule, MatProgressBarModule],
  template: `
    <div #top></div>
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>{{ t().findPasskey.title }}</mat-card-title>
        <mat-card-subtitle>{{ t().findPasskey.counter(screen(), screens) }}</mat-card-subtitle>
      </mat-card-header>
      <mat-card-content>
        @switch (screen()) {
          @case (1) {
            <h3>{{ t().findPasskey.s1Title }}</h3>
            <p>{{ t().findPasskey.s1Text1 }}</p>
            <p>{{ t().findPasskey.s1Text2 }}</p>
            <ng-container *ngTemplateOutlet="tryBlock" />
            <p class="back"><a mat-button routerLink="/recover">{{ t().common.back }}</a></p>
          }
          @case (2) {
            <h3>{{ t().findPasskey.s2Title }}</h3>
            @if (found()) {
              <p>{{ t().findPasskey.s2Found(address) }}</p>
              <div class="answers">
                <a mat-flat-button routerLink="/">{{ t().recoverOpen.toStart }}</a>
              </div>
              <p class="back"><button mat-button type="button" (click)="backToQuestion()">{{ t().common.back }}</button></p>
            } @else {
              <p>{{ t().findPasskey.s2Text }}</p>
              <p>{{ t().findPasskey.s2OtherApp(address) }}</p>
              <p class="question">{{ t().findPasskey.s2Question }}</p>
              <div class="answers">
                <button mat-flat-button type="button" (click)="answerFound()">{{ t().findPasskey.s2Yes }}</button>
                <button mat-stroked-button type="button" (click)="go(3)">{{ t().findPasskey.s2No }}</button>
              </div>
              <p class="back"><button mat-button type="button" (click)="go(1)">{{ t().common.back }}</button></p>
            }
          }
          @case (3) {
            <h3>{{ t().findPasskey.s3Title }}</h3>
            @if (found()) {
              <p>{{ t().findPasskey.foundHere(address) }}</p>
              <ng-container *ngTemplateOutlet="tryBlock" />
              <p class="back"><button mat-button type="button" (click)="backToQuestion()" [disabled]="busy()">{{ t().common.back }}</button></p>
            } @else {
              <p>{{ t().findPasskey.s3Text }}</p>
              <p>{{ t().findPasskey.s3Apple(site()) }}</p>
              <p>{{ t().findPasskey.s3Google }}</p>
              <p>{{ t().findPasskey.s3OtherApp }}</p>
              <div class="answers">
                <button mat-flat-button type="button" (click)="answerFound()">{{ t().findPasskey.s3Yes }}</button>
                <button mat-stroked-button type="button" (click)="go(4)">{{ t().findPasskey.s3No }}</button>
              </div>
              <p class="back"><button mat-button type="button" (click)="go(2)">{{ t().common.back }}</button></p>
            }
          }
          @case (4) {
            <h3>{{ t().findPasskey.s4Title }}</h3>
            @if (found()) {
              <p>{{ t().findPasskey.s4Found }}</p>
              <p>{{ t().findPasskey.foundHere(address) }}</p>
              <ng-container *ngTemplateOutlet="tryBlock" />
              <p class="back"><button mat-button type="button" (click)="backToQuestion()" [disabled]="busy()">{{ t().common.back }}</button></p>
            } @else {
              <p>{{ t().findPasskey.s4Text }}</p>
              <div class="answers">
                <button mat-flat-button type="button" (click)="answerFound()">{{ t().findPasskey.s4Yes }}</button>
                <button mat-stroked-button type="button" (click)="go(5)">{{ t().findPasskey.s4No }}</button>
              </div>
              <p class="back"><button mat-button type="button" (click)="go(3)">{{ t().common.back }}</button></p>
            }
          }
          @case (5) {
            <h3>{{ t().findPasskey.s5Title }}</h3>
            <p>{{ t().findPasskey.s5Intro }}</p>
            <ol>
              <li>{{ t().findPasskey.s5Moderator }}</li>
              @if (threshold(); as needed) {
                <li>{{ t().findPasskey.s5Bankers(needed) }}</li>
              } @else {
                <li>{{ t().findPasskey.s5BankersSome }}</li>
              }
              <li>{{ t().findPasskey.s5Money }}</li>
              @if (waits(); as w) {
                <li>{{ t().findPasskey.s5Waits(w.guarded, w.vault) }}</li>
              } @else {
                <li>{{ t().findPasskey.s5WaitsSome }}</li>
              }
            </ol>
            <mat-checkbox [checked]="ticked()" (change)="ticked.set($event.checked)">{{ t().findPasskey.s5Tick }}</mat-checkbox>
            <div class="answers">
              <button mat-flat-button type="button" (click)="done.emit()" [disabled]="!ticked()">{{ t().common.next }}</button>
            </div>
            <p class="back"><button mat-button type="button" (click)="go(4)">{{ t().common.back }}</button></p>
          }
        }
      </mat-card-content>
    </mat-card>

    <ng-template #tryBlock>
      @if (busy()) {
        <mat-progress-bar mode="indeterminate"></mat-progress-bar>
        <p>{{ t().landing.unlocking }}</p>
      }
      @if (said(); as s) {
        <p [class.error]="s.fault">{{ s.text }}</p>
      }
      <div class="answers" #tryRow>
        <button mat-flat-button type="button" (click)="tryLogIn()" [disabled]="busy()">{{ t().findPasskey.tryButton }}</button>
        @if (screen() === 1 && tried()) {
          <button mat-stroked-button type="button" (click)="go(2)" [disabled]="busy()">{{ t().findPasskey.s1Next }}</button>
        }
      </div>
    </ng-template>
  `,
  styles: `
    p, li { max-width: 640px; }
    h3 { margin: 8px 0 12px; font-size: 1.125rem; font-weight: 500; }
    ol { margin: 0 0 12px; padding-left: 24px; }
    li { margin-bottom: 8px; }
    .question { font-weight: 500; }
    /* A screen's buttons stand side by side and go under each other on a narrow phone. */
    .answers { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
    .back { margin: 8px 0 0; }
    .error { color: var(--mat-sys-error); }
    mat-progress-bar { margin: 8px 0; }
    mat-checkbox { display: block; margin: 4px 0; }
  `,
})
export class FindPasskeyComponent {
  private readonly api = inject(MasterpodApiService);
  private readonly config = inject(ConfigService);
  private readonly crypto = inject(CryptoService);
  private readonly passkey = inject(PasskeyService);
  private readonly session = inject(SessionService);
  private readonly router = inject(Router);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  /** The person ticked the box of the last screen and pressed Next: the page that holds the walk-through shows its form. */
  readonly done = output<void>();

  protected readonly screens = SCREENS;
  /** The screen that shows. */
  protected readonly screen = signal<Screen>(1);
  /** Screens 2 to 4: the person gave the answer that ends the walk ("Yes, I still have it", "I found it", "I have one"), and the screen shows its ending in the place of the question. */
  protected readonly found = signal(false);
  /** A try of Log in was made in this visit and did not log the person in: screen 1 then shows the button that goes on. */
  protected readonly tried = signal(false);
  /** A try of Log in is running: the device's passkey box may be open. */
  protected readonly busy = signal(false);
  /** How the last try ended; null before a try, while one runs and after a change of screen or view. */
  protected readonly result = signal<TryResult | null>(null);
  /** The box of the last screen. */
  protected readonly ticked = signal(false);

  /** The name a password list shows for the wallet's passkeys: the relying-party id of the configuration (wallet.anocloud.com in production, in all three editions); the page's host name until the configuration has loaded. */
  protected readonly site = computed(() => this.config.config()?.rpId ?? location.hostname);
  /** The address a person opens on another device: this page's own host, so each edition names its own. */
  protected readonly address = location.host;
  /** How many bankers have to send their part: the share threshold of the configuration; null until it has loaded. */
  protected readonly threshold = computed(() => this.config.config()?.shareThreshold ?? null);
  /** The two locks in words, "7 days" and "30 days": the lock numbers of the configuration, without the offset; null when the proxy sent none or the configuration has not loaded. */
  protected readonly waits = computed((): { guarded: string; vault: string } | null => {
    const c = this.config.config();
    const guarded = c?.guardedLockMinutes;
    const vault = c?.vaultLockMinutes;
    return typeof guarded === 'number' && typeof vault === 'number' ? { guarded: this.t().minutes(guarded), vault: this.t().minutes(vault) } : null;
  });
  /** The sentence of the last try, and whether it is a fault (red) or one of the two plain sentences. */
  protected readonly said = computed((): { text: string; fault: boolean } | null => {
    const r = this.result();
    if (r === null) return null;
    const words = this.t().findPasskey;
    if (r.kind === 'none') return { text: words.tryNone(this.site()), fault: false };
    if (r.kind === 'unknown') return { text: words.tryUnknown, fault: false };
    return { text: words.tryOther(r.reason), fault: true };
  });

  /** The top of the card: a new screen or view starts there. */
  private readonly top = viewChild<ElementRef<HTMLElement>>('top');
  /** The row with "Try Log in now": after a try it is scrolled back onto the screen. */
  private readonly tryRow = viewChild<ElementRef<HTMLElement>>('tryRow');

  constructor() {
    // The site name and the numbers of the last screen; a wallet that cannot load them shows the sentences without a number.
    void this.config.load().catch(() => undefined);
    // A person taps a button at the bottom of a screen; the screen that takes its place starts at its top.
    afterRenderEffect(() => {
      this.screen();
      this.found();
      this.top()?.nativeElement.scrollIntoView({ block: 'nearest' });
    });
    // The sentence of a try comes in above the buttons and pushes them down; once it is drawn, the row is scrolled back onto the screen, just far enough.
    afterRenderEffect(() => {
      if (this.result()) this.tryRow()?.nativeElement.scrollIntoView({ block: 'nearest' });
    });
  }

  /** Another screen: its question view, with no sentence of a try, and the box of the last screen unticked. */
  protected go(screen: Screen): void {
    this.screen.set(screen);
    this.found.set(false);
    this.result.set(null);
    this.ticked.set(false);
  }

  /** The answer that ends the walk: the screen shows its ending. */
  protected answerFound(): void {
    this.found.set(true);
    this.result.set(null);
  }

  /** Back on an ending: the question again. */
  protected backToQuestion(): void {
    this.found.set(false);
    this.result.set(null);
  }

  /** "Try Log in now": the start page's Log in. It works: the session is open and the person goes where the start page sends them. It does not: tried is set and the sentence of the try shows. */
  protected async tryLogIn(): Promise<void> {
    this.busy.set(true);
    this.result.set(null);
    try {
      const status = await unlockWithPasskey({ api: this.api, crypto: this.crypto, passkey: this.passkey, session: this.session });
      const next = this.session.nextStep(status);
      await this.router.navigateByUrl(next === '/wallet' ? '/home' : next);
    } catch (err) {
      this.tried.set(true);
      this.result.set(tryResultOf(err));
    } finally {
      this.busy.set(false);
    }
  }
}
