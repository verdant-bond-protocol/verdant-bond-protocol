import * as crypto from 'crypto';

export type OwnershipTransferStatus =
  | 'PENDING'
  | 'ACCEPTED'
  | 'CANCELLED'
  | 'REJECTED'
  | 'EXPIRED';

export interface OwnershipAuditEvent {
  seq: number;
  transferId: string;
  resourceId: string;
  action: 'INITIATED' | 'ACCEPTED' | 'CANCELLED' | 'REJECTED' | 'EXPIRED' | 'RETRIED';
  actorId: string;
  fromOwnerId: string;
  toOwnerId: string;
  timestamp: string;
  reason?: string;
}

export interface OwnershipTransferRecord {
  id: string;
  resourceId: string;
  fromOwnerId: string;
  toOwnerId: string;
  status: OwnershipTransferStatus;
  createdAt: number;
  expiresAt: number;
  completedAt?: number;
}

export class OwnershipTransferError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'UNAUTHORIZED'
      | 'NOT_FOUND'
      | 'EXPIRED'
      | 'CONFLICT'
      | 'INVALID_INPUT',
  ) {
    super(message);
    this.name = 'OwnershipTransferError';
  }
}

export const DEFAULT_TRANSFER_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export class OwnershipTransferService {
  private readonly owners = new Map<string, string>();
  private readonly transfers = new Map<string, OwnershipTransferRecord>();
  private readonly auditTrail = new Map<string, OwnershipAuditEvent[]>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  registerResource(resourceId: string, ownerId: string): void {
    this.owners.set(resourceId, ownerId);
  }

  getOwner(resourceId: string): string | undefined {
    return this.owners.get(resourceId);
  }

  getAuditHistory(resourceId: string): readonly OwnershipAuditEvent[] {
    return [...(this.auditTrail.get(resourceId) ?? [])];
  }

  initiate(params: {
    resourceId: string;
    actorId: string;
    toOwnerId: string;
    ttlMs?: number;
  }): OwnershipTransferRecord {
    const currentOwner = this.owners.get(params.resourceId);
    if (!currentOwner) {
      throw new OwnershipTransferError(`Resource "${params.resourceId}" not found.`, 'NOT_FOUND');
    }
    if (params.actorId !== currentOwner) {
      throw new OwnershipTransferError(
        `Actor "${params.actorId}" is not the owner of "${params.resourceId}".`,
        'UNAUTHORIZED',
      );
    }
    const target = params.toOwnerId?.trim();
    if (!target) {
      throw new OwnershipTransferError('Target owner ID is required.', 'INVALID_INPUT');
    }
    if (target === currentOwner) {
      throw new OwnershipTransferError('Cannot transfer ownership to the current owner.', 'INVALID_INPUT');
    }

    this.expireStaleTransfers(params.resourceId);
    const active = [...this.transfers.values()].find(
      (t) => t.resourceId === params.resourceId && t.status === 'PENDING',
    );
    if (active) {
      throw new OwnershipTransferError(
        `A pending transfer (${active.id}) already exists for "${params.resourceId}".`,
        'CONFLICT',
      );
    }

    const nowMs = this.now();
    const ttl = Math.max(1000, params.ttlMs ?? DEFAULT_TRANSFER_TTL_MS);
    const record: OwnershipTransferRecord = {
      id: `ot_${crypto.randomBytes(6).toString('hex')}`,
      resourceId: params.resourceId,
      fromOwnerId: currentOwner,
      toOwnerId: target,
      status: 'PENDING',
      createdAt: nowMs,
      expiresAt: nowMs + ttl,
    };
    this.transfers.set(record.id, record);
    this.appendAudit(record, 'INITIATED', params.actorId);
    return { ...record };
  }

  accept(transferId: string, actorId: string): OwnershipTransferRecord {
    const record = this.transfers.get(transferId);
    if (!record) {
      throw new OwnershipTransferError(`Transfer "${transferId}" not found.`, 'NOT_FOUND');
    }
    if (actorId !== record.toOwnerId) {
      throw new OwnershipTransferError(
        `Actor "${actorId}" is not the designated nominee.`,
        'UNAUTHORIZED',
      );
    }
    if (record.status !== 'PENDING') {
      throw new OwnershipTransferError(`Transfer "${transferId}" is ${record.status}.`, 'CONFLICT');
    }
    const nowMs = this.now();
    if (nowMs >= record.expiresAt) {
      record.status = 'EXPIRED';
      record.completedAt = nowMs;
      this.appendAudit(record, 'EXPIRED', 'system', 'Transfer expired before acceptance');
      throw new OwnershipTransferError(`Transfer "${transferId}" has expired.`, 'EXPIRED');
    }

    record.status = 'ACCEPTED';
    record.completedAt = nowMs;
    this.owners.set(record.resourceId, record.toOwnerId);
    this.appendAudit(record, 'ACCEPTED', actorId);
    return { ...record };
  }

  cancel(transferId: string, actorId: string, reason?: string): OwnershipTransferRecord {
    const record = this.transfers.get(transferId);
    if (!record) {
      throw new OwnershipTransferError(`Transfer "${transferId}" not found.`, 'NOT_FOUND');
    }
    if (actorId !== record.fromOwnerId) {
      throw new OwnershipTransferError('Only the initiating owner can cancel.', 'UNAUTHORIZED');
    }
    if (record.status !== 'PENDING') {
      throw new OwnershipTransferError(`Transfer "${transferId}" is ${record.status}.`, 'CONFLICT');
    }
    record.status = 'CANCELLED';
    record.completedAt = this.now();
    this.appendAudit(record, 'CANCELLED', actorId, reason);
    return { ...record };
  }

  retry(transferId: string, actorId: string, ttlMs?: number): OwnershipTransferRecord {
    const previous = this.transfers.get(transferId);
    if (!previous) {
      throw new OwnershipTransferError(`Transfer "${transferId}" not found.`, 'NOT_FOUND');
    }
    if (actorId !== previous.fromOwnerId) {
      throw new OwnershipTransferError('Only the initiating owner can retry.', 'UNAUTHORIZED');
    }
    this.expireStaleTransfers(previous.resourceId);
    if (previous.status !== 'EXPIRED' && previous.status !== 'CANCELLED') {
      throw new OwnershipTransferError(
        `Only EXPIRED or CANCELLED transfers can be retried (got ${previous.status}).`,
        'CONFLICT',
      );
    }
    const retried = this.initiate({
      resourceId: previous.resourceId,
      actorId,
      toOwnerId: previous.toOwnerId,
      ttlMs,
    });
    this.appendAudit(retried, 'RETRIED', actorId, `Retry of ${previous.id}`);
    return retried;
  }

  private expireStaleTransfers(resourceId: string): void {
    const nowMs = this.now();
    for (const t of this.transfers.values()) {
      if (t.resourceId === resourceId && t.status === 'PENDING' && nowMs >= t.expiresAt) {
        t.status = 'EXPIRED';
        t.completedAt = nowMs;
        this.appendAudit(t, 'EXPIRED', 'system', 'TTL elapsed');
      }
    }
  }

  private appendAudit(
    record: OwnershipTransferRecord,
    action: OwnershipAuditEvent['action'],
    actorId: string,
    reason?: string,
  ): void {
    const list = this.auditTrail.get(record.resourceId) ?? [];
    list.push({
      seq: list.length + 1,
      transferId: record.id,
      resourceId: record.resourceId,
      action,
      actorId,
      fromOwnerId: record.fromOwnerId,
      toOwnerId: record.toOwnerId,
      timestamp: new Date(this.now()).toISOString(),
      ...(reason ? { reason } : {}),
    });
    this.auditTrail.set(record.resourceId, list);
  }
}
