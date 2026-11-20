export type RiskBucket = 'unknown' | 'low' | 'medium' | 'high';
export type Visibility = 'public' | 'maintainer';

export interface CounterpartyRiskInput {
  counterpartyId: string;
  kycVerified?: boolean;
  covenantBreaches?: number;
  rejectedSettlements?: number;
  lateReports?: number;
  manualOverride?: RiskBucket;
  overrideReason?: string;
}

export interface RiskAssessment {
  counterpartyId: string;
  bucket: RiskBucket;
  score: number | null;
  userSummary: {
    bucket: RiskBucket;
    visibility: 'public';
    message: string;
  };
  maintainerDetail: {
    visibility: 'maintainer';
    signals: Record<string, number | boolean | string | undefined>;
    reason: string;
  };
}

export type DisputeState = 'open' | 'investigating' | 'resolved' | 'rejected';
export type EvidenceVisibility = 'public' | 'private';

export interface EvidenceItem {
  id: string;
  uri: string;
  visibility: EvidenceVisibility;
  description: string;
}

export interface SettlementDispute {
  id: string;
  settlementId: string;
  openedBy: string;
  state: DisputeState;
  evidence: EvidenceItem[];
  publicNotes: string[];
  privateNotes: string[];
  audit: AuditRecord[];
}

export interface AuditRecord {
  actor: string;
  action: string;
  reason: string;
  at: string;
}

export type CovenantState =
  | 'clear'
  | 'detected'
  | 'investigating'
  | 'remediation_accepted'
  | 'remediation_rejected'
  | 'resolved';

export interface CovenantInput {
  bondId: string;
  reportsLateByDays?: number;
  sustainabilityMetricValid?: boolean;
  repaymentDaysPastDue?: number;
  issuerRemediationSubmitted?: boolean;
}

export interface CovenantBreachRecord {
  bondId: string;
  state: CovenantState;
  severity: 'none' | 'low' | 'medium' | 'high';
  detectedReasons: string[];
  investorStatus: {
    state: CovenantState;
    severity: 'none' | 'low' | 'medium' | 'high';
    nextStep: string;
  };
  audit: AuditRecord[];
}

const DISPUTE_TRANSITIONS: Record<DisputeState, DisputeState[]> = {
  open: ['investigating', 'rejected', 'resolved'],
  investigating: ['resolved', 'rejected'],
  resolved: ['investigating'],
  rejected: ['investigating'],
};

export class CounterpartyRiskService {
  assess(input: CounterpartyRiskInput): RiskAssessment {
    if (input.manualOverride) {
      return this.assessment(input, input.manualOverride, null, input.overrideReason || 'Manual override applied');
    }

    const knownSignals = [
      input.kycVerified,
      input.covenantBreaches,
      input.rejectedSettlements,
      input.lateReports,
    ].some((value) => value !== undefined);

    if (!knownSignals) {
      return this.assessment(input, 'unknown', null, 'Insufficient counterparty history');
    }

    const score =
      (input.kycVerified ? 0 : 25) +
      (input.covenantBreaches || 0) * 20 +
      (input.rejectedSettlements || 0) * 15 +
      (input.lateReports || 0) * 10;
    const bucket: RiskBucket = score >= 60 ? 'high' : score >= 25 ? 'medium' : 'low';
    return this.assessment(input, bucket, score, 'Derived from documented counterparty signals');
  }

  private assessment(input: CounterpartyRiskInput, bucket: RiskBucket, score: number | null, reason: string): RiskAssessment {
    const messages: Record<RiskBucket, string> = {
      unknown: 'Counterparty risk is not yet established.',
      low: 'No material counterparty risk indicators are currently visible.',
      medium: 'Some counterparty risk indicators require review.',
      high: 'High counterparty risk indicators require maintainer review before proceeding.',
    };

    return {
      counterpartyId: input.counterpartyId,
      bucket,
      score,
      userSummary: {
        bucket,
        visibility: 'public',
        message: messages[bucket],
      },
      maintainerDetail: {
        visibility: 'maintainer',
        reason,
        signals: {
          kycVerified: input.kycVerified,
          covenantBreaches: input.covenantBreaches,
          rejectedSettlements: input.rejectedSettlements,
          lateReports: input.lateReports,
          manualOverride: input.manualOverride,
          overrideReason: input.overrideReason,
          score,
        },
      },
    };
  }
}

