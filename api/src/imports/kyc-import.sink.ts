import { Injectable } from '@nestjs/common';
import { StrKey } from '@stellar/stellar-sdk';
import { KycService } from '../auth/kyc.service';
import { KycStoreService } from '../common/services/kyc-store.service';
import { KycRecord, KycStatus } from '../common/interfaces/authenticated-request.interface';
import {
  ImportSink,
  ImportTraceEntry,
  NormalizedImportRow,
  QuarantineCode,
  QuarantineReason,
  RawImportRow,
  SinkInspection,
} from './import.interface';

const IMPORTABLE_STATUSES = new Set<string>([
  KycStatus.PENDING,
  KycStatus.VERIFIED,
  KycStatus.ACCREDITED,
  KycStatus.REJECTED,
  KycStatus.EXPIRED,
]);
const ELIGIBLE_STATUSES = new Set<string>([KycStatus.VERIFIED, KycStatus.ACCREDITED]);
const PROVIDER_REFERENCE = /^[A-Za-z0-9._:/-]{1,128}$/;
const MAX_EXPIRY_HORIZON_MS = 5 * 365 * 24 * 60 * 60 * 1000;
const MAX_REASON_LENGTH = 256;

/** The part of a KYC record an import can change, and drift/rollback compare. */
export interface KycImportState {
  status: KycStatus;
  expiresAt: number | null;
}

/**
 * `none` is what undoing a `create` leaves behind (the store has no deletes)
 * and no eligibility check accepts it, so it reads as "no record". That keeps
 * create → rollback → re-import consistent.
 */
function project(record: KycRecord | null): KycImportState | null {
  if (!record || record.status === KycStatus.NONE) return null;
  return { status: record.status, expiresAt: record.expiresAt ?? null };
}

/**
 * Imports provider KYC attestations (one row per investor address).
 *
 * Writes go through KycService.transitionStatus so the Redis eligibility
 * cache is invalidated and the KYC audit log records `source: 'import'`, with
 * the batch id, row index and row fingerprint in the reason: that log is the
 * durable trace of every imported row. Reads for preview go to the store
 * directly because KycService.getRecord creates a PENDING record on first
 * lookup, and preview must not write.
 */
@Injectable()
export class KycImportSink implements ImportSink {
  readonly kind = 'kyc_attestation' as const;
  readonly fields = ['address', 'status', 'providerReference', 'expiresAt', 'reason'] as const;

  /** Clock for expiry checks; replaceable in tests. */
  now: () => number = Date.now;

  constructor(
    private readonly kyc: KycService,
    private readonly store: KycStoreService,
  ) {}

  normalize(raw: RawImportRow): { row: NormalizedImportRow | null; reasons: QuarantineReason[] } {
    const reasons: QuarantineReason[] = [];
    const text = (field: string): string | null => {
      const value = raw[field];
      if (value === null || value === undefined) return null;
      const trimmed = String(value).trim();
      return trimmed === '' ? null : trimmed;
    };

    const address = text('address');
    if (!address) {
      reasons.push({ code: QuarantineCode.MISSING_FIELD, field: 'address', message: 'address is required' });
    } else if (!StrKey.isValidEd25519PublicKey(address)) {
      reasons.push({ code: QuarantineCode.INVALID_ADDRESS, field: 'address', message: 'not a valid Stellar ed25519 public key' });
    }

    const status = text('status')?.toLowerCase() ?? null;
    if (!status) {
      reasons.push({ code: QuarantineCode.MISSING_FIELD, field: 'status', message: 'status is required' });
    } else if (!IMPORTABLE_STATUSES.has(status)) {
      reasons.push({
        code: QuarantineCode.INVALID_VALUE,
        field: 'status',
        message: `status must be one of ${[...IMPORTABLE_STATUSES].join(', ')}`,
      });
    }

    const providerReference = text('providerReference');
    if (!providerReference) {
      reasons.push({ code: QuarantineCode.MISSING_FIELD, field: 'providerReference', message: 'providerReference is required for traceability to the KYC provider' });
    } else if (!PROVIDER_REFERENCE.test(providerReference)) {
      reasons.push({ code: QuarantineCode.INVALID_VALUE, field: 'providerReference', message: 'providerReference must be 1-128 characters of A-Z a-z 0-9 . _ : / -' });
    }

    const reason = text('reason');
    if (reason && reason.length > MAX_REASON_LENGTH) {
      reasons.push({ code: QuarantineCode.FIELD_TOO_LONG, field: 'reason', message: `reason exceeds ${MAX_REASON_LENGTH} characters` });
    }

    const expiresAt = this.parseExpiry(raw.expiresAt, status, reasons);

    if (reasons.length > 0) return { row: null, reasons };
    return { row: { address, status, providerReference, expiresAt, reason }, reasons };
  }

