import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { PartialFailureService } from '../failures/partial-failure.service';
import { PayoutRedemptionFailureInjectionService } from '../failures/payout-redemption-failure-injection.service';
import { FailureMode } from '../failures/failure-injection.interface';
import { PermissionDiffService } from '../auth/permission-diff.service';
import { StatusService } from '../status/status.service';
import { WorkflowResilienceService } from './workflow-resilience.service';
import { ExecuteWorkflowRequest } from './resilience.interface';

const NOW = Date.parse('2026-06-01T00:00:00.000Z');
const ADMIN = 'GADMIN0000000000000000000000000000000000000000000000000';

function payout(overrides: Partial<ExecuteWorkflowRequest> = {}): ExecuteWorkflowRequest {
  return {
    workflow: 'PAYOUT',
    bondId: 1,
    amount: '10000',
    counterPartyAddress: 'GAINVESTOR1',
    actorRole: 'issuer',
    actorAddress: ADMIN,
    now: NOW,
    ...overrides,
  };
}

function redemption(overrides: Partial<ExecuteWorkflowRequest> = {}): ExecuteWorkflowRequest {
  return {
    workflow: 'REDEMPTION',
    bondId: 1,
    amount: '100',
    counterPartyAddress: 'GAINVESTOR1',
    actorRole: 'investor',
    actorAddress: ADMIN,
    now: NOW,
    ...overrides,
  };
}

describe('WorkflowResilienceService (#degraded-workflow-slice)', () => {
  let service: WorkflowResilienceService;
  let injection: PayoutRedemptionFailureInjectionService;
  let failures: PartialFailureService;
  let status: StatusService;

  beforeEach(() => {
    failures = new PartialFailureService();
    injection = new PayoutRedemptionFailureInjectionService(failures);
    status = new StatusService(
      { isHealthy: () => true } as any,
      { findMany: jest.fn(async () => ({ data: [], meta: {} })) } as any,
    );
    service = new WorkflowResilienceService(
      injection,
      failures,
      status,
      new PermissionDiffService(),
    );
  });

  describe('normal path', () => {
    it('executes a payout with no injection and reports a healthy user status', async () => {
      const result = await service.execute(payout());

      expect(result.simulation.injected).toBe(false);
      expect(result.simulation.attempts).toBe(1);
      expect(result.recovered).toBe(true);
      expect(result.recoveryAction).toBe('NONE');
      expect(result.component).toBe('settlement');
      expect(result.userStatus.overallStatus).toBe('healthy');
      expect(result.userStatus.headline).toBe('All systems operational.');
      expect(result.userStatus.degraded).toEqual([]);
      expect(result.userStatus.report).toEqual(await status.getPublicStatus(NOW));
    });

    it('executes a redemption and maps it onto the redemption component', async () => {
      const result = await service.execute(redemption());

      expect(result.component).toBe('redemption');
      expect(result.simulation.recovered).toBe(true);
      expect(result.userStatus.overallStatus).toBe('healthy');
    });
  });

  describe('failure and retry paths', () => {
    it('auto-recovers a transient RPC timeout and leaves no degraded state behind', async () => {
      injection.registerRule(
        {
          flowType: 'PAYOUT',
          failureMode: FailureMode.TRANSIENT_RPC_TIMEOUT,
          description: 'seed a transient timeout',
        },
        ADMIN,
      );

      const result = await service.execute(payout());

      expect(result.simulation.injected).toBe(true);
      expect(result.simulation.attempts).toBe(2);
      expect(result.simulation.recoveryMethod).toBe('LEDGER_STATUS_POLL_AND_RETRY');
      expect(result.recovered).toBe(true);
      expect(result.recoveryAction).toBe('AUTO_RETRY');
      expect(result.userStatus.overallStatus).toBe('healthy');
      expect(result.userStatus.degraded).toEqual([]);
    });

    it('degrades the dependency when a redemption failure cannot be recovered', async () => {
      injection.registerRule(
        {
          flowType: 'REDEMPTION',
          failureMode: FailureMode.UNDERFUNDED_REDEMPTION_POOL,
          description: 'seed an underfunded pool',
        },
        ADMIN,
      );

      const result = await service.execute(redemption());

      expect(result.recovered).toBe(false);
      expect(result.recoveryAction).toBe('OPERATOR_RECOVERY_REQUIRED');
      expect(result.recordedFailureId).toBeDefined();
      expect(result.userStatus.overallStatus).toBe('degraded');
      expect(result.userStatus.degraded).toEqual([
        expect.objectContaining({
          component: 'redemption',
          mutationAllowed: false,
          message: expect.stringContaining('reconcile the pool'),
        }),
      ]);
      expect(failures.dashboard().unresolved).toBe(1);
    });

    it('recovers explicitly: clears the degraded component and resolves its failure', async () => {
      injection.registerRule(
        {
          flowType: 'REDEMPTION',
          failureMode: FailureMode.UNDERFUNDED_REDEMPTION_POOL,
          description: 'seed an underfunded pool',
        },
        ADMIN,
      );
      const failed = await service.execute(redemption());
      const recovered = await service.recover('redemption', ADMIN, NOW + 1);

      expect(recovered.overallStatus).toBe('healthy');
      expect(recovered.degraded).toEqual([]);
      expect(failures.get(failed.recordedFailureId!).status).toBe('resolved');
      expect(failures.dashboard().unresolved).toBe(0);
      // The archived/resolved record is still queryable — nothing was deleted.
      expect(failures.list({ status: 'resolved' })).toHaveLength(1);
    });

    it('replays an idempotent request without re-injecting or double-spending', async () => {
      const first = await service.execute(payout({ idempotencyKey: 'slice_key_1' }));
      const second = await service.execute(payout({ idempotencyKey: 'slice_key_1' }));

      expect(first.recovered).toBe(true);
      expect(second.simulation.recoveryMethod).toBe('IDEMPOTENT_CACHE_HIT');
      expect(second.simulation.transactionHash).toBe(first.simulation.transactionHash);
      expect(second.recoveryAction).toBe('NONE');
    });
  });

  describe('authorization paths', () => {
    it('refuses a role that lacks the workflow permission', async () => {
      await expect(service.execute(payout({ actorRole: 'investor' }))).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('honours a permission change: removing the payout permission blocks an issuer', async () => {
      service.applyPermissionChange(
        { ISSUER: ['bond:create', 'bond:distribute-coupon'] },
        { ISSUER: ['bond:create'] },
        ADMIN,
      );

      await expect(service.execute(payout({ actorRole: 'issuer' }))).rejects.toThrow(
        ForbiddenException,
      );

      service.resetPermissions();
      expect((await service.execute(payout({ actorRole: 'issuer' }))).recovered).toBe(true);
    });

    it('rejects a malformed or negative amount before any state changes', async () => {
      await expect(service.execute(payout({ amount: '12.5' }))).rejects.toThrow(/decimal integer/);
      await expect(service.execute(payout({ amount: '-1' }))).rejects.toThrow(/non-negative/);
    });

    it('surfaces a paused protocol as a 503 rather than mutating state', async () => {
      status.pauseProtocol('planned incident', ADMIN);

      await expect(service.execute(payout())).rejects.toThrow(ServiceUnavailableException);
      expect(failures.dashboard().unresolved).toBe(0);
    });
  });
});
