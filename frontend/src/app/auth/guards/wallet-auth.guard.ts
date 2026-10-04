import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../auth.service';

/** Blocks navigation to routes that require a connected wallet + signed-in
 *  session (see AuthService.sessionReady), redirecting to /auth with the
 *  attempted URL preserved as ?returnUrl= so sign-in can send the user back. */
export const walletAuthGuard: CanActivateFn = (_route, state) => {
  const authService = inject(AuthService);
  const router = inject(Router);

  if (authService.isAuthenticated()) return true;

  return router.createUrlTree(['/auth'], { queryParams: { returnUrl: state.url } });
};
