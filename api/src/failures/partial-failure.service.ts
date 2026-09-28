import { Injectable, Logger, Optional } from '@nestjs/common';
import { NotificationsService } from '../notifications/notifications.service';
import {
  DEFAULT_STALE_AFTER_MS,
  DependencyGraph,
  FailureTrendExport,
  PartialFailureListFilter,
  PartialFailure,
  PartialFailureDashboard,
  PartialFailureGroup,
  PartialFailureInput,
  PartialFailureLinks,
  PartialFailureStatus,
  RejectedOperationExplanation,
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
  /secret|password|passphrase|privatekey|private_key|seed|mnemonic|token|apikey|api_key/i;

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

  constructor(@Optional() private readonly notificationsService?: NotificationsService) {}

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

    if (failure.severity === 'warning' || failure.severity === 'critical') {
      this.notificationsService?.createNotification({
        userId: 'admin', // assuming this is a system admin notification
        type: 'PARTIAL_FAILURE',
        message: `Partial failure in ${failure.operationType}: ${failure.message}`,
        eventId: `pf_${failure.operationType}_${failure.externalRef || failure.id}`,
        link: `/admin/failures/${failure.id}`
      });
    }

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
    filter: PartialFailureListFilter = {},
    now: number = Date.now(),
  ): PartialFailure[] {
    const result: PartialFailure[] = [];
    for (const failure of this.failures.values()) {
      if (filter.operationType && failure.operationType !== filter.operationType) continue;
      if (filter.status && failure.status !== filter.status) continue;
      if (filter.severity && failure.severity !== filter.severity) continue;
      if (filter.retryable !== undefined && failure.retryable !== filter.retryable) continue;
      if (filter.externalRef && failure.externalRef !== filter.externalRef) continue;
      if (filter.minRetryCount !== undefined && failure.retryCount < filter.minRetryCount) continue;
      if (filter.createdAfter && Date.parse(failure.createdAt) < Date.parse(filter.createdAfter)) continue;
      if (filter.createdBefore && Date.parse(failure.createdAt) > Date.parse(filter.createdBefore)) continue;
      if (filter.staleOnly && now - Date.parse(failure.createdAt) < DEFAULT_STALE_AFTER_MS) continue;
      if (filter.text) {
        const needle = filter.text.toLowerCase();
        const haystack = `${failure.operationType} ${failure.externalRef ?? ''} ${failure.message} ${JSON.stringify(failure.metadata)}`.toLowerCase();
        if (!haystack.includes(needle)) continue;
      }
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
    opts: { staleAfterMs?: number; now?: number; filter?: PartialFailureListFilter } = {},
  ): PartialFailureDashboard {
    const now = opts.now ?? Date.now();
    const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;

    const byType = new Map<string, PartialFailure[]>();
    for (const failure of this.list(opts.filter ?? {}, now)) {
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

  explainRejectedOperation(code: string, context: Record<string, unknown> = {}): RejectedOperationExplanation {
    const normalized = String(code || 'unknown').toLowerCase();
    const known: Record<string, Omit<RejectedOperationExplanation, 'supportReference'>> = {
      kyc_required: {
        code: 'kyc_required',
        title: 'Identity verification is required',
        userMessage: 'This operation cannot continue until the account completes identity verification.',
        nextActions: ['Complete verification from account settings.', 'Retry the operation after verification is approved.'],
        retryable: true,
      },
      insufficient_balance: {
        code: 'insufficient_balance',
        title: 'Insufficient balance',
        userMessage: 'The wallet does not have enough spendable balance for this operation and network fees.',
        nextActions: ['Add funds to the wallet.', 'Confirm no pending operation is reserving the same balance.', 'Retry after the ledger reflects the new balance.'],
        retryable: true,
      },
      policy_denied: {
        code: 'policy_denied',
        title: 'Operation rejected by policy',
        userMessage: 'A protocol policy prevented this request from being accepted.',
        nextActions: ['Review the request details.', 'Contact support if the policy result looks incorrect.'],
        retryable: false,
      },
    };
    const explanation = known[normalized] ?? {
      code: normalized || 'unknown',
      title: 'Operation rejected',
      userMessage: 'The operation was rejected before it could be submitted.',
      nextActions: ['Review the request details.', 'Retry only after correcting the highlighted issue.'],
      retryable: false,
    };

    return {
      ...explanation,
      supportReference: typeof context.supportReference === 'string'
        ? context.supportReference
        : undefined,
    };
  }

  dependencyGraph(rootId?: string, now: number = Date.now()): DependencyGraph {
    const nodes = new Map<string, DependencyGraph['nodes'][number]>();
    const edges: DependencyGraph['edges'] = [];
    const impactedFailures = new Set<string>();

    const addNode = (id: string, kind: string, label: string, failure?: PartialFailure) => {
      if (!nodes.has(id)) {
        nodes.set(id, {
          id,
          kind,
          label,
          status: failure?.status,
          severity: failure?.severity,
        });
      }
    };

    for (const failure of this.failures.values()) {
      const failureNode = `failure:${failure.id}`;
      addNode(failureNode, 'failure', failure.message, failure);
      const operationNode = `operation:${failure.operationType}`;
      addNode(operationNode, 'operation', failure.operationType);
      edges.push({ from: operationNode, to: failureNode, relation: 'has_failure' });

      if (failure.externalRef) {
        const externalNode = `external:${failure.externalRef}`;
        addNode(externalNode, 'external_ref', failure.externalRef);
        edges.push({ from: failureNode, to: externalNode, relation: 'references' });
      }

      const dependencies = Array.isArray(failure.metadata?.dependsOn)
        ? failure.metadata.dependsOn
        : [];
      for (const dependency of dependencies) {
        const dependencyId = String(dependency);
        const dependencyNode = `resource:${dependencyId}`;
        addNode(dependencyNode, 'resource', dependencyId);
        edges.push({ from: failureNode, to: dependencyNode, relation: 'depends_on' });
        if (!rootId || dependencyNode === rootId || dependencyId === rootId) {
          impactedFailures.add(failure.id);
        }
      }

      if (!rootId || failureNode === rootId || operationNode === rootId || failure.externalRef === rootId) {
        impactedFailures.add(failure.id);
      }
    }

    return {
      generatedAt: new Date(now).toISOString(),
      nodes: [...nodes.values()],
      edges,
      impactedFailures: [...impactedFailures],
    };
  }

  trendExport(opts: {
    bucketMs?: number;
    format?: 'json' | 'csv';
    from?: number;
    to?: number;
    now?: number;
  } = {}): FailureTrendExport {
    const bucketMs = opts.bucketMs ?? 24 * 60 * 60 * 1000;
    const format = opts.format ?? 'json';
    const now = opts.now ?? Date.now();
    const failures = [...this.failures.values()].filter((failure) => {
      const created = Date.parse(failure.createdAt);
      if (opts.from !== undefined && created < opts.from) return false;
      if (opts.to !== undefined && created > opts.to) return false;
      return true;
    });

    const buckets = new Map<number, FailureTrendExport['buckets'][number]>();
    for (const failure of failures) {
      const created = Date.parse(failure.createdAt);
      const start = Math.floor(created / bucketMs) * bucketMs;
      const bucket = buckets.get(start) ?? {
        bucketStart: new Date(start).toISOString(),
        bucketEnd: new Date(start + bucketMs).toISOString(),
        total: 0,
        unresolved: 0,
        retryable: 0,
        bySeverity: { info: 0, warning: 0, critical: 0 },
        byStatus: { open: 0, retrying: 0, resolved: 0, ignored: 0 },
      };
      bucket.total += 1;
      if (failure.status !== 'resolved' && failure.status !== 'ignored') bucket.unresolved += 1;
      if (failure.retryable) bucket.retryable += 1;
      bucket.bySeverity[failure.severity] += 1;
      bucket.byStatus[failure.status] += 1;
      buckets.set(start, bucket);
    }

    const sorted = [...buckets.entries()].sort(([a], [b]) => a - b).map(([, bucket]) => bucket);
    const csv = format === 'csv'
      ? [
          'bucketStart,bucketEnd,total,unresolved,retryable,info,warning,critical,open,retrying,resolved,ignored',
          ...sorted.map((bucket) => [
            bucket.bucketStart,
            bucket.bucketEnd,
            bucket.total,
            bucket.unresolved,
            bucket.retryable,
            bucket.bySeverity.info,
            bucket.bySeverity.warning,
            bucket.bySeverity.critical,
            bucket.byStatus.open,
            bucket.byStatus.retrying,
            bucket.byStatus.resolved,
            bucket.byStatus.ignored,
          ].join(',')),
        ].join('\n')
      : undefined;

    return {
      generatedAt: new Date(now).toISOString(),
      format,
      bucketMs,
      buckets: sorted,
      csv,
    };
  }

  clear(): void {
    this.failures.clear();
  }
}
