import { BoundedCacheService } from './bounded-cache.service';

describe('BoundedCacheService', () => {
  let cache: BoundedCacheService<any>;

  beforeEach(() => {
    cache = new BoundedCacheService(10, 5000, 1000);
  });

  describe('Basic Operations', () => {
    it('should set and get values', () => {
      cache.set('key1', { value: 'test' });
      expect(cache.get('key1')).toEqual({ value: 'test' });
    });

    it('should return null for missing keys', () => {
      expect(cache.get('nonexistent')).toBeNull();
    });

    it('should track cache hits and misses', () => {
      cache.set('key1', { value: 'test' });
      cache.get('key1');
      cache.get('nonexistent');

      const stats = cache.getStats();
      expect(stats.hitRate).toBeGreaterThan(0);
    });

    it('should delete keys', () => {
      cache.set('key1', { value: 'test' });
      expect(cache.has('key1')).toBe(true);

      cache.delete('key1');
      expect(cache.has('key1')).toBe(false);
    });
  });

  describe('Expiration', () => {
    it('should expire entries after TTL', async () => {
      cache.set('key1', { value: 'test' }, 100); // 100ms TTL
      expect(cache.get('key1')).toEqual({ value: 'test' });

      await new Promise((r) => setTimeout(r, 150));
      expect(cache.get('key1')).toBeNull();
    });

    it('should track expired entries', async () => {
      cache.set('key1', { value: 'test' }, 50);
      cache.set('key2', { value: 'test' }, 50);

      await new Promise((r) => setTimeout(r, 100));

      cache.get('key1');
      cache.get('key2');

      const stats = cache.getStats();
      expect(stats.expiredCount).toBe(2);
    });
  });

  describe('Bounded Size & Eviction', () => {
    it('should evict LRU entry when at capacity', () => {
      const smallCache = new BoundedCacheService(3, 5000);

      smallCache.set('key1', { value: 'a' });
      smallCache.set('key2', { value: 'b' });
      smallCache.set('key3', { value: 'c' });

      // Access key1 and key2 to make key3 LRU
      smallCache.get('key1');
      smallCache.get('key2');

      // Add new entry, should evict key3
      smallCache.set('key4', { value: 'd' });

      expect(smallCache.has('key1')).toBe(true);
      expect(smallCache.has('key2')).toBe(true);
      expect(smallCache.has('key3')).toBe(false);
      expect(smallCache.has('key4')).toBe(true);
    });

    it('should report eviction count', () => {
      const smallCache = new BoundedCacheService(2, 5000);

      smallCache.set('key1', { value: 'a' });
      smallCache.set('key2', { value: 'b' });
      smallCache.get('key1');
      smallCache.set('key3', { value: 'c' }); // Evicts key2

      const stats = smallCache.getStats();
      expect(stats.evictionCount).toBeGreaterThan(0);
    });
  });

  describe('Invalidation', () => {
    it('should invalidate by prefix', () => {
      cache.set('user:1:data', { value: 'a' });
      cache.set('user:1:cache', { value: 'b' });
      cache.set('user:2:data', { value: 'c' });

      const removed = cache.invalidatePrefix('user:1:');
      expect(removed).toBe(2);
      expect(cache.has('user:1:data')).toBe(false);
      expect(cache.has('user:1:cache')).toBe(false);
      expect(cache.has('user:2:data')).toBe(true);
    });

    it('should invalidate by pattern', () => {
      cache.set('bond:1:issuer', { value: 'a' });
      cache.set('bond:1:holders', { value: 'b' });
      cache.set('bond:2:issuer', { value: 'c' });

      const removed = cache.invalidatePattern(/^bond:1:/);
      expect(removed).toBe(2);
    });

    it('should clear all entries', () => {
      cache.set('key1', { value: 'a' });
      cache.set('key2', { value: 'b' });
      cache.clear();

      expect(cache.size()).toBe(0);
      expect(cache.has('key1')).toBe(false);
    });
  });

  describe('Stale Detection', () => {
    it('should detect stale entries', async () => {
      cache.set('key1', { value: 'test' }, 10000); // Long TTL
      await new Promise((r) => setTimeout(r, 1100)); // Wait past stale threshold

      cache.get('key1'); // Should trigger stale detection

      const stats = cache.getStats();
      expect(stats.staleDetections).toBeGreaterThan(0);
    });

    it('should return stale entries', async () => {
      cache.set('key1', { value: 'test' }, 10000);
      await new Promise((r) => setTimeout(r, 1100));

      const stale = cache.getStaleEntries();
      expect(stale.length).toBeGreaterThan(0);
      expect(stale[0].key).toBe('key1');
    });

    it('should refresh entry TTL', () => {
      cache.set('key1', { value: 'test' }, 5000);
      const entry1 = cache.getEntry('key1')!;
      const originalExpiry = entry1.expiresAt;

      cache.refresh('key1', 10000);
      const entry2 = cache.getEntry('key1')!;

      expect(entry2.expiresAt).toBeGreaterThan(originalExpiry);
    });
  });

  describe('Metadata', () => {
    it('should store and retrieve metadata', () => {
      cache.set('key1', { value: 'test' }, 5000, { source: 'db', version: 1 });
      const entry = cache.getEntry('key1');

      expect(entry?.metadata).toEqual({ source: 'db', version: 1 });
    });

    it('should track access count', () => {
      cache.set('key1', { value: 'test' });
      cache.get('key1');
      cache.get('key1');
      cache.get('key1');

      const entry = cache.getEntry('key1')!;
      expect(entry.accessCount).toBe(3);
    });
  });

  describe('Concurrency (#423)', () => {
    it('should handle concurrent reads safely', async () => {
      cache.set('key1', { value: 'test' });

      const reads = await Promise.all(
        Array.from({ length: 10 }, () => Promise.resolve(cache.get('key1'))),
      );

      expect(reads.every((r) => r?.value === 'test')).toBe(true);
    });

    it('should handle concurrent writes with size constraints', async () => {
      const smallCache = new BoundedCacheService(5, 5000);

      const writes = Array.from({ length: 10 }, (_, i) =>
        Promise.resolve(smallCache.set(`key${i}`, { value: i })),
      );

      await Promise.all(writes);
      expect(smallCache.size()).toBeLessThanOrEqual(5);
    });

    it('should detect stale versions during concurrent access', async () => {
      cache.set('version:1', { data: 'v1' }, 10000);

      const reads = await Promise.all(
        Array.from({ length: 5 }, () =>
          new Promise((r) => {
            setTimeout(() => r(cache.get('version:1')), 100);
          }),
        ),
      );

      await new Promise((resolve) => setTimeout(resolve, 1200));

      cache.get('version:1'); // Triggers stale detection
      const stats = cache.getStats();

      expect(stats.staleDetections).toBeGreaterThan(0);
    });
  });
});
