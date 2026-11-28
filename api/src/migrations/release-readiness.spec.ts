import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { MigrationSafetyController } from './migration-safety.controller';
import { MigrationSafetyService } from './migration-safety.service';
import { MigrationDefinition, MigrationRecord } from './migration.interface';
import {
  DEFAULT_MAX_DRY_RUN_AGE_MS,
  evaluateMigrationReleaseReadiness,
  isRollbackDocumented,
} from './release-readiness';

const NOW = new Date('2026-11-18T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function at(offsetMs: number): string {
  return new Date(NOW.getTime() + offsetMs).toISOString();
}

function record(migrationId: string, overrides: Partial<MigrationRecord>): MigrationRecord {
  return {
    migrationId,
    startedAt: at(-HOUR),
    ok: true,
    dryRunOnly: true,
    affected: [],
    postCheckResults: [],
    rollbackNotes: 'DROP INDEX CONCURRENTLY idx_bonds_secondary;',
    ...overrides,
  };
}

const definition = (id: string, overrides: Partial<MigrationDefinition> = {}) => ({
  id,
  rollback: `revert ${id} by dropping the new column`,
  postChecks: [{ name: 'shape', check: async () => null }],
  ...overrides,
});

function checkOf(report: ReturnType<typeof evaluateMigrationReleaseReadiness>, id: string, name: string) {
  return report.migrations.find((m) => m.migrationId === id)?.checks.find((c) => c.name === name);
}

