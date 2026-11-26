import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatChipListboxChange, MatChipsModule } from '@angular/material/chips';
import { MatIconModule } from '@angular/material/icon';
import { RouterLink } from '@angular/router';
import { NOTIFICATIONS_PAGE } from '../constants';
import { ChatService } from '../services/chat.service';
import { LanguageService } from '../services/language.service';
import { reasonOf } from '../services/log.service';
import { MasterpodApiService } from '../services/masterpod-api.service';
import { NotificationItem, SessionService } from '../services/session.service';

/** The five filters over the list: all the rows, or the rows of one group. */
type Group = 'all' | 'security' | 'chat' | 'cases' | 'vouching';

/** The four groups of the twenty-one kinds (2026-11-25; wallet spec 4.22). Which kinds make a group is the wallet's list: the masterpod knows no groups and is sent these kind names. A kind that is in no group shows under All only. */
const GROUPS: Record<Exclude<Group, 'all'>, string[]> = {
  security: ['passkeyAdded', 'transferWaiting', 'recoveryMoveWaiting', 'recoveryCaseOpened', 'alertSettingsChanged'],
  chat: ['chatInvite', 'inviteAccepted', 'inviteDeclined', 'joinRequest', 'joinApproved', 'joinDeclined'],
  cases: ['tradeCaseOpened', 'disputeCaseOpened', 'caseScheduled', 'caseDecided', 'caseDismissed', 'recoveryCaseScheduled'],
  vouching: ['vouchRequest', 'vouchApproved', 'vouchDeclined', 'vouched'],
};

/** The icon of each group: a shield with a lock for Security, and for the three others the icon that the side menu has for Chat, Cases and Vouch requests. */
const ICONS: Record<Exclude<Group, 'all'>, string> = { security: 'shield_lock', chat: 'chat', cases: 'folder_shared', vouching: 'verified_user' };

/** The five case kinds of masterpod 13.7: their reference id is a case id, and the row leads to the person's case page (wallet spec 13.4). */
const CASE_KINDS = ['tradeCaseOpened', 'disputeCaseOpened', 'caseScheduled', 'caseDecided', 'caseDismissed'];

/**
 * The notifications page (wallet spec 8.2 and 4.22), with a new look since
 * 2026-11-25 (the plan is forclaude/notifications-page-plan-1.md). A frame
 * of at most 720 pixels: the title, a row of five filters (All, Security,
 * Chat, Cases, Vouching) that scrolls sideways on a phone, and the rows. A
 * row is a round icon for its group, the kind's sentence whole on as many
 * lines as it needs, and under it the time ("Just now", "5 min ago", "3 h
 * ago", then as the chat list words a day). The whole row is the link, for
 * the fourteen kinds that were links before and for vouchRequest; the
 * other six kinds are no link.
 *
 * The page draws the list in memory (session.notifications), which the
 * shell's poll keeps: it asks the masterpod for no rows when it opens,
 * except in the first seconds after a login, while the wallet has no list
 * yet. Opening the page marks everything read: one request,
 * /mark-notifications-read with `upTo`, the list's `seq`, sent when the
 * page opens and when a row arrives while it is open, and never while the
 * unread number is 0. There is no button. The rows that were unread when
 * the page opened and the rows that arrived while it was open keep a dot
 * and a bold sentence for as long as the page is open (`fresh`); the ones
 * at the top stand under "New" and the rest under "Earlier", and with no
 * such row the page has neither heading.
 *
 * A tap on a filter shows the rows of that group that the list in memory
 * holds at once, and the page reads that filter's first page from the
 * masterpod ({ limit, kinds }), which takes their place. The filter's list
 * belongs to the page and is gone when another filter is picked. A row of
 * the group that the shell's poll brings later stands on top of it.
 * "Show older" stands under the list while older rows are left: under All
 * while the list in memory holds fewer rows than the pod has, under a
 * filter while that filter's last read came back full. A tap reads the
 * next 30 below the lowest `seq` the page shows; under All they go to the
 * end of the list in memory.
 */
