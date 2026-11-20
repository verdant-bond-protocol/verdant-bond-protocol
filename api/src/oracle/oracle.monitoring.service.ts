import { Injectable, Logger } from '@nestjs/common';
import { ProjectsService } from '../projects/projects.service';
import { OracleService } from './oracle.service';
import { OracleIncidentRepository } from './oracle-incident.repository';
import {
  ReportStatus,
  StalenessMetric,
  ProviderStalenessMetric,
  OracleStalenessReport,
  CrossSourceAssessment,
  OracleAnomalyReport,
} from './interfaces/oracle.interface';
import {
  IncidentDetectionResult,
  OracleIncidentSubjectType,
  OracleIncidentSyncSummary,
} from './interfaces/oracle-incident.interface';
import { computeCrossSourceAnomalies } from './anomaly.detector';

const DEFAULT_CADENCE_SECONDS = 365 * 24 * 60 * 60;
const DEFAULT_GRACE_SECONDS = 30 * 24 * 60 * 60;
const CADENCE_OVERRIDES: Array<{ pattern: RegExp; seconds: number }> = [
  { pattern: /REMOTE.?SENSING|SATELLITE/i, seconds: 90 * 24 * 60 * 60 },
  { pattern: /IOT|SENSOR/i, seconds: 30 * 24 * 60 * 60 },
];

