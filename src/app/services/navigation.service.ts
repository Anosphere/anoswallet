import { Injectable, computed, inject } from '@angular/core';
import { ConfigService } from './config.service';
import { LanguageService } from './language.service';
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
 * setup is complete; Home first, then wallet, cases, chat, marketplace, DAO
 * and account once it is; Moderation in the moderator edition and Attesting in
 * the attestor edition (wallet spec 12.1, 13.1); Notifications; Vouch
 * requests when the pod is a seed; Log. The labels come from the
 * dictionary, so the side panel and the Home tiles follow the language
 * (wallet spec 8.8).
 */
@Injectable({ providedIn: 'root' })
export class NavigationService {
  private readonly session = inject(SessionService);
  private readonly config = inject(ConfigService);
  private readonly lang = inject(LanguageService);

  readonly items = computed<NavItem[]>(() => {
    const nav = this.lang.words().nav;
    const status = this.session.status();
    if (!this.session.hasSession()) return [];
    const items: NavItem[] = [];
    if (!status?.vouched) items.push({ path: '/vouching', label: nav.vouching, icon: 'how_to_reg' });
    if (!status?.setupComplete) {
      items.push({ path: '/identity', label: nav.identity, icon: 'badge' }, { path: '/setup', label: nav.setup, icon: 'key' });
    } else {
      items.push(
        { path: '/home', label: nav.home, icon: 'home' },
        { path: '/wallet', label: nav.wallet, icon: 'account_balance_wallet' },
        { path: '/cases', label: nav.cases, icon: 'folder_shared' },
        { path: '/chat', label: nav.chat, icon: 'chat', badge: this.session.unreadRoomCount() },
        { path: '/marketplace', label: nav.marketplace, icon: 'storefront' },
        { path: '/dao', label: nav.dao, icon: 'how_to_vote' },
        { path: '/account', label: nav.account, icon: 'manage_accounts' },
      );
    }
    if (this.config.moderatorEdition()) items.push({ path: '/moderation', label: nav.moderation, icon: 'gavel' });
    if (this.config.attestorEdition()) items.push({ path: '/attesting', label: nav.attesting, icon: 'fact_check' });
    items.push({ path: '/notifications', label: nav.notifications, icon: 'notifications', badge: this.session.unread().length });
    if (status?.isSeed || status?.isSuperSeed) items.push({ path: '/seed', label: nav.vouchRequests, icon: 'verified_user' });
    items.push({ path: '/log', label: nav.log, icon: 'receipt_long' });
    return items;
  });
}
