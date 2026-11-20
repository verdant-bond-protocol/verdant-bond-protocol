import * as crypto from 'crypto';
import {
  JurisdictionRule,
  TrancheType,
  VersionedRuleset,
} from '../interfaces/compliance.interface';
import { KycStatus } from '../../common/interfaces/authenticated-request.interface';

const JURISDICTIONS: Record<string, JurisdictionRule> = {
  US: {
    jurisdiction: 'US',
    name: 'United States (SEC Reg D / Reg S)',
    allowedTranches: [TrancheType.STANDARD, TrancheType.RESTRICTED_ACCREDITED],
    minimumKycStatus: KycStatus.VERIFIED,
    requireAccreditationForRestricted: true,
    maxRetailOfferingCap: '10000',
    requiresSanctionsCheck: true,
    isSanctionedOrEmbargoed: false,
  },
  EU: {
    jurisdiction: 'EU',
    name: 'European Union (MiFID II / Prospectus Reg)',
    allowedTranches: [
      TrancheType.STANDARD,
      TrancheType.RESTRICTED_ACCREDITED,
      TrancheType.GREEN_INSTITUTIONAL,
    ],
    minimumKycStatus: KycStatus.VERIFIED,
    requireAccreditationForRestricted: true,
    maxRetailOfferingCap: '25000',
    requiresSanctionsCheck: true,
    isSanctionedOrEmbargoed: false,
  },
  SG: {
    jurisdiction: 'SG',
    name: 'Singapore (MAS SFA Regulated)',
    allowedTranches: [TrancheType.STANDARD, TrancheType.RESTRICTED_ACCREDITED],
    minimumKycStatus: KycStatus.VERIFIED,
    requireAccreditationForRestricted: true,
    maxRetailOfferingCap: '20000',
    requiresSanctionsCheck: true,
    isSanctionedOrEmbargoed: false,
  },
  GB: {
    jurisdiction: 'GB',
    name: 'United Kingdom (FCA FSMA)',
    allowedTranches: [
      TrancheType.STANDARD,
      TrancheType.RESTRICTED_ACCREDITED,
      TrancheType.GREEN_INSTITUTIONAL,
    ],
    minimumKycStatus: KycStatus.VERIFIED,
    requireAccreditationForRestricted: true,
    maxRetailOfferingCap: '25000',
    requiresSanctionsCheck: true,
    isSanctionedOrEmbargoed: false,
  },
  KP: {
    jurisdiction: 'KP',
    name: 'North Korea (OFAC Embargoed)',
    allowedTranches: [],
    minimumKycStatus: KycStatus.ACCREDITED,
    requireAccreditationForRestricted: true,
    requiresSanctionsCheck: true,
    isSanctionedOrEmbargoed: true,
  },
  IR: {
    jurisdiction: 'IR',
    name: 'Iran (OFAC Embargoed)',
    allowedTranches: [],
    minimumKycStatus: KycStatus.ACCREDITED,
    requireAccreditationForRestricted: true,
    requiresSanctionsCheck: true,
    isSanctionedOrEmbargoed: true,
  },
};

const DEFAULT_RULE: JurisdictionRule = {
  jurisdiction: 'GLOBAL',
  name: 'Standard International Jurisdiction Fallback',
  allowedTranches: [TrancheType.STANDARD, TrancheType.RESTRICTED_ACCREDITED],
  minimumKycStatus: KycStatus.VERIFIED,
  requireAccreditationForRestricted: true,
  maxRetailOfferingCap: '10000',
  requiresSanctionsCheck: true,
  isSanctionedOrEmbargoed: false,
};

export function computeRulesetAuditHash(ruleset: Omit<VersionedRuleset, 'auditHash'>): string {
  const canonical = JSON.stringify({
    version: ruleset.version,
    effectiveDate: ruleset.effectiveDate,
    jurisdictions: Object.keys(ruleset.jurisdictions)
      .sort()
      .reduce((acc, k) => {
        acc[k] = ruleset.jurisdictions[k];
        return acc;
      }, {} as any),
    defaultRule: ruleset.defaultRule,
  });
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

const rawRuleset = {
  version: '2026.1',
  effectiveDate: '2026-09-01T00:00:00.000Z',
  jurisdictions: JURISDICTIONS,
  defaultRule: DEFAULT_RULE,
};

export const CANONICAL_RULESET_V2026_1: VersionedRuleset = {
  ...rawRuleset,
  auditHash: computeRulesetAuditHash(rawRuleset),
};
