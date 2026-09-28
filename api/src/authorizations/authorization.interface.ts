/**
 * Delegated authorization grants: any protocol permission one address
 * extends to another (or to itself, time-boxed) that should expire and be
 * safely renewable (issue #302). Distinct from the static `Role`/`Permission`
 * RBAC table in `auth/rbac.ts` — this models a *dynamic*, per-subject,
 * time-bound grant (e.g. an issuer delegating covenant-reporting authority to
 * a servicer for a fixed window) rather than a role assigned at signup.
 */

export enum AuthorizationStatus {
  /** Not expired, not revoked: the grant currently allows its scope's action. */
  Active = 'active',
  /** Passed its `expiresAt` without being renewed or revoked. */
  Expired = 'expired',
  /** Explicitly revoked before its natural expiry. */
  Revoked = 'revoked',
}

export interface AuthorizationAuditEntry {
  at: string;
  event: 'granted' | 'renewed' | 'revoked' | 'expired';
  actor: string;
  note?: string | null;
}

export interface AuthorizationGrant {
  id: string;
  /** The address this authorization applies to (the delegate). */
  subjectAddress: string;
  /** What the grant authorizes — an opaque, caller-defined scope string (e.g. `covenant:report:BOND-1`). */
  scope: string;
  grantedBy: string;
  grantedAt: string;
  expiresAt: string;
  status: AuthorizationStatus;
  /** The grant this one supersedes, if it was created by `renew()`. */
  renewedFromId: string | null;
  /** The grant that superseded this one, set once this grant has been renewed. */
  renewedById: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  audit: AuthorizationAuditEntry[];
}

export class AuthorizationError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'not_found'
      | 'already_revoked'
      | 'already_expired'
      | 'not_active'
      | 'unauthorized_actor'
      | 'invalid_expiry',
  ) {
    super(message);
    this.name = 'AuthorizationError';
  }
}
