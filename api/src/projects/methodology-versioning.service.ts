import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { createHash } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { ErrorCode } from '../common/errors/error-codes';
import { ApiProblemException } from '../common/errors/problem-exception';
import {
  BondMethodologyPin,
  LEGACY_METHODOLOGY_ID,
  LEGACY_METHODOLOGY_VERSION,
  LegacyMigrationResult,
  LegacyRollbackResult,
  MethodologyVersion,
  ReportMethodologyBinding,
} from './interfaces/methodology-version.interface';

export interface CreateMethodologyVersionInput {
  id: string;
  name: string;
  version: string;
  effectiveDate: string;
  documentContent: string;
  actor: string;
  isLegacy?: boolean;
}

export interface UpdateMethodologyDraftInput {
  name?: string;
  effectiveDate?: string;
  documentContent?: string;
  actor: string;
}

export interface RecordReportMethodologyInput {
  reportId: number;
  bondId: number;
  methodologyId: string;
  version: string;
  actor: string;
  overrideReason?: string;
  overrideApprovedBy?: string;
}

@Injectable()
export class MethodologyVersioningService {
  private readonly versions = new Map<string, MethodologyVersion>();
  private readonly bondPins = new Map<number, BondMethodologyPin>();
  private readonly reportBindings = new Map<number, ReportMethodologyBinding>();

  constructor(@Optional() private readonly auditService?: AuditService) {}

  async createDraft(input: CreateMethodologyVersionInput): Promise<MethodologyVersion> {
    const id = this.requireNonEmpty(input.id, 'id').toUpperCase();
    const version = this.requireNonEmpty(input.version, 'version');
    const name = this.requireNonEmpty(input.name, 'name');
    const documentContent = this.requireNonEmpty(input.documentContent, 'documentContent');
    const actor = this.requireNonEmpty(input.actor, 'actor');

    const key = this.keyOf(id, version);
    if (this.versions.has(key)) {
      throw new ApiProblemException(ErrorCode.VALIDATION_FAILED, {
        status: HttpStatus.CONFLICT,
        detail: `Methodology version ${key} already exists`,
      });
    }

    const record: MethodologyVersion = {
      id,
      name,
      version,
      effectiveDate: input.effectiveDate,
      documentContent,
      contentHash: this.computeHash(documentContent),
      status: 'draft',
      isLegacy: input.isLegacy,
      createdBy: actor,
      createdAt: new Date().toISOString(),
    };

    this.versions.set(key, record);
    await this.recordAudit(key, 'create_draft', actor, null, { ...record });
    return { ...record };
  }

  async updateDraft(
    id: string,
    version: string,
    input: UpdateMethodologyDraftInput,
  ): Promise<MethodologyVersion> {
    const key = this.keyOf(id.toUpperCase(), version);
    const existing = this.versions.get(key);
    if (!existing) {
      throw new ApiProblemException(ErrorCode.NOT_FOUND, {
        status: HttpStatus.NOT_FOUND,
        detail: `Methodology version ${key} not found`,
      });
    }
    if (existing.status !== 'draft') {
      throw new ApiProblemException(ErrorCode.METHODOLOGY_IMMUTABLE, {
        status: HttpStatus.CONFLICT,
      });
    }

    const before = { ...existing };
    if (input.name !== undefined) existing.name = this.requireNonEmpty(input.name, 'name');
    if (input.effectiveDate !== undefined) existing.effectiveDate = input.effectiveDate;
    if (input.documentContent !== undefined) {
      existing.documentContent = this.requireNonEmpty(input.documentContent, 'documentContent');
      existing.contentHash = this.computeHash(existing.documentContent);
    }

    await this.recordAudit(key, 'update_draft', input.actor, before, { ...existing });
    return { ...existing };
  }

