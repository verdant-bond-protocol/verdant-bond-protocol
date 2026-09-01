import { Injectable, BadRequestException, ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { createHash } from 'crypto';
import { ContractService } from '../stellar/contract.service';
import { IpfsService } from '../projects/ipfs.service';
import { NonceService } from '../common/services/nonce.service';
import { SubmitReportDto } from './dto/submit-report.dto';
import { ChallengeDto } from './dto/challenge.dto';
import { RegisterProviderDto } from './dto/register-provider.dto';
import {
  ReportResponse,
  ChallengeResponse,
  ProviderResponse,
  ProviderStatsWithHistory,
  SlashRecord,
  ChallengeRecord,
  ReportStatus,
  ChallengeStateResponse,
  ChallengedReportSummary,
  CouponEligibility,
} from './interfaces/oracle.interface';
import { RedisService } from '../common/services/redis.service';
import { SigningKeyProvider } from '../common/services/signing-key.provider';
import { nativeToScVal, scValToNative, Address, xdr } from '@stellar/stellar-sdk';
import { StellarService } from '../stellar/stellar.service';
import { toBigIntString, encodeCid } from '../common/utils';
import { ConfigService } from '../config/config.service';
import { verifyManifest, verifyManifestMatchesReport } from './manifest-verification';



@Injectable()
export class OracleService {
  /**
   * Methodologies backed by a registered OracleProviderAdapter (see
   * ./providers/*). Kept in sync manually since the adapters are wired up
   * as separate Nest providers rather than a discoverable registry.
   */
  private static readonly SUPPORTED_METHODOLOGIES = [
    'VERRA-VCS',
    'BLUE-CARBON',
    'REMOTE-SENSING',
  ];

  constructor(
    private readonly contractService: ContractService,
    private readonly ipfsService: IpfsService,
    private readonly stellarService: StellarService,
    private readonly nonceService: NonceService,
    private readonly redis: RedisService,
    private readonly signingKeys: SigningKeyProvider,
    private readonly configService: ConfigService,
  ) {}

async submitReport(dto: SubmitReportDto, providerAddress: string): Promise<ReportResponse> {
    if (dto.manifest) {
      const verification = verifyManifest(dto.manifest);
      if (!verification.valid) {
        throw new UnprocessableEntityException(
          `Manifest verification failed: ${verification.error}`,
        );
      }
      const matchVerification = verifyManifestMatchesReport(dto.manifest as any, {
        project_id: dto.projectId,
        methodology: dto.methodology,
        period_start: dto.periodStart,
        period_end: dto.periodEnd,
        carbon_sequestered: dto.carbonSequestered,
      });
      if (!matchVerification.valid) {
        throw new BadRequestException(
          `Manifest values do not match report submission: ${matchVerification.error}`,
        );
      }
    }

    const ipfsResult = await this.ipfsService.uploadJson({
      projectId: dto.projectId,
      periodStart: dto.periodStart,
      periodEnd: dto.periodEnd,
      carbonSequestered: dto.carbonSequestered,
      methodology: dto.methodology,
      evidenceHash: dto.evidenceHash,
      providerAddress,
      timestamp: new Date().toISOString(),
    });

    // Evidence hash resolution (#93): `evidenceHash`, when supplied, is
    // already format-validated by `SubmitReportDto`'s `@IsEvidenceReference`
    // decorator (rejected before this method -- and therefore before the
    // IPFS upload above or any contract call -- ever runs), and becomes the
    // on-chain evidence anchor. Otherwise, fall back to the hash of the
    // report metadata this call just pinned, exactly as before.
    const evidenceReference = dto.evidenceHash ?? ipfsResult.hash;

    if (dto.evidenceHash && this.shouldVerifyEvidenceRetrievability()) {
      await this.assertEvidenceRetrievable(dto.evidenceHash);
    }

    const adminSecret = this.getAdminSecret();

    const { result } = await this.contractService.invokeContractMethod(
      this.configService.getOracleConsumerAddress(), 'submit_report', adminSecret,
      [
        Address.fromString(providerAddress).toScVal(),
        this.toBytes32(dto.projectId),
        nativeToScVal(BigInt(dto.periodStart), { type: 'u64' }),
        nativeToScVal(BigInt(dto.periodEnd), { type: 'u64' }),
        nativeToScVal(BigInt(dto.carbonSequestered), { type: 'i128' }),
        nativeToScVal(dto.methodology, { type: 'symbol' }),
        this.evidenceHashToScVal(evidenceReference),
      ],
      providerAddress,
    );

    const reportId = Number(scValToNative(result));

    await this.redis.del(`reports:${dto.projectId}`);

    return {
      id: reportId,
      projectId: dto.projectId,
      periodStart: dto.periodStart,
      periodEnd: dto.periodEnd,
      carbonSequestered: toBigIntString(dto.carbonSequestered),
      methodology: dto.methodology,
      ipfsHash: ipfsResult.hash,
      providerAddress,
      status: ReportStatus.Pending,
      createdAt: new Date().toISOString(),
    };
  }

  async getProjectReports(projectId: string): Promise<ReportResponse[]> {
    const cacheKey = `reports:${projectId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const idsScVal = await this.contractService.simulateCall({
      contractAddress: this.configService.getOracleConsumerAddress(),
      method: 'get_project_reports',
      args: [this.toBytes32(projectId)],
    });
    const ids = scValToNative(idsScVal) as number[];

    const reports: ReportResponse[] = [];
    for (const reportId of ids) {
      try {
        const reportScVal = await this.contractService.simulateCall({
          contractAddress: this.configService.getOracleConsumerAddress(),
          method: 'get_report',
          args: [nativeToScVal(BigInt(reportId), { type: 'u64' })],
        });
        reports.push(this.decodeReport(scValToNative(reportScVal) as any[]));
      } catch {}
    }

    await this.redis.setEx(cacheKey, 60, JSON.stringify(reports));
    return reports;
  }

  /** Fetches a single report by id directly from the ledger. */
  async getReport(reportId: number): Promise<ReportResponse> {
    const reportScVal = await this.contractService.simulateCall({
      contractAddress: this.configService.getOracleConsumerAddress(),
      method: 'get_report',
      args: [nativeToScVal(BigInt(reportId), { type: 'u64' })],
    });
    return this.decodeReport(scValToNative(reportScVal) as any[]);
  }

  /**
   * Challenge review surface (#oracle-challenge): returns the report's status
   * plus every on-chain challenge record against it (counter-evidence hash,
   * challenger, submitted time, resolution). The report's provider address links
   * the report to its challenge history.
   */
  async getReportChallengeState(reportId: number): Promise<ChallengeStateResponse> {
    const report = await this.getReport(reportId);
    const challenges = (await this.getChallengeHistory(report.providerAddress)).filter(
      (c) => c.reportId === reportId,
    );
    return {
      reportId,
      status: report.status,
      challenged: report.status === ReportStatus.Challenged,
      challenges,
    };
  }

  /** Lists every challenged report for a project, each with its latest challenge record. */
  async getProjectChallengedReports(projectId: string): Promise<ChallengedReportSummary[]> {
    const reports = await this.getProjectReports(projectId);
    const challenged = reports.filter((r) => r.status === ReportStatus.Challenged);
    return Promise.all(
      challenged.map(async (report) => {
        const challenges = (await this.getChallengeHistory(report.providerAddress)).filter(
          (c) => c.reportId === report.id,
        );
        return { report, challenge: challenges[0] ?? null };
      }),
    );
  }

  /**
   * Coupon-distribution eligibility for a project (#oracle-challenge). A project
   * is eligible only when it has at least one Verified report and no report is
   * currently Challenged or Rejected. Distributing a coupon on disputed/rejected
   * data must be blocked.
   */
  async getCouponEligibility(projectId: string): Promise<CouponEligibility> {
    const reports = await this.getProjectReports(projectId);
    const reasons: string[] = [];
    const blockedByReportIds: number[] = [];

    const hasVerified = reports.some((r) => r.status === ReportStatus.Verified);
    const blocking = reports.filter(
      (r) => r.status === ReportStatus.Challenged || r.status === ReportStatus.Rejected,
    );
    const conflictingIds = new Set<number>();
    for (let i = 0; i < reports.length; i += 1) {
      for (let j = i + 1; j < reports.length; j += 1) {
        const left = reports[i];
        const right = reports[j];
        if (left.providerAddress === right.providerAddress
          && left.methodology === right.methodology
          && left.periodStart < right.periodEnd
          && right.periodStart < left.periodEnd) {
          conflictingIds.add(left.id);
          conflictingIds.add(right.id);
        }
      }
    }

    if (!hasVerified) {
      reasons.push('No verified oracle report exists for this project');
    }
    if (blocking.length > 0) {
      reasons.push(
        `${blocking.length} report(s) are challenged or rejected and must be resolved first`,
      );
      blockedByReportIds.push(...blocking.map((r) => r.id));
    }
    if (conflictingIds.size > 0) {
      reasons.push('Overlapping oracle report periods must be resolved before coupon distribution');
      blockedByReportIds.push(...conflictingIds);
    }

    const eligible = hasVerified && blocking.length === 0 && conflictingIds.size === 0;
    if (!eligible && reasons.length === 0) {
      reasons.push('Coupon distribution is not eligible for this project');
    }

    return { projectId, eligible, reasons, blockedByReportIds };
  }

async challengeReport(reportId: number, dto: ChallengeDto, challengerAddress: string): Promise<ChallengeResponse> {
    const adminSecret = this.getAdminSecret();

    await this.contractService.invokeContractMethod(
      this.configService.getOracleConsumerAddress(), 'challenge_report', adminSecret,
      [
        Address.fromString(challengerAddress).toScVal(),
        nativeToScVal(BigInt(reportId), { type: 'u64' }),
        this.toBytes32(dto.counterEvidenceHash),
      ],
      challengerAddress,
    );

    await this.redis.del(`oracle:providers`);

    return {
      reportId,
      challengerAddress,
      reason: dto.reason,
      counterEvidenceHash: dto.counterEvidenceHash,
      resolved: false,
      createdAt: new Date().toISOString(),
    };
  }

async registerProvider(dto: RegisterProviderDto): Promise<ProviderResponse> {
    const methodology = dto.methodology.trim().toUpperCase();
    if (!OracleService.SUPPORTED_METHODOLOGIES.includes(methodology)) {
      throw new BadRequestException(
        `Unsupported methodology "${dto.methodology}". Supported methodologies: ` +
          `${OracleService.SUPPORTED_METHODOLOGIES.join(', ')}.`,
      );
    }

    const existing = await this.findProvider(dto.providerAddress);
    if (existing) {
      if (existing.active) {
        throw new ConflictException(
          `Provider ${dto.providerAddress} is already registered with methodology "${existing.methodology}".`,
        );
      }
      // The contract has no reactivation path: register_provider rejects any
      // address already present in storage, active or not (see
      // OracleError::ProviderAlreadyExists in oracle-consumer/src/lib.rs).
      // Surface that distinctly so callers don't retry expecting it to work.
      throw new ConflictException(
        `Provider ${dto.providerAddress} was previously registered and removed. ` +
          'This contract does not support reactivating a removed provider; register a different address instead.',
      );
    }

    const adminSecret = this.getAdminSecret();
    const adminAddress = this.stellarService.getKeypairFromSecret(adminSecret).publicKey();

    await this.contractService.invokeContractMethod(
      this.configService.getOracleConsumerAddress(), 'register_provider', adminSecret,
      [
        Address.fromString(adminAddress).toScVal(),
        Address.fromString(dto.providerAddress).toScVal(),
        nativeToScVal(methodology, { type: 'symbol' }),
      ],
      adminAddress,
    );

    await this.redis.del(`oracle:providers`);

    return {
      providerAddress: dto.providerAddress,
      methodology,
      name: `Oracle ${dto.providerAddress.slice(0, 6)}`,
      active: true,
      registeredAt: new Date().toISOString(),
    };
  }

  /**
   * Looks up a provider's current on-chain state, or null if it has never
   * been registered. Used to validate registration intent before spending a
   * transaction on a call the contract would reject.
   */
  private async findProvider(
    providerAddress: string,
  ): Promise<{ methodology: string; active: boolean } | null> {
    try {
      const providerScVal = await this.contractService.simulateCall({
        contractAddress: this.configService.getOracleConsumerAddress(),
        method: 'get_provider',
        args: [Address.fromString(providerAddress).toScVal()],
      });
      const data = scValToNative(providerScVal) as any[];
      return {
        methodology: data[1] as string,
        active: data[3] as boolean,
      };
    } catch {
      return null;
    }
  }

  async listProviders(): Promise<ProviderResponse[]> {
    const cacheKey = 'oracle:providers';
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const listScVal = await this.contractService.simulateCall({
      contractAddress: this.configService.getOracleConsumerAddress(),
      method: 'list_providers',
      args: [],
    });
    const addresses = scValToNative(listScVal) as string[];

    const providers: ProviderResponse[] = [];
    for (const address of addresses) {
      try {
        const providerScVal = await this.contractService.simulateCall({
          contractAddress: this.configService.getOracleConsumerAddress(),
          method: 'get_provider',
          args: [Address.fromString(address).toScVal()],
        });
        const data = scValToNative(providerScVal) as any[];
        providers.push({
          providerAddress: data[0] as string,
          methodology: data[1] as string,
          name: `Oracle ${(data[0] as string).slice(0, 6)}`,
          active: data[3] as boolean,
          registeredAt: new Date(Number(data[4]) * 1000).toISOString(),
        });
      } catch {}
    }

    await this.redis.setEx(cacheKey, 120, JSON.stringify(providers));
    return providers;
  }

  async getProviderStats(providerAddress: string): Promise<ProviderStatsWithHistory> {
    const statsScVal = await this.contractService.simulateCall({
      contractAddress: this.configService.getOracleConsumerAddress(),
      method: 'get_provider_stats',
      args: [Address.fromString(providerAddress).toScVal()],
    });
    const stats = this.toRecord(scValToNative(statsScVal) as any);

    const slashScVal = await this.contractService.simulateCall({
      contractAddress: this.configService.getOracleConsumerAddress(),
      method: 'get_slash_history',
      args: [Address.fromString(providerAddress).toScVal()],
    });
    const challengeScVal = await this.contractService.simulateCall({
      contractAddress: this.configService.getOracleConsumerAddress(),
      method: 'get_challenge_history',
      args: [Address.fromString(providerAddress).toScVal()],
    });

    const slashHistory = this.toArray(scValToNative(slashScVal)).map((record) =>
      this.decodeSlashRecord(this.toRecord(record)),
    );
    const challengeHistory = this.toArray(scValToNative(challengeScVal)).map((record) =>
      this.decodeChallengeRecord(this.toRecord(record)),
    );

    return {
      providerAddress,
      reportsSubmitted: Number(this.field(stats, 'reports_submitted', 0)),
      challengesFaced: Number(this.field(stats, 'challenges_faced', 1)),
      slashes: Number(this.field(stats, 'slashes', 2)),
      totalPenalty: toBigIntString(this.field(stats, 'total_penalty', 3)),
      stake: toBigIntString(this.field(stats, 'stake', 4)),
      active: Boolean(this.field(stats, 'active', 5)),
      slashHistory,
      challengeHistory,
    };
  }

  async getSlashHistory(providerAddress: string): Promise<SlashRecord[]> {
    const scVal = await this.contractService.simulateCall({
      contractAddress: this.configService.getOracleConsumerAddress(),
      method: 'get_slash_history',
      args: [Address.fromString(providerAddress).toScVal()],
    });
    return this.toArray(scValToNative(scVal)).map((record) =>
      this.decodeSlashRecord(this.toRecord(record)),
    );
  }

  async getChallengeHistory(providerAddress: string): Promise<ChallengeRecord[]> {
    const scVal = await this.contractService.simulateCall({
      contractAddress: this.configService.getOracleConsumerAddress(),
      method: 'get_challenge_history',
      args: [Address.fromString(providerAddress).toScVal()],
    });
    return this.toArray(scValToNative(scVal)).map((record) =>
      this.decodeChallengeRecord(this.toRecord(record)),
    );
  }

  private decodeSlashRecord(record: Record<string, any>): SlashRecord {
    return {
      reportId: Number(this.field(record, 'report_id', 0)),
      penalty: toBigIntString(this.field(record, 'penalty', 1)),
      remainingStake: toBigIntString(this.field(record, 'remaining_stake', 2)),
      timestamp: new Date(Number(this.field(record, 'timestamp', 3)) * 1000).toISOString(),
      activeAfter: Boolean(this.field(record, 'active_after', 4)),
    };
  }

  private decodeChallengeRecord(record: Record<string, any>): ChallengeRecord {
    const resolution = Number(this.field(record, 'resolution', 5));
    return {
      reportId: Number(this.field(record, 'report_id', 0)),
      challengerAddress: String(this.field(record, 'challenger', 1)),
      counterEvidenceHash: Buffer.from(
        this.field(record, 'counter_evidence_hash', 2) as Uint8Array,
      ).toString('hex'),
      submittedAt: new Date(Number(this.field(record, 'submitted_at', 3)) * 1000).toISOString(),
      resolved: Boolean(this.field(record, 'resolved', 4)),
      resolution: resolution > 0 ? this.reportStatusFromIndex(resolution) : null,
    };
  }

  private toArray(value: unknown): any[] {
    return Array.isArray(value) ? value : [];
  }

  private toRecord(value: any): Record<string, any> {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value;
    }
    return {};
  }

  private field(record: Record<string, any>, key: string, index: number): any {
    if (record == null) return undefined;
    if (key in record) return record[key];
    const array = record as any;
    if (Array.isArray(array)) return array[index];
    return undefined;
  }

  private decodeReport(data: any): ReportResponse {
    const verifiedAtNum = Number(this.field(data, 'verified_at', 10));
    const stake = this.field(data, 'provider_stake_at_verification', 11);
    
    return {
      id: Number(this.field(data, 'id', 0)),
      providerAddress: this.field(data, 'provider', 1) as string,
      projectId: Buffer.from(this.field(data, 'project_id', 2) as Uint8Array).toString('hex'),
      periodStart: Number(this.field(data, 'period_start', 3)),
      periodEnd: Number(this.field(data, 'period_end', 4)),
      carbonSequestered: toBigIntString(this.field(data, 'carbon_sequestered', 5)),
      methodology: this.field(data, 'methodology', 6) as string,
      ipfsHash: Buffer.from(this.field(data, 'ipfs_evidence_hash', 7) as Uint8Array).toString('hex'),
      status: this.reportStatusFromIndex(Number(this.field(data, 'status', 8))),
      createdAt: new Date(Number(this.field(data, 'submitted_at', 9)) * 1000).toISOString(),
      verifiedAt: verifiedAtNum > 0
        ? new Date(verifiedAtNum * 1000).toISOString()
        : undefined,
      providerStakeAtVerification: stake != null ? toBigIntString(stake) : undefined,
    };
  }

  private reportStatusFromIndex(index: number): ReportStatus {
    return (
      [
        ReportStatus.Pending,
        ReportStatus.Verified,
        ReportStatus.Challenged,
        ReportStatus.Rejected,
      ][index] ?? ReportStatus.Pending
    );
  }

  private toBytes32(value: string): xdr.ScVal {
    const hex = Buffer.from(value, 'hex');
    const bytes = hex.length === 32 ? hex : createHash('sha256').update(value).digest();
    return xdr.ScVal.scvBytes(bytes);
  }

  /**
   * Encodes a validated evidence reference (CIDv0 or 64-char hex digest) to
   * the `BytesN<32>` argument `submit_report` expects (issue #93). Unlike
   * `toBytes32` above (still used for `projectId`, an arbitrary string
   * that is never a CID), this never silently substitutes a hash of the
   * input -- `encodeCid` throws for anything that isn't a supported,
   * correctly-sized evidence reference.
   */
  private evidenceHashToScVal(evidenceReference: string): xdr.ScVal {
    return xdr.ScVal.scvBytes(encodeCid(evidenceReference));
  }

  private shouldVerifyEvidenceRetrievability(): boolean {
    return process.env.ORACLE_EVIDENCE_VERIFY_RETRIEVABILITY === 'true';
  }

  /**
   * Bounded IPFS/gateway retrievability check (issue #93), off by default
   * and only ever invoked for a caller-supplied `evidenceHash` -- format
   * validation (see `SubmitReportDto`) is the only check that runs
   * unconditionally, so tests for it stay deterministic and
   * network-independent per this issue's contributor guidance. Only
   * meaningful for a CIDv0 reference: a bare hex digest names no gateway to
   * fetch from, so it is skipped rather than treated as unretrievable.
   */
  private async assertEvidenceRetrievable(evidenceHash: string): Promise<void> {
    if (!evidenceHash.startsWith('Qm')) return;

    const gateway = process.env.IPFS_GATEWAY || 'https://gateway.pinata.cloud/ipfs/';
    const timeoutMs = Number(process.env.ORACLE_EVIDENCE_RETRIEVABILITY_TIMEOUT_MS) || 5000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${gateway}${evidenceHash}`, { signal: controller.signal });
      if (!response.ok) {
        throw new UnprocessableEntityException(
          `Evidence ${evidenceHash} is not retrievable from the configured IPFS gateway (status ${response.status}).`,
        );
      }
    } catch (error) {
      if (error instanceof UnprocessableEntityException) throw error;
      throw new UnprocessableEntityException(
        `Evidence ${evidenceHash} could not be retrieved from the configured IPFS gateway: ${(error as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private getAdminSecret(): string {
    return this.signingKeys.adminSecret();
  }
}
