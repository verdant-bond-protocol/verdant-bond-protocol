import { createHash } from 'node:crypto';
import { Permission } from '../../auth/rbac';
import {
  ReconciliationDrift,
  ReconciliationInvariant,
  ReconciliationReport,
} from '../interfaces/reconciliation.interface';

/**
 * Reconciliation between authoritative source state and cached state (#507).
 *
 * Read paths serve bonds, holders, and projects from Redis caches that are
 * filled from the source of truth (contract state / registry). When a write
 * path forgets to invalidate, or a cache write half-succeeds, the cache
 * drifts silently. This module:
 *
 *   1. diffs source entries against cached entries and classifies every key
 *      as missing, stale, orphaned, duplicate, or ahead-of-source;
 *   2. builds a repair plan (set / delete) that the cache can be brought to
 *      with — source always wins, except where the cache is *ahead* of the
 *      source, which is reported but never auto-repaired;
 *   3. applies the plan with per-action retry, journalling the prior cached
 *      value of every key so a failure part-way through is rolled back; and
 *   4. adapts itself as a `ReconciliationInvariant`, so the existing
 *      `ReconciliationService` dry-run / job flow picks it up unchanged.
 *
 * Applying is dry-run by default and requires `Permission.RECONCILE_CACHE`.
 */

export interface SourceEntry {
  key: string;
  value: unknown;
  /** Monotonic version (ledger sequence, updatedAt millis, ...), when known. */
  version?: number;
}

export type CachedEntry = SourceEntry;

export type CacheRepairReason = 'missing' | 'stale' | 'orphaned';

export type CacheRepairAction =
  | { kind: 'set'; key: string; value: unknown; version?: number; reason: Exclude<CacheRepairReason, 'orphaned'> }
  | { kind: 'delete'; key: string; reason: 'orphaned' };

export interface CacheDiff {
  entityType: string;
  totalEntitiesChecked: number;
  drifts: ReconciliationDrift[];
  plan: CacheRepairAction[];
}

