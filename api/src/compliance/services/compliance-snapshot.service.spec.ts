import { ComplianceSnapshotService, COMPLIANCE_SNAPSHOT_SCHEMA_VERSION } from './compliance-snapshot.service';
import { ComplianceRulesEngine } from './compliance-rules.engine';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ComplianceController } from '../controllers/compliance.controller';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AdminGuard } from '../../common/guards/admin.guard';

describe('ComplianceSnapshotService', () => {
  const engine = { getActiveRuleset: jest.fn(() => ({ version: '2026.1', auditHash: 'rules-hash' })) } as unknown as ComplianceRulesEngine;
  let service: ComplianceSnapshotService;

  beforeEach(() => { service = new ComplianceSnapshotService(engine); });

  it('captures one versioned snapshot per critical event', async () => {
    const first = await service.capture('bond:1:issued', 'BOND_ISSUED', 1, { transactionHash: 'tx1' });
    const repeated = await service.capture('bond:1:issued', 'BOND_ISSUED', 1, { transactionHash: 'different' });
    expect(repeated).toEqual(first);
    expect(first.schemaVersion).toBe(COMPLIANCE_SNAPSHOT_SCHEMA_VERSION);
    expect(first.payload).toEqual({ eventData: { transactionHash: 'tx1' }, ruleset: { version: '2026.1', auditHash: 'rules-hash' } });
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(service.verify(first)).toBe(true);
  });

  it('detects altered payloads and metadata', async () => {
    const snapshot = await service.capture('bond:2:matured', 'BOND_MATURED', 2, { status: 'Matured' });
    expect(service.verify({ ...snapshot, payload: { status: 'Active' } })).toBe(false);
    expect(service.verify({ ...snapshot, schemaVersion: 2 })).toBe(false);
    const fetched = await service.get('bond:2:matured');
    expect(fetched).toEqual(snapshot);
  });

  it('requires wallet authentication and admin authorization for audit reads', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, ComplianceController.prototype.getSnapshot);
    expect(guards).toContain(JwtAuthGuard);
    expect(guards).toContain(AdminGuard);
  });
});
