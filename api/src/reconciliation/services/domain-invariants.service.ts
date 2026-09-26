import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { RedisService } from '../../common/services/redis.service';
import { KycStoreService } from '../../common/services/kyc-store.service';
import { ReconciliationService } from './reconciliation.service';
import {
  ReconciliationDrift,
  ReconciliationInvariant,
  ReconciliationReport,
} from '../interfaces/reconciliation.interface';
import { BondStatusEnum } from '../../bonds/interfaces/bond.interface';
import { KycStatus } from '../../common/interfaces/authenticated-request.interface';

export interface ValidationContext {
  bonds?: any[];
  projects?: any[];
  orders?: any[];
  kycRecords?: any[];
  holdersByBond?: Record<number, Array<{ address: string; balance: string }>>;
  settlementTransactions?: Array<{ txHash: string; entityType: string; entityId: string; amount?: string }>;
}

@Injectable()
export class DomainInvariantsService implements OnModuleInit {
  private readonly logger = new Logger(DomainInvariantsService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly kycStore: KycStoreService,
    @Optional() private readonly reconciliationService?: ReconciliationService,
  ) {}

  onModuleInit(): void {
    if (this.reconciliationService) {
      for (const invariant of this.getAllInvariants()) {
        this.reconciliationService.registerInvariant(invariant);
      }
      this.logger.log(`Registered ${this.getAllInvariants().length} core domain restore invariants.`);
    }
  }

  getAllInvariants(): ReconciliationInvariant[] {
    return [
      this.getBondProjectIntegrityInvariant(),
      this.getBondSupplyAccountingInvariant(),
      this.getMarketplaceOrderIntegrityInvariant(),
      this.getSettlementReferenceIntegrityInvariant(),
      this.getKycComplianceIntegrityInvariant(),
    ];
  }

  /**
   * INVARIANT 1: Bond-to-Project Referential Integrity
   * Detects:
   * - Orphaned bonds referencing non-existent projects
   * - Missing project metadata / CID
   * - Duplicated bond IDs
   */
  getBondProjectIntegrityInvariant(): ReconciliationInvariant {
    return {
      name: 'BOND_PROJECT_INTEGRITY',
      description: 'Verifies referential integrity between issued bonds and project registry records',
      check: async (context: ValidationContext = {}): Promise<ReconciliationDrift[]> => {
        const drifts: ReconciliationDrift[] = [];
        const bonds = context.bonds ?? (await this.loadBondsFromStore());
        const projects = context.projects ?? (await this.loadProjectsFromStore());

        const projectIds = new Set(projects.map((p) => String(p.id)));
        const seenBondIds = new Set<number>();

        for (const bond of bonds) {
          // Check duplicated bond IDs
          if (seenBondIds.has(bond.id)) {
            drifts.push({
              type: 'duplicate',
              severity: 'CRITICAL',
              entityType: 'bond',
              entityId: String(bond.id),
              description: `Duplicate bond ID detected: ${bond.id}`,
              affectedFields: ['id'],
              repairSuggestion: 'Deduplicate bond registry and re-verify authoritative contract state',
            });
          }
          seenBondIds.add(bond.id);

          // Check orphaned bond: references project that does not exist
          if (!projectIds.has(String(bond.projectId))) {
            drifts.push({
              type: 'orphaned',
              severity: 'HIGH',
              entityType: 'bond',
              entityId: String(bond.id),
              description: `Bond ${bond.id} references missing or un-restored project ${bond.projectId}`,
              affectedFields: ['projectId'],
              expectedValue: `Project exists in registry`,
              actualValue: bond.projectId,
              repairSuggestion: `Restore project record ${bond.projectId} from project registry backup or IPFS manifest`,
            });
          }
        }

        // Check project metadata completeness
        for (const project of projects) {
          if (!project.name || project.name.trim() === '') {
            drifts.push({
              type: 'missing',
              severity: 'MEDIUM',
              entityType: 'project',
              entityId: String(project.id),
              description: `Project ${project.id} is missing required name or metadata`,
              affectedFields: ['name'],
              repairSuggestion: 'Re-fetch project metadata from IPFS via stored CID',
            });
          }
        }

        return drifts;
      },
    };
  }