/** Minimal cache surface; RedisService-backed adapters implement this. */
export interface CacheStore {
  get(key: string): Promise<CachedEntry | undefined>;
  set(key: string, entry: CachedEntry): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface CacheRepairActor {
  userId: string;
  permissions: readonly Permission[];
}

export interface ApplyCacheRepairOptions {
  actor: CacheRepairActor;
  /** Default `true`: report what would change and write nothing. */
  dryRun?: boolean;
  /** Attempts per action, including the first. Default 3, clamped to [1, 10]. */
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type CacheRepairStatus = 'dry-run' | 'applied' | 'rolled-back' | 'rollback-failed';

export interface CacheRepairResult {
  status: CacheRepairStatus;
  actorUserId: string;
  planned: number;
  applied: number;
  /** Total retries spent across all actions. */
  retries: number;
  error?: string;
  /** Keys whose prior value could not be restored; need manual attention. */
  unrestoredKeys?: string[];
}

export class CacheRepairForbiddenError extends Error {
  constructor(userId: string) {
    super(`actor ${userId} lacks ${Permission.RECONCILE_CACHE}`);
    this.name = 'CacheRepairForbiddenError';
  }
}

/** Errors may set `retryable: false` to skip retries (e.g. Redis NOPERM). */
type MaybeRetryable = { retryable?: boolean };

const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_ATTEMPTS_CAP = 10;
const DEFAULT_BASE_DELAY_MS = 50;

/** Key-order-independent digest so `{a,b}` and `{b,a}` compare equal. */
export function canonicalDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
}

function indexByKey(entries: SourceEntry[]): { byKey: Map<string, SourceEntry>; duplicates: Set<string> } {
  const byKey = new Map<string, SourceEntry>();
  const duplicates = new Set<string>();
  for (const entry of entries) {
    if (byKey.has(entry.key)) duplicates.add(entry.key);
    else byKey.set(entry.key, entry);
  }
  return { byKey, duplicates };
}

export function diffSourceAndCache(entityType: string, source: SourceEntry[], cached: CachedEntry[]): CacheDiff {
  const drifts: ReconciliationDrift[] = [];
  const plan: CacheRepairAction[] = [];
  const src = indexByKey(source);
  const cache = indexByKey(cached);

  // A duplicated source key means the source itself is ambiguous: we cannot
  // tell which value is authoritative, so the key is reported and skipped.
  for (const key of src.duplicates) {
    drifts.push({
      type: 'duplicate',
      severity: 'HIGH',
      entityType,
      entityId: key,
      description: `source returned key ${key} more than once; cache left untouched`,
      repairSuggestion: 'Fix the source query/loader, then re-run reconciliation',
    });
  }

  for (const [key, entry] of src.byKey) {
    if (src.duplicates.has(key)) continue;
    const hit = cache.byKey.get(key);

    if (!hit) {
      drifts.push({
        type: 'missing',
        severity: 'LOW',
        entityType,
        entityId: key,
        description: `cache has no entry for ${key}`,
        repairSuggestion: 'Populate cache from source',
      });
      plan.push({ kind: 'set', key, value: entry.value, version: entry.version, reason: 'missing' });
      continue;
    }

    // Cache newer than source: usually the source read lagged (indexer behind,
    // replica lag). Overwriting would roll the cache *back*, so flag only.
    if (entry.version !== undefined && hit.version !== undefined && hit.version > entry.version) {
      drifts.push({
        type: 'inconsistent',
        severity: 'HIGH',
        entityType,
        entityId: key,
        description: `cache version ${hit.version} is ahead of source version ${entry.version}`,
        expectedValue: entry.version,
        actualValue: hit.version,
        repairSuggestion: 'Check source freshness (indexer/replica lag) before repairing; not auto-repaired',
      });
      continue;
    }

    const versionBehind = entry.version !== undefined && hit.version !== undefined && hit.version < entry.version;
    if (versionBehind || canonicalDigest(entry.value) !== canonicalDigest(hit.value) || cache.duplicates.has(key)) {
      drifts.push({
        type: 'stale',
        severity: 'MEDIUM',
        entityType,
        entityId: key,
        description: versionBehind
          ? `cache version ${hit.version} is behind source version ${entry.version}`
          : `cached value for ${key} differs from source`,
        expectedValue: entry.version,
        actualValue: hit.version,
        repairSuggestion: 'Overwrite cache entry from source',
      });
      plan.push({ kind: 'set', key, value: entry.value, version: entry.version, reason: 'stale' });
    }
  }

  for (const key of cache.byKey.keys()) {
    if (src.byKey.has(key)) continue;
    drifts.push({
      type: 'orphaned',
      severity: 'LOW',
      entityType,
      entityId: key,
      description: `cache holds ${key} which no longer exists in source`,
      repairSuggestion: 'Evict cache entry',
    });
    plan.push({ kind: 'delete', key, reason: 'orphaned' });
  }

  return { entityType, totalEntitiesChecked: new Set([...src.byKey.keys(), ...cache.byKey.keys()]).size, drifts, plan };
}

/** Shape a diff as the existing reconciliation report contract. */
export function toReconciliationReport(diff: CacheDiff, dryRun: boolean, now: Date = new Date()): ReconciliationReport {
  const count = (type: ReconciliationDrift['type']) => diff.drifts.filter((drift) => drift.type === type).length;
  const status = diff.drifts.length === 0
    ? 'HEALTHY'
    : diff.drifts.some((drift) => drift.severity === 'CRITICAL' || drift.type === 'inconsistent')
    ? 'CRITICAL'
    : 'DEGRADED';
  return {
    timestamp: now,
    dryRun,
    totalEntitiesChecked: diff.totalEntitiesChecked,
    status,
    driftsFound: diff.drifts,
    summary: {
      missingCount: count('missing'),
      orphanedCount: count('orphaned'),
      duplicateCount: count('duplicate'),
      staleCount: count('stale'),
      inconsistentCount: count('inconsistent'),
    },
  };
}

/** Plug a source/cache pair into `ReconciliationService.registerInvariant`. */
export function cacheReconciliationInvariant(
  entityType: string,
  loadSource: () => Promise<SourceEntry[]>,
  loadCache: () => Promise<CachedEntry[]>,
): ReconciliationInvariant {
  return {
    name: `CACHE_CONSISTENCY_${entityType.toUpperCase()}`,
    description: `Cached ${entityType} entries match the authoritative source`,
    check: async () => diffSourceAndCache(entityType, await loadSource(), await loadCache()).drifts,
  };
}

async function withRetry<T>(
  operation: () => Promise<T>,
  maxAttempts: number,
  baseDelayMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<{ value: T; retries: number }> {
  for (let attempt = 1; ; attempt++) {
    try {
      return { value: await operation(), retries: attempt - 1 };
    } catch (error) {
      if ((error as MaybeRetryable)?.retryable === false || attempt >= maxAttempts) throw error;
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
}

/**
 * Apply a repair plan to `store`. All-or-nothing: if any action still fails
 * after retries, every action already applied is reverted (newest first) to
 * the value journalled before it was written.
 */
export async function applyCacheRepairPlan(
  plan: CacheRepairAction[],
  store: CacheStore,
  options: ApplyCacheRepairOptions,
): Promise<CacheRepairResult> {
  const { actor } = options;
  if (!actor?.permissions?.includes(Permission.RECONCILE_CACHE)) {
    throw new CacheRepairForbiddenError(actor?.userId ?? 'anonymous');
  }

  const base: CacheRepairResult = { status: 'dry-run', actorUserId: actor.userId, planned: plan.length, applied: 0, retries: 0 };
  if (options.dryRun !== false) return base;

  const maxAttempts = Math.min(Math.max(Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS), 1), MAX_ATTEMPTS_CAP);
  const baseDelayMs = Math.max(options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS, 0);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const journal: Array<{ key: string; prior: CachedEntry | undefined }> = [];
  let retries = 0;

  for (const action of plan) {
    try {
      const prior = await withRetry(() => store.get(action.key), maxAttempts, baseDelayMs, sleep);
      retries += prior.retries;
      const write = await withRetry(
        () =>
          action.kind === 'set'
            ? store.set(action.key, { key: action.key, value: action.value, version: action.version })
            : store.delete(action.key),
        maxAttempts,
        baseDelayMs,
        sleep,
      );
      retries += write.retries;
      journal.push({ key: action.key, prior: prior.value });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const unrestoredKeys: string[] = [];
      for (const { key, prior } of [...journal].reverse()) {
        try {
          await withRetry(
            () => (prior === undefined ? store.delete(key) : store.set(key, prior)),
            maxAttempts,
            baseDelayMs,
            sleep,
          );
        } catch {
          unrestoredKeys.push(key);
        }
      }
      return {
        ...base,
        status: unrestoredKeys.length ? 'rollback-failed' : 'rolled-back',
        applied: 0,
        retries,
        error: `repair of ${action.key} failed: ${message}`,
        ...(unrestoredKeys.length ? { unrestoredKeys } : {}),
      };
    }
  }

  return { ...base, status: 'applied', applied: journal.length, retries };
}
