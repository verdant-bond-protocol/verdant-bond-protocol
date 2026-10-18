import { Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { stableStringify } from '../audit/audit.canonical';
import {
  ImportBatch,
  ImportBatchStatus,
  ImportFormat,
  ImportKind,
  ImportSink,
  ImportTraceEntry,
  PreviewRow,
  QuarantineCode,
  QuarantineReason,
  RawImportRow,
} from './import.interface';
import {
  checkRowSafety,
  fingerprintRow,
  IMPORT_LIMITS,
  ImportPayloadError,
  parseCsv,
  sha256,
} from './import-safety';
import { KycImportSink } from './kyc-import.sink';

export const PREVIEW_TTL_MS = 30 * 60 * 1000;
export const MAX_ROW_ATTEMPTS = 3;
/** Retained batches; only terminal ones are ever evicted to make room. */
export const MAX_BATCHES = 200;

const TERMINAL: ReadonlySet<ImportBatchStatus> = new Set(['committed', 'rolled_back', 'discarded', 'expired']);

export type ImportPipelineErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_REQUEST'
  | 'INVALID_STATE'
  | 'PREVIEW_MISMATCH'
  | 'PREVIEW_EXPIRED'
  | 'DUPLICATE_IMPORT'
  | 'DISABLED'
  | 'CAPACITY';

export class ImportPipelineError extends Error {
  constructor(readonly code: ImportPipelineErrorCode, message: string) {
    super(message);
  }
}

export interface PreviewInput {
  kind: string;
  format: ImportFormat;
  rows?: unknown;
  csv?: unknown;
  sourceName?: string | null;
  actor: string;
}

/**
 * Secure import pipeline (docs/import-pipeline.md).
 *
 *   preview ──► previewed ──commit──► committing ──► committed
 *                  │                     │              │
 *               discard            row failure      rollback
 *                  ▼                     ▼              ▼
 *              discarded       partially_committed ─► rolling_back ─► rolled_back
 *                                 (commit = retry)           └──────► rollback_incomplete
 *
 * Batches live in memory, bounded by MAX_BATCHES. The durable trace of each
 * applied row is written by the sink into its own store (for KYC: the KYC
 * audit log), so a restart loses retry/rollback bookkeeping but never the
 * record of what was imported. See the runbook for recovery after restart.
 */
@Injectable()
export class ImportPipelineService {
  private readonly logger = new Logger(ImportPipelineService.name);
  private readonly sinks = new Map<ImportKind, ImportSink>();
  private readonly batches = new Map<string, ImportBatch>();
  /** contentHash → id of a batch that committed that exact content. */
  private readonly committedContent = new Map<string, string>();
  private readonly contentHashes = new Map<string, string>();

  /** Clock; replaceable in tests. */
  now: () => number = Date.now;

  constructor(
    kycSink: KycImportSink,
    @Optional() private readonly audit?: AuditService,
  ) {
    this.registerSink(kycSink);
  }

  registerSink(sink: ImportSink): void {
    this.sinks.set(sink.kind, sink);
  }

  kinds(): { kind: ImportKind; fields: readonly string[] }[] {
    return [...this.sinks.values()].map((s) => ({ kind: s.kind, fields: s.fields }));
  }

  // ── Preview ────────────────────────────────────────────────────────────────

  /** Classify every row. Reads target state; never writes it. */
  async preview(input: PreviewInput): Promise<ImportBatch> {
    const sink = this.sinks.get(input.kind as ImportKind);
    if (!sink) throw new ImportPipelineError('INVALID_REQUEST', `unknown import kind "${input.kind}"`);
    if (!input.actor) throw new ImportPipelineError('INVALID_REQUEST', 'actor is required');
    this.ensureCapacity();

    const { parsed, sourceSha256 } = this.parse(input);
    const id = randomUUID();
    const rows: PreviewRow[] = parsed.map((p, index) => {
      const row: PreviewRow = {
        index,
        line: p.line,
        fingerprint: '',
        verdict: 'accepted',
        reasons: [],
        key: null,
        action: null,
        normalized: null,
        before: null,
        after: null,
      };
      if (p.error || !p.row) {
        row.reasons.push({ code: QuarantineCode.MALFORMED_ROW, message: p.error ?? 'row is not an object' });
      } else {
        row.reasons.push(...checkRowSafety(p.row, sink.fields));
        if (row.reasons.length === 0) {
          const normalized = sink.normalize(p.row);
          row.reasons.push(...normalized.reasons);
          row.normalized = normalized.row;
          if (normalized.row) row.key = sink.keyOf(normalized.row);
        }
      }
      row.fingerprint = fingerprintRow(row.normalized ?? p.row ?? p.error);
      if (row.reasons.length > 0) {
        row.verdict = 'quarantined';
        row.raw = p.row ?? undefined;
      }
      return row;
    });

    // Two rows for one record: which one wins depends on order, which is
    // exactly the ambiguity an operator must resolve. Quarantine all of them.
    const keyCounts = new Map<string, number>();
    for (const row of rows) if (row.key) keyCounts.set(row.key, (keyCounts.get(row.key) ?? 0) + 1);
    for (const row of rows) {
      if (row.key && (keyCounts.get(row.key) ?? 0) > 1) {
        this.quarantine(row, { code: QuarantineCode.DUPLICATE_IN_BATCH, field: 'key', message: `key appears ${keyCounts.get(row.key)} times in this batch` });
      }
    }

    for (const row of rows) {
      if (row.verdict !== 'accepted' || !row.normalized) continue;
      const inspection = await sink.inspect(row.normalized);
      row.action = inspection.action;
      row.before = inspection.before;
      row.after = inspection.after;
      for (const reason of inspection.reviewReasons) this.quarantine(row, reason);
    }

    const contentHash = sha256(
      stableStringify({ kind: sink.kind, rows: rows.filter((r) => r.verdict === 'accepted').map((r) => r.fingerprint) }),
    );
    const createdAt = this.now();
    const batch: ImportBatch = {
      id,
      kind: sink.kind,
      status: 'previewed',
      actor: input.actor,
      sourceName: input.sourceName ?? null,
      format: input.format,
      sourceSha256,
      previewHash: sha256(
        stableStringify({
          id,
          kind: sink.kind,
          rows: rows.map((r) => [r.index, r.fingerprint, r.verdict, r.action]),
        }),
      ),
      duplicateOf: this.committedContent.get(contentHash) ?? null,
      createdAt: new Date(createdAt).toISOString(),
      previewExpiresAt: new Date(createdAt + PREVIEW_TTL_MS).toISOString(),
      updatedAt: new Date(createdAt).toISOString(),
      rows,
      trace: [],
      attempts: {},
      lastError: null,
      rollbackConflicts: [],
      summary: { total: 0, accepted: 0, quarantined: 0, create: 0, update: 0, noop: 0, applied: 0, rolledBack: 0 },
    };
    this.refreshSummary(batch);
    this.batches.set(id, batch);
    this.contentHashes.set(id, contentHash);
    await this.recordAudit(batch, 'import.previewed', null);
    return this.snapshot(batch);
  }

  // ── Commit / retry ─────────────────────────────────────────────────────────

  /**
   * Apply accepted rows. Also the retry path: on a `partially_committed`
   * batch it resumes after the rows already applied. A row whose target
   * changed since preview is quarantined as STATE_DRIFT, never overwritten.
   */
  async commit(id: string, opts: { previewHash: string; actor: string; allowDuplicate?: boolean }): Promise<ImportBatch> {
    if (process.env.IMPORT_PIPELINE === 'off') {
      throw new ImportPipelineError('DISABLED', 'import commits are disabled (IMPORT_PIPELINE=off); preview and rollback remain available');
    }
    const batch = this.getInternal(id);
    this.expireIfStale(batch);
    if (batch.status === 'expired') {
      throw new ImportPipelineError('PREVIEW_EXPIRED', 'preview expired before commit; submit the file again to get a fresh preview');
    }
    if (batch.status !== 'previewed' && batch.status !== 'partially_committed') {
      throw new ImportPipelineError('INVALID_STATE', `cannot commit a batch in status ${batch.status}`);
    }
    this.requirePreviewHash(batch, opts.previewHash);
    const duplicateOf = this.committedContent.get(this.contentHashes.get(id)!) ?? null;
    if (duplicateOf && duplicateOf !== id && !opts.allowDuplicate) {
      throw new ImportPipelineError('DUPLICATE_IMPORT', `identical content was already committed by batch ${duplicateOf}; pass allowDuplicate to import it again`);
    }

    // Status flips before the first await: a concurrent commit or rollback
    // of this batch now fails the status check above instead of interleaving.
    const from = batch.status;
    batch.status = 'committing';
    const sink = this.sinks.get(batch.kind)!;
    const applied = new Set(batch.trace.map((t) => t.rowIndex));
    let failed = false;

    for (const row of batch.rows) {
      if (row.verdict !== 'accepted' || row.action === 'noop' || applied.has(row.index)) continue;
      if ((batch.attempts[row.index] ?? 0) >= MAX_ROW_ATTEMPTS) {
        this.quarantine(row, { code: QuarantineCode.APPLY_FAILED, message: `failed to apply ${MAX_ROW_ATTEMPTS} times; fix and re-import separately` });
        continue;
      }
      try {
        const current = await sink.current(row.key!);
        if (!sameState(current, row.before)) {
          if (sameState(current, row.after)) {
            // An earlier attempt reached the store but failed afterwards
            // (e.g. cache invalidation). The write is there: trace it.
            batch.trace.push(this.traceEntry(batch, row, current!, opts.actor));
            continue;
          }
          this.quarantine(row, { code: QuarantineCode.STATE_DRIFT, field: 'key', message: 'target record changed after preview; review and re-import' });
          continue;
        }
        const after = await sink.apply(row.normalized!, {
          batchId: batch.id,
          rowIndex: row.index,
          fingerprint: row.fingerprint,
          actor: opts.actor,
        });
        batch.trace.push(this.traceEntry(batch, row, after, opts.actor));
      } catch (error) {
        batch.attempts[row.index] = (batch.attempts[row.index] ?? 0) + 1;
        batch.lastError = { rowIndex: row.index, message: errorMessage(error), at: new Date(this.now()).toISOString() };
        this.logger.warn(`import ${batch.id} row ${row.index} failed (attempt ${batch.attempts[row.index]}): ${errorMessage(error)}`);
        failed = true;
        break;
      }
    }

    batch.status = failed ? 'partially_committed' : 'committed';
    if (!failed) {
      batch.lastError = null;
      this.committedContent.set(this.contentHashes.get(id)!, id);
    }
    this.touch(batch);
    await this.recordAudit(batch, failed ? 'import.partially_committed' : 'import.committed', from);
    return this.snapshot(batch);
  }

  // ── Rollback ───────────────────────────────────────────────────────────────

  /**
   * Undo applied rows, newest first. A record that changed after the import
   * is left alone and reported as a conflict: rollback restores the import's
   * own writes, it never clobbers later ones. Re-running resumes.
   */
  async rollback(id: string, opts: { previewHash: string; actor: string }): Promise<ImportBatch> {
    const batch = this.getInternal(id);
    if (!['committed', 'partially_committed', 'rollback_incomplete'].includes(batch.status)) {
      throw new ImportPipelineError('INVALID_STATE', `cannot roll back a batch in status ${batch.status}`);
    }
    this.requirePreviewHash(batch, opts.previewHash);

    const from = batch.status;
    batch.status = 'rolling_back';
    const sink = this.sinks.get(batch.kind)!;
    batch.rollbackConflicts = batch.rollbackConflicts.filter((c) => c.kind === 'residual');

    for (const entry of [...batch.trace].reverse()) {
      if (entry.rolledBackAt) continue;
      try {
        const current = await sink.current(entry.key);
        if (sameState(current, entry.before)) {
          entry.rolledBackAt = new Date(this.now()).toISOString();
          continue;
        }
        if (!sameState(current, entry.after)) {
          batch.rollbackConflicts.push({
            kind: 'conflict',
            rowIndex: entry.rowIndex,
            key: entry.key,
            message: 'record changed after import; left as is. Resolve manually, then re-run rollback',
          });
          continue;
        }
        await sink.revert(entry, { actor: opts.actor });
        entry.rolledBackAt = new Date(this.now()).toISOString();
        const restored = await sink.current(entry.key);
        if (!sameState(restored, entry.before)) {
          batch.rollbackConflicts.push({
            kind: 'residual',
            rowIndex: entry.rowIndex,
            key: entry.key,
            message: `reverted, but store state ${stableStringify(restored)} differs from pre-import ${stableStringify(entry.before)}`,
          });
        }
      } catch (error) {
        batch.rollbackConflicts.push({ kind: 'error', rowIndex: entry.rowIndex, key: entry.key, message: errorMessage(error) });
      }
    }

    const blocked = batch.rollbackConflicts.some((c) => c.kind !== 'residual');
    batch.status = blocked ? 'rollback_incomplete' : 'rolled_back';
    if (!blocked) this.committedContent.delete(this.contentHashes.get(id)!);
    this.touch(batch);
    await this.recordAudit(batch, blocked ? 'import.rollback_incomplete' : 'import.rolled_back', from);
    return this.snapshot(batch);
  }

  async discard(id: string, actor: string): Promise<ImportBatch> {
    const batch = this.getInternal(id);
    this.expireIfStale(batch);
    if (batch.status !== 'previewed' && batch.status !== 'expired') {
      throw new ImportPipelineError('INVALID_STATE', `cannot discard a batch in status ${batch.status}`);
    }
    const from = batch.status;
    batch.status = 'discarded';
    this.touch(batch);
    await this.recordAudit(batch, 'import.discarded', from, actor);
    return this.snapshot(batch);
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  get(id: string): ImportBatch {
    const batch = this.getInternal(id);
    this.expireIfStale(batch);
    return this.snapshot(batch);
  }

  list(): Omit<ImportBatch, 'rows' | 'trace'>[] {
    return [...this.batches.values()].map((b) => {
      this.expireIfStale(b);
      const { rows: _rows, trace: _trace, ...rest } = this.snapshot(b);
      return rest;
    });
  }

  quarantined(id: string): PreviewRow[] {
    return this.get(id).rows.filter((r) => r.verdict === 'quarantined');
  }

  /** Every import that wrote to `key`, oldest first, across retained batches. */
  traceForKey(key: string): ImportTraceEntry[] {
    return [...this.batches.values()]
      .flatMap((b) => b.trace.filter((t) => t.key === key))
      .sort((a, b) => a.appliedAt.localeCompare(b.appliedAt))
      .map((t) => structuredClone(t));
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private parse(input: PreviewInput): { parsed: { line: number; row: RawImportRow | null; error: string | null }[]; sourceSha256: string } {
    try {
      if (input.format === 'csv') {
        if (typeof input.csv !== 'string') throw new ImportPayloadError('csv must be a string when format is csv');
        return { parsed: parseCsv(input.csv), sourceSha256: sha256(input.csv) };
      }
      if (input.format === 'json') {
        if (!Array.isArray(input.rows)) throw new ImportPayloadError('rows must be an array when format is json');
        if (input.rows.length > IMPORT_LIMITS.MAX_ROWS) throw new ImportPayloadError(`more than ${IMPORT_LIMITS.MAX_ROWS} rows`);
        const serialized = JSON.stringify(input.rows);
        if (Buffer.byteLength(serialized, 'utf8') > IMPORT_LIMITS.MAX_PAYLOAD_BYTES) {
          throw new ImportPayloadError(`payload exceeds ${IMPORT_LIMITS.MAX_PAYLOAD_BYTES} bytes`);
        }
        const parsed = input.rows.map((row, i) =>
          row !== null && typeof row === 'object' && !Array.isArray(row)
            ? { line: i + 1, row: row as RawImportRow, error: null }
            : { line: i + 1, row: null, error: 'row is not an object' },
        );
        return { parsed, sourceSha256: sha256(serialized) };
      }
      throw new ImportPayloadError('format must be json or csv');
    } catch (error) {
      if (error instanceof ImportPayloadError) throw new ImportPipelineError('INVALID_REQUEST', error.message);
      throw error;
    }
  }

  private quarantine(row: PreviewRow, reason: QuarantineReason): void {
    row.reasons.push(reason);
    row.verdict = 'quarantined';
  }

  private traceEntry(batch: ImportBatch, row: PreviewRow, after: Record<string, unknown>, actor: string): ImportTraceEntry {
    return {
      batchId: batch.id,
      rowIndex: row.index,
      line: row.line,
      fingerprint: row.fingerprint,
      key: row.key!,
      action: row.action!,
      before: row.before,
      after,
      appliedAt: new Date(this.now()).toISOString(),
      actor,
    };
  }

  private requirePreviewHash(batch: ImportBatch, previewHash: string): void {
    if (previewHash !== batch.previewHash) {
      throw new ImportPipelineError('PREVIEW_MISMATCH', 'previewHash does not match this batch; re-read the preview before acting on it');
    }
  }

  private expireIfStale(batch: ImportBatch): void {
    if (batch.status === 'previewed' && this.now() > Date.parse(batch.previewExpiresAt)) {
      batch.status = 'expired';
      this.touch(batch);
    }
  }

  private ensureCapacity(): void {
    if (this.batches.size < MAX_BATCHES) return;
    for (const batch of this.batches.values()) this.expireIfStale(batch);
    const evictable = [...this.batches.values()]
      .filter((b) => TERMINAL.has(b.status))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    const victim = evictable[0];
    if (!victim) {
      throw new ImportPipelineError('CAPACITY', `${MAX_BATCHES} batches still need commit, retry or rollback; resolve some before importing more`);
    }
    this.batches.delete(victim.id);
    this.contentHashes.delete(victim.id);
  }

  private refreshSummary(batch: ImportBatch): void {
    const accepted = batch.rows.filter((r) => r.verdict === 'accepted');
    batch.summary = {
      total: batch.rows.length,
      accepted: accepted.length,
      quarantined: batch.rows.length - accepted.length,
      create: accepted.filter((r) => r.action === 'create').length,
      update: accepted.filter((r) => r.action === 'update').length,
      noop: accepted.filter((r) => r.action === 'noop').length,
      applied: batch.trace.filter((t) => !t.rolledBackAt).length,
      rolledBack: batch.trace.filter((t) => t.rolledBackAt).length,
    };
  }

  private touch(batch: ImportBatch): void {
    batch.updatedAt = new Date(this.now()).toISOString();
    this.refreshSummary(batch);
  }

  private getInternal(id: string): ImportBatch {
    const batch = this.batches.get(id);
    if (!batch) throw new ImportPipelineError('NOT_FOUND', `no import batch ${id}`);
    return batch;
  }

  private snapshot(batch: ImportBatch): ImportBatch {
    return structuredClone(batch);
  }

  private async recordAudit(batch: ImportBatch, action: string, from: ImportBatchStatus | null, actor = batch.actor): Promise<void> {
    if (!this.audit) return;
    try {
      const result = await this.audit.record({
        entityType: 'import_batch',
        entityId: batch.id,
        action,
        actor,
        reason: batch.lastError?.message,
        before: from ? { status: from } : null,
        after: {
          status: batch.status,
          kind: batch.kind,
          previewHash: batch.previewHash,
          sourceSha256: batch.sourceSha256,
          summary: batch.summary,
          rollbackConflicts: batch.rollbackConflicts.length,
        },
      });
      if (result.kind === 'rejected') this.logger.warn(`audit write for import ${batch.id} rejected: ${result.rejectReason}`);
    } catch (error) {
      this.logger.warn(`audit write for import ${batch.id} failed: ${errorMessage(error)}`);
    }
  }
}

function sameState(a: unknown, b: unknown): boolean {
  return stableStringify(a ?? null) === stableStringify(b ?? null);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
