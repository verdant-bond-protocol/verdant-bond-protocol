import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { stableStringify } from '../audit/audit.canonical';
import { PolicyService } from './policy.service';
import { PolicyConfiguration } from './policy.interface';

/** Audit chain that holds every administrative policy-configuration change (#408). */
export const POLICY_CONFIG_ENTITY_TYPE = 'admin-config';
export const POLICY_CONFIG_ENTITY_ID = 'policy';

export type PolicyConfigAction = 'policy.config.updated' | 'policy.config.rejected' | 'policy.config.rolled_back';

/** JSON-safe policy configuration: bigint amounts travel as integer strings. */
export type PolicyConfigSnapshot = Record<string, string | number | string[]>;

export interface PolicyConfigChangeRequest {
  /** Client-generated id; a retry with the same id and body returns the original outcome. */
  changeId: string;
  actor: string;
  reason: string;
  updates: Record<string, unknown>;
}

export interface PolicyConfigChangeOutcome {
  changeId: string;
  status: 'applied' | 'unchanged';
  changedKeys: string[];
  config: PolicyConfigSnapshot;
  /** Audit evidence for the change; null when nothing changed. */
  evidence: { sequence: number; hash: string } | null;
}

const BIGINT_KEYS = ['minSubscriptionAmount', 'maxSubscriptionAmount', 'maxTotalHoldings'] as const;
const NUMBER_KEYS = ['redeemptionPenaltyPercentage', 'earlyRedemptionMinDaysRemaining', 'maturityWarningDays'] as const;
const LIST_KEYS = ['restrictedJurisdictions', 'allowedTransitoryStates'] as const;
const EDITABLE_KEYS = new Set<string>([...BIGINT_KEYS, ...NUMBER_KEYS, ...LIST_KEYS]);

const INTEGER_STRING = /^\d+$/;
const JURISDICTION = /^[A-Za-z]{2,16}$/;
const MAX_CHANGE_ID_LENGTH = 128;
/** Retry window: outcomes kept for idempotent replay, oldest evicted first. */
const MAX_REMEMBERED_CHANGES = 5_000;
const MAX_REASON_LENGTH = 500;

/**
 * Administrative policy-configuration changes with audit evidence (#408).
 *
 * Every accepted change is recorded in the hash-chained audit trail
 * (`admin-config/policy`) with actor, reason, change id, changed keys and
 * full before/after snapshots *before* it takes effect — if the evidence
 * cannot be written, the change is refused. Rejected attempts by an
 * authorized admin are recorded too. Rollback re-applies a recorded `before`
 * snapshot as a new, evidenced change; history is never rewritten.
 *
 * Changes are serialized, so a concurrent change can never compute its
 * `before` snapshot from state another change is about to replace.
 */
@Injectable()
export class PolicyConfigChangeService {
  private queue: Promise<unknown> = Promise.resolve();
  /** changeId → fingerprint + outcome, in insertion order (oldest evicted first). */
  private readonly outcomes = new Map<string, { fingerprint: string; outcome: PolicyConfigChangeOutcome }>();

  constructor(
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
  ) {}

  getConfiguration(): PolicyConfigSnapshot {
    return toSnapshot(this.policy.getPolicyConfiguration());
  }

  apply(request: PolicyConfigChangeRequest): Promise<PolicyConfigChangeOutcome> {
    return this.serialized(async () => {
      const replay = this.replayed(request, 'policy.config.updated');
      if (replay) return replay;

      const before = this.policy.getPolicyConfiguration();
      let updates: Partial<PolicyConfiguration>;
      try {
        updates = parseUpdates(request.updates, before);
      } catch (error) {
        await this.recordRejection(request, before, error as Error);
        throw error;
      }
      return this.commit(request, 'policy.config.updated', before, updates, {});
    });
  }

