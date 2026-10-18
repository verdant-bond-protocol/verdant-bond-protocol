import { Injectable, Logger } from '@nestjs/common';

export interface CacheEntry<T> {
  key: string;
  value: T;
  createdAt: number;
  expiresAt: number;
  accessCount: number;
  lastAccessedAt: number;
  metadata?: Record<string, any>;
}

export interface BoundedCacheStats {
  totalEntries: number;
  maxSize: number;
  hitRate: number;
  evictionCount: number;
  expiredCount: number;
  staleDetections: number;
}

/**
 * Bounded cache with explicit invalidation and stale detection (#422).
 *
 * Features:
 * - Fixed maximum size with LRU eviction
 * - TTL-based expiration
 * - Explicit invalidation by key pattern
 * - Stale detection with age-based warnings
 * - Access tracking and metrics
 * - Safe concurrent access
 */
@Injectable()
export class BoundedCacheService<T = any> {
  private readonly logger = new Logger(BoundedCacheService.name);
  private readonly cache = new Map<string, CacheEntry<T>>();
  private readonly maxSize: number;
  private readonly defaultTtlMs: number;
  private readonly staleThresholdMs: number;

  private hitCount = 0;
  private missCount = 0;
  private evictionCount = 0;
  private expiredCount = 0;
  private staleDetections = 0;

  constructor(
    maxSize: number = 1000,
    defaultTtlMs: number = 5 * 60 * 1000, // 5 minutes
    staleThresholdMs: number = 60 * 1000, // 1 minute
  ) {
    this.maxSize = maxSize;
    this.defaultTtlMs = defaultTtlMs;
    this.staleThresholdMs = staleThresholdMs;
  }

  /**
   * Set a value in cache with optional custom TTL.
   */
  set(key: string, value: T, ttlMs: number = this.defaultTtlMs, metadata?: Record<string, any>): void {
    const now = Date.now();

    // Clean expired entries first
    this.cleanExpired();

    // Evict LRU entry if at capacity
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      this.evictLRU();
    }

    const entry: CacheEntry<T> = {
      key,
      value,
      createdAt: now,
      expiresAt: now + ttlMs,
      accessCount: 0,
      lastAccessedAt: now,
      metadata,
    };

    this.cache.set(key, entry);
    this.logger.debug(`Cache SET: ${key} (TTL: ${ttlMs}ms, Size: ${this.cache.size}/${this.maxSize})`);
  }

  /**
   * Get a value from cache, returns null if expired or missing.
   */
  get(key: string): T | null {
    const entry = this.cache.get(key);

    if (!entry) {
      this.missCount++;
      return null;
    }

    const now = Date.now();

    // Check if expired
    if (now > entry.expiresAt) {
      this.cache.delete(key);
      this.expiredCount++;
      this.missCount++;
      this.logger.debug(`Cache MISS (expired): ${key}`);
      return null;
    }

    // Update access tracking
    entry.accessCount++;
    entry.lastAccessedAt = now;
    this.hitCount++;

    // Check if stale
    if (now - entry.createdAt > this.staleThresholdMs) {
      this.staleDetections++;
      this.logger.warn(`Cache STALE: ${key} (age: ${now - entry.createdAt}ms)`);
    }

    return entry.value;
  }

  /**
   * Get entry with metadata (for inspecting age/staleness).
   */
  getEntry(key: string): CacheEntry<T> | null {
    return this.cache.get(key) ?? null;
  }

  /**
   * Check if key exists and is not expired.
   */
  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    const now = Date.now();
    if (now > entry.expiresAt) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Delete a specific key.
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * Invalidate all keys matching a pattern (regex).
   */
  invalidatePattern(pattern: RegExp): number {
    const keysToDelete: string[] = [];

    for (const key of this.cache.keys()) {
      if (pattern.test(key)) {
        keysToDelete.push(key);
      }
    }

    let count = 0;
    for (const key of keysToDelete) {
      if (this.cache.delete(key)) {
        count++;
      }
    }

    this.logger.log(`Cache INVALIDATE: ${count} entries matching pattern ${pattern}`);
    return count;
  }

  /**
   * Invalidate keys by prefix.
   */
  invalidatePrefix(prefix: string): number {
    return this.invalidatePattern(new RegExp(`^${prefix}`));
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    const size = this.cache.size;
    this.cache.clear();
    this.logger.log(`Cache CLEAR: ${size} entries removed`);
  }

  /**
   * Clean expired entries.
   */
  private cleanExpired(): number {
    const now = Date.now();
    const keysToDelete: string[] = [];

    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.cache.delete(key);
      this.expiredCount++;
    }

    return keysToDelete.length;
  }

  /**
   * Evict least recently used entry.
   */
  private evictLRU(): void {
    let lruKey: string | null = null;
    let lruTime = Date.now();

    for (const [key, entry] of this.cache) {
      if (entry.lastAccessedAt < lruTime) {
        lruTime = entry.lastAccessedAt;
        lruKey = key;
      }
    }

    if (lruKey) {
      this.cache.delete(lruKey);
      this.evictionCount++;
      this.logger.debug(`Cache LRU EVICTION: ${lruKey}`);
    }
  }

  /**
   * Get cache statistics.
   */
  getStats(): BoundedCacheStats {
    this.cleanExpired();
    const total = this.hitCount + this.missCount;

    return {
      totalEntries: this.cache.size,
      maxSize: this.maxSize,
      hitRate: total > 0 ? (this.hitCount / total) * 100 : 0,
      evictionCount: this.evictionCount,
      expiredCount: this.expiredCount,
      staleDetections: this.staleDetections,
    };
  }

  /**
   * Get all cache keys.
   */
  keys(): string[] {
    return Array.from(this.cache.keys());
  }

  /**
   * Get cache size.
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * Get stale entries (older than staleThreshold).
   */
  getStaleEntries(): CacheEntry<T>[] {
    const now = Date.now();
    const stale: CacheEntry<T>[] = [];

    for (const entry of this.cache.values()) {
      if (now - entry.createdAt > this.staleThresholdMs && now <= entry.expiresAt) {
        stale.push(entry);
      }
    }

    return stale;
  }

  /**
   * Refresh entry TTL without changing value.
   */
  refresh(key: string, newTtlMs: number = this.defaultTtlMs): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    entry.expiresAt = Date.now() + newTtlMs;
    entry.lastAccessedAt = Date.now();
    return true;
  }
}
