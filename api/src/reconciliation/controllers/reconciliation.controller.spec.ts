import { Test, TestingModule } from '@nestjs/testing';
import { ReconciliationController } from './reconciliation.controller';
import { ReconciliationService } from '../services/reconciliation.service';
import { DomainInvariantsService } from '../services/domain-invariants.service';
import { JobQueueService } from '../../workers/services/job-queue.service';
import { JobType } from '../../workers/interfaces/job.interface';

describe('ReconciliationController', () => {
  let controller: ReconciliationController;
  let reconciliationService: Partial<ReconciliationService>;
  let domainInvariantsService: Partial<DomainInvariantsService>;
  let jobQueueService: Partial<JobQueueService>;

  beforeEach(async () => {
    reconciliationService = {
      runDryRun: jest.fn().mockResolvedValue({
        timestamp: new Date(),
        dryRun: true,
        totalEntitiesChecked: 0,
        status: 'HEALTHY',
        driftsFound: [],
        summary: { missingCount: 0, duplicateCount: 0, staleCount: 0, inconsistentCount: 0 },
      }),
      getInvariantCount: jest.fn().mockReturnValue(5),
    };

    domainInvariantsService = {
      validateDomainInvariants: jest.fn().mockResolvedValue({
        timestamp: new Date(),
        dryRun: true,
        totalEntitiesChecked: 10,
        status: 'HEALTHY',
        driftsFound: [],
        summary: { missingCount: 0, orphanedCount: 0, duplicateCount: 0, staleCount: 0, inconsistentCount: 0 },
      }),
    };

    jobQueueService = {
      enqueue: jest.fn().mockResolvedValue({
        id: 'job-1',
        type: JobType.RECONCILIATION,
        status: 'pending',
      } as any),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ReconciliationController],
      providers: [
        { provide: ReconciliationService, useValue: reconciliationService },
        { provide: DomainInvariantsService, useValue: domainInvariantsService },
        { provide: JobQueueService, useValue: jobQueueService },
      ],
    }).compile();

    controller = module.get<ReconciliationController>(ReconciliationController);
  });

  it('runs dry run reconciliation', async () => {
    const report = await controller.runDryRun();
    expect(report.dryRun).toBe(true);
    expect(reconciliationService.runDryRun).toHaveBeenCalled();
  });

  it('validates restore domain invariants via validateRestore', async () => {
    const report = await controller.validateRestore();
    expect(report.status).toBe('HEALTHY');
    expect(domainInvariantsService.validateDomainInvariants).toHaveBeenCalled();
  });

  it('enqueues a reconciliation background job', async () => {
    const job = await controller.enqueueReconciliationJob({ dryRun: true });
    expect(job.id).toBe('job-1');
    expect(jobQueueService.enqueue).toHaveBeenCalledWith(
      { type: JobType.RECONCILIATION, data: { dryRun: true } },
      2,
    );
  });

  it('returns invariant status count', async () => {
    const status = await controller.getStatus();
    expect(status.invariantCount).toBe(5);
  });
});
