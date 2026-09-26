import { Test, TestingModule } from '@nestjs/testing';
import { MigrationSafetyService } from './migration-safety.service';
import { MigrationDefinition } from './migration.interface';

describe('MigrationSafetyService (#263)', () => {
  let service: MigrationSafetyService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MigrationSafetyService],
    }).compile();
    service = module.get<MigrationSafetyService>(MigrationSafetyService);
  });

  /** A well-formed migration used by the passing scenarios. */
  const goodMigration = (writes: string[] = []): MigrationDefinition => ({
    id: 'add_bond_secondary_index',
    description: 'adds a covering index for secondary-market queries',
    rollback: 'DROP INDEX CONCURRENTLY IF NOT EXISTS idx_bonds_secondary;',
    dryRun: async () => [
      { target: 'bonds', estimate: 1200, detail: 'creates idx_bonds_secondary' },
    ],
    apply: async () => {
      writes.push('applied');
      return { created: 'idx_bonds_secondary' };
    },
    postChecks: [
      {
        name: 'index_exists',
        check: async () => (writes.length > 0 ? null : 'index missing after apply'),
      },
      {
        name: 'no_orphan_rows',
        check: async () => null,
      },
    ],
  });

  describe('dry-run', () => {
    it('reports affected records and performs no writes', async () => {
      const writes: string[] = [];
      service.register(goodMigration(writes));

      const report = await service.run('add_bond_secondary_index', { dryRun: true });

      expect(report.ok).toBe(true);
      expect(report.dryRunOnly).toBe(true);
      expect(report.phases).toHaveLength(1);
      expect(report.phases[0].phase).toBe('dry-run');
      expect(report.phases[0].affected).toHaveLength(1);
      expect(report.phases[0].affected[0].estimate).toBe(1200);
      expect(writes).toHaveLength(0); // nothing applied
    });

    it('runs the preview before a real apply and records it', async () => {
      const writes: string[] = [];
      service.register(goodMigration(writes));

      const report = await service.run('add_bond_secondary_index', { dryRun: false });

      expect(report.ok).toBe(true);
      const dryRun = report.phases.find((p) => p.phase === 'dry-run');
      expect(dryRun.ok).toBe(true);
      expect(dryRun.affected).toHaveLength(1);
      expect(writes).toEqual(['applied']);
    });
  });

  describe('post-checks', () => {
    it('detects an incomplete migration result', async () => {
      const writes: string[] = [];
      const definition = goodMigration(writes);
      definition.apply = async () => {
        // Simulate a partial rollout: the apply "succeeded" but the index
        // never materialised.
        return {};
      };
      service.register(definition);

      const report = await service.run('add_bond_secondary_index', { dryRun: false });

      expect(report.ok).toBe(false);
      const postChecks = report.phases.find((p) => p.phase === 'post-check');
      expect(postChecks.ok).toBe(false);
      const indexCheck = postChecks.postCheckResults.find((r) => r.name === 'index_exists');
      expect(indexCheck.passed).toBe(false);
      expect(indexCheck.detail).toContain('index missing');
    });

    it('runs every post-check even when an earlier one failed', async () => {
      const writes: string[] = [];
      const definition = goodMigration(writes);
      definition.postChecks = [
        { name: 'first_broken', check: async () => 'intentionally broken' },
        { name: 'second_independent', check: async () => null },
      ];
      service.register(definition);

      const report = await service.run('add_bond_secondary_index', { dryRun: false });

      const postChecks = report.phases.find((p) => p.phase === 'post-check');
      expect(postChecks.postCheckResults).toHaveLength(2);
      expect(postChecks.postCheckResults[0].passed).toBe(false);
      expect(postChecks.postCheckResults[1].passed).toBe(true);
    });

    it('treats a throwing post-check as a failure, not a crash', async () => {
      const writes: string[] = [];
      const definition = goodMigration(writes);
      definition.postChecks = [
        { name: 'throws', check: async () => { throw new Error('boom'); } },
      ];
      service.register(definition);

      const report = await service.run('add_bond_secondary_index', { dryRun: false });

      expect(report.ok).toBe(false);
      const postChecks = report.phases.find((p) => p.phase === 'post-check');
      expect(postChecks.postCheckResults[0].passed).toBe(false);
      expect(postChecks.postCheckResults[0].detail).toContain('boom');
    });
  });

  describe('failed migrations', () => {
    it('stops before post-checks when apply throws and records the rollback path', async () => {
      const writes: string[] = [];
      const definition = goodMigration(writes);
      definition.apply = async () => {
        throw new Error('lock timeout');
      };
      service.register(definition);

      const report = await service.run('add_bond_secondary_index', { dryRun: false });

      expect(report.ok).toBe(false);
      expect(report.error).toContain('lock timeout');
      expect(report.phases.find((p) => p.phase === 'apply').ok).toBe(false);
      expect(report.phases.find((p) => p.phase === 'post-check')).toBeUndefined();
      expect(report.rollbackNotes).toContain('DROP INDEX');
      expect(writes).toHaveLength(0);
    });

    it('refuses a dry-run of an unregistered migration', async () => {
      await expect(service.run('no_such_migration', { dryRun: true })).rejects.toThrow('unknown migration');
    });

    it('rejects a duplicate registration', () => {
      service.register(goodMigration());
      expect(() => service.register(goodMigration())).toThrow('already registered');
    });
  });

  describe('history', () => {
    it('records every run, newest first, including dry-runs', async () => {
      const writes: string[] = [];
      service.register(goodMigration(writes));

      const first = await service.run('add_bond_secondary_index', { dryRun: true });
      const second = await service.run('add_bond_secondary_index', { dryRun: false });

      const history = service.getHistory();
      expect(history).toHaveLength(2);
      // Newest first: the apply run must sort before the dry-run that preceded it.
      expect(history[0].dryRunOnly).toBe(false);
      expect(history[0].startedAt).toBe(second.startedAt);
      expect(history[1].dryRunOnly).toBe(true);
      expect(history[1].startedAt).toBe(first.startedAt);
      expect(history[1].affected[0].target).toBe('bonds');
    });

    it('records a failed run with its error', async () => {
      const writes: string[] = [];
      const definition = goodMigration(writes);
      definition.apply = async () => {
        throw new Error('deadlock detected');
      };
      service.register(definition);

      await service.run('add_bond_secondary_index', { dryRun: false });

      const [record] = service.getHistory();
      expect(record.ok).toBe(false);
      expect(record.error).toContain('deadlock detected');
      expect(record.rollbackNotes).toContain('DROP INDEX');
    });
  });
});
