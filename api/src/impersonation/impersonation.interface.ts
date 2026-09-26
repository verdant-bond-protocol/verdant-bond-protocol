/**
 * Scoped maintainer impersonation for support debugging (issue #264).
 *
 * Impersonation is the ability to act *as* a user to reproduce a report. It is
 * deliberately narrow:
 *
 * - **scope** — an explicit allow-list of read-only operations, granted per
 *   session; anything not listed is denied by default,
 * - **duration** — a hard expiry, enforced on every call and never extended
 *   (start a new session instead),
 * - **audit** — session start, end, expiry and every operation performed are
 *   recorded, with the maintainer principal and the target user,
 * - **dangerous mutations** — blocked unless the session was explicitly
 *   granted `allowDangerousMutations`, which the API keeps out of the default
 *   code path entirely.
 */

export interface ImpersonationScope {
  /** Operations the session may perform; anything not listed is denied. */
  allowedOperations: string[];
  /** Explicit opt-in required for mutations; never implied by scope alone. */
  allowDangerousMutations?: boolean;
}

export interface ImpersonationSession {
  sessionId: string;
  /** The maintainer performing the impersonation. */
  maintainerAddress: string;
  /** The user being impersonated. */
  targetAddress: string;
  scope: ImpersonationScope;
  reason: string;
  startedAt: string;
  /** Hard expiry; enforced on every operation, never extended. */
  expiresAt: string;
  endedAt?: string;
  endReason?: 'explicit_end' | 'expired';
  revoked?: boolean;
}

export interface ImpersonationAuditEvent {
  sessionId: string;
  event: 'started' | 'operation_allowed' | 'operation_denied' | 'ended' | 'expired';
  at: string;
  maintainerAddress: string;
  targetAddress: string;
  operation?: string;
  detail?: string;
}

export interface ImpersonationDecision {
  allowed: boolean;
  /** Present when `allowed` is false — always a reason, never silent denial. */
  denialReason?: 'no_active_session' | 'expired' | 'revoked' | 'operation_not_in_scope' | 'dangerous_mutation_blocked';
  /** What to surface to the user; also used for the audit event. */
  reason?: string;
}
