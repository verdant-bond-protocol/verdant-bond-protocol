import { BadRequestException, INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { OracleController } from './oracle.controller';
import { OracleService } from './oracle.service';
import { OracleMonitoringService } from './oracle.monitoring.service';
import { OracleIncidentRepository } from './oracle-incident.repository';
import { CircuitBreakerService } from './circuit-breaker.service';
import { OracleIncidentStatus } from './interfaces/oracle-incident.interface';
import { Rfc7807ExceptionFilter } from '../common/filters/rfc7807-exception.filter';
import { buildControllerApp } from '../test/controller-guard.harness';
import { autoMock, TestRole } from '../test/guard-role-mocks';

/**
 * HTTP contract for `GET /oracle/incidents` (#402): pagination bounds,
 * filtering, and the authorization boundary, exercised through the same
 * ValidationPipe options (`main.ts`) and RFC 7807 filter (`app.module.ts`)
 * the API runs with. Keyset paging itself is verified against real Postgres
 * in `oracle-incident.repository.spec.ts`.
 */
describe('GET /oracle/incidents contract (#402)', () => {
  let app: INestApplication;
  const incidents = autoMock(OracleIncidentRepository);
  const page = {
    data: [{ id: 'b6f7e0a4-1c1e-4b8a-9d55-3f0b5d0f2a11', status: OracleIncidentStatus.Active }],
    meta: { page: 1, limit: 20, total: 1, totalPages: 1 },
  };

  const get = (query: string, role: TestRole = 'admin') =>
    request(app.getHttpServer()).get(`/oracle/incidents${query}`).set('x-test-role', role);

  beforeAll(async () => {
    app = await buildControllerApp(
      OracleController,
      [
        { provide: OracleService, useValue: autoMock(OracleService) },
        { provide: OracleMonitoringService, useValue: autoMock(OracleMonitoringService) },
        { provide: OracleIncidentRepository, useValue: incidents },
        { provide: CircuitBreakerService, useValue: autoMock(CircuitBreakerService) },
      ],
      (nest) => {
        nest.useGlobalPipes(
          new ValidationPipe({
            whitelist: true,
            transform: true,
            transformOptions: { enableImplicitConversion: true },
            validationError: { target: false, value: false },
          }),
        );
        nest.useGlobalFilters(new Rfc7807ExceptionFilter());
      },
    );
  });

  afterAll(() => app.close());

  beforeEach(() => {
    incidents.findMany.mockReset();
    incidents.findMany.mockResolvedValue(page as any);
  });

  describe('authorization boundary', () => {
    it('rejects anonymous callers with 401 before the store is queried', async () => {
      await get('', 'anon').expect(401);
      expect(incidents.findMany).not.toHaveBeenCalled();
    });

    it('rejects an authenticated caller without MANAGE_INCIDENTS with 403', async () => {
      const res = await get('?status=active', 'user').expect(403);
      expect(res.body).toMatchObject({ status: 403, code: 'FORBIDDEN' });
      expect(incidents.findMany).not.toHaveBeenCalled();
    });

    it('rejects an invalid query from an unauthorized caller as 403, not 400 (no validation oracle)', async () => {
      await get('?limit=1000', 'user').expect(403);
    });

    it('serves a caller holding MANAGE_INCIDENTS', async () => {
      const res = await get('').expect(200);
      expect(res.body).toEqual(page);
    });
  });

  describe('pagination bounds', () => {
    it('applies the documented defaults: page 1, limit 20, no filter, no cursor', async () => {
      await get('').expect(200);
      expect(incidents.findMany).toHaveBeenCalledWith(1, 20, undefined, undefined);
    });

    it.each(['?limit=1', '?limit=100', '?page=10000'])('accepts the boundary value %s', async (query) => {
      await get(query).expect(200);
    });

    it.each([
      ['limit below 1', '?limit=0'],
      ['limit above 100', '?limit=101'],
      ['non-integer limit', '?limit=2.5'],
      ['non-numeric limit', '?limit=all'],
      ['page below 1', '?page=0'],
      ['page above 10000', '?page=10001'],
    ])('rejects %s with an RFC 7807 400 before the store is queried', async (_label, query) => {
      const res = await get(query).expect(400);
      expect(res.body).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
      expect(res.body.errors?.length).toBeGreaterThan(0);
      expect(incidents.findMany).not.toHaveBeenCalled();
    });
  });

  describe('filtering', () => {
    it('forwards the status filter and cursor unchanged', async () => {
      const cursor = '2026-01-01T00:00:00.000Z|b6f7e0a4-1c1e-4b8a-9d55-3f0b5d0f2a11';
      await get(`?status=acknowledged&limit=5&cursor=${encodeURIComponent(cursor)}`).expect(200);
      expect(incidents.findMany).toHaveBeenCalledWith(1, 5, OracleIncidentStatus.Acknowledged, cursor);
    });

    it('rejects a status outside the enum', async () => {
      await get('?status=deleted').expect(400);
      expect(incidents.findMany).not.toHaveBeenCalled();
    });

    it('strips unknown query parameters instead of passing them to the store', async () => {
      await get('?severity=critical&owner=GXYZ').expect(200);
      expect(incidents.findMany).toHaveBeenCalledWith(1, 20, undefined, undefined);
    });
  });

  describe('failure and retry', () => {
    it('maps a malformed cursor to a 400, not a 500', async () => {
      incidents.findMany.mockRejectedValueOnce(new BadRequestException('Invalid pagination cursor'));
      const res = await get('?cursor=not-a-cursor').expect(400);
      expect(res.body).toMatchObject({ status: 400 });
    });

    it('answers a store outage with a generic 500 that leaks no internals, and the same request then succeeds', async () => {
      incidents.findMany.mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.5:5432'));

      const failed = await get('?status=active').expect(500);
      expect(failed.body).toMatchObject({ status: 500, code: 'INTERNAL_ERROR' });
      expect(JSON.stringify(failed.body)).not.toContain('ECONNREFUSED');

      await get('?status=active').expect(200);
      expect(incidents.findMany).toHaveBeenNthCalledWith(2, 1, 20, OracleIncidentStatus.Active, undefined);
    });

    it('is a pure read: repeating a request yields the same response', async () => {
      const first = await get('?status=active&limit=1').expect(200);
      const second = await get('?status=active&limit=1').expect(200);
      expect(second.body).toEqual(first.body);
    });
  });
});
