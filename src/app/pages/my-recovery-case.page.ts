import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { RouterLink } from '@angular/router';
import { accountNames } from '../account-names';
import { CaseChatListComponent } from '../components/case-chat-list.component';
import { CASES_POLL_MS } from '../constants';
import { LanguageService } from '../services/language.service';
import { reasonOf } from '../services/log.service';
import { BreakGlassCaseItem, BreakGlassEvent, MasterpodApiService } from '../services/masterpod-api.service';
import { SessionService } from '../services/session.service';
import { shortId } from '../short-id';
import { REVIEW_STATUSES, STATUS_ICONS } from './attesting.page';

/** The icon of each event the person may see on a recovery case (masterpod 14.4.1), as My case draws them. */
const EVENT_ICONS: Record<string, string> = { scheduled: 'event', decided: 'verified', sent: 'send', dismissed: 'block' };

/** The video call: the time of the newest scheduled event in words, and its meeting link. */
interface Call {
  when: string;
  link: string | null;
}

/** One line of Your accounts: the sentence of a move cut at the new account, which the page draws as a link to that account. */
interface MoveLine {
  transactionId: string;
  accountIdTo: string;
  before: string;
  to: string;
  after: string;
}

/** One line of the timeline. */
interface TimelineItem {
  key: string;
  icon: string;
  text: string;
  link: string | null;
  when: string;
}

/**
 * My recovery case (wallet spec 13.3, /cases/recovery/:caseId, every
 * edition, 2026-11-12): the person's side of the recovery case under which
 * the money of the lost accounts is moved (masterpod 14), in the frame of
 * My case. It reads /list-my-break-glass-moves when it opens, by Refresh
 * and every 15 s, and takes the case with this id. Top to bottom: the
 * status in words and, while the case is open or in review, how many of
 * the two attestors have signed; the video call, while the case is open or
 * in review (the newest scheduled event: its time, and Join the video call,
 * which opens the meeting link in a new tab; "No video call is set up yet."
 * without one); "Chat with the attestor" and the person's chats about the
 * case (8.7); "Your accounts", one line per move (the account's kind, the
 * old account's short id, and the new account by its name, else its short
 * id, as a link to its page); the timeline the person may see (scheduled
 * with the meeting link, decided, sent, dismissed with the reason in
 * words). The masterpod names no attestor in this answer. The notification
 * recoveryCaseScheduled leads here.
 */
