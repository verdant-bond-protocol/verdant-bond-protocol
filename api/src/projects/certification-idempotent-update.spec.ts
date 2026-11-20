import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { ContractService } from '../stellar/contract.service';
import { StellarService } from '../stellar/stellar.service';
import { IpfsService } from './ipfs.service';
import { NonceService } from '../common/services/nonce.service';
import { RedisService } from '../common/services/redis.service';
import { SigningKeyProvider } from '../common/services/signing-key.provider';
import { ConfigService } from '../config/config.service';

describe('Idempotent Project Certification Document Updates (#459)', () => {
  let service: ProjectsService;
  let redisStore: Map<string, string>;

  const mockProject = {
    id: 1,
    name: 'Mangrove Restoration Project',
    ownerAddress: 'GOWNER1111111111111111111111111111111111111111111111111',
    status: 'Active',
    methodology: 'BLUE-CARBON',
    country: 'ID',
    metadataIpfsHash: 'QmProjectMetaHash11111111111111111111111111',
    totalAreaHa: 500,
    carbonSequestrationEstimate: 12000,
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  beforeEach(async () => {
    redisStore = new Map();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProjectsService,
        {
          provide: ContractService,
          useValue: {
            simulateCall: jest.fn(),
            invokeContractMethod: jest.fn(),
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
          provide: IpfsService,
          useValue: {
            uploadFile: jest.fn(),
            getContent: jest.fn(),
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
            getProjectRegistryAddress: () => 'CPROJECTREGISTRY',
            getCouponEngineAddress: () => 'CCOUPONENGINE',
            getOracleConsumerAddress: () => 'CORACLECONSUMER',
          },
        },
      ],
    }).compile();

    service = module.get<ProjectsService>(ProjectsService);
    jest.spyOn(service, 'findOne').mockResolvedValue(mockProject as any);
  });

  it('normal path: records new certification CIDs and chains previous CIDs', async () => {
    const result = await service.updateProjectCertifications(
      1,
      { cids: ['QmCertV1', 'QmCertV2'], kind: 'third-party-certification' },
      mockProject.ownerAddress,
    );

    expect(result.projectId).toBe(1);
    expect(result.addedCount).toBe(2);
    expect(result.existingCount).toBe(0);
    expect(result.certifications).toHaveLength(2);
    expect(result.certifications[0].cid).toBe('QmCertV1');
    expect(result.certifications[0].previousCid).toBeNull();
    expect(result.certifications[1].cid).toBe('QmCertV2');
    expect(result.certifications[1].previousCid).toBe('QmCertV1');
  });

  it('retry path: sending duplicate CIDs is idempotent and does not error or append duplicates', async () => {
    await service.updateProjectCertifications(
      1,
      { cids: ['QmCertV1', 'QmCertV2'] },
      mockProject.ownerAddress,
    );

    const retryResult = await service.updateProjectCertifications(
      1,
      { cids: ['QmCertV1', 'QmCertV2'] },
      mockProject.ownerAddress,
    );

    expect(retryResult.addedCount).toBe(0);
    expect(retryResult.existingCount).toBe(2);
    expect(retryResult.certifications).toHaveLength(2);
    expect(retryResult.totalVersions).toBe(2);
  });

  it('mixed update path: appends only net-new CIDs while recognizing already-versioned CIDs', async () => {
    await service.updateProjectCertifications(
      1,
      { cids: ['QmCertV1'] },
      mockProject.ownerAddress,
    );

    const mixedResult = await service.updateProjectCertifications(
      1,
      { cids: ['QmCertV1', 'QmCertV2', 'QmCertV3'] },
      mockProject.ownerAddress,
    );

    expect(mixedResult.addedCount).toBe(2);
    expect(mixedResult.existingCount).toBe(1);
    expect(mixedResult.certifications).toHaveLength(3);
    expect(mixedResult.certifications[2].previousCid).toBe('QmCertV2');
  });

  it('authorization path: allows project owner and admin, rejects unauthorized caller', async () => {
    const adminAddress = 'GADMIN111111111111111111111111111111111111111111111111';
    const strangerAddress = 'GSTRANGER1111111111111111111111111111111111111111111111';

    await expect(
      service.updateProjectCertifications(1, { cids: ['QmCertAdmin'] }, adminAddress),
    ).resolves.toBeDefined();

    await expect(
      service.updateProjectCertifications(1, { cids: ['QmCertStranger'] }, strangerAddress),
    ).rejects.toThrow(ForbiddenException);
  });

  it('failure path: rejects empty CID list or invalid project', async () => {
    await expect(
      service.updateProjectCertifications(1, { cids: [] }, mockProject.ownerAddress),
    ).rejects.toThrow(BadRequestException);

    jest.spyOn(service, 'findOne').mockResolvedValue(null as any);
    await expect(
      service.updateProjectCertifications(99, { cids: ['QmCertV1'] }, mockProject.ownerAddress),
    ).rejects.toThrow(BadRequestException);
  });
});
