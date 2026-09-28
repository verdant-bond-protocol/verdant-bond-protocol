import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  AuthorizationAuditEntry,
  AuthorizationError,
  AuthorizationGrant,
  AuthorizationStatus,
} from './authorization.interface';

export interface CleanupReport {
  scannedAt: string;
  scanned: number;
  /** Grants that were transitioned from Active to Expired by this run. */
  expiredIds: string[];
}

/**
 * In-memory store of delegated authorization grants with an expiry, cleanup,
 * renewal, and revocation flow (issue #302). Follows the same in-memory
 * `Map`-per-service convention as `InvitationService`; a production
 * deployment would back this with the same store the invitations/KYC
 * services eventually move to.
 */
@Injectable()
export class AuthorizationService {
  private readonly grants = new Map<string, AuthorizationGrant>();

  /** Grant `scope` to `subjectAddress`, valid for `ttlMs` from now. */
  grant(
    subjectAddress: string,
    scope: string,
    grantedBy: string,
    ttlMs: number,
    now: number = Date.now(),
  ): AuthorizationGrant {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new AuthorizationError('ttlMs must be a positive number', 'invalid_expiry');
    }
    const nowIso = new Date(now).toISOString();
    const record: AuthorizationGrant = {
      id: randomUUID(),
      subjectAddress,
      scope,
      grantedBy,
      grantedAt: nowIso,
      expiresAt: new Date(now + ttlMs).toISOString(),
      status: AuthorizationStatus.Active,
      renewedFromId: null,
      renewedById: null,
      revokedAt: null,
      revokedBy: null,
      audit: [{ at: nowIso, event: 'granted', actor: grantedBy }],
    };
    this.grants.set(record.id, record);
    return record;
  }

  private find(id: string): AuthorizationGrant {
    const record = this.grants.get(id);
    if (!record) {
      throw new AuthorizationError(`no authorization grant with id "${id}"`, 'not_found');
    }
    return record;
  }

  /**
   * The grant's true status as of `now`, computed on read without mutating
   * anything. An `Active`-stored grant past its `expiresAt` reads as
   * `Expired` here immediately — a protected action is blocked the instant a
   * grant lapses, not only once `cleanupExpired` has next run.
   */
  effectiveStatus(grant: AuthorizationGrant, now: number = Date.now()): AuthorizationStatus {
    if (grant.status === AuthorizationStatus.Revoked) return AuthorizationStatus.Revoked;
    if (now >= Date.parse(grant.expiresAt)) return AuthorizationStatus.Expired;
    return grant.status;
  }

  get(id: string): AuthorizationGrant {
    return this.find(id);
  }

  /** Whether `id` currently authorizes its scope's protected action. */
  isActive(id: string, now: number = Date.now()): boolean {
    const record = this.grants.get(id);
    if (!record) return false;
    return this.effectiveStatus(record, now) === AuthorizationStatus.Active;
  }

  /**
   * Transition every stored grant whose effective status is `Expired` but
   * whose persisted status is still `Active` into `Expired`, recording an
   * audit entry on each. Safe to run repeatedly (a cron job or an on-demand
   * report) — already-expired or revoked grants are left untouched.
   */
  cleanupExpired(now: number = Date.now()): CleanupReport {
    const expiredIds: string[] = [];
    for (const record of this.grants.values()) {
      if (record.status === AuthorizationStatus.Active && this.effectiveStatus(record, now) === AuthorizationStatus.Expired) {
        record.status = AuthorizationStatus.Expired;
        record.audit.push({ at: new Date(now).toISOString(), event: 'expired', actor: 'system:cleanup' });
        expiredIds.push(record.id);
      }
    }
    return { scannedAt: new Date(now).toISOString(), scanned: this.grants.size, expiredIds };
  }

  /**
   * Renew `id`: creates a fresh grant (new id, new expiry) that supersedes
   * it, and marks the old record as superseded. Only the original grantor or
   * the grant's own subject may confirm a renewal, and a revoked grant can
   * never be renewed — revocation is deliberate and final. An expired grant
   * *can* be renewed (that is the point: an old authorization "should
   * expire and be renewable"), an already-renewed one cannot be renewed
   * again through this record (renew the record it was superseded by).
   */
  renew(id: string, actor: string, ttlMs: number, now: number = Date.now()): AuthorizationGrant {
    const record = this.find(id);
    if (record.status === AuthorizationStatus.Revoked) {
      throw new AuthorizationError(`grant "${id}" was revoked and cannot be renewed`, 'already_revoked');
    }
    if (record.renewedById) {
      throw new AuthorizationError(`grant "${id}" was already renewed as "${record.renewedById}"`, 'not_active');
    }
    if (actor !== record.grantedBy && actor !== record.subjectAddress) {
      throw new AuthorizationError(
        `"${actor}" is not authorized to renew grant "${id}" (only the grantor or the subject may)`,
        'unauthorized_actor',
      );
    }
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new AuthorizationError('ttlMs must be a positive number', 'invalid_expiry');
    }

    // Mark the true current state before creating the replacement, so an
    // expired-but-not-yet-cleaned record is recorded as Expired rather than
    // left reading Active with a stale expiresAt.
    record.status = this.effectiveStatus(record, now);

    const nowIso = new Date(now).toISOString();
    const renewed: AuthorizationGrant = {
      id: randomUUID(),
      subjectAddress: record.subjectAddress,
      scope: record.scope,
      grantedBy: actor,
      grantedAt: nowIso,
      expiresAt: new Date(now + ttlMs).toISOString(),
      status: AuthorizationStatus.Active,
      renewedFromId: record.id,
      renewedById: null,
      revokedAt: null,
      revokedBy: null,
      audit: [{ at: nowIso, event: 'granted', actor, note: `renewed from ${record.id}` }],
    };

    record.renewedById = renewed.id;
    const renewalEntry: AuthorizationAuditEntry = { at: nowIso, event: 'renewed', actor, note: renewed.id };
    record.audit.push(renewalEntry);

    this.grants.set(renewed.id, renewed);
    return renewed;
  }

  /** Revoke `id`. Only its original grantor may revoke it. Idempotent calls fail loudly rather than silently no-op. */
  revoke(id: string, actor: string, now: number = Date.now()): AuthorizationGrant {
    const record = this.find(id);
    if (record.status === AuthorizationStatus.Revoked) {
      throw new AuthorizationError(`grant "${id}" is already revoked`, 'already_revoked');
    }
    if (actor !== record.grantedBy) {
      throw new AuthorizationError(
        `"${actor}" is not authorized to revoke grant "${id}" (only the original grantor may)`,
        'unauthorized_actor',
      );
    }
    record.status = AuthorizationStatus.Revoked;
    record.revokedAt = new Date(now).toISOString();
    record.revokedBy = actor;
    record.audit.push({ at: record.revokedAt, event: 'revoked', actor });
    return record;
  }

  /** All grants for a subject, for an audit or self-service listing view. */
  listForSubject(subjectAddress: string): AuthorizationGrant[] {
    return [...this.grants.values()].filter((g) => g.subjectAddress === subjectAddress);
  }
}
