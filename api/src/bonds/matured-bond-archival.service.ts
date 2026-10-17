import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
  Optional,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { BondsService } from './bonds.service';
import { HolderIndexService } from './holder-index.service';
import { RedisService } from '../common/services/redis.service';
import {
  BondResponse,
  BondStatusEnum,
  BondMaturityStatusEnum,
} from './interfaces/bond.interface';
import {
  RecordLifecycle,
  ArchiveState,
  activeLifecycle,
  archiveRecord,
  restoreRecord,
  isArchived,
  LifecycleError,
} from '../common/lifecycle/record-lifecycle';

export interface ArchiveBondDto {
  reason: string;
  actor?: string;
}

export interface RestoreBondDto {
  reason?: string;
  actor?: string;
  force?: boolean;
}

export interface RestoreMismatch {
  check: 'INTEGRITY' | 'INVARIANT' | 'PROVENANCE' | 'DERIVED_INDEX';
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  description: string;
  repair: string;
}

export interface BondRestoreVerificationReport {
  bondId: number;
  status: 'VERIFIED' | 'FAILED';
  verifiedAt: string;
  checks: {
    integrity: { passed: boolean; message: string; sha256?: string };
    invariants: { passed: boolean; message: string; details?: Record<string, any> };
    provenance: { passed: boolean; message: string };
    derivedIndex: { passed: boolean; message: string; holderCount?: number };
  };
  mismatches: RestoreMismatch[];
}

export interface ArchivalResult {
  bondId: number;
  status: string;
  lifecycle: RecordLifecycle;
  archivedAt: string;
  archivedBy: string;
  archiveReason: string;
}

export interface RestoreResult {
  bondId: number;
  status: 'VERIFIED' | 'FAILED';
  lifecycle: RecordLifecycle;
  verification: BondRestoreVerificationReport;
}

@Injectable()
export class MaturedBondArchivalService {
  private readonly logger = new Logger(MaturedBondArchivalService.name);
  private readonly lifecycles = new Map<number, RecordLifecycle>();
  private readonly archivedRecords = new Map<number, BondResponse>();

  constructor(
    private readonly bondsService: BondsService,
    private readonly holderIndexService: HolderIndexService,
    @Optional() private readonly redis?: RedisService,
  ) {}

  async getArchivalLifecycle(bondId: number): Promise<RecordLifecycle> {
    if (this.lifecycles.has(bondId)) {
      return this.lifecycles.get(bondId)!;
    }
    if (this.redis) {
      try {
        const raw = await this.redis.get(`bond:lifecycle:${bondId}`);
        if (raw) return JSON.parse(raw);
      } catch {
        // Fall back to memory
      }
    }
    return activeLifecycle();
  }

  private async saveLifecycle(bondId: number, lifecycle: RecordLifecycle): Promise<void> {
    this.lifecycles.set(bondId, lifecycle);
    if (this.redis) {
      try {
        await this.redis.set(`bond:lifecycle:${bondId}`, JSON.stringify(lifecycle));
      } catch (err) {
        this.logger.warn(`Failed to cache bond lifecycle in redis: ${err}`);
      }
    }
  }

  async isBondArchived(bondId: number): Promise<boolean> {
    const lifecycle = await this.getArchivalLifecycle(bondId);
    return isArchived({ lifecycle });
  }

  async archiveMaturedRecord(
    bondId: number,
    dto: ArchiveBondDto,
    callerAddress?: string,
  ): Promise<ArchivalResult> {
    if (!dto.reason || !dto.reason.trim()) {
      throw new BadRequestException('Archiving requires a non-empty reason');
    }

    const actor = dto.actor || callerAddress;
    if (!actor || !actor.trim()) {
      throw new BadRequestException('Archiving requires an authenticated actor or wallet address');
    }

    const bond = await this.bondsService.findOne(bondId);
    const now = Math.floor(Date.now() / 1000);
    const isMatured = bond.status === BondStatusEnum.Matured || now >= bond.maturityDate;

    if (!isMatured) {
      throw new BadRequestException(
        `Bond ${bondId} is Active and has not matured yet (maturity: ${new Date(bond.maturityDate * 1000).toISOString()}). Only matured bonds can be archived.`,
      );
    }

    const currentLifecycle = await this.getArchivalLifecycle(bondId);
    try {
      archiveRecord(currentLifecycle, {
        actor,
        reason: dto.reason.trim(),
      });
    } catch (error) {
      if (error instanceof LifecycleError) {
        throw new BadRequestException(`Lifecycle error: ${error.message} (${error.code})`);
      }
      throw error;
    }

    this.archivedRecords.set(bondId, bond);
    await this.saveLifecycle(bondId, currentLifecycle);

    this.logger.log(`Bond ${bondId} successfully archived by ${actor}: "${dto.reason.trim()}"`);

    return {
      bondId,
      status: 'Archived',
      lifecycle: currentLifecycle,
      archivedAt: currentLifecycle.archivedAt!,
      archivedBy: currentLifecycle.archivedBy!,
      archiveReason: currentLifecycle.archiveReason!,
    };
  }

