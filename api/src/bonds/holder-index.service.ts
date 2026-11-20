import { Injectable, ConflictException, Logger } from '@nestjs/common';
import { ContractService } from '../stellar/contract.service';
import { RedisService } from '../common/services/redis.service';
import { ConfigService } from '../config/config.service';
import { Address, nativeToScVal, scValToNative } from '@stellar/stellar-sdk';
import { toBigIntString } from '../common/utils';
import { HolderStore, createHolderStore } from './holder-store';

export interface HolderWithBalance {
  address: string;
  balance: string;
}

export interface CouponHoldersOptions {
  requireFresh?: boolean;
  maxStalenessMs?: number;
}

/**
 * Authoritative holder indexing for bonds.
 *
 * The previous implementation tracked holder membership only inside Redis
 * (via `bond:{id}:holders`). Redis is neither authoritative nor durable:
 * transfers performed directly against the contract (outside the API) and
 * Redis eviction/loss both desynchronise the holder list, causing coupon
 * distribution to miss holders.
 *
 * This service keeps a durable, Redis-independent index of holders and
 * reconciles it against on-chain balances. Redis is retained only as a
 * read cache. Holder lists therefore survive Redis loss, and out-of-band
 * transfers can be rediscovered by reconciliation.
 */
@Injectable()
export class HolderIndexService {
  private readonly logger = new Logger(HolderIndexService.name);
  private readonly store: HolderStore;
  private loaded = false;

  constructor(
    private readonly contractService: ContractService,
    private readonly redis: RedisService,
    private readonly configService: ConfigService,
  ) {
    this.store = createHolderStore();
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await this.store.load();
    this.loaded = true;
  }

  private async getOnChainBalance(bondId: number, address: string): Promise<bigint> {
    const balanceScVal = await this.contractService.simulateCall({
      contractAddress: this.configService.getBondIssuerAddress(),
      method: 'get_holder_balance',
      args: [nativeToScVal(BigInt(bondId), { type: 'u64' }), Address.fromString(address).toScVal()],
    });
    return BigInt(toBigIntString(scValToNative(balanceScVal)));
  }

  /** Record a successful API subscribe as an authoritative holder. */
  async recordSubscribe(bondId: number, address: string): Promise<void> {
    await this.ensureLoaded();
    this.store.addHolder(bondId, address);
    this.store.addKnownAddress(address);
    this.store.touch(bondId);
    await this.store.save();
    await this.redis.sAdd(`bond:${bondId}:holders`, address).catch(() => undefined);
  }

  /** Record a successful API transfer as an authoritative holder change. */
  async recordTransfer(bondId: number, fromAddress: string, toAddress: string): Promise<void> {
    await this.ensureLoaded();
    this.store.addKnownAddress(fromAddress);
    this.store.addKnownAddress(toAddress);
    this.store.addHolder(bondId, toAddress);
    this.store.touch(bondId);
    await this.store.save();
    await this.redis.sAdd(`bond:${bondId}:holders`, toAddress).catch(() => undefined);
  }

  async getAuthoritativeHolders(bondId: number): Promise<string[]> {
    await this.ensureLoaded();
    return this.store.getHolders(bondId);
  }

  /**
   * Return holders with on-chain balances, pruning any holder whose on-chain
   * balance has dropped to zero (e.g. after a transfer or sell).
   */
  async getHoldersWithBalances(bondId: number): Promise<HolderWithBalance[]> {
    await this.ensureLoaded();
    const addresses = this.store.getHolders(bondId);
    const result: HolderWithBalance[] = [];
    let changed = false;

    for (const address of addresses) {
      try {
        const balance = await this.getOnChainBalance(bondId, address);
        if (balance > 0n) {
          result.push({ address, balance: balance.toString() });
        } else {
          this.store.removeHolder(bondId, address);
          changed = true;
        }
      } catch {
        // If the balance check fails we keep the holder rather than drop it.
        result.push({ address, balance: '0' });
      }
    }

    if (changed) await this.store.save();
    return result;
  }

  /**
   * Reconcile the authoritative index for a single bond against on-chain
   * balances. Candidate addresses are every address the index has ever seen
   * plus any explicitly supplied extras (e.g. a direct-contract transfer
   * counterparty discovered out of band). This is how transfers that happen
   * outside the API are rediscovered.
   */
  async reconcileBond(bondId: number, extraCandidates: string[] = []): Promise<HolderWithBalance[]> {
    await this.ensureLoaded();
    const candidates = Array.from(
      new Set([...this.store.getHolders(bondId), ...this.store.getKnownAddresses(), ...extraCandidates]),
    );

    for (const address of candidates) {
      try {
        const balance = await this.getOnChainBalance(bondId, address);
        if (balance > 0n) {
          this.store.addHolder(bondId, address);
        } else {
          this.store.removeHolder(bondId, address);
        }
      } catch {
        // Network/contract error: leave the existing index entry untouched.
      }
    }

    this.store.touch(bondId);
    await this.store.save();
    return this.getHoldersWithBalances(bondId);
  }

  /** Reconcile every known bond against on-chain state. */
  async reindexAll(bondCount: number): Promise<Record<number, HolderWithBalance[]>> {
    await this.ensureLoaded();
    const out: Record<number, HolderWithBalance[]> = {};
    for (let id = 1; id <= bondCount; id++) {
      out[id] = await this.reconcileBond(id);
    }
    return out;
  }

  /**
   * Return the holder addresses to use for coupon distribution.
   *
   * When `requireFresh` is set (the default in strict mode), the index is
   * refused if it has not been reconciled within `maxStalenessMs` and a
   * reconciliation attempt fails, or if the index has never been seeded
   * with any candidate addresses (so it cannot be considered authoritative).
   * This prevents coupon distribution from silently using stale/missing data.
   */
  async getHoldersForCoupon(
    bondId: number,
    opts: CouponHoldersOptions = {},
  ): Promise<string[]> {
    await this.ensureLoaded();
    const requireFresh = opts.requireFresh ?? process.env.HOLDER_INDEX_STRICT !== 'false';
    const maxStalenessMs = opts.maxStalenessMs ?? Number(process.env.HOLDER_INDEX_MAX_STALENESS_MS ?? 3_600_000);

    if (requireFresh) {
      const lastReconciled = this.store.getLastReconciled(bondId);
      const stale = lastReconciled === 0 || Date.now() - lastReconciled > maxStalenessMs;
      if (stale) {
        try {
          await this.reconcileBond(bondId);
        } catch (error) {
          throw new ConflictException(
            `Holder index for bond ${bondId} is stale and reconciliation failed; ` +
              `reindex before distributing coupons. ${error instanceof Error ? error.message : ''}`.trim(),
          );
        }
      }
      if (this.store.getKnownAddresses().length === 0 && this.store.getHolders(bondId).length === 0) {
        throw new ConflictException(
          `Refusing coupon distribution for bond ${bondId}: holder index is empty and has never ` +
            `been seeded. Run the holder reindex command before distributing coupons.`,
        );
      }
    }

    const holders = await this.getHoldersWithBalances(bondId);
    return holders.map((h) => h.address);
  }

  /** Mark the index for a bond as reconciled now (used after repair). */
  async markReconciled(bondId: number): Promise<void> {
    await this.ensureLoaded();
    this.store.touch(bondId);
    await this.store.save();
  }

  /** Expose the durable store for operational repair tooling/tests. */
  getStore(): HolderStore {
    return this.store;
  }
}
