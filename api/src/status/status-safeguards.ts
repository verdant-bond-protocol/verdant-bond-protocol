/**
 * Safe Public-Status Model and Mutation Safeguards Engine.
 *
 * Implements:
 * 1. Deep recursive secret redaction (Stellar seeds, DB URIs, JWTs, IPs, internal paths).
 * 2. Degradation, pause, and maintenance state machine.
 * 3. Mutation safeguards preventing state changes when paused or in maintenance.
 *
 * Resolves Issue #370.
 */

import type {
  ComponentStatus,
  MaintenanceWindowRecord,
  MaintenanceWindowStatus,
  OverallStatus,
  PublicComponent,
  PublicIncident,
  PublicMaintenanceWindow,
  StatusReport,
} from './status.interface.ts';
import { STATUS_SCHEMA_VERSION, StatusError } from './status.interface.ts';

export function redactSecretsFromText(text: string): string {
  if (!text) return text;
  return text
    // Stellar Secret seeds (S + 55 alphanumeric uppercase characters)
    .replace(/\bS[A-Z0-9]{55}\b/g, '[REDACTED_STELLAR_SECRET]')
    // DB connection strings (postgres, mongodb, redis, mysql)
    .replace(/(?:postgres|postgresql|mongodb|redis|mysql):\/\/[^:\s]+:[^@\s]+@[^\s]+/gi, '[REDACTED_DB_URI]')
    // JWT tokens
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]')
    // Bearer tokens
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED_TOKEN]')
    // IPv4 addresses (private & loopback subnets)
    .replace(/\b(?:10|127|172\.(?:1[6-9]|2[0-9]|3[01])|192\.168)\.\d{1,3}\.\d{1,3}(?::\d+)?\b/g, '[REDACTED_IP]')
    // Stack traces and absolute filesystem paths
    .replace(/(?:[a-zA-Z]:|\/)(?:[a-zA-Z0-9_.-]+[\\/])+[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]{2,4}/g, '[REDACTED_PATH]');
}

export function redactSecretsDeep<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    return redactSecretsFromText(obj) as unknown as T;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => redactSecretsDeep(item)) as unknown as T;
  }
  if (typeof obj === 'object') {
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      if (/password|passwd|secret|token|seed|private_?key|credential/i.test(key)) {
        result[key] = '[REDACTED_SENSITIVE_FIELD]';
      } else {
        result[key] = redactSecretsDeep(value);
      }
    }
    return result as T;
  }
  return obj;
}

export interface ComponentStateOverride {
  status: ComponentStatus;
  notice?: string;
  updatedAt: string;
  updatedBy: string;
}

export class StatusSafeguardsManager {
  private readonly componentOverrides = new Map<string, ComponentStateOverride>();
  private protocolPaused: { paused: boolean; reason?: string; actor?: string; since?: string } = {
    paused: false,
  };

  // ── Protocol Pause Controls ────────────────────────────────────────────────

  pauseProtocol(reason: string, actor: string): void {
    const sanitizedReason = redactSecretsFromText(reason);
    this.protocolPaused = {
      paused: true,
      reason: sanitizedReason,
      actor,
      since: new Date().toISOString(),
    };
  }

  resumeProtocol(actor?: string): void {
    this.protocolPaused = { paused: false };
  }

  isProtocolPaused(): boolean {
    return this.protocolPaused.paused;
  }

  getProtocolPauseReason(): string | undefined {
    return this.protocolPaused.reason;
  }

  // ── Component Overrides ────────────────────────────────────────────────────

  setComponentStatus(name: string, status: ComponentStatus, notice?: string, actor = 'admin'): void {
    const sanitizedNotice = notice ? redactSecretsFromText(notice) : undefined;
    this.componentOverrides.set(name, {
      status,
      notice: sanitizedNotice,
      updatedAt: new Date().toISOString(),
      updatedBy: actor,
    });
  }

  getComponentOverride(name: string): ComponentStateOverride | undefined {
    return this.componentOverrides.get(name);
  }

  clearComponentOverride(name: string): void {
    this.componentOverrides.delete(name);
  }

  getAllComponentOverrides(): Map<string, ComponentStateOverride> {
    return this.componentOverrides;
  }

  // ── Mutation Gate Safeguards ───────────────────────────────────────────────

  /**
   * Assesses if state mutations (issuance, trades, claims, overrides) are allowed.
   */
  isMutationAllowed(componentName?: string): boolean {
    if (this.protocolPaused.paused) {
      return false;
    }

    if (componentName) {
      const override = this.componentOverrides.get(componentName);
      if (override && (override.status === 'paused' || override.status === 'down' || override.status === 'maintenance')) {
        return false;
      }
    }

    return true;
  }

  /**
   * Asserts mutation eligibility. Throws safe StatusError if degraded or paused.
   */
  assertMutationAllowed(componentName?: string): void {
    if (this.protocolPaused.paused) {
      throw new StatusError(
        this.protocolPaused.reason || 'Protocol state mutations are temporarily paused by operators.',
        'protocol_paused',
      );
    }

    if (componentName) {
      const override = this.componentOverrides.get(componentName);
      if (override) {
        if (override.status === 'paused') {
          throw new StatusError(
            `Component "${componentName}" is temporarily paused: ${override.notice || 'Operations paused'}`,
            'protocol_paused',
          );
        }
        if (override.status === 'maintenance') {
          throw new StatusError(
            `Component "${componentName}" is currently undergoing scheduled maintenance.`,
            'protocol_maintenance',
          );
        }
        if (override.status === 'down') {
          throw new StatusError(
            `Component "${componentName}" is currently offline and unable to process mutations.`,
            'protocol_paused',
          );
        }
      }
    }
  }

  // ── Status Aggregation ────────────────────────────────────────────────────

  buildPublicReport(opts: {
    now: number;
    baseComponents: PublicComponent[];
    incidents: PublicIncident[];
    maintenanceWindows: PublicMaintenanceWindow[];
  }): StatusReport {
    const components: PublicComponent[] = [...opts.baseComponents];

    // Apply component overrides
    for (const comp of components) {
      const override = this.componentOverrides.get(comp.name);
      if (override) {
        comp.status = override.status;
        if (override.notice) comp.publicNotice = override.notice;
        comp.isMutationAllowed = override.status === 'operational';
      }
    }

    // Include any additional registered protocol subsystems
    for (const [name, override] of this.componentOverrides.entries()) {
      if (!components.some((c) => c.name === name)) {
        components.push({
          name,
          status: override.status,
          description: `Protocol subsystem: ${name}.`,
          isMutationAllowed: override.status === 'operational',
          publicNotice: override.notice,
        });
      }
    }

    // Determine Overall Status
    let overallStatus: OverallStatus = 'healthy';
    if (this.protocolPaused.paused) {
      overallStatus = 'paused';
    } else if (opts.incidents.some((incident) => incident.status !== 'resolved')) {
      overallStatus = 'incident';
    } else if (opts.maintenanceWindows.some((window) => window.status === 'in_progress')) {
      overallStatus = 'maintenance';
    } else if (components.some((c) => c.status === 'paused')) {
      overallStatus = 'paused';
    } else if (components.some((c) => c.status !== 'operational')) {
      overallStatus = 'degraded';
    }

    const report: StatusReport = {
      schemaVersion: STATUS_SCHEMA_VERSION,
      generatedAt: new Date(opts.now).toISOString(),
      overallStatus,
      isMutationAllowed: this.isMutationAllowed(),
      components,
      incidents: opts.incidents,
      maintenanceWindows: opts.maintenanceWindows,
    };

    return redactSecretsDeep(report);
  }
}
