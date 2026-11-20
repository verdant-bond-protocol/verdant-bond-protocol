import { normalizeTelemetryRoute, TelemetryService, type TelemetryFields } from './telemetry.service';

/**
 * Deterministic sampling and bounded-label coverage (contributor slice).
 *
 * The existing telemetry spec exercises redaction and cardinality clamping but
 * uses real randomness, so adaptive sampling under load can only be asserted
 * one-sided. Injecting the randomness source makes the exact decision
 * reproducible, which is what a retry/authorization regression needs.
 */

const event = (overrides: Partial<TelemetryFields> = {}): TelemetryFields => ({
  operation: 'browse_catalog',
  actorType: 'user',
  result: 'success',
  durationMs: 10,
  correlationId: 'corr-1',
  ...overrides,
});

describe('normalizeTelemetryRoute', () => {
  it('preserves static route segments and drops query strings', () => {
    expect(normalizeTelemetryRoute('/api/bonds?page=1&limit=20')).toBe('/api/bonds');
    expect(normalizeTelemetryRoute('/api/bonds/3/preview-subscribe?amount=1')).toBe(
      '/api/bonds/:id/preview-subscribe',
    );
  });

  it('collapses ids, UUIDs, Stellar addresses and opaque hashes', () => {
    expect(normalizeTelemetryRoute('/api/bonds/42/detail')).toBe('/api/bonds/:id/detail');
    expect(normalizeTelemetryRoute('/api/orders/3f2b1a90-1234-4abc-8def-0123456789ab')).toBe(
      '/api/orders/:uuid',
    );
    expect(normalizeTelemetryRoute('/api/holders/GA2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBe(
      '/api/holders/:address',
    );
    expect(normalizeTelemetryRoute('/api/stellar/transactions/' + 'a'.repeat(64))).toBe(
      '/api/stellar/transactions/:token',
    );
  });

  it('is stable when the same route is seen with different ids', () => {
    const a = normalizeTelemetryRoute('/api/bonds/1/detail');
    const b = normalizeTelemetryRoute('/api/bonds/999999/detail');
    expect(a).toBe(b);
  });
});

describe('TelemetryService deterministic sampling (contributor slice)', () => {
  let logSpy: jest.SpyInstance | undefined;

  afterEach(() => logSpy?.mockRestore());

  const serviceWith = (random: () => number, options: Record<string, unknown> = {}) => {
    const service = new TelemetryService({ samplingRandom: random, ...options } as any);
    logSpy = jest.spyOn(service['logger'], 'log').mockImplementation();
    service.resetStats();
    return service;
  };

  it('samples exactly when the injected draw is below the configured rate', () => {
    let draw = 0.2;
    const service = serviceWith(() => draw, { sampleRateSuccess: 0.25 });

    expect(service.emit(event())).toBe(true);
    draw = 0.5;
    expect(service.emit(event())).toBe(false);
    expect(service.getStats().totalSampledOut).toBe(1);
  });

  it('adapts the rate under high volume using the deterministic draw', () => {
    // threshold 2: after 3 events the effective rate is 2/3 (~0.67).
    const draw = 0.9;
    const service = serviceWith(() => draw, {
      sampleRateSuccess: 1.0,
      highVolumeThresholdPerMin: 2,
    });

    expect(service.emit(event({ correlationId: '1' }))).toBe(true);
    expect(service.emit(event({ correlationId: '2' }))).toBe(true);
    // Third event: 0.9 >= 2/3, so it is sampled out.
    expect(service.emit(event({ correlationId: '3' }))).toBe(false);
    expect(service.getStats().totalSampledOut).toBe(1);
  });

  it('retry path: failures and partials are retained regardless of the draw', () => {
    const service = serviceWith(() => 0.999, { sampleRateSuccess: 0, highVolumeThresholdPerMin: 1 });

    expect(service.emit(event({ result: 'failure', error: 'boom' }))).toBe(true);
    expect(service.emit(event({ result: 'partial' }))).toBe(true);
    expect(service.emit(event({ error: 'downstream timeout' }))).toBe(true);
    expect(service.getStats().totalEmitted).toBe(3);
  });

  it('authorization path: admin and critical operations are always retained', () => {
    const service = serviceWith(() => 0.999, { sampleRateSuccess: 0 });

    expect(service.emit(event({ actorType: 'admin' }))).toBe(false); // actor alone is not a retention rule
    expect(service.emit(event({ operation: 'settlement' }))).toBe(true);
    expect(service.emit(event({ operation: 'kyc_verification' }))).toBe(true);
  });

  it('records the effective sample rate on emitted events', () => {
    const service = serviceWith(() => 0.1, {
      sampleRateSuccess: 0.25,
      highVolumeThresholdPerMin: 2,
    });
    service.emit(event({ correlationId: '1' }));
    service.emit(event({ correlationId: '2' }));

    const payload = JSON.parse(logSpy!.mock.calls.at(-1)![0]);
    expect(payload.sampleRate).toBe(0.25);
    expect(payload.isSampled).toBe(true);
  });
});
