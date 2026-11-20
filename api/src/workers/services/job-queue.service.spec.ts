import { Test, TestingModule } from '@nestjs/testing';
import { JobQueueService } from './job-queue.service';
import { RedisService } from '../../common/services/redis.service';
import { JobPayload, JobType, JobStatus } from '../interfaces/job.interface';

describe('JobQueueService', () => {
  let service: JobQueueService;
  let redisService: RedisService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JobQueueService,
        {
          provide: RedisService,
          useValue: {
            set: jest.fn().mockResolvedValue('OK'),
            get: jest.fn(),
            del: jest.fn(),
            sAdd: jest.fn(),
            sRem: jest.fn(),
            sMembers: jest.fn().mockResolvedValue([]),
            expire: jest.fn(),
            // Admission control (#391)
            acquireLockOrThrow: jest.fn().mockResolvedValue(true),
            releaseLockOrThrow: jest.fn().mockResolvedValue(undefined),
            sMembersOrThrow: jest.fn().mockResolvedValue([]),
            getOrThrow: jest.fn().mockResolvedValue(null),
          },
        },
      ],
    }).compile();

    service = module.get<JobQueueService>(JobQueueService);
    redisService = module.get<RedisService>(RedisService);
  });

  describe('enqueue', () => {
    it('should enqueue a job with pending status', async () => {
      const payload: JobPayload = {
        type: JobType.RECONCILIATION,
        data: { bondId: 'bond-123' },
        userId: 'user-456',
      };

      const job = await service.enqueue(payload, 3);

      expect(job.status).toBe(JobStatus.PENDING);
      expect(job.payload).toEqual(payload);
      expect(job.retries).toBe(0);
      expect(job.maxRetries).toBe(3);
      expect(redisService.set).toHaveBeenCalled();
    });

    it('propagates correlationId from payload to top-level job field (#398)', async () => {
      const correlationId = 'trace-abc-123';
      const payload: JobPayload = {
        type: JobType.COUPON_DISTRIBUTION,
        data: { bondId: 'bond-99' },
        correlationId,
      };

      const job = await service.enqueue(payload);

      expect(job.correlationId).toBe(correlationId);
    });

    it('generates a correlationId when payload omits one (#398)', async () => {
      const payload: JobPayload = {
        type: JobType.ORACLE_SYNC,
        data: {},
      };

      const job = await service.enqueue(payload);

      expect(typeof job.correlationId).toBe('string');
      expect(job.correlationId.length).toBeGreaterThan(0);
      // Must be a UUID-shaped string (8-4-4-4-12)
      expect(job.correlationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it('stores correlationId in the persisted job record (#398)', async () => {
      const correlationId = 'store-check-456';
      const payload: JobPayload = {
        type: JobType.RECONCILIATION,
        data: {},
        correlationId,
      };

      await service.enqueue(payload);

      const [, serialised] = (redisService.set as jest.Mock).mock.calls[0];
      const stored = JSON.parse(serialised);
      expect(stored.correlationId).toBe(correlationId);
    });
  });

  describe('markSuccess', () => {
    it('should mark job as successful', async () => {
      (redisService.get as jest.Mock).mockResolvedValueOnce(
        JSON.stringify({
          id: 'job-1',
          status: JobStatus.PROCESSING,
          retries: 0,
        }),
      );

      await service.markSuccess('job-1', { processed: true });

      expect(redisService.set).toHaveBeenCalled();
      expect(redisService.del).toHaveBeenCalled();
    });
  });

  describe('markFailure', () => {
    it('should retry failed job if retries not exhausted', async () => {
      (redisService.get as jest.Mock).mockResolvedValueOnce(
        JSON.stringify({
          id: 'job-1',
          status: JobStatus.PROCESSING,
          retries: 0,
          maxRetries: 3,
        }),
      );

      const shouldRetry = await service.markFailure('job-1', 'Test error');

      expect(shouldRetry).toBe(true);
      expect(redisService.sAdd).toHaveBeenCalled();
    });

    it('should move to dead letter when retries exhausted', async () => {
      (redisService.get as jest.Mock).mockResolvedValueOnce(
        JSON.stringify({
          id: 'job-1',
          status: JobStatus.PROCESSING,
          retries: 2,
          maxRetries: 3,
        }),
      );

      const shouldRetry = await service.markFailure('job-1', 'Final error');

      expect(shouldRetry).toBe(false);
    });
  });
});
