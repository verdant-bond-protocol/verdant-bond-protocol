import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { OracleService } from './oracle.service';
import { ContractService } from '../stellar/contract.service';
import { IpfsService } from '../projects/ipfs.service';
import { StellarService } from '../stellar/stellar.service';
import { NonceService } from '../common/services/nonce.service';
import { RedisService } from '../common/services/redis.service';
import { SigningKeyProvider } from '../common/services/signing-key.provider';
import { ConfigService } from '../config/config.service';
import { ReportStatus } from './interfaces/oracle.interface';
import {
  verifyDisputeEvidenceBundle,
  computeBundleDigest,
  computeBundleCid,
  DISPUTE_BUNDLE_SCHEMA_VERSION,
} from './interfaces/dispute-bundle.interface';

describe('Deterministic Dispute Evidence Bundle for Contested Reports (#458)', () => {
  let service: OracleService;
  let redisStore: Map<string, string>;

  const mockReport = {
    id: 42,
    projectId: 'PRJ-AMAZON-01',
    periodStart: 1700000000,
    periodEnd: 1702592000,
    carbonSequestered: '1000000000',
    methodology: 'VERRA-VCS',
    ipfsHash: 'QmZtmD2qt8fJpq3CLDHvwDeWVCkfF4NNgwcspuknMStWNo',
    providerAddress: 'GPROVIDER1111111111111111111111111111111111111111111111',
    status: ReportStatus.Challenged,
    createdAt: '2026-01-01T00:00:00.000Z',
    verifiedAt: '2026-01-02T00:00:00.000Z',
  };

  const mockChallenges = [
    {
      reportId: 42,
      challengerAddress: 'GCHALLENGER1111111111111111111111111111111111111111111',
      reason: 'Disputed satellite canopy degradation telemetry anomaly',
      counterEvidenceHash: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
      resolved: false,
      resolution: 0,
      submittedAt: '2026-01-03T12:00:00.000Z',
    },
  ];

  beforeEach(async () => {
    redisStore = new Map();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OracleService,
        {
          provide: ContractService,
          useValue: {
            simulateCall: jest.fn(),
            invokeContractMethod: jest.fn(),
          },
        },
        {
          provide: IpfsService,
          useValue: {
            uploadFile: jest.fn(),
            getContent: jest.fn(),
          },
        },
        {
          provide: StellarService,
          useValue: {
            getKeypairFromSecret: jest.fn().mockReturnValue({
              publicKey: () => 'GADMIN111111111111111111111111111111111111111111111111',
            }),
          },
        },
        {
          provide: NonceService,
          useValue: {
            next: jest.fn().mockResolvedValue(1),
          },
        },
        {
          provide: RedisService,
          useValue: {
            get: jest.fn(async (key: string) => redisStore.get(key) ?? null),
            set: jest.fn(async (key: string, val: string) => {
              redisStore.set(key, val);
            }),
            setEx: jest.fn(async (key: string, ttl: number, val: string) => {
              redisStore.set(key, val);
            }),
            del: jest.fn(async (key: string) => {
              redisStore.delete(key);
            }),
          },
        },
        {
          provide: SigningKeyProvider,
          useValue: {
            adminSecret: () => 'SADMINSECRET111111111111111111111111111111111111111111111',
          },
        },
        {
          provide: ConfigService,
          useValue: {
            getOracleConsumerAddress: () => 'CORACLECONSUMER',
            getCouponEngineAddress: () => 'CCOUPONENGINE',
          },
        },
      ],
    }).compile();

    service = module.get<OracleService>(OracleService);
  });

  it('normal path: builds a deterministic dispute evidence bundle for a challenged report', async () => {
    jest.spyOn(service, 'getReport').mockResolvedValue(mockReport as any);
    jest.spyOn(service, 'getChallengeHistory').mockResolvedValue(mockChallenges as any);

    const bundle = await service.getDisputeEvidenceBundle(42);

    expect(bundle).toBeDefined();
    expect(bundle.schemaVersion).toBe(DISPUTE_BUNDLE_SCHEMA_VERSION);
    expect(bundle.reportId).toBe(42);
    expect(bundle.projectId).toBe('PRJ-AMAZON-01');
    expect(bundle.contestation.status).toBe(ReportStatus.Challenged);
    expect(bundle.contestation.challenges).toHaveLength(1);
    expect(bundle.contestation.primaryChallenge?.counterEvidenceHash).toBe(
      'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
    );
    expect(bundle.evidenceLinkage.originalEvidenceHash).toBe(mockReport.ipfsHash);
    expect(bundle.evidenceLinkage.counterEvidenceHashes).toContain(
      'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
    );
    expect(bundle.digest).toBeDefined();
    expect(bundle.cid).toMatch(/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/);

    const verification = verifyDisputeEvidenceBundle(bundle);
    expect(verification.valid).toBe(true);
  });

  it('retry path: generating bundle multiple times yields byte-for-byte identical digest and CID', async () => {
    jest.spyOn(service, 'getReport').mockResolvedValue(mockReport as any);
    jest.spyOn(service, 'getChallengeHistory').mockResolvedValue(mockChallenges as any);

    const first = await service.getDisputeEvidenceBundle(42);
    redisStore.clear();
    const second = await service.getDisputeEvidenceBundle(42);

    expect(first.digest).toBe(second.digest);
    expect(first.cid).toBe(second.cid);
    expect(first.bundleId).toBe(second.bundleId);
  });

  it('failure path: throws BadRequestException if report is not contested', async () => {
    const verifiedReport = { ...mockReport, status: ReportStatus.Verified };
    jest.spyOn(service, 'getReport').mockResolvedValue(verifiedReport as any);
    jest.spyOn(service, 'getChallengeHistory').mockResolvedValue([]);

    await expect(service.getDisputeEvidenceBundle(42)).rejects.toThrow(BadRequestException);
  });

  it('failure path: throws if report is not found', async () => {
    jest.spyOn(service, 'getReport').mockResolvedValue(null as any);

    await expect(service.getDisputeEvidenceBundle(999)).rejects.toThrow(BadRequestException);
  });

  it('tamper detection: modifying bundle content fails cryptographic verification', async () => {
    jest.spyOn(service, 'getReport').mockResolvedValue(mockReport as any);
    jest.spyOn(service, 'getChallengeHistory').mockResolvedValue(mockChallenges as any);

    const bundle = await service.getDisputeEvidenceBundle(42);
    const tampered = {
      ...bundle,
      performanceReport: {
        ...bundle.performanceReport,
        carbonSequestered: '9999999999',
      },
    };

    const result = verifyDisputeEvidenceBundle(tampered);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Digest mismatch');
  });
});
