import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { IdempotencyService } from '../services/idempotency.service';

/**
 * Actor-scoped duplicate-submission guard (contributor slice).
 *
 * The global IdempotencyInterceptor keys only on the client-supplied key and
 * the request fingerprint. Two different investors that happen to pick the
 * same key — or an attacker who learns one — can therefore collide on a single
 * cached result. This guard namespaces every key with a hash of the
 * authenticated actor before delegating to the existing `IdempotencyService`.
 *
 * It is additive and opt-in: no existing key, endpoint or contract changes.
 * New callers that need actor isolation use this guard; legacy interceptor
 * records keep their current `idem:<key>` namespace and are untouched. See
 * `docs/duplicate-submission-concurrency.md`.
 */

export interface ActorSubmission {
  /** Client-generated idempotency key. */
  key: string;
  /** Authenticated subject (JWT `sub`), never a client-controlled header. */
  actorId: string;
  method: string;
  path: string;
  body: unknown;
}

export type DuplicateDecision = 'execute' | 'replay' | 'conflict';

export interface BeginResult {
  decision: DuplicateDecision;
  result?: any;
  statusCode?: number;
}

@Injectable()
export class ActorScopedIdempotency {
  constructor(private readonly idempotency: IdempotencyService) {}

  /** Namespaced storage key; the digest keeps the actor id out of Redis keys. */
  static scopedKey(sub: ActorSubmission): string {
    const actor = createHash('sha256').update(sub.actorId).digest('hex');
    return `actor:${actor}:${sub.key}`;
  }

  static fingerprintOf(sub: ActorSubmission): string {
    return IdempotencyService.fingerprintOf(sub.method, sub.path, sub.body);
  }

  /**
   * Decide what the caller may do. At most one concurrent caller receives
   * `execute`: the first reserving the key, or — after a recorded failure —
   * the single winner of the retry claim. Everyone else gets `replay` (a
   * completed result) or `conflict` (in progress, payload mismatch, or state
   * unreadable). Conflicts fail closed; the mutation is never run twice.
   */
  async begin(sub: ActorSubmission): Promise<BeginResult> {
    const key = ActorScopedIdempotency.scopedKey(sub);
    const fingerprint = ActorScopedIdempotency.fingerprintOf(sub);
    const existing = await this.idempotency.get(key);

    if (existing) {
      if (existing.fingerprint !== fingerprint) return { decision: 'conflict' };
      if (existing.status === 'success') {
        return { decision: 'replay', result: existing.result, statusCode: existing.statusCode };
      }
      if (existing.status === 'pending') return { decision: 'conflict' };
      // Previous attempt failed: exactly one caller may claim the retry.
      return (await this.idempotency.claimRetry(key, fingerprint))
        ? { decision: 'execute' }
        : { decision: 'conflict' };
    }

    if (await this.idempotency.markPending(key, fingerprint)) return { decision: 'execute' };

    // We could not reserve the key. Re-read before deciding: a stale read or
    // Redis outage must not bypass deduplication.
    const again = await this.idempotency.get(key);
    if (!again || again.fingerprint !== fingerprint) return { decision: 'conflict' };
    if (again.status === 'success') {
      return { decision: 'replay', result: again.result, statusCode: again.statusCode };
    }
    if (again.status === 'pending' || !(await this.idempotency.claimRetry(key, fingerprint))) {
      return { decision: 'conflict' };
    }
    return { decision: 'execute' };
  }

  async complete(sub: ActorSubmission, result: any, statusCode = 200): Promise<void> {
    await this.idempotency.complete(
      ActorScopedIdempotency.scopedKey(sub),
      'success',
      result,
      statusCode,
      ActorScopedIdempotency.fingerprintOf(sub),
    );
  }

  async fail(sub: ActorSubmission, error: Error, statusCode = 500): Promise<void> {
    await this.idempotency.complete(
      ActorScopedIdempotency.scopedKey(sub),
      'error',
      { message: error.message },
      statusCode,
      ActorScopedIdempotency.fingerprintOf(sub),
    );
  }
}
