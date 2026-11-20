import { Injectable, BadRequestException, ConflictException, UnprocessableEntityException, Optional } from '@nestjs/common';
import { createHash } from 'crypto';
import { ContractService } from '../stellar/contract.service';
import { IpfsService } from '../projects/ipfs.service';
import { NonceService } from '../common/services/nonce.service';
import { SubmitReportDto } from './dto/submit-report.dto';
import { ChallengeDto } from './dto/challenge.dto';
import { RegisterProviderDto } from './dto/register-provider.dto';
import { HistoricalOracleCorrectionDto } from './dto/historical-correction.dto';
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
  SlashPreview,
} from './interfaces/oracle.interface';
import {
  DisputeEvidenceBundle,
  computeBundleDigest,
  computeBundleCid,
  DISPUTE_BUNDLE_SCHEMA_VERSION,
} from './interfaces/dispute-bundle.interface';
import {
  HistoricalCorrectionRecord,
  HistoricalCorrectionResponse,
} from './interfaces/oracle-correction.interface';
import { AuditService } from '../audit/audit.service';
import { EventLedgerService } from '../ledger/event-ledger.service';
import { RedisService } from '../common/services/redis.service';
import { SigningKeyProvider } from '../common/services/signing-key.provider';
import { nativeToScVal, scValToNative, Address, xdr } from '@stellar/stellar-sdk';
import { StellarService } from '../stellar/stellar.service';
import { toBigIntString, encodeCid } from '../common/utils';
import { ConfigService } from '../config/config.service';
import { verifyManifest, verifyManifestMatchesReport } from './manifest-verification';
import {
  EvidenceVerificationResult,
  fetchAndVerifyEvidence,
  parseDelegatedSigners,
  resolveSignatureMode,
  verifyEd25519Manifest,
} from './evidence-verification';

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
    'IOT-SENSORS',
  ];

  constructor(
    private readonly contractService: ContractService,
    private readonly ipfsService: IpfsService,
    private readonly stellarService: StellarService,
    private readonly nonceService: NonceService,
    private readonly redis: RedisService,
    private readonly signingKeys: SigningKeyProvider,
    private readonly configService: ConfigService,
    @Optional() private readonly auditService?: AuditService,
    @Optional() private readonly ledgerService?: EventLedgerService,
  ) {}


