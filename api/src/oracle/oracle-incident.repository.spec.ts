import { randomUUID } from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { spawn, ChildProcessByStdio } from 'child_process';
import * as path from 'path';
import { Readable } from 'stream';
import { OracleIncidentRepository } from './oracle-incident.repository';
import {
  OracleIncidentSeverity,
  OracleIncidentStatus,
  OracleIncidentSubjectType,
} from './interfaces/oracle-incident.interface';

/**
 * Integration test for OracleIncidentRepository (issue #95), run against a
 * real, ephemeral PostgreSQL server -- not a mock or a SQL emulator. This
 * matters because the dedup/recurrence guarantee relies on a real
 * PostgreSQL-specific feature (a partial unique index combined with
 * `INSERT ... ON CONFLICT (col) WHERE <predicate> DO UPDATE`); a
 * lighter-weight in-memory SQL engine (`pg-mem` was evaluated and does not
 * parse this exact clause) would not actually verify that this works. The
 * CI workflow (`.github/workflows/ci.yml`) does not provision a Postgres
 * service for the `api` job, so this test brings its own real, disposable
 * database instead of depending on one being externally available.
 *
 * The database itself is started by `test-setup/embedded-postgres-server.mjs`
 * in a genuinely separate `node` child process, not loaded in-process. The
 * `embedded-postgres` npm package ships as pure ESM with no CommonJS build,
 * and this project's Jest is configured for CommonJS/ts-jest (matching every
 * other test file); Jest's sandboxed module loader cannot execute a real ESM
 * package even via a dynamic `import()` from inside a test file. Running it
 * as a plain `node file.mjs` subprocess sidesteps that entirely -- Jest is
 * not involved in loading it at all.
 */

const PORT = 57432;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let repository: OracleIncidentRepository;

jest.setTimeout(60_000);

function startEmbeddedPostgres(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(__dirname, '..', '..', 'test-setup', 'embedded-postgres-server.mjs'), String(PORT)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    serverProcess = child;

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('exit', (code) => {
      if (code !== null && code !== 0) {
        reject(new Error(`embedded-postgres-server exited early (code ${code}): ${stderr}`));
      }
    });

    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/PGREADY:(\S+)/);
      if (match) resolve(match[1]);
    });
  });
}

function stopEmbeddedPostgres(): Promise<void> {
  return new Promise((resolve) => {
    if (!serverProcess || serverProcess.exitCode !== null) {
      resolve();
      return;
    }
    serverProcess.once('exit', () => resolve());
    serverProcess.kill('SIGTERM');
  });
}

beforeAll(async () => {
  process.env.DATABASE_URL = await startEmbeddedPostgres();
  process.env.ORACLE_INCIDENT_ESCALATION_THRESHOLDS = '3:critical';

  repository = new OracleIncidentRepository();
  await repository.onModuleInit();
});

afterAll(async () => {
  await repository.onModuleDestroy();
  await stopEmbeddedPostgres();
});

function detection(overrides: Partial<{ subjectType: OracleIncidentSubjectType; subjectId: string; detectedAt: string }> = {}) {
  return {
    subjectType: overrides.subjectType ?? OracleIncidentSubjectType.Project,
    subjectId: overrides.subjectId ?? randomUUID(),
    detectedAt: overrides.detectedAt ?? '2026-01-01T00:00:00.000Z',
    details: { lastVerifiedAt: '2025-12-01T00:00:00.000Z', stalenessSeconds: 2_592_000 },
  };
}

