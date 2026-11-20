import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DexService } from './dex.service';
import { RedisService } from '../common/services/redis.service';
import { OrderResponse, OrderStatus, QuoteAsset } from './interfaces/marketplace.interface';
import { listSupportedQuoteAssets } from './quote-assets';

export type MismatchType =
  | 'balance_mismatch'
  | 'stale_order_cache'
  | 'missing_order'
  | 'order_escrow_invariant';

export interface ReconciliationMismatch {
  correlationId: string;
  type: MismatchType;
  walletAddress?: string;
  asset?: string;
  orderId?: number;
  /** Authoritative value read directly from the ledger. */
  expected: string;
  /** Value observed in the API/indexed cache. */
  observed: string;
  detail: string;
  repair: string;
}

export interface ReconciliationReport {
  correlationId: string;
  startedAt: string;
  finishedAt: string;
  sampledWallets: number;
  checkedBalances: number;
  checkedOrders: number;
  mismatches: ReconciliationMismatch[];
  hasMismatches: boolean;
}

export interface ReconcileOptions {
  wallets?: string[];
  assets?: QuoteAsset[];
  /** Cap on on-chain order-id scan used to detect missing orders. */
  maxOrderScan?: number;
}

const LAST_REPORT_KEY = 'dex:recon:last';
const MISMATCHES_KEY = 'dex:recon:mismatches';
const MAX_STORED_MISMATCHES = 200;

/**
 * Periodic reconciliation (#recon) between the API/indexed view of marketplace
 * state and the authoritative on-chain DEX router ledger.
 *
 * It compares:
 *   - escrowed quote balances: indexed `quote:balance:*` cache vs
 *     `DEXRouter.get_quote_balance()`;
 *   - open orders: the API order cache/index vs `DEXRouter.get_order()` status,
 *     plus an escrow invariant (a seller's on-chain balance must still cover the
 *     order's notional) and detection of open orders that have dropped out of the
 *     API index entirely.
 *
 * Mismatches are logged with a correlation id and persisted for operators
 * (`dex:recon:last`, `dex:recon:mismatches`). `repair()` provides the stale-cache
 * / index repair path (invalidate caches, re-sync the index to the ledger).
 */
@Injectable()
export class DexReconciliationService {
  private readonly logger = new Logger(DexReconciliationService.name);

  constructor(
    private readonly dexService: DexService,
    private readonly redis: RedisService,
  ) {}

  async reconcile(options: ReconcileOptions = {}): Promise<ReconciliationReport> {
    const correlationId = randomUUID();
    const startedAt = new Date().toISOString();
    const mismatches: ReconciliationMismatch[] = [];

    const wallets = await this.resolveWallets(options.wallets);
    const assets = options.assets ?? (listSupportedQuoteAssets().map((a) => a.symbol) as QuoteAsset[]);

    let checkedBalances = 0;
    for (const wallet of wallets) {
      for (const asset of assets) {
        checkedBalances += 1;
        const onChain = await this.dexService.getQuoteBalance(wallet, asset);
        const indexed = await this.dexService.getIndexedQuoteBalance(wallet, asset);
        if (indexed === null) {
          // First sighting: seed the index from the ledger, no divergence yet.
          await this.dexService.setIndexedQuoteBalance(wallet, asset, onChain.balance);
          continue;
        }
        if (indexed !== onChain.balance) {
          mismatches.push({
            correlationId,
            type: 'balance_mismatch',
            walletAddress: wallet,
            asset,
            expected: onChain.balance,
            observed: indexed,
            detail: `Indexed quote balance ${indexed} != on-chain ${onChain.balance} for ${wallet}/${asset}`,
            repair: `Invalidate quote:balance:${wallet}:${asset} (handled by repair())`,
          });
        }
      }
    }

    const checkedOrders = await this.reconcileOrders(correlationId, mismatches, options.maxOrderScan ?? 500);

    const finishedAt = new Date().toISOString();
    const report: ReconciliationReport = {
      correlationId,
      startedAt,
      finishedAt,
      sampledWallets: wallets.length,
      checkedBalances,
      checkedOrders,
      mismatches,
      hasMismatches: mismatches.length > 0,
    };

    await this.persistReport(report);

    if (report.hasMismatches) {
      this.logger.warn(
        `[${correlationId}] Marketplace reconciliation found ${mismatches.length} mismatch(es): ` +
          mismatches.map((m) => `${m.type}#${m.orderId ?? m.walletAddress ?? ''}`).join(', '),
      );
    } else {
      this.logger.log(`[${correlationId}] Marketplace reconciliation clean (${checkedBalances} balances, ${checkedOrders} orders)`);
    }

    return report;
  }

