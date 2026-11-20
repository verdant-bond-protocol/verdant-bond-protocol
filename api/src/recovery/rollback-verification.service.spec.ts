import { RollbackVerificationService, RollbackVerificationInput } from './rollback-verification.service';

describe('RollbackVerificationService (Issue #312)', () => {
  let service: RollbackVerificationService;

  beforeEach(() => {
    service = new RollbackVerificationService();
  });

  it('1. Clean Rollback: returns CLEAN status when all state, jobs, and references are consistent', () => {
    const input: RollbackVerificationInput = {
      targetVersion: 'v1.4.0',
      bondRecords: [
        { id: 1, status: 'ACTIVE', totalIssued: BigInt('500000'), holderCount: 25 },
        { id: 2, status: 'MATURED', totalIssued: BigInt('1000000'), holderCount: 50 },
      ],
      jobRecords: [
        { id: 'job_1', type: 'COUPON_PAYOUT', status: 'COMPLETED', lastStepId: 'step_final', interruptedMs: 0 },
      ],
      externalRefRecords: [
        { id: 'ref_1', url: 'https://ipfs.io/ipfs/QmValid', verified: true },
      ],
    };

    const report = service.verifyRollback(input);

    expect(report.overallStatus).toBe('CLEAN');
    expect(report.isReadOnly).toBe(true);
    expect(report.recordsRequiringRepair).toHaveLength(0);
    expect(report.summaryText).toContain('completed cleanly');
    expect(report.checkedComponents).toContain('user_facing_state');
    expect(report.checkedComponents).toContain('background_jobs');
  });

  it('2. Partial Rollback: detects interrupted background jobs and unverified external references requiring repair', () => {
    const input: RollbackVerificationInput = {
      targetVersion: 'v1.4.0',
      bondRecords: [
        { id: 1, status: 'ACTIVE', totalIssued: BigInt('500000'), holderCount: 25 },
      ],
      jobRecords: [
        { id: 'job_stuck', type: 'BOND_ISSUANCE', status: 'INTERRUPTED', lastStepId: 'step_2_transfer', interruptedMs: 3600000 },
      ],
      externalRefRecords: [
        { id: 'ref_unverified', url: 'https://ipfs.io/ipfs/QmMissing', verified: false },
      ],
    };

    const report = service.verifyRollback(input);

    expect(report.overallStatus).toBe('PARTIAL_REPAIR_REQUIRED');
    expect(report.isReadOnly).toBe(true);
    expect(report.recordsRequiringRepair).toHaveLength(2);

    const jobRepair = report.recordsRequiringRepair.find((r) => r.component === 'background_jobs');
    expect(jobRepair).toBeDefined();
    expect(jobRepair?.issueType).toBe('INTERRUPTED_JOB');
    expect(jobRepair?.suggestedAction).toContain('RecoveryService.resume');

    const refRepair = report.recordsRequiringRepair.find((r) => r.component === 'external_references');
    expect(refRepair).toBeDefined();
    expect(refRepair?.issueType).toBe('UNVERIFIED_REFERENCE');
  });

  it('3. Failed Rollback / Critical Mismatch: detects corrupted bond state post-rollback', () => {
    const input: RollbackVerificationInput = {
      targetVersion: 'v1.4.0',
      bondRecords: [
        { id: 99, status: 'INVALID_STATE', totalIssued: BigInt('-100'), holderCount: 0 },
      ],
    };

    const report = service.verifyRollback(input);

    expect(report.overallStatus).toBe('CRITICAL_MISMATCH');
    expect(report.isReadOnly).toBe(true);
    expect(report.recordsRequiringRepair).toHaveLength(1);
    expect(report.recordsRequiringRepair[0].issueType).toBe('CORRUPTED_BOND_STATE');
    expect(report.recordsRequiringRepair[0].suggestedAction).toContain('reindex-holders');
  });
});