@Component({
  selector: 'app-notifications-page',
  imports: [NgTemplateOutlet, RouterLink, MatButtonModule, MatChipsModule, MatIconModule],
  template: `
    <section class="page">
      <header class="head">
        <h1>{{ t().notifications.title }}</h1>
      </header>
      <div class="chips">
        <mat-chip-listbox [attr.aria-label]="t().common.filters" [value]="group()" (change)="groupChanged($event)">
          <mat-chip-option value="all">{{ t().common.all }}</mat-chip-option>
          <mat-chip-option value="security">{{ t().notifications.security }}</mat-chip-option>
          <mat-chip-option value="chat">{{ t().nav.chat }}</mat-chip-option>
          <mat-chip-option value="cases">{{ t().nav.cases }}</mat-chip-option>
          <mat-chip-option value="vouching">{{ t().nav.vouching }}</mat-chip-option>
        </mat-chip-listbox>
      </div>
      @if (error(); as text) {
        <p class="error note">{{ text }}</p>
      }
      @if (freshRows().length > 0) {
        <h2 class="part">{{ t().notifications.fresh }}</h2>
      }
      @for (n of freshRows(); track n.notificationNumber) {
        <ng-container *ngTemplateOutlet="row; context: { $implicit: n, fresh: true }" />
      }
      @if (freshRows().length > 0 && earlierRows().length > 0) {
        <h2 class="part">{{ t().notifications.earlier }}</h2>
      }
      @for (n of earlierRows(); track n.notificationNumber) {
        <ng-container *ngTemplateOutlet="row; context: { $implicit: n, fresh: isFresh(n) }" />
      }
      @if (freshRows().length === 0 && earlierRows().length === 0) {
        @if (reading() > 0) {
          <p class="muted note">{{ t().common.loading }}</p>
        } @else if (known()) {
          <p class="muted note">{{ group() === 'all' ? t().notifications.none : t().notifications.noneInGroup }}</p>
        }
      }
      @if (more()) {
        <div class="foot">
          <button mat-button type="button" (click)="older()" [disabled]="olderBusy()">{{ t().notifications.showOlder }}</button>
        </div>
      }
    </section>

    <ng-template #row let-n let-fresh="fresh">
      @if (linkOf(n.kind, n.referenceId); as link) {
        <a class="row" [class.fresh]="fresh" [routerLink]="link">
          <span class="disc" [class.alarm]="groupOf(n.kind) === 'security'"><mat-icon>{{ iconOf(n.kind) }}</mat-icon></span>
          <span class="texts">
            <span class="title">{{ label(n.kind) }}</span>
            <span class="when">{{ when(n.createdAt) }}</span>
          </span>
          @if (fresh) {
            <span class="dot"></span>
          }
        </a>
      } @else {
        <div class="row" [class.fresh]="fresh">
          <span class="disc" [class.alarm]="groupOf(n.kind) === 'security'"><mat-icon>{{ iconOf(n.kind) }}</mat-icon></span>
          <span class="texts">
            <span class="title">{{ label(n.kind) }}</span>
            <span class="when">{{ when(n.createdAt) }}</span>
          </span>
          @if (fresh) {
            <span class="dot"></span>
          }
        </div>
      }
    </ng-template>
  `,
  styles: `
    :host { display: block; max-width: 720px; margin: 0 auto; }
    .page { border: 1px solid var(--mat-sys-outline-variant); border-radius: 12px; overflow: hidden; background: var(--mat-sys-surface); }
    .head { padding: 12px 16px 4px; }
    h1 { font-size: 1.25rem; font-weight: 500; margin: 0; }
    .chips { display: flex; align-items: center; overflow-x: auto; padding: 4px 16px 8px; scrollbar-width: none; }
    .chips > * { flex: none; }
    .part { font-size: 13px; font-weight: 500; color: var(--mat-sys-on-surface-variant); margin: 0; padding: 12px 16px 4px; }
    .row { display: flex; align-items: flex-start; gap: 12px; padding: 10px 16px; color: inherit; text-decoration: none; }
    a.row:hover { background: var(--mat-sys-surface-container); }
    .disc { width: 40px; height: 40px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; background: var(--mat-sys-surface-container-high); color: var(--mat-sys-on-surface-variant); flex: none; }
    .disc.alarm { background: var(--mat-sys-error-container); color: var(--mat-sys-on-error-container); }
    .texts { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .title { overflow-wrap: break-word; }
    .when { font-size: 12px; color: var(--mat-sys-on-surface-variant); }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--mat-sys-primary); flex: none; margin-top: 6px; }
    .row.fresh .title { font-weight: 700; }
    .foot { display: flex; justify-content: center; padding: 4px 16px 8px; border-top: 1px solid var(--mat-sys-outline-variant); }
    .note { padding: 8px 16px 16px; margin: 0; }
    .muted { color: var(--mat-sys-on-surface-variant); }
    .error { color: var(--mat-sys-error); }
  `,
})
export class NotificationsPage {
  protected readonly session = inject(SessionService);
  private readonly api = inject(MasterpodApiService);
  private readonly chat = inject(ChatService);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  /** The filter that is on. */
  protected readonly group = signal<Group>('all');
  /** The dots: the ids of the rows that were unread when the page opened and of the rows that arrived while it was open. They keep their dot for this visit and are gone with the page. */
  private readonly fresh = signal<ReadonlySet<string>>(new Set());
  /** The rows of this page's reads for the filter that is on, the highest `seq` first: its first page, with every older page after it. Null until the first answer for that filter has come. */
  private readonly filterRows = signal<NotificationItem[] | null>(null);
  /** The last read for the filter that is on came back full, so older rows of that group may be left. */
  private readonly filterFull = signal(false);
  /** How many of this page's reads of a first page are on their way: the wallet's first page, in the first seconds after a login, or a filter's. */
  protected readonly reading = signal(0);
  /** The read of "Show older" is on its way: the button is off. */
  protected readonly olderBusy = signal(false);
  /** A read of this page that failed, as the red line. */
  protected readonly error = signal<string | null>(null);
  /** The taps on a filter and the reads of a filter's first page, counted, so that an answer which a later one overtook is dropped. */
  private reads = 0;
  /** A mark is on its way. */
  private marking = false;

