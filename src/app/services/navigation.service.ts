import { Injectable, computed, inject } from '@angular/core';
import { ConfigService } from './config.service';
import { SessionService } from './session.service';

/** One entry of the side navigation and one Home tile; `badge` is a count drawn at its right (Chat: the unread rooms; Notifications: the unread notifications; wallet spec 8.2). */
export interface NavItem {
  path: string;
  label: string;
  icon: string;
  badge?: number;
}

/**
 * The navigation (wallet spec 8.1): the one list the side panel and the
 * Home tiles both draw, so they cannot drift apart. Which entries it holds
 * follows the status: vouching until vouched; identity and setup until
 * setup is complete; Home first, then wallet, cases, chat, marketplace and
 * account once it is; Moderation in the moderator edition and Attesting in
 * the attestor edition (wallet spec 12.1, 13.1); Notifications; Vouch
 * requests when the pod is a seed; Log.
 */
@Injectable({ providedIn: 'root' })
export class NavigationService {
  private readonly session = inject(SessionService);
  private readonly config = inject(ConfigService);

  readonly items = computed<NavItem[]>(() => {
    const status = this.session.status();
    if (!this.session.hasSession()) return [];
    const items: NavItem[] = [];
    if (!status?.vouched) items.push({ path: '/vouching', label: 'Vouching', icon: 'how_to_reg' });
    if (!status?.setupComplete) {
      items.push({ path: '/identity', label: 'Identity', icon: 'badge' }, { path: '/setup', label: 'Setup', icon: 'key' });
    } else {
      items.push(
        { path: '/home', label: 'Home', icon: 'home' },
        { path: '/wallet', label: 'Wallet', icon: 'account_balance_wallet' },
        { path: '/cases', label: 'Cases', icon: 'folder_shared' },
        { path: '/chat', label: 'Chat', icon: 'chat', badge: this.session.unreadRoomCount() },
        { path: '/marketplace', label: 'Marketplace', icon: 'storefront' },
        { path: '/account', label: 'Account', icon: 'manage_accounts' },
      );
    }
    if (this.config.moderatorEdition()) items.push({ path: '/moderation', label: 'Moderation', icon: 'gavel' });
    if (this.config.attestorEdition()) items.push({ path: '/attesting', label: 'Attesting', icon: 'fact_check' });
    items.push({ path: '/notifications', label: 'Notifications', icon: 'notifications', badge: this.session.unread().length });
    if (status?.isSeed || status?.isSuperSeed) items.push({ path: '/seed', label: 'Vouch requests', icon: 'verified_user' });
    items.push({ path: '/log', label: 'Log', icon: 'receipt_long' });
    return items;
  });
}
