import { Injectable, Logger, ForbiddenException } from '@nestjs/common';
import {
  ExportableRecord,
  ExportCaller,
  ExportRole,
  ExportType,
  ExportStreamOptions,
  ExportStreamResult,
  ExportStatus,
} from '../interfaces/export.interface';

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

/**
 * Assigning an own `__proto__` key (as `JSON.parse` produces) onto a plain
 * object rewrites that object's prototype instead of copying a field (#382),
 * so it is never exported, for any role.
 */
const PROTOTYPE_KEY = '__proto__';

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

  sanitizeRecordForCaller(record: ExportableRecord, caller: ExportCaller): ExportableRecord {
    // 1. Data ownership check: Investors can only export their own records.
    // A record with no owner cannot be proven to be the caller's, so it is
    // refused rather than exported (fail closed, #382).
    if (caller.role === ExportRole.INVESTOR && record.ownerUserId !== caller.userId) {
      throw new ForbiddenException('Cannot access records outside your caller ownership scope');
    }

    // 2. Forbidden field stripping based on caller role, at every nesting depth
    const forbiddenKeys = FORBIDDEN_KEYS_BY_ROLE.get(caller.role) ?? new Set<string>();

    return {
      ...record,
      data: this.stripForbidden(record.data, forbiddenKeys) as Record<string, any>,
    };
  }

  /**
   * Copy `value` without any forbidden key or `__proto__`, at any
   * depth of nested objects and arrays (#382). Key matching is
   * case-insensitive so `SSN` or `PrivateKey` cannot slip past the list.
   * O(n) time and space in the number of nodes in `value`.
   */
  private stripForbidden(value: unknown, forbiddenKeys: ReadonlySet<string>): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.stripForbidden(item, forbiddenKeys));
    }
    if (value === null || typeof value !== 'object' || value instanceof Date) {
      return value;
    }

    const cleaned: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === PROTOTYPE_KEY || forbiddenKeys.has(key.toLowerCase())) continue;
      cleaned[key] = this.stripForbidden(child, forbiddenKeys);
    }
    return cleaned;
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

    // Validate high-level permission for export type
    if (!this.validatePermission(caller, exportType)) {
      throw new ForbiddenException(
        `Role ${caller.role} is not authorized to export type ${exportType}`,
      );
    }

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
          };
        }

        // Project and sanitize records for caller role
        const sanitizedChunk = chunk.map((record) => this.sanitizeRecordForCaller(record, caller));

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
      };
    } catch (error) {
      if (abortSignal?.aborted || (error as any)?.name === 'AbortError') {
        return {
          exportId,
          status: 'cancelled',
          totalRecordsProcessed,
          totalChunks,
          cancelledAt: new Date(),
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
      };
    }
  }
}