  /**
   * INVARIANT 2: Bond Supply & Investor Holding Invariant
   * Detects:
   * - Inconsistent supply: totalSubscribed > totalSupply
   * - Inconsistent balances: sum(holder balances) != totalSubscribed
   * - Inconsistent balance values: negative holder balance
   * - Missing / orphaned holder index references
   */
  getBondSupplyAccountingInvariant(): ReconciliationInvariant {
    return {
      name: 'BOND_SUPPLY_ACCOUNTING',
      description: 'Verifies that tokenized bond supply strictly equals sum of all investor holdings and <= authorized cap',
      check: async (context: ValidationContext = {}): Promise<ReconciliationDrift[]> => {
        const drifts: ReconciliationDrift[] = [];
        const bonds = context.bonds ?? (await this.loadBondsFromStore());

        for (const bond of bonds) {
          const totalSupply = BigInt(bond.totalSupply ?? 0);
          const totalSubscribed = BigInt(bond.totalSubscribed ?? 0);

          // 1. Supply cap check
          if (totalSubscribed > totalSupply) {
            drifts.push({
              type: 'inconsistent',
              severity: 'CRITICAL',
              entityType: 'bond',
              entityId: String(bond.id),
              description: `Bond ${bond.id} totalSubscribed (${totalSubscribed}) exceeds authorized totalSupply (${totalSupply})`,
              affectedFields: ['totalSubscribed', 'totalSupply'],
              expectedValue: `<= ${totalSupply}`,
              actualValue: totalSubscribed.toString(),
              repairSuggestion: 'Audit mint/subscription ledger transactions to revert over-allocated balance',
            });
          }

          // 2. Holder balances vs totalSubscribed check
          const holders = context.holdersByBond?.[bond.id] ?? (await this.loadHoldersForBond(bond.id));
          let sumBalances = 0n;
          const seenHolderAddresses = new Set<string>();

          for (const holder of holders) {
            const balance = BigInt(holder.balance ?? 0);

            // Duplicate holder record
            if (seenHolderAddresses.has(holder.address)) {
              drifts.push({
                type: 'duplicate',
                severity: 'HIGH',
                entityType: 'holder',
                entityId: `${bond.id}:${holder.address}`,
                description: `Duplicate holder entry for address ${holder.address} on bond ${bond.id}`,
                affectedFields: ['address'],
                repairSuggestion: 'Deduplicate holder index and consolidate balance',
              });
            }
            seenHolderAddresses.add(holder.address);

            // Negative balance (impossible invariant)
            if (balance < 0n) {
              drifts.push({
                type: 'inconsistent',
                severity: 'CRITICAL',
                entityType: 'holder',
                entityId: `${bond.id}:${holder.address}`,
                description: `Holder ${holder.address} on bond ${bond.id} has negative balance: ${balance}`,
                affectedFields: ['balance'],
                expectedValue: '>= 0',
                actualValue: balance.toString(),
                repairSuggestion: 'Correct holder balance from transaction journal',
              });
            }

            sumBalances += balance;
          }

          if (sumBalances !== totalSubscribed) {
            drifts.push({
              type: 'inconsistent',
              severity: 'CRITICAL',
              entityType: 'bond',
              entityId: String(bond.id),
              description: `Bond ${bond.id} holder balance sum (${sumBalances}) does not match recorded totalSubscribed (${totalSubscribed})`,
              affectedFields: ['totalSubscribed', 'holders.balance'],
              expectedValue: totalSubscribed.toString(),
              actualValue: sumBalances.toString(),
              repairSuggestion: 'Re-index on-chain holder balances via reindex-holders script',
            });
          }

          // 3. Maturity state consistency
          const nowSeconds = Math.floor(Date.now() / 1000);
          if (
            bond.status === BondStatusEnum.Matured &&
            bond.maturityDate &&
            nowSeconds < Number(bond.maturityDate) &&
            !bond.earlyMatured
          ) {
            drifts.push({
              type: 'inconsistent',
              severity: 'MEDIUM',
              entityType: 'bond',
              entityId: String(bond.id),
              description: `Bond ${bond.id} marked as Matured before its maturity date without early-redemption record`,
              affectedFields: ['status', 'maturityDate'],
              expectedValue: BondStatusEnum.Active,
              actualValue: bond.status,
              repairSuggestion: 'Verify on-chain contract maturity status and correct cached state',
            });
          }
        }

        return drifts;
      },
    };
  }

