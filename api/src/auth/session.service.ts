import {
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { RedisService } from '../common/services/redis.service';
import {
  canRevokeSessions,
  SESSION_EPOCH_TTL_SECONDS,
  SessionActor,
  SessionClaims,
} from './session-revocation.interface';

/**
 * Stale-session and token-revocation handling.
 *
 * Two independent mechanisms, both checked on every authenticated request:
 *
 *  - a per-wallet **epoch** (`sv` claim). `revokeAll` increments it, so every
 *    token minted at an older version is stale — "sign out everywhere".
 *  - a per-session **jti deny-list**. `revokeToken` adds one session id, so a
 *    single device can be logged out without touching the others.
 *
 * Redis is the source of truth; an in-process mirror is a fallback for a short
 * Redis outage. By default a revocation check **fails closed** when neither
 * Redis nor the mirror can answer, so a revoked token is never honoured during
 * an outage. `SESSION_REVOCATION_FAIL_OPEN=true` (or `setFailOpen(true)`) opts
 * into fail-open for operators who prefer availability; see the runbook.
 *
 * Legacy tokens without `sv`/`jti` are treated as version 0 with no jti. They
 * remain valid while the wallet's epoch is 0, and are invalidated by the first
 * `revokeAll` — see the migration section in
 * `docs/token-revocation-and-stale-sessions.md`.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);
  private readonly epochMemory = new Map<string, { value: number; expiresAt: number }>();
  private readonly revokedMemory = new Map<string, number>();
  private failOpen = process.env.SESSION_REVOCATION_FAIL_OPEN === 'true';

  constructor(private readonly redis: RedisService) {}

  /** Test/ops override for the documented fail-open recovery lever. */
  setFailOpen(value: boolean): void {
    this.failOpen = value;
  }

  private static epochKey(address: string): string {
    return `session:epoch:${address.toLowerCase()}`;
  }

  private static jtiKey(jti: string): string {
    return `session:revoked:${jti}`;
  }

  /** Mint the claims a newly issued token pair must carry. */
  async issue(address: string): Promise<{ sessionVersion: number; jti: string }> {
    return { sessionVersion: await this.currentVersion(address), jti: crypto.randomUUID() };
  }

  async currentVersion(address: string): Promise<number> {
    const key = SessionService.epochKey(address);
    let raw: string | null;
    try {
      raw = await this.redis.getOrThrow(key);
    } catch (error) {
      const mirrored = this.epochMemory.get(address);
      if (mirrored && mirrored.expiresAt > Date.now()) return mirrored.value;
      if (this.failOpen) return 0;
      throw new ServiceUnavailableException('Session state is unavailable');
    }
    if (raw === null) return 0;
    const version = Number(raw);
    return Number.isInteger(version) && version >= 0 ? version : 0;
  }

  /**
   * Revoke every session of `address` by bumping its epoch.
   * Idempotent in effect: repeating it only makes older tokens even staler.
   */
  async revokeAll(address: string, actor: SessionActor, reason = 'revoked'): Promise<number> {
    if (!canRevokeSessions(actor, address)) {
      throw new ForbiddenException('You may only revoke your own sessions');
    }
    const key = SessionService.epochKey(address);
    try {
      const version = await this.redis.incrOrThrow(key);
      await this.redis.expire(key, SESSION_EPOCH_TTL_SECONDS);
      this.mirrorEpoch(address, version);
      this.logger.warn(`sessions revoked for ${address} (epoch ${version}): ${reason}`);
      return version;
    } catch (error) {
      if (!this.failOpen) {
        throw new ServiceUnavailableException('Session revocation is unavailable; retry the request');
      }
      const version = (await this.currentVersion(address)) + 1;
      this.mirrorEpoch(address, version);
      return version;
    }
  }

  /** Revoke one session (access + refresh pair) by its `jti`. Safe to repeat. */
  async revokeToken(jti: string, ttlSeconds = SESSION_EPOCH_TTL_SECONDS): Promise<void> {
    if (!jti) throw new ForbiddenException('Missing session id');
    const stored = await this.redis.set(
      SessionService.jtiKey(jti),
      JSON.stringify({ revokedAt: Date.now() }),
      { EX: ttlSeconds },
    );
    this.revokedMemory.set(jti, Date.now() + ttlSeconds * 1000);
    if (stored === null && !this.failOpen) {
      throw new ServiceUnavailableException('Session revocation is unavailable; retry the request');
    }
  }

  async isJtiRevoked(jti: string): Promise<boolean> {
    const key = SessionService.jtiKey(jti);
    let raw: string | null;
    try {
      raw = await this.redis.getOrThrow(key);
    } catch (error) {
      const mirroredUntil = this.revokedMemory.get(jti);
      if (mirroredUntil !== undefined) return mirroredUntil > Date.now();
      if (this.failOpen) return false;
      throw new ServiceUnavailableException('Session state is unavailable');
    }
    return raw !== null;
  }

  /** Reject a stale or revoked token. Called by JwtStrategy and refresh. */
  async assertActive(claims: SessionClaims): Promise<void> {
    if (claims.jti && (await this.isJtiRevoked(claims.jti))) {
      throw new UnauthorizedException('Session has been revoked. Please sign in again.');
    }
    const current = await this.currentVersion(claims.sub);
    if ((claims.sv ?? 0) !== current) {
      throw new UnauthorizedException('Session is stale. Please sign in again.');
    }
  }

  private mirrorEpoch(address: string, value: number): void {
    this.epochMemory.set(address, { value, expiresAt: Date.now() + SESSION_EPOCH_TTL_SECONDS * 1000 });
  }
}