  /**
   * The rows the page shows, the newest first. Under All: the list in
   * memory. Under a filter: the rows of this page's reads for that filter,
   * and on top of them the rows of the group that the list in memory holds
   * with a `seq` above the highest `seq` of those reads. Those are the rows
   * that the shell's poll has brought since. A row of the list in memory
   * that is at or below that number is on the filter's own list already,
   * or belongs below its first page, so it is not put on top. Until the
   * first answer for the filter has come, and when that answer held no
   * row, every row of the group that the list in memory holds is shown.
   */
  private readonly shown = computed(() => {
    const group = this.group();
    const list = this.session.notifications() ?? [];
    if (group === 'all') return list;
    const ofGroup = list.filter((n) => GROUPS[group].includes(n.kind));
    const rows = this.filterRows();
    if (rows === null || rows.length === 0) return ofGroup;
    const top = rows[0].seq ?? 0;
    return [...ofGroup.filter((n) => (n.seq ?? 0) > top), ...rows];
  });
  /** How many rows at the top of what is shown have a dot: they stand under "New". */
  private readonly top = computed(() => {
    const rows = this.shown();
    const fresh = this.fresh();
    let count = 0;
    while (count < rows.length && fresh.has(rows[count].notificationNumber)) count += 1;
    return count;
  });
  protected readonly freshRows = computed(() => this.shown().slice(0, this.top()));
  /** The rest, under "Earlier". */
  protected readonly earlierRows = computed(() => this.shown().slice(this.top()));
  /** Whether the page knows what there is to show: under All once the wallet has its list, under a filter once the masterpod has answered for that filter. Only then does a page with no row say that there is none. */
  protected readonly known = computed(() => (this.group() === 'all' ? this.session.notifications() !== null : this.filterRows() !== null));
  /** "Show older" stands while older rows are left: under All while the list in memory holds fewer rows than the pod has, under a filter while the last read for it came back full. */
  protected readonly more = computed(() => {
    if (this.group() !== 'all') return this.filterFull();
    const list = this.session.notifications();
    return list !== null && list.length < this.session.notificationsCount();
  });

  constructor() {
    if (this.session.notifications() === null) void this.readFirst();
    // The dots and the marking. Each time the list in memory or the unread
    // number changes while something is unread: the unread rows of the list
    // get their dot, and everything is marked read. That is the page's
    // opening, and a row that arrives while the page is open.
    effect(() => {
      const rows = this.session.notifications();
      if (rows === null || this.session.unread() === 0) return;
      untracked(() => {
        const unread = rows.filter((n) => !n.read).map((n) => n.notificationNumber);
        if (unread.some((id) => !this.fresh().has(id))) this.fresh.update((ids) => new Set([...ids, ...unread]));
        void this.mark();
      });
    });
    // When the wallet reads its first page again because it missed a row,
    // the page with a filter on reads that filter's first page again too.
    // A red line of a read that failed before goes with it: the list is
    // fresh.
    effect(() => {
      this.session.notificationPages();
      untracked(() => {
        this.error.set(null);
        void this.readFilter();
      });
    });
  }

