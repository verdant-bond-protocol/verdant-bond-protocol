import { Injectable, Logger, ForbiddenException } from '@nestjs/common';
import {
  ExportableRecord,
  ExportCaller,
  ExportRole,
  ExportType,
} from '../interfaces/export.interface';

export type FieldAction = 'STRIP' | 'REDACT' | 'ALLOW';

export interface FieldAuthorizationPolicy {
  role: ExportRole;
  exportType?: ExportType;
  action: FieldAction;
  fields: string[];
  organizationId?: string;
}

export interface FieldAuthorizationAudit {
  recordId: string;
  timestamp: string;
  callerUserId: string;
  callerRole: ExportRole;
  exportType: ExportType;
  organizationId?: string;
  fieldsStripped: string[];
  fieldsRedacted: string[];
  fieldsAllowed: string[];
}

interface ResolvedAction {
  action: FieldAction;
  redactedValue?: string;
}

const PROTOTYPE_KEY = '__proto__';
const SSN_PATTERN = /^\d{3}-\d{2}-\d{4}$/;
const DEFAULT_AUDIT_LOG_CAP = 10_000;

@Injectable()
export class FieldAuthorizationService {
  private readonly logger = new Logger(FieldAuthorizationService.name);
  private readonly policies: FieldAuthorizationPolicy[] = [];
  private readonly auditLog: FieldAuthorizationAudit[] = [];
  private readonly auditLogCap: number;

  constructor(auditLogCap: number = DEFAULT_AUDIT_LOG_CAP) {
    this.auditLogCap = auditLogCap;
  }

  registerPolicy(policy: FieldAuthorizationPolicy): void {
    this.policies.push({
      ...policy,
      fields: policy.fields.map((f) => f.toLowerCase()),
    });
    this.logger.log(
      `Registered field authorization policy: role=${policy.role} type=${policy.exportType ?? '*'} action=${policy.action} fields=[${policy.fields.join(',')}] org=${policy.organizationId ?? '*'}`,
    );
  }

  registerPolicies(policies: FieldAuthorizationPolicy[]): void {
    for (const policy of policies) {
      this.registerPolicy(policy);
    }
  }

  evaluateField(
    fieldName: string,
    caller: ExportCaller,
    exportType: ExportType,
    fieldValue?: unknown,
  ): ResolvedAction {
    const key = fieldName.toLowerCase();

    if (key === PROTOTYPE_KEY) {
      return { action: 'STRIP' };
    }

    // Gather matching policies in priority order:
    // 1. org + exportType specific
    // 2. org + role-wide (no exportType)
    // 3. global + exportType specific
    // 4. global + role-wide (no exportType)
    let bestMatch: FieldAuthorizationPolicy | undefined;
    let bestSpecificity = -1;

    for (const policy of this.policies) {
      if (policy.role !== caller.role) continue;
      if (!policy.fields.includes(key)) continue;

      let specificity = 0;
      const orgMatch =
        policy.organizationId !== undefined &&
        caller.organizationId !== undefined &&
        policy.organizationId === caller.organizationId;
      const orgWild = policy.organizationId === undefined;
      if (!orgMatch && !orgWild) continue;

      if (orgMatch) specificity += 2;
      if (policy.exportType === exportType) specificity += 1;
      else if (policy.exportType !== undefined) continue;

      if (specificity > bestSpecificity) {
        bestSpecificity = specificity;
        bestMatch = policy;
      }
    }

    if (!bestMatch) {
      return { action: 'ALLOW' };
    }

    if (bestMatch.action === 'REDACT') {
      return { action: 'REDACT', redactedValue: this.redactValue(fieldValue) };
    }

    return { action: bestMatch.action };
  }

  sanitizeRecord(
    record: ExportableRecord,
    caller: ExportCaller,
    exportType: ExportType,
  ): { record: ExportableRecord; audit: FieldAuthorizationAudit } {
    if (caller.role === ExportRole.INVESTOR && record.ownerUserId !== caller.userId) {
      throw new ForbiddenException('Cannot access records outside your caller ownership scope');
    }

    const audit: FieldAuthorizationAudit = {
      recordId: record.id,
      timestamp: new Date().toISOString(),
      callerUserId: caller.userId,
      callerRole: caller.role,
      exportType,
      organizationId: caller.organizationId,
      fieldsStripped: [],
      fieldsRedacted: [],
      fieldsAllowed: [],
    };

    const sanitizedData = this.processValue(record.data, caller, exportType, audit) as Record<string, any>;

    this.appendAudit(audit);

    return {
      record: { ...record, data: sanitizedData },
      audit,
    };
  }

  getAuditLog(): FieldAuthorizationAudit[] {
    return [...this.auditLog];
  }

  clearAuditLog(): void {
    this.auditLog.length = 0;
  }

  clearPolicies(): void {
    this.policies.length = 0;
  }

  private processValue(
    value: unknown,
    caller: ExportCaller,
    exportType: ExportType,
    audit: FieldAuthorizationAudit,
  ): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.processValue(item, caller, exportType, audit));
    }
    if (value === null || typeof value !== 'object' || value instanceof Date) {
      return value;
    }

    const cleaned: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === PROTOTYPE_KEY) {
        audit.fieldsStripped.push(key);
        continue;
      }

      const resolved = this.evaluateField(key, caller, exportType, child);

      switch (resolved.action) {
        case 'STRIP':
          audit.fieldsStripped.push(key);
          break;
        case 'REDACT':
          audit.fieldsRedacted.push(key);
          cleaned[key] = resolved.redactedValue;
          break;
        case 'ALLOW':
          audit.fieldsAllowed.push(key);
          cleaned[key] = this.processValue(child, caller, exportType, audit);
          break;
      }
    }
    return cleaned;
  }

  private redactValue(value: unknown): string {
    if (typeof value === 'string' && SSN_PATTERN.test(value)) {
      return `***-**-${value.slice(-4)}`;
    }
    return '[REDACTED]';
  }

  private appendAudit(audit: FieldAuthorizationAudit): void {
    if (this.auditLog.length >= this.auditLogCap) {
      this.auditLog.shift();
    }
    this.auditLog.push(audit);
  }
}
