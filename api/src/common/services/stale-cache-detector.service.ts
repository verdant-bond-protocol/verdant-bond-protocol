import { Logger } from '@nestjs/common';
import { BoundedCacheService } from './bounded-cache.service';

/**
 * Stale-cache detection with repair recommendations (#531).
 *
 * `BoundedCacheService` only knows an entry's age; it cannot tell whether a
 * cached value still matches the source of truth, and `refresh()` happily
 * extends the TTL of a value that is already wrong. This detector compares
 * each live entry against its source and classifies it:
 *
 *   fresh              value (or version) matches the source
 *   stale_version      entry carries `metadata.version` older/different than the source's
 *   stale_value        value differs from the source
 *   orphaned           the source no longer has the record
 *   source_unavailable the source lookup failed; nothing can be concluded
 *
 * Each non-fresh finding carries a repair recommendation. `repair()` applies
 * them (re-reading the source at repair time, never the value captured during
 * the scan) and requires an actor with the repair permission.
 */

export type CacheEntryStatus = 'fresh' | 'stale_version' | 'stale_value' | 'orphaned' | 'source_unavailable';

export type CacheRepairAction = 'none' | 'reload' | 'evict' | 'retry_scan';

export interface CacheRepairRecommendation {
  action: CacheRepairAction;
  description: string;
  /** Whether `repair()` performs this action itself. */
  automatable: boolean;
}

export interface CacheSourceRecord<T> {
  value: T;
  version?: string | number;
}

export interface CacheSource<T> {
  /** Authoritative record for a cache key, or null when it no longer exists. */
  load(key: string): Promise<CacheSourceRecord<T> | null>;
}

export interface StaleCacheFinding {
  key: string;
  status: Exclude<CacheEntryStatus, 'fresh'>;
  ageMs: number;
  cachedVersion?: string | number;
  sourceVersion?: string | number;
  error?: string;
  recommendation: CacheRepairRecommendation;
}

export interface PrefixRecommendation {
  prefix: string;
  staleKeys: number;
  description: string;
}

export interface StaleCacheReport {
  scannedAt: string;
  scanned: number;
  fresh: number;
  stale: number;
  orphaned: number;
  unavailable: number;
  findings: StaleCacheFinding[];
  prefixRecommendations: PrefixRecommendation[];
  health: 'OK' | 'DEGRADED' | 'CRITICAL';
}

export interface StaleCacheScanOptions {
  /** Restrict the scan to these keys (default: every live key). */
  keys?: string[];
  /** Custom equality; default compares a key-order-independent serialisation. */
  equals?: (cached: unknown, source: unknown) => boolean;
  /** Stale keys sharing a `prefix:` before a bulk invalidation is suggested. Default 10. */
  prefixThreshold?: number;
  /** Stale share of scanned entries at which health is CRITICAL. Default 0.5. */
  criticalRatio?: number;
}

export interface CacheRepairActor {
  id: string;
  permissions: readonly string[];
}

export interface CacheRepairOptions {
  /** Report what would happen without touching the cache. */
  dryRun?: boolean;
}

export interface CacheRepairOutcome {
  key: string;
  action: CacheRepairAction;
  result: 'applied' | 'planned' | 'skipped' | 'failed';
  reason?: string;
}

export const CACHE_REPAIR_PERMISSION = 'REPAIR_CACHE';

export class CacheRepairForbiddenError extends Error {
  constructor(actorId: string) {
    super(`${actorId} lacks ${CACHE_REPAIR_PERMISSION}`);
    this.name = 'CacheRepairForbiddenError';
  }
}

