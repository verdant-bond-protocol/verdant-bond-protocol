import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataRetentionService, DataType, RETENTION_DAYS } from './data-retention.service';
import { OracleIncidentRepository } from '../oracle/oracle-incident.repository';
import { OracleIncidentStatus } from '../oracle/interfaces/oracle-incident.interface';
import { RECORDS_FILE } from '../common/services/kyc-store.service';

const DAY = 24 * 60 * 60 * 1000;

/**
 * Retention and deletion of sensitive operational data (#411), against a
 * real temporary directory: files are created with controlled mtimes and the
 * job's real `unlink` decides what survives.
 */
describe('DataRetentionService lifecycle (#411)', () => {
  let dataDir: string;
  let incidents: { findMany: jest.Mock };
  let service: DataRetentionService;

  async function file(type: string, name: string, ageDays: number): Promise<string> {
    const target = path.join(dataDir, type, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, 'sensitive');
    const mtime = new Date(Date.now() - ageDays * DAY);
    await fs.utimes(target, mtime, mtime);
    return target;
  }

  const exists = (target: string) => fs.access(target).then(() => true, () => false);
  const page = (data: Array<{ id: string; subjectId: string }>, nextCursor?: string) => ({ data, meta: { nextCursor } });

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'retention-'));
    process.env.DATA_DIR = dataDir;
    incidents = { findMany: jest.fn().mockResolvedValue(page([])) };
    service = new DataRetentionService(incidents as unknown as OracleIncidentRepository);
    jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    delete process.env.DATA_DIR;
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  describe('normal path', () => {
    it.each(Object.values(DataType))('deletes %s records past retention and keeps those within it', async (type) => {
      const limit = RETENTION_DAYS[type];
      const expired = await file(type, 'expired.jsonl', limit + 1);
      const atLimit = await file(type, 'at-limit.jsonl', limit - 0.01);

      const report = await service.runCleanupJob();

      expect(await exists(expired)).toBe(false);
      expect(await exists(atLimit)).toBe(true);
      expect(report[type]).toEqual({ deleted: 1, held: 0, errors: 0 });
    });

    it('never expires the live KYC record store, however old its mtime', async () => {
      const store = await file(DataType.AUDIT, RECORDS_FILE, RETENTION_DAYS[DataType.AUDIT] + 365);
      const oldAuditLog = await file(DataType.AUDIT, 'kyc-audit.log.jsonl', RETENTION_DAYS[DataType.AUDIT] + 1);

      const report = await service.runCleanupJob();

      expect(await exists(store)).toBe(true);
      expect(await exists(oldAuditLog)).toBe(false);
      expect(report[DataType.AUDIT]).toEqual({ deleted: 1, held: 1, errors: 0 });
    });
  });

  describe('authorization boundary: what the job may delete', () => {
    it('touches only the four classified directories, never other data or subdirectories', async () => {
      const unclassified = await file('backups', 'db.dump', 10_000);
      const nested = await file(path.join(DataType.TELEMETRY, 'archive'), 'old.jsonl', 10_000);
      const outside = path.join(os.tmpdir(), `retention-outside-${process.pid}.txt`);
      await fs.writeFile(outside, 'x');

      await service.runCleanupJob();

      expect(await exists(unclassified)).toBe(true);
      expect(await exists(nested)).toBe(true);
      expect(await exists(outside)).toBe(true);
      await fs.rm(outside, { force: true });
    });

    it('holds expired evidence linked to any unresolved incident, across every page of incidents', async () => {
      const onPage2 = await file(DataType.EVIDENCE, 'report-incident-on-page-2.pdf', 2_000);
      const subjectHeld = await file(DataType.EVIDENCE, 'satellite-subject-77.png', 2_000);
      const free = await file(DataType.EVIDENCE, 'closed-case.pdf', 2_000);
      incidents.findMany.mockImplementation(async (_page: number, _limit: number, status: OracleIncidentStatus, cursor?: string) => {
        if (status === OracleIncidentStatus.Active) {
          return cursor
            ? page([{ id: 'incident-on-page-2', subjectId: 'project-on-page-2' }])
            : page([{ id: 'incident-on-page-1', subjectId: 'project-on-page-1' }], 'cursor-1');
        }
        return page([{ id: 'ack-1', subjectId: 'subject-77' }]);
      });

      const report = await service.runCleanupJob();

      expect(await exists(onPage2)).toBe(true);
      expect(await exists(subjectHeld)).toBe(true);
      expect(await exists(free)).toBe(false);
      expect(report[DataType.EVIDENCE]).toEqual({ deleted: 1, held: 2, errors: 0 });
    });
  });

  describe('failure path', () => {
    it('fails closed: holds all expired evidence when incidents cannot be read, but still cleans other types', async () => {
      const evidence = await file(DataType.EVIDENCE, 'anything.pdf', 2_000);
      const telemetry = await file(DataType.TELEMETRY, 'old.jsonl', 31);
      incidents.findMany.mockRejectedValue(new Error('connect ECONNREFUSED'));
      jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

      const report = await service.runCleanupJob();

      expect(await exists(evidence)).toBe(true);
      expect(await exists(telemetry)).toBe(false);
      expect(report[DataType.EVIDENCE].held).toBe(1);
      expect(incidents.findMany).toHaveBeenCalledTimes(1); // loaded once per run, not per file
    });

    it('reports a file it cannot delete and carries on with the rest', async () => {
      const locked = await file(DataType.EXPORT, 'locked.csv', 8);
      const other = await file(DataType.EXPORT, 'other.csv', 8);
      const unlink = fs.unlink;
      jest.spyOn((service as any).fileFs, 'unlink').mockImplementation(async (target: any) => {
        if (String(target).endsWith('locked.csv')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        return unlink(target);
      });
      jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);

      const report = await service.runCleanupJob();

      expect(await exists(locked)).toBe(true);
      expect(await exists(other)).toBe(false);
      expect(report[DataType.EXPORT]).toEqual({ deleted: 1, held: 0, errors: 1 });
    });

    it('does nothing when DATA_DIR has no classified directories', async () => {
      const report = await service.runCleanupJob();
      expect(Object.values(report).every((r) => r.deleted === 0 && r.errors === 0)).toBe(true);
    });
  });

  describe('retry path', () => {
    it('is idempotent: a second run deletes nothing more', async () => {
      await file(DataType.TELEMETRY, 'old.jsonl', 31);

      expect((await service.runCleanupJob())[DataType.TELEMETRY].deleted).toBe(1);
      expect((await service.runCleanupJob())[DataType.TELEMETRY]).toEqual({ deleted: 0, held: 0, errors: 0 });
    });

    it('treats a file removed by a concurrent run as done, not as an error', async () => {
      await file(DataType.TELEMETRY, 'old.jsonl', 31);

      const [first, second] = await Promise.all([service.runCleanupJob(), service.runCleanupJob()]);

      expect(first[DataType.TELEMETRY].deleted + second[DataType.TELEMETRY].deleted).toBe(1);
      expect(first[DataType.TELEMETRY].errors + second[DataType.TELEMETRY].errors).toBe(0);
    });

    it('releases evidence once its incident is resolved', async () => {
      const evidence = await file(DataType.EVIDENCE, 'report-inc-9.pdf', 2_000);
      incidents.findMany.mockResolvedValueOnce(page([{ id: 'inc-9', subjectId: 's' }]));
      await service.runCleanupJob();
      expect(await exists(evidence)).toBe(true);

      incidents.findMany.mockResolvedValue(page([]));
      await service.runCleanupJob();
      expect(await exists(evidence)).toBe(false);
    });
  });
});
