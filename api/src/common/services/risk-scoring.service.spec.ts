import { RiskScoringService } from './risk-scoring.service';

describe('RiskScoringService', () => {
  let service: RiskScoringService;

  beforeEach(() => {
    service = new RiskScoringService();
  });

  describe('Risk Scoring', () => {
    it('should score low-risk action', () => {
      const score = service.scoreAction('transfer_small', 'user_1', {
        amount: BigInt('100'),
        historicalAverage: BigInt('100'),
        timeOfDay: 14,
        accountAgeMs: 365 * 24 * 60 * 60 * 1000,
        recentTransactionCount: 5,
        isOffHours: false,
        isWeekend: false,
        isNewAccount: false,
        isRapidSequence: false,
      });

      expect(score.riskLevel).toBe('LOW');
      expect(score.overallScore).toBeLessThan(25);
      expect(score.factors.length).toBeGreaterThan(0);
    });

    it('should score high-risk action (new account + large amount)', () => {
      const score = service.scoreAction('transfer_large', 'user_2', {
        amount: BigInt('10000'),
        historicalAverage: BigInt('100'),
        timeOfDay: 2,
        accountAgeMs: 10 * 24 * 60 * 60 * 1000, // 10 days
        recentTransactionCount: 1,
        isOffHours: true,
        isWeekend: true,
        isNewAccount: true,
        isRapidSequence: false,
      });

      expect(score.riskLevel).toBe('HIGH');
      expect(score.overallScore).toBeGreaterThanOrEqual(50);
    });

    it('should score critical-risk action (multiple red flags)', () => {
      const score = service.scoreAction('emergency_disable', 'user_3', {
        amount: BigInt('50000'),
        historicalAverage: BigInt('1000'),
        timeOfDay: 3,
        accountAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
        recentTransactionCount: 50,
        isOffHours: true,
        isWeekend: true,
        isNewAccount: true,
        isRapidSequence: true,
      });

      expect(score.riskLevel).toBe('CRITICAL');
      expect(score.overallScore).toBeGreaterThanOrEqual(75);
    });
  });

  describe('Risk Factors', () => {
    it('should include amount anomaly factor', () => {
      const score = service.scoreAction('transfer_large', 'user_1', {
        amount: BigInt('5000'),
        historicalAverage: BigInt('100'),
      });

      const amountFactor = score.factors.find((f) => f.name === 'amount_anomaly');
      expect(amountFactor).toBeDefined();
      expect(amountFactor?.value).toBeGreaterThan(0);
    });

    it('should include temporal anomaly factor', () => {
      const score = service.scoreAction('transfer_large', 'user_1', {
        isOffHours: true,
        isWeekend: true,
      });

      const timeFactor = score.factors.find((f) => f.name === 'temporal_anomaly');
      expect(timeFactor).toBeDefined();
      expect(timeFactor?.value).toBeGreaterThan(0);
    });

    it('should include account maturity factor', () => {
      const score = service.scoreAction('transfer_large', 'user_1', {
        isNewAccount: true,
        accountAgeMs: 5 * 24 * 60 * 60 * 1000,
      });

      const maturityFactor = score.factors.find((f) => f.name === 'account_maturity');
      expect(maturityFactor).toBeDefined();
      expect(maturityFactor?.value).toBeGreaterThan(0);
    });

    it('should include activity frequency factor', () => {
      const score = service.scoreAction('transfer_large', 'user_1', {
        recentTransactionCount: 25,
        isRapidSequence: true,
      });

      const frequencyFactor = score.factors.find((f) => f.name === 'activity_frequency');
      expect(frequencyFactor).toBeDefined();
      expect(frequencyFactor?.value).toBeGreaterThan(0);
    });

    it('should include action type severity factor', () => {
      const score = service.scoreAction('permission_escalation', 'user_1', {});

      const actionFactor = score.factors.find((f) => f.name === 'action_type_severity');
      expect(actionFactor).toBeDefined();
      expect(actionFactor?.value).toBeGreaterThan(0);
    });
  });

  describe('Recommendations', () => {
    it('should provide recommendations for critical risk', () => {
      const score = service.scoreAction('emergency_disable', 'user_1', {
        isNewAccount: true,
        isRapidSequence: true,
      });

      expect(score.recommendations.some((r) => r.includes('Immediate review'))).toBe(true);
      expect(score.recommendations.some((r) => r.includes('2FA'))).toBe(true);
    });

    it('should provide recommendations for high risk', () => {
      const score = service.scoreAction('role_assignment', 'user_1', {
        amount: BigInt('1000'),
        historicalAverage: BigInt('100'),
      });

      expect(score.recommendations.some((r) => r.includes('verification'))).toBe(true);
    });

    it('should provide recommendations for low risk', () => {
      const score = service.scoreAction('export_data', 'user_1', {});

      expect(score.recommendations.some((r) => r.includes('standard'))).toBe(true);
    });
  });

  describe('Risk History & Metrics', () => {
    it('should track risk history per user', () => {
      service.scoreAction('transfer_large', 'user_1', { amount: BigInt('1000') });
      service.scoreAction('transfer_large', 'user_1', { amount: BigInt('2000') });
      service.scoreAction('transfer_large', 'user_2', { amount: BigInt('3000') });

      const user1History = service.getUserRiskHistory('user_1');
      expect(user1History.length).toBe(2);

      const user2History = service.getUserRiskHistory('user_2');
      expect(user2History.length).toBe(1);
    });

    it('should limit history retrieval', () => {
      for (let i = 0; i < 150; i++) {
        service.scoreAction('transfer_large', 'user_1', { amount: BigInt('1000') });
      }

      const history = service.getUserRiskHistory('user_1', 50);
      expect(history.length).toBe(50);
    });

    it('should calculate risk metrics', () => {
      service.scoreAction('transfer_large', 'user_1', {
        isNewAccount: true,
        isRapidSequence: true,
      });
      service.scoreAction('transfer_large', 'user_2', {
        isNewAccount: true,
      });
      service.scoreAction('export_data', 'user_3', {});

      const metrics = service.getRiskMetrics();

      expect(metrics.totalScored).toBe(3);
      expect(metrics.criticalCount).toBeGreaterThanOrEqual(0);
      expect(metrics.highCount).toBeGreaterThanOrEqual(0);
      expect(metrics.averageScore).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Action Type Scoring', () => {
    it('should score different action types appropriately', () => {
      const largeTransferScore = service.scoreAction('transfer_large', 'user_1', {});
      const roleScore = service.scoreAction('role_assignment', 'user_1', {});
      const emergencyScore = service.scoreAction('emergency_disable', 'user_1', {});

      expect(emergencyScore.overallScore).toBeGreaterThanOrEqual(roleScore.overallScore);
      expect(roleScore.overallScore).toBeGreaterThanOrEqual(largeTransferScore.overallScore);
    });
  });

  describe('Explainability', () => {
    it('should provide clear factor explanations', () => {
      const score = service.scoreAction('transfer_large', 'user_1', {
        amount: BigInt('5000'),
        historicalAverage: BigInt('100'),
        isOffHours: true,
        isNewAccount: true,
      });

      for (const factor of score.factors) {
        expect(factor.explanation).toBeTruthy();
        expect(factor.explanation.length).toBeGreaterThan(0);
      }
    });

    it('should provide actionable recommendations', () => {
      const score = service.scoreAction('permission_escalation', 'user_1', {
        isNewAccount: true,
        isRapidSequence: true,
      });

      expect(score.recommendations.length).toBeGreaterThan(0);
      for (const rec of score.recommendations) {
        expect(rec.length).toBeGreaterThan(0);
      }
    });

    it('should include timestamp for audit trails', () => {
      const before = Date.now();
      const score = service.scoreAction('transfer_large', 'user_1', {});
      const after = Date.now();

      expect(score.timestamp).toBeGreaterThanOrEqual(before);
      expect(score.timestamp).toBeLessThanOrEqual(after);
    });
  });
});
