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
            set: jest.fn(),
            get: jest.fn(),
            del: jest.fn(),
            sAdd: jest.fn(),
            sMembers: jest.fn().mockResolvedValue([]),
            expire: jest.fn(),
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
