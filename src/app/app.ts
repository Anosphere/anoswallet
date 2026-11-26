import { BreakpointObserver, Breakpoints } from '@angular/cdk/layout';
import { Component, DestroyRef, ElementRef, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatToolbarModule } from '@angular/material/toolbar';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { map } from 'rxjs';
import { askConfirm } from './components/confirm-dialog.component';
import { NOTIFICATIONS_PAGE, NOTIFICATIONS_POLL_MS } from './constants';
import { ChatService } from './services/chat.service';
import { ConfigService } from './services/config.service';
import { LanguageService } from './services/language.service';
import { ApiError, ApiResponse } from './services/log.service';
import { MasterpodApiService, RoomsAnswer } from './services/masterpod-api.service';
import { NavigationService } from './services/navigation.service';
import { SessionService } from './services/session.service';
import { SoundService } from './services/sound.service';
import { UpdateService } from './services/update.service';

/** The three answers of the masterpod's session check (masterpod spec 3) that say this page's login has ended: the hours of a login are over, or a recovery ended it; a newer login of the same anoPod took its place; the anoPod is gone. */
const LOGIN_ENDED = new Set(['session expired', 'bad signature', 'unknown anopod']);

/** True when the masterpod refused a plain read of the shell's poll with one of those three. A wrong clock, a masterpod that is down and a phone with no connection answer otherwise and are passed over, as before. */
function loginEnded(res: ApiResponse<unknown>): boolean {
  const reason = (res.body as Partial<ApiError> | null)?.error;
  return !res.ok && res.status === 401 && typeof reason === 'string' && LOGIN_ENDED.has(reason);
}

