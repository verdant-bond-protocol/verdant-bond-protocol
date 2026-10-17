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
  ComponentStatus,
  MaintenanceWindowRecord,
  MaintenanceWindowStatus,
  PublicComponent,
  PublicIncident,
  PublicMaintenanceWindow,
  StatusError,
  StatusReport,
} from './status.interface';
import {
  StatusSafeguardsManager,
  redactSecretsFromText,
  redactSecretsDeep,
} from './status-safeguards';

export { redactSecretsFromText, redactSecretsDeep };

@Injectable()
export class StatusService {
  private readonly logger = new Logger(StatusService.name);
  private readonly maintenanceWindows = new Map<string, MaintenanceWindowRecord>();
  private readonly safeguards = new StatusSafeguardsManager();
  private readonly redis: RedisService;
  private readonly oracleIncidents: OracleIncidentRepository;

  constructor(
    redis: RedisService,
    oracleIncidents: OracleIncidentRepository,
  ) {
    this.redis = redis;
    this.oracleIncidents = oracleIncidents;
  }

  // ── Protocol Pause & Resume ────────────────────────────────────────────────

  pauseProtocol(reason: string, actor: string): void {
    this.safeguards.pauseProtocol(reason, actor);
    this.logger.warn(`Protocol paused by ${actor}: ${reason}`);
  }

  resumeProtocol(actor: string): void {
    this.safeguards.resumeProtocol(actor);
    this.logger.log(`Protocol resumed by ${actor}`);
  }

  isProtocolPaused(): boolean {
    return this.safeguards.isProtocolPaused();
  }

  // ── Component Overrides ────────────────────────────────────────────────────

  setComponentStatus(name: string, status: ComponentStatus, notice?: string, actor = 'admin'): void {
    this.safeguards.setComponentStatus(name, status, notice, actor);
    this.logger.log(`Component "${name}" status set to "${status}" by ${actor}`);
  }

  clearComponentOverride(name: string): void {
    this.safeguards.clearComponentOverride(name);
  }

  // ── Mutation Safeguards ────────────────────────────────────────────────────

  isMutationAllowed(componentName?: string): boolean {
    return this.safeguards.isMutationAllowed(componentName);
  }

  assertMutationAllowed(componentName?: string): void {
    this.safeguards.assertMutationAllowed(componentName);
  }

  // ── Admin surface (maintenance windows) ──────────────────────────────────

  scheduleMaintenance(title: string, startsAt: string, endsAt: string, createdBy: string, now: number = Date.now()): MaintenanceWindowRecord {
    const starts = Date.parse(startsAt);
    const ends = Date.parse(endsAt);
    if (!Number.isFinite(starts) || !Number.isFinite(ends) || ends <= starts) {
      throw new StatusError('endsAt must be a valid timestamp after startsAt', 'invalid_window');
    }
    const sanitizedTitle = redactSecretsFromText(title);
    const record: MaintenanceWindowRecord = {
      id: randomUUID(),
      title: sanitizedTitle,
      startsAt,
      endsAt,
      createdBy,
      createdAt: new Date(now).toISOString(),
      lifecycle: activeLifecycle(),
    };
    this.maintenanceWindows.set(record.id, record);
    return record;
  }

  archiveMaintenance(id: string, actor: string, reason: string, now: number = Date.now()): MaintenanceWindowRecord {
    const record = this.maintenanceWindows.get(id);
    if (!record) throw new StatusError(`no maintenance window with id "${id}"`, 'not_found');
    const sanitizedReason = redactSecretsFromText(reason);
    archiveRecord(record.lifecycle, { actor, reason: sanitizedReason, now });
    this.logger.log(`maintenance window archived: ${id}`, { actor, reason: sanitizedReason });
    return record;
  }

  restoreMaintenance(id: string, actor: string, now: number = Date.now()): MaintenanceWindowRecord {
    const record = this.maintenanceWindows.get(id);
    if (!record) throw new StatusError(`no maintenance window with id "${id}"`, 'not_found');
    restoreRecord(record.lifecycle, { actor, now });
    this.logger.log(`maintenance window restored: ${id}`, { actor });
    return record;
  }

  listMaintenance(
    opts: { includeArchived?: boolean; now?: number } = {},
  ): Array<MaintenanceWindowRecord & { status: MaintenanceWindowStatus }> {
    const now = opts.now ?? Date.now();
    return includeArchived([...this.maintenanceWindows.values()], opts.includeArchived === true).map((record) => ({
      ...record,
      status: this.maintenanceStatus(record, now),
    }));
  }

  private maintenanceStatus(record: MaintenanceWindowRecord, now: number): MaintenanceWindowStatus {
    if (now < Date.parse(record.startsAt)) return 'scheduled';
    if (now < Date.parse(record.endsAt)) return 'in_progress';
    return 'completed';
  }

  // ── Public feed ───────────────────────────────────────────────────────────

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

  async getPublicStatus(now: number = Date.now()): Promise<StatusReport> {
    const baseComponents: PublicComponent[] = [
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
      this.logger.warn(`Could not read oracle incidents for status feed: ${error instanceof Error ? error.message : String(error)}`);
      baseComponents.push({
        name: 'oracle-monitoring',
        status: 'down',
        description: 'Oracle coverage incident tracking.',
      });
    }

    const maintenanceWindows = visibleOnly([...this.maintenanceWindows.values()]).map((record) =>
      this.toPublicMaintenanceWindow(record, now),
    );

    return this.safeguards.buildPublicReport({
      now,
      baseComponents,
      incidents,
      maintenanceWindows,
    });
  }
}