  async activateVersion(id: string, version: string, approvedBy: string): Promise<MethodologyVersion> {
    const key = this.keyOf(id.toUpperCase(), version);
    const existing = this.versions.get(key);
    if (!existing) {
      throw new ApiProblemException(ErrorCode.NOT_FOUND, {
        status: HttpStatus.NOT_FOUND,
        detail: `Methodology version ${key} not found`,
      });
    }
    this.verifyIntegrity(existing);

    if (existing.status === 'active') {
      return { ...existing };
    }
    if (existing.status === 'deprecated') {
      throw new ApiProblemException(ErrorCode.METHODOLOGY_VERSION_NOT_ALLOWED, {
        detail: `Cannot activate deprecated methodology version ${key}`,
      });
    }

    const before = { ...existing };
    existing.status = 'active';
    existing.approvedBy = this.requireNonEmpty(approvedBy, 'approvedBy');
    existing.approvedAt = new Date().toISOString();

    await this.recordAudit(key, 'activate', existing.approvedBy, before, { ...existing });
    return { ...existing };
  }

  async deprecateVersion(
    id: string,
    version: string,
    actor: string,
    reason: string,
  ): Promise<MethodologyVersion> {
    const key = this.keyOf(id.toUpperCase(), version);
    const existing = this.versions.get(key);
    if (!existing) {
      throw new ApiProblemException(ErrorCode.NOT_FOUND, {
        status: HttpStatus.NOT_FOUND,
        detail: `Methodology version ${key} not found`,
      });
    }
    this.verifyIntegrity(existing);

    if (existing.status === 'deprecated') {
      return { ...existing };
    }

    const before = { ...existing };
    existing.status = 'deprecated';
    existing.deprecatedBy = this.requireNonEmpty(actor, 'actor');
    existing.deprecatedAt = new Date().toISOString();
    existing.deprecationReason = this.requireNonEmpty(reason, 'reason');

    await this.recordAudit(key, 'deprecate', existing.deprecatedBy, before, { ...existing }, reason);
    return { ...existing };
  }

  /**
   * Read a methodology version and verify its contentHash against documentContent.
   */
  getVersion(id: string, version: string): MethodologyVersion {
    const key = this.keyOf(id.toUpperCase(), version);
    const existing = this.versions.get(key);
    if (!existing) {
      throw new ApiProblemException(ErrorCode.NOT_FOUND, {
        status: HttpStatus.NOT_FOUND,
        detail: `Methodology version ${key} not found`,
      });
    }
    this.verifyIntegrity(existing);
    return { ...existing };
  }

  listVersions(methodologyId?: string): MethodologyVersion[] {
    const filter = methodologyId?.toUpperCase();
    const list: MethodologyVersion[] = [];
    for (const v of this.versions.values()) {
      if (!filter || v.id === filter) {
        this.verifyIntegrity(v);
        list.push({ ...v });
      }
    }
    return list;
  }

  /**
   * Pin an active methodology version to a bond at issuance. Write-once; cannot change.
   */
  async pinMethodologyToBond(
    bondId: number,
    methodologyId: string,
    version: string,
    actor: string,
    isLegacyMigration = false,
  ): Promise<BondMethodologyPin> {
    if (this.bondPins.has(bondId)) {
      throw new ApiProblemException(ErrorCode.METHODOLOGY_ALREADY_PINNED, {
        status: HttpStatus.CONFLICT,
      });
    }

    const meth = this.getVersion(methodologyId, version);
    if (meth.status !== 'active') {
      throw new ApiProblemException(ErrorCode.METHODOLOGY_VERSION_NOT_ALLOWED, {
        detail: `Only active methodology versions can be pinned at issuance (got ${meth.status})`,
      });
    }

    const pin: BondMethodologyPin = {
      bondId,
      methodologyId: meth.id,
      version: meth.version,
      contentHash: meth.contentHash,
      pinnedBy: this.requireNonEmpty(actor, 'actor'),
      pinnedAt: new Date().toISOString(),
      isLegacyMigration,
    };

    this.bondPins.set(bondId, pin);
    await this.recordAudit(`bond:${bondId}`, 'pin_methodology', pin.pinnedBy, null, { ...pin });
    return { ...pin };
  }

  getBondPin(bondId: number): BondMethodologyPin | null {
    const pin = this.bondPins.get(bondId);
    return pin ? { ...pin } : null;
  }