  /**
   * INVARIANT 3: Marketplace Order Book Integrity
   * Detects:
   * - Orphaned orders referencing non-existent bonds
   * - Duplicated order IDs
   * - Inconsistent order amounts (amount <= 0 or remaining negative)
   * - Stale open orders that exceeded expiration timestamp
   */
  getMarketplaceOrderIntegrityInvariant(): ReconciliationInvariant {
    return {
      name: 'MARKETPLACE_ORDER_INTEGRITY',
      description: 'Verifies secondary market order state consistency, valid bond references, and expiration status',
      check: async (context: ValidationContext = {}): Promise<ReconciliationDrift[]> => {
        const drifts: ReconciliationDrift[] = [];
        const orders = context.orders ?? (await this.loadOrdersFromStore());
        const bonds = context.bonds ?? (await this.loadBondsFromStore());
        const bondIds = new Set(bonds.map((b) => b.id));
        const seenOrderIds = new Set<number>();
        const nowSeconds = Math.floor(Date.now() / 1000);

        for (const order of orders) {
          // 1. Duplicate order ID
          if (seenOrderIds.has(order.id)) {
            drifts.push({
              type: 'duplicate',
              severity: 'HIGH',
              entityType: 'order',
              entityId: String(order.id),
              description: `Duplicate order ID detected: ${order.id}`,
              affectedFields: ['id'],
              repairSuggestion: 'Prune duplicate order entry and verify order sequence counter',
            });
          }
          seenOrderIds.add(order.id);

          // 2. Orphaned order: bond does not exist
          if (!bondIds.has(Number(order.bondId))) {
            drifts.push({
              type: 'orphaned',
              severity: 'HIGH',
              entityType: 'order',
              entityId: String(order.id),
              description: `Order ${order.id} references non-existent bond ${order.bondId}`,
              affectedFields: ['bondId'],
              expectedValue: 'Existing bond ID',
              actualValue: order.bondId,
              repairSuggestion: 'Cancel orphaned order and release any escrowed quote assets',
            });
          }

          // 3. Inconsistent order amount
          const amount = BigInt(order.amount ?? 0);
          if (amount <= 0n) {
            drifts.push({
              type: 'inconsistent',
              severity: 'HIGH',
              entityType: 'order',
              entityId: String(order.id),
              description: `Order ${order.id} has invalid non-positive amount: ${amount}`,
              affectedFields: ['amount'],
              expectedValue: '> 0',
              actualValue: amount.toString(),
              repairSuggestion: 'Cancel invalid order',
            });
          }

          // 4. Stale open order past expiry
          if (order.status === 'Open' && order.expiresAt) {
            const expiresSeconds = Math.floor(new Date(order.expiresAt).getTime() / 1000);
            if (expiresSeconds > 0 && nowSeconds > expiresSeconds) {
              drifts.push({
                type: 'stale',
                severity: 'LOW',
                entityType: 'order',
                entityId: String(order.id),
                description: `Order ${order.id} is marked Open but expired at ${order.expiresAt}`,
                affectedFields: ['status', 'expiresAt'],
                expectedValue: 'Expired',
                actualValue: order.status,
                repairSuggestion: 'Trigger cleanExpiredOrders job to sweep expired order',
              });
            }
          }
        }

        return drifts;
      },
    };
  }

  /**
   * INVARIANT 4: Settlement & Transaction Reference Integrity
   * Detects:
   * - Inconsistent transaction hashes (non-64 hex char strings)
   * - Duplicate settlement hashes across distinct transactions
   * - Missing transaction hashes on recorded state mutations
   */
  getSettlementReferenceIntegrityInvariant(): ReconciliationInvariant {
    return {
      name: 'SETTLEMENT_REFERENCE_INTEGRITY',
      description: 'Verifies cryptographic Stellar transaction hashes and prevents double-attribution collisions',
      check: async (context: ValidationContext = {}): Promise<ReconciliationDrift[]> => {
        const drifts: ReconciliationDrift[] = [];
        const txs = context.settlementTransactions ?? (await this.loadSettlementTransactions());

        const hashRegex = /^[0-9a-fA-F]{64}$/;
        const seenHashes = new Map<string, { entityType: string; entityId: string }>();

        for (const tx of txs) {
          if (!tx.txHash) {
            drifts.push({
              type: 'missing',
              severity: 'HIGH',
              entityType: tx.entityType,
              entityId: tx.entityId,
              description: `${tx.entityType} ${tx.entityId} has missing on-chain settlement transaction hash`,
              affectedFields: ['transactionHash'],
              repairSuggestion: 'Look up ledger sequence and backfill Stellar transaction hash',
            });
            continue;
          }

          // Format validation
          if (!hashRegex.test(tx.txHash)) {
            drifts.push({
              type: 'inconsistent',
              severity: 'CRITICAL',
              entityType: tx.entityType,
              entityId: tx.entityId,
              description: `Malformed transaction hash '${tx.txHash}' on ${tx.entityType} ${tx.entityId} (must be 64-char hex)`,
              affectedFields: ['transactionHash'],
              expectedValue: '64 hex characters',
              actualValue: tx.txHash,
              repairSuggestion: 'Re-query Horizon/RPC for the authoritative transaction hash',
            });
          }

          // Duplicate settlement reference across different entities
          if (seenHashes.has(tx.txHash)) {
            const original = seenHashes.get(tx.txHash)!;
            if (original.entityType !== tx.entityType || original.entityId !== tx.entityId) {
              drifts.push({
                type: 'duplicate',
                severity: 'CRITICAL',
                entityType: 'settlement_reference',
                entityId: tx.txHash,
                description: `Transaction hash ${tx.txHash} shared by multiple distinct operations (${original.entityType} ${original.entityId} and ${tx.entityType} ${tx.entityId})`,
                affectedFields: ['transactionHash'],
                repairSuggestion: 'Investigate potential replay attack or double-spending collision in ledger indexing',
              });
            }
          } else {
            seenHashes.set(tx.txHash, { entityType: tx.entityType, entityId: tx.entityId });
          }
        }

        return drifts;
      },
    };
  }

