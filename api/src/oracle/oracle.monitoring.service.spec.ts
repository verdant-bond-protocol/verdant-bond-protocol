import { Test } from '@nestjs/testing';
import { OracleMonitoringService } from './oracle.monitoring.service';
import { ProjectsService } from '../projects/projects.service';
import { OracleService } from './oracle.service';
import { OracleIncidentRepository } from './oracle-incident.repository';
import { ReportStatus } from './interfaces/oracle.interface';
import { OracleIncidentSeverity, OracleIncidentStatus, OracleIncidentSubjectType } from './interfaces/oracle-incident.interface';
import { RedisService } from '../common/services/redis.service';

const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const CADENCE_GRACE_MS = (365 + 30) * 24 * 60 * 60 * 1000;

describe('OracleMonitoringService', () => {
  let service: OracleMonitoringService;
  let projectsService: { findAll: jest.Mock };
  let oracleService: { getProjectReports: jest.Mock };
  let incidentRepository: { recordDetection: jest.Mock };

  const makeProject = (id: number, methodology: string, createdAt = NOW - DAY) => ({
    id,
    name: `Project ${id}`,
    status: 'Approved',
    methodology,
    country: 'PE',
    metadataIpfsHash: '00',
    ownerAddress: 'G000000000000000000000000000000000000000000000000000000000000000',
    totalAreaHa: 10,
    carbonSequestrationEstimate: 100,
    createdAt: new Date(createdAt).toISOString(),
  });

  const makeReport = (verifiedAt: number, providerAddress: string) => ({
    id: 1,
    projectId: 'aa',
    periodStart: 1,
    periodEnd: 2,
    carbonSequestered: 100,
    methodology: 'VERRA-VCS',
    ipfsHash: 'bb',
    providerAddress,
    status: ReportStatus.Verified,
    createdAt: new Date(verifiedAt - DAY).toISOString(),
    verifiedAt: new Date(verifiedAt).toISOString(),
  });

  beforeEach(async () => {
    projectsService = { findAll: jest.fn() };
    oracleService = { getProjectReports: jest.fn() };
    incidentRepository = { recordDetection: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        OracleMonitoringService,
        { provide: ProjectsService, useValue: projectsService },
        { provide: OracleService, useValue: oracleService },
        { provide: OracleIncidentRepository, useValue: incidentRepository },
        {
          provide: RedisService,
          useValue: {
            get: jest.fn().mockResolvedValue(null),
            set: jest.fn().mockResolvedValue(undefined),
            setEx: jest.fn().mockResolvedValue(undefined),
            del: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = moduleRef.get(OracleMonitoringService);
  });

  describe('computeStaleness', () => {
    it('marks a project stale when its last verified report exceeds cadence + grace', async () => {
      projectsService.findAll.mockResolvedValue({
        data: [makeProject(1, 'VERRA-VCS')],
        meta: { total: 1 },
      });
      oracleService.getProjectReports.mockResolvedValue([
        makeReport(NOW - CADENCE_GRACE_MS - DAY, 'GPROVIDER'),
      ]);

      const report = await service.computeStaleness(NOW);
      expect(report.projects[0].isStale).toBe(true);
      expect(report.projects[0].stalenessSeconds).toBe(
        (CADENCE_GRACE_MS + DAY) / 1000,
      );
    });

    it('marks a project healthy while reports are within the reporting window', async () => {
      projectsService.findAll.mockResolvedValue({
        data: [makeProject(1, 'VERRA-VCS')],
        meta: { total: 1 },
      });
      oracleService.getProjectReports.mockResolvedValue([
        makeReport(NOW - DAY, 'GPROVIDER'),
      ]);

      const report = await service.computeStaleness(NOW);
      expect(report.projects[0].isStale).toBe(false);
      expect(report.projects[0].lastVerifiedAt).toBe(
        new Date(NOW - DAY).toISOString(),
      );
    });

    it('marks a never-reported project stale once it exceeds the window', async () => {
      projectsService.findAll.mockResolvedValue({
        data: [makeProject(1, 'VERRA-VCS', NOW - CADENCE_GRACE_MS - DAY)],
        meta: { total: 1 },
      });
      oracleService.getProjectReports.mockResolvedValue([]);

      const report = await service.computeStaleness(NOW);
      expect(report.projects[0].isStale).toBe(true);
      expect(report.projects[0].lastVerifiedAt).toBe(
        new Date(NOW - CADENCE_GRACE_MS - DAY).toISOString(),
      );
    });

    it('applies a shorter cadence for remote-sensing methodologies', async () => {
      projectsService.findAll.mockResolvedValue({
        data: [makeProject(1, 'REMOTE-SENSING')],
        meta: { total: 1 },
      });
      oracleService.getProjectReports.mockResolvedValue([
        makeReport(NOW - 200 * DAY, 'GPROVIDER'),
      ]);

      const report = await service.computeStaleness(NOW);
      expect(report.projects[0].expectedCadenceSeconds).toBe(90 * 24 * 60 * 60);
      expect(report.projects[0].isStale).toBe(true);
    });

    it('aggregates provider staleness from verified reports', async () => {
      projectsService.findAll.mockResolvedValue({
        data: [
          makeProject(1, 'VERRA-VCS'),
          makeProject(2, 'VERRA-VCS'),
        ],
        meta: { total: 2 },
      });
      oracleService.getProjectReports.mockImplementation((projectId: string) =>
        Promise.resolve([
          projectId === '1'
            ? makeReport(NOW - 2 * DAY, 'GPROVIDER')
            : makeReport(NOW - DAY, 'GPROVIDER'),
        ]),
      );

      const report = await service.computeStaleness(NOW);
      expect(report.providers).toHaveLength(1);
      expect(report.providers[0].providerAddress).toBe('GPROVIDER');
      expect(report.providers[0].projectIds.sort()).toEqual(['1', '2']);
      expect(report.providers[0].isStale).toBe(false);
    });

    it('tolerates report-fetch failures', async () => {
      projectsService.findAll.mockResolvedValue({
        data: [makeProject(1, 'VERRA-VCS', NOW - CADENCE_GRACE_MS - DAY)],
        meta: { total: 1 },
      });
      oracleService.getProjectReports.mockRejectedValue(new Error('rpc down'));

      const report = await service.computeStaleness(NOW);
      expect(report.projects[0].isStale).toBe(true);
      expect(report.projects).toHaveLength(1);
    });
  });

  describe('syncIncidents (#95)', () => {
    function fakeIncident(overrides: Partial<{ id: string; occurrenceCount: number; severity: OracleIncidentSeverity }> = {}) {
      return {
        id: overrides.id ?? 'incident-1',
        dedupeKey: 'project:1',
        subjectType: OracleIncidentSubjectType.Project,
        subjectId: '1',
        status: OracleIncidentStatus.Active,
        severity: overrides.severity ?? OracleIncidentSeverity.Warning,
        occurrenceCount: overrides.occurrenceCount ?? 1,
        firstDetectedAt: new Date(NOW).toISOString(),
        lastDetectedAt: new Date(NOW).toISOString(),
        acknowledgedAt: null,
        acknowledgedBy: null,
        resolvedAt: null,
        resolvedBy: null,
        resolutionNote: null,
        details: null,
        createdAt: new Date(NOW).toISOString(),
        updatedAt: new Date(NOW).toISOString(),
      };
    }

    it('records a durable incident for a stale project instead of only logging', async () => {
      projectsService.findAll.mockResolvedValue({
        data: [makeProject(1, 'VERRA-VCS', NOW - CADENCE_GRACE_MS - DAY)],
        meta: { total: 1 },
      });
      oracleService.getProjectReports.mockResolvedValue([]);
      incidentRepository.recordDetection.mockResolvedValue({
        incident: fakeIncident(),
        isNew: true,
        escalated: false,
      });

      const summary = await service.syncIncidents(NOW);

      expect(incidentRepository.recordDetection).toHaveBeenCalledWith(
        expect.objectContaining({ subjectType: OracleIncidentSubjectType.Project, subjectId: '1' }),
      );
      expect(summary).toEqual({ created: 1, updated: 0, escalated: 0 });
    });

    it('also records incidents for stale providers, not just stale projects', async () => {
      projectsService.findAll.mockResolvedValue({
        data: [makeProject(1, 'VERRA-VCS'), makeProject(2, 'VERRA-VCS')],
        meta: { total: 2 },
      });
      // Both projects share a provider whose last report is far outside the
      // reporting window, so the provider (not just the project) is stale.
      oracleService.getProjectReports.mockResolvedValue([
        makeReport(NOW - CADENCE_GRACE_MS - DAY, 'GSTALEPROVIDER'),
      ]);
      incidentRepository.recordDetection.mockImplementation(({ subjectType }) =>
        Promise.resolve({
          incident: fakeIncident({ id: `${subjectType}-incident` }),
          isNew: true,
          escalated: false,
        }),
      );

      await service.syncIncidents(NOW);

      expect(incidentRepository.recordDetection).toHaveBeenCalledWith(
        expect.objectContaining({ subjectType: OracleIncidentSubjectType.Provider, subjectId: 'GSTALEPROVIDER' }),
      );
    });

    it('does not record an incident for a project or provider that is not stale', async () => {
      projectsService.findAll.mockResolvedValue({
        data: [makeProject(1, 'VERRA-VCS')],
        meta: { total: 1 },
      });
      oracleService.getProjectReports.mockResolvedValue([makeReport(NOW - DAY, 'GPROVIDER')]);

      const summary = await service.syncIncidents(NOW);

      expect(incidentRepository.recordDetection).not.toHaveBeenCalled();
      expect(summary).toEqual({ created: 0, updated: 0, escalated: 0 });
    });

    it('tallies an existing incident as updated, not created, on a repeated cron cycle', async () => {
      projectsService.findAll.mockResolvedValue({
        data: [makeProject(1, 'VERRA-VCS', NOW - CADENCE_GRACE_MS - DAY)],
        meta: { total: 1 },
      });
      oracleService.getProjectReports.mockResolvedValue([]);
      incidentRepository.recordDetection.mockResolvedValue({
        incident: fakeIncident({ occurrenceCount: 2 }),
        isNew: false,
        escalated: false,
      });

      const summary = await service.syncIncidents(NOW);
      expect(summary).toEqual({ created: 0, updated: 1, escalated: 0 });
    });

    it('tallies an escalation separately from the created/updated counts', async () => {
      projectsService.findAll.mockResolvedValue({
        data: [makeProject(1, 'VERRA-VCS', NOW - CADENCE_GRACE_MS - DAY)],
        meta: { total: 1 },
      });
      oracleService.getProjectReports.mockResolvedValue([]);
      incidentRepository.recordDetection.mockResolvedValue({
        incident: fakeIncident({ occurrenceCount: 3, severity: OracleIncidentSeverity.Critical }),
        isNew: false,
        escalated: true,
      });

      const summary = await service.syncIncidents(NOW);
      expect(summary).toEqual({ created: 0, updated: 1, escalated: 1 });
    });
  });

  describe('computeCrossSourceAnomalies (#158)', () => {
    it('flags a project-period whose two providers disagree beyond tolerance', async () => {
      projectsService.findAll.mockResolvedValue({
        data: [makeProject(1, 'VERRA-VCS')],
        meta: { total: 1 },
      });
      oracleService.getProjectReports.mockResolvedValue([
        { ...makeReport(NOW, 'GPROVIDER_A'), carbonSequestered: '1000' },
        { ...makeReport(NOW, 'GPROVIDER_B'), carbonSequestered: '1000' },
        { ...makeReport(NOW, 'GPROVIDER_C'), carbonSequestered: '1400' },
      ]);

      const report = await service.computeCrossSourceAnomalies(NOW);
      expect(report.asOf).toBe(new Date(NOW).toISOString());
      expect(report.anomalies).toHaveLength(1);
      expect(report.anomalies[0].kind).toBe('outlier');
      expect(['warning', 'critical']).toContain(report.anomalies[0].severity);
    });

    it('returns missing_source when no independent cross-check exists', async () => {
      projectsService.findAll.mockResolvedValue({
        data: [makeProject(1, 'VERRA-VCS')],
        meta: { total: 1 },
      });
      oracleService.getProjectReports.mockResolvedValue([
        { ...makeReport(NOW, 'GPROVIDER_A'), carbonSequestered: '1000' },
      ]);

      const report = await service.computeCrossSourceAnomalies(NOW);
      expect(report.anomalies[0].kind).toBe('missing_source');
      expect(report.anomalies[0].severity).toBe('info');
    });

    it('treats a project whose chain read fails as skipped, not fatal', async () => {
      projectsService.findAll.mockResolvedValue({
        data: [makeProject(1, 'VERRA-VCS')],
        meta: { total: 1 },
      });
      oracleService.getProjectReports.mockRejectedValue(new Error('rpc down'));

      const report = await service.computeCrossSourceAnomalies(NOW);
      expect(report.anomalies).toEqual([]);
    });
  });
});
