import { KycStatus } from '../../common/interfaces/authenticated-request.interface';

export enum TrancheType {
  STANDARD = 'STANDARD',
  RESTRICTED_ACCREDITED = 'RESTRICTED_ACCREDITED',
  GREEN_INSTITUTIONAL = 'GREEN_INSTITUTIONAL',
}

export interface JurisdictionRule {
  jurisdiction: string; // ISO 3166-1 alpha-2, e.g. 'US', 'GB', 'SG', 'EU'
  name: string;
  allowedTranches: TrancheType[];
  minimumKycStatus: KycStatus;
  requireAccreditationForRestricted: boolean;
  maxRetailOfferingCap?: string; // Cap in minor units or null if unlimited
  requiresSanctionsCheck: boolean;
  isSanctionedOrEmbargoed: boolean;
}

export interface VersionedRuleset {
  version: string; // e.g. '2026.1'
  effectiveDate: string;
  auditHash: string; // SHA-256 hash of canonical serialized ruleset
  jurisdictions: Record<string, JurisdictionRule>;
  defaultRule: JurisdictionRule;
}

export interface EligibilityEvaluationContext {
  investorAddress: string;
  jurisdiction: string;
  tranche: TrancheType;
  bondId: number;
  purchaseAmount?: string;
  kycRecord?: {
    status: KycStatus;
    expiresAt?: number | null;
  };
}

export interface EvaluatedRuleResult {
  ruleName: string;
  passed: boolean;
  reason?: string;
}

export interface EligibilityDecision {
  eligible: boolean;
  code?: 'ELIGIBLE' | 'ACCREDITATION_REQUIRED' | 'SANCTIONED_ADDRESS' | 'SANCTIONED_JURISDICTION' | 'KYC_REQUIRED' | 'KYC_EXPIRED' | 'OFFERING_CAP_EXCEEDED' | 'TRANCHE_NOT_PERMITTED';
  reason?: string;
  rulesetVersion: string;
  jurisdiction: string;
  tranche: TrancheType;
  requiresAttestation: boolean;
  evaluatedRules: EvaluatedRuleResult[];
}

export interface EligibilityAttestationPayload {
  investorAddress: string;
  bondId: number;
  tranche: TrancheType;
  jurisdiction: string;
  kycStatus: KycStatus;
  rulesetVersion: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

export interface SignedEligibilityAttestation {
  payload: EligibilityAttestationPayload;
  signature: string; // Hex signature from compliance keypair
  signerPublicKey: string;
}

export interface AttestationVerificationResult {
  valid: boolean;
  reason?: string;
  payload?: EligibilityAttestationPayload;
}

export interface SanctionsStatus {
  isStale: boolean;
  lastRefreshedAt: string;
  entryCount: number;
  refreshCadence: string;
  maxStalenessHours: number;
  alertRaised: boolean;
}
