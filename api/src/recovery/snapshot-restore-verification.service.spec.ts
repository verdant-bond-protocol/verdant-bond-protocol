import { DomainInvariantsService } from '../reconciliation/services/domain-invariants.service';
import { BondStatusEnum } from '../bonds/interfaces/bond.interface';
import { KycStatus } from '../common/interfaces/authenticated-request.interface';
import {
  CriticalDataSections,
  CriticalDataSnapshot,
  HolderIndexData,
  RestoreVerificationError,
  SnapshotRestoreVerificationService,
} from './snapshot-restore-verification.service';

const ALICE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const BOB = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const CAROL = 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

function sections(): CriticalDataSections {
  return {
    bonds: [
      { id: 1, projectId: 'proj-1', totalSupply: '1000', totalSubscribed: '700', status: BondStatusEnum.Active },
      { id: 2, projectId: 'proj-1', totalSupply: '500', totalSubscribed: '100', status: BondStatusEnum.Active },
    ],
    projects: [{ id: 'proj-1', name: 'Mangrove Restoration' }],
    orders: [{ id: 10, bondId: 1, amount: '50', status: 'Open', expiresAt: new Date(Date.now() + 86_400_000).toISOString() }],
    kycRecords: [{ address: ALICE, status: KycStatus.VERIFIED, expiresAt: Date.now() + 86_400_000 }],
    holdersByBond: {
      '1': [
        { address: BOB, balance: '400' },
        { address: ALICE, balance: '300' },
        { address: CAROL, balance: '0' },
      ],
      '2': [{ address: ALICE, balance: '100' }],
    },
    settlementTransactions: [{ txHash: 'a'.repeat(64), entityType: 'subscription', entityId: '1' }],
  };
}

/** The holder index a healthy deployment would have persisted for `sections()`. */
function healthyIndex(): HolderIndexData {
  return {
    holders: { '1': [ALICE, BOB], '2': [ALICE] },
    knownAddresses: [ALICE, BOB, CAROL],
    lastReconciled: { '1': 1_760_000_000_000, '2': 1_760_000_000_000 },
  };
}

/** A backup written to disk and read back, as a restore does. */
const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value));