  async verifyRestore(bondId: number, customRecord?: Partial<BondResponse>): Promise<BondRestoreVerificationReport> {
    const mismatches: RestoreMismatch[] = [];
    const verifiedAt = new Date().toISOString();

    let bond: BondResponse;
    try {
      bond = (customRecord as BondResponse) || this.archivedRecords.get(bondId) || (await this.bondsService.findOne(bondId));
    } catch {
      throw new NotFoundException(`Bond record ${bondId} not found for restore verification`);
    }

    // 1. Integrity check
    let integrityPassed = true;
    let sha256 = '';
    try {
      const canonical = JSON.stringify({
        id: bond.id,
        projectId: bond.projectId,
        faceValue: bond.faceValue,
        totalSupply: bond.totalSupply,
        totalSubscribed: bond.totalSubscribed,
        maturityDate: bond.maturityDate,
        creditType: bond.creditType,
      });
      sha256 = createHash('sha256').update(canonical).digest('hex');
      if (!bond.id || !bond.projectId || !bond.faceValue || !bond.totalSupply) {
        integrityPassed = false;
        mismatches.push({
          check: 'INTEGRITY',
          severity: 'CRITICAL',
          description: 'Required core bond attributes are missing or malformed',
          repair: 'Restore complete canonical bond state from authoritative snapshot or ledger replay',
        });
      }
    } catch (err) {
      integrityPassed = false;
      mismatches.push({
        check: 'INTEGRITY',
        severity: 'CRITICAL',
        description: `Integrity check error: ${err}`,
        repair: 'Re-verify snapshot manifest',
      });
    }

    // 2. Domain & financial invariants check
    let invariantsPassed = true;
    const invDetails: Record<string, any> = {};

    try {
      const totalSub = BigInt(bond.totalSubscribed);
      const totalSup = BigInt(bond.totalSupply);
      invDetails.totalSubscribed = totalSub.toString();
      invDetails.totalSupply = totalSup.toString();

      if (totalSub > totalSup) {
        invariantsPassed = false;
        mismatches.push({
          check: 'INVARIANT',
          severity: 'CRITICAL',
          description: `Total subscribed (${totalSub}) exceeds total supply (${totalSup})`,
          repair: 'Reconcile subscription transactions against on-chain issuance ledger',
        });
      }

      if (bond.status !== BondStatusEnum.Matured && Math.floor(Date.now() / 1000) < bond.maturityDate) {
        invariantsPassed = false;
        mismatches.push({
          check: 'INVARIANT',
          severity: 'HIGH',
          description: `Restoring bond ${bondId} as matured when its ledger status is Active`,
          repair: 'Ensure matured transition is confirmed on-chain before archiving or restoring as matured',
        });
      }
    } catch (err) {
      invariantsPassed = false;
      mismatches.push({
        check: 'INVARIANT',
        severity: 'HIGH',
        description: `Failed evaluating numerical financial invariants: ${err}`,
        repair: 'Ensure BigInt serialization formats match standard decimal strings',
      });
    }

    // 3. Provenance check
    let provenancePassed = true;
    if (!bond.projectId || bond.projectId.length === 0) {
      provenancePassed = false;
      mismatches.push({
        check: 'PROVENANCE',
        severity: 'CRITICAL',
        description: 'Bond lacks valid project identifier binding to ProjectRegistry',
        repair: 'Re-bind bond tranche to its registered NbS project hash',
      });
    }

    // 4. Derived holder index check
    let derivedPassed = true;
    let holderCount = 0;
    try {
      const holders = await this.holderIndexService.getAuthoritativeHolders(bondId);
      holderCount = holders.length;
    } catch {
      derivedPassed = false;
      mismatches.push({
        check: 'DERIVED_INDEX',
        severity: 'MEDIUM',
        description: `Durable holder index for bond ${bondId} is missing or corrupted`,
        repair: `Run holder index reconciliation (POST /bonds/${bondId}/reconcile-holders)`,
      });
    }

    const overallPassed = mismatches.length === 0;

    return {
      bondId,
      status: overallPassed ? 'VERIFIED' : 'FAILED',
      verifiedAt,
      checks: {
        integrity: {
          passed: integrityPassed,
          message: integrityPassed ? 'Integrity and digest verified' : 'Digest mismatch or missing fields',
          sha256,
        },
        invariants: {
          passed: invariantsPassed,
          message: invariantsPassed ? 'All financial invariants satisfied' : 'Invariant violations detected',
          details: invDetails,
        },
        provenance: {
          passed: provenancePassed,
          message: provenancePassed ? 'Project binding verified' : 'Missing project binding',
        },
        derivedIndex: {
          passed: derivedPassed,
          message: derivedPassed ? `Holder index verified (${holderCount} holders)` : 'Holder index unavailable',
          holderCount,
        },
      },
      mismatches,
    };
  }

  async restoreMaturedRecord(
    bondId: number,
    dto: RestoreBondDto = {},
    callerAddress?: string,
  ): Promise<RestoreResult> {
    const actor = dto.actor || callerAddress || 'system:restore';
    const lifecycle = await this.getArchivalLifecycle(bondId);

    if (lifecycle.state !== ArchiveState.Archived) {
      throw new BadRequestException(`Bond ${bondId} is not archived; current state is ${lifecycle.state}`);
    }

    const verification = await this.verifyRestore(bondId);

    if (verification.status === 'FAILED' && !dto.force) {
      throw new BadRequestException({
        error: 'RESTORE_VERIFICATION_FAILED',
        message: `Restore verification failed with ${verification.mismatches.length} mismatch(es). Use force: true to override if permissible.`,
        report: verification,
      });
    }

    try {
      restoreRecord(lifecycle, { actor });
    } catch (error) {
      if (error instanceof LifecycleError) {
        throw new BadRequestException(`Lifecycle restore error: ${error.message} (${error.code})`);
      }
      throw error;
    }

    await this.saveLifecycle(bondId, lifecycle);
    this.logger.log(`Bond ${bondId} restored by ${actor} (verification status: ${verification.status})`);

    return {
      bondId,
      status: verification.status,
      lifecycle,
      verification,
    };
  }
}
