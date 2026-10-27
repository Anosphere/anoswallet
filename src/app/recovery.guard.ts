import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { RecoveryService } from './services/recovery.service';

/** Sends anyone without a recovery session to /recover (wallet spec 12.2). */
export const recoveryGuard: CanActivateFn = () => {
  const recovery = inject(RecoveryService);
  return recovery.hasSession() ? true : inject(Router).createUrlTree(['/recover']);
};
