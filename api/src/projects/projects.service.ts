import { Injectable, BadRequestException } from '@nestjs/common';
import { ContractService } from '../stellar/contract.service';
import { StellarService } from '../stellar/stellar.service';
import { IpfsService } from './ipfs.service';
import { NonceService } from '../common/services/nonce.service';
import { RedisService } from '../common/services/redis.service';
import { SigningKeyProvider } from '../common/services/signing-key.provider';
import { nativeToScVal, scValToNative, Address, xdr } from '@stellar/stellar-sdk';
import { CreateProjectDto } from './dto/create-project.dto';
import { ProjectResponse, ProjectStatusEnum, DocumentUploadResponse, ProjectProvenanceResponse, ProvenanceEvent, CertificationKind, CertificationVersion, CouponCertification } from './interfaces/project.interface';
import { encodeCid, decodeCid, toBigIntString } from '../common/utils';
import { ConfigService } from '../config/config.service';
import { validateGeoJsonBoundary } from './utils/geojson-validator';
import * as crypto from 'crypto';



@Injectable()
export class ProjectsService {
  constructor(
    private readonly contractService: ContractService,
    private readonly stellarService: StellarService,
    private readonly ipfsService: IpfsService,
    private readonly nonceService: NonceService,
    private readonly redis: RedisService,
    private readonly signingKeys: SigningKeyProvider,
    private readonly configService: ConfigService,
  ) {}

  async register(dto: CreateProjectDto, ownerAddress: string): Promise<ProjectResponse> {
    try {
      Address.fromString(ownerAddress);
    } catch {
      throw new BadRequestException('Authenticated wallet address is required');
    }

    let boundaryData: Record<string, any> = {};
    if (dto.boundary) {
      try {
        const validation = validateGeoJsonBoundary(dto.boundary, dto.totalAreaHa);
        boundaryData = {
          boundary: validation.geometry,
          boundaryHash: validation.boundaryHash,
          boundaryAreaHa: validation.areaHa,
        };
      } catch (err: any) {
        throw new BadRequestException(`Geospatial boundary validation failed: ${err.message}`);
      }
    }
    const metadata = {
      name: dto.name,
      methodology: dto.methodology,
      country: dto.country,
      location: dto.location,
      totalAreaHa: dto.totalAreaHa,
      carbonSequestrationEstimate: dto.carbonSequestrationEstimate,
      blueCarbon: dto.blueCarbon ?? false,
      biodiversityCorridor: dto.biodiversityCorridor ?? false,
      description: dto.description ?? '',
      ...boundaryData,
      timestamp: new Date().toISOString(),
    };

    const ipfsResult = await this.ipfsService.uploadJson(metadata);
    const ipfsHash = encodeCid(ipfsResult.hash);

    const ownerSecret = this.signingKeys.userSecret();

    const { result, transactionHash } = await this.contractService.invokeContractMethod(
      this.configService.getProjectRegistryAddress(), 'register_project', ownerSecret,
      [
        Address.fromString(ownerAddress).toScVal(),
        nativeToScVal(ipfsHash, { type: 'bytes' }),
        nativeToScVal(dto.methodology, { type: 'symbol' }),
        nativeToScVal(dto.country, { type: 'symbol' }),
      ],
      ownerAddress,
    );

    const projectId = Number(scValToNative(result));
    const project = await this.buildProjectResponse(projectId);

    await this.redis.setEx(`project:${projectId}`, 300, JSON.stringify(project));

    return { ...project, transactionHash };
  }

