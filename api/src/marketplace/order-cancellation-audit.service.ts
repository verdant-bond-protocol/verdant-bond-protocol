import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';

/**
 * Secondary-market order cancellation audit with reason codes (#440).
 *
 * Every cancellation is recorded once, with a stable reason code, the actor
 * and their role, in an append-only hash-chained log. Who may use which
 * reason code is fixed by role. A retry with the same idempotency key returns
 * the original entry. See docs/order-cancellation-audit.md.
 */

export enum CancellationReasonCode {
  USER_REQUESTED = 'USER_REQUESTED',
  EXPIRED = 'EXPIRED',
  INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE',
  STALE_PRICE = 'STALE_PRICE',
  KYC_REVOKED = 'KYC_REVOKED',
  COMPLIANCE_HOLD = 'COMPLIANCE_HOLD',
  ADMIN_HALT = 'ADMIN_HALT',
}

export type CancellationActorRole = 'owner' | 'system' | 'admin';

export const REASONS_BY_ROLE: Record<CancellationActorRole, readonly CancellationReasonCode[]> = {
  owner: [CancellationReasonCode.USER_REQUESTED],
  system: [
    CancellationReasonCode.EXPIRED,
    CancellationReasonCode.INSUFFICIENT_BALANCE,
    CancellationReasonCode.STALE_PRICE,
    CancellationReasonCode.KYC_REVOKED,
  ],
  admin: [
    CancellationReasonCode.KYC_REVOKED,
    CancellationReasonCode.COMPLIANCE_HOLD,
    CancellationReasonCode.ADMIN_HALT,
  ],
};

/** Reason codes that need a human-written note. */
export const NOTE_REQUIRED: readonly CancellationReasonCode[] = [
  CancellationReasonCode.COMPLIANCE_HOLD,
  CancellationReasonCode.ADMIN_HALT,
];

export const MAX_NOTE_LENGTH = 280;
export const GENESIS_HASH = '0'.repeat(64);

export interface CancellationRequest {
  orderId: number;
  orderOwner: string;
  actor: { address: string; role: CancellationActorRole };
  reasonCode: CancellationReasonCode;
  note?: string;
  idempotencyKey: string;
}

export interface CancellationAuditEntry {
  sequence: number;
  orderId: number;
  orderOwner: string;
  actorAddress: string;
  actorRole: CancellationActorRole;
  reasonCode: CancellationReasonCode;
  note: string | null;
  idempotencyKey: string;
  recordedAt: number;
  prevHash: string;
  hash: string;
}

export interface ChainVerification {
  valid: boolean;
  /** Sequence of the first entry that fails verification. */
  brokenAt?: number;
}

@Injectable()
export class OrderCancellationAuditService {
  private readonly log: CancellationAuditEntry[] = [];
  private readonly byOrder = new Map<number, CancellationAuditEntry>();

  now: () => number = () => Date.now();

  record(request: CancellationRequest): CancellationAuditEntry {
    if (!Object.values(CancellationReasonCode).includes(request.reasonCode)) {
      throw new BadRequestException({ code: 'INVALID_REASON_CODE', message: `Unknown reason code: ${request.reasonCode}` });
    }
    if (!request.idempotencyKey) {
      throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'idempotencyKey is required' });
    }
    const allowed = REASONS_BY_ROLE[request.actor.role];
    if (!allowed) {
      throw new ForbiddenException({ code: 'CANCELLATION_FORBIDDEN', message: 'Unknown actor role' });
    }
    if (request.actor.role === 'owner' && request.actor.address !== request.orderOwner) {
      throw new ForbiddenException({
        code: 'CANCELLATION_FORBIDDEN',
        message: 'Only the order owner can cancel this order',
      });
    }
    if (!allowed.includes(request.reasonCode)) {
      throw new ForbiddenException({
        code: 'REASON_NOT_ALLOWED_FOR_ROLE',
        message: `${request.actor.role} cannot cancel with ${request.reasonCode}`,
      });
    }
    const note = request.note?.trim() || null;
    if (note && note.length > MAX_NOTE_LENGTH) {
      throw new BadRequestException({ code: 'NOTE_TOO_LONG', message: `note exceeds ${MAX_NOTE_LENGTH} characters` });
    }
    if (!note && NOTE_REQUIRED.includes(request.reasonCode)) {
      throw new BadRequestException({ code: 'NOTE_REQUIRED', message: `${request.reasonCode} requires a note` });
    }

    const existing = this.byOrder.get(request.orderId);
    if (existing) {
      if (existing.idempotencyKey === request.idempotencyKey) {
        return { ...existing };
      }
      throw new ConflictException({
        code: 'ORDER_ALREADY_CANCELLED',
        message: `Order ${request.orderId} was already cancelled (${existing.reasonCode})`,
      });
    }

    const prevHash = this.log.length ? this.log[this.log.length - 1].hash : GENESIS_HASH;
    const unhashed: Omit<CancellationAuditEntry, 'hash'> = {
      sequence: this.log.length + 1,
      orderId: request.orderId,
      orderOwner: request.orderOwner,
      actorAddress: request.actor.address,
      actorRole: request.actor.role,
      reasonCode: request.reasonCode,
      note,
      idempotencyKey: request.idempotencyKey,
      recordedAt: this.now(),
      prevHash,
    };
    const entry: CancellationAuditEntry = { ...unhashed, hash: OrderCancellationAuditService.hashOf(unhashed) };
    this.log.push(entry);
    this.byOrder.set(entry.orderId, entry);
    return { ...entry };
  }

  getForOrder(orderId: number): CancellationAuditEntry | undefined {
    const entry = this.byOrder.get(orderId);
    return entry ? { ...entry } : undefined;
  }

  list(filter: { reasonCode?: CancellationReasonCode; actorRole?: CancellationActorRole } = {}): CancellationAuditEntry[] {
    return this.log
      .filter((e) => !filter.reasonCode || e.reasonCode === filter.reasonCode)
      .filter((e) => !filter.actorRole || e.actorRole === filter.actorRole)
      .map((e) => ({ ...e }));
  }

  /** Counts by reason code, for ops dashboards. */
  summary(): Record<CancellationReasonCode, number> {
    const counts = Object.fromEntries(
      Object.values(CancellationReasonCode).map((code) => [code, 0]),
    ) as Record<CancellationReasonCode, number>;
    for (const entry of this.log) counts[entry.reasonCode] += 1;
    return counts;
  }

  verifyChain(entries: readonly CancellationAuditEntry[] = this.log): ChainVerification {
    let prev = GENESIS_HASH;
    for (const entry of entries) {
      const { hash, ...rest } = entry;
      if (entry.prevHash !== prev || OrderCancellationAuditService.hashOf(rest) !== hash) {
        return { valid: false, brokenAt: entry.sequence };
      }
      prev = hash;
    }
    return { valid: true };
  }

  static hashOf(entry: Omit<CancellationAuditEntry, 'hash'>): string {
    const canonical = JSON.stringify([
      entry.sequence,
      entry.orderId,
      entry.orderOwner,
      entry.actorAddress,
      entry.actorRole,
      entry.reasonCode,
      entry.note,
      entry.idempotencyKey,
      entry.recordedAt,
      entry.prevHash,
    ]);
    return createHash('sha256').update(canonical).digest('hex');
  }
}