function cadenceForMethodology(methodology: string): number {
  for (const override of CADENCE_OVERRIDES) {
    if (override.pattern.test(methodology)) return override.seconds;
  }
  const configured = Number(process.env.ORACLE_CADENCE_SECONDS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_CADENCE_SECONDS;
}

function graceSeconds(): number {
  const configured = Number(process.env.ORACLE_GRACE_SECONDS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_GRACE_SECONDS;
}

@Injectable()
export class OracleMonitoringService {
  private readonly logger = new Logger(OracleMonitoringService.name);

  constructor(
    private readonly projectsService: ProjectsService,
    private readonly oracleService: OracleService,
    private readonly incidents: OracleIncidentRepository,
  ) {}

  async computeStaleness(now: number = Date.now()): Promise<OracleStalenessReport> {
    const projects = await this.projectsService.findAll(1, 1000);

    const projectMetrics: StalenessMetric[] = [];
    const reportsByProvider = new Map<string, Array<{ projectId: string; verifiedAt: number }>>();

    for (const project of projects.data) {
      const projectId = String(project.id);
      const cadence = cadenceForMethodology(project.methodology);
      const grace = graceSeconds();

      let lastVerifiedAt: number | undefined;
      let providerAddress: string | undefined;
      try {
        const reports = await this.oracleService.getProjectReports(projectId);
        const latest = reports
          .filter((report) => report.status === ReportStatus.Verified)
          .sort(
            (a, b) =>
              this.reportTime(b) - this.reportTime(a),
          )[0];

        if (latest) {
          lastVerifiedAt = this.reportTime(latest);
          providerAddress = latest.providerAddress;
          if (providerAddress) {
            const entry = reportsByProvider.get(providerAddress) ?? [];
            entry.push({ projectId, verifiedAt: lastVerifiedAt });
            reportsByProvider.set(providerAddress, entry);
          }
        }
      } catch {}

      const baseline = lastVerifiedAt ?? new Date(project.createdAt).getTime();
      projectMetrics.push(
        this.buildProjectMetric(projectId, providerAddress, baseline, cadence, grace, now),
      );
    }

    const providerMetrics = this.aggregateProviderStaleness(reportsByProvider, now);

    return {
      asOf: new Date(now).toISOString(),
      projects: projectMetrics,
      providers: providerMetrics,
    };
  }

  /**
   * Compute cross-source anomaly assessments across every project-period
   * (#158). Reports from independent providers for the same project-period are
   * compared against a methodology-family tolerance; disagreements beyond
   * tolerance are surfaced so an operator can investigate a possibly fabricated
   * or faulty measurement instead of trusting a single source.
   */
  async computeCrossSourceAnomalies(now: number = Date.now()): Promise<OracleAnomalyReport> {
    const anomalies: CrossSourceAssessment[] = [];
    const projects = await this.projectsService.findAll(1, 1000);

    for (const project of projects.data) {
      const projectId = String(project.id);
      try {
        const reports = await this.oracleService.getProjectReports(projectId);
        anomalies.push(...computeCrossSourceAnomalies(reports));
      } catch {
        // A project whose chain read fails is skipped; it contributes no period.
      }
    }

    return {
      asOf: new Date(now).toISOString(),
      anomalies,
    };
  }

  /**
   * Evaluate the current staleness report and reconcile durable incidents
   * for every stale project and stale provider (issue #95). Each detection
   * is recorded via `OracleIncidentRepository.recordDetection`, which
   * dedupes/updates in place -- so a repeated cron cycle over an
   * already-open incident produces a database update, not a new row, and
   * (per `recordAndLog` below) does not re-emit a log line unless the
   * incident is new or has just escalated. This is the fix for "repeated
   * cron cycles can spam logs": the previous implementation only
   * rate-limited the log line via a Redis TTL key and never persisted
   * anything an operator could query, acknowledge, or resolve.
   */
  async syncIncidents(now: number = Date.now()): Promise<OracleIncidentSyncSummary> {
    const report = await this.computeStaleness(now);
    const detectedAt = new Date(now).toISOString();
    const summary: OracleIncidentSyncSummary = { created: 0, updated: 0, escalated: 0 };

    for (const metric of report.projects.filter((m) => m.isStale)) {
      const result = await this.recordAndLog(OracleIncidentSubjectType.Project, metric.projectId, detectedAt, {
        lastVerifiedAt: metric.lastVerifiedAt,
        expectedNextReportAt: metric.expectedNextReportAt,
        stalenessSeconds: metric.stalenessSeconds,
      });
      this.tally(summary, result);
    }

    for (const metric of report.providers.filter((m) => m.isStale)) {
      const result = await this.recordAndLog(OracleIncidentSubjectType.Provider, metric.providerAddress, detectedAt, {
        lastVerifiedAt: metric.lastVerifiedAt,
        expectedNextReportAt: metric.expectedNextReportAt,
        stalenessSeconds: metric.stalenessSeconds,
        projectIds: metric.projectIds,
      });
      this.tally(summary, result);
    }

    if (summary.created + summary.updated > 0) {
      this.logger.log(
        `Oracle monitoring: ${summary.created} incident(s) created, ${summary.updated} updated, ` +
          `${summary.escalated} escalated this cycle`,
      );
    }
    return summary;
  }

  private async recordAndLog(
    subjectType: OracleIncidentSubjectType,
    subjectId: string,
    detectedAt: string,
    details: { lastVerifiedAt?: string; expectedNextReportAt?: string; stalenessSeconds?: number; projectIds?: string[] },
  ): Promise<IncidentDetectionResult> {
    const result = await this.incidents.recordDetection({ subjectType, subjectId, detectedAt, details });

    if (result.isNew) {
      this.logger.warn(
        `Oracle incident opened: ${subjectType} ${subjectId} is stale. ` +
          `Last verified: ${details.lastVerifiedAt ?? 'never'}, ` +
          `staleness: ${this.formatDuration(details.stalenessSeconds ?? 0)} (incident ${result.incident.id})`,
      );
    } else if (result.escalated) {
      this.logger.warn(
        `Oracle incident escalated to ${result.incident.severity}: ${subjectType} ${subjectId} ` +
          `(occurrence #${result.incident.occurrenceCount}, incident ${result.incident.id})`,
      );
    }
    return result;
  }

  private tally(summary: OracleIncidentSyncSummary, result: IncidentDetectionResult): void {
    if (result.isNew) summary.created += 1;
    else summary.updated += 1;
    if (result.escalated) summary.escalated += 1;
  }

  private buildProjectMetric(
    projectId: string,
    providerAddress: string | undefined,
    baselineMs: number,
    cadenceSeconds: number,
    grace: number,
    now: number,
  ): StalenessMetric {
    const expectedNext = baselineMs + (cadenceSeconds + grace) * 1000;
    const staleness = Math.max(0, now - baselineMs);
    return {
      projectId,
      providerAddress,
      lastVerifiedAt: new Date(baselineMs).toISOString(),
      expectedCadenceSeconds: cadenceSeconds,
      graceSeconds: grace,
      expectedNextReportAt: new Date(expectedNext).toISOString(),
      stalenessSeconds: Math.floor(staleness / 1000),
      isStale: now > expectedNext,
    };
  }

  private aggregateProviderStaleness(
    reportsByProvider: Map<string, Array<{ projectId: string; verifiedAt: number }>>,
    now: number,
  ): ProviderStalenessMetric[] {
    const metrics: ProviderStalenessMetric[] = [];
    for (const [providerAddress, reports] of reportsByProvider) {
      const latest = reports.reduce((max, report) =>
        report.verifiedAt > max.verifiedAt ? report : max,
      );
      const cadence = DEFAULT_CADENCE_SECONDS;
      const grace = graceSeconds();
      const expectedNext = latest.verifiedAt + (cadence + grace) * 1000;
      const staleness = Math.max(0, now - latest.verifiedAt);
      metrics.push({
        providerAddress,
        lastVerifiedAt: new Date(latest.verifiedAt).toISOString(),
        expectedNextReportAt: new Date(expectedNext).toISOString(),
        stalenessSeconds: Math.floor(staleness / 1000),
        isStale: now > expectedNext,
        projectIds: reports.map((report) => report.projectId),
      });
    }
    return metrics;
  }

  private reportTime(report: { verifiedAt?: string; createdAt: string }): number {
    return new Date(report.verifiedAt ?? report.createdAt).getTime();
  }

  private formatDuration(seconds: number): string {
    const days = Math.floor(seconds / (24 * 60 * 60));
    const hours = Math.floor((seconds % (24 * 60 * 60)) / (60 * 60));
    return `${days}d ${hours}h`;
  }
}