  /**
   * INVARIANT 5: KYC & Compliance Monotonic Audit Integrity
   * Detects:
   * - Inconsistent audit log timestamps (non-monotonic timestamps)
   * - Duplicate active KYC records for same wallet address
   * - Stale verification records that passed expiration timestamp
   */
  getKycComplianceIntegrityInvariant(): ReconciliationInvariant {
    return {
      name: 'KYC_COMPLIANCE_INTEGRITY',
      description: 'Verifies KYC record monotonicity, valid statuses, and absence of duplicate or conflicting identities',
      check: async (context: ValidationContext = {}): Promise<ReconciliationDrift[]> => {
        const drifts: ReconciliationDrift[] = [];
        const records = context.kycRecords ?? (await this.kycStore.list());
        const seenAddresses = new Set<string>();
        const validStatuses = new Set(Object.values(KycStatus));
        const now = Date.now();

        for (const record of records) {
          // 1. Duplicate active record
          if (seenAddresses.has(record.address)) {
            drifts.push({
              type: 'duplicate',
              severity: 'HIGH',
              entityType: 'kyc_record',
              entityId: record.address,
              description: `Duplicate KYC record found for wallet address: ${record.address}`,
              affectedFields: ['address'],
              repairSuggestion: 'Deduplicate KYC store snapshot to keep most recent valid status',
            });
          }
          seenAddresses.add(record.address);

          // 2. Status validation
          if (!validStatuses.has(record.status)) {
            drifts.push({
              type: 'inconsistent',
              severity: 'HIGH',
              entityType: 'kyc_record',
              entityId: record.address,
              description: `KYC record for ${record.address} has unrecognized status: ${record.status}`,
              affectedFields: ['status'],
              expectedValue: Array.from(validStatuses).join('|'),
              actualValue: record.status,
              repairSuggestion: 'Reset record to PENDING or re-verify with provider',
            });
          }

          // 3. Stale expiration check
          if (
            (record.status === KycStatus.VERIFIED || record.status === KycStatus.ACCREDITED) &&
            record.expiresAt &&
            record.expiresAt < now
          ) {
            drifts.push({
              type: 'stale',
              severity: 'MEDIUM',
              entityType: 'kyc_record',
              entityId: record.address,
              description: `KYC record for ${record.address} is marked ${record.status} but expired at ${new Date(record.expiresAt).toISOString()}`,
              affectedFields: ['status', 'expiresAt'],
              expectedValue: KycStatus.EXPIRED,
              actualValue: record.status,
              repairSuggestion: 'Transition status to EXPIRED to enforce re-verification',
            });
          }

          // 4. Audit trail monotonicity check
          try {
            const auditLogs = await this.kycStore.listAudit(record.address, 50);
            for (let i = 1; i < auditLogs.length; i++) {
              if (auditLogs[i].timestamp < auditLogs[i - 1].timestamp) {
                drifts.push({
                  type: 'inconsistent',
                  severity: 'MEDIUM',
                  entityType: 'kyc_audit',
                  entityId: record.address,
                  description: `Non-monotonic timestamp detected in KYC audit trail for ${record.address}`,
                  affectedFields: ['timestamp'],
                  repairSuggestion: 'Re-sort KYC audit log by timestamp',
                });
                break;
              }
            }
          } catch {
            // best effort for audit
          }
        }

        return drifts;
      },
    };
  }