describe('SnapshotRestoreVerificationService (#379)', () => {
  let service: SnapshotRestoreVerificationService;

  beforeEach(() => {
    // Hermetic: the invariants see only the snapshot, never a live store.
    const invariants = new DomainInvariantsService(
      { scanKeys: jest.fn().mockResolvedValue([]), get: jest.fn().mockResolvedValue(null) } as any,
      { list: jest.fn().mockResolvedValue([]), listAudit: jest.fn().mockResolvedValue([]) } as any,
    );
    service = new SnapshotRestoreVerificationService(invariants);
  });

  const captured = (data = sections()): CriticalDataSnapshot => roundTrip(service.capture(data, new Date('2026-10-01T00:00:00Z')));

  it('verifies a clean capture → restore round trip', async () => {
    const report = await service.verify(captured(), roundTrip(healthyIndex()));

    expect(report.status).toBe('VERIFIED');
    expect(report.mismatches).toEqual([]);
    expect(report.snapshotCapturedAt).toBe('2026-10-01T00:00:00.000Z');
  });

  describe('integrity', () => {
    it('fails on a truncated section', async () => {
      const snapshot = captured();
      snapshot.sections.bonds.pop();

      const report = await service.verify(snapshot, healthyIndex());

      expect(report.status).toBe('FAILED');
      expect(report.mismatches).toContainEqual(
        expect.objectContaining({
          check: 'SNAPSHOT_INTEGRITY',
          severity: 'CRITICAL',
          entity: 'bonds',
          description: 'Restored 1 record(s), manifest expects 2',
        }),
      );
    });

    it('fails on contents altered without changing the record count', async () => {
      const snapshot = captured();
      snapshot.sections.holdersByBond['1'][0].balance = '401';

      const report = await service.verify(snapshot, healthyIndex());

      expect(report.mismatches).toContainEqual(
        expect.objectContaining({ check: 'SNAPSHOT_INTEGRITY', entity: 'holdersByBond', description: expect.stringMatching(/SHA-256/) }),
      );
    });

    it('fails on a section missing from the restore or from the manifest', async () => {
      const snapshot = captured();
      delete (snapshot.sections as any).orders;
      delete (snapshot.manifest as any).kycRecords;

      const entities = (await service.verify(snapshot, healthyIndex())).mismatches
        .filter((m) => m.check === 'SNAPSHOT_INTEGRITY')
        .map((m) => m.entity);

      expect(entities).toEqual(expect.arrayContaining(['orders', 'kycRecords']));
    });

    it('refuses an unknown snapshot format', async () => {
      const report = await service.verify({ ...captured(), version: 2 }, healthyIndex());
      expect(report.mismatches[0]).toEqual(expect.objectContaining({ check: 'SNAPSHOT_INTEGRITY', entity: 'snapshot' }));
    });
  });

  describe('domain invariants', () => {
    it('fails when restored balances do not add up to the recorded subscription total', async () => {
      const data = sections();
      data.bonds[0].totalSubscribed = '650';

      const report = await service.verify(captured(data), healthyIndex());

      expect(report.status).toBe('FAILED');
      expect(report.mismatches).toContainEqual(
        expect.objectContaining({
          check: 'DOMAIN_INVARIANT',
          severity: 'CRITICAL',
          entity: 'bond:1',
          repair: expect.stringMatching(/reindex-holders/),
        }),
      );
    });

    it('reports time-dependent drifts as warnings without failing the restore', async () => {
      const data = sections();
      data.orders[0].expiresAt = '2026-01-01T00:00:00Z';

      const report = await service.verify(captured(data), healthyIndex());

      expect(report.status).toBe('VERIFIED');
      expect(report.warnings).toEqual([expect.objectContaining({ check: 'DOMAIN_INVARIANT', entity: 'order:10' })]);
    });
  });

  describe('derived holder index', () => {
    it('rebuilds membership deterministically from positive balances and forces on-chain reconciliation', () => {
      const rebuilt = service.rebuildHolderIndex(sections(), { holders: {}, knownAddresses: ['GZZZ'], lastReconciled: {} });

      expect(rebuilt).toEqual({
        holders: { '1': [ALICE, BOB], '2': [ALICE] },
        knownAddresses: [ALICE, BOB, CAROL, 'GZZZ'],
        lastReconciled: { '1': 0, '2': 0 },
      });
    });

    it('fails with a repair step when the index is missing a holder', async () => {
      const index = healthyIndex();
      index.holders['1'] = [BOB];

      const report = await service.verify(captured(), index);

      expect(report.mismatches).toEqual([
        expect.objectContaining({
          check: 'DERIVED_INDEX',
          severity: 'HIGH',
          entity: `holder-index:1:${ALICE}`,
          repair: 'Rewrite the holder index from the snapshot (--repair), then npm run reindex-holders -- --bond=1',
        }),
      ]);
    });

    it('fails when the index lists a zero-balance address, an unknown bond, or misses a known address', async () => {
      const index = healthyIndex();
      index.holders['1'] = [ALICE, BOB, CAROL];
      index.holders['9'] = [BOB];
      index.knownAddresses = [ALICE, CAROL];

      const entities = (await service.verify(captured(), index)).mismatches.map((m) => m.entity);

      expect(entities).toEqual(
        expect.arrayContaining([`holder-index:1:${CAROL}`, 'holder-index:9', `known-address:${BOB}`]),
      );
    });

    it('fails on a balance that is not an integer', async () => {
      const data = sections();
      data.holdersByBond['2'][0].balance = '1e3';

      const report = await service.verify(captured(data), healthyIndex());

      expect(report.mismatches).toContainEqual(
        expect.objectContaining({ check: 'DERIVED_INDEX', severity: 'CRITICAL', entity: `holder:2:${ALICE}` }),
      );
    });

    it('verifies cleanly once the rebuilt index is written back (the --repair path)', async () => {
      const snapshot = captured();
      const broken = { holders: { '1': [CAROL] }, knownAddresses: [], lastReconciled: {} };

      const first = await service.verify(snapshot, broken);
      expect(first.status).toBe('FAILED');

      const repaired = roundTrip(first.rebuiltHolderIndex);
      expect((await service.verify(snapshot, repaired)).status).toBe('VERIFIED');
    });
  });

  it('verifyOrThrow fails loudly, naming every mismatch', async () => {
    const index = healthyIndex();
    index.holders['2'] = [];

    await expect(service.verifyOrThrow(captured(), index)).rejects.toThrow(RestoreVerificationError);
    await expect(service.verifyOrThrow(captured(), index)).rejects.toThrow(`holder-index:2:${ALICE}`);
    await expect(service.verifyOrThrow(captured(), healthyIndex())).resolves.toEqual(
      expect.objectContaining({ status: 'VERIFIED' }),
    );
  });
});
