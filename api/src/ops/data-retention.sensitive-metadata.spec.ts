import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DataRetentionService,
  DataType,
  RETENTION_DAYS,
  RetentionPlan,
} from './data-retention.service';
import { OracleIncidentRepository } from '../oracle/oracle-incident.repository';
import { OracleIncidentStatus } from '../oracle/interfaces/oracle-incident.interface';
import { RECORDS_FILE } from '../common/services/kyc-store.service';

const DAY = 24 * 60 * 60 * 1000;

/**
 * Retention enforcement for sensitive metadata (#411).
 *
 * Uses real temporary directories and the real `unlink`, mirroring the two
 * invariants that matter: the read-only preview must predict enforcement
 * exactly, and protected sensitive records must survive every run.
 */
describe('Data retention enforcement for sensitive metadata', () => {
  let dataDir: string;
  let incidents: { findMany: jest.Mock };
  let service: DataRetentionService;

  async function file(type: string, name: string, ageDays: number): Promise<string> {
    const target = path.join(dataDir, type, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, 'sensitive metadata');
    const mtime = new Date(Date.now() - ageDays * DAY);
    await fs.utimes(target, mtime, mtime);
    return target;
  }

  const exists = (target: string) => fs.access(target).then(() => true, () => false);
  const page = (data: Array<{ id: string; subjectId: string }>, nextCursor?: string) => ({
    data,
    meta: { nextCursor },
  });
  const actions = (plan: RetentionPlan): Record<string, string> =>
    Object.fromEntries(plan.entries.map((e) => [e.file, e.action]));

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'retention-sensitive-'));
    process.env.DATA_DIR = dataDir;
    incidents = { findMany: jest.fn().mockResolvedValue(page([])) };
    service = new DataRetentionService(incidents as unknown as OracleIncidentRepository);
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn((service as any).logger, level).mockImplementation(() => undefined);
    }
  });

  afterEach(async () => {
    delete process.env.DATA_DIR;
    jest.restoreAllMocks();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  describe('normal path', () => {
    it('predicts enforcement exactly without deleting anything', async () => {
      const expiredAudit = await file(DataType.AUDIT, 'kyc-audit.log.jsonl', RETENTION_DAYS[DataType.AUDIT] + 1);
      const expiredTelemetry = await file(DataType.TELEMETRY, 'trace.jsonl', RETENTION_DAYS[DataType.TELEMETRY] + 1);
      const withinLimit = await file(DataType.EXPORT, 'recent.csv', RETENTION_DAYS[DataType.EXPORT] - 1);
      const liveStore = await file(DataType.AUDIT, RECORDS_FILE, RETENTION_DAYS[DataType.AUDIT] + 100);
      const heldEvidence = await file(DataType.EVIDENCE, 'case-inc-42.pdf', 2_000);
      incidents.findMany.mockResolvedValue(page([{ id: 'inc-42', subjectId: 'GABC...WALLET' }]));

      const preview = await service.previewCleanup();

      expect(actions(preview)).toEqual({
        'kyc-audit.log.jsonl': 'delete',
        'trace.jsonl': 'delete',
        [RECORDS_FILE]: 'never-expire',
        'case-inc-42.pdf': 'evidence-hold',
      });
      expect(preview.entries.map((e) => [e.type, e.file])).toEqual(
        [...preview.entries.map((e) => [e.type, e.file])].sort(),
      );
      expect(preview.entries.every((e) => typeof e.ageDays === 'number' && e.ageDays > 0)).toBe(true);
      // Preview is strictly read-only.
      for (const target of [expiredAudit, expiredTelemetry, withinLimit, liveStore, heldEvidence]) {
        expect(await exists(target)).toBe(true);
      }
      expect(await service.previewCleanup()).toEqual(preview);

      const report = await service.runCleanupJob();

      expect(await exists(expiredAudit)).toBe(false);
      expect(await exists(expiredTelemetry)).toBe(false);
      expect(await exists(withinLimit)).toBe(true);
      expect(await exists(liveStore)).toBe(true);
      expect(await exists(heldEvidence)).toBe(true);
      expect(report[DataType.AUDIT]).toEqual({ deleted: 1, held: 1, errors: 0 });
      expect(report[DataType.TELEMETRY]).toEqual({ deleted: 1, held: 0, errors: 0 });
      expect(report[DataType.EVIDENCE]).toEqual({ deleted: 0, held: 1, errors: 0 });
    });
  });

  describe('authorization boundary: what enforcement may delete', () => {
    it('protects the live KYC store and evidence held by a wallet-address subject', async () => {
      const liveStore = await file(DataType.AUDIT, RECORDS_FILE, 10_000);
      const subjectHeld = await file(DataType.EVIDENCE, 'evidence-GWIOLD...PDF', 2_000);
      const unclassified = await file('backups', 'db.dump', 10_000);
      const nested = await file(path.join(DataType.TELEMETRY, 'archive'), 'old.jsonl', 10_000);
      incidents.findMany.mockResolvedValue(page([{ id: '', subjectId: 'GWIOLD...' }]));

      const preview = await service.previewCleanup();
      await service.runCleanupJob();

      expect(await exists(liveStore)).toBe(true);
      expect(await exists(subjectHeld)).toBe(true);
      expect(await exists(unclassified)).toBe(true);
      expect(await exists(nested)).toBe(true);
      expect(actions(preview)).toEqual({ 'evidence-GWIOLD...PDF': 'evidence-hold', [RECORDS_FILE]: 'never-expire' });
    });

    it('holds all sensitive evidence when the incident store is unavailable (fail closed)', async () => {
      const evidence = await file(DataType.EVIDENCE, 'unrelated.pdf', 2_000);
      const audit = await file(DataType.AUDIT, 'kyc-audit.log.jsonl', 10_000);
      incidents.findMany.mockRejectedValue(new Error('ECONNREFUSED'));

      const preview = await service.previewCleanup();
      const report = await service.runCleanupJob();

      expect(actions(preview)['unrelated.pdf']).toBe('evidence-hold');
      expect(await exists(evidence)).toBe(true);
      expect(await exists(audit)).toBe(false); // other types are still enforced
      expect(report[DataType.EVIDENCE].held).toBe(1);
      expect(report[DataType.AUDIT].deleted).toBe(1);
      expect(incidents.findMany).toHaveBeenCalledTimes(2); // once per run, not per file
    });
  });

  describe('failure path', () => {
    it('reports an undeletable sensitive file, leaves it in place, and carries on', async () => {
      const locked = await file(DataType.AUDIT, 'kyc-audit.log.jsonl', 10_000);
      const other = await file(DataType.EXPORT, 'export.csv', 10);
      const realUnlink = fs.unlink;
      jest.spyOn((service as any).fileFs, 'unlink').mockImplementation(async (target: any) => {
        if (String(target).endsWith('kyc-audit.log.jsonl')) {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        }
        return realUnlink(target);
      });

      const report = await service.runCleanupJob();

      expect(await exists(locked)).toBe(true);
      expect(await exists(other)).toBe(false);
      expect(report[DataType.AUDIT]).toEqual({ deleted: 0, held: 0, errors: 1 });
      expect(report[DataType.EXPORT]).toEqual({ deleted: 1, held: 0, errors: 0 });
    });

    it('skips entries whose stat fails instead of failing the whole sweep', async () => {
      await file(DataType.TELEMETRY, 'vanished.jsonl', 100);
      const realStat = fs.stat;
      jest.spyOn((service as any).fileFs, 'stat').mockImplementation(async (target: any) => {
        if (String(target).endsWith('vanished.jsonl')) throw Object.assign(new Error('EIO'), { code: 'EIO' });
        return realStat(target);
      });

      const preview = await service.previewCleanup();
      const report = await service.runCleanupJob();

      expect(preview.entries).toEqual([]);
      expect(report[DataType.TELEMETRY]).toEqual({ deleted: 0, held: 0, errors: 1 });
    });
  });

  describe('retry path', () => {
    it('succeeds on a second run after a transient unlink error', async () => {
      const target = await file(DataType.AUDIT, 'kyc-audit.log.jsonl', 10_000);
      const realUnlink = fs.unlink;
      const unlink = jest.spyOn((service as any).fileFs, 'unlink').mockImplementationOnce(async () => {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      }).mockImplementation(async (t: any) => realUnlink(t));

      expect((await service.runCleanupJob())[DataType.AUDIT].errors).toBe(1);
      expect(await exists(target)).toBe(true);

      // Recovery: the next scheduled sweep retries without reconfiguration.
      expect((await service.runCleanupJob())[DataType.AUDIT]).toEqual({ deleted: 1, held: 0, errors: 0 });
      expect(await exists(target)).toBe(false);
      expect(unlink).toHaveBeenCalledTimes(2);
    });

    it('is idempotent and releases an evidence hold once the incident is resolved', async () => {
      const evidence = await file(DataType.EVIDENCE, 'case-inc-7.pdf', 2_000);
      incidents.findMany.mockResolvedValue(page([{ id: 'inc-7', subjectId: 's' }]));

      expect((await service.runCleanupJob())[DataType.EVIDENCE].held).toBe(1);
      expect(await exists(evidence)).toBe(true);
      expect((await service.runCleanupJob())[DataType.EVIDENCE]).toEqual({ deleted: 0, held: 1, errors: 0 });

      incidents.findMany.mockResolvedValue(page([]));
      expect((await service.runCleanupJob())[DataType.EVIDENCE].deleted).toBe(1);
      expect(await exists(evidence)).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('keeps a file exactly at the retention limit (strictly-greater rule)', async () => {
      const atLimit = await file(DataType.TELEMETRY, 'boundary.jsonl', RETENTION_DAYS[DataType.TELEMETRY] - 0.01);
      const plan = await service.previewCleanup();
      await service.runCleanupJob();
      expect(actions(plan)).toEqual({});
      expect(await exists(atLimit)).toBe(true);
    });

    it('ignores blank hold keys so an empty incident id cannot hold every file', async () => {
      const evidence = await file(DataType.EVIDENCE, 'case-1.pdf', 2_000);
      incidents.findMany.mockResolvedValue(page([{ id: '', subjectId: '' }]));

      await service.runCleanupJob();

      expect(await exists(evidence)).toBe(false);
    });

    it('documents the substring-match behavior of evidence holds', async () => {
      // Hold matching is intentionally a substring test on filenames; a name
      // that happens to contain an incident id is held even if unrelated.
      const coincidental = await file(DataType.EVIDENCE, 'inc-99-summary.pdf', 2_000);
      incidents.findMany.mockResolvedValue(page([{ id: 'inc-99', subjectId: 's' }]));

      const plan = await service.previewCleanup();
      await service.runCleanupJob();

      expect(actions(plan)['inc-99-summary.pdf']).toBe('evidence-hold');
      expect(await exists(coincidental)).toBe(true);
    });
  });
});