  protected isFresh(n: NotificationItem): boolean {
    return this.fresh().has(n.notificationNumber);
  }

  /** A tap on a filter: the rows of this page's reads for the filter of before are gone, and the new filter's first page is read. A tap on the filter that is on takes it off in Material's list, which then names no filter: that is All, and All is set on in the list again, so a tap on All while it is on leaves it on. */
  protected groupChanged(event: MatChipListboxChange): void {
    const value = event.value as Group | undefined;
    this.group.set(value ?? 'all');
    if (value === undefined) event.source.value = 'all';
    this.filterRows.set(null);
    this.filterFull.set(false);
    this.error.set(null);
    void this.readFilter();
  }

  /** The first read of the notifications, by the page itself: only while the wallet has no list yet, in the first seconds after a login or a page load, before the shell's poll has made it. An answer that comes after the shell's is dropped, a refusal too: nobody waits for it then. */
  private async readFirst(): Promise<void> {
    this.reading.update((n) => n + 1);
    try {
      const res = await this.api.listNotifications({ limit: NOTIFICATIONS_PAGE }, true);
      if (this.session.notifications() !== null) return;
      if (!res.ok) this.error.set(`/list-notifications: ${reasonOf(res)}`);
      else if (this.session.hasSession()) this.session.putNotifications(res.body);
    } finally {
      this.reading.update((n) => n - 1);
    }
  }

  /** The first page of the filter that is on, from the masterpod: its newest 30 rows of the group's kinds. Nothing under All. It changes neither the list in memory nor its numbers. An answer that a later tap or a later read overtook is dropped. */
  private async readFilter(): Promise<void> {
    const read = ++this.reads;
    const group = this.group();
    if (group === 'all') return;
    this.reading.update((n) => n + 1);
    try {
      const res = await this.api.listNotifications({ limit: NOTIFICATIONS_PAGE, kinds: GROUPS[group] }, true);
      if (read !== this.reads) return;
      if (res.ok) {
        // A row above the list's `seq` was written after the shell's last read: it arrived while the page is open, and the shell's next read brings it. It has its dot at once.
        const seq = this.session.notificationsSeq;
        const arrived = seq === null ? [] : res.body.notifications.filter((n) => !n.read && (n.seq ?? 0) > seq).map((n) => n.notificationNumber);
        if (arrived.length > 0) this.fresh.update((ids) => new Set([...ids, ...arrived]));
        this.filterRows.set(res.body.notifications);
        this.filterFull.set(res.body.notifications.length >= NOTIFICATIONS_PAGE);
        this.error.set(null);
      } else {
        this.error.set(`/list-notifications: ${reasonOf(res)}`);
      }
    } finally {
      this.reading.update((n) => n - 1);
    }
  }

  /**
   * "Show older": the next 30 rows below the lowest `seq` the page shows,
   * of the group's kinds under a filter. Under All they go to the end of
   * the list in memory, under a filter to the end of that filter's rows.
   * The answer is put in only while the row it was asked below is still
   * the lowest one, so an answer for a list that was read anew meanwhile,
   * or for another filter, is dropped. Under All its rows are put in as
   * read: an older row that was still unread was marked with the rest when
   * the page opened, or is marked now, so it has no dot. It changes neither
   * the list's `seq` nor its count.
   */
  protected async older(): Promise<void> {
    const group = this.group();
    const before = this.shown().at(-1)?.seq;
    if (this.olderBusy() || before === undefined) return;
    this.olderBusy.set(true);
    this.error.set(null);
    try {
      const res = await this.api.listNotifications(group === 'all' ? { limit: NOTIFICATIONS_PAGE, before } : { limit: NOTIFICATIONS_PAGE, before, kinds: GROUPS[group] }, true);
      if (!res.ok) {
        if (this.group() === group) this.error.set(`/list-notifications: ${reasonOf(res)}`);
        return;
      }
      const rows = res.body.notifications;
      if (group === 'all') {
        const list = this.session.notifications();
        if (list !== null && list.at(-1)?.seq === before) this.session.notifications.set([...list, ...rows.map((n) => (n.read ? n : { ...n, read: true }))]);
      } else if (this.group() === group && this.filterRows()?.at(-1)?.seq === before) {
        this.filterRows.update((held) => [...(held ?? []), ...rows]);
        this.filterFull.set(rows.length >= NOTIFICATIONS_PAGE);
      }
    } finally {
      this.olderBusy.set(false);
    }
  }

