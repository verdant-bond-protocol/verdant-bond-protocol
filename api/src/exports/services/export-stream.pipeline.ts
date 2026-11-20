import { Injectable, Logger, ForbiddenException, BadRequestException } from '@nestjs/common';
import {
  ExportableRecord,
  ExportCaller,
  ExportRole,
  ExportType,
  ExportStreamOptions,
  ExportStreamResult,
  ExportStatus,
} from '../interfaces/export.interface';
import {
  ExportRedactionMode,
  RedactionManifest,
  createRedactionManifest,
  isExportRedactionMode,
  redactExportValue,
} from './export-field-redaction';

const ROLE_PERMITTED_TYPES: Record<ExportRole, ExportType[]> = {
  [ExportRole.INVESTOR]: [
    ExportType.PORTFOLIO,
    ExportType.TRANSACTIONS,
    ExportType.HOLDINGS,
    ExportType.PERFORMANCE,
  ],
  [ExportRole.ISSUER]: [
    ExportType.PORTFOLIO,
    ExportType.TRANSACTIONS,
    ExportType.HOLDINGS,
    ExportType.PERFORMANCE,
    ExportType.BONDS,
    ExportType.COUPONS,
  ],
  [ExportRole.AUDITOR]: [
    ExportType.PORTFOLIO,
    ExportType.TRANSACTIONS,
    ExportType.HOLDINGS,
    ExportType.PERFORMANCE,
    ExportType.BONDS,
    ExportType.COUPONS,
    ExportType.COMPLIANCE_AUDIT,
  ],
  [ExportRole.ADMIN]: [
    ExportType.PORTFOLIO,
    ExportType.TRANSACTIONS,
    ExportType.HOLDINGS,
    ExportType.PERFORMANCE,
    ExportType.BONDS,
    ExportType.COUPONS,
    ExportType.COMPLIANCE_AUDIT,
    ExportType.KYC_PII,
  ],
};

const FORBIDDEN_FIELDS_BY_ROLE: Record<ExportRole, string[]> = {
  [ExportRole.INVESTOR]: [
    'ssn',
    'nationalId',
    'passportNumber',
    'taxId',
    'internalRiskScore',
    'complianceNotes',
    'signingKey',
    'signingSeed',
    'privateKey',
    'nonce',
    'rawKycDocument',
  ],
  [ExportRole.ISSUER]: [
    'ssn',
    'nationalId',
    'passportNumber',
    'taxId',
    'signingSeed',
    'privateKey',
    'rawKycDocument',
  ],
  [ExportRole.AUDITOR]: [
    'signingSeed',
    'privateKey',
    'passwordHash',
  ],
  [ExportRole.ADMIN]: [
    'signingSeed',
    'privateKey',
  ],
};

/** Per-role forbidden keys, lower-cased once so lookups are O(1) and case-blind. */
const FORBIDDEN_KEYS_BY_ROLE = new Map<ExportRole, ReadonlySet<string>>(
  (Object.keys(FORBIDDEN_FIELDS_BY_ROLE) as ExportRole[]).map((role) => [
    role,
    new Set(FORBIDDEN_FIELDS_BY_ROLE[role].map((field) => field.toLowerCase())),
  ]),
);

@Injectable()
export class ExportStreamPipeline {
  private readonly logger = new Logger(ExportStreamPipeline.name);

  validatePermission(caller: ExportCaller, exportType: ExportType): boolean {
    const permitted = ROLE_PERMITTED_TYPES[caller.role] || [];
    return permitted.includes(exportType);
  }

  /**
   * Apply ownership and field rules for `caller`. `mode` picks how forbidden
   * fields are hidden (#506): `strip` (default) removes them, `mask` keeps
   * the key with a placeholder. Redactions are counted into `manifest`.
   */
  sanitizeRecordForCaller(
    record: ExportableRecord,
    caller: ExportCaller,
    mode: ExportRedactionMode = 'strip',
    manifest?: RedactionManifest,
  ): ExportableRecord {
    // 0. An unrecognised role has no field rules; exporting with an empty
    // forbidden set would leak everything, so refuse instead (#506).
    const forbiddenKeys = FORBIDDEN_KEYS_BY_ROLE.get(caller.role);
    if (!forbiddenKeys) {
      throw new ForbiddenException(`Role ${caller.role} has no export redaction policy`);
    }

    // 1. Data ownership check: Investors can only export their own records.
    // A record with no owner cannot be proven to be the caller's, so it is
    // refused rather than exported (fail closed, #382).
    if (caller.role === ExportRole.INVESTOR && record.ownerUserId !== caller.userId) {
      throw new ForbiddenException('Cannot access records outside your caller ownership scope');
    }

    // 2. Forbidden field redaction based on caller role, at every nesting
    // depth, case-insensitively (#382).
    return {
      ...record,
      data: redactExportValue(record.data, forbiddenKeys, mode, manifest) as Record<string, any>,
    };
  }

  async streamExport<T = any>(
    exportId: string,
    exportType: ExportType,
    source: AsyncIterable<ExportableRecord[]>,
    options: ExportStreamOptions,
    chunkConsumer?: (chunk: ExportableRecord[]) => Promise<void>,
    cancellationCheck?: () => Promise<boolean>,
  ): Promise<ExportStreamResult> {
    const { caller, abortSignal } = options;
    const mode = options.redaction ?? 'strip';

    // Validate high-level permission for export type
    if (!this.validatePermission(caller, exportType)) {
      throw new ForbiddenException(
        `Role ${caller.role} is not authorized to export type ${exportType}`,
      );
    }
    if (!isExportRedactionMode(mode)) {
      throw new BadRequestException(`Unknown export redaction mode: ${String(mode)}`);
    }

    // Built fresh per run, so a retried export reports only its own redactions.
    const redaction = createRedactionManifest(caller.role, mode);

    let totalRecordsProcessed = 0;
    let totalChunks = 0;

    this.logger.log(`Starting bounded streaming export ${exportId} for caller ${caller.userId} (${caller.role})`);

    try {
      for await (const chunk of source) {
        // Cancellation check via AbortSignal or external cancellation token
        if (abortSignal?.aborted || (cancellationCheck && (await cancellationCheck()))) {
          this.logger.warn(`Export ${exportId} stream was cancelled at chunk ${totalChunks}`);
          return {
            exportId,
            status: 'cancelled',
            totalRecordsProcessed,
            totalChunks,
            cancelledAt: new Date(),
            redaction,
          };
        }

        // Project and sanitize records for caller role
        const sanitizedChunk = chunk.map((record) => this.sanitizeRecordForCaller(record, caller, mode, redaction));

        if (chunkConsumer) {
          await chunkConsumer(sanitizedChunk);
        }

        totalRecordsProcessed += sanitizedChunk.length;
        totalChunks++;
      }

      this.logger.log(`Export ${exportId} completed successfully. Processed ${totalRecordsProcessed} records in ${totalChunks} chunks.`);
      return {
        exportId,
        status: 'completed',
        totalRecordsProcessed,
        totalChunks,
        completedAt: new Date(),
        redaction,
      };
    } catch (error) {
      if (abortSignal?.aborted || (error as any)?.name === 'AbortError') {
        return {
          exportId,
          status: 'cancelled',
          totalRecordsProcessed,
          totalChunks,
          cancelledAt: new Date(),
          redaction,
        };
      }
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Export ${exportId} failed: ${errorMsg}`);
      return {
        exportId,
        status: 'failed',
        totalRecordsProcessed,
        totalChunks,
        error: errorMsg,
        redaction,
      };
    }
  }
}
