import { Injectable, Logger } from '@nestjs/common';
import {
  DEFAULT_STALE_AFTER_MS,
  PartialFailure,
  PartialFailureDashboard,
  PartialFailureGroup,
  PartialFailureInput,
  PartialFailureLinks,
  PartialFailureStatus,
} from './partial-failure.interface';

/** Remediation docs per operation kind — the "manual remediation" links. */
const REMEDIATION_DOCS: Record<string, string> = {
  'stellar.settlement': 'docs/runbook-degraded-providers.md#stellar-settlement',
  'oracle.ingestion': 'docs/oracle-challenge-lifecycle.md#failed-ingestion',
  'bond.issuance': 'docs/runbook-admin-intent.md#bond-issuance',
  'marketplace.order': 'docs/runbook-marketplace-reconciliation.md',
};

function remediationDoc(operationType: string): string {
  return REMEDIATION_DOCS[operationType] ?? 'docs/runbook-marketplace-reconciliation.md';
}

/**
 * Keys whose values must never reach the dashboard. Matching is
 * case-insensitive on the whole key name.
 */
const SECRET_KEY_PATTERN =
  /secret|password|privatekey|private_key|seed|mnemonic|token|apikey|api_key/i;

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1));
  if (value && typeof value === 'object') {
    const clean: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        clean[key] = '[redacted]';
      } else {
        clean[key] = scrub(val, depth + 1);
      }
    }
    return clean;
  }
  return value;
}

@Injectable()
export class PartialFailureService {
  private readonly logger = new Logger(PartialFailureService.name);
  private readonly failures = new Map<string, PartialFailure>();

  /**
   * Record a partially completed operation. Metadata is deep-scrubbed so
   * secret-shaped fields never reach the dashboard.
   */
  record(input: PartialFailureInput): PartialFailure {
    const now = input.now ?? Date.now();
    if (!input.operationType || !input.message) {
      throw new Error('operationType and message are required');
    }

    const failure: PartialFailure = {
      id: `pf_${input.operationType}_${now.toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
      operationType: input.operationType,
      externalRef: input.externalRef,
      message: input.message,
      severity: input.severity ?? 'warning',
      retryable: input.retryable ?? true,
      status: 'open',
      createdAt: new Date(now).toISOString(),
      lastFailureAt: new Date(now).toISOString(),
      retryCount: 0,
      metadata: (scrub(input.metadata ?? {}) ?? {}) as Record<string, unknown>,
    };
    this.failures.set(failure.id, failure);
    this.logger.warn(`partial failure recorded: ${input.operationType}`, {
      id: failure.id,
      externalRef: failure.externalRef,
    });
    return failure;
  }

  /** How many times this failure has been retried externally. */
  countExternalRetries(operationType: string, externalRef: string): number {
    let count = 0;
    for (const failure of this.failures.values()) {
      if (failure.operationType === operationType && failure.externalRef === externalRef) {
        count += failure.retryCount;
      }
    }
    return count;
  }

  get(id: string): PartialFailure {
    const failure = this.failures.get(id);
    if (!failure) throw new Error(`no partial failure ${id}`);
    return failure;
  }

  /** Resolve a failure after manual (or automatic) remediation. */
  resolve(id: string, note?: string, now: number = Date.now()): PartialFailure {
    const failure = this.get(id);
    failure.status = 'resolved';
    failure.resolvedAt = new Date(now).toISOString();
    failure.resolvedNote = note;
    return failure;
  }

  /** Manually ignore a failure (documented decision, hidden from the board). */
  ignore(id: string, note?: string, now: number = Date.now()): PartialFailure {
    const failure = this.get(id);
    failure.status = 'ignored';
    failure.ignoredAt = new Date(now).toISOString();
    failure.ignoredNote = note;
    return failure;
  }

  /** Mark a retry as attempted: bumps the counter and flips status. */
  markRetried(id: string, now: number = Date.now()): PartialFailure {
    const failure = this.get(id);
    failure.retryCount += 1;
    failure.status = 'retrying';
    failure.lastFailureAt = new Date(now).toISOString();
    return failure;
  }

  /**
   * Failures unresolved for longer than `staleAfterMs` (default 24h). These
   * are user-impacting and need a maintainer decision.
   */
  listStale(now: number = Date.now(), staleAfterMs = DEFAULT_STALE_AFTER_MS): PartialFailure[] {
    return this.list({ status: 'open' }, now).filter(
      (failure) => now - Date.parse(failure.createdAt) >= staleAfterMs,
    );
  }

  list(
    filter: { operationType?: string; status?: PartialFailureStatus; retryable?: boolean } = {},
    now: number = Date.now(),
  ): PartialFailure[] {
    const result: PartialFailure[] = [];
    for (const failure of this.failures.values()) {
      if (filter.operationType && failure.operationType !== filter.operationType) continue;
      if (filter.status && failure.status !== filter.status) continue;
      if (filter.retryable !== undefined && failure.retryable !== filter.retryable) continue;
      result.push(failure);
    }
    return result;
  }

  /**
   * Group unresolved (and recently resolved) failures by operation type for
   * the maintainer dashboard. Every row carries its age, staleness and the
   * retry/inspect/remediation links — no secrets.
   */
  dashboard(
    opts: { staleAfterMs?: number; now?: number } = {},
  ): PartialFailureDashboard {
    const now = opts.now ?? Date.now();
    const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;

    const byType = new Map<string, PartialFailure[]>();
    for (const failure of this.failures.values()) {
      if (failure.status === 'ignored') continue; // manually ignored: documented decision
      const bucket = byType.get(failure.operationType) ?? [];
      bucket.push(failure);
      byType.set(failure.operationType, bucket);
    }

    const groups: PartialFailureGroup[] = [];
    let unresolved = 0;
    for (const [operationType, bucket] of byType) {
      bucket.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      const byStatus = { open: 0, retrying: 0, resolved: 0, ignored: 0 };
      const bySeverity = { info: 0, warning: 0, critical: 0 };
      let retryable = 0;
      let oldestAgeMs: number | null = null;
      const rows = bucket.map((failure) => {
        const ageMs = now - Date.parse(failure.createdAt);
        byStatus[failure.status] += 1;
        bySeverity[failure.severity] += 1;
        if (failure.retryable) retryable += 1;
        if (failure.status !== 'resolved') unresolved += 1;
        if (oldestAgeMs === null || ageMs > oldestAgeMs) oldestAgeMs = ageMs;
        return {
          ...failure,
          ageMs,
          stale: failure.status !== 'resolved' && ageMs >= staleAfterMs,
          links: this.linksFor(failure),
        };
      });
      groups.push({
        operationType,
        total: bucket.length,
        byStatus,
        bySeverity,
        retryable,
        oldestAgeMs,
        failures: rows,
      });
    }
    groups.sort((a, b) => (b.oldestAgeMs ?? 0) - (a.oldestAgeMs ?? 0));

    return {
      generatedAt: new Date(now).toISOString(),
      unresolved,
      staleAfterMs,
      groups,
    };
  }

  linksFor(failure: PartialFailure): PartialFailureLinks {
    return {
      retry: failure.retryable && failure.status !== 'resolved'
        ? `POST /api/v1/operations/failures/${failure.id}/retry`
        : undefined,
      inspect: `GET /api/v1/operations/failures/${failure.id}`,
      remediationDoc: remediationDoc(failure.operationType),
    };
  }

  clear(): void {
    this.failures.clear();
  }
}
