export enum ReportStatus {
  Pending = 'Pending',
  Verified = 'Verified',
  Challenged = 'Challenged',
  Rejected = 'Rejected',
}

export interface ReportResponse {
  id: number;
  projectId: string;
  periodStart: number;
  periodEnd: number;
  carbonSequestered: string;
  methodology: string;
  ipfsHash: string;
  providerAddress: string;
  status: ReportStatus;
  createdAt: string;
  verifiedAt?: string;
  providerStakeAtVerification?: string;
}

export interface ChallengeResponse {
  reportId: number;
  challengerAddress: string;
  reason: string;
  counterEvidenceHash: string;
  resolved: boolean;
  createdAt: string;
}

export interface ProviderResponse {
  providerAddress: string;
  methodology: string;
  name: string;
  active: boolean;
  registeredAt: string;
}

export interface SlashRecord {
  reportId: number;
  penalty: string;
  remainingStake: string;
  timestamp: string;
  activeAfter: boolean;
}

export interface SlashPreview {
  reportId: number;
  providerAddress: string;
  currentStake: string;
  penalty: string;
  remainingStake: string;
  activeAfter: boolean;
}

export interface ChallengeRecord {
  reportId: number;
  challengerAddress: string;
  counterEvidenceHash: string;
  submittedAt: string;
  resolved: boolean;
  resolution: ReportStatus | null;
}

export interface ProviderStatsResponse {
  providerAddress: string;
  reportsSubmitted: number;
  challengesFaced: number;
  slashes: number;
  totalPenalty: string;
  stake: string;
  active: boolean;
}

export interface ProviderStatsWithHistory extends ProviderStatsResponse {
  slashHistory: SlashRecord[];
  challengeHistory: ChallengeRecord[];
}

export interface StalenessMetric {
  projectId: string;
  providerAddress?: string;
  lastVerifiedAt?: string;
  expectedCadenceSeconds: number;
  graceSeconds: number;
  expectedNextReportAt?: string;
  stalenessSeconds?: number;
  isStale: boolean;
}

export interface ProviderStalenessMetric {
  providerAddress: string;
  lastVerifiedAt?: string;
  expectedNextReportAt?: string;
  stalenessSeconds?: number;
  isStale: boolean;
  projectIds: string[];
}

export interface OracleStalenessReport {
  asOf: string;
  projects: StalenessMetric[];
  providers: ProviderStalenessMetric[];
}

/** Full challenge state for a single report, including the on-chain challenge records. */
export interface ChallengeStateResponse {
  reportId: number;
  status: ReportStatus;
  challenged: boolean;
  challenges: ChallengeRecord[];
}

/** A challenged report paired with its most recent challenge record, for project listings. */
export interface ChallengedReportSummary {
  report: ReportResponse;
  challenge: ChallengeRecord | null;
}

/**
 * Coupon-distribution eligibility for a project, derived from the challenge
 * state of its oracle reports. A project is only eligible when it has at least
 * one Verified report and no Challenged/Rejected report (a challenged report
 * means the underlying carbon data is disputed and must not be paid on).
 */
export interface CouponEligibility {
  projectId: string;
  eligible: boolean;
  reasons: string[];
  blockedByReportIds: number[];
}

export type CrossSourceAnomalyKind =
  | 'normal'
  | 'outlier'
  | 'conflicting_sources'
  | 'missing_source';

export interface CrossSourceAssessment {
  projectId: string;
  periodKey: string;
  kind: CrossSourceAnomalyKind;
  severity: 'info' | 'warning' | 'critical';
  median: number | null;
  deviations: Array<{
    sourceId: string;
    value: number;
    deviation: number | null;
  }>;
  tolerance: number;
  reason: string;
}

export interface OracleAnomalyReport {
  asOf: string;
  anomalies: CrossSourceAssessment[];
}

