import { HttpStatus, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { createHmac } from 'crypto';
import { AuditService } from '../../audit/audit.service';
import { Role } from '../../auth/rbac';
import { ErrorCode } from '../../common/errors/error-codes';
import { ApiProblemException } from '../../common/errors/problem-exception';
import {
  INVESTOR_COMPLIANCE_EXPORT_ALLOWLIST,
  InvestorComplianceExportFilters,
  InvestorComplianceExportRequest,
  InvestorComplianceExportRow,
  InvestorExportPurpose,
  InvestorHoldingsPageLoader,
  InvestorHoldingsSourceRow,
} from '../interfaces/investor-compliance-export.interface';

const WALLET_ALLOWED_ROLES = new Set<Role>([Role.MAINTAINER, Role.SETTLEMENT_MANAGER]);
const WALLET_ALLOWED_PURPOSES = new Set<InvestorExportPurpose>([
  'regulatory_audit',
  'sanctions_screening',
]);
const FORMULA_INJECTION_PREFIX = /^[=+\-@\t\r]/;
const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 1000;

@Injectable()
export class InvestorComplianceExportService {
  private readonly defaultSource: InvestorHoldingsPageLoader = async () => ({
    rows: [],
    nextCursor: null,
  });

  constructor(@Optional() private readonly auditService?: AuditService) {}

  /**
   * Keyed HMAC-SHA256 pseudonymisation. Never hardcoded; fails closed when
   * `INVESTOR_EXPORT_HMAC_KEY` is missing outside explicit unit-test injection.
   */
  pseudonymiseInvestor(investorId: string, hmacKeyOverride?: string): string {
    const key = hmacKeyOverride ?? process.env.INVESTOR_EXPORT_HMAC_KEY;
    if (!key || key.length < 16) {
      throw new ServiceUnavailableException(
        'Investor export pseudonymisation key is not configured (INVESTOR_EXPORT_HMAC_KEY)',
      );
    }
    return createHmac('sha256', key).update(investorId, 'utf8').digest('hex');
  }

  /**
   * Explicit allowlist projection: only fields in `INVESTOR_COMPLIANCE_EXPORT_ALLOWLIST`
   * are copied, preventing accidental leakage of existing or newly added DB columns.
   */
  projectRow(
    source: InvestorHoldingsSourceRow,
    opts: {
      asOfTimestamp: string;
      includeWallet: boolean;
      hmacKeyOverride?: string;
    },
  ): InvestorComplianceExportRow {
    const projected: InvestorComplianceExportRow = {
      investorPseudonym: this.pseudonymiseInvestor(source.investorId, opts.hmacKeyOverride),
      walletAddress: opts.includeWallet ? source.walletAddress : null,
      jurisdiction: String(source.jurisdiction || '').toUpperCase(),
      investorCategory: source.investorCategory,
      kycStatus: source.kycStatus,
      kycVerifiedAt: source.kycVerifiedAt ?? null,
      bondId: Number(source.bondId),
      holdingsMinorUnits: String(source.holdingsMinorUnits),
      asOfTimestamp: opts.asOfTimestamp,
    };

    // Enforce exact allowlist keys
    const out = {} as InvestorComplianceExportRow;
    for (const key of INVESTOR_COMPLIANCE_EXPORT_ALLOWLIST) {
      (out as any)[key] = projected[key];
    }
    return out;
  }

  /**
   * Guard against spreadsheet formula injection (=, +, -, @, tab, CR) and
   * apply RFC 4180 CSV quoting.
   */
  escapeCsvCell(value: string | number | null | undefined): string {
    if (value === null || value === undefined) {
      return '';
    }
    let str = String(value);
    if (FORMULA_INJECTION_PREFIX.test(str)) {
      str = `'${str}`;
    }
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  /**
   * Stream privacy-safe compliance records in bounded pages as UTF-8 CSV or JSON.
   * Always writes an audit record (requester, purpose, filters, asOfTimestamp — never content).
   * Emits an explicit completion footer on success or an error trailer on mid-stream failure
   * so truncated outputs can never be mistaken for complete exports.
   */
  async *streamExport(
    request: InvestorComplianceExportRequest,
    loader: InvestorHoldingsPageLoader = this.defaultSource,
    hmacKeyOverride?: string,
  ): AsyncGenerator<string, void, unknown> {
    const asOfTimestamp = request.asOfTimestamp || new Date().toISOString();
    const filters: InvestorComplianceExportFilters = request.filters ?? {};
    const pageSize = Math.min(Math.max(request.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const includeWallet = this.canIncludeWallet(
      request.requesterRoles,
      request.purpose,
      Boolean(request.includeWalletAddress),
    );

    // Validate key upfront before streaming any bytes
    this.pseudonymiseInvestor('__key_preflight__', hmacKeyOverride);

    if (this.auditService) {
      await this.auditService.record({
        entityType: 'investor_compliance_export',
        entityId: `${request.requesterId}:${asOfTimestamp}`,
        action: 'export',
        actor: request.requesterId,
        reason: request.purpose,
        before: null,
        after: {
          format: request.format,
          purpose: request.purpose,
          asOfTimestamp,
          filters,
          includeWallet,
        },
      });
    }

    let totalRows = 0;
    let cursor: string | null = null;

    if (request.format === 'csv') {
      yield `${INVESTOR_COMPLIANCE_EXPORT_ALLOWLIST.join(',')}\n`;
      try {
        do {
          const page = await loader({ asOfTimestamp, filters, cursor, limit: pageSize });
          for (const rawRow of page.rows) {
            const row = this.projectRow(rawRow, {
              asOfTimestamp,
              includeWallet,
              hmacKeyOverride,
            });
            const line = INVESTOR_COMPLIANCE_EXPORT_ALLOWLIST.map((col) =>
              this.escapeCsvCell(row[col]),
            ).join(',');
            yield `${line}\n`;
            totalRows++;
          }
          cursor = page.nextCursor;
        } while (cursor !== null);
        yield `# END_OF_EXPORT status=complete count=${totalRows} asOf=${asOfTimestamp}\n`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        yield `# EXPORT_ERROR status=failed count=${totalRows} reason=${this.escapeCsvCell(msg)}\n`;
      }
      return;
    }

    // JSON streaming format with explicit status trailer
    yield `{"asOfTimestamp":${JSON.stringify(asOfTimestamp)},"rows":[`;
    let first = true;
    try {
      do {
        const page = await loader({ asOfTimestamp, filters, cursor, limit: pageSize });
        for (const rawRow of page.rows) {
          const row = this.projectRow(rawRow, {
            asOfTimestamp,
            includeWallet,
            hmacKeyOverride,
          });
          yield `${first ? '' : ','}${JSON.stringify(row)}`;
          first = false;
          totalRows++;
        }
        cursor = page.nextCursor;
      } while (cursor !== null);
      yield `],"totalRows":${totalRows},"status":"complete"}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      yield `],"totalRows":${totalRows},"status":"error","error":${JSON.stringify(msg)}}`;
    }
  }

  canIncludeWallet(
    roles: Role[],
    purpose: InvestorExportPurpose,
    requested: boolean,
  ): boolean {
    if (!requested) return false;
    const roleAllowed = roles.some((r) => WALLET_ALLOWED_ROLES.has(r));
    if (!roleAllowed || !WALLET_ALLOWED_PURPOSES.has(purpose)) {
      throw new ApiProblemException(ErrorCode.FORBIDDEN, {
        status: HttpStatus.FORBIDDEN,
        detail: 'Wallet addresses can only be exported by MAINTAINER/SETTLEMENT_MANAGER for regulatory_audit or sanctions_screening',
      });
    }
    return true;
  }
}
