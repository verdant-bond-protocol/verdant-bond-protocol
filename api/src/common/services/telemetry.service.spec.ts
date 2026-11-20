import { Test, TestingModule } from '@nestjs/testing';
import { TelemetryService, TelemetryFields } from './telemetry.service';

describe('TelemetryService (#355 High-Cardinality & Redaction)', () => {
  let service: TelemetryService;
  let logSpy: jest.SpyInstance;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: TelemetryService,
          useValue: new TelemetryService({
            maxLabelCardinality: 5,
            sampleRateSuccess: 1.0,
            highVolumeThresholdPerMin: 50,
          }),
        },
      ],
    }).compile();

    service = module.get<TelemetryService>(TelemetryService);
    logSpy = jest.spyOn(service['logger'], 'log').mockImplementation();
    service.resetStats();
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  describe('Standard emission and backwards compatibility', () => {
    it('should emit success telemetry with duration and actorType', () => {
      const fields: TelemetryFields = {
        operation: 'bond_purchase',
        actorType: 'user',
        result: 'success',
        durationMs: 125,
        correlationId: 'test-id-123',
        userId: 'user-456',
      };

      const emitted = service.emit(fields);
      expect(emitted).toBe(true);
      expect(logSpy).toHaveBeenCalled();
      const payload = JSON.parse(logSpy.mock.calls[0][0]);
      expect(payload.operation).toBe('bond_purchase');
      expect(payload.result).toBe('success');
      expect(payload.durationMs).toBe(125);
      expect(payload.userId).toBe('user-456');
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
      const payload = JSON.parse(logSpy.mock.calls[0][0]);
      expect(payload.result).toBe('failure');
      expect(payload.error).toBe('Insufficient balance');
    });
  });

  describe('Sensitive data redaction', () => {
    it('redacts Stellar secret keys (S...) from error messages, strings, and userIds', () => {
      const secretKey = 'SBEXAMPLESECRETKEY1234567890ABCDEF1234567890ABCDEF123456';
      const fields: TelemetryFields = {
        operation: 'bond_issuance',
        actorType: 'user',
        result: 'failure',
        durationMs: 200,
        correlationId: 'corr-sec',
        userId: secretKey,
        error: `Transaction failed with key ${secretKey}`,
      };

      service.emit(fields);
      const payload = JSON.parse(logSpy.mock.calls[0][0]);
      expect(payload.userId).toBe('[REDACTED_STELLAR_SECRET]');
      expect(payload.error).toBe('Transaction failed with key [REDACTED_STELLAR_SECRET]');
    });

    it('redacts JWT tokens and email addresses from messages and fields', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeakThisSignature12345';
      const email = 'investor.alice@example.org';

      const fields: TelemetryFields = {
        operation: 'kyc_verification',
        actorType: 'user',
        result: 'success',
        durationMs: 150,
        correlationId: 'corr-jwt',
        userId: email,
        error: `Bearer ${jwt}`,
        businessMetric: {
          contactEmail: email,
          bearerToken: jwt,
        },
      };

      service.emit(fields);
      const payload = JSON.parse(logSpy.mock.calls[0][0]);
      expect(payload.userId).toBe('[REDACTED_EMAIL]');
      expect(payload.error).toBe('Bearer [REDACTED_JWT]');
      expect(payload.businessMetric.contactEmail).toBe('[REDACTED_EMAIL]');
      expect(payload.businessMetric.bearerToken).toBe('[REDACTED_JWT]');
    });

    it('redacts sensitive object keys (passwords, tokens, nationalId, privateKey)', () => {
      const fields: TelemetryFields = {
        operation: 'kyc_verification',
        actorType: 'user',
        result: 'success',
        durationMs: 90,
        correlationId: 'corr-obj',
        businessMetric: {
          normalMetric: 42,
          password: 'super-secret-password',
          privateKey: '0x1234567890abcdef',
          nationalId: 'ID-999-88-777',
          nested: {
            apiKey: 'secret-api-key',
            safeValue: 'ok',
          },
        } as any,
      };

      service.emit(fields);
      const payload = JSON.parse(logSpy.mock.calls[0][0]);
      expect(payload.businessMetric.normalMetric).toBe(42);
      expect(payload.businessMetric.password).toBe('[REDACTED_SENSITIVE]');
      expect(payload.businessMetric.privateKey).toBe('[REDACTED_SENSITIVE]');
      expect(payload.businessMetric.nationalId).toBe('[REDACTED_SENSITIVE]');
      expect(payload.businessMetric.nested.apiKey).toBe('[REDACTED_SENSITIVE]');
      expect(payload.businessMetric.nested.safeValue).toBe('ok');
    });
  });

  describe('High-cardinality protection & unsafe label rejection', () => {
    it('rejects unsafe label keys with special characters, punctuation, or spaces', () => {
      const fields: TelemetryFields = {
        operation: 'portfolio_query',
        actorType: 'user',
        result: 'success',
        durationMs: 30,
        correlationId: 'corr-unsafe',
        labels: {
          valid_label: 'tier1',
          'unsafe-label!@#': 'malicious_key',
          'drop table;--': 'injection',
        },
      };

      service.emit(fields);
      const payload = JSON.parse(logSpy.mock.calls[0][0]);
      expect(payload.labels.valid_label).toBe('tier1');
      expect(payload.labels['unsafe-label!@#']).toBeUndefined();
      expect(payload.labels['drop table;--']).toBeUndefined();
    });

    it('clamps label values to __other__ once maxLabelCardinality is exceeded', () => {
      // Configured maxLabelCardinality is 5
      for (let i = 1; i <= 8; i++) {
        service.emit({
          operation: 'market_query',
          actorType: 'user',
          result: 'success',
          durationMs: 10,
          correlationId: `corr-${i}`,
          labels: {
            region: `region-${i}`,
          },
        });
      }

      expect(logSpy).toHaveBeenCalledTimes(8);
      // First 5 should keep their exact label
      for (let i = 0; i < 5; i++) {
        const payload = JSON.parse(logSpy.mock.calls[i][0]);
        expect(payload.labels.region).toBe(`region-${i + 1}`);
      }
      // 6th, 7th, 8th should be clamped to __other__
      for (let i = 5; i < 8; i++) {
        const payload = JSON.parse(logSpy.mock.calls[i][0]);
        expect(payload.labels.region).toBe('__other__');
      }

      const stats = service.getStats();
      expect(stats.cardinalityClampedCount).toBe(3);
    });
  });

  describe('Sampling rules under high input volume', () => {
    it('always retains 100% of failure and error events regardless of volume or sample rate', () => {
      service.setSampleRate(0.0); // 0% success sample rate

      const failureField: TelemetryFields = {
        operation: 'order_placement',
        actorType: 'user',
        result: 'failure',
        durationMs: 50,
        correlationId: 'fail-100',
        error: 'Order book crossed',
      };

      const emitted = service.emit(failureField);
      expect(emitted).toBe(true);
      expect(logSpy).toHaveBeenCalled();
      const payload = JSON.parse(logSpy.mock.calls[0][0]);
      expect(payload.sampleRate).toBe(1.0);
    });

    it('always retains 100% of critical operations (e.g. bond_issuance, coupon_distribution, settlement)', () => {
      service.setSampleRate(0.0);

      const criticalField: TelemetryFields = {
        operation: 'settlement',
        actorType: 'service',
        result: 'success',
        durationMs: 120,
        correlationId: 'settle-1',
      };

      const emitted = service.emit(criticalField);
      expect(emitted).toBe(true);
      expect(logSpy).toHaveBeenCalled();
    });

    it('drops non-critical success events when sample rate is reduced', () => {
      service.setSampleRate(0.0);

      const standardField: TelemetryFields = {
        operation: 'browse_catalog',
        actorType: 'user',
        result: 'success',
        durationMs: 15,
        correlationId: 'browse-1',
      };

      const emitted = service.emit(standardField);
      expect(emitted).toBe(false);
      expect(logSpy).not.toHaveBeenCalled();
      expect(service.getStats().totalSampledOut).toBe(1);
    });
  });
});
