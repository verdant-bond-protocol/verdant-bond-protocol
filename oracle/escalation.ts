import {
  AnomalyKind,
  CrossSourceAssessment,
  CrossSourceGroup,
  assessCrossSourceAnomaly,
} from './anomaly';

/**
 * Cross-oracle disagreement dashboard with operator escalation (#443).
 *
 * `anomaly.ts` already classifies a project-period as `normal`, `outlier`,
 * `conflicting_sources`, or `missing_source`. This module turns those raw
 * classifications into an operator-facing dashboard plus an escalation queue:
 *
 *   - `buildDisagreementDashboard` aggregates assessments into a stable
 *     summary so an operator can see, at a glance, which project-periods are
 *     in conflict and how serious each one is.
 *   - `EscalationQueue` promotes `warning`/`critical` disagreements into
 *     tickets with an assignment route, an SLA deadline, and a lifecycle
 *     (`open` → `acknowledged` → `resolved`). Tickets are deduplicated by
 *     project-period-kind so a nightly re-scan does not spawn duplicates.
 *
 * Only genuine disagreement is escalated: `normal` and `missing_source`
 * assessments never open a ticket (a single source cannot disagree with
 * itself), and `info`-severity outliers stay on the dashboard for context.
 */

export type EscalationSeverity = 'info' | 'warning' | 'critical';
export type EscalationStatus = 'open' | 'acknowledged' | 'resolved';

/** Assignment route that owns a disagreement, by severity. */
export const ESCALATION_ROUTE: Record<EscalationSeverity, string> = {
  info: 'disagreement-watch',
  warning: 'disagreement-review',
  critical: 'oracle-on-call',
};

/** Time-to-acknowledge SLA (ms) per severity. */
export const ESCALATION_SLA_MS: Record<EscalationSeverity, number> = {
  info: 7 * 24 * 60 * 60 * 1000,
  warning: 24 * 60 * 60 * 1000,
  critical: 60 * 60 * 1000,
};

export interface DisagreementDashboard {
  generatedAtMs: number;
  /** Every assessed project-period, disagreement or not. */
  entries: CrossSourceAssessment[];
  summary: {
    total: number;
    byKind: Record<AnomalyKind, number>;
    bySeverity: Record<EscalationSeverity, number>;
    /** Project-periods that warrant an operator ticket. */
    escalated: number;
  };
}

/** True when an assessment is a real dispute worth operator attention. */
export function isEscalatable(assessment: CrossSourceAssessment): boolean {
  return (
    (assessment.kind === 'outlier' || assessment.kind === 'conflicting_sources') &&
    (assessment.severity === 'warning' || assessment.severity === 'critical')
  );
}

function emptyKindCount(): Record<AnomalyKind, number> {
  return {
    normal: 0,
    outlier: 0,
    conflicting_sources: 0,
    missing_source: 0,
  };
}

/**
 * Aggregate cross-source groups into a dashboard: per-period assessments plus
 * a summary an operator UI can render directly.
 */
export function buildDisagreementDashboard(
  groups: CrossSourceGroup[],
  nowMs: number = Date.now(),
): DisagreementDashboard {
  const entries = groups.map(assessCrossSourceAnomaly);
  const byKind = emptyKindCount();
  const bySeverity: Record<EscalationSeverity, number> = {
    info: 0,
    warning: 0,
    critical: 0,
  };
  let escalated = 0;

  for (const entry of entries) {
    byKind[entry.kind] += 1;
    bySeverity[entry.severity] += 1;
    if (isEscalatable(entry)) escalated += 1;
  }

  return {
    generatedAtMs: nowMs,
    entries,
    summary: { total: entries.length, byKind, bySeverity, escalated },
  };
}

/** Convenience: build a dashboard directly from flat reports. */
export function buildDashboardFromReports(
  reports: Array<{
    projectId: string;
    periodStart: number;
    periodEnd: number;
    sourceId: string;
    methodology?: string | null;
    carbon: number;
  }>,
  nowMs: number = Date.now(),
): DisagreementDashboard {
  const grouped = new Map<string, CrossSourceGroup>();
  for (const report of reports) {
    const periodKey = `${report.periodStart}-${report.periodEnd}`;
    const key = `${report.projectId}::${periodKey}`;
    if (!grouped.has(key)) {
      grouped.set(key, { projectId: report.projectId, periodKey, values: [] });
    }
    grouped.get(key)!.values.push({
      sourceId: report.sourceId,
      methodology: report.methodology,
      carbon: report.carbon,
    });
  }
  return buildDisagreementDashboard([...grouped.values()], nowMs);
}

