import { z } from 'zod';
import { createAxiosHttpClient, HttpClient } from './http';
import { buildOracleReport } from './report';
import {
  VerraProjectSchema,
  VerraReportListSchema,
  VerraProject,
  VerraMonitoringReport,
  METHODOLOGY,
} from './schemas';

const DEFAULT_REGISTRY_URL =
  process.env.VERRA_REGISTRY_URL || 'https://registry.verra.org/api/v1';

export interface VerraAdapterOptions {
  baseUrl?: string;
  http?: HttpClient;
  timeoutMs?: number;
}

export class VerraAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerraAdapterError';
  }
}

export class VerraNotFoundError extends VerraAdapterError {
  constructor(projectId: string) {
    super(`Verra project not found: ${projectId}`);
    this.name = 'VerraNotFoundError';
  }
}

export class VerraSchemaError extends VerraAdapterError {
  constructor(source: string, issues: z.ZodIssue[]) {
    super(`Verra response for ${source} failed schema validation: ${issues[0]?.message ?? 'unknown issue'}`);
    this.name = 'VerraSchemaError';
  }
}

export class VerraNoVerifiedReportsError extends VerraAdapterError {
  constructor(projectId: string, periodStart: string, periodEnd: string) {
    super(
      `No VERIFIED Verra monitoring reports for project ${projectId} in period ${periodStart}..${periodEnd}`,
    );
    this.name = 'VerraNoVerifiedReportsError';
  }
}

/** Validate a single report, keeping only VERIFIED reports inside the window. */
export function filterVerifiedReports(
  reports: VerraMonitoringReport[],
  periodStart: string,
  periodEnd: string,
): VerraMonitoringReport[] {
  return reports.filter(
    (report) =>
      report.verification_status === 'VERIFIED' &&
      report.reporting_period_start >= periodStart &&
      report.reporting_period_end <= periodEnd,
  );
}

/**
 * Poll a Verra-compatible registry for the verified project report(s)
 * covering `periodStart`..`periodEnd` and produce an `OracleReport`.
 *
 * Upstream responses are validated against `VerraProjectSchema` /
 * `VerraReportListSchema` before any report is produced. Throws
 * `VerraNotFoundError`, `VerraSchemaError`, or `VerraNoVerifiedReportsError`
 * on the corresponding failure paths.
 */
export async function pollVerraProject(
  projectId: string,
  period: { periodStart: string; periodEnd: string },
  options: VerraAdapterOptions = {},
): Promise<ReturnType<typeof buildOracleReport>> {
  const baseUrl = (options.baseUrl || DEFAULT_REGISTRY_URL).replace(/\/$/, '');
  const http = options.http ?? createAxiosHttpClient(options.timeoutMs);
  const { periodStart, periodEnd } = period;

  const project = await fetchVerraProject(projectId, { baseUrl, http });

  const response = await http.get<unknown>(
    `${baseUrl}/projects/${projectId}/monitoring-reports?verified=true&start=${periodStart}&end=${periodEnd}`,
  );

  let parsed: z.infer<typeof VerraReportListSchema>;
  try {
    parsed = VerraReportListSchema.parse(response.data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new VerraSchemaError('monitoring-reports', error.issues);
    }
    throw error;
  }

  const verified = filterVerifiedReports(parsed.reports, periodStart, periodEnd);
  if (verified.length === 0) {
    throw new VerraNoVerifiedReportsError(projectId, periodStart, periodEnd);
  }

  const carbonSequestered = verified.reduce(
    (sum, report) => sum + report.carbon_sequestered_kg,
    0,
  );

  return buildOracleReport({
    project_id: projectId,
    provider: 'VerraRegistry',
    methodology: project.methodologies[0] || METHODOLOGY.VERRA_VCS,
    period_start: periodStart,
    period_end: periodEnd,
    carbon_sequestered: carbonSequestered,
    confidence: 0.95,
    evidence: {
      verra_report_ids: verified.map((report) => report.report_id),
      credits_issued: verified.reduce((sum, report) => sum + report.credits_issued, 0),
    },
    raw_observations: {
      verra_report_ids: verified.map((report) => report.report_id),
      report_count: verified.length,
    },
    transformation_parameters: {
      status_filter: 'VERIFIED',
      methodologies: project.methodologies,
    },
  });
}

/**
 * Fetch and validate a single Verra project record.
 */
export async function fetchVerraProject(
  projectId: string,
  options: VerraAdapterOptions = {},
): Promise<VerraProject> {
  const baseUrl = (options.baseUrl || DEFAULT_REGISTRY_URL).replace(/\/$/, '');
  const http = options.http ?? createAxiosHttpClient(options.timeoutMs);

  const response = await http.get<unknown>(`${baseUrl}/projects/${projectId}`);
  if (response.status === 404) {
    throw new VerraNotFoundError(projectId);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new VerraAdapterError(
      `Verra registry returned status ${response.status} for project ${projectId}`,
    );
  }

  try {
    return VerraProjectSchema.parse(response.data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new VerraSchemaError(`project ${projectId}`, error.issues);
    }
    throw error;
  }
}

/**
 * True when at least one VERIFIED monitoring report exists for the project in
 * the given period.
 */
export async function verifyVerraReport(
  projectId: string,
  periodStart: string,
  periodEnd: string,
  options: VerraAdapterOptions = {},
): Promise<boolean> {
  const baseUrl = (options.baseUrl || DEFAULT_REGISTRY_URL).replace(/\/$/, '');
  const http = options.http ?? createAxiosHttpClient(options.timeoutMs);

  try {
    const response = await http.get<unknown>(
      `${baseUrl}/projects/${projectId}/monitoring-reports?verified=true&start=${periodStart}&end=${periodEnd}`,
    );
    const parsed = VerraReportListSchema.parse(response.data);
    return filterVerifiedReports(parsed.reports, periodStart, periodEnd).length > 0;
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new VerraSchemaError('monitoring-reports', error.issues);
    }
    return false;
  }
}
