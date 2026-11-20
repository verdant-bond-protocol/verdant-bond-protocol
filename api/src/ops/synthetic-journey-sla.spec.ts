import {
  SyntheticJourneyConfig,
  SyntheticJourneyMonitor,
  JourneyRuntime,
} from './synthetic-journey.monitor';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('SyntheticJourneyMonitor SLA and fault attribution (#543)', () => {
  const baseConfig: SyntheticJourneyConfig = {
    baseUrl: 'https://api.example.org',
    amount: 100,
    stepTimeoutMs: 5000,
    confirmTimeoutMs: 10000,
    confirmPollMs: 50,
  };

  function createRuntime(fetchImpl: typeof fetch): JourneyRuntime {
    let clock = 1_700_000_000_000;
    return {
      fetch: fetchImpl,
      now: () => {
        clock += 25;
        return clock;
      },
      sleep: async () => {},
      idempotencyKey: () => 'idem-543-key',
    };
  }

  it('completes read-only synthetic journey and records per-step SLA latency', async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/health/ready')) {
        return jsonResponse({ redis: 'up', contracts: { bond: { status: 'healthy' } } });
      }
      if (url.includes('/api/bonds?page=1')) {
        return jsonResponse({
          data: [{ id: 7, status: 'Active', totalSupply: '1000', totalSubscribed: '200' }],
        });
      }
      if (url.endsWith('/api/bonds/7/detail')) {
        return jsonResponse({ id: 7, status: 'Active' });
      }
      if (url.includes('/api/bonds/7/preview-subscribe')) {
        return jsonResponse({ expected_failure: null });
      }
      return jsonResponse({}, 404);
    });

    const monitor = new SyntheticJourneyMonitor(baseConfig, createRuntime(fetchMock as unknown as typeof fetch));
    const report = await monitor.run();

    expect(report.ok).toBe(true);
    expect(report.blame).toBeNull();
    expect(report.bondId).toBe(7);
    expect(report.steps.map((s) => s.name)).toEqual([
      'readiness',
      'list-bonds',
      'bond-detail',
      'preview-subscribe',
    ]);
    expect(report.totalLatencyMs).toBeGreaterThan(0);
    expect(report.steps.every((s) => s.ok && s.latencyMs > 0)).toBe(true);
  });

  it('attributes Soroban RPC 5xx failures to soroban-rpc and halts subsequent dependent steps', async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/health/ready')) {
        return jsonResponse({ redis: 'up', contracts: { bond: { status: 'healthy' } } });
      }
      if (url.includes('/api/bonds?page=1')) {
        return jsonResponse({ error: 'Soroban RPC unavailable' }, 503);
      }
      return jsonResponse({}, 404);
    });

    const monitor = new SyntheticJourneyMonitor(baseConfig, createRuntime(fetchMock as unknown as typeof fetch));
    const report = await monitor.run();

    expect(report.ok).toBe(false);
    expect(report.blame).toBe('soroban-rpc');
    expect(report.steps.find((s) => s.name === 'list-bonds')).toMatchObject({
      ok: false,
      httpStatus: 503,
      dependency: 'soroban-rpc',
    });
    expect(report.steps.some((s) => s.name === 'bond-detail')).toBe(false);
  });

  it('records degraded readiness dependencies (redis) and attributes data exhaustion when no bond has capacity', async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/health/ready')) {
        return jsonResponse({ redis: 'down', contracts: { bond: { status: 'healthy' } } });
      }
      if (url.includes('/api/bonds?page=1')) {
        return jsonResponse({
          data: [{ id: 1, status: 'Active', totalSupply: '100', totalSubscribed: '100' }],
        });
      }
      return jsonResponse({}, 404);
    });

    const monitor = new SyntheticJourneyMonitor(baseConfig, createRuntime(fetchMock as unknown as typeof fetch));
    const report = await monitor.run();

    expect(report.ok).toBe(false);
    expect(report.degradedDependencies).toEqual(['redis']);
    expect(report.blame).toBe('redis');
    const listStep = report.steps.find((s) => s.name === 'list-bonds');
    expect(listStep).toMatchObject({ ok: false, dependency: 'data' });
  });

  it('executes authenticated write flow with idempotency key and confirms transaction', async () => {
    let confirmCalls = 0;
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/health/ready')) {
        return jsonResponse({ redis: 'up', contracts: { bond: { status: 'healthy' } } });
      }
      if (url.includes('/api/bonds?page=1')) {
        return jsonResponse({
          data: [{ id: 9, status: 'Active', totalSupply: '500', totalSubscribed: '0' }],
        });
      }
      if (url.endsWith('/api/bonds/9/detail')) {
        return jsonResponse({ id: 9, status: 'Active' });
      }
      if (url.includes('/api/bonds/9/preview-subscribe')) {
        return jsonResponse({ expected_failure: null });
      }
      if (url.endsWith('/api/bonds/9/subscribe')) {
        const headers = init?.headers as Record<string, string>;
        expect(headers['Authorization']).toBe('Bearer synth-token');
        expect(headers['Idempotency-Key']).toBe('idem-543-key');
        return jsonResponse({ transactionHash: 'tx-abc-123' }, 201);
      }
      if (url.endsWith('/api/stellar/transactions/tx-abc-123')) {
        confirmCalls += 1;
        return jsonResponse({ status: confirmCalls >= 2 ? 'confirmed' : 'pending' });
      }
      return jsonResponse({}, 404);
    });

    const writeConfig: SyntheticJourneyConfig = {
      ...baseConfig,
      write: {
        token: 'synth-token',
        investorAddress: 'GABC1234567890',
      },
    };
    const monitor = new SyntheticJourneyMonitor(writeConfig, createRuntime(fetchMock as unknown as typeof fetch));
    const report = await monitor.run();

    expect(report.ok).toBe(true);
    expect(report.transactionHash).toBe('tx-abc-123');
    expect(confirmCalls).toBe(2);
    expect(report.steps.map((s) => s.name)).toEqual([
      'readiness',
      'list-bonds',
      'bond-detail',
      'preview-subscribe',
      'subscribe',
      'confirm-transaction',
    ]);
  });
});
