/**
 * Public, schema-backed status feed (issues #303 & #370).
 *
 * Everything in this file is safe to expose to an unauthenticated caller.
 * No field here may carry a contract address, an internal error message, a
 * wallet address, or any other detail useful only to an operator.
 * All outputs undergo deep recursive secret redaction.
 */

import type { RecordLifecycle } from '../common/lifecycle/record-lifecycle';

export const STATUS_SCHEMA_VERSION = 1 as const;

export type ComponentStatus = 'operational' | 'degraded' | 'paused' | 'maintenance' | 'down';
export type PublicIncidentStatus = 'investigating' | 'monitoring' | 'resolved';

/**
 * Schedule state only. There is no `cancelled` value: a window that was
 * withdrawn is *archived*, and archived windows are excluded from the feed
 * rather than published under a status every reader has to remember to filter.
 */
export type MaintenanceWindowStatus = 'scheduled' | 'in_progress' | 'completed';
export type OverallStatus = 'healthy' | 'degraded' | 'paused' | 'incident' | 'maintenance';

export interface PublicComponent {
  name: string;
  status: ComponentStatus;
  description: string;
  isMutationAllowed?: boolean;
  publicNotice?: string;
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
  isMutationAllowed?: boolean;
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
  readonly code:
    | 'not_found'
    | 'invalid_window'
    | 'protocol_paused'
    | 'protocol_maintenance'
    | 'secret_leak_prevented';

  constructor(
    message: string,
    code:
      | 'not_found'
      | 'invalid_window'
      | 'protocol_paused'
      | 'protocol_maintenance'
      | 'secret_leak_prevented',
  ) {
    super(message);
    this.name = 'StatusError';
    this.code = code;
  }
}
