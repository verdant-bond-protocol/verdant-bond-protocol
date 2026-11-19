/** Claims used by the stale-session / revocation checks (issue: stale sessions). */

import { Permission, Role } from './rbac';

export interface SessionClaims {
  sub: string;
  /** Session version ("epoch") the token was minted at. Absent = 0 (legacy tokens). */
  sv?: number;
  /** Unique session id, shared by the access token and its refresh token. */
  jti?: string;
}

export interface SessionActor {
  walletAddress: string;
  permissions?: string[];
  roles?: string[];
}

/**
 * Authorization rule shared by the service and the HTTP layer:
 * a wallet may always revoke its own sessions; revoking somebody else's
 * requires the `auth:sessions:revoke` permission (or the admin role).
 */
export function canRevokeSessions(actor: SessionActor, target: string): boolean {
  if (!actor?.walletAddress || !target) return false;
  if (actor.walletAddress.toLowerCase() === target.toLowerCase()) return true;
  const permissions = actor.permissions ?? [];
  const roles = actor.roles ?? [];
  return (
    permissions.includes('auth:sessions:revoke') ||
    permissions.includes(Permission.MANAGE_INCIDENTS) ||
    roles.includes(Role.MAINTAINER) ||
    roles.includes('admin') // legacy/external role name
  );
}

export const SESSION_EPOCH_TTL_SECONDS = 30 * 24 * 60 * 60; // longer than refresh lifetime (7d)