  /** Marks everything read: /mark-notifications-read with `upTo`, the list's `seq`. Nothing is sent while the unread number is 0, while the list has no `seq` (a masterpod of before) or while a mark is on its way. After the answer every row of the list up to that number is read. A mark that fails changes nothing: the number stays, and the next change of the list sends it again. */
  private async mark(): Promise<void> {
    const upTo = this.session.notificationsSeq;
    if (this.marking || upTo === null || this.session.unread() === 0) return;
    const me = this.session.anopodId();
    this.marking = true;
    try {
      const res = await this.api.markNotificationsRead(upTo);
      if (res.ok && this.session.anopodId() === me) this.session.putNotificationsRead(upTo);
    } finally {
      this.marking = false;
    }
  }

  /** The group of a kind, null for a kind the wallet does not know. */
  protected groupOf(kind: string): Exclude<Group, 'all'> | null {
    for (const group of Object.keys(GROUPS) as Exclude<Group, 'all'>[]) if (GROUPS[group].includes(kind)) return group;
    return null;
  }

  /** The icon of a row: its group's, and a bell for a kind the wallet does not know. */
  protected iconOf(kind: string): string {
    const group = this.groupOf(kind);
    return group ? ICONS[group] : 'notifications';
  }

  /** The kinds of the masterpod spec section 6 and the five case kinds of 13.7, in words, from the dictionary; a kind it does not know shows as it is. */
  protected label(kind: string): string {
    return this.t().notifications.labels[kind] ?? kind;
  }

  /** The time under a sentence (2026-11-25): "Just now" in the first minute, then "5 min ago", then "3 h ago" up to 24 hours, and after that as the chat list words a day: "Yesterday", the weekday within six days, else the date. It reads the clock's minute (session.minute), so the words are drawn again each minute and at midnight. */
  protected when(iso: string): string {
    this.session.minute();
    const words = this.t().notifications;
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60_000) return words.justNow;
    if (ms < 3_600_000) return words.minutesAgo(Math.floor(ms / 60_000));
    if (ms < 86_400_000) return words.hoursAgo(Math.floor(ms / 3_600_000));
    return this.chat.shortWhen(iso);
  }

  /** Where a row leads: a case kind to the case; recoveryCaseScheduled to the person's recovery case, the reference being the case's id (2026-11-12); passkeyAdded to the Passkeys page (2026-11-18; the reference is the new passkey's id, which the link does not use); transferWaiting to the page of the account the transfer waits in, the reference being that account's id, and alertSettingsChanged to the Security alerts page, whose reference, the anoPod's own id, the link does not use (2026-11-21); chatInvite and joinRequest to the chat requests; inviteAccepted, inviteDeclined and joinApproved to the room, the reference being its id; vouchRequest to the Vouch requests page (2026-11-25); null for the other six kinds: vouchApproved, vouchDeclined, vouched, joinDeclined, recoveryMoveWaiting and recoveryCaseOpened. Since 2026-11-25 the whole row is the link, where it was the sentence alone. */
  protected linkOf(kind: string, referenceId: string): string[] | null {
    if (CASE_KINDS.includes(kind)) return ['/cases', referenceId];
    if (kind === 'recoveryCaseScheduled') return ['/cases/recovery', referenceId];
    if (kind === 'passkeyAdded') return ['/account/passkeys'];
    if (kind === 'transferWaiting') return ['/wallet', referenceId];
    if (kind === 'alertSettingsChanged') return ['/account/alerts'];
    if (kind === 'chatInvite' || kind === 'joinRequest') return ['/chat/requests'];
    if (kind === 'inviteAccepted' || kind === 'inviteDeclined' || kind === 'joinApproved') return ['/chat', referenceId];
    if (kind === 'vouchRequest') return ['/seed'];
    return null;
  }
}
