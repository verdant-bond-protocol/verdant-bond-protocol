export interface ReconciliationDrift {
  type: 'missing' | 'orphaned' | 'duplicate' | 'stale' | 'inconsistent';
  entityType: string;
  entityId: string;
  description: string;
  affectedFields?: string[];
  expectedValue?: any;
  actualValue?: any;
  repairSuggestion?: string;
  severity?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

export interface ReconciliationReport {
  timestamp: Date;
  dryRun: boolean;
  totalEntitiesChecked: number;
  status?: 'HEALTHY' | 'DEGRADED' | 'CRITICAL';
  durationMs?: number;
  driftsFound: ReconciliationDrift[];
  summary: {
    missingCount: number;
    orphanedCount?: number;
    duplicateCount: number;
    staleCount: number;
    inconsistentCount: number;
  };
}

export interface ReconciliationInvariant {
  name: string;
  description: string;
  check: (context: any) => Promise<ReconciliationDrift[]>;
}
