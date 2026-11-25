import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';

/**
 * Reason codes for pending subscription cancellations (#639).
 */
export enum SubscriptionCancellationReason {
  INVESTOR_REQUESTED = 'INVESTOR_REQUESTED',
  KYC_EXPIRED = 'KYC_EXPIRED',
  SANCTIONS_BLOCK = 'SANCTIONS_BLOCK',
  TIMEOUT_RECOVERY = 'TIMEOUT_RECOVERY',
  ADMIN_OVERRIDE = 'ADMIN_OVERRIDE',
}

export type CancellationRole = 'investor' | 'admin' | 'system';

export interface CancelSubscriptionDto {
  investorAddress: string;
  reasonCode: SubscriptionCancellationReason;
  note?: string;
  idempotencyKey: string;
}

export interface SubscriptionCancellationReceipt {
  sequence: number;
  bondId: number;
  investorAddress: string;
  actorAddress: string;
  actorRole: CancellationRole;
  reasonCode: SubscriptionCancellationReason;
  note: string | null;
  idempotencyKey: string;
  cancelledAt: number;
  prevHash: string;
  hash: string;
}

export const GENESIS_SUBSCRIPTION_HASH = '0'.repeat(64);
export const MAX_CANCELLATION_NOTE = 280;

@Injectable()
export class SubscriptionCancellationService {
  private readonly receipts: SubscriptionCancellationReceipt[] = [];
  private readonly pendingSubscriptions = new Map<string, { bondId: number; investorAddress: string; amount: string; status: 'PENDING' | 'CANCELLED' | 'SETTLED' }>();

  now: () => number = () => Date.now();

  private key(bondId: number, investorAddress: string): string {
    return `${bondId}:${investorAddress}`;
  }

  /**
   * Register a pending subscription reservation.
   */
  registerPending(bondId: number, investorAddress: string, amount: string): void {
    this.pendingSubscriptions.set(this.key(bondId, investorAddress), {
      bondId,
      investorAddress,
      amount,
      status: 'PENDING',
    });
  }

  getPending(bondId: number, investorAddress: string) {
    return this.pendingSubscriptions.get(this.key(bondId, investorAddress));
  }

  /**
   * Safely cancel a pending subscription.
   *
   * Normal path: marks pending subscription CANCELLED, computes SHA-256 audit entry.
   * Failure path: not found (404), already settled (409), unauthorized caller (403).
   * Retry path: matching idempotencyKey returns existing receipt without double-cancellation.
   */
  async cancel(
    bondId: number,
    dto: CancelSubscriptionDto,
    actor: { address: string; role: CancellationRole; isAdmin?: boolean },
  ): Promise<SubscriptionCancellationReceipt> {
    if (!dto.idempotencyKey || dto.idempotencyKey.trim().length === 0) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'An idempotency key is required to safely cancel a subscription',
      });
    }

    if (!Object.values(SubscriptionCancellationReason).includes(dto.reasonCode)) {
      throw new BadRequestException({
        code: 'INVALID_REASON_CODE',
        message: `Invalid cancellation reason code: ${dto.reasonCode}`,
      });
    }

    if (dto.note && dto.note.length > MAX_CANCELLATION_NOTE) {
      throw new BadRequestException({
        code: 'NOTE_TOO_LONG',
        message: `Cancellation note exceeds maximum allowed length of ${MAX_CANCELLATION_NOTE} characters`,
      });
    }

    // Authorization: only the investor or admin/system can cancel
    if (actor.role === 'investor' && actor.address !== dto.investorAddress) {
      throw new ForbiddenException({
        code: 'CANCELLATION_FORBIDDEN',
        message: 'Investors may only cancel their own subscriptions',
      });
    }

    // Check for idempotent replay
    const existing = this.receipts.find(
      (r) => r.bondId === bondId && r.idempotencyKey === dto.idempotencyKey,
    );
    if (existing) {
      return { ...existing };
    }

    // Lookup pending state
    const pending = this.getPending(bondId, dto.investorAddress);
    if (!pending) {
      throw new NotFoundException({
        code: 'SUBSCRIPTION_NOT_FOUND',
        message: `No pending subscription found for investor ${dto.investorAddress} on bond ${bondId}`,
      });
    }

    if (pending.status === 'SETTLED') {
      throw new ConflictException({
        code: 'SUBSCRIPTION_ALREADY_SETTLED',
        message: 'Settled subscriptions cannot be cancelled; position must be redeemed or sold on DEX',
      });
    }

    if (pending.status === 'CANCELLED') {
      throw new ConflictException({
        code: 'SUBSCRIPTION_ALREADY_CANCELLED',
        message: 'This pending subscription has already been cancelled',
      });
    }

    // Transition state to CANCELLED
    pending.status = 'CANCELLED';

    // Hash chain entry
    const sequence = this.receipts.length + 1;
    const prevHash = this.receipts.length > 0 ? this.receipts[this.receipts.length - 1].hash : GENESIS_SUBSCRIPTION_HASH;
    const cancelledAt = this.now();
    const note = dto.note ? dto.note.trim() : null;

    const hash = this.computeHash({
      sequence,
      bondId,
      investorAddress: dto.investorAddress,
      actorAddress: actor.address,
      actorRole: actor.role,
      reasonCode: dto.reasonCode,
      note,
      idempotencyKey: dto.idempotencyKey,
      cancelledAt,
      prevHash,
    });

    const receipt: SubscriptionCancellationReceipt = {
      sequence,
      bondId,
      investorAddress: dto.investorAddress,
      actorAddress: actor.address,
      actorRole: actor.role,
      reasonCode: dto.reasonCode,
      note,
      idempotencyKey: dto.idempotencyKey,
      cancelledAt,
      prevHash,
      hash,
    };

    this.receipts.push(receipt);
    return { ...receipt };
  }

  private computeHash(fields: Omit<SubscriptionCancellationReceipt, 'hash'>): string {
    const canonical = [
      fields.sequence,
      fields.bondId,
      fields.investorAddress,
      fields.actorAddress,
      fields.actorRole,
      fields.reasonCode,
      fields.note ?? '',
      fields.idempotencyKey,
      fields.cancelledAt,
      fields.prevHash,
    ].join(':');

    return createHash('sha256').update(canonical).digest('hex');
  }

  listReceipts(bondId?: number): SubscriptionCancellationReceipt[] {
    return this.receipts
      .filter((r) => bondId === undefined || r.bondId === bondId)
      .map((r) => ({ ...r }));
  }

  verifyChain(): { valid: boolean; brokenAt?: number } {
    let expectedPrev = GENESIS_SUBSCRIPTION_HASH;
    for (const entry of this.receipts) {
      if (entry.prevHash !== expectedPrev) {
        return { valid: false, brokenAt: entry.sequence };
      }
      const expectedHash = this.computeHash(entry);
      if (entry.hash !== expectedHash) {
        return { valid: false, brokenAt: entry.sequence };
      }
      expectedPrev = entry.hash;
    }
    return { valid: true };
  }
}

