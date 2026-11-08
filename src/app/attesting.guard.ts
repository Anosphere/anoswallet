import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { ConfigService } from './services/config.service';
import { SessionService } from './services/session.service';

/**
 * The four Attesting pages need a session and the attestor edition (wallet
 * spec 13.2, the shape of moderationGuard): anyone without a session goes
 * to the landing page, as sessionGuard sends them; a session in another
 * edition goes there too. Whether the pod is an attestor is the masterpod's
 * call, shown on the page.
 */
export const attestingGuard: CanActivateFn = async () => {
  const session = inject(SessionService);
  const config = inject(ConfigService);
  const router = inject(Router);
  if (!session.hasSession()) return router.createUrlTree(['/']);
  const { edition } = await config.load().catch(() => ({ edition: 'wallet' }));
  return edition === 'attestor' ? true : router.createUrlTree(['/']);
};
