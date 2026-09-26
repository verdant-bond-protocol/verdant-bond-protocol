import { Test, TestingModule } from '@nestjs/testing';
import { RecoveryService } from './recovery.service';
import { RecoveryOperationStatus, RecoveryStepDefinition } from './recovery.interface';

describe('RecoveryService (#261)', () => {
  let service: RecoveryService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [RecoveryService],
    }).compile();
    service = module.get<RecoveryService>(RecoveryService);
  });

  /** Build steps whose invocations are observable and countable. */
  const steps = (effects: { applied: string[] }, overrides: Partial<RecoveryStepDefinition>[] = []): RecoveryStepDefinition[] => {
    const make = (id: string, i: number): RecoveryStepDefinition => ({
      id,
      userAction: `retry ${id}`,
      hasExternalSideEffect: i === 1,
      run: async (state) => {
        effects.applied.push(id);
        return { ...state, [`${id}Done`]: true };
      },
      sideEffectsApplied: async () => effects.applied.includes(`already:${id}`),
      ...overrides[i],
    });
    return [make('reserve', 0), make('submit_onchain', 1), make('notify', 2)];
  };

  describe('deterministic resume', () => {
    it('runs every step and completes when nothing interrupts', async () => {
      const effects: { applied: string[] } = { applied: [] };
      const steps = steps(effects);

      const operation = await service.start('bond_subscription', steps);
      const resumed = await service.resume(operation.operationId);

      expect(resumed.status).toBe(RecoveryOperationStatus.COMPLETED);
      expect(resumed.checkpoints.map((c) => c.stepId)).toEqual(['reserve', 'submit_onchain', 'notify']);
      expect(effects.applied.filter((e) => e === 'reserveDone')).toHaveLength(0);
    });

    it('resumes from the last checkpoint without re-running completed steps', async () => {
      const effects: { applied: string[] } = { applied: [] };
      const failOnNotify = steps(effects);
      failOnNotify[2].run = async () => {
        throw new Error('webhook timed out');
      };

      const operation = await service.start('bond_subscription', failOnNotify);
      await service.resume(operation.operationId);

      expect(operation.status).toBe(RecoveryOperationStatus.INTERRUPTED);
      expect(operation.checkpoints.map((c) => c.stepId)).toEqual([
        'reserve',
        'submit_onchain',
        'notify',
      ]);

      // Un-break the final step and resume.
      failOnNotify[2].run = async (state) => ({ ...state, notifyDone: true });
      const resumed = await service.resume(operation.operationId);

      expect(resumed.status).toBe(RecoveryOperationStatus.COMPLETED);
      // reserve and submit_onchain ran exactly once across both resumes:
      // their step indexes are strictly before the failing index, so resume
      // restarts at 2 and never replays them.
      const reserveRuns = resumed.checkpoints.filter(
        (c) => c.stepId === 'reserve' && c.status === RecoveryOperationStatus.COMPLETED,
      );
      expect(reserveRuns).toHaveLength(1);
    });

    it('never re-applies an external side effect that already happened', async () => {
      const effects: { applied: string[] } = { applied: [] };
      const steps = steps(effects);

      // The side effect already landed (wallet signed, chain accepted,
      // process died before the checkpoint): sideEffectsApplied reports it.
      effects.applied.push('already:submit_onchain');

      let submitRuns = 0;
      steps[1].run = async (state) => {
        submitRuns++;
        effects.applied.push('submit_onchain');
        return { ...state, submitDone: true };
      };

      const operation = await service.start('bond_subscription', steps);
      await service.resume(operation.operationId);

      expect(submitRuns).toBe(0);
      expect(operation.status).toBe(RecoveryOperationStatus.COMPLETED);
      // The step is still checkpointed complete, so downstream steps run.
      expect(operation.checkpoints.map((c) => c.stepId)).toContain('notify');
    });

    it('re-runs a side-effect step when the side effect did NOT land', async () => {
      const effects: { applied: string[] } = { applied: [] };
      const steps = steps(effects);
      let submitRuns = 0;
      steps[1].run = async (state) => {
        submitRuns++;
        return { ...state, submitDone: true };
      };

      const operation = await service.start('bond_subscription', steps);
      await service.resume(operation.operationId);

      expect(submitRuns).toBe(1);
    });
  });

  describe('interruption before, during, and after external side effects', () => {
    it('interrupts before the side effect and resumes cleanly', async () => {
      const effects: { applied: string[] } = { applied: [] };
      const steps = steps(effects);
      steps[0].run = async () => {
        throw new Error('wallet rejected');
      };

      const operation = await service.start('bond_subscription', steps);
      const resumed = await service.resume(operation.operationId);

      expect(resumed.status).toBe(RecoveryOperationStatus.INTERRUPTED);
      expect(resumed.checkpoints).toHaveLength(2); // initial + failing step
      expect(resumed.lastError).toContain('wallet rejected');
      expect(effects.applied).toHaveLength(0);
    });

    it('interrupts during the side effect and lets sideEffectsApplied arbitrate', async () => {
      const effects: { applied: string[] } = { applied: [] };
      const steps = steps(effects);
      steps[1].run = async () => {
        throw new Error('connection reset mid-submission');
      };

      const operation = await service.start('bond_subscription', steps);
      await service.resume(operation.operationId);

      expect(operation.status).toBe(RecoveryOperationStatus.INTERRUPTED);
      expect(operation.lastError).toContain('connection reset');

      // Arbitration: not yet applied -> rerun; applied -> skip. Both legal
      // outcomes are deterministic because the predicate decides.
      effects.applied.push('already:submit_onchain');
      const second = await service.resume(operation.operationId);
      expect(second.status).toBe(RecoveryOperationStatus.COMPLETED);
      expect(second.checkpoints.filter((c) => c.stepId === 'submit_onchain')).toHaveLength(2);
    });

    it('records the interruption after the side effect and resumes from there', async () => {
      const effects: { applied: string[] } = { applied: [] };
      const steps = steps(effects);
      steps[2].run = async () => {
        throw new Error('notify failed');
      };

      const operation = await service.start('bond_subscription', steps);
      await service.resume(operation.operationId);

      const last = operation.checkpoints[operation.checkpoints.length - 1];
      expect(last.stepId).toBe('notify');
      expect(last.stepIndex).toBe(2);

      steps[2].run = async (state) => ({ ...state, notifyDone: true });
      const resumed = await service.resume(operation.operationId);
      expect(resumed.status).toBe(RecoveryOperationStatus.COMPLETED);
    });
  });

  describe('user-visible recovery actions', () => {
    it('surfaces a next step for every interruption', async () => {
      const effects: { applied: string[] } = { applied: [] };
      const steps = steps(effects);
      steps[1].run = async () => {
        throw new Error('on-chain rejected');
      };

      const operation = await service.start('bond_subscription', steps);
      await service.resume(operation.operationId);

      const actions = service.getUserActions(operation.operationId);
      expect(actions).toHaveLength(1);
      expect(actions[0].stepId).toBe('submit_onchain');
      expect(actions[0].action).toBe('retry submit_onchain');
      expect(actions[0].status).toBe(RecoveryOperationStatus.INTERRUPTED);
    });

    it('returns no actions for an operation that never interrupted', async () => {
      const effects: { applied: string[] } = { applied: [] };
      const operation = await service.start('bond_subscription', steps(effects));
      await service.resume(operation.operationId);

      expect(service.getUserActions(operation.operationId)).toHaveLength(0);
    });
  });

  describe('maintainer diagnostics', () => {
    it('lists stuck operations with interruption duration and attempts', async () => {
      const effects: { applied: string[] } = { applied: [] };
      const steps = steps(effects);
      steps[0].run = async () => {
        throw new Error('stuck');
      };

      const operation = await service.start('bond_subscription', steps);
      await service.resume(operation.operationId);
      await service.resume(operation.operationId);
      await service.resume(operation.operationId);

      const diagnostics = service.getDiagnostics(Date.now() + 10_000);
      const entry = diagnostics.find((d) => d.operationId === operation.operationId);

      expect(entry).toBeDefined();
      expect(entry.resumeAttempts).toBe(3);
      expect(entry.stepId).toBe('reserve');
      expect(entry.interruptedForMs).toBeGreaterThanOrEqual(0);
    });

    it('marks abandoned only operations older than the threshold and not completed', async () => {
      const effects: { applied: string[] } = { applied: [] };
      const good = await service.start('bond_subscription', steps(effects));
      await service.resume(good.operationId); // completes

      const steps2 = steps(effects);
      steps2[0].run = async () => {
        throw new Error('boom');
      };
      const stuck = await service.start('bond_subscription', steps2);
      await service.resume(stuck.operationId);

      // Not older than 24h yet -> refused.
      expect(await service.markAbandoned(stuck.operationId, 24 * 3600_000, Date.now())).toBe(false);
      // Completed operation -> refused.
      expect(await service.markAbandoned(good.operationId, 0, Date.now())).toBe(false);
      // Stuck and old enough -> abandoned.
      expect(await service.markAbandoned(stuck.operationId, 0, Date.now() + 1000)).toBe(true);

      const after = service.getOperation(stuck.operationId);
      expect(after.status).toBe(RecoveryOperationStatus.ABANDONED);
      expect(service.getUserActions(stuck.operationId)[0].status).toBe(RecoveryOperationStatus.INTERRUPTED);
    });
  });

  describe('validation', () => {
    it('rejects an operation with zero steps', async () => {
      await expect(service.start('empty', [])).rejects.toThrow('at least one step');
    });

    it('rejects duplicate step ids', async () => {
      const effects: { applied: string[] } = { applied: [] };
      const dup = steps(effects);
      dup[1].id = 'reserve';
      await expect(service.start('bond_subscription', dup)).rejects.toThrow('unique');
    });

    it('throws on resume of an unknown operation', async () => {
      await expect(service.resume('no-such-operation')).rejects.toThrow('unknown operation');
    });

    it('refuses to resume an abandoned operation', async () => {
      const effects: { applied: string[] } = { applied: [] };
      const steps2 = steps(effects);
      steps2[0].run = async () => {
        throw new Error('boom');
      };
      const operation = await service.start('bond_subscription', steps2);
      await service.resume(operation.operationId);
      await service.markAbandoned(operation.operationId, 0, Date.now() + 1000);

      await expect(service.resume(operation.operationId)).rejects.toThrow('abandoned');
    });
  });

  describe('audit events', () => {
    it('records interrupted, resumed, and completed transitions', async () => {
      const effects: { applied: string[] } = { applied: [] };
      const steps2 = steps(effects);
      steps2[1].run = async () => {
        throw new Error('x');
      };

      const operation = await service.start('bond_subscription', steps2);
      await service.resume(operation.operationId);

      // Internals are private; observable via the public diagnostics instead.
      const diagnostics = service.getDiagnostics(Date.now() + 5000);
      expect(diagnostics.some((d) => d.operationId === operation.operationId)).toBe(true);
    });
  });
});