function stable(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
    .join(',')}}`;
}

const RECOMMENDATIONS: Record<StaleCacheFinding['status'], CacheRepairRecommendation> = {
  stale_version: {
    action: 'reload',
    description: 'Cached version is behind the source; reload the entry from the source.',
    automatable: true,
  },
  stale_value: {
    action: 'reload',
    description: 'Cached value differs from the source; reload the entry. Repeated findings for one key mean a write path skips invalidation.',
    automatable: true,
  },
  orphaned: {
    action: 'evict',
    description: 'Source record no longer exists; evict the entry so readers stop seeing it.',
    automatable: true,
  },
  source_unavailable: {
    action: 'retry_scan',
    description: 'Source lookup failed; entry left untouched (its TTL still bounds it). Retry the scan once the source recovers.',
    automatable: false,
  },
};

export class StaleCacheDetectorService {
  private readonly logger = new Logger(StaleCacheDetectorService.name);

  async scan<T>(
    cache: BoundedCacheService<T>,
    source: CacheSource<T>,
    options: StaleCacheScanOptions = {},
  ): Promise<StaleCacheReport> {
    const equals = options.equals ?? ((a: unknown, b: unknown) => stable(a) === stable(b));
    const now = Date.now();
    const findings: StaleCacheFinding[] = [];
    let scanned = 0;

    for (const key of options.keys ?? cache.keys()) {
      const entry = cache.getEntry(key);
      if (!entry || now > entry.expiresAt) continue; // expired entries are already misses
      scanned++;
      const ageMs = now - entry.createdAt;
      const cachedVersion = entry.metadata?.version as string | number | undefined;

      let record: CacheSourceRecord<T> | null;
      try {
        record = await source.load(key);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        findings.push({ key, status: 'source_unavailable', ageMs, cachedVersion, error, recommendation: RECOMMENDATIONS.source_unavailable });
        continue;
      }

      if (record === null) {
        findings.push({ key, status: 'orphaned', ageMs, cachedVersion, recommendation: RECOMMENDATIONS.orphaned });
        continue;
      }

      const bothVersioned = cachedVersion !== undefined && record.version !== undefined;
      if (bothVersioned && cachedVersion !== record.version) {
        findings.push({
          key,
          status: 'stale_version',
          ageMs,
          cachedVersion,
          sourceVersion: record.version,
          recommendation: RECOMMENDATIONS.stale_version,
        });
      } else if (!bothVersioned && !equals(entry.value, record.value)) {
        findings.push({ key, status: 'stale_value', ageMs, cachedVersion, sourceVersion: record.version, recommendation: RECOMMENDATIONS.stale_value });
      }
    }

    const stale = findings.filter((f) => f.status === 'stale_value' || f.status === 'stale_version').length;
    const orphaned = findings.filter((f) => f.status === 'orphaned').length;
    const unavailable = findings.filter((f) => f.status === 'source_unavailable').length;
    const criticalRatio = options.criticalRatio ?? 0.5;
    const health: StaleCacheReport['health'] =
      findings.length === 0 ? 'OK' : scanned > 0 && (stale + orphaned) / scanned >= criticalRatio ? 'CRITICAL' : 'DEGRADED';

    if (health !== 'OK') {
      this.logger.warn(`Stale cache scan: ${stale} stale, ${orphaned} orphaned, ${unavailable} unavailable of ${scanned}`);
    }

    return {
      scannedAt: new Date(now).toISOString(),
      scanned,
      fresh: scanned - findings.length,
      stale,
      orphaned,
      unavailable,
      findings,
      prefixRecommendations: this.prefixRecommendations(findings, options.prefixThreshold ?? 10),
      health,
    };
  }

  async repair<T>(
    cache: BoundedCacheService<T>,
    source: CacheSource<T>,
    report: StaleCacheReport,
    actor: CacheRepairActor,
    options: CacheRepairOptions = {},
  ): Promise<CacheRepairOutcome[]> {
    if (!actor.permissions.includes(CACHE_REPAIR_PERMISSION)) {
      throw new CacheRepairForbiddenError(actor.id);
    }

    const outcomes: CacheRepairOutcome[] = [];
    for (const finding of report.findings) {
      const { key } = finding;
      const action = finding.recommendation.action;
      if (!finding.recommendation.automatable) {
        outcomes.push({ key, action, result: 'skipped', reason: 'requires a new scan' });
        continue;
      }
      if (!cache.getEntry(key)) {
        outcomes.push({ key, action, result: 'skipped', reason: 'entry no longer cached' });
        continue;
      }
      if (options.dryRun) {
        outcomes.push({ key, action, result: 'planned' });
        continue;
      }

      try {
        // Re-read the source now: the scan's view may itself be outdated.
        const record = await source.load(key);
        if (record === null) {
          cache.delete(key);
          outcomes.push({ key, action: 'evict', result: 'applied' });
        } else {
          const metadata = { ...(cache.getEntry(key)?.metadata ?? {}), version: record.version };
          cache.set(key, record.value, undefined, metadata);
          outcomes.push({ key, action: 'reload', result: 'applied' });
        }
      } catch (err) {
        // Leave the entry in place; a failed source read must not cause a stampede of misses.
        outcomes.push({ key, action, result: 'failed', reason: err instanceof Error ? err.message : String(err) });
      }
    }

    this.logger.log(
      `Cache repair by ${actor.id}${options.dryRun ? ' (dry run)' : ''}: ` +
        `${outcomes.filter((o) => o.result === 'applied').length} applied, ` +
        `${outcomes.filter((o) => o.result === 'failed').length} failed`,
    );
    return outcomes;
  }

  private prefixRecommendations(findings: StaleCacheFinding[], threshold: number): PrefixRecommendation[] {
    const counts = new Map<string, number>();
    for (const finding of findings) {
      if (finding.status === 'source_unavailable') continue;
      const separator = finding.key.indexOf(':');
      if (separator <= 0) continue;
      const prefix = finding.key.slice(0, separator + 1);
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
    return [...counts.entries()]
      .filter(([, count]) => count >= threshold)
      .map(([prefix, staleKeys]) => ({
        prefix,
        staleKeys,
        description: `${staleKeys} stale entries under "${prefix}"; consider invalidatePrefix("${prefix}") and audit that prefix's write-path invalidation.`,
      }));
  }
}
