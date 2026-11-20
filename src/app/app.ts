import { BreakpointObserver, Breakpoints } from '@angular/cdk/layout';
import { Component, DestroyRef, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatToolbarModule } from '@angular/material/toolbar';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { map } from 'rxjs';
import { NOTIFICATIONS_POLL_MS } from './constants';
import { ConfigService } from './services/config.service';
import { LanguageService } from './services/language.service';
import { MasterpodApiService, RoomsAnswer } from './services/masterpod-api.service';
import { NavigationService } from './services/navigation.service';
import { SessionService } from './services/session.service';
import { SoundService } from './services/sound.service';

/**
 * The shell (wallet spec 8 and 8.1): a toolbar and a side navigation on a
 * desktop, the navigation collapsing behind a menu button on a phone. The
 * navigation's list lives in navigation.service.ts, shared with the Home
 * tiles: Home is first once setup is complete, and which pages show
 * follows the status (vouching until vouched; identity and setup until
 * setup is complete; home, wallet, chat, marketplace and account once it
 * is, and Cases with them, wallet spec 13.1; seed when the pod is a seed;
 * Moderation in the moderator edition, wallet spec 12.1, which also names
 * the app "Moderator wallet" in the toolbar; Attesting in the attestor
 * edition, wallet spec 13.1, named "Attestor wallet"). The toolbar's name
 * is a link to Home once setup is complete. The toolbar's words come from
 * the dictionary (wallet spec 8.8), and the language service is created
 * here, so the page's `lang` attribute follows the language from the
 * start. Since 2026-11-19 the shell also rings the wallet's one sound
 * (sound.service.ts; wallet spec 8.1): its 5-second poll plays it once
 * when the room list holds a new message from someone else, unless that
 * conversation is the page on the screen, or a new invite or join
 * request.
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
  private readonly navigation = inject(NavigationService);
  private readonly sound = inject(SoundService);

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
    // and the chat rooms with them once setup is complete (8.2, Chat). The
    // poll also rings: the answer with the chat rooms goes to ring(), which
    // plays the wallet's sound for what is new in it (8.1).
    const timer = setInterval(() => void this.poll(), NOTIFICATIONS_POLL_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  private polling = false;
  /** What the shell has rung for already, for the pod of this session: each room's newest position, and the ids of the invites and join requests. Null with no session, and until the first answer of one. */
  private heard: { anopodId: string; positions: Map<string, number>; requests: Set<string> } | null = null;

  private async poll(): Promise<void> {
    if (!this.session.hasSession()) {
      this.heard = null;
      return;
    }
    if (this.polling) return;
    this.polling = true;
    try {
      const [notifications, status, rooms] = await Promise.all([
        this.api.listNotifications(false, true),
        this.api.checkAnopodStatus(true),
        this.session.setupComplete() ? this.api.listChatRooms(true) : Promise.resolve(null),
      ]);
      if (!this.session.hasSession()) return;
      if (notifications.ok) this.session.notifications.set(notifications.body.notifications);
      if (status.ok) this.session.status.set(status.body);
      if (rooms?.ok) this.session.chatRooms.set(rooms.body);
      if (rooms?.ok) this.ring(rooms.body);
    } finally {
      this.polling = false;
    }
  }

  /**
   * The sound (2026-11-19, wallet spec 8.1): one chime when this answer of
   * /list-chat-rooms holds something new since the one before. New is: a
   * newest message by someone else in a room the shell already knew,
   * unless that conversation is the page on the screen; or an invite or
   * a join request it did not know. The first answer of a session rings
   * for nothing, and so does a room that is new to the list.
   */
  private ring(answer: RoomsAnswer): void {
    const me = this.session.anopodId();
    if (me === null) return;
    const before = this.heard !== null && this.heard.anopodId === me ? this.heard : null;
    const onScreen = document.visibilityState === 'visible' ? this.router.url : '';
    const positions = new Map<string, number>();
    const requests = new Set<string>();
    let news = false;
    for (const room of answer.rooms) {
      positions.set(room.chatRoomId, room.lastPosition);
      const known = before?.positions.get(room.chatRoomId);
      if (known === undefined || room.lastMessage === null || room.lastPosition <= known) continue;
      if (room.lastMessage.senderAnopodId !== me && onScreen !== `/chat/${room.chatRoomId}`) news = true;
    }
    for (const id of [...answer.invites.map((i) => i.inviteId), ...answer.joinRequests.map((r) => r.joinRequestId)]) {
      requests.add(id);
      if (before !== null && !before.requests.has(id)) news = true;
    }
    this.heard = { anopodId: me, positions, requests };
    if (news) this.sound.chime();
  }

  protected navigated(): void {
    if (this.handset()) this.menuOpen.set(false);
  }

  protected lock(): void {
    this.session.close();
    void this.router.navigateByUrl('/');
  }
}