  private async reconcileOrders(
    correlationId: string,
    mismatches: ReconciliationMismatch[],
    maxOrderScan: number,
  ): Promise<number> {
    const openOrders: OrderResponse[] = (
      await this.dexService.listOrders(undefined, OrderStatus.Open, 1, 200)
    ).data;
    const indexedOpenIds = new Set(openOrders.map((o) => o.id));

    let checked = 0;
    for (const order of openOrders) {
      checked += 1;
      const onChain = await this.dexService.fetchOrderFromLedger(order.id);
      const indexed = await this.dexService.getOrder(order.id);

      if (
        this.isOpenState(indexed.status) &&
        !this.isOpenState(onChain.status)
      ) {
        mismatches.push({
          correlationId,
          type: 'stale_order_cache',
          orderId: order.id,
          expected: onChain.status,
          observed: indexed.status,
          detail: `Order ${order.id} cached as ${indexed.status} but is ${onChain.status} on-chain`,
          repair: `Invalidate order:${order.id} and orders:* (handled by repair())`,
        });
      }

      // Escrow invariant: the seller must still hold enough quote asset on-chain.
      const escrowed = await this.dexService.getQuoteBalance(order.seller, order.quoteAsset);
      const required = BigInt(order.pricePerToken) * BigInt(order.amount);
      if (BigInt(escrowed.balance) < required) {
        mismatches.push({
          correlationId,
          type: 'order_escrow_invariant',
          orderId: order.id,
          walletAddress: order.seller,
          asset: order.quoteAsset,
          expected: `>= ${required}`,
          observed: escrowed.balance,
          detail: `Order ${order.id} seller ${order.seller} escrowed ${escrowed.balance} < required ${required}`,
          repair: `Re-escrow or cancel order ${order.id}; invalidate orders:* (handled by repair())`,
        });
      }
    }

    // Missing-order detection: walk the on-chain id space and flag open orders
    // absent from the API index.
    const orderCount = await this.dexService.getOrderCount();
    const scanLimit = Math.min(orderCount, maxOrderScan);
    for (let id = 1; id <= scanLimit; id += 1) {
      let onChain: OrderResponse;
      try {
        onChain = await this.dexService.fetchOrderFromLedger(id);
      } catch {
        continue;
      }
      if (this.isOpenState(onChain.status) && !indexedOpenIds.has(id)) {
        mismatches.push({
          correlationId,
          type: 'missing_order',
          orderId: id,
          expected: onChain.status,
          observed: 'absent from API index',
          detail: `Open order ${id} exists on-chain but is missing from the API order index/cache`,
          repair: `Invalidate orders:* so the next listOrders re-indexes it (handled by repair())`,
        });
      }
    }

    return checked;
  }

  private isOpenState(status: OrderStatus): boolean {
    return status === OrderStatus.Open || status === OrderStatus.PartiallyFilled;
  }

  /**
   * Builds the set of wallets to sample. Operators can pin an explicit list via
   * `options.wallets` (tests) or the `DEX_RECON_WALLETS` env var; otherwise we
   * sample every seller currently advertising an open order so the most
   * balance-sensitive wallets are always covered.
   */
  private async resolveWallets(override?: string[]): Promise<string[]> {
    if (override && override.length) {
      return [...new Set(override)];
    }
    const configured = (process.env.DEX_RECON_WALLETS || '')
      .split(',')
      .map((w) => w.trim())
      .filter(Boolean);
    const fromOrders = (
      await this.dexService.listOrders(undefined, OrderStatus.Open, 1, 200)
    ).data.map((o) => o.seller);
    return [...new Set([...configured, ...fromOrders])];
  }

  /**
   * Repair path for the stale cache / index records found by `reconcile()`.
   * Returns a human-readable list of actions taken. Balance mismatches are
   * re-synced to the ledger value; order/index mismatches evict the affected
   * Redis caches so the next read re-fetches from the ledger.
   */
  async repair(report: ReconciliationReport): Promise<string[]> {
    const actions: string[] = [];
    for (const mismatch of report.mismatches) {
      switch (mismatch.type) {
        case 'balance_mismatch':
          if (mismatch.walletAddress && mismatch.asset) {
            await this.dexService.setIndexedQuoteBalance(
              mismatch.walletAddress,
              mismatch.asset as QuoteAsset,
              mismatch.expected,
            );
            await this.redis.del(`quote:balance:${mismatch.walletAddress}:${mismatch.asset}`);
            actions.push(`re-synced quote:balance:${mismatch.walletAddress}:${mismatch.asset} -> ${mismatch.expected}`);
          }
          break;
        case 'stale_order_cache':
          if (mismatch.orderId !== undefined) {
            await this.redis.del(`order:${mismatch.orderId}`);
            await this.redis.delPattern('orders:*');
            actions.push(`evicted order:${mismatch.orderId} and orders:*`);
          }
          break;
        case 'missing_order':
          await this.redis.delPattern('orders:*');
          actions.push('evicted orders:* to force re-index of missing order');
          break;
        case 'order_escrow_invariant':
          if (mismatch.orderId !== undefined) {
            await this.redis.delPattern('orders:*');
            actions.push(`evicted orders:* for under-escrowed order ${mismatch.orderId}`);
          }
          break;
      }
    }
    this.logger.log(
      `[${report.correlationId}] Repaired ${actions.length}/${report.mismatches.length} mismatch(es): ${actions.join('; ')}`,
    );
    return actions;
  }

  async getLastReport(): Promise<ReconciliationReport | null> {
    const raw = await this.redis.get(LAST_REPORT_KEY);
    return raw ? (JSON.parse(raw) as ReconciliationReport) : null;
  }

  async listMismatches(limit = 50): Promise<ReconciliationMismatch[]> {
    const raw = await this.redis.get(MISMATCHES_KEY);
    if (!raw) return [];
    const all = JSON.parse(raw) as ReconciliationMismatch[];
    return all.slice(0, limit);
  }

  private async persistReport(report: ReconciliationReport): Promise<void> {
    try {
      await this.redis.setEx(LAST_REPORT_KEY, 86_400 * 7, JSON.stringify(report));
      const existing = await this.listMismatches(MAX_STORED_MISMATCHES);
      const merged = [...report.mismatches, ...existing].slice(0, MAX_STORED_MISMATCHES);
      await this.redis.setEx(MISMATCHES_KEY, 86_400 * 7, JSON.stringify(merged));
    } catch (error) {
      this.logger.warn(`Failed to persist reconciliation report: ${this.message(error)}`);
    }
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