  keyOf(row: NormalizedImportRow): string {
    return row.address as string;
  }

  async inspect(row: NormalizedImportRow): Promise<SinkInspection> {
    const key = this.keyOf(row);
    const before = project(await this.store.get(key));
    // KycStoreService keeps the existing expiry when none is supplied, so the
    // projected state must too, or noop detection and rollback checks lie.
    const after: KycImportState = {
      status: row.status as KycStatus,
      expiresAt: (row.expiresAt as number | null) ?? before?.expiresAt ?? null,
    };

    const reviewReasons: QuarantineReason[] = [];
    if (before?.status === KycStatus.REJECTED && ELIGIBLE_STATUSES.has(after.status)) {
      reviewReasons.push({
        code: QuarantineCode.REQUIRES_REVIEW,
        field: 'status',
        message: 'a bulk import cannot lift a KYC rejection; re-verify this investor through the provider flow',
      });
    }

    let action: SinkInspection['action'] = 'update';
    if (!before) action = 'create';
    else if (before.status === after.status && before.expiresAt === after.expiresAt) action = 'noop';

    return { key, action, before: before as Record<string, unknown> | null, after: after as unknown as Record<string, unknown>, reviewReasons };
  }

  async apply(
    row: NormalizedImportRow,
    ctx: { batchId: string; rowIndex: number; fingerprint: string; actor: string },
  ): Promise<Record<string, unknown>> {
    const trace = `import ${ctx.batchId} row ${ctx.rowIndex} sha256:${ctx.fingerprint.slice(0, 16)}`;
    const { record } = await this.kyc.transitionStatus(this.keyOf(row), row.status as KycStatus, {
      source: 'import',
      actor: ctx.actor,
      reason: row.reason ? `${trace} — ${row.reason}` : trace,
      providerReference: row.providerReference as string,
      expiresAt: row.expiresAt as number | null,
    });
    return project(record) as unknown as Record<string, unknown>;
  }

  async current(key: string): Promise<Record<string, unknown> | null> {
    return project(await this.store.get(key)) as Record<string, unknown> | null;
  }

  /**
   * The KYC store is append-only (no deletes), so undoing a `create` moves the
   * record to `none`, which no eligibility check accepts. The store cannot
   * clear an expiry once set; the pipeline's post-revert check reports that.
   */
  async revert(entry: ImportTraceEntry, ctx: { actor: string }): Promise<void> {
    const before = entry.before as KycImportState | null;
    await this.kyc.transitionStatus(entry.key, before?.status ?? KycStatus.NONE, {
      source: 'import',
      actor: ctx.actor,
      reason: `rollback of import ${entry.batchId} row ${entry.rowIndex}`,
      expiresAt: before?.expiresAt ?? null,
    });
  }

  private parseExpiry(value: unknown, status: string | null, reasons: QuarantineReason[]): number | null {
    const present = value !== null && value !== undefined && String(value).trim() !== '';
    if (!present) {
      if (status && ELIGIBLE_STATUSES.has(status)) {
        reasons.push({ code: QuarantineCode.MISSING_FIELD, field: 'expiresAt', message: `expiresAt is required for status ${status}` });
      }
      return null;
    }
    if (status && !ELIGIBLE_STATUSES.has(status)) {
      reasons.push({ code: QuarantineCode.INVALID_VALUE, field: 'expiresAt', message: `expiresAt only applies to ${[...ELIGIBLE_STATUSES].join('/')}` });
      return null;
    }

    const textValue = String(value).trim();
    // Epoch milliseconds or an ISO-8601 date with an explicit zone; a bare
    // local date would be read in the server's timezone.
    const ms = /^\d{13}$/.test(textValue)
      ? Number(textValue)
      : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(textValue)
        ? Date.parse(textValue)
        : NaN;
    if (!Number.isFinite(ms)) {
      reasons.push({ code: QuarantineCode.INVALID_VALUE, field: 'expiresAt', message: 'expiresAt must be epoch milliseconds or ISO-8601 with a timezone' });
      return null;
    }
    const now = this.now();
    if (ms <= now) {
      reasons.push({ code: QuarantineCode.INVALID_VALUE, field: 'expiresAt', message: 'expiresAt is in the past' });
      return null;
    }
    if (ms > now + MAX_EXPIRY_HORIZON_MS) {
      reasons.push({ code: QuarantineCode.INVALID_VALUE, field: 'expiresAt', message: 'expiresAt is more than 5 years ahead' });
      return null;
    }
    return ms;
  }
}
