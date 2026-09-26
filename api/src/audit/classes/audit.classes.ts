import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { randomUUID } from 'crypto';
import { AuditRecord } from './interfaces/audit.interface';
import { stableStringify } from './audit.canonical';

/**
 * One step in the history of a single entity: the hash of the record's
 * authoritative content when the step was recorded, the monotonic per-entity
 * sequence number, and the hash of the previous step. Reordered or dropped
 * entries break both the sequence and the chain; altered content breaks the
 * content hash.
 */
export class AuditChainStep {
  sequence: number;
  recordId: string;
  createdAt: string;
  contentHash: string;
  previousHash: string;
  payload: Record<string, any>;
  hash: string;
}

export class AuditWriteResult {
  kind: 'recorded' | 'rejected';
  rejectReason: string;
  record: AuditRecord;
}

export class AuditRecordRef {
  entityType: string;
  entityId: string;
}

export class AuditWrite {
  entityType: string;
  entityId: string;
  action: string;
  actor: string;
  reason: string;
  before: Record<string, any>;
  after: Record<string, any>;
}
