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
import { MasterpodApiService } from './services/masterpod-api.service';
import { NavigationService } from './services/navigation.service';
import { SessionService } from './services/session.service';

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
 * start.
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
    // and the chat rooms with them once setup is complete (8.2, Chat).
    const timer = setInterval(() => void this.poll(), NOTIFICATIONS_POLL_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  private polling = false;

  private async poll(): Promise<void> {
    if (!this.session.hasSession() || this.polling) return;
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
    } finally {
      this.polling = false;
    }
  }

  protected navigated(): void {
    if (this.handset()) this.menuOpen.set(false);
  }

  protected lock(): void {
    this.session.close();
    void this.router.navigateByUrl('/');
  }
}
