import { RiskService } from './risk.service';
import { DEFAULT_RISK_CONFIG } from './risk.types';

describe('scoreRisk service (#375)', () => {
  let service: RiskService;

  const assess = (actor: string, overrides: Record<string, unknown> = {}) =>
    service.assess({ operation: 'marketplace.buy', actor, kycVerified: true, ...overrides });

  beforeEach(() => {
    service = new RiskService();
    service.configure({ enabled: true });
  });

  it('marks the first operation for an actor as new', () => {
    expect(assess('GNEW').reasons.map((r) => r.signal)).toContain('new_actor');
  });

  it('accumulates velocity for repeat operations by the same actor', () => {
    let last = assess('GVEL');
    for (let i = 0; i < DEFAULT_RISK_CONFIG.velocityStepUp; i += 1) {
      last = assess('GVEL');
    }

    expect(last.score).toBeGreaterThan(0);
    expect(last.reasons.map((r) => r.signal)).toEqual(
      expect.arrayContaining(['velocity_elevated']),
    );
  });

  it('records rejections that raise the next assessment', () => {
    const first = assess('GREJECT');
    expect(first.reasons.map((r) => r.signal)).not.toContain('recent_rejections');

    service.recordRejection('GREJECT');

    const second = assess('GREJECT');
    expect(second.reasons.map((r) => r.signal)).toContain('recent_rejections');
    expect(second.score).toBeGreaterThan(first.score);
  });

  it('detects an origin change for an actor', () => {
    assess('GIP', { ip: '203.0.113.1' });
    const changed = assess('GIP', { ip: '198.51.100.9' });

    expect(changed.reasons.map((r) => r.signal)).toContain('origin_changed');
  });

  it('can be disabled via configuration', () => {
    service.configure({ enabled: false });
    expect(service.isEnabled()).toBe(false);
  });

  describe('configFromEnv', () => {
    it('falls back to documented defaults', () => {
      expect(RiskService.configFromEnv({})).toEqual(DEFAULT_RISK_CONFIG);
    });

    it('parses overrides and treats RISK_DETECTION_ENABLED=false as disabled', () => {
      const config = RiskService.configFromEnv({
        RISK_DETECTION_ENABLED: 'false',
        RISK_WINDOW_SECONDS: '120',
        RISK_REVIEW_THRESHOLD: '90',
      });

      expect(config.enabled).toBe(false);
      expect(config.windowSeconds).toBe(120);
      expect(config.reviewThreshold).toBe(90);
    });

    it('ignores non-numeric overrides', () => {
      const config = RiskService.configFromEnv({ RISK_WINDOW_SECONDS: 'not-a-number' });

      expect(config.windowSeconds).toBe(DEFAULT_RISK_CONFIG.windowSeconds);
    });
  });
});
