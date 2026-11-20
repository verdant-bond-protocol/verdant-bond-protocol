export const SUPPORTED_CONTRACT_SCHEMA_VERSION = 1;
export const SUPPORTED_API_SCHEMA_VERSION = 1;

export type ContractTarget =
  | 'bond-issuer'
  | 'coupon-engine'
  | 'oracle-consumer'
  | 'dex-router'
  | 'governance'
  | 'credit-retirement'
  | 'project-registry';

export enum ReleaseGateStatus {
  COMPATIBLE = 'COMPATIBLE',
  INCOMPATIBLE = 'INCOMPATIBLE',
  MIGRATION_ACTIVE = 'MIGRATION_ACTIVE',
  BYPASSED = 'BYPASSED',
}

export interface InterfaceCheckResult {
  method: string;
  expectedArgs: number;
  compatible: boolean;
  error?: string;
}

export interface StorageFixtureValidationResult {
  verified: boolean;
  fixtureCount: number;
  keysChecked: string[];
  mismatches: string[];
}

export interface ContractCompatibilityReport {
  contract: ContractTarget;
  address: string;
  deployedSchemaVersion: number;
  expectedSchemaVersion: number;
  isVersionCompatible: boolean;
  interfaceChecks: InterfaceCheckResult[];
  migrationWindowActive: boolean;
  storageKeyVerified: boolean;
  status: 'COMPATIBLE' | 'INCOMPATIBLE' | 'MIGRATION_REQUIRED';
  violations: string[];
}

export interface ReleaseGateBypassInfo {
  bypassed: boolean;
  reason?: string;
  bypassedBy?: string;
  expiresAt?: string;
  overriddenViolations?: string[];
}

export interface ReleaseGateEvaluation {
  gateStatus: ReleaseGateStatus;
  evaluatedAt: string;
  schemaVersion: number;
  overallCompatible: boolean;
  contracts: Record<ContractTarget, ContractCompatibilityReport>;
  storageValidation: StorageFixtureValidationResult;
  activeMigrations: string[];
  violations: string[];
  rollbackRecommendations: string[];
  bypass?: ReleaseGateBypassInfo;
}
