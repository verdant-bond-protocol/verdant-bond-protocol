import { Injectable, BadRequestException, Optional } from '@nestjs/common';
import { nativeToScVal, scValToNative, Address, xdr } from '@stellar/stellar-sdk';
import { ContractService } from '../stellar/contract.service';
import { ContractException } from '../stellar/contract-errors';
import { StellarService } from '../stellar/stellar.service';
import { NonceService } from '../common/services/nonce.service';
import { RedisService } from '../common/services/redis.service';
import { SigningKeyProvider } from '../common/services/signing-key.provider';
import { HolderIndexService } from './holder-index.service';
import { CreateBondDto } from './dto/create-bond.dto';
import { SubscribeDto } from './dto/subscribe.dto';
import { DistributeCouponDto } from './dto/distribute-coupon.dto';
import { ClaimCreditsDto } from './dto/claim-credits.dto';
import { TransferBondDto } from './dto/transfer-bond.dto';
import * as crypto from 'crypto';
import {
  BondResponse,
  HeldBondResponse,
  SubscriptionResponse,
  HolderListResponse,
  CouponDistributionResponse,
  ClaimCreditsResponse,
  TransferResponse,
  UndistributedTotalResponse,
  SweepUndistributedResponse,
  BondDetailResponse,
  BondStatusEnum,
  BondMaturityStatusEnum,
  CreditTypeEnum,
  ClaimableCreditDetail,
  ClaimableCreditsResponse,
} from './interfaces/bond.interface';
import { toBigIntString } from '../common/utils';
import { ConfigService } from '../config/config.service';
import { OracleService } from '../oracle/oracle.service';
import { ReportStatus } from '../oracle/interfaces/oracle.interface';

const BOND_ERROR_CODE = {
  NotInitialized: 1,
  Unauthorized: 2,
  InvalidNonce: 3,
  BondNotFound: 4,
  BondAlreadyMatured: 5,
  InsufficientSupply: 6,
  ZeroAmount: 7,
  ProjectNotApproved: 8,
  Overflow: 9,
  ReportNotVerified: 10,
};

@Injectable()
export class BondsService {
  constructor(
    private readonly contractService: ContractService,
    private readonly stellarService: StellarService,
    private readonly nonceService: NonceService,
    private readonly redis: RedisService,
    private readonly signingKeys: SigningKeyProvider,
    private readonly configService: ConfigService,
    private readonly holderIndex: HolderIndexService,
    @Optional() private readonly oracleService?: OracleService,
  ) {}

  async create(dto: CreateBondDto): Promise<BondResponse> {
    const adminSecret = this.getAdminSecret();
    const adminAddress = this.stellarService.getKeypairFromSecret(adminSecret).publicKey();

    const configScVal = this.encodeBondConfig(dto);

    const { result, transactionHash } = await this.contractService.invokeContractMethod(
      this.configService.getBondIssuerAddress(), 'issue_bond', adminSecret,
      [Address.fromString(adminAddress).toScVal(), configScVal],
      adminAddress,
    );

    const bondId = Number(scValToNative(result));
    const bond = await this.buildBondResponse(bondId);
    await this.redis.setEx(`bond:${bondId}`, 300, JSON.stringify(bond));
    return { ...bond, transactionHash };
  }

