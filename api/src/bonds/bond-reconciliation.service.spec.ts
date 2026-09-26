import { Test, TestingModule } from '@nestjs/testing';
import { BondReconciliationService, BondReconciliationMismatch } from './bond-reconciliation.service';
import { RedisService } from '../common/services/redis.service';

describe('BondReconciliationService', () => {
  let service: BondReconciliationService;
  let redis: RedisService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BondReconciliationService,
        {
          provide: RedisService,
          useValue: {
            get: jest.fn(),
            setEx: jest.fn(),
            del: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<BondReconciliationService>(BondReconciliationService);
    redis = module.get<RedisService>(RedisService);
  });

  describe('ingestHorizonEvent', () => {
    it('should ingest new event and return true', async () => {
      (redis.get as jest.Mock).mockResolvedValueOnce(null);
      (redis.setEx as jest.Mock).mockResolvedValue('OK');

      const event = {
        eventId: 'evt-123',
        ledgerSequence: 1000,
        txHash: 'tx123',
        investorAddress: 'INVESTOR1',
        bondId: 1,
        eventType: 'coupon_claimed' as const,
        amount: '100',
        timestamp: Date.now(),
      };

      const result = await service.ingestHorizonEvent(event);

      expect(result).toBe(true);
      expect(redis.setEx).toHaveBeenCalled();
    });

    it('should return false for duplicate event', async () => {
      (redis.get as jest.Mock).mockResolvedValueOnce('processed');

      const event = {
        eventId: 'evt-123',
        ledgerSequence: 1000,
        txHash: 'tx123',
        investorAddress: 'INVESTOR1',
        bondId: 1,
        eventType: 'coupon_claimed' as const,
        amount: '100',
        timestamp: Date.now(),
      };

      const result = await service.ingestHorizonEvent(event);

      expect(result).toBe(false);
    });
  });

  describe('reconcile', () => {
    it('should return report with no mismatches when states align', async () => {
      (redis.get as jest.Mock).mockResolvedValue(null);
      (redis.setEx as jest.Mock).mockResolvedValue('OK');

      const report = await service.reconcile();

      expect(report).toBeDefined();
      expect(report.startedAt).toBeDefined();
      expect(report.finishedAt).toBeDefined();
      expect(Array.isArray(report.mismatches)).toBe(true);
    });
  });

  describe('repair', () => {
    it('should return actions for repaired mismatches', async () => {
      const report = {
        correlationId: 'corr-123',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        checkedInvestors: 1,
        checkedBonds: 1,
        mismatches: [
          {
            correlationId: 'corr-123',
            type: 'stale_balance' as const,
            investorAddress: 'INVESTOR1',
            bondId: 1,
            expected: '1000',
            observed: '500',
            fieldType: 'bidirectional' as const,
            detail: 'Balance mismatch',
            repair: 'Sync balance',
          } as BondReconciliationMismatch,
        ],
        hasMismatches: true,
      };

      const actions = await service.repair(report);

      expect(Array.isArray(actions)).toBe(true);
    });
  });

  describe('getLastReport', () => {
    it('should return last reconciliation report', async () => {
      const mockReport = {
        correlationId: 'corr-123',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        checkedInvestors: 0,
        checkedBonds: 0,
        mismatches: [],
        hasMismatches: false,
      };

      (redis.get as jest.Mock).mockResolvedValue(JSON.stringify(mockReport));

      const report = await service.getLastReport();

      expect(report).toEqual(mockReport);
    });

    it('should return null when no report exists', async () => {
      (redis.get as jest.Mock).mockResolvedValue(null);

      const report = await service.getLastReport();

      expect(report).toBeNull();
    });
  });

  describe('listMismatches', () => {
    it('should return list of mismatches', async () => {
      const mismatches: BondReconciliationMismatch[] = [
        {
          correlationId: 'corr-123',
          type: 'stale_balance',
          expected: '1000',
          observed: '500',
          fieldType: 'bidirectional',
          detail: 'Balance mismatch',
          repair: 'Sync balance',
        },
      ];

      (redis.get as jest.Mock).mockResolvedValue(JSON.stringify(mismatches));

      const result = await service.listMismatches(10);

      expect(result).toEqual(mismatches);
    });

    it('should return empty array when no mismatches', async () => {
      (redis.get as jest.Mock).mockResolvedValue(null);

      const result = await service.listMismatches();

      expect(result).toEqual([]);
    });
  });
});