@Component({
  selector: 'app-my-recovery-case-page',
  imports: [RouterLink, MatCardModule, MatButtonModule, MatIconModule, MatListModule, MatProgressBarModule, CaseChatListComponent],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>{{ t().myRecoveryCase.title }}</mat-card-title>
        <mat-card-subtitle class="subtitle">
          <span>{{ t().common.caseId(shortCaseId()) }}</span>
          <button mat-icon-button type="button" (click)="copyCaseId()" [attr.aria-label]="t().common.copyCaseId"><mat-icon>content_copy</mat-icon></button>
          @if (copied()) {
            <span class="muted">{{ t().copy.copied }}</span>
          }
        </mat-card-subtitle>
      </mat-card-header>
      <mat-card-content>
        <div class="row">
          <a mat-button routerLink="/cases"><mat-icon>arrow_back</mat-icon> {{ t().nav.cases }}</a>
          <button mat-stroked-button type="button" (click)="refresh()" [disabled]="busy()">{{ t().common.refresh }}</button>
        </div>
        @if (busy()) {
          <mat-progress-bar mode="indeterminate"></mat-progress-bar>
        }
        @if (error(); as text) {
          <p class="error">{{ text }}</p>
        }
        @if (data(); as d) {
          <p class="status"><mat-icon class="inline">{{ icons[d.status] }}</mat-icon> {{ statusText(d) }}</p>
          @if (!final()) {
            <p>{{ t().myRecoveryCase.signed(d.signOffs) }}</p>

            <h3>{{ t().common.videoCall }}</h3>
            @if (call(); as c) {
              <p>{{ t().myRecoveryCase.callAt(c.when) }}</p>
              @if (c.link) {
                <p><a mat-flat-button [href]="c.link" target="_blank" rel="noopener">{{ t().myRecoveryCase.joinCall }}</a></p>
              }
            } @else {
              <p class="muted">{{ t().myRecoveryCase.noCall }}</p>
            }
          }

          <h3>{{ t().caseChat.title }}</h3>
          <app-case-chat-list [caseId]="caseId()" />

          <h3>{{ t().myRecoveryCase.accounts }}</h3>
          @for (m of moves(); track m.transactionId) {
            <p>{{ m.before }}<a [routerLink]="['/wallet', m.accountIdTo]">{{ m.to }}</a>{{ m.after }}</p>
          }

          <h3>{{ t().common.timeline }}</h3>
          @if (timeline().length === 0) {
            <p class="muted">{{ t().common.nothingYet }}</p>
          }
          <mat-list dense>
            @for (item of timeline(); track item.key) {
              <mat-list-item>
                <mat-icon matListItemIcon>{{ item.icon }}</mat-icon>
                <span matListItemTitle>
                  {{ item.text }}
                  @if (item.link) {
                    <a [href]="item.link" target="_blank" rel="noopener">{{ t().common.meetingLink }}</a>
                  }
                </span>
                <span matListItemLine>{{ item.when }}</span>
              </mat-list-item>
            }
          </mat-list>
        }
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    .subtitle { display: flex; align-items: center; gap: 4px; }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 8px 0; }
    .status { font-weight: 500; }
    .inline { font-size: 18px; width: 18px; height: 18px; vertical-align: text-bottom; }
    .muted { color: var(--mat-sys-on-surface-variant); }
    .error { color: var(--mat-sys-error); }
  `,
})
export class MyRecoveryCasePage {
  readonly caseId = input.required<string>();

  private readonly session = inject(SessionService);
  private readonly masterpod = inject(MasterpodApiService);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  protected readonly icons = STATUS_ICONS;

  /** The case with this page's id, out of the last /list-my-break-glass-moves answer; null until it is read, and when the answer has none. */
  protected readonly data = signal<BreakGlassCaseItem | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly copied = signal(false);

  protected readonly shortCaseId = computed(() => `${this.caseId().slice(0, 8)}…${this.caseId().slice(-8)}`);

  /** True once the case is decided or dismissed: the sign-offs and the video call no longer show. */
  protected readonly final = computed(() => {
    const status = this.data()?.status;
    return status !== undefined && !REVIEW_STATUSES.includes(status);
  });

  /** The video call: the newest scheduled event, or null while an attestor has set none up. */
  protected readonly call = computed<Call | null>(() => {
    const event = [...(this.data()?.events ?? [])].reverse().find((e) => e.kind === 'scheduled');
    if (!event) return null;
    const link = event.details['meetLink'];
    return { when: this.callTime(event), link: typeof link === 'string' ? link : null };
  });

  /**
   * Your accounts: one line per move, in the masterpod's account order. The
   * new account reads its name among the session's accounts
   * (account-names.ts), else its short id. The sentence is built with the
   * new account's id standing where the account goes and is cut there, so
   * the page draws the account as a link, wherever a language puts it.
   */
  protected readonly moves = computed<MoveLine[]>(() => {
    const kinds = this.t().accountKinds;
    const names = accountNames(this.session.accounts(), kinds);
    return (this.data()?.moves ?? []).map((move) => {
      const [before, after = ''] = this.t().myRecoveryCase.moveLine(kinds[move.accountType] ?? move.accountType, shortId(move.accountId), move.accountIdTo).split(move.accountIdTo);
      return { transactionId: move.transactionId, accountIdTo: move.accountIdTo, before, to: names.get(move.accountIdTo) ?? shortId(move.accountIdTo), after };
    });
  });

  protected readonly timeline = computed<TimelineItem[]>(() =>
    (this.data()?.events ?? []).map((event, i) => ({
      key: `${i}-${event.kind}-${event.createdAt}`,
      icon: EVENT_ICONS[event.kind] ?? 'circle',
      text: this.textOf(event),
      link: event.kind === 'scheduled' && typeof event.details['meetLink'] === 'string' ? event.details['meetLink'] : null,
      when: this.lang.dateTime(event.createdAt),
    })),
  );

  constructor() {
    effect(() => {
      this.caseId();
      untracked(() => void this.refresh());
    });
    const timer = setInterval(() => void this.load(true), CASES_POLL_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  // --- the case ----------------------------------------------------------------

  protected async refresh(): Promise<void> {
    this.busy.set(true);
    try {
      await this.load(false);
    } finally {
      this.busy.set(false);
    }
  }

  /** /list-my-break-glass-moves, and out of it the case with this page's id; none is "No recovery case of yours with this id." A refused read leaves what the page shows. */
  private async load(quiet: boolean): Promise<void> {
    const res = await this.masterpod.listMyBreakGlassMoves(quiet);
    if (!res.ok) {
      this.error.set(`/list-my-break-glass-moves: ${reasonOf(res)}`);
      return;
    }
    const found = res.body.cases.find((c) => c.caseId === this.caseId()) ?? null;
    this.data.set(found);
    this.error.set(found ? null : this.t().myRecoveryCase.notFound);
  }

  /** The status in words; a dismissed case with its reason, as My case words it. */
  protected statusText(d: BreakGlassCaseItem): string {
    const words = this.t().myRecoveryCase;
    switch (d.status) {
      case 'open':
        return words.statusOpen;
      case 'inReview':
        return words.statusInReview;
      case 'decided':
        return words.statusDecided;
      case 'dismissed':
        return this.t().myCase.statusDismissed(this.reasonWords([...d.events].reverse().find((e) => e.kind === 'dismissed')));
    }
  }

  /** The reason of a dismissed event in words: the dictionary's, the word as the masterpod sent it when the dictionary has none, "another reason" without an event or a reason. */
  private reasonWords(event: BreakGlassEvent | undefined): string {
    const reason = event?.details['reason'];
    return typeof reason === 'string' ? (this.t().dismissReasons[reason] ?? reason) : this.t().common.anotherReason;
  }

  // --- copy and the timeline -------------------------------------------------------------

  protected async copyCaseId(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.caseId());
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } catch {
      this.error.set(this.t().common.couldNotCopyId);
    }
  }

  /** The time of a scheduled event as date and time, or "a time to be confirmed" when the event carries none. */
  private callTime(event: BreakGlassEvent): string {
    const at = event.details['at'];
    return typeof at === 'string' ? this.lang.dateTime(at) : this.t().common.timeToBeConfirmed;
  }

  /** One event in words (masterpod 14.4.1), as My case words the same kinds. */
  private textOf(event: BreakGlassEvent): string {
    switch (event.kind) {
      case 'scheduled':
        return this.t().common.videoCallScheduled(this.callTime(event));
      case 'decided':
        return this.t().myRecoveryCase.eventDecided;
      case 'sent':
        return this.t().myCase.eventSent;
      case 'dismissed':
        return this.t().common.dismissed(this.reasonWords(event));
      default:
        return event.kind;
    }
  }
}
