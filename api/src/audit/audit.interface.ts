export interface AuditRecord {
  sequence: number;
  recordId: string;
  entityType: string;
  entityId: string;
  action: string;
  actor: string;
  reason?: string;
  before: Record<string, any> | null;
  after: Record<string, any> | null;
  recordedAt: string;
  previousHash: string | null;
  hash: string;
}
