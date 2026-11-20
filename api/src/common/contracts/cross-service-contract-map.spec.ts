import {
  CROSS_SERVICE_CONTRACT_MAP,
  validateCrossServiceEvent,
  getContractsByProducer,
  getContractsByConsumer,
} from './cross-service-contract-map';

describe('Cross-Service Contract Map (#368)', () => {
  it('registers all required domain events with producers, consumers, and failure policies', () => {
    const requiredEvents = [
      'bond.issued',
      'subscription.allocated',
      'coupon.distributed',
      'oracle.report_submitted',
      'oracle.provider_slashed',
      'order.filled',
      'kyc.override',
    ];

    for (const eventName of requiredEvents) {
      const contract = CROSS_SERVICE_CONTRACT_MAP[eventName];
      expect(contract).toBeDefined();
      expect(contract.eventName).toBe(eventName);
      expect(contract.producer).toBeDefined();
      expect(contract.consumers.length).toBeGreaterThan(0);
      expect(['fail-closed', 'dead-letter-retry', 'circuit-breaker-pause']).toContain(
        contract.allowedFailureBehavior,
      );
    }
  });

  it('validates a conformant bond.issued domain event', () => {
    const event = {
      eventName: 'bond.issued',
      schemaVersion: '1.0.0',
      producer: 'contract:BondIssuer' as const,
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: {
        bondId: 101,
        projectId: 'a'.repeat(64),
        issuer: 'GBJ7V4JHYC52O2ZNDH6WGB7E6R3YGY6YAM7G7R2EQ6V32J4K47U65C5G',
        faceValue: '1000000000',
        maturityTimestamp: 1767225600,
      },
    };

    const result = validateCrossServiceEvent(event);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects events missing required fields', () => {
    const event = {
      eventName: 'bond.issued',
      schemaVersion: '1.0.0',
      producer: 'contract:BondIssuer' as const,
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: { bondId: 101 },
    };

    const result = validateCrossServiceEvent(event);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Missing required field'))).toBe(true);
  });

  it('rejects events with incompatible major schema versions', () => {
    const event = {
      eventName: 'bond.issued',
      schemaVersion: '2.0.0',
      producer: 'contract:BondIssuer' as const,
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: {
        bondId: 101,
        projectId: 'a'.repeat(64),
        issuer: 'GBJ7V4JHYC52O2ZNDH6WGB7E6R3YGY6YAM7G7R2EQ6V32J4K47U65C5G',
        faceValue: '1000000000',
        maturityTimestamp: 1767225600,
      },
    };

    const result = validateCrossServiceEvent(event);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Incompatible schema version'))).toBe(true);
  });

  it('rejects events with invalid producer identity', () => {
    const event = {
      eventName: 'bond.issued',
      schemaVersion: '1.0.0',
      producer: 'api:SettlementService' as const,
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: {},
    };

    const result = validateCrossServiceEvent(event);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Producer mismatch'))).toBe(true);
  });

  it('supports producer and consumer topological lookups', () => {
    const bondContracts = getContractsByProducer('contract:BondIssuer');
    expect(bondContracts.length).toBeGreaterThanOrEqual(2);

    const ledgerContracts = getContractsByConsumer('api:EventLedger');
    expect(ledgerContracts.length).toBeGreaterThanOrEqual(5);
  });
});
