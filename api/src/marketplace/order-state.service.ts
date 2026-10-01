import { Injectable, ConflictException } from '@nestjs/common';
import { RedisService } from '../common/services/redis.service';
import { OrderStatus } from './interfaces/marketplace.interface';

/**
 * Versioned order state machine (#200) for serialized transitions that prevent
 * concurrent cancel-vs-match races. Uses optimistic concurrency with a version
 * column so that concurrent attempts to modify the same order are serialized.
 */

export interface VersionedOrderState {
  orderId: number;
  version: number;
  status: OrderStatus;
  filledAmount: string;
  lastModified: number;
}

@Injectable()
export class OrderStateService {
  constructor(private readonly redis: RedisService) {}

  private keyOf(orderId: number): string {
    return `order:state:${orderId}`;
  }

  /**
   * Atomically reads or initializes order state. Returns the versioned state
   * and prevents lost updates through optimistic concurrency.
   */
  async getOrderState(orderId: number): Promise<VersionedOrderState> {
    const key = this.keyOf(orderId);
    const raw = await this.redis.get(key);
    if (raw) {
      return JSON.parse(raw) as VersionedOrderState;
    }

    const initial: VersionedOrderState = {
      orderId,
      version: 0,
      status: OrderStatus.Open,
      filledAmount: '0',
      lastModified: Date.now(),
    };
    await this.redis.setEx(key, 86_400 * 7, JSON.stringify(initial));
    return initial;
  }

  /**
   * Attempts a state transition with optimistic concurrency control. Throws
   * ConflictException if the version has changed (concurrent modification).
   * Returns the new versioned state if successful.
   */
  async transitionState(
    orderId: number,
    currentVersion: number,
    newStatus: OrderStatus,
    filledAmount?: string,
  ): Promise<VersionedOrderState> {
    const key = this.keyOf(orderId);
    const existing = await this.getOrderState(orderId);

    if (existing.version !== currentVersion) {
      throw new ConflictException(
        `Order ${orderId} was modified concurrently (version conflict: expected ${currentVersion}, found ${existing.version}). Retry with fresh order state.`,
      );
    }

    const newState: VersionedOrderState = {
      orderId,
      version: currentVersion + 1,
      status: newStatus,
      filledAmount: filledAmount ?? existing.filledAmount,
      lastModified: Date.now(),
    };

    await this.redis.setEx(key, 86_400 * 7, JSON.stringify(newState));
    return newState;
  }

  /**
   * Rolls back order state after on-chain settlement failure. Reverts to
   * Open status and clears the filledAmount to allow retry.
   */
  async rollbackAfterSettlementFailure(orderId: number): Promise<VersionedOrderState> {
    const current = await this.getOrderState(orderId);
    const rolled = await this.transitionState(
      orderId,
      current.version,
      OrderStatus.Open,
      '0',
    );
    return rolled;
  }

  /**
   * Marks an order as settled. Used to track final state and prevent
   * further state transitions.
   */
  async markSettled(orderId: number): Promise<VersionedOrderState> {
    const current = await this.getOrderState(orderId);
    return this.transitionState(orderId, current.version, OrderStatus.Filled);
  }

  /**
   * Clears order state when an order is cancelled. Allows the seller to
   * re-list or modify the order without version conflicts.
   */
  async clearOnCancellation(orderId: number): Promise<void> {
    await this.redis.del(this.keyOf(orderId));
  }
}