export interface EscalationTicket {
  id: string;
  projectId: string;
  periodKey: string;
  kind: AnomalyKind;
  severity: 'warning' | 'critical';
  reason: string;
  route: string;
  status: EscalationStatus;
  /** Operator the ticket is assigned to, once claimed. */
  assignee?: string;
  createdAtMs: number;
  dueAtMs: number;
  acknowledgedAtMs?: number;
  resolvedAtMs?: number;
  resolutionNote?: string;
}

/** Deterministic ticket id so repeated scans deduplicate the same dispute. */
export function escalationTicketId(assessment: CrossSourceAssessment): string {
  return `${assessment.projectId}::${assessment.periodKey}::${assessment.kind}`;
}

/**
 * Mutable queue of operator escalations. Kept as a class (rather than free
 * functions) so a long-running monitor can hold state between scans.
 */
export class EscalationQueue {
  private readonly tickets = new Map<string, EscalationTicket>();

  constructor(
    private readonly slaMs: Record<EscalationSeverity, number> = ESCALATION_SLA_MS,
  ) {}

  /** All tickets, oldest first. */
  list(): EscalationTicket[] {
    return [...this.tickets.values()].sort((a, b) => a.createdAtMs - b.createdAtMs);
  }

  /** Tickets still needing operator action. */
  open(): EscalationTicket[] {
    return this.list().filter((ticket) => ticket.status !== 'resolved');
  }

  get(id: string): EscalationTicket | undefined {
    return this.tickets.get(id);
  }

  /**
   * Promote escalatable assessments into tickets. Existing tickets for the
   * same dispute keep their lifecycle state; brand-new ones open as `open`.
   * Returns only the tickets created by this call.
   */
  sync(
    assessments: CrossSourceAssessment[],
    nowMs: number = Date.now(),
  ): EscalationTicket[] {
    const created: EscalationTicket[] = [];
    for (const assessment of assessments) {
      if (!isEscalatable(assessment)) continue;
      const id = escalationTicketId(assessment);
      if (this.tickets.has(id)) continue;
      const severity = assessment.severity as 'warning' | 'critical';
      const ticket: EscalationTicket = {
        id,
        projectId: assessment.projectId,
        periodKey: assessment.periodKey,
        kind: assessment.kind,
        severity,
        reason: assessment.reason,
        route: ESCALATION_ROUTE[severity],
        status: 'open',
        createdAtMs: nowMs,
        dueAtMs: nowMs + this.slaMs[severity],
      };
      this.tickets.set(id, ticket);
      created.push(ticket);
    }
    return created;
  }

  /** Assign an open ticket to an operator (first responder). */
  assign(id: string, operator: string): EscalationTicket {
    const ticket = this.require(id);
    if (ticket.status === 'resolved') {
      throw new Error(`Cannot assign resolved ticket ${id}`);
    }
    ticket.assignee = operator;
    return ticket;
  }

  /** Acknowledge a ticket, stopping its SLA clock. */
  acknowledge(id: string, operator?: string): EscalationTicket {
    const ticket = this.require(id);
    if (ticket.status === 'resolved') {
      throw new Error(`Cannot acknowledge resolved ticket ${id}`);
    }
    ticket.status = 'acknowledged';
    ticket.acknowledgedAtMs ??= Date.now();
    if (operator) ticket.assignee = operator;
    return ticket;
  }

  /** Resolve a ticket with a note explaining the operator's decision. */
  resolve(id: string, note: string): EscalationTicket {
    const ticket = this.require(id);
    if (!note.trim()) {
      throw new Error('A resolution note is required');
    }
    ticket.status = 'resolved';
    ticket.resolvedAtMs = Date.now();
    ticket.resolutionNote = note;
    return ticket;
  }

  /** Open tickets whose SLA has elapsed at `nowMs`. */
  overdue(nowMs: number = Date.now()): EscalationTicket[] {
    return this.open().filter((ticket) => ticket.dueAtMs <= nowMs);
  }

  private require(id: string): EscalationTicket {
    const ticket = this.tickets.get(id);
    if (!ticket) throw new Error(`Unknown escalation ticket: ${id}`);
    return ticket;
  }
}