  /**
   * Undo `targetChangeId`: the keys it changed get back the values they had
   * before it, as a new evidenced change. Keys it did not touch — including
   * later, unrelated changes — are left alone.
   */
  rollback(request: Omit<PolicyConfigChangeRequest, 'updates'> & { targetChangeId: string }): Promise<PolicyConfigChangeOutcome> {
    return this.serialized(async () => {
      const replay = this.replayed({ ...request, updates: { targetChangeId: request.targetChangeId } }, 'policy.config.rolled_back');
      if (replay) return replay;

      // Rollback trusts recorded snapshots, so the chain must verify first.
      const verification = await this.audit.verifyEntity(POLICY_CONFIG_ENTITY_TYPE, POLICY_CONFIG_ENTITY_ID);
      if (!verification.ok) {
        throw new ConflictException('Policy configuration audit chain failed verification; rollback refused');
      }
      const target = this.audit
        .getEntityHistory(POLICY_CONFIG_ENTITY_TYPE, POLICY_CONFIG_ENTITY_ID)
        .find((entry) => entry.action !== 'policy.config.rejected' && entry.after?.changeId === request.targetChangeId);
      if (!target?.before || !target.after) {
        throw new NotFoundException(`No applied policy change ${request.targetChangeId} to roll back`);
      }

      const before = this.policy.getPolicyConfiguration();
      const previous = fromSnapshot(target.before.config as PolicyConfigSnapshot) as Record<string, unknown>;
      const restored = Object.fromEntries(
        (target.after.changedKeys as string[]).map((key) => [key, previous[key]]),
      ) as Partial<PolicyConfiguration>;
      return this.commit(
        { ...request, updates: { targetChangeId: request.targetChangeId } },
        'policy.config.rolled_back',
        before,
        restored,
        { rolledBack: request.targetChangeId },
      );
    });
  }

  private async commit(
    request: PolicyConfigChangeRequest,
    action: PolicyConfigAction,
    before: PolicyConfiguration,
    updates: Partial<PolicyConfiguration>,
    extra: Record<string, string>,
  ): Promise<PolicyConfigChangeOutcome> {
    const beforeSnapshot = toSnapshot(before);
    const afterSnapshot = toSnapshot({ ...before, ...updates });
    const changedKeys = Object.keys(afterSnapshot)
      .filter((key) => stableStringify(afterSnapshot[key]) !== stableStringify(beforeSnapshot[key]))
      .sort();

    let evidence: PolicyConfigChangeOutcome['evidence'] = null;
    if (changedKeys.length > 0) {
      const written = await this.audit.record({
        entityType: POLICY_CONFIG_ENTITY_TYPE,
        entityId: POLICY_CONFIG_ENTITY_ID,
        action,
        actor: request.actor,
        reason: request.reason,
        before: { config: beforeSnapshot },
        after: { config: afterSnapshot, changeId: request.changeId, changedKeys, ...extra },
      });
      // No evidence, no change.
      if (written.kind !== 'recorded' || !written.record) {
        throw new ServiceUnavailableException(`Audit evidence could not be recorded (${written.rejectReason}); change not applied`);
      }
      this.policy.updatePolicyConfiguration(updates);
      evidence = { sequence: written.record.sequence, hash: written.record.hash };
    }

    const outcome: PolicyConfigChangeOutcome = {
      changeId: request.changeId,
      status: changedKeys.length > 0 ? 'applied' : 'unchanged',
      changedKeys,
      config: afterSnapshot,
      evidence,
    };
    this.outcomes.set(request.changeId, { fingerprint: fingerprintOf(request, action), outcome });
    if (this.outcomes.size > MAX_REMEMBERED_CHANGES) {
      this.outcomes.delete(this.outcomes.keys().next().value as string);
    }
    return outcome;
  }

  private async recordRejection(request: PolicyConfigChangeRequest, before: PolicyConfiguration, error: Error): Promise<void> {
    await this.audit.record({
      entityType: POLICY_CONFIG_ENTITY_TYPE,
      entityId: POLICY_CONFIG_ENTITY_ID,
      action: 'policy.config.rejected',
      actor: request.actor,
      reason: request.reason,
      before: { config: toSnapshot(before) },
      after: { changeId: request.changeId, error: error.message, attempted: toJsonSafe(request.updates) },
    });
  }

