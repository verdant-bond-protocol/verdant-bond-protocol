import type { ExportRedactionMode, RedactionManifest } from '../services/export-field-redaction';

export type ExportStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

export enum ExportRole {
  INVESTOR = 'INVESTOR',
  ISSUER = 'ISSUER',
  AUDITOR = 'AUDITOR',
  ADMIN = 'ADMIN',
}

export interface ExportCaller {
  userId: string;
  role: ExportRole;
  organizationId?: string;
}

export interface ExportableRecord {
  id: string;
  type: string;
  createdAt: Date;
  data: Record<string, any>;
  ownerUserId?: string;
  organizationId?: string;
}

export interface ExportSchema {
  version: string;
  generatedAt: Date;
  generatedBy: string;
  recordTypes: string[];
  retentionDays: number;
}

export interface DataExport {
  id: string;
  userId: string;
  status: ExportStatus;
  schema: ExportSchema;
  recordCount: number;
  filePath?: string;
  expiresAt: Date;
  createdAt: Date;
  completedAt?: Date;
  cancelledAt?: Date;
  error?: string;
  /** What was withheld from this run, for audit (#506). */
  redaction?: RedactionManifest;
}

export enum ExportType {
  PORTFOLIO = 'portfolio',
  TRANSACTIONS = 'transactions',
  HOLDINGS = 'holdings',
  PERFORMANCE = 'performance',
  BONDS = 'bonds',
  COUPONS = 'coupons',
  COMPLIANCE_AUDIT = 'compliance_audit',
  KYC_PII = 'kyc_pii',
}

export interface ExportStreamOptions {
  batchSize?: number;
  abortSignal?: AbortSignal;
  caller: ExportCaller;
  /** How forbidden fields are hidden (#506). Default `strip` (removed). */
  redaction?: ExportRedactionMode;
}

export interface ExportStreamResult {
  exportId: string;
  status: ExportStatus;
  totalRecordsProcessed: number;
  totalChunks: number;
  completedAt?: Date;
  cancelledAt?: Date;
  error?: string;
  /** What was withheld from this run, for audit (#506). */
  redaction?: RedactionManifest;
}