describe('OracleIncidentRepository', () => {
  describe('creation', () => {
    it('creates a new active incident on first detection', async () => {
      const input = detection();
      const result = await repository.recordDetection(input);

      expect(result.isNew).toBe(true);
      expect(result.escalated).toBe(false);
      expect(result.incident.status).toBe(OracleIncidentStatus.Active);
      expect(result.incident.severity).toBe(OracleIncidentSeverity.Warning);
      expect(result.incident.occurrenceCount).toBe(1);
      expect(result.incident.subjectId).toBe(input.subjectId);
      expect(result.incident.dedupeKey).toBe(`project:${input.subjectId}`);
    });

    it('keys projects and providers separately even with the same subject id', async () => {
      const subjectId = randomUUID();
      const project = await repository.recordDetection(
        detection({ subjectType: OracleIncidentSubjectType.Project, subjectId }),
      );
      const provider = await repository.recordDetection(
        detection({ subjectType: OracleIncidentSubjectType.Provider, subjectId }),
      );

      expect(project.isNew).toBe(true);
      expect(provider.isNew).toBe(true);
      expect(project.incident.id).not.toBe(provider.incident.id);
    });
  });

  describe('dedupe', () => {
    it('updates the existing incident instead of creating a new row on a repeated cron cycle', async () => {
      const subjectId = randomUUID();
      const first = await repository.recordDetection(detection({ subjectId, detectedAt: '2026-01-01T00:00:00.000Z' }));
      const second = await repository.recordDetection(detection({ subjectId, detectedAt: '2026-01-02T00:00:00.000Z' }));

      expect(second.isNew).toBe(false);
      expect(second.incident.id).toBe(first.incident.id);
      expect(second.incident.occurrenceCount).toBe(2);
      expect(second.incident.lastDetectedAt).toBe('2026-01-02T00:00:00.000Z');

      const listed = await repository.findMany(1, 20, undefined);
      const matching = listed.data.filter((incident) => incident.dedupeKey === first.incident.dedupeKey);
      expect(matching).toHaveLength(1);
    });

    it('is safe under concurrent detections for the same subject (no duplicate active rows)', async () => {
      const subjectId = randomUUID();
      const [a, b, c] = await Promise.all([
        repository.recordDetection(detection({ subjectId, detectedAt: '2026-02-01T00:00:00.000Z' })),
        repository.recordDetection(detection({ subjectId, detectedAt: '2026-02-01T00:00:01.000Z' })),
        repository.recordDetection(detection({ subjectId, detectedAt: '2026-02-01T00:00:02.000Z' })),
      ]);

      const ids = new Set([a.incident.id, b.incident.id, c.incident.id]);
      expect(ids.size).toBe(1);
      const finalCount = Math.max(a.incident.occurrenceCount, b.incident.occurrenceCount, c.incident.occurrenceCount);
      expect(finalCount).toBe(3);
    });
  });

  describe('escalation', () => {
    it('escalates severity once occurrence count reaches the configured threshold', async () => {
      const subjectId = randomUUID();
      const first = await repository.recordDetection(detection({ subjectId }));
      expect(first.incident.severity).toBe(OracleIncidentSeverity.Warning);

      const second = await repository.recordDetection(detection({ subjectId }));
      expect(second.escalated).toBe(false);
      expect(second.incident.severity).toBe(OracleIncidentSeverity.Warning);

      // ORACLE_INCIDENT_ESCALATION_THRESHOLDS='3:critical' set in beforeAll.
      const third = await repository.recordDetection(detection({ subjectId }));
      expect(third.escalated).toBe(true);
      expect(third.incident.severity).toBe(OracleIncidentSeverity.Critical);
      expect(third.incident.occurrenceCount).toBe(3);

      // Does not re-fire "escalated" once already at the target severity.
      const fourth = await repository.recordDetection(detection({ subjectId }));
      expect(fourth.escalated).toBe(false);
      expect(fourth.incident.severity).toBe(OracleIncidentSeverity.Critical);
    });
  });

  describe('acknowledgement', () => {
    it('acknowledges an active incident', async () => {
      const { incident } = await repository.recordDetection(detection());
      const acknowledged = await repository.acknowledge(incident.id, 'GADMIN...OPERATOR');

      expect(acknowledged.status).toBe(OracleIncidentStatus.Acknowledged);
      expect(acknowledged.acknowledgedBy).toBe('GADMIN...OPERATOR');
      expect(acknowledged.acknowledgedAt).not.toBeNull();
    });

    it('rejects acknowledging an incident that is already acknowledged', async () => {
      const { incident } = await repository.recordDetection(detection());
      await repository.acknowledge(incident.id, 'GADMIN...OPERATOR');

      await expect(repository.acknowledge(incident.id, 'GADMIN...OPERATOR')).rejects.toThrow();
    });

    it('rejects acknowledging a resolved incident', async () => {
      const { incident } = await repository.recordDetection(detection());
      await repository.resolve(incident.id, 'GADMIN...OPERATOR');

      await expect(repository.acknowledge(incident.id, 'GADMIN...OPERATOR')).rejects.toThrow();
    });

    it('rejects acknowledging an incident that does not exist', async () => {
      await expect(repository.acknowledge(randomUUID(), 'GADMIN...OPERATOR')).rejects.toThrow();
    });
  });

  describe('resolution', () => {
    it('resolves an active incident directly', async () => {
      const { incident } = await repository.recordDetection(detection());
      const resolved = await repository.resolve(incident.id, 'GADMIN...OPERATOR', 'provider back online');

      expect(resolved.status).toBe(OracleIncidentStatus.Resolved);
      expect(resolved.resolvedBy).toBe('GADMIN...OPERATOR');
      expect(resolved.resolutionNote).toBe('provider back online');
      expect(resolved.resolvedAt).not.toBeNull();
    });

    it('resolves an already-acknowledged incident', async () => {
      const { incident } = await repository.recordDetection(detection());
      await repository.acknowledge(incident.id, 'GADMIN...OPERATOR');
      const resolved = await repository.resolve(incident.id, 'GADMIN...OPERATOR');

      expect(resolved.status).toBe(OracleIncidentStatus.Resolved);
    });

    it('rejects resolving an incident that is already resolved', async () => {
      const { incident } = await repository.recordDetection(detection());
      await repository.resolve(incident.id, 'GADMIN...OPERATOR');

      await expect(repository.resolve(incident.id, 'GADMIN...OPERATOR')).rejects.toThrow();
    });
  });

  describe('recurrence', () => {
    it('opens a new incident when the same subject goes stale again after resolution', async () => {
      const subjectId = randomUUID();
      const first = await repository.recordDetection(detection({ subjectId, detectedAt: '2026-03-01T00:00:00.000Z' }));
      await repository.resolve(first.incident.id, 'GADMIN...OPERATOR');

      const recurrence = await repository.recordDetection(detection({ subjectId, detectedAt: '2026-04-01T00:00:00.000Z' }));

      expect(recurrence.isNew).toBe(true);
      expect(recurrence.incident.id).not.toBe(first.incident.id);
      expect(recurrence.incident.status).toBe(OracleIncidentStatus.Active);
      expect(recurrence.incident.occurrenceCount).toBe(1);

      // The resolved incident's history is preserved, not overwritten.
      const resolvedHistory = await repository.findById(first.incident.id);
      expect(resolvedHistory?.status).toBe(OracleIncidentStatus.Resolved);
    });
  });

  describe('listing', () => {
    it('filters by status and paginates results', async () => {
      const resolvedOne = await repository.recordDetection(detection());
      await repository.resolve(resolvedOne.incident.id, 'GADMIN...OPERATOR');
      await repository.recordDetection(detection());

      const activeOnly = await repository.findMany(1, 50, OracleIncidentStatus.Active);
      expect(activeOnly.data.every((incident) => incident.status === OracleIncidentStatus.Active)).toBe(true);

      const resolvedOnly = await repository.findMany(1, 50, OracleIncidentStatus.Resolved);
      expect(resolvedOnly.data.some((incident) => incident.id === resolvedOne.incident.id)).toBe(true);

      const page1 = await repository.findMany(1, 1);
      expect(page1.data).toHaveLength(1);
      expect(page1.meta.limit).toBe(1);
      // With limit=1, totalPages == total exactly (ceil(total / 1) == total).
      expect(page1.meta.totalPages).toBe(page1.meta.total);
    });
  });

  describe('pagination contract (#402)', () => {
    /**
     * Walks every cursor page. Rows from earlier tests share the table, so
     * assertions compare against `total` rather than fixed counts.
     */
    async function walkCursor(limit: number, status?: OracleIncidentStatus) {
      const first = await repository.findMany(1, limit, status);
      const seen = [...first.data];
      let cursor = first.meta.nextCursor as string | undefined;
      let pages = 1;
      while (cursor) {
        const next = await repository.findMany(1, limit, status, cursor);
        expect(next.data.length).toBeGreaterThan(0); // a cursor is only issued when another page exists
        seen.push(...next.data);
        cursor = next.meta.nextCursor as string | undefined;
        pages++;
      }
      return { seen, total: first.meta.total, pages };
    }

    // One cron cycle stamps every subject it detects with the same time.
    async function seedTiedCycle(count: number, detectedAt: string): Promise<string[]> {
      const ids: string[] = [];
      for (let i = 0; i < count; i++) {
        ids.push((await repository.recordDetection(detection({ detectedAt }))).incident.id);
      }
      return ids;
    }

    it('cursor paging visits every row exactly once when detection times tie', async () => {
      const tied = await seedTiedCycle(7, '2026-03-01T00:00:00.000Z');

      const { seen, total } = await walkCursor(3);
      const ids = seen.map((incident) => incident.id);

      expect(ids).toHaveLength(total);
      expect(new Set(ids).size).toBe(total);
      expect(ids).toEqual(expect.arrayContaining(tied));
    });

    it('offset pages are disjoint and complete under ties (total order on time, id)', async () => {
      await seedTiedCycle(5, '2026-03-02T00:00:00.000Z');
      const { total } = (await repository.findMany(1, 1)).meta;

      const ids: string[] = [];
      for (let p = 1; p <= Math.ceil(total / 4); p++) {
        ids.push(...(await repository.findMany(p, 4)).data.map((incident) => incident.id));
      }
      expect(ids).toHaveLength(total);
      expect(new Set(ids).size).toBe(total);
    });

    it('orders newest detection first, then by id descending', async () => {
      const { seen } = await walkCursor(50);
      for (let i = 1; i < seen.length; i++) {
        const [prev, cur] = [seen[i - 1], seen[i]];
        const order = prev.lastDetectedAt.localeCompare(cur.lastDetectedAt) || prev.id.localeCompare(cur.id);
        expect(order).toBeGreaterThan(0);
      }
    });

    it('issues nextCursor only while another page exists', async () => {
      const { total } = (await repository.findMany(1, 1)).meta;
      expect((await repository.findMany(1, total)).meta.nextCursor).toBeUndefined();
      expect((await repository.findMany(1, total - 1)).meta.nextCursor).toEqual(expect.stringContaining('|'));
    });

    it('combines the status filter with cursor paging', async () => {
      const resolved = await repository.recordDetection(detection({ detectedAt: '2026-03-03T00:00:00.000Z' }));
      await repository.resolve(resolved.incident.id, 'GADMIN...OPERATOR');

      const { seen, total } = await walkCursor(2, OracleIncidentStatus.Resolved);

      expect(seen).toHaveLength(total);
      expect(seen.every((incident) => incident.status === OracleIncidentStatus.Resolved)).toBe(true);
      expect(seen.map((incident) => incident.id)).toContain(resolved.incident.id);
    });

    it('keeps a cursor page stable when newer incidents arrive between requests (retry-safe)', async () => {
      const first = await repository.findMany(1, 2);
      const cursor = first.meta.nextCursor as string;
      const before = await repository.findMany(1, 2, undefined, cursor);

      await repository.recordDetection(detection({ detectedAt: '2027-01-01T00:00:00.000Z' }));

      const retried = await repository.findMany(1, 2, undefined, cursor);
      expect(retried.data.map((i) => i.id)).toEqual(before.data.map((i) => i.id));
    });

    it('still accepts a legacy timestamp-only cursor (strictly older rows)', async () => {
      const page = await repository.findMany(1, 50, undefined, '2026-03-02T00:00:00.000Z');
      expect(page.data.length).toBeGreaterThan(0);
      expect(page.data.every((incident) => incident.lastDetectedAt < '2026-03-02T00:00:00.000Z')).toBe(true);
    });

    it.each([
      ['garbage', 'not-a-cursor'],
      ['a non-UUID id', '2026-03-01T00:00:00.000Z|42'],
      ['extra segments', '2026-03-01T00:00:00.000Z|b6f7e0a4-1c1e-4b8a-9d55-3f0b5d0f2a11|x'],
    ])('rejects a cursor with %s as a client error', async (_label, cursor) => {
      await expect(repository.findMany(1, 10, undefined, cursor)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('returns an empty page, the real total, and no cursor past the last page', async () => {
      const result = await repository.findMany(10_000, 100);
      expect(result.data).toEqual([]);
      expect(result.meta.total).toBeGreaterThan(0);
      expect(result.meta.nextCursor).toBeUndefined();
    });
  });
});
