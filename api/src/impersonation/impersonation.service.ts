import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  ImpersonationAuditEvent,
  ImpersonationDecision,
  ImpersonationEndReason,
  ImpersonationScope,
  ImpersonationSession,
} from './impersonation.interface';

/** Upper bound for a session, even if a caller asks for longer. */
export const MAX_SESSION_TTL_SECONDS = 30 * 60; // 30 minutes
const DEFAULT_SESSION_TTL_SECONDS = 15 * 60;
const MAX_AUDIT_EVENTS = 5_000;

/**
 * Map a session's single terminal state onto the denial a caller sees. A
 * session that was revoked is not reported the same way as one whose TTL ran
 * out or that the maintainer deliberately ended — a caller debugging an access
 * decision needs those to be distinguishable.
 */
function endedDenial(session: ImpersonationSession): {
  denialReason: ImpersonationDecision['denialReason'];
  reason: string;
} {
  switch (session.endReason) {
    case 'expired':
      return {
        denialReason: 'expired',
        reason: `session expired at ${session.expiresAt}`,
      };
    case 'revoked':
      return { denialReason: 'revoked', reason: 'session was revoked' };
    default:
      return { denialReason: 'session_ended', reason: 'session has ended' };
  }
}

/**
 * Scoped maintainer impersonation (issue #264).
 *
 * An impersonation session is a narrow, expiring grant: a maintainer may act
 * as one specific user for a bounded time, for one stated reason, over an
 * explicit operation allow-list. Sessions cannot be extended — a longer
 * investigation starts a new session, which produces a new audit trail rather
 * than a single unbounded one.
 *
 * Denials are never silent: `performOperation` returns a
 * `denialReason` naming exactly which guard rejected the call, and the denial
 * itself is audited so a maintainer probing beyond their grant is visible.
 */
@Injectable()
export class ImpersonationService {
  private readonly logger = new Logger(ImpersonationService.name);
  private readonly sessions = new Map<string, ImpersonationSession>();
  private readonly auditEvents: ImpersonationAuditEvent[] = [];

  /**
   * Start an impersonation session.
   *
   * The maintainer must be the configured admin principal — the same check
   * `AdminGuard` performs (`STELLAR_PUBLIC_KEY`) — so an impersonation grant
   * cannot be created by an ordinary user, and every existing admin-side
   * route stays behind the same gate.
   */
  async start(input: {
    maintainerAddress: string;
    targetAddress: string;
    scope: ImpersonationScope;
    reason: string;
    ttlSeconds?: number;
    now?: Date;
  }): Promise<ImpersonationSession> {
    const adminKey = process.env.STELLAR_PUBLIC_KEY;
    if (!adminKey) {
      throw new UnauthorizedException('Admin key not configured');
    }
    if (input.maintainerAddress !== adminKey) {
      throw new UnauthorizedException('Admin access required to impersonate');
    }

    if (!input.targetAddress) {
      throw new Error('targetAddress is required');
    }
    if (!input.reason || input.reason.trim().length === 0) {
      throw new Error('a reason is required for impersonation');
    }
    if (!input.scope || !Array.isArray(input.scope.allowedOperations)) {
      throw new Error('an explicit allowedOperations list is required');
    }

    const requested = input.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
    // Clamp, never extend: a caller asking for a week gets 30 minutes.
    const ttl = Math.min(Math.max(1, Math.floor(requested)), MAX_SESSION_TTL_SECONDS);
    const now = input.now ?? new Date();
    const startedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();

    const session: ImpersonationSession = {
      sessionId: randomUUID(),
      maintainerAddress: input.maintainerAddress,
      targetAddress: input.targetAddress,
      scope: {
        allowedOperations: [...new Set(input.scope.allowedOperations)],
        allowDangerousMutations: input.scope.allowDangerousMutations === true,
      },
      reason: input.reason.trim(),
      startedAt,
      expiresAt,
      endedAt: null,
      endReason: null,
    };

    this.sessions.set(session.sessionId, session);
    this.audit(session, 'started', { detail: `scope: ${session.scope.allowedOperations.join(', ')}` });
    return session;
  }