/**
 * The shell (wallet spec 8 and 8.1): a toolbar and a side navigation on a
 * desktop, the navigation collapsing behind a menu button on a phone. The
 * navigation's list lives in navigation.service.ts, shared with the Home
 * tiles: Home is first once setup is complete, and which pages show
 * follows the status (vouching until vouched; identity and setup until
 * setup is complete; home, wallet, chat, marketplace and account once it
 * is, and Cases with them, wallet spec 13.1; seed when the pod is a seed;
 * Moderation in the moderator edition, wallet spec 12.1, which also names
 * the app "Moderator" in the toolbar; Attesting in the attestor edition,
 * wallet spec 13.1, named "Attestor"). The toolbar's name is a link to
 * Home once setup is complete. Since 2026-11-24 it is one short word in
 * bold letters of 18 px ("anoPod" in the wallet edition; the word
 * "wallet" went out of all three names), and the username beside it ends
 * in "…" when the top bar has no room for all of it, so the bar is never
 * wider than a phone's screen. The toolbar's words come from
 * the dictionary (wallet spec 8.8), and the language service is created
 * here, so the page's `lang` attribute follows the language from the
 * start. Since 2026-11-19 the shell also rings the wallet's one sound
 * (sound.service.ts; wallet spec 8.1): its 5-second poll plays it once
 * when the room list holds a new message from someone else, unless that
 * conversation is the page on the screen, or a new invite or join
 * request. Since 2026-11-22 (wallet spec 8.1; the plan is
 * forclaude/wallet-refresh-plan-1.md) the shell also shows the
 * Update button in the top bar while the wallet's server has a newer
 * build (update.service.ts), tells a person whose login has ended, with
 * the box "You are logged out", and loads the page again after that box,
 * after the Update button and after Lock, under the words "Refreshing…".
 */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, MatToolbarModule, MatSidenavModule, MatListModule, MatIconModule, MatButtonModule],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly session = inject(SessionService);
  protected readonly config = inject(ConfigService);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;
  private readonly router = inject(Router);
  private readonly api = inject(MasterpodApiService);
  private readonly chat = inject(ChatService);
  private readonly navigation = inject(NavigationService);
  private readonly sound = inject(SoundService);
  private readonly dialog = inject(MatDialog);
  protected readonly update = inject(UpdateService);

  /** True on a narrow screen: the navigation hides behind the menu button. */
  protected readonly handset = toSignal(
    inject(BreakpointObserver).observe([Breakpoints.Handset]).pipe(map((state) => state.matches)),
    { initialValue: false },
  );
  protected readonly menuOpen = signal(false);

  protected readonly navItems = this.navigation.items;

  constructor() {
    void this.config.load().catch(() => undefined);
    // The notification poll (wallet spec 8.2): while a session is open, the
    // notifications and the status (vouched, the counts) every 5 seconds,
    // and the chat rooms with them once setup is complete (8.2, Chat). Since
    // 2026-11-24 the read of the chat rooms asks only for what is new and
    // puts it into the list in memory (chat.service's refreshNews; 4.17).
    // Since 2026-11-25 the read of the notifications asks only for what is
    // new too (readNotifications, below; 4.22).
    // The poll also rings: after that read the list goes to ring(), which
    // plays the wallet's sound for what is new in it (8.1).
    const timer = setInterval(() => void this.poll(), NOTIFICATIONS_POLL_MS);
    // Back at the front, the poll runs at once (2026-11-22): a phone freezes
    // the timer while another app is in front, and a login that ended
    // meanwhile shows its box without the wait.
    const front = () => {
      if (document.visibilityState === 'visible') void this.poll();
    };
    document.addEventListener('visibilitychange', front);
    // A way around a fault of Chrome's app window on Android (the wallet
    // opened from its Home screen icon; 2026-11-22, wallet spec 8.1): a page
    // that is loaded again inside that window is told, for its first
    // moments, a screen 56 pixels higher than the one it has, and the shell
    // keeps the height its style sheet gave it then. The same height written
    // onto the shell itself is worked out anew. Looked at three times after
    // the start; nothing is written while the shell fits the window.
    const shell = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const settle = () => {
      if (shell.offsetHeight <= window.innerHeight) return;
      shell.style.height = '';
      shell.style.height = '100dvh';
    };
    const settles = [300, 1000, 3000].map((ms) => setTimeout(settle, ms));
    inject(DestroyRef).onDestroy(() => {
      clearInterval(timer);
      settles.forEach(clearTimeout);
      document.removeEventListener('visibilitychange', front);
    });
  }

  private polling = false;
  /** What the shell has rung for already, for the pod of this session: the position of each room's newest message (since 2026-11-24; until then the room's highest position, which an edit or a delete of a message raises too), and the ids of the invites and join requests. Null with no session, and until the first answer of one. */
  private heard: { anopodId: string; positions: Map<string, number>; requests: Set<string> } | null = null;

  private async poll(): Promise<void> {
    if (!this.session.hasSession()) {
      this.heard = null;
      return;
    }
    if (this.polling) return;
    this.polling = true;
    try {
      const [, status, rooms] = await Promise.all([
        this.readNotifications(),
        this.api.checkAnopodStatus(true),
        this.session.setupComplete() ? this.chat.refreshNews() : Promise.resolve(null),
      ]);
      if (!this.session.hasSession()) return;
      if (loginEnded(status)) {
        await this.loggedOut();
        return;
      }
      if (status.ok) this.session.status.set(status.body);
      // The read of the chat rooms has put its answer into the list in memory already (refreshNews): the sound is given that list as it stands now.
      const list = rooms?.ok ? this.session.chatRooms() : null;
      if (list) this.ring(list);
    } finally {
      this.polling = false;
    }
  }

  /**
   * The poll's read of the notifications (2026-11-25; wallet spec 4.22; the
   * plan is forclaude/notifications-page-plan-1.md). Until then every read
   * got the newest 100 whole and put them in the place of the list. Now the
   * first read after a login or a page load asks for the newest 30, and its
   * answer is the list in memory. Every later read sends the list's `seq`
   * as `since` and gets only the rows above it, which go on top of the
   * list; when none came, the list is not set anew. Before the rows are
   * put in, the wallet compares. When the answer's `count` is not the count
   * the wallet had plus the rows that came, it missed a row; when the
   * answer's `seq` is below the `since` that was sent, the masterpod's
   * database was put back from a backup. In both cases the first page is
   * read again, once, and takes the list's place; if that read fails, the
   * list stays as it was and the next read finds the same thing again. An
   * answer without `seq`, from a masterpod of before, is taken as the first
   * page, and the next read asks for the first page again. An answer is
   * dropped, and the next read brings what it held, in two cases: when the
   * list's `seq` is no longer the one this read was asked with, and when
   * the answer of a mark came meanwhile (the Notifications page marks),
   * since such an answer can carry the rows and the number of before the
   * mark. A read that is refused or not answered changes nothing. Every
   * call also looks at the clock, for the Notifications page's words that
   * depend on the time (session.minute).
   */
  private async readNotifications(): Promise<void> {
    this.session.minute.set(Math.floor(Date.now() / 60_000));
    const since = this.session.notificationsSeq;
    const marks = this.session.notificationMarks;
    const stillAsked = () => this.session.hasSession() && this.session.notificationsSeq === since && this.session.notificationMarks === marks;
    const res = await this.api.listNotifications(since === null ? { limit: NOTIFICATIONS_PAGE } : { since }, true);
    if (!res.ok || !stillAsked()) return;
    const { notifications, seq, count, unread } = res.body;
    if (since === null || typeof seq !== 'number' || typeof count !== 'number' || typeof unread !== 'number') {
      this.session.putNotifications(res.body);
      return;
    }
    if (count === this.session.notificationsCount() + notifications.length && seq >= since) {
      this.session.putNewNotifications(notifications, seq, count, unread);
      return;
    }
    const page = await this.api.listNotifications({ limit: NOTIFICATIONS_PAGE }, true);
    if (page.ok && stillAsked()) this.session.putNotifications(page.body);
  }

  /**
   * The sound (2026-11-19, wallet spec 8.1): one chime when the chat list
   * holds something new since the shell's read before. New is: a newest
   * message by someone else in a room the shell already knew, unless that
   * conversation is the page on the screen; or an invite or a join request
   * it did not know. The first read of a session rings for nothing, and so
   * does a room that is new to the list. Until 2026-11-24 the list was the
   * answer of /list-chat-rooms itself; since then it is the list in
   * memory, after the read's answer was put into it (4.17). Since
   * 2026-11-24, too (forclaude/chat-edit-delete-plan-1.md; 4.19), a room
   * counts as new by the position of its newest message
   * (`lastMessage.position`), where it was the room's highest position
   * (`lastPosition`): an edit or a delete of a message raises the highest
   * position and leaves the newest message's own, so it rings nothing.
   */
  private ring(list: RoomsAnswer): void {
    const me = this.session.anopodId();
    if (me === null) return;
    const before = this.heard !== null && this.heard.anopodId === me ? this.heard : null;
    const onScreen = document.visibilityState === 'visible' ? this.router.url : '';
    const positions = new Map<string, number>();
    const requests = new Set<string>();
    let news = false;
    for (const room of list.rooms) {
      const position = room.lastMessage?.position ?? 0;
      positions.set(room.chatRoomId, position);
      const known = before?.positions.get(room.chatRoomId);
      if (known === undefined || room.lastMessage === null || position <= known) continue;
      if (room.lastMessage.senderAnopodId !== me && onScreen !== `/chat/${room.chatRoomId}`) news = true;
    }
    for (const id of [...list.invites.map((i) => i.inviteId), ...list.joinRequests.map((r) => r.joinRequestId)]) {
      requests.add(id);
      if (before !== null && !before.requests.has(id)) news = true;
    }
    this.heard = { anopodId: me, positions, requests };
    if (news) this.sound.chime();
  }

  protected navigated(): void {
    if (this.handset()) this.menuOpen.set(false);
  }

  /**
   * The login has ended (2026-11-22, wallet spec 8.1): the masterpod no
   * longer takes this page's session keys. The status is asked once more
   * first, so that a read which was on its way while this tab logged in
   * anew (Setup, the finish of a recovery) is not taken for the end. Then
   * the box "You are logged out", with one button; whatever closes it, the
   * wallet locks and loads its page again. The poll waits meanwhile.
   */
  private async loggedOut(): Promise<void> {
    const again = await this.api.checkAnopodStatus(true);
    if (!this.session.hasSession() || !loginEnded(again)) return;
    const words = this.t().shell;
    await askConfirm(this.dialog, { title: words.loggedOutTitle, lines: [], notes: [words.loggedOutText], confirmLabel: words.ok, single: true });
    await this.lock();
  }

  /** Lock: the session's keys are dropped and the first page shows, as before; since 2026-11-22 the page is then loaded again from the server (update.service.ts), which empties the page's whole memory and brings the newest build. Without a connection the wallet stays locked on the first page it shows. */
  protected async lock(): Promise<void> {
    await this.toFirstPage();
    await this.update.refresh();
  }

  /** The Update button (2026-11-22): the page is loaded again from the server. A session ends with it, but only once the server has answered: with no connection the tap changes nothing. The load always starts from the first page, so the wallet comes back on it whatever page the button was tapped on. */
  protected updateNow(): void {
    void this.update.refresh(() => this.toFirstPage());
  }

  /** Drops the session, if one is open, and shows the first page inside the app. */
  private toFirstPage(): Promise<boolean> {
    this.session.close();
    return this.router.navigateByUrl('/');
  }
}
