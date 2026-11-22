import { AuditService } from '../audit/audit.service';
import { Permission, Role, RolePermissions } from '../auth/rbac';
import { ErrorCode } from '../common/errors/error-codes';
import {
  LEGACY_METHODOLOGY_ID,
  LEGACY_METHODOLOGY_VERSION,
} from './interfaces/methodology-version.interface';
import { MethodologyVersioningService } from './methodology-versioning.service';

describe('MethodologyVersioningService (#622)', () => {
  let audit: AuditService;
  let service: MethodologyVersioningService;

  const ISSUER = 'GISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const APPROVER = 'GAPPROVERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  beforeEach(() => {
    audit = new AuditService();
    service = new MethodologyVersioningService(audit);
  });

  it('creates a draft, activates it, and records an audit trail', async () => {
    const draft = await service.createDraft({
      id: 'VERRA-VCS',
      name: 'Verra Verified Carbon Standard',
      version: '1.0.0',
      effectiveDate: '2026-01-01',
      documentContent: 'Baseline rules v1',
      actor: ISSUER,
    });
    expect(draft.status).toBe('draft');
    expect(draft.contentHash).toHaveLength(64);

    const active = await service.activateVersion('VERRA-VCS', '1.0.0', APPROVER);
    expect(active.status).toBe('active');
    expect(active.approvedBy).toBe(APPROVER);

    const history = audit.getEntityHistory('methodology', 'VERRA-VCS@1.0.0');
    expect(history.map((h) => h.action)).toEqual(['create_draft', 'activate']);
  });

  it('enforces immutability of active versions and detects document tampering on read', async () => {
    await service.createDraft({
      id: 'VERRA-VCS',
      name: 'Verra VCS',
      version: '1.0.0',
      effectiveDate: '2026-01-01',
      documentContent: 'Immutable content',
      actor: ISSUER,
    });
    await service.activateVersion('VERRA-VCS', '1.0.0', APPROVER);

    await expect(
      service.updateDraft('VERRA-VCS', '1.0.0', {
        documentContent: 'Edited content',
        actor: ISSUER,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.METHODOLOGY_IMMUTABLE });

    service.tamperDocumentForTest('VERRA-VCS', '1.0.0', 'Tampered content');
    expect(() => service.getVersion('VERRA-VCS', '1.0.0')).toThrow(
      expect.objectContaining({ code: ErrorCode.METHODOLOGY_TAMPER_DETECTED }),
    );
  });

  it('pins methodology permanently at bond issuance and rejects re-pinning', async () => {
    await service.createDraft({
      id: 'GOLD-STANDARD',
      name: 'Gold Standard',
      version: '1.0.0',
      effectiveDate: '2026-01-01',
      documentContent: 'GS v1',
      actor: ISSUER,
    });
    const active = await service.activateVersion('GOLD-STANDARD', '1.0.0', APPROVER);

    const pin = await service.pinMethodologyToBond(101, 'GOLD-STANDARD', '1.0.0', ISSUER);
    expect(pin.contentHash).toBe(active.contentHash);

    await expect(
      service.pinMethodologyToBond(101, 'GOLD-STANDARD', '1.0.0', ISSUER),
    ).rejects.toMatchObject({ code: ErrorCode.METHODOLOGY_ALREADY_PINNED });
  });

  it('validates report methodology against pinned, unapproved, later, and deprecated versions', async () => {
    await service.createDraft({
      id: 'VERRA-VCS',
      name: 'Verra VCS',
      version: '1.0.0',
      effectiveDate: '2026-01-01',
      documentContent: 'v1',
      actor: ISSUER,
    });
    await service.activateVersion('VERRA-VCS', '1.0.0', APPROVER);
    await service.pinMethodologyToBond(1, 'VERRA-VCS', '1.0.0', ISSUER);

    // Pinned version accepted
    const b1 = await service.recordReportMethodology({
      reportId: 10,
      bondId: 1,
      methodologyId: 'VERRA-VCS',
      version: '1.0.0',
      actor: ISSUER,
    });
    expect(b1.isLaterVersionOverride).toBe(false);

    // Draft (unapproved) version rejected
    await service.createDraft({
      id: 'VERRA-VCS',
      name: 'Verra VCS',
      version: '2.0.0',
      effectiveDate: '2026-06-01',
      documentContent: 'v2',
      actor: ISSUER,
    });
    await expect(
      service.recordReportMethodology({
        reportId: 11,
        bondId: 1,
        methodologyId: 'VERRA-VCS',
        version: '2.0.0',
        actor: ISSUER,
        overrideReason: 'Upgrade',
        overrideApprovedBy: APPROVER,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.METHODOLOGY_VERSION_NOT_ALLOWED });

    // Activate v2.0.0: rejected without reason/approver, accepted with reason/approver
    await service.activateVersion('VERRA-VCS', '2.0.0', APPROVER);
    await expect(
      service.recordReportMethodology({
        reportId: 12,
        bondId: 1,
        methodologyId: 'VERRA-VCS',
        version: '2.0.0',
        actor: ISSUER,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.METHODOLOGY_VERSION_NOT_ALLOWED });

    const b2 = await service.recordReportMethodology({
      reportId: 12,
      bondId: 1,
      methodologyId: 'VERRA-VCS',
      version: '2.0.0',
      actor: ISSUER,
      overrideReason: 'Updated IPCC factor adopted by governance',
      overrideApprovedBy: APPROVER,
    });
    expect(b2.isLaterVersionOverride).toBe(true);
    expect(b2.overrideReason).toContain('Updated IPCC factor');

    // Deprecate v2.0.0: new reports and new bond pins rejected
    await service.deprecateVersion('VERRA-VCS', '2.0.0', APPROVER, 'Superseded by 3.0.0');
    await expect(
      service.recordReportMethodology({
        reportId: 13,
        bondId: 1,
        methodologyId: 'VERRA-VCS',
        version: '2.0.0',
        actor: ISSUER,
        overrideReason: 'Late report',
        overrideApprovedBy: APPROVER,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.METHODOLOGY_VERSION_NOT_ALLOWED });
    await expect(
      service.pinMethodologyToBond(2, 'VERRA-VCS', '2.0.0', ISSUER),
    ).rejects.toMatchObject({ code: ErrorCode.METHODOLOGY_VERSION_NOT_ALLOWED });
  });

  it('runs idempotent legacy migration and supports clean rollback', async () => {
    await service.createDraft({
      id: 'ACR',
      name: 'ACR',
      version: '1.0.0',
      effectiveDate: '2026-01-01',
      documentContent: 'ACR v1',
      actor: ISSUER,
    });
    await service.activateVersion('ACR', '1.0.0', APPROVER);
    await service.pinMethodologyToBond(50, 'ACR', '1.0.0', ISSUER);

    const m1 = await service.migrateLegacyBondsAndReports(
      [1, 2, 50],
      [{ reportId: 100, bondId: 1 }],
      APPROVER,
    );
    expect(m1.migratedBondIds).toEqual([1, 2]);
    expect(m1.skippedBondIds).toEqual([50]);
    expect(m1.migratedReportIds).toEqual([100]);
    expect(service.getBondPin(1)?.methodologyId).toBe(LEGACY_METHODOLOGY_ID);
    expect(service.getBondPin(1)?.version).toBe(LEGACY_METHODOLOGY_VERSION);

    // Re-running migration is idempotent
    const m2 = await service.migrateLegacyBondsAndReports(
      [1, 2, 50],
      [{ reportId: 100, bondId: 1 }],
      APPROVER,
    );
    expect(m2.migratedBondIds).toEqual([]);
    expect(m2.skippedBondIds).toEqual([1, 2, 50]);

    // Rollback removes only legacy-migrated pins/bindings, preserving bond 50
    const rb = await service.rollbackLegacyMigration(APPROVER);
    expect(rb.rolledBackBondIds).toEqual([1, 2]);
    expect(rb.rolledBackReportIds).toEqual([100]);
    expect(service.getBondPin(1)).toBeNull();
    expect(service.getBondPin(50)?.methodologyId).toBe('ACR');
  });

  it('restricts MANAGE_METHODOLOGIES permission away from INVESTOR role', () => {
    expect(RolePermissions[Role.INVESTOR]).not.toContain(Permission.MANAGE_METHODOLOGIES);
    expect(RolePermissions[Role.ISSUER]).toContain(Permission.MANAGE_METHODOLOGIES);
    expect(RolePermissions[Role.MAINTAINER]).toContain(Permission.MANAGE_METHODOLOGIES);
  });
});
