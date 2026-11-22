import { Role } from '../../auth/rbac';
import { KycStatus } from '../../common/interfaces/authenticated-request.interface';

export type InvestorExportFormat = 'csv' | 'json';

export type InvestorExportPurpose =
  | 'compliance_reporting'
  | 'regulatory_audit'
  | 'sanctions_screening'
  | 'portfolio_analytics';

export type InvestorCategory = 'retail' | 'accredited' | 'institutional';

export const INVESTOR_COMPLIANCE_EXPORT_ALLOWLIST = [
  'investorPseudonym',
  'walletAddress',
  'jurisdiction',
  'investorCategory',
  'kycStatus',
  'kycVerifiedAt',
  'bondId',
  'holdingsMinorUnits',
  'asOfTimestamp',
] as const;

export type InvestorComplianceExportField = (typeof INVESTOR_COMPLIANCE_EXPORT_ALLOWLIST)[number];

/**
 * Raw source record shape from DB/ledger; extra columns on this object
 * (e.g. name, email, taxId, ssn, or newly added DB columns) are NEVER
 * passed through because projection uses an explicit field-by-field allowlist.
 */
export interface InvestorHoldingsSourceRow {
  investorId: string;
  walletAddress: string;
  jurisdiction: string;
  investorCategory: InvestorCategory;
  kycStatus: KycStatus;
  kycVerifiedAt: string | null;
  bondId: number;
  holdingsMinorUnits: string;
  [extraColumn: string]: unknown;
}

export interface InvestorComplianceExportRow {
  investorPseudonym: string;
  walletAddress: string | null;
  jurisdiction: string;
  investorCategory: InvestorCategory;
  kycStatus: KycStatus;
  kycVerifiedAt: string | null;
  bondId: number;
  holdingsMinorUnits: string;
  asOfTimestamp: string;
}

export interface InvestorComplianceExportFilters {
  bondId?: number;
  jurisdiction?: string;
  kycStatus?: KycStatus;
}

export interface InvestorComplianceExportRequest {
  requesterId: string;
  requesterRoles: Role[];
  purpose: InvestorExportPurpose;
  format: InvestorExportFormat;
  asOfTimestamp?: string;
  includeWalletAddress?: boolean;
  filters?: InvestorComplianceExportFilters;
  pageSize?: number;
}

export interface InvestorHoldingsPage {
  rows: InvestorHoldingsSourceRow[];
  nextCursor: string | null;
}

export type InvestorHoldingsPageLoader = (params: {
  asOfTimestamp: string;
  filters: InvestorComplianceExportFilters;
  cursor: string | null;
  limit: number;
}) => Promise<InvestorHoldingsPage>;
