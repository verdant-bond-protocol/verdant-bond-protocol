import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { createClient, RedisClientType } from '@redis/client';

@Injectable()
export class RedisService {
  private readonly logger = new Logger(RedisService.name);
  private readonly redis: RedisClientType;
  private healthy = false;

  constructor() {
    this.redis = createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      socket: {
        reconnectStrategy: (retries) => Math.min(1000 * 2 ** retries, 30_000),
      },
    });
    this.redis.on('ready', () => {
      this.healthy = true;
      this.logger.log('Redis connection ready');
    });
    this.redis.on('end', () => {
      this.healthy = false;
      this.logger.warn('Redis connection closed');
    });
    this.redis.on('error', (error) => {
      this.healthy = false;
      this.logger.error(`Redis error: ${error.message}`);
    });
    this.redis.connect().catch((error) => {
      this.healthy = false;
      this.logger.error(`Redis connection failed: ${error.message}`);
    });
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  async get(key: string): Promise<string | null> {
    try {
      return await this.redis.get(key);
    } catch (error) {
      this.logDegraded('get', key, error);
      return null;
    }
  }

  async set(key: string, value: string, options?: { EX?: number; NX?: boolean; PX?: number }): Promise<string | null> {
    try {
      return await (this.redis.set as any)(key, value, options);
    } catch (error) {
      this.logDegraded('set', key, error);
      return null;
    }
  }

  async setEx(key: string, seconds: number, value: string): Promise<void> {
    try {
      await this.redis.setEx(key, seconds, value);
    } catch (error) {
      this.logDegraded('setEx', key, error);
    }
  }

  async cacheSet(key: string, seconds: number, value: string, tags: string[]): Promise<void> {
    await this.setEx(key, seconds, value);
    for (const tag of tags) {
      await this.sAdd(`cache-index:${tag}`, key);
    }
  }

  async invalidateTag(tag: string): Promise<void> {
    const indexKey = `cache-index:${tag}`;
    const keys = await this.sMembers(indexKey);
    for (const key of keys) {
      await this.del(key);
    }
    await this.del(indexKey);
  }

  async del(key: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch (error) {
      this.logDegraded('del', key, error);
    }
  }

  /**
   * Atomically get the value of `key` and delete it in a single Redis operation.
   *
   * This is the safe primitive for one-time-use tokens (e.g. auth challenges):
   * if a value is returned, the caller knows they are the exclusive consumer
   * and no concurrent request could have read the same value.
   *
   * Returns the previous value stored at `key`, or `null` if the key did not
   * exist (already consumed / expired / never set).
   *
   * Throws ServiceUnavailableException on Redis failure so callers do not
   * silently fall back to non-atomic behaviour.
   */
  async getDel(key: string): Promise<string | null> {
    try {
      return await this.redis.getDel(key);
    } catch (error) {
      this.healthy = false;
      this.logger.error(`Redis getDel failed for ${key}: ${this.message(error)}`);
      throw new ServiceUnavailableException('Challenge consumption is unavailable');
    }
  }

  /**
   * Delete all keys matching a glob pattern.
   *
   * Uses SCAN with MATCH to enumerate matching keys without blocking Redis,
   * then DELs them in a single batched call per cursor page.
   * Never calls KEYS, which blocks the server on large keyspaces.
   */
  async delPattern(pattern: string): Promise<void> {
    try {
      let cursor = 0;
      do {
        const reply = await this.redis.scan(cursor, { MATCH: pattern, COUNT: 100 });
        cursor = reply.cursor;
        if (reply.keys.length > 0) {
          await this.redis.del(reply.keys);
        }
      } while (cursor !== 0);
    } catch (error) {
      this.logDegraded('delPattern', pattern, error);
    }
  }

  async sAdd(key: string, value: string): Promise<void> {
    try {
      await this.redis.sAdd(key, value);
    } catch (error) {
      this.logDegraded('sAdd', key, error);
    }
  }

  async sMembers(key: string): Promise<string[]> {
    try {
      return await this.redis.sMembers(key);
    } catch (error) {
      this.logDegraded('sMembers', key, error);
      return [];
    }
  }

  async incrOrThrow(key: string): Promise<number> {
    try {
      return await this.redis.incr(key);
    } catch (error) {
      this.healthy = false;
      this.logger.error(`Redis incr failed for ${key}: ${this.message(error)}`);
      throw new ServiceUnavailableException('Nonce tracking is unavailable');
    }
  }

  async getOrThrow(key: string): Promise<string | null> {
    try {
      return await this.redis.get(key);
    } catch (error) {
      this.throwUnavailable('get', key, error);
    }
  }

  async setOrThrow(key: string, value: string): Promise<void> {
    try {
      await this.redis.set(key, value);
    } catch (error) {
      this.throwUnavailable('set', key, error);
    }
  }

  async acquireLockOrThrow(key: string, token: string, ttlMs: number): Promise<boolean> {
    try {
      return (await this.redis.set(key, token, { NX: true, PX: ttlMs })) === 'OK';
    } catch (error) {
      this.throwUnavailable('lock', key, error);
    }
  }

  async releaseLockOrThrow(key: string, token: string): Promise<void> {
    try {
      await this.redis.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        { keys: [key], arguments: [token] },
      );
    } catch (error) {
      this.throwUnavailable('unlock', key, error);
    }
  }

  async expire(key: string, seconds: number): Promise<boolean> {
    try {
      return await this.redis.expire(key, seconds);
    } catch (error) {
      this.logDegraded('expire', key, error);
      return false;
    }
  }

  /**
   * Reserve a key only if it does not already exist (Redis `SET ... NX`).
   *
   * Used for admin-intent replay protection: a nonce may be consumed exactly
   * once. Returns true if this call reserved the key (first use), false if it
   * already existed (replay attempt). The key auto-expires after `seconds`.
   */
  async setNx(key: string, seconds: number): Promise<boolean> {
    try {
      const result = await this.redis.set(key, '1', { NX: true, EX: seconds });
      return result === 'OK';
    } catch (error) {
      this.logDegraded('setNx', key, error);
      return false;
    }
  }

  /**
   * Like {@link setNx} but stores an arbitrary string value (used for
   * idempotency records). Returns true only if the key was newly created.
   */
  async setNxValue(key: string, value: string, seconds: number): Promise<boolean> {
    try {
      const result = await this.redis.set(key, value, { NX: true, EX: seconds });
      return result === 'OK';
    } catch (error) {
      this.logDegraded('setNxValue', key, error);
      return false;
    }
  }

  async ttl(key: string): Promise<number> {
    try {
      return await this.redis.ttl(key);
    } catch (error) {
      this.logDegraded('ttl', key, error);
      return -1;
    }
  }

  private logDegraded(operation: string, key: string, error: unknown): void {
    this.healthy = false;
    this.logger.warn(`Redis ${operation} failed for ${key}; continuing without cache: ${this.message(error)}`);
  }

  private throwUnavailable(operation: string, key: string, error: unknown): never {
    this.healthy = false;
    this.logger.error(`Redis ${operation} failed for ${key}: ${this.message(error)}`);
    throw new ServiceUnavailableException('Nonce tracking is unavailable');
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
