import { Injectable } from '@nestjs/common';
import { RedisService } from './redis.service';
import * as crypto from 'crypto';

export type IdempotencyStatus = 'pending' | 'success' | 'error';

export interface IdempotencyRecord {
  status: IdempotencyStatus;
  fingerprint: string;
  result?: any;
  transactionHash?: string;
  statusCode?: number;
  /** Reservation token; only set while pending. */
  owner?: string;
  createdAt: number;
}

const DEFAULT_TTL_SECONDS = Number(process.env.IDEMPOTENCY_TTL_SECONDS ?? 86_400);
/**
 * Only guards the gap between claiming a retry and writing its pending record;
 * after that the pending record itself blocks concurrent retries. Short so a
 * claimer that crashes inside the gap cannot wedge the key for long.
 */
export const RETRY_CLAIM_TTL_SECONDS = 60;

/**
 * Persists the terminal result of a user-submitted mutation keyed by an
 * idempotency key (#114). Replaying the same key returns the original result;
 * reusing a key with a different payload is rejected as a conflict.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly redis: RedisService) {}

  private keyOf(key: string): string {
    return `idem:${key}`;
  }

  private retryClaimOf(key: string): string {
    return `idem:${key}:retry`;
  }

  async get(key: string): Promise<IdempotencyRecord | null> {
    const raw = await this.redis.get(this.keyOf(key));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as IdempotencyRecord;
    } catch {
      return null;
    }
  }

  /**
   * Reserve a pending slot. Returns false if a record already exists. The
   * random `owner` lets a caller whose write landed but whose reply was lost
   * recognise its own reservation instead of wedging the key as "in progress".
   */
  async markPending(key: string, fingerprint: string): Promise<boolean> {
    const owner = crypto.randomUUID();
    const record: IdempotencyRecord = {
      status: 'pending',
      fingerprint,
      owner,
      createdAt: Date.now(),
    };
    if (await this.redis.setNxValue(this.keyOf(key), JSON.stringify(record), DEFAULT_TTL_SECONDS)) {
      return true;
    }
    const current = await this.get(key);
    return current?.status === 'pending' && current.owner === owner;
  }

  /**
   * Atomically take over a key whose previous attempt ended in `error` (#348).
   * Without this, every concurrent retry after an error saw the same `error`
   * record and executed the mutation. Returns false if another retry holds the
   * claim or the record is no longer `error` (e.g. it already succeeded).
   */
  async claimRetry(key: string, fingerprint: string): Promise<boolean> {
    const claimed = await this.redis.setNxValue(this.retryClaimOf(key), '1', RETRY_CLAIM_TTL_SECONDS);
    if (!claimed) return false;

    const current = await this.get(key);
    if (current?.status !== 'error' || current.fingerprint !== fingerprint) {
      await this.redis.del(this.retryClaimOf(key));
      return false;
    }

    const record: IdempotencyRecord = { status: 'pending', fingerprint, createdAt: Date.now() };
    await this.redis.setEx(this.keyOf(key), DEFAULT_TTL_SECONDS, JSON.stringify(record));
    return true;
  }

  async complete(
    key: string,
    status: IdempotencyStatus,
    result: any,
    statusCode?: number,
    /**
     * Callers that know the request fingerprint should pass it: if the
     * read-back below fails, an empty fingerprint would make every legitimate
     * retry look like a conflicting payload until the TTL expires (#348).
     */
    fingerprint?: string,
  ): Promise<void> {
    const existing = await this.get(key);
    const transactionHash =
      result?.transactionHash ?? existing?.transactionHash ?? undefined;
    const record: IdempotencyRecord = {
      status,
      fingerprint: fingerprint ?? existing?.fingerprint ?? '',
      result,
      transactionHash,
      statusCode: statusCode ?? existing?.statusCode ?? 200,
      createdAt: existing?.createdAt ?? Date.now(),
    };
    await this.redis.setEx(this.keyOf(key), DEFAULT_TTL_SECONDS, JSON.stringify(record));
    await this.redis.del(this.retryClaimOf(key));
  }

  static fingerprintOf(method: string, path: string, body: unknown): string {
    const canonical = JSON.stringify({ method, path, body: body ?? null });
    return crypto.createHash('sha256').update(canonical).digest('hex');
  }
}
