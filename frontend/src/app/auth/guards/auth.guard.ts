import { inject } from '@angular/core';
import { CanActivateFn, Router, UrlTree } from '@angular/router';
import { WalletService } from '../wallet.service';
import { AuthService } from '../auth.service';
import { AdminAccessService } from '../../shared/services/admin-access.service';

/** Query param carrying the route to return to after a successful sign-in. */
export const RETURN_URL_PARAM = 'returnUrl';

/** Query param naming why access was refused, so /auth can explain itself. */
export const AUTH_REASON_PARAM = 'reason';

export type AuthDenialReason = 'wallet' | 'session' | 'admin';

function redirectToAuth(router: Router, returnUrl: string, reason: AuthDenialReason): UrlTree {
  return router.createUrlTree(['/auth'], {
    queryParams: { [RETURN_URL_PARAM]: returnUrl, [AUTH_REASON_PARAM]: reason },
  });
}

/**
 * Gate for private flows (issue #168).
 *
 * The API guards these flows with `JwtAuthGuard` (+ `KycGuard`), so reaching
 * them without a connected wallet and a verified session only ever produces
 * empty states and 401s. Anonymous visitors are sent to /auth with the route
 * they wanted, and land back on it once signed in.
 */
export const authGuard: CanActivateFn = (_route, state) => {
  const router = inject(Router);
  const wallet = inject(WalletService);
  const auth = inject(AuthService);

  if (!wallet.isConnected()) {
    return redirectToAuth(router, state.url, 'wallet');
  }
  if (!auth.isAuthenticated()) {
    return redirectToAuth(router, state.url, 'session');
  }
  return true;
};

/**
 * Gate for admin-only flows (bond issuance, coupon distribution, sweeps).
 *
 * Mirrors the API's `AdminGuard`, which only accepts the wallet matching
 * `STELLAR_PUBLIC_KEY`. Runs the `authGuard` checks first so an anonymous
 * visitor gets the connect prompt rather than an "admin only" dead end.
 */
export const adminGuard: CanActivateFn = (route, state) => {
  const router = inject(Router);
  const adminAccess = inject(AdminAccessService);

  const authResult = authGuard(route, state);
  if (authResult !== true) return authResult;

  return adminAccess.isAdmin() ? true : redirectToAuth(router, state.url, 'admin');
};
