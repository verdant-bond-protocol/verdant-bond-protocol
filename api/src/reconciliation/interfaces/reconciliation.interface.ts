export interface ReconciliationDrift {
  type: 'missing' | 'duplicate' | 'stale' | 'inconsistent';
  entityType: string;
  entityId: string;
  description: string;
  affectedFields?: string[];
  expectedValue?: any;
  actualValue?: any;
  repairSuggestion?: string;
}

export interface ReconciliationReport {
  timestamp: Date;
  dryRun: boolean;
  totalEntitiesChecked: number;
  driftsFound: ReconciliationDrift[];
  summary: {
    missingCount: number;
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
