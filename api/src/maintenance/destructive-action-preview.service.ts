import { createHash, randomUUID } from 'crypto';

/**
 * Dry-run previews for destructive maintainer actions (#529).
 *
 * A destructive action (archive, purge, reindex, revoke, reset, ...) is split
 * into two steps:
 *
 *   1. `preview()` runs only the action's read-only `plan()` and returns what
 *      would change: affected resources, reversibility, rollback notes and a
 *      `planDigest`. Nothing is mutated.
 *   2. `execute()` runs the action only for a preview that is unexpired,
 *      unconsumed, made by the same actor with the same parameters, confirmed
 *      by echoing its `planDigest`, and still matches a fresh plan. If the
 *      underlying state moved since the preview, execution is refused as
 *      `PREVIEW_STALE` and a new preview is required.
 *
 * Authorization is checked at both steps, so a permission revoked between
 * preview and execute blocks the execution.
 */

export type DestructiveChange = 'delete' | 'archive' | 'overwrite' | 'revoke' | 'reset';

export interface AffectedResource {
  kind: string;
  id: string;
  change: DestructiveChange;
  summary?: string;
}

export interface DestructiveActionPlan {
  affected: AffectedResource[];
  /** Whether the change can be undone after execution. */
  reversible: boolean;
  /** How to roll the change back (or why it cannot be). */
  rollback: string;
  warnings?: string[];
}

export interface DestructiveActionDefinition<P = unknown, R = unknown> {
  action: string;
  /** Permission the actor must hold to preview and to execute. */
  permission: string;
  /** Read-only: must not mutate state. */
  plan(params: P): DestructiveActionPlan | Promise<DestructiveActionPlan>;
  execute(params: P, plan: DestructiveActionPlan): R | Promise<R>;
  /**
   * Blast-radius cap. A plan touching more resources than this needs
   * `acknowledgeBlastRadius: true` at execution time.
   */
  maxAffected?: number;
}

export interface MaintainerActor {
  id: string;
  permissions: readonly string[];
}

export type PreviewRisk = 'none' | 'low' | 'high';

export interface DryRunPreview {
  previewId: string;
  action: string;
  actorId: string;
  paramsDigest: string;
  planDigest: string;
  affectedCount: number;
  /** First `sampleSize` affected resources, for display. */
  sample: AffectedResource[];
  reversible: boolean;
  rollback: string;
  warnings: string[];
  risk: PreviewRisk;
  requiresBlastRadiusAck: boolean;
  createdAt: string;
  expiresAt: string;
}

export interface ExecuteOptions {
  /** Must equal the preview's `planDigest`: proves the caller reviewed it. */
  confirmPlanDigest: string;
  acknowledgeBlastRadius?: boolean;
}

export interface ExecutionResult<R = unknown> {
  previewId: string;
  action: string;
  affectedCount: number;
  attempts: number;
  result: R;
}

export type DestructiveActionErrorCode =
  | 'UNKNOWN_ACTION'
  | 'FORBIDDEN'
  | 'PREVIEW_NOT_FOUND'
  | 'PREVIEW_EXPIRED'
  | 'PREVIEW_CONSUMED'
  | 'PREVIEW_ACTOR_MISMATCH'
  | 'PREVIEW_PARAMS_MISMATCH'
  | 'PREVIEW_NOT_CONFIRMED'
  | 'PREVIEW_STALE'
  | 'BLAST_RADIUS_NOT_ACKNOWLEDGED'
  | 'EXECUTION_IN_PROGRESS';

export class DestructiveActionError extends Error {
  constructor(public readonly code: DestructiveActionErrorCode, message: string) {
    super(message);
    this.name = 'DestructiveActionError';
  }
}

export interface DestructiveActionPreviewOptions {
  /** How long a preview stays executable. Default: 10 minutes. */
  ttlMs?: number;
  sampleSize?: number;
  now?: () => number;
}

