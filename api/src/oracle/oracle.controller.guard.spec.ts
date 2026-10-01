import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { OracleController } from './oracle.controller';
import { OracleService } from './oracle.service';
import { OracleMonitoringService } from './oracle.monitoring.service';
import { OracleIncidentRepository } from './oracle-incident.repository';
import { buildControllerApp } from '../test/controller-guard.harness';
import { autoMock, TestRole } from '../test/guard-role-mocks';

describe('OracleController authorization (behavioral)', () => {
  let app: INestApplication;
  let oracleService: jest.Mocked<OracleService>;
  let monitoringService: jest.Mocked<OracleMonitoringService>;
  let incidents: jest.Mocked<OracleIncidentRepository>;

  const mockOracleService = autoMock(OracleService);
  const mockMonitoringService = autoMock(OracleMonitoringService);
  const mockIncidents = autoMock(OracleIncidentRepository);

  beforeAll(async () => {
    app = await buildControllerApp(OracleController, [
      { provide: OracleService, useValue: mockOracleService },
      { provide: OracleMonitoringService, useValue: mockMonitoringService },
      { provide: OracleIncidentRepository, useValue: mockIncidents },
    ]);
    oracleService = app.get(OracleService) as jest.Mocked<OracleService>;
    monitoringService = app.get(OracleMonitoringService) as jest.Mocked<OracleMonitoringService>;
    incidents = app.get(OracleIncidentRepository) as jest.Mocked<OracleIncidentRepository>;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /oracle/incidents (admin-only)', () => {
    it('rejects anonymous callers', async () => {
      await request(app.getHttpServer())
        .get('/oracle/incidents')
        .set('x-test-role', 'anon' as TestRole)
        .expect(401);
      expect(incidents.findMany).not.toHaveBeenCalled();
    });

    it('rejects authenticated non-admin callers', async () => {
      await request(app.getHttpServer())
        .get('/oracle/incidents')
        .set('x-test-role', 'user' as TestRole)
        .expect(403);
      expect(incidents.findMany).not.toHaveBeenCalled();
    });

    it('allows the admin key', async () => {
      mockIncidents.findMany.mockResolvedValue({ items: [], total: 0 } as any);
      await request(app.getHttpServer())
        .get('/oracle/incidents')
        .set('x-test-role', 'admin' as TestRole)
        .expect(200);
      expect(incidents.findMany).toHaveBeenCalled();
    });
  });

  describe('POST /oracle/incidents/:id/resolve (admin-only)', () => {
    it('rejects non-admin callers and never resolves an incident', async () => {
      await request(app.getHttpServer())
        .post('/oracle/incidents/abc/resolve')
        .set('x-test-role', 'user' as TestRole)
        .send({ resolutionNote: 'done' })
        .expect(403);
      expect(incidents.resolve).not.toHaveBeenCalled();
    });
  });

  describe('public + wallet-header oracle endpoints', () => {
    it('GET /oracle/reports/:projectId is public', async () => {
      mockOracleService.getProjectReports.mockResolvedValue([] as any);
      await request(app.getHttpServer())
        .get('/oracle/reports/PROJ')
        .set('x-test-role', 'anon' as TestRole)
        .expect(200);
      expect(oracleService.getProjectReports).toHaveBeenCalledWith('PROJ');
    });

    it('POST /oracle/reports is wallet-header gated (no JWT) but reaches the service', async () => {
      mockOracleService.submitReport.mockResolvedValue({ id: 1 } as any);
      await request(app.getHttpServer())
        .post('/oracle/reports')
        .set('x-test-role', 'anon' as TestRole)
        .set('x-provider-address', 'G_PROVIDER')
        .send({ projectId: 'PROJ' })
        .expect(201);
      expect(oracleService.submitReport).toHaveBeenCalled();
    });

    it('GET /oracle/monitoring/staleness is public', async () => {
      mockMonitoringService.computeStaleness.mockResolvedValue({ stale: [] } as any);
      await request(app.getHttpServer())
        .get('/oracle/monitoring/staleness')
        .set('x-test-role', 'anon' as TestRole)
        .expect(200);
      expect(monitoringService.computeStaleness).toHaveBeenCalled();
    });

    it('GET /oracle/monitoring/anomalies is public (#158)', async () => {
      mockMonitoringService.computeCrossSourceAnomalies.mockResolvedValue({
        asOf: new Date().toISOString(),
        anomalies: [],
      } as any);
      await request(app.getHttpServer())
        .get('/oracle/monitoring/anomalies')
        .set('x-test-role', 'anon' as TestRole)
        .expect(200);
      expect(monitoringService.computeCrossSourceAnomalies).toHaveBeenCalled();
    });
  });
});
