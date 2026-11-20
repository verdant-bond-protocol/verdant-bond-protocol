import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { OracleService } from './oracle.service';
import { ContractService } from '../stellar/contract.service';
import { StellarService } from '../stellar/stellar.service';
import { NonceService } from '../common/services/nonce.service';
import { RedisService } from '../common/services/redis.service';
import { SigningKeyProvider } from '../common/services/signing-key.provider';
import { ConfigService } from '../config/config.service';
import { AuditService } from '../audit/audit.service';
import { EventLedgerService } from '../ledger/event-ledger.service';
import { IpfsService } from '../projects/ipfs.service';
import { ReportStatus } from './interfaces/oracle.interface';
import { Keypair } from '@stellar/stellar-sdk';

describe('Historical Oracle Correction Workflow with Compensating Audit Events (#461)', () => {
  const validAdminKeypair = Keypair.random();
  let service: OracleService;
  let auditService: any;
  let ledgerService: any;
  let contractService: any;
  let redisStore: Map<string, string>;

  const mockReport = {
    id: 10,
    projectId: 'PRJ-PEATLAND-02',
    periodStart: 1700000000,
    periodEnd: 1702592000,
    carbonSequestered: '5000000',
    methodology: 'VERRA-VCS',
    ipfsHash: 'QmOriginalEvidenceHash111111111111111111111111',
    providerAddress: 'GPROVIDER1111111111111111111111111111111111111111111111',
    status: ReportStatus.Verified,
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  beforeEach(async () => {
    redisStore = new Map();

    auditService = {
      record: jest.fn().mockResolvedValue({
        kind: 'recorded',
        rejectReason: '',
        record: {
          sequence: 14,
          entityType: 'oracle-report',
          entityId: '10',
          action: 'oracle.historical_correction',
        },
      }),
    };

    ledgerService = {
      appendSafe: jest.fn().mockResolvedValue({
        sequence: 42,
        type: 'oracle.override',
        category: 'privileged',
      }),
    };

    contractService = {
      simulateCall: jest.fn(),
      invokeContractMethod: jest.fn().mockResolvedValue({
        result: {},
        transactionHash: 'tx-trueup-hash-1',
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OracleService,
        { provide: AuditService, useValue: auditService },
        { provide: EventLedgerService, useValue: ledgerService },
        { provide: ContractService, useValue: contractService },
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
            getKeypairFromSecret: jest.fn().mockReturnValue(validAdminKeypair),
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
            adminSecret: () => validAdminKeypair.secret(),
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
    jest.spyOn(service, 'getReport').mockResolvedValue(mockReport as any);
  });

  it('normal path: successfully submits historical correction and emits compensating audit + ledger events', async () => {
    const dto = {
      reportId: 10,
      projectId: 'PRJ-PEATLAND-02',
      correctedCarbonSequestered: '5500000',
      correctionEvidenceHash: 'QmCorrectedEvidenceHash11111111111111111111111',
      reason: 'Post-audit drone imagery recalibration delta +500k',
    };

    const res = await service.submitHistoricalCorrection(dto, 'GACTOR11111111111111111111111111111111111111111111111111');

    expect(res.success).toBe(true);
    expect(res.correction.reportId).toBe(10);
    expect(res.correction.carbonDelta).toBe('500000');
    expect(res.correction.auditSequence).toBe(14);
    expect(res.correction.ledgerSequence).toBe(42);
    expect(res.correction.trueUpSubmitted).toBe(true);

    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'oracle-report',
        entityId: '10',
        action: 'oracle.historical_correction',
        before: expect.objectContaining({ carbonSequestered: '5000000' }),
        after: expect.objectContaining({
          carbonSequestered: '5500000',
          carbonDelta: '500000',
        }),
      }),
    );

    expect(ledgerService.appendSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'oracle.override',
        subjectType: 'oracle-report',
        subjectId: '10',
        payload: expect.objectContaining({
          carbonDelta: '500000',
          reason: 'Post-audit drone imagery recalibration delta +500k',
        }),
      }),
    );

    const history = await service.getHistoricalCorrections(10);
    expect(history).toHaveLength(1);
    expect(history[0].carbonDelta).toBe('500000');
  });

  it('idempotency path: retrying with same idempotencyKey returns cached response without duplicate events', async () => {
    const dto = {
      reportId: 10,
      projectId: 'PRJ-PEATLAND-02',
      correctedCarbonSequestered: '4800000',
      correctionEvidenceHash: 'QmCorrectedEvidenceHash22222222222222222222222',
      reason: 'Sensor degradation correction',
      idempotencyKey: 'idem-key-correction-1',
    };

    const first = await service.submitHistoricalCorrection(dto, 'GACTOR1');
    const second = await service.submitHistoricalCorrection(dto, 'GACTOR1');

    expect(first.correction.correctionId).toBe(second.correction.correctionId);
    expect(auditService.record).toHaveBeenCalledTimes(1);
    expect(ledgerService.appendSafe).toHaveBeenCalledTimes(1);
  });

  it('failure path: rejects correction with zero delta (no change)', async () => {
    const dto = {
      reportId: 10,
      projectId: 'PRJ-PEATLAND-02',
      correctedCarbonSequestered: '5000000',
      correctionEvidenceHash: 'QmCorrectedEvidenceHash33333333333333333333333',
      reason: 'No change attempt',
    };

    await expect(service.submitHistoricalCorrection(dto, 'GACTOR1')).rejects.toThrow(BadRequestException);
  });

  it('failure path: rejects when mandatory reason is missing or empty', async () => {
    const dto = {
      reportId: 10,
      projectId: 'PRJ-PEATLAND-02',
      correctedCarbonSequestered: '6000000',
      correctionEvidenceHash: 'QmCorrectedEvidenceHash44444444444444444444444',
      reason: '',
    };

    await expect(service.submitHistoricalCorrection(dto, 'GACTOR1')).rejects.toThrow(BadRequestException);
  });
});
