import { AuditService } from '../../audit/audit.service';
import { Permission, Role, RolePermissions } from '../../auth/rbac';
import { ErrorCode } from '../../common/errors/error-codes';
import { KycStatus } from '../../common/interfaces/authenticated-request.interface';
import {
  INVESTOR_COMPLIANCE_EXPORT_ALLOWLIST,
  InvestorHoldingsPageLoader,
  InvestorHoldingsSourceRow,
} from '../interfaces/investor-compliance-export.interface';
import { InvestorComplianceExportService } from './investor-compliance-export.service';

describe('InvestorComplianceExportService (#619)', () => {
  let audit: AuditService;
  let service: InvestorComplianceExportService;
  const TEST_HMAC_KEY = 'unit-test-hmac-secret-key-at-least-32-chars';

  const makeRow = (overrides: Partial<InvestorHoldingsSourceRow> = {}): InvestorHoldingsSourceRow => ({
    investorId: 'inv-001',
    walletAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    jurisdiction: 'us',
    investorCategory: 'accredited',
    kycStatus: KycStatus.ACCREDITED,
    kycVerifiedAt: '2026-01-01T00:00:00.000Z',
    bondId: 42,
    holdingsMinorUnits: '50000000',
    // Sensitive / extra columns that must NEVER leak
    fullName: 'Alice Example',
    email: 'alice@example.com',
    taxId: '123-45-6789',
    documentNumber: 'P99887766',
    streetAddress: '123 Secret Lane',
    newUnexpectedColumn: 'should-never-appear',
    ...overrides,
  });

  const collect = async (gen: AsyncGenerator<string>): Promise<string> => {
    let out = '';
    for await (const chunk of gen) {
      out += chunk;
    }
    return out;
  };

  beforeEach(() => {
    audit = new AuditService();
    service = new InvestorComplianceExportService(audit);
  });

  it('enforces strict allowlist so existing PII and newly added columns never leak', () => {
    const projected = service.projectRow(makeRow(), {
      asOfTimestamp: '2026-02-01T00:00:00.000Z',
      includeWallet: false,
      hmacKeyOverride: TEST_HMAC_KEY,
    });

    expect(Object.keys(projected)).toEqual([...INVESTOR_COMPLIANCE_EXPORT_ALLOWLIST]);
    expect(projected.walletAddress).toBeNull();
    expect(projected.jurisdiction).toBe('US');
    expect((projected as any).fullName).toBeUndefined();
    expect((projected as any).taxId).toBeUndefined();
    expect((projected as any).newUnexpectedColumn).toBeUndefined();
  });

  it('produces stable keyed pseudonyms that do not reveal the raw investorId', () => {
    const p1 = service.pseudonymiseInvestor('inv-001', TEST_HMAC_KEY);
    const p2 = service.pseudonymiseInvestor('inv-001', TEST_HMAC_KEY);
    const pOther = service.pseudonymiseInvestor('inv-002', TEST_HMAC_KEY);

    expect(p1).toBe(p2);
    expect(p1).not.toBe(pOther);
    expect(p1).not.toContain('inv-001');
    expect(p1).toHaveLength(64);
  });

  it('guards CSV cells against formula injection and quotes commas, quotes, and newlines', () => {
    expect(service.escapeCsvCell('=CMD()')).toBe("'=CMD()");
    expect(service.escapeCsvCell('+1+1')).toBe("'+1+1");
    expect(service.escapeCsvCell('-2+3')).toBe("'-2+3");
    expect(service.escapeCsvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(service.escapeCsvCell('\tcmd')).toBe("'\tcmd");
    expect(service.escapeCsvCell('\rcmd')).toBe('"\'\rcmd"');
    expect(service.escapeCsvCell('a,b')).toBe('"a,b"');
    expect(service.escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(service.escapeCsvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('gates walletAddress by role and stated purpose', async () => {
    const loader: InvestorHoldingsPageLoader = async () => ({
      rows: [makeRow()],
      nextCursor: null,
    });

    await expect(
      collect(
        service.streamExport(
          {
            requesterId: 'issuer-1',
            requesterRoles: [Role.ISSUER],
            purpose: 'regulatory_audit',
            format: 'json',
            includeWalletAddress: true,
          },
          loader,
          TEST_HMAC_KEY,
        ),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });

    await expect(
      collect(
        service.streamExport(
          {
            requesterId: 'maint-1',
            requesterRoles: [Role.MAINTAINER],
            purpose: 'portfolio_analytics',
            format: 'json',
            includeWalletAddress: true,
          },
          loader,
          TEST_HMAC_KEY,
        ),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });

    const allowedJson = await collect(
      service.streamExport(
        {
          requesterId: 'maint-1',
          requesterRoles: [Role.MAINTAINER],
          purpose: 'regulatory_audit',
          format: 'json',
          includeWalletAddress: true,
          asOfTimestamp: '2026-02-01T00:00:00.000Z',
        },
        loader,
        TEST_HMAC_KEY,
      ),
    );
    const parsed = JSON.parse(allowedJson);
    expect(parsed.status).toBe('complete');
    expect(parsed.rows[0].walletAddress).toBe(makeRow().walletAddress);
  });

  it('records an audit entry with requester, purpose, and filters without logging exported rows', async () => {
    const asOf = '2026-02-01T00:00:00.000Z';
    const csv = await collect(
      service.streamExport(
        {
          requesterId: 'issuer-1',
          requesterRoles: [Role.ISSUER],
          purpose: 'compliance_reporting',
          format: 'csv',
          asOfTimestamp: asOf,
          filters: { bondId: 42, jurisdiction: 'US' },
        },
        async () => ({ rows: [], nextCursor: null }),
        TEST_HMAC_KEY,
      ),
    );

    expect(csv).toContain('# END_OF_EXPORT status=complete count=0 asOf=2026-02-01T00:00:00.000Z');
    const history = audit.getEntityHistory('investor_compliance_export', `issuer-1:${asOf}`);
    expect(history).toHaveLength(1);
    expect(history[0].actor).toBe('issuer-1');
    expect(history[0].reason).toBe('compliance_reporting');
    expect(history[0].after).toEqual({
      format: 'csv',
      purpose: 'compliance_reporting',
      asOfTimestamp: asOf,
      filters: { bondId: 42, jurisdiction: 'US' },
      includeWallet: false,
    });
  });

  it('streams large exports in bounded pages and marks mid-stream failures clearly', async () => {
    const total = 250;
    const paginatedLoader: InvestorHoldingsPageLoader = async ({ cursor, limit }) => {
      const offset = cursor ? parseInt(cursor, 10) : 0;
      const rows: InvestorHoldingsSourceRow[] = [];
      for (let i = offset; i < Math.min(offset + limit, total); i++) {
        rows.push(makeRow({ investorId: `inv-${i}` }));
      }
      const next = offset + rows.length < total ? String(offset + rows.length) : null;
      return { rows, nextCursor: next };
    };

    const jsonOut = await collect(
      service.streamExport(
        {
          requesterId: 'maint-1',
          requesterRoles: [Role.MAINTAINER],
          purpose: 'compliance_reporting',
          format: 'json',
          pageSize: 100,
          asOfTimestamp: '2026-02-01T00:00:00.000Z',
        },
        paginatedLoader,
        TEST_HMAC_KEY,
      ),
    );
    const parsed = JSON.parse(jsonOut);
    expect(parsed.status).toBe('complete');
    expect(parsed.totalRows).toBe(250);
    expect(parsed.rows).toHaveLength(250);

    // Mid-stream failure must not look complete
    let calls = 0;
    const failingLoader: InvestorHoldingsPageLoader = async () => {
      calls++;
      if (calls === 1) {
        return { rows: [makeRow()], nextCursor: '1' };
      }
      throw new Error('DB cursor timeout');
    };

    const failedCsv = await collect(
      service.streamExport(
        {
          requesterId: 'maint-1',
          requesterRoles: [Role.MAINTAINER],
          purpose: 'compliance_reporting',
          format: 'csv',
          asOfTimestamp: '2026-02-01T00:00:00.000Z',
        },
        failingLoader,
        TEST_HMAC_KEY,
      ),
    );
    expect(failedCsv).not.toContain('END_OF_EXPORT');
    expect(failedCsv).toContain('# EXPORT_ERROR status=failed count=1 reason=DB cursor timeout');
  });

  it('restricts EXPORT_INVESTOR_COMPLIANCE permission away from INVESTOR role', () => {
    expect(RolePermissions[Role.INVESTOR]).not.toContain(Permission.EXPORT_INVESTOR_COMPLIANCE);
    expect(RolePermissions[Role.ISSUER]).toContain(Permission.EXPORT_INVESTOR_COMPLIANCE);
    expect(RolePermissions[Role.SETTLEMENT_MANAGER]).toContain(Permission.EXPORT_INVESTOR_COMPLIANCE);
    expect(RolePermissions[Role.MAINTAINER]).toContain(Permission.EXPORT_INVESTOR_COMPLIANCE);
  });
});
