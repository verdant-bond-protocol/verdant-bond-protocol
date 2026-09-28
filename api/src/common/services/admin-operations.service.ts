import { createHash } from 'crypto';

export interface SignedAdminApproval {
  action: string;
  actor: string;
  reason: string;
  expiresAt: string;
  nonce: string;
  signature: string;
}

export interface FreezeWindow {
  id: string;
  scope: string;
  startsAt: string;
  endsAt: string;
  reason: string;
  emergencyBypassActors?: string[];
}

export interface OperationEvent {
  actor: string;
  resource: string;
  action: string;
  at: string;
  success: boolean;
  volume?: number;
}

export interface AnomalyFinding {
  severity: 'low' | 'medium' | 'high';
  resource: string;
  signal: 'volume_spike' | 'repeated_failure' | 'suspicious_actor';
  message: string;
}

export class AdminOperationsService {
  private readonly usedNonces = new Set<string>();

  signablePayload(approval: Omit<SignedAdminApproval, 'signature'>): string {
    return JSON.stringify({
      action: approval.action,
      actor: approval.actor,
      reason: approval.reason,
      expiresAt: approval.expiresAt,
      nonce: approval.nonce,
    });
  }

  expectedSignature(approval: Omit<SignedAdminApproval, 'signature'>, secret: string): string {
    return createHash('sha256').update(`${this.signablePayload(approval)}:${secret}`).digest('hex');
  }

  verifyApproval(approval: SignedAdminApproval, action: string, actor: string, now: Date, secret: string): void {
    if (approval.action !== action) throw new Error('approval action mismatch');
    if (approval.actor !== actor) throw new Error('approval actor mismatch');
    if (Date.parse(approval.expiresAt) <= now.getTime()) throw new Error('approval expired');
    if (this.usedNonces.has(approval.nonce)) throw new Error('approval replay detected');
    const { signature, ...payload } = approval;
    if (signature !== this.expectedSignature(payload, secret)) throw new Error('approval signature invalid');
    this.usedNonces.add(approval.nonce);
  }

  assertNotFrozen(action: string, windows: FreezeWindow[], now: Date, actor: string, emergency = false): void {
    const active = windows.find((window) =>
      (window.scope === '*' || window.scope === action) &&
      Date.parse(window.startsAt) <= now.getTime() &&
      Date.parse(window.endsAt) > now.getTime(),
    );
    if (!active) return;
    if (emergency && active.emergencyBypassActors?.includes(actor)) return;
    throw new Error(`Action ${action} is frozen by ${active.id}: ${active.reason}`);
  }

  anomalyReport(events: OperationEvent[]): AnomalyFinding[] {
    const findings: AnomalyFinding[] = [];
    const byResource = this.groupBy(events, (event) => event.resource);
    for (const [resource, resourceEvents] of byResource) {
      const volume = resourceEvents.reduce((sum, event) => sum + (event.volume || 1), 0);
      if (volume >= 1000) {
        findings.push({
          severity: 'high',
          resource,
          signal: 'volume_spike',
          message: `Resource ${resource} has unusually high volume (${volume}).`,
        });
      }
    }

    const byActor = this.groupBy(events, (event) => event.actor);
    for (const [actor, actorEvents] of byActor) {
      const failures = actorEvents.filter((event) => !event.success);
      if (failures.length >= 3) {
        findings.push({
          severity: 'medium',
          resource: actor,
          signal: 'repeated_failure',
          message: `Actor ${actor} has ${failures.length} failed operations.`,
        });
      }
      const distinctResources = new Set(actorEvents.map((event) => event.resource));
      if (distinctResources.size >= 5) {
        findings.push({
          severity: 'low',
          resource: actor,
          signal: 'suspicious_actor',
          message: `Actor ${actor} touched ${distinctResources.size} resources in the sample.`,
        });
      }
    }

    return findings.sort((a, b) => this.rank(b.severity) - this.rank(a.severity));
  }

  private groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
    const grouped = new Map<string, T[]>();
    for (const item of items) {
      const group = key(item);
      grouped.set(group, [...(grouped.get(group) || []), item]);
    }
    return grouped;
  }

  private rank(severity: AnomalyFinding['severity']): number {
    return { low: 1, medium: 2, high: 3 }[severity];
  }
}
