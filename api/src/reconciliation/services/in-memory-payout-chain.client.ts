import { Injectable } from '@nestjs/common';
import {
  OnChainPayoutClient,
  OnChainPayoutEvent,
  OnChainPayoutPage,
} from '../interfaces/payout-reconciliation.interface';

/**
 * In-memory / test implementation of `OnChainPayoutClient`.
 * Live Horizon / Soroban RPC adapters implement the same `OnChainPayoutClient`
 * interface so reconciliation can run deterministically without network access.
 */
@Injectable()
export class InMemoryOnChainPayoutClient implements OnChainPayoutClient {
  private events: OnChainPayoutEvent[] = [];
  private failuresRemaining = 0;
  private failOnPageIndex: number | null = null;
  private callCount = 0;

  setEvents(events: OnChainPayoutEvent[]): void {
    this.events = [...events];
  }

  injectFailures(count: number, onPageIndex?: number): void {
    this.failuresRemaining = count;
    this.failOnPageIndex = onPageIndex ?? null;
    this.callCount = 0;
  }

  async fetchPayoutEvents(params: {
    bondId: number;
    periodId: string;
    cursor: string | null;
    limit: number;
  }): Promise<OnChainPayoutPage> {
    const currentCall = this.callCount++;
    if (
      this.failuresRemaining > 0 &&
      (this.failOnPageIndex === null || currentCall >= this.failOnPageIndex)
    ) {
      this.failuresRemaining--;
      throw new Error('Simulated Stellar Horizon RPC transient failure');
    }

    const filtered = this.events.filter(
      (e) => e.bondId === params.bondId && e.periodId === params.periodId,
    );
    const offset = params.cursor ? parseInt(params.cursor, 10) : 0;
    const slice = filtered.slice(offset, offset + params.limit);
    const nextOffset = offset + slice.length;
    return {
      events: slice.map((e) => ({ ...e })),
      nextCursor: nextOffset < filtered.length ? String(nextOffset) : null,
    };
  }
}
