import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { ConfigService } from './services/config.service';
import { SessionService } from './services/session.service';

/**
 * The two Moderation pages need a session and the moderator edition (wallet
 * spec 12.2): anyone without a session goes to the landing page, as
 * sessionGuard sends them; a session in the wallet edition goes there too.
 * Whether the pod is a moderator is the masterpod's call, shown on the page.
 */
export const moderationGuard: CanActivateFn = async () => {
  const session = inject(SessionService);
  const config = inject(ConfigService);
  const router = inject(Router);
  if (!session.hasSession()) return router.createUrlTree(['/']);
  const { edition } = await config.load().catch(() => ({ edition: 'wallet' }));
  return edition === 'moderator' ? true : router.createUrlTree(['/']);
};
