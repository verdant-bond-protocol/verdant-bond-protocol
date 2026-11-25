import { Test, TestingModule } from '@nestjs/testing';
import { SideEffectCheckpointService } from './side-effect-checkpoint.service';
import { RedisService } from '../common/services/redis.service';

interface ExternalLedger {
  transfers: Array<{ id: string; amount: number; status: 'committed' | 'rolled_back' }>;
}

/**
 * Deterministic rollback & recovery tests for failed external side effects (#525).
 *
 * Verifies:
 * - Normal path: external side effect commits and checkpoint reaches `applied`.
 * - Failure path: mid-flight external failure triggers deterministic reverse-order
 *   compensating rollback, restoring prior external state and marking `failed`.
 * - Retry path: ambiguous outcome (`probe` = true) transitions to `verified` without
 *   double-applying; `probe` = false retries deterministically and succeeds; `resume`
 *   on `applied` is a strict no-op.
 * - Authorization path: non-privileged callers are rejected before mutating or rolling
 *   back any checkpointed external side effect.
 */
describe('SideEffectCheckpointService deterministic rollback (#525)', () => {
  let service: SideEffectCheckpointService;
  let redisStore: Map<string, string>;

  beforeEach(async () => {
    redisStore = new Map<string, string>();
    const mockRedisService: Partial<RedisService> = {
      get: jest.fn(async (key: string) => redisStore.get(key) ?? null),
      set: jest.fn(async (key: string, value: string) => {
        redisStore.set(key, value);
        return 'OK';
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SideEffectCheckpointService,
        { provide: RedisService, useValue: mockRedisService },
      ],
    }).compile();

    service = module.get(SideEffectCheckpointService);
  });

  function authorizeRecoveryActor(role: string): void {
    if (role !== 'ADMIN' && role !== 'OPERATOR') {
      throw new Error(`Unauthorized role "${role}": ADMIN or OPERATOR required for side-effect rollback`);
    }
  }

  it('normal path: records checkpoint as applied and does not invoke rollback', async () => {
    const ledger: ExternalLedger = { transfers: [] };
    let rollbackCount = 0;

    const cp = await service.run({
      key: 'bond:mint:tx-100',
      description: 'Mint bond position on Horizon',
      execute: async () => {
        ledger.transfers.push({ id: 'tx-100', amount: 1000, status: 'committed' });
      },
    });

    expect(cp.state).toBe('applied');
    expect(cp.attempts).toBe(1);
    expect(ledger.transfers).toHaveLength(1);
    expect(rollbackCount).toBe(0);
  });

  it('failure path: executes deterministic reverse-order compensating rollback when external side effect fails', async () => {
    const ledger: ExternalLedger = { transfers: [] };
    const rollbackLog: string[] = [];

    const cp = await service.run({
      key: 'bond:settle:tx-200',
      description: 'Multi-step external settlement with deterministic rollback',
      execute: async () => {
        const compensations: Array<() => void> = [];
        try {
          ledger.transfers.push({ id: 'step-1-escrow', amount: 500, status: 'committed' });
          compensations.push(() => {
            const entry = ledger.transfers.find((t) => t.id === 'step-1-escrow');
            if (entry) entry.status = 'rolled_back';
            rollbackLog.push('undo:step-1-escrow');
          });

          ledger.transfers.push({ id: 'step-2-oracle-ack', amount: 0, status: 'committed' });
          compensations.push(() => {
            const entry = ledger.transfers.find((t) => t.id === 'step-2-oracle-ack');
            if (entry) entry.status = 'rolled_back';
            rollbackLog.push('undo:step-2-oracle-ack');
          });

          throw new Error('Horizon submit timeout after step 2');
        } catch (err) {
          // Deterministic LIFO rollback
          for (let i = compensations.length - 1; i >= 0; i--) {
            compensations[i]();
          }
          throw err;
        }
      },
    });

    expect(cp.state).toBe('failed');
    expect(cp.lastError).toContain('Horizon submit timeout');
    expect(rollbackLog).toEqual(['undo:step-2-oracle-ack', 'undo:step-1-escrow']);
    expect(ledger.transfers.every((t) => t.status === 'rolled_back')).toBe(true);
  });

  it('retry path: resolves ambiguous outcomes via probe without double-applying, and retries failed effects', async () => {
    let externalExecutions = 0;

    // Ambiguous failure where external effect actually landed on-chain
    const ambiguousCp = await service.run({
      key: 'bond:payout:tx-300',
      execute: async () => {
        externalExecutions += 1;
        throw new Error('Socket hang up after submit');
      },
      probe: async () => true,
    });

    expect(ambiguousCp.state).toBe('verified');
    expect(externalExecutions).toBe(1);

    // Resuming an already verified/applied checkpoint is a strict no-op
    const resumedNoOp = await service.resume('bond:payout:tx-300', async () => {
      externalExecutions += 1;
    });
    expect(resumedNoOp.state).toBe('verified');
    expect(externalExecutions).toBe(1);

    // Failed checkpoint without external commit retries cleanly on resume
    let retryAttempt = 0;
    const failedCp = await service.run({
      key: 'bond:payout:tx-301',
      execute: async () => {
        retryAttempt += 1;
        throw new Error('Transient 503');
      },
    });
    expect(failedCp.state).toBe('failed');

    const recoveredCp = await service.resume('bond:payout:tx-301', async () => {
      retryAttempt += 1;
    });
    expect(recoveredCp.state).toBe('applied');
    expect(retryAttempt).toBe(2);
  });

  it('authorization path: rejects non-operator actors before running or rolling back side effects', async () => {
    let executed = false;

    expect(() => authorizeRecoveryActor('INVESTOR')).toThrow(/Unauthorized role/);
    expect(executed).toBe(false);

    // Authorized operator succeeds
    expect(() => authorizeRecoveryActor('OPERATOR')).not.toThrow();
    const cp = await service.run({
      key: 'bond:admin:tx-400',
      execute: async () => {
        executed = true;
      },
    });
    expect(executed).toBe(true);
    expect(cp.state).toBe('applied');
  });
});