  /**
   * Run full disaster recovery validation across all domain invariants (read-only by default).
   */
  async validateDomainInvariants(context: ValidationContext = {}): Promise<ReconciliationReport> {
    const startTime = Date.now();
    const driftsFound: ReconciliationDrift[] = [];
    const invariants = this.getAllInvariants();
    let totalEntities = 0;

    for (const invariant of invariants) {
      try {
        const drifts = await invariant.check(context);
        driftsFound.push(...drifts);
      } catch (err: any) {
        this.logger.error(`Error evaluating invariant ${invariant.name}: ${err.message}`, err.stack);
        driftsFound.push({
          type: 'inconsistent',
          severity: 'CRITICAL',
          entityType: invariant.name,
          entityId: 'SYSTEM_ERROR',
          description: `Invariant check failed: ${err.message}`,
        });
      }
    }

    const summary = {
      missingCount: driftsFound.filter((d) => d.type === 'missing').length,
      orphanedCount: driftsFound.filter((d) => d.type === 'orphaned').length,
      duplicateCount: driftsFound.filter((d) => d.type === 'duplicate').length,
      staleCount: driftsFound.filter((d) => d.type === 'stale').length,
      inconsistentCount: driftsFound.filter((d) => d.type === 'inconsistent').length,
    };

    const status = driftsFound.length === 0
      ? 'HEALTHY'
      : driftsFound.some((d) => d.severity === 'CRITICAL')
      ? 'CRITICAL'
      : 'DEGRADED';

    return {
      timestamp: new Date(),
      dryRun: true,
      totalEntitiesChecked: totalEntities,
      status,
      durationMs: Date.now() - startTime,
      driftsFound,
      summary,
    };
  }

  // Helper methods to read store state safely
  private async loadBondsFromStore(): Promise<any[]> {
    try {
      const keys = await this.redis.scanKeys('bond:*');
      const bondKeys = keys.filter((k: string) => /^bond:\d+$/.test(k));
      const bonds: any[] = [];
      for (const k of bondKeys) {
        const raw = await this.redis.get(k);
        if (raw) {
          try {
            bonds.push(JSON.parse(raw));
          } catch {}
        }
      }
      return bonds;
    } catch {
      return [];
    }
  }

  private async loadProjectsFromStore(): Promise<any[]> {
    try {
      const keys = await this.redis.scanKeys('project:*');
      const projectKeys = keys.filter((k: string) => /^project:[^:]+$/.test(k));
      const projects: any[] = [];
      for (const k of projectKeys) {
        const raw = await this.redis.get(k);
        if (raw) {
          try {
            projects.push(JSON.parse(raw));
          } catch {}
        }
      }
      return projects;
    } catch {
      return [];
    }
  }

  private async loadOrdersFromStore(): Promise<any[]> {
    try {
      const keys = await this.redis.scanKeys('order:*');
      const orderKeys = keys.filter((k: string) => /^order:\d+$/.test(k));
      const orders: any[] = [];
      for (const k of orderKeys) {
        const raw = await this.redis.get(k);
        if (raw) {
          try {
            orders.push(JSON.parse(raw));
          } catch {}
        }
      }
      return orders;
    } catch {
      return [];
    }
  }

  private async loadHoldersForBond(bondId: number): Promise<Array<{ address: string; balance: string }>> {
    try {
      const raw = await this.redis.get(`bond:${bondId}:holders`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
        if (Array.isArray(parsed?.holders)) return parsed.holders;
      }
      return [];
    } catch {
      return [];
    }
  }

  private async loadSettlementTransactions(): Promise<Array<{ txHash: string; entityType: string; entityId: string }>> {
    try {
      const keys = await this.redis.scanKeys('stellar:tx:*');
      const txs: Array<{ txHash: string; entityType: string; entityId: string }> = [];
      for (const k of keys) {
        const hash = k.replace('stellar:tx:', '');
        const raw = await this.redis.get(k);
        const parsed = raw ? JSON.parse(raw) : {};
        txs.push({
          txHash: hash,
          entityType: parsed.entityType ?? 'settlement',
          entityId: parsed.entityId ?? hash,
        });
      }
      return txs;
    } catch {
      return [];
    }
  }
}
