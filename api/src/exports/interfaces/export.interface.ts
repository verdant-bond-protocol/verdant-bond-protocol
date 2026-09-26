export interface ExportableRecord {
  id: string;
  type: string;
  createdAt: Date;
  data: Record<string, any>;
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
  status: 'pending' | 'processing' | 'completed' | 'failed';
  schema: ExportSchema;
  recordCount: number;
  filePath?: string;
  expiresAt: Date;
  createdAt: Date;
  completedAt?: Date;
  error?: string;
}

export enum ExportType {
  PORTFOLIO = 'portfolio',
  TRANSACTIONS = 'transactions',
  HOLDINGS = 'holdings',
  PERFORMANCE = 'performance',
}
