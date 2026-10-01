import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RedisService } from '../common/services/redis.service';
import {
  activeLifecycle,
  archiveRecord,
  includeArchived,
  restoreRecord,
  visibleOnly,
} from '../common/lifecycle/record-lifecycle';
import { OracleIncidentRepository } from '../oracle/oracle-incident.repository';
import { OracleIncident, OracleIncidentStatus } from '../oracle/interfaces/oracle-incident.interface';
import {
  MaintenanceWindowRecord,
  MaintenanceWindowStatus,
  PublicComponent,
  PublicIncident,
  PublicMaintenanceWindow,
  STATUS_SCHEMA_VERSION,
  StatusError,
  StatusReport,
} from './status.interface';

@Injectable()
export class StatusService {
  private readonly logger = new Logger(StatusService.name);
  private readonly maintenanceWindows = new Map<string, MaintenanceWindowRecord>();

  constructor(
    private readonly redis: RedisService,
    private readonly oracleIncidents: OracleIncidentRepository,
  ) {}

  // ── Admin surface (maintenance windows) ──────────────────────────────────

  scheduleMaintenance(title: string, startsAt: string, endsAt: string, createdBy: string, now: number = Date.now()): MaintenanceWindowRecord {
    const starts = Date.parse(startsAt);
    const ends = Date.parse(endsAt);
    if (!Number.isFinite(starts) || !Number.isFinite(ends) || ends <= starts) {
      throw new StatusError('endsAt must be a valid timestamp after startsAt', 'invalid_window');
    }
    const record: MaintenanceWindowRecord = {
      id: randomUUID(),
      title,
      startsAt,
      endsAt,
      createdBy,
      createdAt: new Date(now).toISOString(),
      lifecycle: activeLifecycle(),
    };
    this.maintenanceWindows.set(record.id, record);
    return record;
  }

  /**
   * Withdraw a scheduled window by archiving it. The reason is mandatory: a
   * maintenance notice that disappears without an explanation is the exact
   * case the status page exists to prevent.
   */
  archiveMaintenance(id: string, actor: string, reason: string, now: number = Date.now()): MaintenanceWindowRecord {
    const record = this.maintenanceWindows.get(id);
    if (!record) throw new StatusError(`no maintenance window with id "${id}"`, 'not_found');
    archiveRecord(record.lifecycle, { actor, reason, now });
    this.logger.log(`maintenance window archived: ${id}`, { actor, reason });
    return record;
  }

  /** Re-publish a previously withdrawn window. The archive stays in its history. */
  restoreMaintenance(id: string, actor: string, now: number = Date.now()): MaintenanceWindowRecord {
    const record = this.maintenanceWindows.get(id);
    if (!record) throw new StatusError(`no maintenance window with id "${id}"`, 'not_found');
    restoreRecord(record.lifecycle, { actor, now });
    this.logger.log(`maintenance window restored: ${id}`, { actor });
    return record;
  }

  /**
   * Windows for the admin surface. Archived windows are omitted by default so
   * the admin listing and the public feed agree on what is live; pass
   * `includeArchived` to audit what was withdrawn.
   */
  listMaintenance(
    opts: { includeArchived?: boolean; now?: number } = {},
  ): Array<MaintenanceWindowRecord & { status: MaintenanceWindowStatus }> {
    const now = opts.now ?? Date.now();
    return includeArchived([...this.maintenanceWindows.values()], opts.includeArchived === true).map((record) => ({
      ...record,
      status: this.maintenanceStatus(record, now),
    }));
  }

  /** A window's status is derived from `now` against its schedule. */
  private maintenanceStatus(record: MaintenanceWindowRecord, now: number): MaintenanceWindowStatus {
    if (now < Date.parse(record.startsAt)) return 'scheduled';
    if (now < Date.parse(record.endsAt)) return 'in_progress';
    return 'completed';
  }

  // ── Public feed ───────────────────────────────────────────────────────────

  /**
   * Strips an `OracleIncident` (an operator-facing record that may carry
   * subject ids, acknowledger/resolver wallet addresses, and free-text
   * resolution notes) down to the minimum a public status page needs.
   */
  private toPublicIncident(incident: OracleIncident): PublicIncident {
    const status: PublicIncident['status'] =
      incident.status === OracleIncidentStatus.Resolved
        ? 'resolved'
        : incident.status === OracleIncidentStatus.Acknowledged
          ? 'monitoring'
          : 'investigating';
    return {
      id: incident.id,
      title: 'Oracle data coverage incident',
      status,
      startedAt: incident.firstDetectedAt,
      updatedAt: incident.updatedAt,
    };
  }

  private toPublicMaintenanceWindow(record: MaintenanceWindowRecord, now: number): PublicMaintenanceWindow {
    return {
      id: record.id,
      title: record.title,
      status: this.maintenanceStatus(record, now),
      startsAt: record.startsAt,
      endsAt: record.endsAt,
    };
  }

  /**
   * Aggregate current component health, active incidents, and maintenance
   * windows into the public, schema-backed feed (issue #303). Never throws
   * for a degraded dependency — a component that cannot be reached is
   * reported as `down` in the feed itself, which is the whole point of a
   * status page.
   */
  async getPublicStatus(now: number = Date.now()): Promise<StatusReport> {
    const components: PublicComponent[] = [
      {
        name: 'cache',
        status: this.redis.isHealthy() ? 'operational' : 'down',
        description: 'Shared cache backing list and detail reads.',
      },
    ];

    let incidents: PublicIncident[] = [];
    try {
      const active = await this.oracleIncidents.findMany(1, 50, OracleIncidentStatus.Active);
      const acknowledged = await this.oracleIncidents.findMany(1, 50, OracleIncidentStatus.Acknowledged);
      incidents = [...active.data, ...acknowledged.data].map((incident) => this.toPublicIncident(incident));
    } catch (error) {
      // The incident store itself being unreachable is, itself, degraded
      // service — surfaced as a component rather than failing the whole feed.
      this.logger.warn(`Could not read oracle incidents for the status feed: ${error instanceof Error ? error.message : String(error)}`);
      components.push({ name: 'oracle-monitoring', status: 'down', description: 'Oracle coverage incident tracking.' });
    }

    const maintenanceWindows = visibleOnly([...this.maintenanceWindows.values()]).map((record) =>
      this.toPublicMaintenanceWindow(record, now),
    );

    const overallStatus: StatusReport['overallStatus'] =
      incidents.some((incident) => incident.status !== 'resolved')
        ? 'incident'
        : maintenanceWindows.some((window) => window.status === 'in_progress')
          ? 'maintenance'
          : components.some((component) => component.status !== 'operational')
            ? 'degraded'
            : 'healthy';

    return {
      schemaVersion: STATUS_SCHEMA_VERSION,
      generatedAt: new Date(now).toISOString(),
      overallStatus,
      components,
      incidents,
      maintenanceWindows,
    };
  }
}