interface StoredPreview {
  preview: DryRunPreview;
  expiresAtMs: number;
  consumed: boolean;
  inFlight: boolean;
  attempts: number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_SAMPLE_SIZE = 20;

export function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

export function digest(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function planDigestOf(plan: DestructiveActionPlan): string {
  const affected = [...plan.affected].sort((a, b) =>
    `${a.kind}:${a.id}:${a.change}`.localeCompare(`${b.kind}:${b.id}:${b.change}`),
  );
  return digest({ affected, reversible: plan.reversible });
}

export class DestructiveActionPreviewService {
  private readonly definitions = new Map<string, DestructiveActionDefinition<any, any>>();
  private readonly previews = new Map<string, StoredPreview>();
  private readonly ttlMs: number;
  private readonly sampleSize: number;
  private readonly now: () => number;

  constructor(options: DestructiveActionPreviewOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.sampleSize = options.sampleSize ?? DEFAULT_SAMPLE_SIZE;
    this.now = options.now ?? Date.now;
  }

  register<P, R>(definition: DestructiveActionDefinition<P, R>): void {
    if (this.definitions.has(definition.action)) {
      throw new Error(`Destructive action ${definition.action} is already registered`);
    }
    this.definitions.set(definition.action, definition);
  }

  async preview<P>(action: string, params: P, actor: MaintainerActor): Promise<DryRunPreview> {
    const definition = this.definitionFor(action);
    this.authorize(definition, actor);
    this.sweepExpired();

    const plan = await definition.plan(params);
    const createdAtMs = this.now();
    const expiresAtMs = createdAtMs + this.ttlMs;
    const warnings = [...(plan.warnings ?? [])];
    if (plan.affected.length === 0) warnings.push('No resources would change; execution is a no-op.');
    if (!plan.reversible) warnings.push('This change cannot be undone after execution.');
    const requiresBlastRadiusAck =
      definition.maxAffected !== undefined && plan.affected.length > definition.maxAffected;
    if (requiresBlastRadiusAck) {
      warnings.push(
        `Affects ${plan.affected.length} resources, above the cap of ${definition.maxAffected}; ` +
          'execution must acknowledge the blast radius.',
      );
    }

    const preview: DryRunPreview = {
      previewId: randomUUID(),
      action,
      actorId: actor.id,
      paramsDigest: digest(params),
      planDigest: planDigestOf(plan),
      affectedCount: plan.affected.length,
      sample: plan.affected.slice(0, this.sampleSize),
      reversible: plan.reversible,
      rollback: plan.rollback,
      warnings,
      risk: plan.affected.length === 0 ? 'none' : !plan.reversible || requiresBlastRadiusAck ? 'high' : 'low',
      requiresBlastRadiusAck,
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
    this.previews.set(preview.previewId, { preview, expiresAtMs, consumed: false, inFlight: false, attempts: 0 });
    return preview;
  }

  async execute<P, R = unknown>(
    previewId: string,
    action: string,
    params: P,
    actor: MaintainerActor,
    options: ExecuteOptions,
  ): Promise<ExecutionResult<R>> {
    const definition = this.definitionFor(action) as DestructiveActionDefinition<P, R>;
    const stored = this.previews.get(previewId);
    if (!stored || stored.preview.action !== action) {
      throw new DestructiveActionError('PREVIEW_NOT_FOUND', `No preview ${previewId} for ${action}`);
    }
    if (stored.consumed) {
      throw new DestructiveActionError('PREVIEW_CONSUMED', `Preview ${previewId} was already executed`);
    }
    if (stored.inFlight) {
      throw new DestructiveActionError('EXECUTION_IN_PROGRESS', `Preview ${previewId} is executing`);
    }
    if (this.now() > stored.expiresAtMs) {
      this.previews.delete(previewId);
      throw new DestructiveActionError('PREVIEW_EXPIRED', `Preview ${previewId} expired; request a new preview`);
    }
    if (stored.preview.actorId !== actor.id) {
      throw new DestructiveActionError('PREVIEW_ACTOR_MISMATCH', 'Only the maintainer who previewed may execute');
    }
    this.authorize(definition, actor);
    if (digest(params) !== stored.preview.paramsDigest) {
      throw new DestructiveActionError('PREVIEW_PARAMS_MISMATCH', 'Parameters differ from the previewed ones');
    }
    if (options.confirmPlanDigest !== stored.preview.planDigest) {
      throw new DestructiveActionError('PREVIEW_NOT_CONFIRMED', 'confirmPlanDigest does not match the preview');
    }
    if (stored.preview.requiresBlastRadiusAck && options.acknowledgeBlastRadius !== true) {
      throw new DestructiveActionError(
        'BLAST_RADIUS_NOT_ACKNOWLEDGED',
        `Preview affects ${stored.preview.affectedCount} resources; acknowledgeBlastRadius is required`,
      );
    }

    stored.inFlight = true;
    try {
      const plan = await definition.plan(params);
      if (planDigestOf(plan) !== stored.preview.planDigest) {
        this.previews.delete(previewId);
        throw new DestructiveActionError(
          'PREVIEW_STALE',
          'State changed since the preview was made; review a new preview before executing',
        );
      }
      stored.attempts += 1;
      const result = await definition.execute(params, plan);
      stored.consumed = true;
      return { previewId, action, affectedCount: plan.affected.length, attempts: stored.attempts, result };
    } finally {
      // A failed execution leaves the preview executable (retry) until it
      // expires; a successful one is consumed and cannot run twice.
      stored.inFlight = false;
    }
  }

  getPreview(previewId: string): DryRunPreview | undefined {
    return this.previews.get(previewId)?.preview;
  }

  private definitionFor(action: string): DestructiveActionDefinition<any, any> {
    const definition = this.definitions.get(action);
    if (!definition) throw new DestructiveActionError('UNKNOWN_ACTION', `Unknown destructive action ${action}`);
    return definition;
  }

  private authorize(definition: DestructiveActionDefinition<any, any>, actor: MaintainerActor): void {
    if (!actor.permissions.includes(definition.permission)) {
      throw new DestructiveActionError(
        'FORBIDDEN',
        `${actor.id} lacks ${definition.permission} required for ${definition.action}`,
      );
    }
  }

  private sweepExpired(): void {
    const now = this.now();
    for (const [id, stored] of this.previews) {
      if ((stored.consumed || now > stored.expiresAtMs) && !stored.inFlight) this.previews.delete(id);
    }
  }
}