  /**
   * Validate and record the methodology version used for an impact/oracle report.
   * Accepts the bond's pinned version, or an active later version of the same
   * methodology when an explicit overrideReason and overrideApprovedBy are recorded.
   */
  async recordReportMethodology(
    input: RecordReportMethodologyInput,
    isLegacyMigration = false,
  ): Promise<ReportMethodologyBinding> {
    const pin = this.bondPins.get(input.bondId);
    if (!pin) {
      throw new ApiProblemException(ErrorCode.NOT_FOUND, {
        status: HttpStatus.NOT_FOUND,
        detail: `Bond ${input.bondId} has no pinned methodology`,
      });
    }

    const meth = this.getVersion(input.methodologyId, input.version);
    if (meth.status !== 'active') {
      throw new ApiProblemException(ErrorCode.METHODOLOGY_VERSION_NOT_ALLOWED, {
        detail: `Report cannot use ${meth.status} methodology version ${meth.id}@${meth.version}`,
      });
    }

    const isExactPinned = meth.id === pin.methodologyId && meth.version === pin.version;
    let isLaterVersionOverride = false;

    if (!isExactPinned) {
      if (meth.id !== pin.methodologyId || !this.isLaterVersion(meth.version, pin.version)) {
        throw new ApiProblemException(ErrorCode.METHODOLOGY_VERSION_NOT_ALLOWED, {
          detail: `Report methodology ${meth.id}@${meth.version} is not permitted for bond pinned to ${pin.methodologyId}@${pin.version}`,
        });
      }
      if (!input.overrideReason?.trim() || !input.overrideApprovedBy?.trim()) {
        throw new ApiProblemException(ErrorCode.METHODOLOGY_VERSION_NOT_ALLOWED, {
          detail: 'Reporting under a later methodology version requires overrideReason and overrideApprovedBy',
        });
      }
      isLaterVersionOverride = true;
    }

    const binding: ReportMethodologyBinding = {
      reportId: input.reportId,
      bondId: input.bondId,
      methodologyId: meth.id,
      version: meth.version,
      contentHash: meth.contentHash,
      isLaterVersionOverride,
      overrideReason: input.overrideReason?.trim(),
      overrideApprovedBy: input.overrideApprovedBy?.trim(),
      recordedBy: this.requireNonEmpty(input.actor, 'actor'),
      recordedAt: new Date().toISOString(),
      isLegacyMigration,
    };

    this.reportBindings.set(input.reportId, binding);
    await this.recordAudit(
      `report:${input.reportId}`,
      'bind_methodology',
      binding.recordedBy,
      null,
      { ...binding },
      binding.overrideReason,
    );
    return { ...binding };
  }

  getReportBinding(reportId: number): ReportMethodologyBinding | null {
    const b = this.reportBindings.get(reportId);
    return b ? { ...b } : null;
  }

  /**
   * Re-runnable, idempotent migration mapping unversioned legacy bonds and reports
   * to the `LEGACY-UNVERSIONED@0.0.0-legacy` record.
   */
  async migrateLegacyBondsAndReports(
    bondIds: number[],
    reports: Array<{ reportId: number; bondId: number }>,
    actor: string,
  ): Promise<LegacyMigrationResult> {
    const legacyKey = this.keyOf(LEGACY_METHODOLOGY_ID, LEGACY_METHODOLOGY_VERSION);
    if (!this.versions.has(legacyKey)) {
      await this.createDraft({
        id: LEGACY_METHODOLOGY_ID,
        name: 'Legacy / Unversioned Methodology',
        version: LEGACY_METHODOLOGY_VERSION,
        effectiveDate: '1970-01-01T00:00:00.000Z',
        documentContent: 'Legacy unversioned methodology placeholder for pre-versioning bonds and reports.',
        actor,
        isLegacy: true,
      });
      await this.activateVersion(LEGACY_METHODOLOGY_ID, LEGACY_METHODOLOGY_VERSION, actor);
    }

    const migratedBondIds: number[] = [];
    const skippedBondIds: number[] = [];
    for (const bondId of bondIds) {
      if (this.bondPins.has(bondId)) {
        skippedBondIds.push(bondId);
      } else {
        await this.pinMethodologyToBond(
          bondId,
          LEGACY_METHODOLOGY_ID,
          LEGACY_METHODOLOGY_VERSION,
          actor,
          true,
        );
        migratedBondIds.push(bondId);
      }
    }

    const migratedReportIds: number[] = [];
    const skippedReportIds: number[] = [];
    for (const r of reports) {
      if (this.reportBindings.has(r.reportId)) {
        skippedReportIds.push(r.reportId);
      } else {
        await this.recordReportMethodology(
          {
            reportId: r.reportId,
            bondId: r.bondId,
            methodologyId: LEGACY_METHODOLOGY_ID,
            version: LEGACY_METHODOLOGY_VERSION,
            actor,
          },
          true,
        );
        migratedReportIds.push(r.reportId);
      }
    }

    return {
      legacyMethodologyKey: legacyKey,
      migratedBondIds,
      skippedBondIds,
      migratedReportIds,
      skippedReportIds,
      executedAt: new Date().toISOString(),
    };
  }

