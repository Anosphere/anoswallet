import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { SessionService } from './services/session.service';

/** Sends anyone without a session to the landing page (wallet spec 8.1). */
export const sessionGuard: CanActivateFn = () => {
  const session = inject(SessionService);
  return session.hasSession() ? true : inject(Router).createUrlTree(['/']);
};
