import { SideEffectCheckpointService } from './side-effect-checkpoint.service';
import { SideEffectError } from './side-effect-checkpoint.interface';

function redisStub() {
  const store = new Map<string, string>();
  return {
    store,
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => {
      store.set(k, v);
      return 'OK';
    }),
    scanKeys: jest.fn(async () => [...store.keys()]),
  };
}

function makeService() {
  const redis = redisStub();
  const service = new SideEffectCheckpointService(redis as any);
  return { service, redis };
}

describe('SideEffectCheckpointService.run', () => {
  it('normal path: a successful effect records an applied checkpoint on the first attempt', async () => {
    const { service } = makeService();
    const execute = jest.fn(async () => {});

    const cp = await service.run({ key: 'effect-a', execute });

    expect(cp.state).toBe('applied');
    expect(cp.attempts).toBe(1);
    expect(cp.appliedAt).toBeTruthy();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('failure path (no probe): a thrown error records failed and is safe to retry', async () => {
    const { service } = makeService();
    const execute = jest.fn(async () => {
      throw new Error('network down');
    });

    const cp = await service.run({ key: 'effect-b', execute });

    expect(cp.state).toBe('failed');
    expect(cp.lastError).toBe('network down');
    expect(cp.appliedAt).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('ambiguous failure with a confirming probe marks the effect verified (applied), not retried', async () => {
    const { service } = makeService();
    const execute = jest.fn(async () => {
      throw new Error('timeout after send');
    });
    const probe = jest.fn(async () => true);

    const cp = await service.run({ key: 'effect-c', execute, probe });

    expect(cp.state).toBe('verified');
    expect(cp.appliedAt).toBeTruthy();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('ambiguous failure with a negative probe marks the effect failed', async () => {
    const { service } = makeService();
    const execute = jest.fn(async () => {
      throw new Error('timeout after send');
    });
    const probe = jest.fn(async () => false);

    const cp = await service.run({ key: 'effect-d', execute, probe });

    expect(cp.state).toBe('failed');
    expect(cp.lastError).toBe('timeout after send');
  });

  it('ambiguous failure where the probe itself fails records unknown for an operator', async () => {
    const { service } = makeService();
    const execute = jest.fn(async () => {
      throw new Error('timeout after send');
    });
    const probe = jest.fn(async () => {
      throw new Error('probe unreachable');
    });

    const cp = await service.run({ key: 'effect-e', execute, probe });

    expect(cp.state).toBe('unknown');
    expect(cp.lastError).toContain('probe failed: probe unreachable');
  });

  it('attempts accumulate across runs of the same key', async () => {
    const { service } = makeService();
    const execute = jest.fn(async () => {
      throw new Error('boom');
    });

    await service.run({ key: 'effect-f', execute });
    const second = await service.run({ key: 'effect-f', execute });

    expect(second.attempts).toBe(2);
  });
});

describe('SideEffectCheckpointService.resume', () => {
  it('idempotency: resuming an applied effect never re-runs execute', async () => {
    const { service } = makeService();
    await service.run({ key: 'effect-a', execute: async () => {} });

    const execute = jest.fn(async () => {});
    const cp = await service.resume('effect-a', execute);

    expect(cp.state).toBe('applied');
    expect(execute).not.toHaveBeenCalled();
  });

  it('retries a failed effect', async () => {
    const { service } = makeService();
    await service.run({
      key: 'effect-g',
      execute: async () => {
        throw new Error('first fail');
      },
    });

    const execute = jest.fn(async () => {});
    const cp = await service.resume('effect-g', execute);

    expect(cp.state).toBe('applied');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(cp.attempts).toBe(2);
  });

  it('resolves an unknown effect to verified when the probe says it landed (no re-run)', async () => {
    const { service } = makeService();
    await service.run({
      key: 'effect-h',
      execute: async () => {
        throw new Error('timeout');
      },
      probe: async () => {
        throw new Error('probe down');
      },
    });

    const execute = jest.fn(async () => {});
    const cp = await service.resume('effect-h', execute, async () => true);

    expect(cp.state).toBe('verified');
    expect(execute).not.toHaveBeenCalled();
  });

  it('re-runs an unknown effect when the probe reports it did not land', async () => {
    const { service } = makeService();
    await service.run({
      key: 'effect-i',
      execute: async () => {
        throw new Error('timeout');
      },
      probe: async () => {
        throw new Error('probe down');
      },
    });

    const execute = jest.fn(async () => {});
    const cp = await service.resume('effect-i', execute, async () => false);

    expect(cp.state).toBe('applied');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('authorization/safety: an interrupted effect without a probe stays unknown rather than double-applying', async () => {
    const { service } = makeService();
    await service.run({
      key: 'effect-j',
      execute: async () => {
        throw new Error('interrupted');
      },
      probe: async () => {
        throw new Error('probe down');
      },
    });

    const execute = jest.fn(async () => {});
    const cp = await service.resume('effect-j', execute);

    expect(cp.state).toBe('unknown');
    expect(execute).not.toHaveBeenCalled();
  });

  it('throws when resuming a key that was never checkpointed', async () => {
    const { service } = makeService();

    await expect(service.resume('missing', async () => {})).rejects.toBeInstanceOf(SideEffectError);
  });
});

describe('SideEffectCheckpointService storage', () => {
  it('persists checkpoints to redis and reads them back after the in-process cache is cleared', async () => {
    const { service, redis } = makeService();
    await service.run({ key: 'effect-k', execute: async () => {} });

    expect(redis.store.has('sideeffect:effect-k')).toBe(true);

    service.clear();
    const reloaded = await service.get('effect-k');

    expect(reloaded).toMatchObject({ key: 'effect-k', state: 'applied' });
  });

  it('lists checkpoints and separates pending (unknown/started) ones', async () => {
    const { service } = makeService();
    await service.run({ key: 'done', execute: async () => {} });
    await service.run({
      key: 'pending',
      execute: async () => {
        throw new Error('x');
      },
      probe: async () => {
        throw new Error('probe down');
      },
    });

    const all = await service.list();
    const pending = await service.getPending();

    expect(all).toHaveLength(2);
    expect(pending.map((p) => p.key)).toEqual(['pending']);
    expect(pending[0].state).toBe('unknown');
  });
});
