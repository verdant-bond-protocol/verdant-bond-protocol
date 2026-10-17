import { scoreRisk } from './risk-scorer';
import { DEFAULT_RISK_CONFIG, RiskConfig, RiskSignals } from './risk.types';

function signals(overrides: Partial<RiskSignals> = {}): RiskSignals {
  return {
    operation: 'marketplace.buy',
    actor: 'GBOB',
    amountUsd: 100,
    velocityCount: 1,
    isNewActor: false,
    kycVerified: true,
    recentRejections: 0,
    ipChanged: false,
    ...overrides,
  };
}

const config: RiskConfig = { ...DEFAULT_RISK_CONFIG };

describe('scoreRisk (#375)', () => {
  it('allows a legitimate low-risk operation without any signals', () => {
    const result = scoreRisk(signals(), config);

    expect(result.action).toBe('allow');
    expect(result.band).toBe('low');
    expect(result.score).toBe(0);
    expect(result.reasons).toEqual([]);
  });

  it('escalates to step-up — not review — for a verified high-value actor', () => {
    const result = scoreRisk(
      signals({
        operation: 'bond.issue',
        amountUsd: config.amountStepUpUsd,
        velocityCount: config.velocityStepUp,
        kycVerified: true,
        isNewActor: false,
      }),
      config,
    );

    expect(result.action).toBe('step_up');
    expect(result.band).toBe('elevated');
    expect(result.reasons.map((r) => r.signal)).toContain('amount_elevated');
    expect(result.reasons.map((r) => r.signal)).not.toContain('amount_critical');
  });

  it('escalates to review when critical amount, velocity and KYC stack up', () => {
    const result = scoreRisk(
      signals({
        amountUsd: config.amountReviewUsd,
        velocityCount: config.velocityReview,
        kycVerified: false,
        isNewActor: true,
      }),
      config,
    );

    expect(result.score).toBeGreaterThanOrEqual(config.reviewThreshold);
    expect(result.action).toBe('review');
    expect(result.band).toBe('high');
  });

  it('reports every contributing signal with a weight and human explanation', () => {
    const result = scoreRisk(
      signals({
        amountUsd: config.amountReviewUsd,
        velocityCount: config.velocityReview,
        kycVerified: false,
        recentRejections: 2,
        ipChanged: true,
      }),
      config,
    );

    expect(result.reasons.length).toBeGreaterThan(0);
    for (const reason of result.reasons) {
      expect(reason.signal).toBeTruthy();
      expect(reason.weight).toBeGreaterThan(0);
      expect(reason.detail.length).toBeGreaterThan(0);
    }
    const names = result.reasons.map((r) => r.signal);
    expect(names).toEqual(
      expect.arrayContaining(['amount_critical', 'velocity_critical', 'kyc_unverified', 'recent_rejections', 'origin_changed']),
    );
  });

  it('adds a fixed premium for critical operations', () => {
    const result = scoreRisk(signals({ operation: 'bond.issue' }), config);

    expect(result.reasons.map((r) => r.signal)).toContain('critical_operation');
    expect(result.score).toBe(10);
  });

  it('caps the score at 100', () => {
    const result = scoreRisk(
      signals({
        operation: 'bond.issue',
        amountUsd: config.amountReviewUsd,
        velocityCount: config.velocityReview,
        kycVerified: false,
        recentRejections: 10,
        ipChanged: true,
      }),
      config,
    );

    expect(result.score).toBe(100);
  });

  it('caps the rejection signal weight so it cannot overwhelm the score', () => {
    const many = scoreRisk(signals({ recentRejections: 99, kycVerified: true }), config);
    const rejection = many.reasons.find((r) => r.signal === 'recent_rejections');

    expect(rejection?.weight).toBe(30);
  });
});