  async findAll(page = 1, limit = 20) {
    const cacheKey = `bonds:${page}:${limit}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const bonds: BondResponse[] = [];
    let total = 0;

    try {
      const countScVal = await this.contractService.simulateCall({
        contractAddress: this.configService.getBondIssuerAddress(), method: 'bond_count', args: [],
      });
      total = Number(scValToNative(countScVal));
    } catch {}

    const start = (page - 1) * limit;
    const end = Math.min(start + limit, total);

    for (let id = 1; id <= total; id++) {
      if (id > start && id <= end) {
        try {
          bonds.push(await this.buildBondResponse(id));
        } catch {}
      }
    }

    const result = {
      data: bonds,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
    };

    await this.redis.setEx(cacheKey, 60, JSON.stringify(result));
    return result;
  }

  async findOne(id: number): Promise<BondResponse> {
    const cached = await this.redis.get(`bond:${id}`);
    if (cached) return JSON.parse(cached);

    const bond = await this.buildBondResponse(id);
    await this.redis.setEx(`bond:${id}`, 300, JSON.stringify(bond));
    return bond;
  }

  async findHeldByAddress(address: string): Promise<HeldBondResponse[]> {
    try {
      Address.fromString(address);
    } catch {
      throw new BadRequestException('Invalid wallet address');
    }

    let total = 0;
    try {
      const countScVal = await this.contractService.simulateCall({
        contractAddress: this.configService.getBondIssuerAddress(), method: 'bond_count', args: [],
      });
      total = Number(scValToNative(countScVal));
    } catch {
      return [];
    }

    const heldBonds: HeldBondResponse[] = [];
    for (let id = 1; id <= total; id++) {
      try {
        const balanceScVal = await this.contractService.simulateCall({
          contractAddress: this.configService.getBondIssuerAddress(), method: 'get_holder_balance',
          args: [nativeToScVal(BigInt(id), { type: 'u64' }), Address.fromString(address).toScVal()],
        });
        const balance = toBigIntString(scValToNative(balanceScVal));
        if (balance !== '0') {
          heldBonds.push({ ...(await this.findOne(id)), balance });
        }
      } catch {}
    }

    return heldBonds;
  }

  async subscribe(id: number, dto: SubscribeDto): Promise<SubscriptionResponse> {
    const investorSecret = this.signingKeys.investorSecret();
    const { transactionHash } = await this.contractService.invokeContractMethod(
      this.configService.getBondIssuerAddress(), 'subscribe', investorSecret,
      [
        Address.fromString(dto.investorAddress).toScVal(),
        nativeToScVal(BigInt(id), { type: 'u64' }),
        nativeToScVal(BigInt(dto.amount), { type: 'i128' }),
      ],
      dto.investorAddress,
    );

    await this.redis.del(`bond:${id}`);
    await this.holderIndex.recordSubscribe(id, dto.investorAddress);
    this.invalidatePortfolio(dto.investorAddress);

    return { bondId: id, investorAddress: dto.investorAddress, amount: toBigIntString(dto.amount), transactionHash: transactionHash || '' };
  }

  async getHolders(id: number): Promise<HolderListResponse> {
    const holders = await this.holderIndex.getHoldersWithBalances(id);
    return { bondId: id, holders, total: holders.length };
  }

  /**
   * Atomically refresh every panel of a bond's detail (issue #4). Fetches the
   * bond summary, holders, and coupon undistributed total together and derives
   * a single maturity status, so callers never commit a mix of pre- and
   * post-mutation values. `loadedAt` lets the client refresh model detect
   * staleness against its own `lastLoadedAt`.
   */
  async getBondDetail(id: number): Promise<BondDetailResponse> {
    const bond = await this.buildBondResponse(id);
    const [holdersResponse, couponResponse] = await Promise.all([
      this.getHolders(id),
      this.getUndistributedTotal(id),
    ]);

    const now = Math.floor(Date.now() / 1000);
    const reached = bond.status === BondStatusEnum.Matured || now >= bond.maturityDate;
    const secondsUntil = reached ? 0 : bond.maturityDate - now;

    return {
      bond,
      holders: holdersResponse.holders,
      coupon: { undistributedTotal: couponResponse.undistributedTotal },
      maturity: { reached, date: bond.maturityDate, secondsUntil },
      loadedAt: new Date().toISOString(),
    };
  }

  async distributeCoupon(id: number, dto: DistributeCouponDto): Promise<CouponDistributionResponse> {
    const adminSecret = this.getAdminSecret();
    const adminAddress = this.stellarService.getKeypairFromSecret(adminSecret).publicKey();

    const holderAddresses = await this.holderIndex.getHoldersForCoupon(id, { requireFresh: true });
    // Challenge linkage (#oracle-challenge): a coupon pays out on the carbon
    // data in the referenced oracle report. If that report is Challenged or
    // Rejected, the data is disputed and must not be paid on, so block before
    // any contract call is made. The oracle dependency is optional so the bond
    // module keeps working where the oracle module is not wired in.
    if (this.oracleService) {
      const report = await this.oracleService.getReport(dto.reportId);
      if (report.status === ReportStatus.Challenged) {
        throw new BadRequestException(
          `Cannot distribute coupon: report ${report.id} is currently Challenged. ` +
            'Resolve the challenge before distributing.',
        );
      }
      if (report.status === ReportStatus.Rejected) {
        throw new BadRequestException(`Cannot distribute coupon: report ${report.id} was Rejected.`);
      }
    }

    const { result } = await this.contractService.invokeContractMethod(
      this.configService.getCouponEngineAddress(), 'distribute_coupon', adminSecret,
      [
        Address.fromString(adminAddress).toScVal(),
        nativeToScVal(BigInt(id), { type: 'u64' }),
        nativeToScVal(dto.periodIndex, { type: 'u32' }),
        xdr.ScVal.scvVec(holderAddresses.map((h) => Address.fromString(h).toScVal())),
        nativeToScVal(BigInt(dto.reportId), { type: 'u64' }),
      ],
      adminAddress,
    );

    const parsed = scValToNative(result) as any[];
    return {
      bondId: id,
      periodIndex: dto.periodIndex,
      totalCredits: toBigIntString(parsed?.[2] ?? 0),
      holderCount: Number(parsed?.[3] ?? 0),
    };
  }

  async claimCredits(id: number, dto: ClaimCreditsDto): Promise<ClaimCreditsResponse> {
    const investorSecret = this.signingKeys.investorSecret();

    const { result, transactionHash } = await this.contractService.invokeContractMethod(
      this.configService.getCouponEngineAddress(), 'claim_credits', investorSecret,
      [
        Address.fromString(dto.investorAddress).toScVal(),
        nativeToScVal(BigInt(id), { type: 'u64' }),
      ],
      dto.investorAddress,
    );

    this.invalidatePortfolio(dto.investorAddress);

    return {
      bondId: id,
      investorAddress: dto.investorAddress,
      credits: toBigIntString(scValToNative(result)),
      transactionHash: transactionHash || '',
    };
  }

  async transfer(id: number, dto: TransferBondDto): Promise<TransferResponse> {
    const investorSecret = this.signingKeys.investorSecret();

    const { transactionHash } = await this.contractService.invokeContractMethod(
      this.configService.getBondIssuerAddress(), 'transfer', investorSecret,
      [
        Address.fromString(dto.fromAddress).toScVal(),
        Address.fromString(dto.toAddress).toScVal(),
        nativeToScVal(BigInt(id), { type: 'u64' }),
        nativeToScVal(BigInt(dto.amount), { type: 'i128' }),
      ],
      dto.fromAddress,
    );

    await this.holderIndex.recordTransfer(id, dto.fromAddress, dto.toAddress);
    this.invalidatePortfolio(dto.fromAddress);
    this.invalidatePortfolio(dto.toAddress);

    return {
      bondId: id,
      fromAddress: dto.fromAddress,
      toAddress: dto.toAddress,
      amount: toBigIntString(dto.amount),
      transactionHash: transactionHash || '',
    };
  }

  /**
   * Operational repair (#117): reconcile the authoritative holder index for a
   * single bond against on-chain balances, rediscovering any out-of-band
   * transfers. Returns the reconciled holder list.
   */
  async reconcileBond(id: number): Promise<HolderListResponse> {
    const holders = await this.holderIndex.reconcileBond(id);
    return { bondId: id, holders, total: holders.length };
  }

  /**
   * Operational repair (#117): reindex every bond against on-chain balances.
   * Use after Redis loss or when direct contract transfers may have occurred.
   */
  async reindexHolders(): Promise<Array<{ bondId: number; total: number }>> {
    let total = 0;
    try {
      const countScVal = await this.contractService.simulateCall({
        contractAddress: this.configService.getBondIssuerAddress(), method: 'bond_count', args: [],
      });
      total = Number(scValToNative(countScVal));
    } catch {}

    const result = await this.holderIndex.reindexAll(total);
    return Object.entries(result).map(([bondId, holders]) => ({ bondId: Number(bondId), total: holders.length }));
  }

  async getUndistributedTotal(id: number): Promise<UndistributedTotalResponse> {
    const resultScVal = await this.contractService.simulateCall({
      contractAddress: this.configService.getCouponEngineAddress(), method: 'get_undistributed_total',
      args: [nativeToScVal(BigInt(id), { type: 'u64' })],
    });

    return {
      bondId: id,
      undistributedTotal: toBigIntString(scValToNative(resultScVal)),
    };
  }

  /**
   * Aggregate of claimable coupon credits for a wallet across every bond it
   * holds. Best-effort: bonds whose coupon engine call fails are skipped so a
   * single unreadable period cannot blank the whole portfolio view.
   */
  async getClaimableCredits(
    address: string,
  ): Promise<Array<{ bondId: number; amount: string }>> {
    try {
      Address.fromString(address);
    } catch {
      throw new BadRequestException('Invalid wallet address');
    }

    const held = await this.findHeldByAddress(address);
    const out: Array<{ bondId: number; amount: string }> = [];
    for (const bond of held) {
      try {
        const scVal = await this.contractService.simulateCall({
          contractAddress: this.configService.getCouponEngineAddress(),
          method: 'claimable_credits',
          args: [nativeToScVal(BigInt(bond.id), { type: 'u64' }), Address.fromString(address).toScVal()],
        });
        const amount = toBigIntString(scValToNative(scVal));
        if (amount !== '0') out.push({ bondId: bond.id, amount });
      } catch {}
    }
    return out;
  }

  /**
   * Itemized claimable-credit provenance for a single holder on a single bond
   * (issue #156). Surfaces every period/report/type line so the UI can group
   * claimable credits exactly as `claim_credits` clears them.
   */
  async getClaimableCreditDetails(
    bondId: number,
    address?: string,
  ): Promise<ClaimableCreditsResponse> {
    if (!address) {
      throw new BadRequestException('Wallet address is required');
    }
    try {
      Address.fromString(address);
    } catch {
      throw new BadRequestException('Invalid wallet address');
    }

    const scVal = await this.contractService.simulateCall({
      contractAddress: this.configService.getCouponEngineAddress(),
      method: 'claimable_credit_details',
      args: [nativeToScVal(BigInt(bondId), { type: 'u64' }), Address.fromString(address).toScVal()],
    });

    const raw = scValToNative(scVal);
    const details = Array.isArray(raw)
      ? raw.map((entry) => decodeClaimableCreditDetail(entry))
      : [];

    const total = details.reduce((sum, line) => sum + BigInt(line.amount), 0n);
    return { bondId, address, total: total.toString(), details };
  }

  /**
   * All credit retirement records belonging to a wallet, used by the portfolio
   * aggregate view.
   */
  async getRetiredCredits(
    address: string,
  ): Promise<Array<{ id: number; bondId: number; amount: string; creditType: string; retiredAt: number }>> {
    try {
      Address.fromString(address);
    } catch {
      throw new BadRequestException('Invalid wallet address');
    }

    const out: Array<{ id: number; bondId: number; amount: string; creditType: string; retiredAt: number }> = [];
    try {
      const countScVal = await this.contractService.simulateCall({
        contractAddress: this.configService.getCreditRetirementAddress(),
        method: 'total_retirements',
        args: [],
      });
      const total = Number(scValToNative(countScVal));
      for (let id = 1; id <= total; id++) {
        try {
          const recScVal = await this.contractService.simulateCall({
            contractAddress: this.configService.getCreditRetirementAddress(),
            method: 'get_retirement_record',
            args: [nativeToScVal(BigInt(id), { type: 'u64' })],
          });
          const record = scValToNative(recScVal) as any[];
          const holder = (record[1] as any)?.toString?.() ?? '';
          if (holder !== address) continue;
          out.push({
            id: Number(record[0]),
            bondId: Number(record[2]),
            amount: toBigIntString(record[3]),
            creditType: record[4] as string,
            retiredAt: Number(record[5]),
          });
        } catch {}
      }
    } catch {}
    return out;
  }

  /** Invalidate the cached portfolio aggregate for a wallet (#116). */
  private invalidatePortfolio(address: string): void {
    if (!address) return;
    this.redis.del(`portfolio:${address}`).catch(() => undefined);
  }

  async sweepUndistributed(id: number): Promise<SweepUndistributedResponse> {
    const adminSecret = this.getAdminSecret();
    const adminAddress = this.stellarService.getKeypairFromSecret(adminSecret).publicKey();

    const { result, transactionHash } = await this.contractService.invokeContractMethod(
      this.configService.getCouponEngineAddress(), 'sweep_undistributed', adminSecret,
      [
        Address.fromString(adminAddress).toScVal(),
        nativeToScVal(BigInt(id), { type: 'u64' }),
      ],
      adminAddress,
    );

    return {
      bondId: id,
      swept: toBigIntString(scValToNative(result)),
      transactionHash: transactionHash || '',
    };
  }

  async mature(id: number): Promise<BondResponse> {
    const adminSecret = this.getAdminSecret();
    const adminAddress = this.stellarService.getKeypairFromSecret(adminSecret).publicKey();

    try {
      await this.contractService.invokeContractMethod(
        this.configService.getBondIssuerAddress(), 'mature_bond', adminSecret,
        [Address.fromString(adminAddress).toScVal(), nativeToScVal(BigInt(id), { type: 'u64' })],
        adminAddress,
      );
    } catch (error) {
      throw this.mapBondError(error, id);
    }

    await this.redis.del(`bond:${id}`);
    await this.redis.delPattern('portfolio:*').catch(() => undefined);
    return this.buildBondResponse(id);
  }

  private encodeBondConfig(dto: CreateBondDto): xdr.ScVal {
    return xdr.ScVal.scvVec([
      xdr.ScVal.scvBytes(Buffer.from(dto.projectId, 'hex')),
      nativeToScVal(BigInt(dto.faceValue), { type: 'i128' }),
      xdr.ScVal.scvVec(dto.couponSchedule.map((ts) => nativeToScVal(BigInt(ts), { type: 'u64' }))),
      nativeToScVal(dto.creditType, { type: 'symbol' }),
      nativeToScVal(BigInt(dto.maturityDate), { type: 'u64' }),
      nativeToScVal(BigInt(dto.totalSupply), { type: 'i128' }),
    ]);
  }

  private async buildBondResponse(id: number): Promise<BondResponse> {
    const configScVal = await this.contractService.simulateCall({
      contractAddress: this.configService.getBondIssuerAddress(), method: 'get_bond',
      args: [nativeToScVal(BigInt(id), { type: 'u64' })],
    });
    const config = scValToNative(configScVal) as any[];

    const stateScVal = await this.contractService.simulateCall({
      contractAddress: this.configService.getBondIssuerAddress(), method: 'get_bond_state',
      args: [nativeToScVal(BigInt(id), { type: 'u64' })],
    });
    const state = scValToNative(stateScVal) as any[];

    const status = state[1] as BondStatusEnum;
    const maturityDate = Number(config[4]);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const maturityStatus =
      status === BondStatusEnum.Matured || nowSeconds >= maturityDate
        ? BondMaturityStatusEnum.Matured
        : BondMaturityStatusEnum.Active;

    return {
      id,
      projectId: Buffer.from(config[0] as Uint8Array).toString('hex'),
      faceValue: toBigIntString(config[1]),
      couponSchedule: (config[2] as any[]).map((v: bigint) => toBigIntString(v)),
      creditType: config[3] as CreditTypeEnum,
      maturityDate,
      maturityStatus,
      totalSupply: toBigIntString(config[5]),
      totalSubscribed: toBigIntString(state[0]),
      status,
      createdAt: new Date(Number(state[2]) * 1000).toISOString(),
    };
  }

  private mapBondError(error: unknown, bondId: number): any {
    if (error instanceof ContractException) {
      const code = error.rawErrorCode as number | undefined;
      if (code === BOND_ERROR_CODE.BondAlreadyMatured) {
        return new BadRequestException(`Bond ${bondId} is already matured`);
      }
      if (code === BOND_ERROR_CODE.BondNotFound) {
        return new BadRequestException(`Bond ${bondId} not found`);
      }
      return new BadRequestException(error.detail || String(error.message));
    }

    if (error instanceof Error) {
      return error;
    }

    return new BadRequestException('Failed to mature bond');
  }

  async exportBond(bondId: number, auditorAddress: string): Promise<any> {
    // 1. Fetch bond config & state
    const configScVal = await this.contractService.simulateCall({
      contractAddress: this.configService.getBondIssuerAddress(),
      method: 'get_bond',
      args: [nativeToScVal(BigInt(bondId), { type: 'u64' })],
    });
    const config = scValToNative(configScVal) as any[];
    if (!config || config.length === 0) {
      throw new BadRequestException('Bond not found');
    }

    const stateScVal = await this.contractService.simulateCall({
      contractAddress: this.configService.getBondIssuerAddress(),
      method: 'get_bond_state',
      args: [nativeToScVal(BigInt(bondId), { type: 'u64' })],
    });
    const state = scValToNative(stateScVal) as any[];

    const bondData = {
      id: bondId,
      projectRegistryId: Buffer.from(config[0] as Uint8Array).toString('hex'),
      faceValue: toBigIntString(config[1]),
      couponSchedule: (config[2] as any[]).map((t) => Number(t)),
      creditType: config[3],
      maturityDate: Number(config[4]),
      totalSupply: toBigIntString(config[5]),
      totalSubscribed: toBigIntString(state[0]),
      status: state[1],
      createdAt: new Date(Number(state[2]) * 1000).toISOString(),
    };

    // 2. Lifecycle events
    const lifecycleEvents: any[] = [
      {
        event: 'ISSUED',
        timestamp: bondData.createdAt,
        details: { totalSupply: bondData.totalSupply },
      },
    ];
    if (Number(state[1]) === 1) { // Matured
      lifecycleEvents.push({
        event: 'MATURED',
        timestamp: new Date(Number(config[4]) * 1000).toISOString(),
        details: {},
      });
    }

    // 3. Holders list
    const holdersResponse = await this.getHolders(bondId);
    const holders = holdersResponse.holders || [];

    // 4. Coupon distributions
    const couponDistributions: any[] = [];
    const scheduleLength = bondData.couponSchedule.length;
    for (let period = 0; period < scheduleLength; period++) {
      try {
        const periodInfoScVal = await this.contractService.simulateCall({
          contractAddress: this.configService.getCouponEngineAddress(),
          method: 'get_period_info',
          args: [
            nativeToScVal(BigInt(bondId), { type: 'u64' }),
            nativeToScVal(period, { type: 'u32' }),
          ],
        });
        const periodInfo = scValToNative(periodInfoScVal) as any[];
        if (periodInfo && periodInfo[4]) { // distributed is true
          couponDistributions.push({
            periodIndex: Number(periodInfo[0]),
            startTime: Number(periodInfo[1]),
            endTime: Number(periodInfo[2]),
            totalCreditsEarned: toBigIntString(periodInfo[3]),
            reportId: Number(periodInfo[5]),
            undistributed: toBigIntString(periodInfo[6]),
          });
        }
      } catch {}
    }

    // 5. Credit retirements
    const retirements: any[] = [];
    try {
      const countScVal = await this.contractService.simulateCall({
        contractAddress: this.configService.getCreditRetirementAddress(),
        method: 'total_retirements',
        args: [],
      });
      const totalRetirements = Number(scValToNative(countScVal));
      for (let retId = 1; retId <= totalRetirements; retId++) {
        try {
          const recScVal = await this.contractService.simulateCall({
            contractAddress: this.configService.getCreditRetirementAddress(),
            method: 'get_retirement_record',
            args: [nativeToScVal(BigInt(retId), { type: 'u64' })],
          });
          const record = scValToNative(recScVal) as any[];
          if (Number(record[2]) === bondId) {
            retirements.push({
              id: Number(record[0]),
              holder: (record[1] as any).toString?.() || '',
              amount: toBigIntString(record[3]),
              creditType: record[4],
              retiredAt: Number(record[5]),
              certificateIpfsHash: Buffer.from(record[6] as Uint8Array).toString('hex'),
            });
          }
        } catch {}
      }
    } catch {}

    // 6. Construct payload & checksum
    const payload: any = {
      generationMetadata: {
        timestamp: new Date().toISOString(),
        exporterAddress: auditorAddress || 'system',
        version: '1.0.0',
      },
      bond: bondData,
      lifecycleEvents,
      holders,
      couponDistributions,
      retirements,
    };

    // Calculate sha256 checksum over sorted payload fields
    const sortedData = JSON.stringify(payload, Object.keys(payload).sort());
    payload.generationMetadata.checksum = crypto
      .createHash('sha256')
      .update(sortedData)
      .digest('hex');

    return payload;
  }

  private getAdminSecret(): string {
    return this.signingKeys.adminSecret();
  }
}

/** Coerce a bigint/number SCVal field into a JS number. */
function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return Number(value ?? 0);
}

/**
 * Defensively decode a single `ClaimableCreditDetail` tuple. The contracttype
 * struct round-trips as either an object (map form) or a positional array,
 * depending on the XDR encoder version.
 */
function decodeClaimableCreditDetail(raw: unknown): ClaimableCreditDetail {
  if (Array.isArray(raw)) {
    const [periodIndex, reportId, startTime, endTime, creditType, amount] = raw;
    return {
      periodIndex: toNumber(periodIndex),
      reportId: toNumber(reportId),
      startTime: toNumber(startTime),
      endTime: toNumber(endTime),
      creditType: String(creditType),
      amount: toBigIntString(amount),
    };
  }

  const entry = (raw ?? {}) as Record<string, unknown>;
  const pick = (key: string) => entry[key] ?? entry[toCamelCase(key)];
  return {
    periodIndex: toNumber(pick('period_index')),
    reportId: toNumber(pick('report_id')),
    startTime: toNumber(pick('start_time')),
    endTime: toNumber(pick('end_time')),
    creditType: String(pick('credit_type') ?? ''),
    amount: toBigIntString(toBigint(pick('amount'))),
  };
}

function toCamelCase(key: string): string {
  return key.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

/** Coerce an SCVal amount field into a bigint for string serialization. */
function toBigint(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  if (typeof value === 'string') {
    try {
      return BigInt(value);
    } catch {
      return 0n;
    }
  }
  return 0n;
}
