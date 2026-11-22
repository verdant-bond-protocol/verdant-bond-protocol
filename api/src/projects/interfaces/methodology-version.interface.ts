export type MethodologyVersionStatus = 'draft' | 'active' | 'deprecated';

export const LEGACY_METHODOLOGY_ID = 'LEGACY-UNVERSIONED';
export const LEGACY_METHODOLOGY_VERSION = '0.0.0-legacy';

export interface MethodologyVersion {
  id: string;
  name: string;
  version: string;
  effectiveDate: string;
  documentContent: string;
  contentHash: string;
  status: MethodologyVersionStatus;
  isLegacy?: boolean;
  createdBy: string;
  createdAt: string;
  approvedBy?: string;
  approvedAt?: string;
  deprecatedBy?: string;
  deprecatedAt?: string;
  deprecationReason?: string;
}

export interface BondMethodologyPin {
  bondId: number;
  methodologyId: string;
  version: string;
  contentHash: string;
  pinnedBy: string;
  pinnedAt: string;
  isLegacyMigration?: boolean;
}

export interface ReportMethodologyBinding {
  reportId: number;
  bondId: number;
  methodologyId: string;
  version: string;
  contentHash: string;
  isLaterVersionOverride: boolean;
  overrideReason?: string;
  overrideApprovedBy?: string;
  recordedBy: string;
  recordedAt: string;
  isLegacyMigration?: boolean;
}

export interface LegacyMigrationResult {
  legacyMethodologyKey: string;
  migratedBondIds: number[];
  skippedBondIds: number[];
  migratedReportIds: number[];
  skippedReportIds: number[];
  executedAt: string;
}

export interface LegacyRollbackResult {
  rolledBackBondIds: number[];
  rolledBackReportIds: number[];
  rolledBackAt: string;
}