  async findAll(page = 1, limit = 20, cursor?: string | number) {
    const cursorValue = typeof cursor === 'string' ? parseInt(cursor, 10) : cursor;
    const cacheKey = cursorValue !== undefined ? `projects:c:${cursorValue}:${limit}` : `projects:${page}:${limit}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    let total = 0;
    try {
      const countScVal = await this.contractService.simulateCall({
        contractAddress: this.configService.getProjectRegistryAddress(), method: 'project_count', args: [],
      });
      total = Number(scValToNative(countScVal));
    } catch {}

    const projects: ProjectResponse[] = [];
    
    if (cursorValue !== undefined) {
      let currentId = cursorValue + 1;
      while (projects.length < limit && currentId <= total) {
        try {
          // If buildProjectResponse throws due to hidden or deleted status, the record is skipped.
          // Because we iterate deterministically, these skips don't shift offsets.
          projects.push(await this.buildProjectResponse(currentId));
        } catch {}
        currentId++;
      }
      const nextCursor = currentId <= total ? currentId - 1 : undefined;
      const result = {
        data: projects,
        meta: { limit, total, nextCursor, totalPages: Math.ceil(total / limit) || 1 },
      };
      await this.redis.setEx(cacheKey, 60, JSON.stringify(result));
      return result;
    }

    const start = (page - 1) * limit;
    let skipped = 0;
    let currentId = 1;
    
    while (skipped < start && currentId <= total) {
      try {
        // Skip hidden/deleted records during offset traversal
        await this.buildProjectResponse(currentId);
        skipped++;
      } catch {}
      currentId++;
    }

    while (projects.length < limit && currentId <= total) {
      try {
        // Skip hidden/deleted records while fulfilling limit
        projects.push(await this.buildProjectResponse(currentId));
      } catch {}
      currentId++;
    }

    const result = {
      data: projects,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
    };

    await this.redis.setEx(cacheKey, 60, JSON.stringify(result));
    return result;
  }

  async findOne(id: number): Promise<ProjectResponse> {
    const cached = await this.redis.get(`project:${id}`);
    if (cached) return JSON.parse(cached);

    const project = await this.buildProjectResponse(id);
    await this.redis.setEx(`project:${id}`, 300, JSON.stringify(project));
    return project;
  }

  async approve(id: number): Promise<ProjectResponse> {
    const adminSecret = this.getAdminSecret();
    const adminAddress = this.stellarService.getKeypairFromSecret(adminSecret).publicKey();

    await this.contractService.invokeContractMethod(
      this.configService.getProjectRegistryAddress(), 'approve_project', adminSecret,
      [Address.fromString(adminAddress).toScVal(), nativeToScVal(BigInt(id), { type: 'u64' })],
      adminAddress,
    );

    await this.redis.del(`project:${id}`);
    return this.buildProjectResponse(id);
  }

  async reject(id: number): Promise<ProjectResponse> {
    const adminSecret = this.getAdminSecret();
    const adminAddress = this.stellarService.getKeypairFromSecret(adminSecret).publicKey();

    await this.contractService.invokeContractMethod(
      this.configService.getProjectRegistryAddress(), 'reject_project', adminSecret,
      [Address.fromString(adminAddress).toScVal(), nativeToScVal(BigInt(id), { type: 'u64' })],
      adminAddress,
    );

    await this.redis.del(`project:${id}`);
    return this.buildProjectResponse(id);
  }

  async uploadDocuments(id: number, files: any[]): Promise<DocumentUploadResponse> {
    const documentHashes: string[] = [];
    const gatewayUrls: string[] = [];

    for (const file of files) {
      const result = await this.ipfsService.uploadFile(file.buffer, file.originalname, file.mimetype);
      documentHashes.push(result.hash);
      gatewayUrls.push(result.gatewayUrl);
    }

    const existing = await this.redis.get(`project:${id}:documents`);
    const allHashes = existing ? [...JSON.parse(existing), ...documentHashes] : documentHashes;
    await this.redis.set(`project:${id}:documents`, JSON.stringify(allHashes));

    // Each upload is a distinct immutable IPFS object: record every hash as
    // a new certification version (append-only, issue #213) without changing
    // this method's existing response shape. Re-uploads of already-versioned
    // content are skipped so the endpoint stays idempotent.
    const known = new Set(
      (await this.getCertificationHistory(id)).map((v) => v.cid),
    );
    for (const hash of documentHashes) {
      if (!known.has(hash)) {
        await this.addCertification(id, hash, 'document');
        known.add(hash);
      }
    }

    return { projectId: id, documentHashes, gatewayUrls };
  }

  /**
   * Append a new certification version (issue #213). Versions are immutable
   * and append-only: the new entry links to the previous CID but no existing
   * entry is ever modified or overwritten.
   */
  async addCertification(
    id: number,
    cid: string,
    kind: CertificationKind = 'document',
  ): Promise<CertificationVersion> {
    if (!cid || typeof cid !== 'string') {
      throw new BadRequestException('Certification CID is required');
    }
    const history = await this.getCertificationHistory(id);
    if (history.some((v) => v.cid === cid)) {
      throw new BadRequestException('Certification version already recorded');
    }
    const version: CertificationVersion = {
      version: history.length + 1,
      cid,
      previousCid: history.length > 0 ? history[history.length - 1].cid : null,
      kind,
      uploadedAt: new Date().toISOString(),
    };
    await this.redis.set(
      `project:${id}:certifications`,
      JSON.stringify([...history, version]),
    );
    return version;
  }

  async getCertificationHistory(id: number): Promise<CertificationVersion[]> {
    const raw = await this.redis.get(`project:${id}:certifications`);
    return raw ? JSON.parse(raw) : [];
  }

  /**
   * Reconstruct which certification version justified a historical coupon
   * payment (issue #213). On-chain, the coupon engine's `PeriodInfo`
   * records the `report_id` used for the calculation and the oracle
   * `Report` records the exact `ipfs_evidence_hash` (CID) — together they
   * are the tamper-evident anchor. The first resolution for a
   * (bond, period) is snapshotted immutably, so later superseding
   * certifications can never rewrite history.
   */
  async getCouponCertification(
    projectId: number,
    bondId: number,
    periodIndex: number,
  ): Promise<CouponCertification> {
    const couponKey = `bond:${bondId}:coupon-certs`;
    const raw = await this.redis.get(couponKey);
    const log: CouponCertification[] = raw ? JSON.parse(raw) : [];
    const snapshot = log.find((e) => e.periodIndex === periodIndex);
    if (snapshot) return snapshot;

    const infoRaw = await this.contractService.simulateCall({
      contractAddress: this.configService.getCouponEngineAddress(),
      method: 'get_period_info',
      args: [
        nativeToScVal(BigInt(bondId), { type: 'u64' }),
        nativeToScVal(periodIndex, { type: 'u32' }),
      ],
    });
    const info = scValToNative(infoRaw) as any[];
    const reportId = Number(info[5]);

    const reportRaw = await this.contractService.simulateCall({
      contractAddress: this.configService.getOracleConsumerAddress(),
      method: 'get_report',
      args: [nativeToScVal(BigInt(reportId), { type: 'u64' })],
    });
    const report = scValToNative(reportRaw) as any[];
    const certificationCid = decodeCid(report[8] as Uint8Array);

    const history = await this.getCertificationHistory(projectId);
    const match = history.find((v) => v.cid === certificationCid);

    const resolved: CouponCertification = {
      bondId,
      periodIndex,
      reportId,
      certificationCid,
      gatewayUrl: `https://gateway.pinata.cloud/ipfs/${certificationCid}`,
      certificationVersion: match ? match.version : null,
      recordedAt: new Date().toISOString(),
    };
    await this.redis.set(couponKey, JSON.stringify([...log, resolved]));
    return resolved;
  }

  async getProvenance(id: number): Promise<ProjectProvenanceResponse> {
    const snapshot = await this.exportProject(id, 'system');
    const project = await this.findOne(id);
    const events: ProvenanceEvent[] = [{
      type: 'registration',
      occurredAt: project.createdAt,
      title: 'Project registered',
      status: 'complete',
      reference: project.metadataIpfsHash,
      evidenceUrl: `https://gateway.pinata.cloud/ipfs/${project.metadataIpfsHash}`,
    }];
    if (project.status === ProjectStatusEnum.Pending) {
      events.push({ type: 'review', occurredAt: null, title: 'Review pending', status: 'pending' });
    } else {
      events.push({ type: 'review', occurredAt: null, title: `Project ${project.status.toLowerCase()}`, status: 'complete' });
    }
    for (const report of snapshot.reports) {
      const reportStatus = report.status === 'Pending' || report.status === 0
        ? 'pending'
        : report.ipfsEvidenceHash ? 'complete' : 'stale';
      events.push({
        type: 'report', occurredAt: report.createdAt ?? null,
        title: `Oracle report #${report.id}`, status: reportStatus,
        reference: String(report.id), evidenceUrl: report.ipfsEvidenceHash ? `https://gateway.pinata.cloud/ipfs/${report.ipfsEvidenceHash}` : undefined,
      });
    }
    for (const bondId of snapshot.relatedBonds) {
      events.push({ type: 'bond', occurredAt: null, title: `Bond #${bondId} issued`, status: 'complete', reference: String(bondId), evidenceUrl: `/bonds/${bondId}` });
    }
    for (const hash of snapshot.documents) {
      events.push({ type: 'document', occurredAt: null, title: 'Project document added', status: 'complete', reference: hash, evidenceUrl: `https://gateway.pinata.cloud/ipfs/${hash}` });
    }
    events.sort((a, b) => (a.occurredAt && b.occurredAt ? a.occurredAt.localeCompare(b.occurredAt) : a.occurredAt ? -1 : b.occurredAt ? 1 : 0));
    return { projectId: id, events };
  }

  private async buildProjectResponse(id: number): Promise<ProjectResponse> {
    const projectScVal = await this.contractService.simulateCall({
      contractAddress: this.configService.getProjectRegistryAddress(), method: 'get_project',
      args: [nativeToScVal(BigInt(id), { type: 'u64' })],
    });

    const project = scValToNative(projectScVal) as any[];

    const metadataIpfsHash = decodeCid(project[2] as Uint8Array);
    let metadata: any = {};
    try {
      metadata = await this.ipfsService.getContent(metadataIpfsHash);
    } catch {}

    return {
      id: Number(project[0]),
      name: metadata.name || `Project #${id}`,
      status: project[3] as ProjectStatusEnum,
      methodology: project[4] as string,
      country: project[5] as string,
      metadataIpfsHash,
      ownerAddress: (project[1] as any).toString?.() || '',
      totalAreaHa: metadata.totalAreaHa || 0,
      carbonSequestrationEstimate: metadata.carbonSequestrationEstimate || 0,
      createdAt: metadata.timestamp || new Date().toISOString(),
    };
  }

  async exportProject(projectId: number, auditorAddress: string): Promise<any> {
    // 1. Fetch project from registry
    const projectScVal = await this.contractService.simulateCall({
      contractAddress: this.configService.getProjectRegistryAddress(),
      method: 'get_project',
      args: [nativeToScVal(BigInt(projectId), { type: 'u64' })],
    });
    const project = scValToNative(projectScVal) as any[];
    if (!project || project.length === 0) {
      throw new BadRequestException('Project not found');
    }

    const metadataIpfsHash = decodeCid(project[2] as Uint8Array);
    let metadata: any = {};
    try {
      metadata = await this.ipfsService.getContent(metadataIpfsHash);
    } catch {}

    const projectData = {
      id: Number(project[0]),
      ownerAddress: (project[1] as any).toString?.() || '',
      metadataIpfsHash,
      status: project[3],
      methodology: project[4],
      country: project[5],
      name: metadata.name || `Project #${projectId}`,
      totalAreaHa: metadata.totalAreaHa || 0,
      carbonSequestrationEstimate: metadata.carbonSequestrationEstimate || 0,
    };

    // 2. Fetch documents from Redis cache
    const documentsCache = await this.redis.get(`project:${projectId}:documents`);
    const documents = documentsCache ? JSON.parse(documentsCache) : [];

    // 3. Fetch reports from Oracle contract
    const reports: any[] = [];
    try {
      const idsScVal = await this.contractService.simulateCall({
        contractAddress: this.configService.getOracleConsumerAddress(),
        method: 'get_project_reports',
        args: [xdr.ScVal.scvBytes(Buffer.from(project[2] as Uint8Array))],
      });
      const ids = scValToNative(idsScVal) as number[];
      for (const reportId of ids) {
        try {
          const reportScVal = await this.contractService.simulateCall({
            contractAddress: this.configService.getOracleConsumerAddress(),
            method: 'get_report',
            args: [nativeToScVal(BigInt(reportId), { type: 'u64' })],
          });
          const report = scValToNative(reportScVal) as any[];
          reports.push({
            id: Number(reportId),
            projectId: Buffer.from(report[0] as Uint8Array).toString('hex'),
            periodStart: Number(report[1]),
            periodEnd: Number(report[2]),
            carbonSequestered: toBigIntString(report[3]),
            methodology: report[4],
            providerSignature: Buffer.from(report[5] as Uint8Array).toString('hex'),
            ipfsEvidenceHash: Buffer.from(report[6] as Uint8Array).toString('hex'),
            status: report[7],
          });
        } catch {}
      }
    } catch {}

    // 4. Fetch related bonds
    const relatedBonds: number[] = [];
    try {
      const countScVal = await this.contractService.simulateCall({
        contractAddress: this.configService.getBondIssuerAddress(),
        method: 'bond_count',
        args: [],
      });
      const totalBonds = Number(scValToNative(countScVal));
      const projectHex = Buffer.from(project[2] as Uint8Array).toString('hex');
      for (let id = 1; id <= totalBonds; id++) {
        try {
          const configScVal = await this.contractService.simulateCall({
            contractAddress: this.configService.getBondIssuerAddress(),
            method: 'get_bond',
            args: [nativeToScVal(BigInt(id), { type: 'u64' })],
          });
          const config = scValToNative(configScVal) as any[];
          const bondProjIdHex = Buffer.from(config[0] as Uint8Array).toString('hex');
          if (bondProjIdHex === projectHex) {
            relatedBonds.push(id);
          }
        } catch {}
      }
    } catch {}

    // 5. Construct payload & checksum
    const payload: any = {
      generationMetadata: {
        timestamp: new Date().toISOString(),
        exporterAddress: auditorAddress || 'system',
        version: '1.0.0',
      },
      project: projectData,
      documents,
      reports,
      relatedBonds,
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