export class SettlementDisputeService {
  open(existing: SettlementDispute[], dispute: Omit<SettlementDispute, 'state' | 'audit'>, actor: string, at: string): SettlementDispute {
    if (existing.some((item) => item.settlementId === dispute.settlementId && item.state !== 'resolved' && item.state !== 'rejected')) {
      throw new Error(`Active dispute already exists for settlement ${dispute.settlementId}`);
    }

    return {
      ...dispute,
      state: 'open',
      audit: [{ actor, action: 'open', reason: 'Dispute opened', at }],
    };
  }

  transition(dispute: SettlementDispute, next: DisputeState, actor: string, reason: string, at: string): SettlementDispute {
    if (!DISPUTE_TRANSITIONS[dispute.state].includes(next)) {
      throw new Error(`Cannot transition dispute from ${dispute.state} to ${next}`);
    }
    return {
      ...dispute,
      state: next,
      audit: [...dispute.audit, { actor, action: next, reason, at }],
    };
  }

  visibleEvidence(dispute: SettlementDispute, visibility: Visibility): EvidenceItem[] {
    return dispute.evidence.filter((item) => visibility === 'maintainer' || item.visibility === 'public');
  }
}

export class CovenantBreachService {
  evaluate(input: CovenantInput, at = new Date().toISOString()): CovenantBreachRecord {
    const reasons: string[] = [];
    if ((input.reportsLateByDays || 0) > 0) reasons.push('Missed reporting cadence');
    if (input.sustainabilityMetricValid === false) reasons.push('Invalid sustainability metric');
    if ((input.repaymentDaysPastDue || 0) > 0) reasons.push('Repayment schedule violation');

    const severity = reasons.length === 0
      ? 'none'
      : (input.repaymentDaysPastDue || 0) > 30 || input.sustainabilityMetricValid === false
        ? 'high'
        : (input.reportsLateByDays || 0) > 7
          ? 'medium'
          : 'low';

    const state: CovenantState = reasons.length === 0 ? 'clear' : 'detected';
    return {
      bondId: input.bondId,
      state,
      severity,
      detectedReasons: reasons,
      investorStatus: this.toInvestorStatus(state, severity),
      audit: reasons.length === 0
        ? []
        : [{ actor: 'system', action: 'detected', reason: reasons.join('; '), at }],
    };
  }

  maintainerAction(record: CovenantBreachRecord, next: CovenantState, actor: string, reason: string, at: string): CovenantBreachRecord {
    const allowed: Record<CovenantState, CovenantState[]> = {
      clear: ['detected'],
      detected: ['investigating', 'remediation_accepted', 'remediation_rejected', 'resolved'],
      investigating: ['remediation_accepted', 'remediation_rejected', 'resolved'],
      remediation_accepted: ['resolved', 'remediation_rejected'],
      remediation_rejected: ['investigating', 'resolved'],
      resolved: ['investigating'],
    };
    if (!allowed[record.state].includes(next)) {
      throw new Error(`Cannot transition covenant from ${record.state} to ${next}`);
    }
    return {
      ...record,
      state: next,
      investorStatus: this.toInvestorStatus(next, record.severity),
      audit: [...record.audit, { actor, action: next, reason, at }],
    };
  }

  private toInvestorStatus(state: CovenantState, severity: CovenantBreachRecord['severity']): CovenantBreachRecord['investorStatus'] {
    const nextStep: Record<CovenantState, string> = {
      clear: 'No investor action is required.',
      detected: 'A breach indicator has been detected and is awaiting maintainer review.',
      investigating: 'Maintainers are reviewing the breach evidence.',
      remediation_accepted: 'Issuer remediation has been accepted and is being tracked.',
      remediation_rejected: 'Issuer remediation was rejected; maintainers are determining next actions.',
      resolved: 'The breach workflow is resolved.',
    };
    return { state, severity, nextStep: nextStep[state] };
  }
}
