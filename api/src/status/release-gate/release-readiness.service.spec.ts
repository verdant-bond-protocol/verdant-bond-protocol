import { Test, TestingModule } from '@nestjs/testing';
import { ReleaseReadinessService, SmokeTestProbe } from './release-readiness.service';
import { MigrationSafetyService } from '../../migrations/migration-safety.service';
import { ReleaseGateService } from './release-gate.service';
import { RollbackVerificationService } from '../../recovery/rollback-verification.service';
import { ReleaseGateStatus, SUPPORTED_CONTRACT_SCHEMA_VERSION } from './release-gate.interface';
import { MigrationDefinition } from '../../migrations/migration.interface';

describe('ReleaseReadinessService (#429)', () => {
  let service: ReleaseReadinessService;
  let migrations: MigrationSafetyService;
  let mockReleaseGate: { evaluateReleaseGate: jest.Mock };
  let rollbackVerifier: RollbackVerificationService;

  const passingMigration = (id = 'mig_add_index'): MigrationDefinition => ({
    id,
    description: 'adds a covering index',
    rollback: 'DROP INDEX CONCURRENTLY IF NOT EXISTS idx_test;',
    dryRun: async () => [{ target: 'bonds', estimate: 100, detail: 'creates idx_test' }],
    apply: async () => ({ created: 'idx_test' }),
    postChecks: [{ name: 'index_exists', check: async () => null }],
  });

  const failingMigration = (id = 'mig_broken'): MigrationDefinition => ({
    id,
    description: 'a migration that fails dry-run',
    rollback: 'REVERT broken_column FROM bonds;',
    dryRun: async () => { throw new Error('column type mismatch'); },
    apply: async () => ({}),
  });

  const passingProbe = (name = 'health', scope?: string): SmokeTestProbe => ({
    name,
    scope,
    timeoutMs: 5000,
    run: async () => ({ passed: true, detail: 'OK' }),
  });

  const failingProbe = (name = 'oracle-liveness', scope?: string): SmokeTestProbe => ({
    name,
    scope,
    timeoutMs: 5000,
    run: async () => ({ passed: false, detail: 'Oracle RPC unreachable' }),
  });

  const slowProbe = (name = 'slow-probe', timeoutMs = 50): SmokeTestProbe => ({
    name,
    timeoutMs,
    run: () => new Promise((resolve) => setTimeout(() => resolve({ passed: true }), timeoutMs + 200)),
  });

  const throwingProbe = (name = 'exploding-probe'): SmokeTestProbe => ({
    name,
    timeoutMs: 5000,
    run: async () => { throw new Error('connection reset'); },
  });

  const compatibleGateResult = () => ({
    gateStatus: ReleaseGateStatus.COMPATIBLE,
    overallCompatible: true,
    violations: [],
    rollbackRecommendations: [],
    activeMigrations: [],
    contracts: {},
    storageValidation: { verified: true, fixtureCount: 6, keysChecked: [], mismatches: [] },
    evaluatedAt: new Date().toISOString(),
    schemaVersion: SUPPORTED_CONTRACT_SCHEMA_VERSION,
  });

  beforeEach(async () => {
    mockReleaseGate = {
      evaluateReleaseGate: jest.fn().mockResolvedValue(compatibleGateResult()),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReleaseReadinessService,
        MigrationSafetyService,
        { provide: ReleaseGateService, useValue: mockReleaseGate },
        { provide: RollbackVerificationService, useFactory: () => new RollbackVerificationService() },
      ],
    }).compile();

    service = module.get(ReleaseReadinessService);
    migrations = module.get(MigrationSafetyService);
    rollbackVerifier = module.get(RollbackVerificationService);
  });

  describe('Normal path: all checks pass', () => {
    it('returns READY when migrations, smoke tests, rollback, and gate all pass', async () => {
      migrations.register(passingMigration());
      service.registerSmokeTest(passingProbe());

      const report = await service.evaluate({
        rollbackInput: { targetVersion: 'v1.2.0', bondRecords: [], jobRecords: [] },
      });

      expect(report.status).toBe('READY');
      expect(report.dryRun).toBe(true);
      expect(report.migration.allPassed).toBe(true);
      expect(report.smokeTests).toHaveLength(1);
      expect(report.smokeTests[0].passed).toBe(true);
      expect(report.rollback.isClean).toBe(true);
      expect(report.releaseGateCompatible).toBe(true);
      expect(report.rollbackSteps).toHaveLength(0);
      expect(report.checks.every((c) => c.passed)).toBe(true);
    });

    it('returns READY with zero registered migrations and zero smoke tests', async () => {
      const report = await service.evaluate();

      expect(report.status).toBe('READY');
      expect(report.migration.registeredCount).toBe(0);
      expect(report.smokeTests).toHaveLength(0);
    });
  });

  describe('Migration failure path', () => {
    it('returns BLOCKED when a migration dry-run fails, with rollback notes', async () => {
      migrations.register(passingMigration('mig_good'));
      migrations.register(failingMigration('mig_broken'));

      const report = await service.evaluate();

      expect(report.status).toBe('BLOCKED');
      expect(report.migration.allPassed).toBe(false);
      expect(report.migration.dryRunResults).toHaveLength(2);

      const failed = report.migration.dryRunResults.find((r) => r.migrationId === 'mig_broken');
      expect(failed!.ok).toBe(false);
      expect(failed!.error).toContain('column type mismatch');

      const blockers = report.checks.filter((c) => c.category === 'migration' && !c.passed);
      expect(blockers).toHaveLength(1);
      expect(blockers[0].rollbackSteps).toContain('REVERT broken_column');
      expect(report.rollbackSteps.some((s) => s.includes('mig_broken'))).toBe(true);
    });

    it('runs all migrations even when an earlier one fails (no short-circuit)', async () => {
      migrations.register(failingMigration('mig_fail_first'));
      migrations.register(passingMigration('mig_pass_second'));

      const report = await service.evaluate();

      expect(report.migration.dryRunResults).toHaveLength(2);
      const first = report.migration.dryRunResults.find((r) => r.migrationId === 'mig_fail_first');
      const second = report.migration.dryRunResults.find((r) => r.migrationId === 'mig_pass_second');
      expect(first!.ok).toBe(false);
      expect(second!.ok).toBe(true);
    });
  });

  describe('Smoke test failure path', () => {
    it('returns BLOCKED when a probe reports failure', async () => {
      service.registerSmokeTest(passingProbe('health'));
      service.registerSmokeTest(failingProbe('oracle-liveness'));

      const report = await service.evaluate();

      expect(report.status).toBe('BLOCKED');
      expect(report.smokeTests).toHaveLength(2);
      expect(report.smokeTests.find((t) => t.name === 'oracle-liveness')!.passed).toBe(false);

      const blocker = report.checks.find((c) => c.category === 'smoke-test' && !c.passed);
      expect(blocker).toBeDefined();
      expect(blocker!.detail).toContain('oracle-liveness');
    });

    it('returns BLOCKED when a probe throws an exception', async () => {
      service.registerSmokeTest(throwingProbe('exploding'));

      const report = await service.evaluate();

      expect(report.status).toBe('BLOCKED');
      const result = report.smokeTests.find((t) => t.name === 'exploding');
      expect(result!.passed).toBe(false);
      expect(result!.detail).toContain('connection reset');
      expect(result!.timedOut).toBe(false);
    });

    it('runs all probes even when an earlier one fails (no short-circuit)', async () => {
      service.registerSmokeTest(failingProbe('first'));
      service.registerSmokeTest(passingProbe('second'));
      service.registerSmokeTest(throwingProbe('third'));

      const report = await service.evaluate();

      expect(report.smokeTests).toHaveLength(3);
      expect(report.smokeTests[0].name).toBe('first');
      expect(report.smokeTests[1].name).toBe('second');
      expect(report.smokeTests[2].name).toBe('third');
    });

    it('rejects duplicate smoke test registration', () => {
      service.registerSmokeTest(passingProbe('dup'));
      expect(() => service.registerSmokeTest(passingProbe('dup'))).toThrow('already registered');
    });
  });

  describe('Smoke test timeout', () => {
    it('marks a probe as timed out when it exceeds its deadline', async () => {
      service.registerSmokeTest(slowProbe('slow', 50));

      const report = await service.evaluate();

      expect(report.status).toBe('BLOCKED');
      const result = report.smokeTests.find((t) => t.name === 'slow');
      expect(result!.passed).toBe(false);
      expect(result!.timedOut).toBe(true);
      expect(result!.detail).toContain('Timed out');
    });
  });

  describe('Rollback failure path', () => {
    it('returns BLOCKED when rollback verification reports CRITICAL_MISMATCH', async () => {
      const report = await service.evaluate({
        rollbackInput: {
          targetVersion: 'v1.1.0',
          bondRecords: [{ id: 42, status: 'INVALID_STATE', totalIssued: BigInt(-1), holderCount: 0 }],
        },
      });

      expect(report.status).toBe('BLOCKED');
      expect(report.rollback.status).toBe('CRITICAL_MISMATCH');
      expect(report.rollback.isClean).toBe(false);
      expect(report.rollback.repairCount).toBeGreaterThan(0);

      const blocker = report.checks.find((c) => c.category === 'rollback' && !c.passed);
      expect(blocker).toBeDefined();
      expect(blocker!.rollbackSteps).toContain('Critical state mismatch');
      expect(report.rollbackSteps.some((s) => s.includes('Critical mismatch'))).toBe(true);
    });

    it('passes rollback check but notes repairs when status is PARTIAL_REPAIR_REQUIRED', async () => {
      const report = await service.evaluate({
        rollbackInput: {
          targetVersion: 'v1.1.0',
          jobRecords: [{ id: 'job-99', type: 'coupon-dist', status: 'INTERRUPTED', lastStepId: 'step-3', interruptedMs: 999_999 }],
        },
      });

      expect(report.rollback.status).toBe('PARTIAL_REPAIR_REQUIRED');
      expect(report.rollback.isClean).toBe(false);
      const rollbackCheck = report.checks.find((c) => c.category === 'rollback');
      expect(rollbackCheck!.passed).toBe(true);
    });
  });

  describe('Release gate failure path', () => {
    it('returns BLOCKED when release gate is INCOMPATIBLE', async () => {
      mockReleaseGate.evaluateReleaseGate.mockResolvedValue({
        ...compatibleGateResult(),
        gateStatus: ReleaseGateStatus.INCOMPATIBLE,
        overallCompatible: false,
        violations: ['bond-issuer schema mismatch'],
        rollbackRecommendations: ['Revert bond-issuer wasm'],
      });

      const report = await service.evaluate();

      expect(report.status).toBe('BLOCKED');
      expect(report.releaseGateCompatible).toBe(false);
      const blocker = report.checks.find((c) => c.category === 'release-gate');
      expect(blocker!.passed).toBe(false);
      expect(blocker!.detail).toContain('INCOMPATIBLE');
      expect(report.rollbackSteps.some((s) => s.includes('Revert bond-issuer wasm'))).toBe(true);
    });

    it('handles release gate evaluation throwing an error', async () => {
      mockReleaseGate.evaluateReleaseGate.mockRejectedValue(new Error('RPC timeout'));

      const report = await service.evaluate();

      expect(report.status).toBe('BLOCKED');
      expect(report.releaseGateCompatible).toBe(false);
      const blocker = report.checks.find((c) => c.category === 'release-gate');
      expect(blocker!.passed).toBe(false);
      expect(blocker!.detail).toContain('RPC timeout');
    });
  });

  describe('Retry path: re-evaluation after fixing a blocker', () => {
    it('transitions from BLOCKED to READY after the failing migration is replaced', async () => {
      migrations.register(failingMigration('mig_bad'));

      const first = await service.evaluate();
      expect(first.status).toBe('BLOCKED');

      migrations.clear();
      migrations.register(passingMigration('mig_fixed'));

      const second = await service.evaluate();
      expect(second.status).toBe('READY');
      expect(second.migration.allPassed).toBe(true);
    });
  });

  describe('Scope-based smoke test filtering', () => {
    it('runs only probes matching the requested scope', async () => {
      service.registerSmokeTest(passingProbe('global-health'));
      service.registerSmokeTest(passingProbe('staging-only', 'staging'));
      service.registerSmokeTest(failingProbe('prod-oracle', 'production'));

      const report = await service.evaluate({ scope: 'staging' });

      const names = report.smokeTests.map((t) => t.name);
      expect(names).toContain('global-health');
      expect(names).toContain('staging-only');
      expect(names).not.toContain('prod-oracle');
      expect(report.status).toBe('READY');
    });

    it('includes unscoped probes alongside scope-matched probes', async () => {
      service.registerSmokeTest(passingProbe('unscoped'));
      service.registerSmokeTest(passingProbe('scoped', 'canary'));

      const report = await service.evaluate({ scope: 'canary' });

      expect(report.smokeTests).toHaveLength(2);
    });

    it('runs all probes when no scope is specified', async () => {
      service.registerSmokeTest(passingProbe('a'));
      service.registerSmokeTest(passingProbe('b', 'staging'));
      service.registerSmokeTest(passingProbe('c', 'production'));

      const report = await service.evaluate();

      expect(report.smokeTests).toHaveLength(3);
    });
  });

  describe('Recovery documentation: every BLOCKED result includes rollbackSteps', () => {
    it('aggregates rollback steps from all failing categories', async () => {
      migrations.register(failingMigration('mig_fail'));
      service.registerSmokeTest(failingProbe('bad-probe'));
      mockReleaseGate.evaluateReleaseGate.mockResolvedValue({
        ...compatibleGateResult(),
        gateStatus: ReleaseGateStatus.INCOMPATIBLE,
        overallCompatible: false,
        violations: ['schema mismatch'],
        rollbackRecommendations: ['Revert contract wasm'],
      });

      const report = await service.evaluate({
        rollbackInput: {
          targetVersion: 'v1.0.0',
          bondRecords: [{ id: 1, status: 'INVALID_STATE', totalIssued: BigInt(-1), holderCount: 0 }],
        },
      });

      expect(report.status).toBe('BLOCKED');
      expect(report.rollbackSteps.length).toBeGreaterThanOrEqual(3);
      expect(report.rollbackSteps.some((s) => s.includes('migration'))).toBe(true);
      expect(report.rollbackSteps.some((s) => s.includes('smoke-test'))).toBe(true);
      expect(report.rollbackSteps.some((s) => s.includes('release-gate'))).toBe(true);

      const blockedChecks = report.checks.filter((c) => !c.passed);
      for (const check of blockedChecks) {
        expect(check.rollbackSteps).toBeDefined();
        expect(check.rollbackSteps!.length).toBeGreaterThan(0);
      }
    });
  });
});