describe('migration release readiness (#514)', () => {
  describe('isRollbackDocumented', () => {
    it.each(['', '   ', 'TODO', 'tbd', 'N/A', 'none', '...', 'TODO: write the down migration'])(
      'rejects placeholder %p',
      (note) => expect(isRollbackDocumented(note)).toBe(false),
    );

    it('accepts a concrete undo or forward-fix note', () => {
      expect(isRollbackDocumented('DROP INDEX CONCURRENTLY idx_bonds_secondary;')).toBe(true);
      expect(isRollbackDocumented('irreversible: forward-fix by re-running backfill v2')).toBe(true);
    });
  });

  describe('normal path', () => {
    it('is READY when every migration is documented, checked, and freshly dry-run', () => {
      const report = evaluateMigrationReleaseReadiness({
        releaseMigrationIds: ['m1', 'm2'],
        definitions: [definition('m1'), definition('m2')],
        history: [record('m1', {}), record('m2', {})],
        now: NOW,
      });

      expect(report.status).toBe('READY');
      expect(report.blockers).toEqual([]);
      expect(report.evaluatedAt).toBe(NOW.toISOString());
      expect(report.migrations.every((m) => m.ready)).toBe(true);
    });

    it('emits the rollback plan in reverse apply order', () => {
      const report = evaluateMigrationReleaseReadiness({
        releaseMigrationIds: ['m1', 'm2', 'm3'],
        definitions: [definition('m1'), definition('m2'), definition('m3')],
        history: [record('m1', {}), record('m2', {}), record('m3', {})],
        now: NOW,
      });

      expect(report.rollbackPlan.map((step) => [step.order, step.migrationId])).toEqual([
        [1, 'm3'],
        [2, 'm2'],
        [3, 'm1'],
      ]);
      expect(report.rollbackPlan[0].rollback).toContain('m3');
    });

    it('evaluates a duplicated release id once', () => {
      const report = evaluateMigrationReleaseReadiness({
        releaseMigrationIds: ['m1', 'm1'],
        definitions: [definition('m1')],
        history: [record('m1', {})],
        now: NOW,
      });

      expect(report.migrations).toHaveLength(1);
      expect(report.rollbackPlan).toHaveLength(1);
    });
  });

  describe('failure paths', () => {
    it('blocks an unregistered migration and leaves it out of the rollback plan', () => {
      const report = evaluateMigrationReleaseReadiness({
        releaseMigrationIds: ['ghost'],
        definitions: [],
        history: [],
        now: NOW,
      });

      expect(report.status).toBe('BLOCKED');
      expect(report.blockers).toEqual(['ghost']);
      expect(checkOf(report, 'ghost', 'registered')?.passed).toBe(false);
      expect(report.rollbackPlan).toEqual([]);
    });

    it('blocks placeholder rollback notes and missing post-checks', () => {
      const report = evaluateMigrationReleaseReadiness({
        releaseMigrationIds: ['m1'],
        definitions: [definition('m1', { rollback: 'TODO', postChecks: [] })],
        history: [record('m1', {})],
        now: NOW,
      });

      expect(report.status).toBe('BLOCKED');
      expect(checkOf(report, 'm1', 'rollback-documented')?.passed).toBe(false);
      expect(checkOf(report, 'm1', 'post-checks-defined')?.passed).toBe(false);
    });

    it('blocks when no dry-run was ever recorded', () => {
      const report = evaluateMigrationReleaseReadiness({
        releaseMigrationIds: ['m1'],
        definitions: [definition('m1')],
        history: [],
        now: NOW,
      });

      expect(checkOf(report, 'm1', 'dry-run-passed')).toMatchObject({ passed: false, detail: 'no dry-run recorded' });
    });

    it('lets a later failing dry-run supersede an earlier passing one', () => {
      const report = evaluateMigrationReleaseReadiness({
        releaseMigrationIds: ['m1'],
        definitions: [definition('m1')],
        history: [
          record('m1', { startedAt: at(-2 * HOUR), ok: true }),
          record('m1', { startedAt: at(-HOUR), ok: false, error: 'table bonds missing' }),
        ],
        now: NOW,
      });

      expect(checkOf(report, 'm1', 'dry-run-passed')?.detail).toContain('table bonds missing');
    });

    it('blocks a stale dry-run, honouring a custom freshness window', () => {
      const history = [record('m1', { startedAt: at(-DEFAULT_MAX_DRY_RUN_AGE_MS - 1) })];
      const input = { releaseMigrationIds: ['m1'], definitions: [definition('m1')], history, now: NOW };

      expect(checkOf(evaluateMigrationReleaseReadiness(input), 'm1', 'dry-run-fresh')?.passed).toBe(false);
      expect(
        checkOf(evaluateMigrationReleaseReadiness({ ...input, maxDryRunAgeMs: 48 * HOUR }), 'm1', 'dry-run-fresh')?.passed,
      ).toBe(true);
    });

    it('blocks on an unresolved failed apply and surfaces the recorded recovery path', () => {
      const report = evaluateMigrationReleaseReadiness({
        releaseMigrationIds: ['m1'],
        definitions: [definition('m1')],
        history: [
          record('m1', {}),
          record('m1', { dryRunOnly: false, ok: false, startedAt: at(-30 * 60 * 1000), error: 'post-check failures' }),
        ],
        now: NOW,
      });

      const check = checkOf(report, 'm1', 'no-unresolved-failure');
      expect(report.status).toBe('BLOCKED');
      expect(check?.passed).toBe(false);
      expect(check?.detail).toContain('post-check failures');
      expect(check?.detail).toContain('DROP INDEX CONCURRENTLY');
    });
  });

  describe('retry path', () => {
    it('clears a failed apply once a later apply succeeds and counts the recovery', () => {
      const report = evaluateMigrationReleaseReadiness({
        releaseMigrationIds: ['m1'],
        definitions: [definition('m1')],
        history: [
          record('m1', { startedAt: at(-3 * HOUR), dryRunOnly: false, ok: false, error: 'lock timeout' }),
          record('m1', { startedAt: at(-2 * HOUR), dryRunOnly: false, ok: false, error: 'lock timeout' }),
          record('m1', { startedAt: at(-HOUR), dryRunOnly: false, ok: true }),
          record('m1', { startedAt: at(-HOUR) }),
        ],
        now: NOW,
      });

      expect(report.status).toBe('READY');
      expect(report.migrations[0].recoveredFailures).toBe(2);
    });

    it('end to end: a flaky apply blocks the release, a retry unblocks it', async () => {
      const service = new MigrationSafetyService();
      let attempts = 0;
      service.register({
        id: 'add_coupon_index',
        description: 'index coupons by bond',
        rollback: 'DROP INDEX CONCURRENTLY idx_coupons_bond;',
        dryRun: async () => [{ target: 'coupons', estimate: 10, detail: 'create index' }],
        apply: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('lock timeout');
          return {};
        },
        postChecks: [{ name: 'index_exists', check: async () => null }],
      });

      await service.run('add_coupon_index', { dryRun: true });
      await service.run('add_coupon_index', { dryRun: false });
      const blocked = service.evaluateReleaseReadiness();
      expect(blocked.status).toBe('BLOCKED');
      expect(blocked.blockers).toEqual(['add_coupon_index']);

      // Retries get distinct timestamps from the first attempt.
      await new Promise((resolve) => setTimeout(resolve, 5));
      await service.run('add_coupon_index', { dryRun: false });
      const ready = service.evaluateReleaseReadiness();
      expect(ready.status).toBe('READY');
      expect(ready.migrations[0].recoveredFailures).toBe(1);
      expect(ready.rollbackPlan).toEqual([
        { order: 1, migrationId: 'add_coupon_index', rollback: 'DROP INDEX CONCURRENTLY idx_coupons_bond;' },
      ]);
    });
  });

  describe('authorization and endpoint contract', () => {
    it('serves readiness from the admin-only migrations controller', () => {
      const guards = Reflect.getMetadata(GUARDS_METADATA, MigrationSafetyController);

      expect(guards).toEqual([JwtAuthGuard, AdminGuard]);
    });

    it('parses ids and the freshness override, and rejects bad overrides', async () => {
      const service = new MigrationSafetyService();
      const spy = jest.spyOn(service, 'evaluateReleaseReadiness');
      const controller = new MigrationSafetyController(service);

      await controller.releaseReadiness(' m1, m2 ,,', '90');
      expect(spy).toHaveBeenLastCalledWith(['m1', 'm2'], { maxDryRunAgeMs: 90 * 60 * 1000 });

      await controller.releaseReadiness(undefined, undefined);
      expect(spy).toHaveBeenLastCalledWith(undefined, { maxDryRunAgeMs: undefined });

      await expect(controller.releaseReadiness(undefined, '-5')).rejects.toThrow(BadRequestException);
      await expect(controller.releaseReadiness(undefined, 'soon')).rejects.toThrow(BadRequestException);
    });

    it('is read-only: evaluating readiness records no history', () => {
      const service = new MigrationSafetyService();
      service.register({ ...definition('m1'), description: 'x', dryRun: async () => [], apply: async () => ({}) });

      service.evaluateReleaseReadiness();

      expect(service.getHistory()).toEqual([]);
    });
  });
});
