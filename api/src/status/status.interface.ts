/**
 * Public, schema-backed status feed (issue #303).
 *
 * Everything in this file is safe to expose to an unauthenticated caller.
 * No field here may carry a contract address, an internal error message, a
 * wallet address, or any other detail useful only to an operator — those
 * stay in the operator-facing surfaces this feed aggregates from (oracle
 * incidents, readiness probes), and are filtered out on the way in. See
 * `StatusService.toPublicIncident` and `toPublicComponent`.
 */

import type { RecordLifecycle } from '../common/lifecycle/record-lifecycle';

export const STATUS_SCHEMA_VERSION = 1 as const;

export type ComponentStatus = 'operational' | 'degraded' | 'down';
export type PublicIncidentStatus = 'investigating' | 'monitoring' | 'resolved';
/**
 * Schedule state only. There is no `cancelled` value: a window that was
 * withdrawn is *archived*, and archived windows are excluded from the feed
 * rather than published under a status every reader has to remember to
 * filter.
 */
export type MaintenanceWindowStatus = 'scheduled' | 'in_progress' | 'completed';
export type OverallStatus = 'healthy' | 'degraded' | 'incident' | 'maintenance';

export interface PublicComponent {
  name: string;
  status: ComponentStatus;
  description: string;
}

export interface PublicIncident {
  id: string;
  title: string;
  status: PublicIncidentStatus;
  startedAt: string;
  updatedAt: string;
}

export interface PublicMaintenanceWindow {
  id: string;
  title: string;
  status: MaintenanceWindowStatus;
  startsAt: string;
  endsAt: string;
}

export interface StatusReport {
  schemaVersion: typeof STATUS_SCHEMA_VERSION;
  generatedAt: string;
  overallStatus: OverallStatus;
  components: PublicComponent[];
  incidents: PublicIncident[];
  maintenanceWindows: PublicMaintenanceWindow[];
}

/** Internal, admin-only maintenance window record (has audit fields the public shape omits). */
export interface MaintenanceWindowRecord {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  createdBy: string;
  createdAt: string;
  /**
   * Archive/restore state. This — not a `cancelledAt` timestamp or a
   * `cancelled` status — is what withdraws a window from the public feed, and
   * it records who withdrew it, when, and why.
   */
  lifecycle: RecordLifecycle;
}

export class StatusError extends Error {
  constructor(
    message: string,
    public readonly code: 'not_found' | 'invalid_window',
  ) {
    super(message);
    this.name = 'StatusError';
  }
}