  /**
   * Validates the envelope and resolves a retry. Same id + same body returns
   * the original outcome without re-applying or re-recording; same id with a
   * different body is a conflict.
   */
  private replayed(request: PolicyConfigChangeRequest, action: PolicyConfigAction): PolicyConfigChangeOutcome | null {
    if (!request.changeId?.trim() || request.changeId.length > MAX_CHANGE_ID_LENGTH) {
      throw new BadRequestException(`changeId is required (at most ${MAX_CHANGE_ID_LENGTH} characters)`);
    }
    if (!request.reason?.trim() || request.reason.length > MAX_REASON_LENGTH) {
      throw new BadRequestException(`reason is required (at most ${MAX_REASON_LENGTH} characters)`);
    }
    const previous = this.outcomes.get(request.changeId);
    if (!previous) return null;
    if (previous.fingerprint !== fingerprintOf(request, action)) {
      throw new ConflictException(`changeId ${request.changeId} was already used for a different change`);
    }
    return previous.outcome;
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function fingerprintOf(request: PolicyConfigChangeRequest, action: PolicyConfigAction): string {
  return createHash('sha256')
    .update(stableStringify({ action, actor: request.actor, reason: request.reason, updates: toJsonSafe(request.updates) }))
    .digest('hex');
}

/** O(k) in the number of submitted keys; rejects unknown keys and wrong types instead of coercing. */
function parseUpdates(raw: Record<string, unknown>, current: PolicyConfiguration): Partial<PolicyConfiguration> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length === 0) {
    throw new BadRequestException('updates must be a non-empty object');
  }
  const updates: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!EDITABLE_KEYS.has(key)) throw new BadRequestException(`Unknown policy setting: ${key}`);
    if ((BIGINT_KEYS as readonly string[]).includes(key)) {
      if (typeof value !== 'string' || !INTEGER_STRING.test(value)) {
        throw new BadRequestException(`${key} must be a non-negative integer string`);
      }
      updates[key] = BigInt(value);
    } else if ((NUMBER_KEYS as readonly string[]).includes(key)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new BadRequestException(`${key} must be a non-negative number`);
      }
      if (key === 'redeemptionPenaltyPercentage' && value > 100) {
        throw new BadRequestException(`${key} must be at most 100`);
      }
      updates[key] = value;
    } else {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        throw new BadRequestException(`${key} must be an array of strings`);
      }
      if (key === 'restrictedJurisdictions' && value.some((item) => !JURISDICTION.test(item))) {
        throw new BadRequestException(`${key} entries must be letter-only jurisdiction codes`);
      }
      const items = key === 'restrictedJurisdictions' ? value.map((item) => item.toUpperCase()) : value;
      updates[key] = [...new Set(items)].sort();
    }
  }

  const merged = { ...current, ...updates } as PolicyConfiguration;
  if (
    merged.minSubscriptionAmount !== undefined &&
    merged.maxSubscriptionAmount !== undefined &&
    merged.minSubscriptionAmount > merged.maxSubscriptionAmount
  ) {
    throw new BadRequestException('minSubscriptionAmount must not exceed maxSubscriptionAmount');
  }
  return updates as Partial<PolicyConfiguration>;
}

function toSnapshot(config: PolicyConfiguration): PolicyConfigSnapshot {
  return toJsonSafe(config) as PolicyConfigSnapshot;
}

function fromSnapshot(snapshot: PolicyConfigSnapshot): PolicyConfiguration {
  const config: Record<string, unknown> = { ...snapshot };
  for (const key of BIGINT_KEYS) {
    if (typeof snapshot[key] === 'string') config[key] = BigInt(snapshot[key] as string);
  }
  return config as PolicyConfiguration;
}

/** bigint → decimal string, so snapshots can be hashed and serialized. */
function toJsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJsonSafe(item)]));
  }
  return value;
}
