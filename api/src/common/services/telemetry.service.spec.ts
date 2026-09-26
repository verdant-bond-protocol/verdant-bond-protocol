import { Test, TestingModule } from '@nestjs/testing';
import { TelemetryService, TelemetryFields } from './telemetry.service';

describe('TelemetryService', () => {
  let service: TelemetryService;
  let logSpy: jest.SpyInstance;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TelemetryService],
    }).compile();

    service = module.get<TelemetryService>(TelemetryService);
    logSpy = jest.spyOn(service['logger'], 'log').mockImplementation();
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('should emit success telemetry', () => {
    const fields: TelemetryFields = {
      operation: 'bond_purchase',
      actorType: 'user',
      result: 'success',
      durationMs: 125,
      correlationId: 'test-id-123',
      userId: 'user-456',
    };

    service.emit(fields);

    expect(logSpy).toHaveBeenCalled();
    const emitted = JSON.parse(logSpy.mock.calls[0][0]);
    expect(emitted.operation).toBe('bond_purchase');
    expect(emitted.result).toBe('success');
    expect(emitted.durationMs).toBe(125);
  });

  it('should emit failure telemetry with error code', () => {
    const fields: TelemetryFields = {
      operation: 'coupon_distribution',
      actorType: 'system',
      result: 'failure',
      durationMs: 5000,
      correlationId: 'fail-id-789',
      error: 'Insufficient balance',
      errorCode: '400',
    };

    service.emit(fields);

    expect(logSpy).toHaveBeenCalled();
    const emitted = JSON.parse(logSpy.mock.calls[0][0]);
    expect(emitted.result).toBe('failure');
    expect(emitted.error).toBe('Insufficient balance');
  });

  it('should sanitize fields correctly', () => {
    const fields: TelemetryFields = {
      operation: 'portfolio_fetch',
      actorType: 'admin',
      result: 'success',
      durationMs: 234,
      correlationId: 'admin-id-xyz',
      businessMetric: { bondCount: 5, totalValue: '1000000' },
    };

    service.emit(fields);

    expect(logSpy).toHaveBeenCalled();
    const emitted = JSON.parse(logSpy.mock.calls[0][0]);
    expect(emitted.businessMetric).toEqual({ bondCount: 5, totalValue: '1000000' });
  });
});