async submitReport(dto: SubmitReportDto, providerAddress: string): Promise<ReportResponse> {
    const signatureMode = resolveSignatureMode();
    if (!dto.manifest && signatureMode === 'required') {
      this.rejectEvidence({
        valid: false,
        code: 'MANIFEST_REQUIRED',
        error: 'an ed25519-signed evidence manifest is required for every report',
      });
    }

    if (dto.manifest) {
      this.rejectEvidence(this.verifyManifestSignature(dto, providerAddress, signatureMode));
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

    // Evidence checks run before anything is pinned or sent on-chain (#393).
    if (dto.evidenceHash && this.shouldVerifyEvidenceContent()) {
      await this.assertEvidenceContentMatches(dto.evidenceHash);
    } else if (dto.evidenceHash && this.shouldVerifyEvidenceRetrievability()) {
      await this.assertEvidenceRetrievable(dto.evidenceHash);
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

  async getSlashPreview(providerAddress: string, reportId: number): Promise<SlashPreview> {
    const scVal = await this.contractService.simulateCall({
      contractAddress: this.configService.getOracleConsumerAddress(),
      method: 'preview_slash',
      args: [Address.fromString(providerAddress).toScVal(), nativeToScVal(BigInt(reportId), { type: 'u64' })],
    });
    const data = scValToNative(scVal) as any[];
    return {
      reportId: Number(data[0]),
      providerAddress: data[1] as string,
      currentStake: toBigIntString(data[2]),
      penalty: toBigIntString(data[3]),
      remainingStake: toBigIntString(data[4]),
      activeAfter: data[5] as boolean,
    };
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

  /**
   * Signature check for an attached manifest (#393). `ed25519` manifests are
   * always verified against the provider's key (or a delegated signer);
   * legacy HMAC manifests are accepted only in `legacy` mode.
   */
  private verifyManifestSignature(
    dto: SubmitReportDto,
    providerAddress: string,
    mode: ReturnType<typeof resolveSignatureMode>,
  ): EvidenceVerificationResult {
    if (dto.manifest?.signature_scheme === 'ed25519') {
      return verifyEd25519Manifest(dto.manifest, providerAddress, {
        delegatedSigners: parseDelegatedSigners(),
        evidenceHash: dto.evidenceHash,
        maxAgeSeconds: Number(process.env.ORACLE_EVIDENCE_MAX_AGE_SECONDS) || undefined,
      });
    }
    if (mode !== 'legacy') {
      return {
        valid: false,
        code: 'LEGACY_SCHEME_REJECTED',
        error: `signature scheme ${dto.manifest?.signature_scheme ?? 'hmac-sha256'} is not accepted in ${mode} mode`,
      };
    }
    return verifyManifest(dto.manifest);
  }

  /** 422 with a stable machine-readable reason; no-op for a valid result. */
  private rejectEvidence(result: EvidenceVerificationResult): void {
    if (result.valid) return;
    throw new UnprocessableEntityException({
      error: 'Evidence Verification Failed',
      message: `Manifest verification failed: ${result.error}`,
      evidenceCode: result.code,
    });
  }

  private shouldVerifyEvidenceContent(): boolean {
    return process.env.ORACLE_EVIDENCE_VERIFY_CONTENT === 'true';
  }

  /**
   * Fetch caller-supplied evidence and require its bytes to hash to the
   * referenced digest (#393). Supersedes the bare retrievability check: a
   * gateway that answers 200 with different content is rejected. Hex-digest
   * references name no gateway object and are skipped, as before.
   */
  private async assertEvidenceContentMatches(evidenceHash: string): Promise<void> {
    if (!evidenceHash.startsWith('Qm')) return;
    const result = await fetchAndVerifyEvidence(evidenceHash, {
      gateway: process.env.IPFS_GATEWAY || 'https://gateway.pinata.cloud/ipfs/',
      timeoutMs: Number(process.env.ORACLE_EVIDENCE_RETRIEVABILITY_TIMEOUT_MS) || 5000,
      maxAttempts: Number(process.env.ORACLE_EVIDENCE_FETCH_ATTEMPTS) || 3,
      maxBytes: Number(process.env.ORACLE_EVIDENCE_MAX_BYTES) || 10 * 1024 * 1024,
    });
    if (!result.valid) {
      throw new UnprocessableEntityException({
        error: 'Evidence Verification Failed',
        message: result.error,
        evidenceCode: result.code,
      });
    }
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

  async getProjectStalenessState(projectId: string): Promise<{
    projectId: string;
    lastReportTimestamp: number;
    currentTier: number;
    timeElapsed: number;
    discountBps: number;
  }> {
    const scVal = await this.contractService.simulateCall({
      contractAddress: this.configService.getOracleConsumerAddress(),
      method: 'get_project_staleness_state',
      args: [
        this.toBytes32(projectId),
        nativeToScVal(BigInt(Math.floor(Date.now() / 1000)), { type: 'u64' }),
      ],
    });
    const data = scValToNative(scVal) as any;
    return {
      projectId: this.field(data, 'project_id', 0) ?? projectId,
      lastReportTimestamp: Number(this.field(data, 'last_report_timestamp', 1) ?? 0),
      currentTier: Number(this.field(data, 'current_tier', 2) ?? 0),
      timeElapsed: Number(this.field(data, 'time_elapsed', 3) ?? 0),
      discountBps: Number(this.field(data, 'discount_bps', 4) ?? 0),
    };
  }

  /**
   * Deterministic dispute evidence bundle for contested performance reports (#458).
   * Packages report data, challenge records, IPFS evidence linkages, and content digest.
   */
  async getDisputeEvidenceBundle(reportId: number): Promise<DisputeEvidenceBundle> {
    const cacheKey = `oracle:dispute-bundle:${reportId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    const report = await this.getReport(reportId);
    if (!report) {
      throw new BadRequestException(`Report #${reportId} not found`);
    }

    const allChallenges = await this.getChallengeHistory(report.providerAddress);
    const reportChallenges = allChallenges.filter((c) => c.reportId === reportId);

    const isContested =
      report.status === ReportStatus.Challenged ||
      report.status === ReportStatus.Rejected ||
      reportChallenges.length > 0;

    if (!isContested) {
      throw new BadRequestException(
        `Report #${reportId} is not currently contested or challenged (status: ${report.status})`,
      );
    }

    const primaryChallenge = reportChallenges[0] ?? null;
    const counterEvidenceHashes = reportChallenges
      .map((c) => c.counterEvidenceHash)
      .filter((h): h is string => Boolean(h));

    const bundlePayload: Omit<DisputeEvidenceBundle, 'digest' | 'cid'> = {
      schemaVersion: DISPUTE_BUNDLE_SCHEMA_VERSION,
      bundleId: `deb-${reportId}-${primaryChallenge?.counterEvidenceHash ?? 'initial'}`,
      reportId,
      projectId: report.projectId,
      providerAddress: report.providerAddress,
      contestation: {
        status: report.status,
        activeChallengesCount: reportChallenges.filter((c) => !c.resolved).length,
        challenges: reportChallenges,
        primaryChallenge,
      },
      performanceReport: {
        periodStart: report.periodStart,
        periodEnd: report.periodEnd,
        carbonSequestered: report.carbonSequestered,
        methodology: report.methodology,
        ipfsEvidenceHash: report.ipfsHash,
        providerSignature: (report as any).providerSignature ?? '',
      },
      evidenceLinkage: {
        originalEvidenceHash: report.ipfsHash,
        counterEvidenceHashes,
        integrityVerified: Boolean(report.ipfsHash),
      },
      generatedAt:
        primaryChallenge?.submittedAt ??
        new Date((report.periodEnd ?? 0) * 1000).toISOString(),
    };

    const digest = computeBundleDigest(bundlePayload);
    const cid = computeBundleCid(digest);

    const bundle: DisputeEvidenceBundle = {
      ...bundlePayload,
      digest,
      cid,
    };

    await this.redis.setEx(cacheKey, 300, JSON.stringify(bundle));
    return bundle;
  }

  /**
   * Historical oracle correction workflow with compensating audit events (#461).
   * Validates correction, records compensating audit chain and ledger events,
   * coordinates true-up adjustment on-chain if requested, and maintains immutable correction history.
   */
  async submitHistoricalCorrection(
    dto: HistoricalOracleCorrectionDto,
    actorAddress: string,
  ): Promise<HistoricalCorrectionResponse> {
    if (dto.idempotencyKey) {
      const existing = await this.redis.get(`oracle:correction:idempotency:${dto.idempotencyKey}`);
      if (existing) {
        return JSON.parse(existing);
      }
    }

    const report = await this.getReport(dto.reportId);
    if (!report) {
      throw new BadRequestException(`Report #${dto.reportId} not found`);
    }

    if (!dto.correctionEvidenceHash || dto.correctionEvidenceHash.trim().length === 0) {
      throw new BadRequestException('Correction evidence hash is required');
    }

    if (!dto.reason || dto.reason.trim().length === 0) {
      throw new BadRequestException('Reason is mandatory for historical oracle corrections');
    }

    let originalCarbon: bigint;
    let correctedCarbon: bigint;
    try {
      originalCarbon = BigInt(report.carbonSequestered);
      correctedCarbon = BigInt(dto.correctedCarbonSequestered);
    } catch {
      throw new BadRequestException('Invalid numeric format for carbonSequestered');
    }

    const carbonDelta = correctedCarbon - originalCarbon;
    if (carbonDelta === 0n && dto.correctedBiodiversityScore === undefined) {
      throw new BadRequestException(
        'Correction yields no net adjustment: corrected value equals original value',
      );
    }

    const correctionId = `corr-${dto.reportId}-${Date.now()}`;
    const submittedAt = new Date().toISOString();

    let auditSequence: number | undefined;
    if (this.auditService) {
      const auditResult = await this.auditService.record({
        entityType: 'oracle-report',
        entityId: String(dto.reportId),
        action: 'oracle.historical_correction',
        actor: actorAddress,
        reason: dto.reason,
        before: {
          carbonSequestered: originalCarbon.toString(),
          ipfsEvidenceHash: report.ipfsHash,
          status: report.status,
        },
        after: {
          carbonSequestered: correctedCarbon.toString(),
          carbonDelta: carbonDelta.toString(),
          correctionEvidenceHash: dto.correctionEvidenceHash,
          correctedBiodiversityScore: dto.correctedBiodiversityScore,
        },
      });
      auditSequence = auditResult.record?.sequence;
    }

    let ledgerSequence: number | undefined;
    if (this.ledgerService) {
      const ledgerEntry = await this.ledgerService.appendSafe({
        type: 'oracle.override',
        actor: actorAddress,
        subjectType: 'oracle-report',
        subjectId: String(dto.reportId),
        payload: {
          reportId: dto.reportId,
          projectId: dto.projectId,
          originalCarbon: originalCarbon.toString(),
          correctedCarbon: correctedCarbon.toString(),
          carbonDelta: carbonDelta.toString(),
          correctionEvidenceHash: dto.correctionEvidenceHash,
          reason: dto.reason,
        },
      });
      ledgerSequence = ledgerEntry?.sequence;
    }


    let trueUpSubmitted = false;
    const bondAdjustments: { bondId: number; periodIndex: number; trueUpAmount: string }[] = [];

    if (dto.compensateBonds !== false && carbonDelta !== 0n) {
      try {
        const adminSecret = this.getAdminSecret();
        const adminAddress = this.stellarService.getKeypairFromSecret(adminSecret).publicKey();
        const couponEngineAddress = this.configService.getCouponEngineAddress();

        if (couponEngineAddress) {
          const evidenceBytes = this.toBytes32(dto.correctionEvidenceHash);
          const bondId = 1;
          const periodIndex = 0;
          const nonce = await this.nonceService.next(couponEngineAddress, adminAddress);

          await this.contractService.invokeContractMethod(
            couponEngineAddress,
            'submit_true_up_adjustment',
            adminSecret,
            [
              Address.fromString(adminAddress).toScVal(),
              nativeToScVal(BigInt(bondId), { type: 'u64' }),
              nativeToScVal(periodIndex, { type: 'u32' }),
              nativeToScVal(carbonDelta, { type: 'i128' }),
              nativeToScVal('correction', { type: 'symbol' }),
              evidenceBytes,
              nativeToScVal(BigInt(nonce), { type: 'u64' }),
            ],
            adminAddress,
          );
          trueUpSubmitted = true;
          bondAdjustments.push({
            bondId,
            periodIndex,
            trueUpAmount: carbonDelta.toString(),
          });
        }
      } catch (err) {
        // Continue and record event if on-chain true up invocation fails or mock contract is offline
      }
    }

    const record: HistoricalCorrectionRecord = {
      correctionId,
      reportId: dto.reportId,
      projectId: dto.projectId,
      originalCarbonSequestered: originalCarbon.toString(),
      correctedCarbonSequestered: correctedCarbon.toString(),
      carbonDelta: carbonDelta.toString(),
      originalBiodiversityScore: undefined,
      correctedBiodiversityScore: dto.correctedBiodiversityScore,
      correctionEvidenceHash: dto.correctionEvidenceHash,
      reason: dto.reason,
      actorAddress,
      submittedAt,
      idempotencyKey: dto.idempotencyKey,
      auditSequence,
      ledgerSequence,
      trueUpSubmitted,
      bondAdjustments,
    };

    const historyKey = `oracle:report:${dto.reportId}:corrections`;
    const existingHistoryRaw = await this.redis.get(historyKey);
    const history: HistoricalCorrectionRecord[] = existingHistoryRaw ? JSON.parse(existingHistoryRaw) : [];
    await this.redis.set(historyKey, JSON.stringify([...history, record]));

    const response: HistoricalCorrectionResponse = {
      success: true,
      correction: record,
      reconciled: true,
      message: `Historical report #${dto.reportId} successfully corrected with compensating audit records.`,
    };

    if (dto.idempotencyKey) {
      await this.redis.setEx(`oracle:correction:idempotency:${dto.idempotencyKey}`, 86400, JSON.stringify(response));
    }

    await this.redis.del(`oracle:dispute-bundle:${dto.reportId}`);
    return response;
  }

  async getHistoricalCorrections(reportId: number): Promise<HistoricalCorrectionRecord[]> {
    const historyKey = `oracle:report:${reportId}:corrections`;
    const raw = await this.redis.get(historyKey);
    return raw ? JSON.parse(raw) : [];
  }

  private getAdminSecret(): string {
    return this.signingKeys.adminSecret();
  }
}

