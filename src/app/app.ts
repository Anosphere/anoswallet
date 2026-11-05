import { BreakpointObserver, Breakpoints } from '@angular/cdk/layout';
import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
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
import { MasterpodApiService } from './services/masterpod-api.service';
import { SessionService } from './services/session.service';

/** One entry of the side navigation. */
interface NavItem {
  path: string;
  label: string;
  icon: string;
}

/**
 * The shell (wallet spec 8 and 8.1): a toolbar and a side navigation on a
 * desktop, the navigation collapsing behind a menu button on a phone. Which
 * pages the navigation shows follows the status: vouching until vouched;
 * identity and setup until setup is complete; wallet, chat, marketplace and
 * account once it is, and Cases with them (wallet spec 13.1); seed when
 * the pod is a seed; Moderation in the moderator edition (wallet spec 12.1),
 * which also names the app "Moderator wallet" in the toolbar; Attesting in
 * the attestor edition (wallet spec 13.1), named "Attestor wallet".
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
  private readonly router = inject(Router);
  private readonly api = inject(MasterpodApiService);

  /** True on a narrow screen: the navigation hides behind the menu button. */
  protected readonly handset = toSignal(
    inject(BreakpointObserver).observe([Breakpoints.Handset]).pipe(map((state) => state.matches)),
    { initialValue: false },
  );
  protected readonly menuOpen = signal(false);

  protected readonly navItems = computed<NavItem[]>(() => {
    const status = this.session.status();
    if (!this.session.hasSession()) return [];
    const items: NavItem[] = [];
    if (!status?.vouched) items.push({ path: '/vouching', label: 'Vouching', icon: 'how_to_reg' });
    if (!status?.setupComplete) {
      items.push({ path: '/identity', label: 'Identity', icon: 'badge' }, { path: '/setup', label: 'Setup', icon: 'key' });
    } else {
      items.push(
        { path: '/wallet', label: 'Wallet', icon: 'account_balance_wallet' },
        { path: '/cases', label: 'Cases', icon: 'folder_shared' },
        { path: '/chat', label: 'Chat', icon: 'chat' },
        { path: '/marketplace', label: 'Marketplace', icon: 'storefront' },
        { path: '/account', label: 'Account', icon: 'manage_accounts' },
      );
    }
    if (this.config.moderatorEdition()) items.push({ path: '/moderation', label: 'Moderation', icon: 'gavel' });
    if (this.config.attestorEdition()) items.push({ path: '/attesting', label: 'Attesting', icon: 'fact_check' });
    items.push({ path: '/notifications', label: 'Notifications', icon: 'notifications' });
    if (status?.isSeed || status?.isSuperSeed) items.push({ path: '/seed', label: 'Vouch requests', icon: 'verified_user' });
    items.push({ path: '/log', label: 'Log', icon: 'receipt_long' });
    return items;
  });

  constructor() {
    void this.config.load().catch(() => undefined);
    // The notification poll (wallet spec 8.2): while a session is open, the
    // notifications and the status (vouched, the counts) every 5 seconds.
    const timer = setInterval(() => void this.poll(), NOTIFICATIONS_POLL_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  private polling = false;

  private async poll(): Promise<void> {
    if (!this.session.hasSession() || this.polling) return;
    this.polling = true;
    try {
      const [notifications, status] = await Promise.all([this.api.listNotifications(false, true), this.api.checkAnopodStatus(true)]);
      if (!this.session.hasSession()) return;
      if (notifications.ok) this.session.notifications.set(notifications.body.notifications);
      if (status.ok) this.session.status.set(status.body);
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
