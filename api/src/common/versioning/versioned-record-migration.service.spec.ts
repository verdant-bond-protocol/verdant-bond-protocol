import {
  MIGRATION_ADMIN_ROLE,
  RecordMigrationError,
  VERSION_ORDER,
  VersionedRecordMigrationService,
  type MigrationActor,
} from './versioned-record-migration.service';
import {
  SchemaVersion,
  createVersionedRecord,
  type CompatibilityRegistry,
  type VersionedRecord,
} from './schema-versioning';

describe('VersionedRecordMigrationService (contributor slice)', () => {
  const admin: MigrationActor = { id: 'ops-1', roles: [MIGRATION_ADMIN_ROLE] };
  const investor: MigrationActor = { id: 'user-1', roles: ['user'] };
  const anonymous: MigrationActor = { id: '', roles: [] };

  let clock: number;
  let service: VersionedRecordMigrationService;

  const legacy = (): VersionedRecord<any> =>
    createVersionedRecord(
      {
        id: 'bond-1',
        symbol: 'VRT',
        faceValue: '1000',
        interestRate: 0.05,
        projectId: 'project-1',
        // V1.1/V1.2 transforms assume these already exist.
        creditType: 'Carbon',
        totalSubscribed: '0',
      },
      SchemaVersion.V1_0_0,
      { migratedAt: 100 },
    );

  beforeEach(() => {
    clock = 1_000;
    service = new VersionedRecordMigrationService(() => (clock += 10));
  });

  describe('normal paths', () => {
    it('upgrades every legacy version to the canonical V2.0.0 shape', () => {
      for (const from of VERSION_ORDER.slice(0, 3)) {
        const record = legacy();
        record.metadata.version = from;

        const result = service.migrate({ record, targetVersion: SchemaVersion.V2_0_0 }, admin);

        expect(result.changed).toBe(true);
        expect(result.replay).toBe(false);
        expect(result.fromVersion).toBe(from);
        expect(result.transformsApplied).toBe(VERSION_ORDER.length - 1 - VERSION_ORDER.indexOf(from));
        expect(result.record.metadata.version).toBe(SchemaVersion.V2_0_0);
        expect(result.record.metadata.migratedFrom).toBe(from);
        expect(result.record.data).toMatchObject({
          projectRegistryId: 'project-1',
          status: 'Active',
          creditType: 'Carbon',
        });
      }
    });

    it('downgrades a canonical record with the matching write transform', () => {
      const record = createVersionedRecord(
        { id: 'bond-1', faceValue: '1000', projectRegistryId: 'project-1' },
        SchemaVersion.V2_0_0,
      );

      const result = service.migrate({ record, targetVersion: SchemaVersion.V1_1_0 }, admin);

      expect(result.changed).toBe(true);
      expect(result.record.data).toMatchObject({ projectId: 'project-1' });
      expect(result.record.data).not.toHaveProperty('projectRegistryId');
      expect(result.record.metadata.migratedFrom).toBe(SchemaVersion.V2_0_0);
    });

    it('stamps migratedAt from the injected clock, never from wall time', () => {
      const result = service.migrate({ record: legacy(), targetVersion: SchemaVersion.V2_0_0 }, admin);
      expect(result.record.metadata.migratedAt).toBe(1_010);
    });
  });

  describe('failure paths', () => {
    it('refuses a record without schema metadata', () => {
      expect(() =>
        service.migrate({ record: { data: {} } as any, targetVersion: SchemaVersion.V2_0_0 }, admin),
      ).toThrow(RecordMigrationError);
      try {
        service.migrate({ record: { data: {} } as any, targetVersion: SchemaVersion.V2_0_0 }, admin);
      } catch (error) {
        expect((error as RecordMigrationError).code).toBe('invalid_record');
      }
    });

    it('refuses an unsupported target version', () => {
      expect(() =>
        service.migrate(
          { record: legacy(), targetVersion: '9.9.9' as SchemaVersion },
          admin,
        ),
      ).toThrow(expect.objectContaining({ code: 'unsupported_version' }));
    });

    it('refuses an upgrade when an intermediate read transform is missing', () => {
      const registry: CompatibilityRegistry = { readTransforms: [], writeTransforms: [] };
      expect(() =>
        service.migrate(
          { record: legacy(), targetVersion: SchemaVersion.V2_0_0, registry },
          admin,
        ),
      ).toThrow(expect.objectContaining({ code: 'missing_transform' }));
    });

    it('refuses a downgrade when no write transform exists for the target', () => {
      const registry: CompatibilityRegistry = { readTransforms: [], writeTransforms: [] };
      const record = createVersionedRecord({ id: 'bond-1' }, SchemaVersion.V2_0_0);
      expect(() =>
        service.migrate({ record, targetVersion: SchemaVersion.V1_2_0, registry }, admin),
      ).toThrow(expect.objectContaining({ code: 'missing_transform' }));
    });

    it('allows downgrade to the canonical version without a write transform', () => {
      const registry: CompatibilityRegistry = { readTransforms: [], writeTransforms: [] };
      const record = createVersionedRecord({ id: 'bond-1' }, SchemaVersion.V2_0_0);
      const result = service.migrate({ record, targetVersion: SchemaVersion.V2_0_0, registry }, admin);
      expect(result.replay).toBe(true);
    });
  });

  describe('retry paths', () => {
    it('replaying a completed migration returns the exact same envelope', () => {
      const first = service.migrate({ record: legacy(), targetVersion: SchemaVersion.V2_0_0 }, admin);
      const retry = service.migrate({ record: first.record, targetVersion: SchemaVersion.V2_0_0 }, admin);

      expect(retry.replay).toBe(true);
      expect(retry.changed).toBe(false);
      expect(retry.transformsApplied).toBe(0);
      expect(retry.record).toBe(first.record);
      expect(retry.record.metadata.migratedAt).toBe(first.record.metadata.migratedAt);
    });

    it('is safe to fan out, and whichever result a store adopts is stable on re-read', async () => {
      const record = legacy();
      const results = await Promise.all(
        Array.from({ length: 8 }, async () => {
          // Yield to interleave; the transform itself never mutates the input.
          await Promise.resolve();
          return service.migrate({ record, targetVersion: SchemaVersion.V2_0_0 }, admin);
        }),
      );

      expect(results.every((r) => r.changed)).toBe(true);
      expect(JSON.stringify(record.metadata.version)).toBe(JSON.stringify(SchemaVersion.V1_0_0));
      const distinctStamps = new Set(results.map((r) => r.record.metadata.migratedAt));
      expect(distinctStamps.size).toBe(8); // no hidden shared state between calls

      // Concurrent writers are resolved by the store's own compare-and-set;
      // whichever envelope wins, re-reading it is a no-op replay.
      const stored = results[3].record;
      const replay = service.migrate({ record: stored, targetVersion: SchemaVersion.V2_0_0 }, admin);
      expect(replay.record).toBe(stored);
      expect(replay.record.metadata.migratedAt).toBe(stored.metadata.migratedAt);
    });
  });

  describe('authorization paths', () => {
    it('rejects anonymous and non-admin callers before touching the record', () => {
      for (const actor of [anonymous, investor]) {
        const record = legacy();
        const before = JSON.stringify(record);
        expect(() =>
          service.migrate({ record, targetVersion: SchemaVersion.V2_0_0 }, actor),
        ).toThrow(expect.objectContaining({ code: 'migration_forbidden' }));
        expect(JSON.stringify(record)).toBe(before);
      }
    });

    it('admins may migrate and the denial does not depend on the target version', () => {
      const result = service.migrate({ record: legacy(), targetVersion: SchemaVersion.V2_0_0 }, admin);
      expect(result.changed).toBe(true);
      expect(() =>
        service.migrate({ record: legacy(), targetVersion: '9.9.9' as SchemaVersion }, investor),
      ).toThrow(expect.objectContaining({ code: 'migration_forbidden' }));
    });
  });
});