  /**
   * Decide whether `operation` may be performed under `sessionId` right now,
   * recording an allowed/denied audit event either way.
   */
  async performOperation(
    sessionId: string,
    operation: string,
    { dangerous = false, now = new Date() } = {},
  ): Promise<ImpersonationDecision> {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return { allowed: false, denialReason: 'no_active_session', reason: 'no such impersonation session' };
    }

    if (session.endedAt) {
      this.audit(session, 'operation_denied', { operation, detail: `session already ${session.endReason}` });
      return { allowed: false, ...endedDenial(session) };
    }

    const expiresAtMs = new Date(session.expiresAt).getTime();
    if (now.getTime() >= expiresAtMs) {
      this.endInternal(session, 'expired', now);
      this.audit(session, 'expired', { operation });
      return { allowed: false, denialReason: 'expired', reason: `session expired at ${session.expiresAt}` };
    }

    if (!session.scope.allowedOperations.includes(operation)) {
      this.audit(session, 'operation_denied', { operation, detail: 'operation not in scope' });
      return { allowed: false, denialReason: 'operation_not_in_scope', reason: `operation '${operation}' is not in the session scope` };
    }

    if (dangerous && session.scope.allowDangerousMutations !== true) {
      this.audit(session, 'operation_denied', { operation, detail: 'dangerous mutation blocked' });
      return { allowed: false, denialReason: 'dangerous_mutation_blocked', reason: 'dangerous mutations require an explicit session grant' };
    }

    this.audit(session, 'operation_allowed', { operation });
    return { allowed: true };
  }

  /** Explicit end by the maintainer (or a supervisor). Idempotent. */
  async end(sessionId: string, byAddress: string, now: Date = new Date()): Promise<boolean> {
    return this.endBy(sessionId, byAddress, 'explicit_end', 'ended', now);
  }

  /**
   * Revoke a session. Same authority as an explicit end — only the session's
   * own maintainer — and the same single terminal state, so a revocation can
   * never be represented by a flag that some other check forgets to read.
   */
  async revoke(sessionId: string, byAddress: string, now: Date = new Date()): Promise<boolean> {
    return this.endBy(sessionId, byAddress, 'revoked', 'revoked', now);
  }

  private async endBy(
    sessionId: string,
    byAddress: string,
    endReason: ImpersonationEndReason,
    auditEvent: ImpersonationAuditEvent['event'],
    now: Date,
  ): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    // Only the session's own maintainer may end it; anyone else gets nothing.
    if (session.maintainerAddress !== byAddress) return false;

    if (session.endedAt) return true; // already ended — idempotent

    this.endInternal(session, endReason, now);
    this.audit(session, auditEvent, {});
    return true;
  }

  getSession(sessionId: string): ImpersonationSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Sessions for one target user, for the visible indicator. */
  getSessionsForTarget(targetAddress: string): ImpersonationSession[] {
    const now = Date.now();
    return [...this.sessions.values()].filter(
      (s) => s.targetAddress === targetAddress && !s.endedAt && new Date(s.expiresAt).getTime() > now,
    );
  }

  getAuditTrail(): ImpersonationAuditEvent[] {
    return [...this.auditEvents];
  }

  getActiveSessionCount(): number {
    const now = Date.now();
    return [...this.sessions.values()].filter(
      (s) => !s.endedAt && new Date(s.expiresAt).getTime() > now,
    ).length;
  }

  clear(): void {
    this.sessions.clear();
    this.auditEvents.length = 0;
  }

  private endInternal(
    session: ImpersonationSession,
    reason: ImpersonationEndReason,
    now: Date = new Date(),
  ): void {
    if (session.endedAt) return;
    session.endedAt = now.toISOString();
    session.endReason = reason;
  }

  private audit(
    session: ImpersonationSession,
    event: ImpersonationAuditEvent['event'],
    extra: { operation?: string; detail?: string },
  ): void {
    if (this.auditEvents.length >= MAX_AUDIT_EVENTS) {
      this.auditEvents.shift();
    }
    this.auditEvents.push({
      sessionId: session.sessionId,
      event,
      at: new Date().toISOString(),
      maintainerAddress: session.maintainerAddress,
      targetAddress: session.targetAddress,
      operation: extra.operation,
      detail: extra.detail,
    });
  }
}
