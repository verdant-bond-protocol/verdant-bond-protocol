import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  ImpersonationAuditEvent,
  ImpersonationDecision,
  ImpersonationScope,
  ImpersonationSession,
} from './impersonation.interface';

/** Upper bound for a session, even if a caller asks for longer. */
export const MAX_SESSION_TTL_SECONDS = 30 * 60; // 30 minutes
const DEFAULT_SESSION_TTL_SECONDS = 15 * 60;
const MAX_AUDIT_EVENTS = 5_000;

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

    if (session.revoked || session.endedAt) {
      this.audit(session, 'operation_denied', { operation, detail: 'session already ended' });
      return { allowed: false, denialReason: 'revoked', reason: 'session has ended' };
    }

    const expiresAtMs = new Date(session.expiresAt).getTime();
    if (now.getTime() >= expiresAtMs) {
      this.endInternal(session, 'expired');
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
  async end(sessionId: string, byAddress: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    // Only the session's own maintainer may end it; anyone else gets nothing.
    if (session.maintainerAddress !== byAddress) return false;

    if (session.endedAt) return true; // already ended — idempotent

    session.endedAt = new Date().toISOString();
    session.endReason = 'explicit_end';
    this.audit(session, 'ended', {});
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

  private endInternal(session: ImpersonationSession, reason: 'explicit_end' | 'expired'): void {
    if (session.endedAt) return;
    session.endedAt = new Date().toISOString();
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