  /**
   * Rollback only the pins and report bindings created by the legacy migration.
   */
  async rollbackLegacyMigration(actor: string): Promise<LegacyRollbackResult> {
    const rolledBackReportIds: number[] = [];
    for (const [reportId, binding] of this.reportBindings.entries()) {
      if (binding.isLegacyMigration) {
        this.reportBindings.delete(reportId);
        rolledBackReportIds.push(reportId);
      }
    }

    const rolledBackBondIds: number[] = [];
    for (const [bondId, pin] of this.bondPins.entries()) {
      if (pin.isLegacyMigration) {
        this.bondPins.delete(bondId);
        rolledBackBondIds.push(bondId);
      }
    }

    await this.recordAudit(
      LEGACY_METHODOLOGY_ID,
      'rollback_legacy_migration',
      this.requireNonEmpty(actor, 'actor'),
      null,
      { rolledBackBondIds, rolledBackReportIds },
    );

    return {
      rolledBackBondIds,
      rolledBackReportIds,
      rolledBackAt: new Date().toISOString(),
    };
  }

  /** Test seam to simulate storage tampering without touching contentHash. */
  tamperDocumentForTest(id: string, version: string, tamperedContent: string): void {
    const existing = this.versions.get(this.keyOf(id.toUpperCase(), version));
    if (existing) {
      existing.documentContent = tamperedContent;
    }
  }

  private verifyIntegrity(v: MethodologyVersion): void {
    const actual = this.computeHash(v.documentContent);
    if (actual !== v.contentHash) {
      throw new ApiProblemException(ErrorCode.METHODOLOGY_TAMPER_DETECTED, {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        context: { id: v.id, version: v.version },
      });
    }
  }

  private isLaterVersion(candidate: string, pinned: string): boolean {
    const parse = (v: string) => v.split('.').map((n) => parseInt(n, 10));
    const a = parse(candidate);
    const b = parse(pinned);
    if (a.some(Number.isNaN) || b.some(Number.isNaN)) {
      return candidate > pinned;
    }
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const av = a[i] ?? 0;
      const bv = b[i] ?? 0;
      if (av > bv) return true;
      if (av < bv) return false;
    }
    return false;
  }

  private computeHash(content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex');
  }

  private keyOf(id: string, version: string): string {
    return `${id}@${version}`;
  }

  private requireNonEmpty(value: string, field: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new ApiProblemException(ErrorCode.VALIDATION_FAILED, {
        detail: `${field} is required`,
      });
    }
    return value.trim();
  }

  private async recordAudit(
    entityId: string,
    action: string,
    actor: string,
    before: Record<string, any> | null,
    after: Record<string, any> | null,
    reason?: string,
  ): Promise<void> {
    if (!this.auditService) return;
    await this.auditService.record({
      entityType: 'methodology',
      entityId,
      action,
      actor,
      before,
      after,
      reason,
    });
  }
}
