/**
 * Types and interfaces for deterministic duplicate detection and merge review workflow.
 *
 * Supports reproducible candidate detection, two-phase human review, field-level
 * resolution strategies, reversible merge execution, and tamper-evident audit logging.
 */

export enum EntityType {
  KYC_RECORD = 'kyc_record',
  PROJECT = 'project',
}

export enum CandidateStatus {
  PENDING_REVIEW = 'pending_review',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  DISMISSED = 'dismissed',
  MERGED = 'merged',
  REVERSED = 'reversed',
}

export enum MatchRuleType {
  EXACT_IDENTIFIER = 'exact_identifier',
  NORMALIZED_TEXT = 'normalized_text',
  TOKEN_SIMILARITY = 'token_similarity',
  GEO_PROXIMITY = 'geo_proximity',
  COMPOSITE = 'composite',
}

export enum FieldResolutionStrategy {
  PRIMARY_WINS = 'primary_wins',
  SECONDARY_WINS = 'secondary_wins',
  UNION = 'union',
  LATEST = 'latest',
  MANUAL = 'manual',
}

export enum MergeStatus {
  MERGED = 'merged',
  REVERSED = 'reversed',
}

export interface MatchRule {
  id: string;
  name: string;
  type: MatchRuleType;
  weight: number;
  threshold: number;
  description: string;
}

export interface RuleEvaluation {
  ruleId: string;
  ruleName: string;
  score: number;
  weight: number;
  threshold: number;
  passed: boolean;
  details?: string;
}

export interface FieldDiff {
  fieldName: string;
  primaryValue: any;
  secondaryValue: any;
  identical: boolean;
}

export interface CandidateReview {
  reviewer: string;
  decision: 'approved' | 'rejected' | 'dismissed';
  reason: string;
  fieldStrategies?: Record<string, { strategy: FieldResolutionStrategy; manualValue?: any }>;
  reviewedAt: string;
}

export interface CandidateDuplicate<T = Record<string, any>> {
  id: string;
  entityType: EntityType;
  primaryId: string;
  secondaryId: string;
  confidenceScore: number;
  evaluations: RuleEvaluation[];
  status: CandidateStatus;
  detectedAt: string;
  primarySnapshot: T;
  secondarySnapshot: T;
  primaryDigest: string;
  secondaryDigest: string;
  diffs: FieldDiff[];
  review?: CandidateReview;
  mergeId?: string;
}

export interface MergeJournalEntry {
  id: string;
  candidateId: string;
  entityType: EntityType;
  primaryId: string;
  secondaryId: string;
  preMergePrimary: Record<string, any>;
  preMergeSecondary: Record<string, any>;
  postMergePrimary: Record<string, any>;
  postMergeSecondary: Record<string, any>;
  appliedStrategies: Record<string, FieldResolutionStrategy>;
  executedBy: string;
  executedAt: string;
  status: MergeStatus;
  reversedBy?: string;
  reversedAt?: string;
  reversalReason?: string;
  stateDigest: string;
}

export interface DeduplicationScanOptions {
  entityType: EntityType;
  minConfidence?: number;
  limit?: number;
}

export interface DeduplicationScanResult {
  entityType: EntityType;
  scannedCount: number;
  candidatesFound: number;
  candidates: CandidateDuplicate[];
  scanFingerprint: string;
  /**
   * Additive content-bearing fingerprint. Unlike `scanFingerprint`, changes
   * when scores, state digests, review status or the confidence threshold
   * change. Optional so existing callers and stored results stay compatible.
   */
  scanFingerprintV2?: string;
  scannedAt: string;
}

export interface CandidateFilter {
  entityType?: EntityType;
  status?: CandidateStatus;
  minConfidence?: number;
  limit?: number;
  offset?: number;
}
