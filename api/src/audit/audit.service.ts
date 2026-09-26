import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHash } from 'crypto';
import { AuditRecord } from './interfaces/audit.interface';
import {
  AuditChainStep,
  AuditWrite,
  AuditWriteResult,
} from './classes/audit.classes';

export class AuditChainState {
  lastHash: string = null;
  lastSequence = 0;
  entries: AuditRecord[] = [];
  expired = 0;
}

export class VerificationFailure {
  ok: false;
  failedIndex: number;
  reason: string;
  expected: string;
  actual: string;
}

export class VerificationReport {
  ok = true;
  started = 0;
  finished = 0;
  checkedEntries = 0;
  failures: VerificationFailure[] = [];
}

/**
 * Bounds for the in-memory chain so a stream of distinct entity ids cannot
 * grow the store without bound. Matches the sizing rationale of
 * `oracle-incident.repository.ts` (#95): audit history is durable data, so it
 * belongs in Postgres; until that storage lands, the in-memory chain keeps its
 * footprint bounded and records how much it dropped.
 */
const MAX_TOTAL_ENTRIES = 10_000;
const MAX_ENTRIES_PER_ENTITY = 5_000;

/**
 * Append-only, hash-chained change history for critical domain records
 * (issue #260).
 *
 * Each entry hashes { entityId, entityType, action, actor, reason, sequence,
 * previousHash, recordedAt, before, after } with SHA-256. The chain is
 * per-entity: `previousHash` links entry N to entry N-1 for the same entity,
 * and `sequence` is that entity's monotonic counter. The two mechanisms catch
 * different tampering (see `verifyEntity`):
 *
 * - a rebuilt value-hash catches ALTERED before/after payloads,
 * - the hash chain catches a REPLACED history set, since an attacker cannot
 *   reconstruct matching hashes without knowing the chain head,
 * - the sequence check catches DROPPED or REORDERED entries even if the hash
 *   values themselves were recomputed around the edit.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  private readonly chains = new Map<string, AuditChainState>();
  private totalEntries = 0;
  private totalExpired = 0;
  private droppedWrites = 0;

  async record(write: AuditWrite): Promise<AuditWriteResult> {
    if (!write || typeof write.entityId !== 'string' || write.entityId.length === 0) {
      const fail = new AuditWriteResult();
      fail.kind = 'rejected';
      fail.rejectReason = 'entityId is required';
      fail.record = null;
      return fail;
    }
    if (!write.action) {
      const fail = new AuditWriteResult();
      fail.kind = 'rejected';
      fail.rejectReason = 'action is required';
      fail.record = null;
      return fail;
    }
    if (!write.actor) {
      const fail = new AuditWriteResult();
      fail.kind = 'rejected';
      fail.rejectReason = 'actor is required';
      fail.record = null;
      return fail;
    }

    const key = this.entityKey(write.entityType, write.entityId);
    const state = this.getOrCreateChain(key);

    if (state.entries.length >= MAX_ENTRIES_PER_ENTITY) {
      this.dropOldest(key);
    }
    if (this.totalEntries >= MAX_TOTAL_ENTRIES) {
      this.droppedWrites++;
      this.logger.warn(
        `audit chain at capacity (${MAX_TOTAL_ENTRIES} entries); dropping write for ${key}`,
      );
      const fail = new AuditWriteResult();
      fail.kind = 'rejected';
      fail.rejectReason = 'audit chain at capacity';
      fail.record = null;
      return fail;
    }

    const entry: AuditRecord = {
      sequence: state.lastSequence + 1,
      recordId: write.entityType ? randomUUID() : randomUUID(),
      entityType: write.entityType,
      entityId: write.entityId,
      action: write.action,
      actor: write.actor,
      reason: write.reason,
      before: write.before ?? null,
      after: write.after ?? null,
      recordedAt: new Date().toISOString(),
      previousHash: state.lastHash,
      hash: '',
    };
    entry.hash = this.computeEntryHash(entry);

    state.entries.push(entry);
    state.lastSequence = entry.sequence;
    state.lastHash = entry.hash;
    this.totalEntries++;

    const result = new AuditWriteResult();
    result.kind = 'recorded';
    result.record = entry;
    return result;
  }

  /**
   * Verify one entity's history in place. `strict` also rejects a chain whose
   * stored sequence is discontinuous (dropped steps).
   */
  async verifyEntity(entityType: string, entityId: string, strict = true): Promise<VerificationReport> {
    const report = new VerificationReport();
    const state = this.chains.get(this.entityKey(entityType, entityId));

    if (!state) {
      report.ok = true;
      report.checkedEntries = 0;
      return report;
    }

    const entries = state.entries;
    report.checkedEntries = entries.length;
    report.started = entries.length ? 1 : 0;

    let previousHash: string = null;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];

      if (previousHash !== null && entry.previousHash !== previousHash) {
        this.pushFailure(report, i, 'previous hash mismatch', previousHash, entry.previousHash);
      }
      if (strict) {
        if (i > 0 && entry.sequence !== entries[i - 1].sequence + 1) {
          this.pushFailure(report, i, 'sequence break', String(entries[i - 1].sequence + 1), String(entry.sequence));
        }
        if (i === 0 && entry.sequence !== 1) {
          this.pushFailure(report, i, 'first entry sequence must be 1', '1', String(entry.sequence));
        }
      }

      const rebuilt = this.computeEntryHash(entry);
      if (rebuilt !== entry.hash) {
        this.pushFailure(report, i, 'content hash mismatch', entry.hash, rebuilt);
      }

      previousHash = entry.hash;
    }

    report.finished = entries.length;
    report.ok = report.failures.length === 0;
    return report;
  }

  getEntityHistory(entityType: string, entityId: string): AuditRecord[] {
    const state = this.chains.get(this.entityKey(entityType, entityId));
    return state ? [...state.entries] : [];
  }

  getChainHead(entityType: string, entityId: string): string | null {
    const state = this.chains.get(this.entityKey(entityType, entityId));
    return state ? state.lastHash : null;
  }

  getStats() {
    return {
      trackedEntities: this.chains.size,
      totalEntries: this.totalEntries,
      totalExpired: this.totalExpired,
      droppedWrites: this.droppedWrites,
      maxTotalEntries: MAX_TOTAL_ENTRIES,
      maxEntriesPerEntity: MAX_ENTRIES_PER_ENTITY,
    };
  }

  clear(): void {
    this.chains.clear();
    this.totalEntries = 0;
    this.totalExpired = 0;
    this.droppedWrites = 0;
  }

  /** Test seam: drop one entry without touching hashes, to prove detection. */
  removeEntryAt(entityType: string, entityId: string, index: number): boolean {
    const state = this.chains.get(this.entityKey(entityType, entityId));
    if (!state || index < 0 || index >= state.entries.length) return false;
    state.entries.splice(index, 1);
    this.totalEntries--;
    return true;
  }

  private pushFailure(
    report: VerificationReport,
    index: number,
    reason: string,
    expected: string,
    actual: string,
  ): void {
    const failure = new VerificationFailure();
    failure.ok = false;
    failure.failedIndex = index;
    failure.reason = reason;
    failure.expected = expected;
    failure.actual = actual;
    report.failures.push(failure);
  }

  private getOrCreateChain(key: string): AuditChainState {
    let state = this.chains.get(key);
    if (!state) {
      state = new AuditChainState();
      this.chains.set(key, state);
    }
    return state;
  }

  private entityKey(entityType: string, entityId: string): string {
    return `${entityType}:${entityId}`;
  }

  private dropOldest(key: string): void {
    const state = this.chains.get(key);
    if (!state) return;
    state.entries.shift();
    state.lastSequence = state.entries.length;
    state.lastHash = state.entries.length ? state.entries[state.entries.length - 1].hash : null;
    this.totalEntries--;
    this.totalExpired++;
  }

  /**
   * Stable digest of one entry. Excludes `recordId` (a random uuid that cannot
   * be reproduced on re-verification) but includes everything else, including
   * the recordedAt timestamp — so a tampered entry must recompute the hash,
   * which `previousHash` chaining makes fail loudly at the next entry.
   */
  private computeEntryHash(entry: AuditRecord): string {
    return createHash('sha256')
      .update(
        stableStringify({
          entityType: entry.entityType,
          entityId: entry.entityId,
          action: entry.action,
          actor: entry.actor,
          reason: entry.reason ?? null,
          sequence: entry.sequence,
          previousHash: entry.previousHash,
          recordedAt: entry.recordedAt,
          before: entry.before,
          after: entry.after,
        }),
      )
      .digest('hex');
  }
}
