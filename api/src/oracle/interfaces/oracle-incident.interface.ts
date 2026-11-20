/**
 * Durable oracle incident model (issue #95).
 *
 * Replaces the previous log-only / Redis-rearm alerting in
 * `OracleMonitoringService` with a persisted incident lifecycle so operators
 * have a source of truth for degraded oracle coverage instead of scattered
 * WARN log lines.
 */

export enum OracleIncidentStatus {
  Active = 'active',
  Acknowledged = 'acknowledged',
  Resolved = 'resolved',
}

export enum OracleIncidentSeverity {
  Warning = 'warning',
  Critical = 'critical',
}

export enum OracleIncidentSubjectType {
  Project = 'project',
  Provider = 'provider',
}

/**
 * Point-in-time staleness context captured when an incident is created or
 * updated, for audit/debugging. Intentionally the same shape the staleness
 * report already exposes via `GET /oracle/monitoring/staleness`, so an
 * incident's `details` is self-explanatory next to that endpoint.
 */
export interface OracleIncidentDetails {
  lastVerifiedAt?: string;
  expectedNextReportAt?: string;
  stalenessSeconds?: number;
  projectIds?: string[];
}

export interface OracleIncident {
  id: string;
  dedupeKey: string;
  subjectType: OracleIncidentSubjectType;
  subjectId: string;
  status: OracleIncidentStatus;
  severity: OracleIncidentSeverity;
  occurrenceCount: number;
  firstDetectedAt: string;
  lastDetectedAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  details: OracleIncidentDetails | null;
  createdAt: string;
  updatedAt: string;
}

/** Input for recording one detection of a stale condition during a monitoring cycle. */
export interface IncidentDetectionInput {
  subjectType: OracleIncidentSubjectType;
  subjectId: string;
  detectedAt: string;
  details: OracleIncidentDetails;
}

export interface IncidentDetectionResult {
  incident: OracleIncident;
  /** True if this detection created a new incident row (first occurrence or a recurrence after resolution). */
  isNew: boolean;
  /** True if this detection pushed the incident's severity to a higher tier. */
  escalated: boolean;
}

export interface OracleIncidentSyncSummary {
  created: number;
  updated: number;
  escalated: number;
}
