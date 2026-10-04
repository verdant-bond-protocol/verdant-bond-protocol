import { CouponBacktestService, PerformanceDataset } from './coupon-backtest.service';

describe('CouponBacktestService (#333 Historical Performance Backtesting Tooling)', () => {
  let service: CouponBacktestService;

  beforeEach(() => {
    service = new CouponBacktestService();
  });

  describe('1. Contract-Faithful Coupon Calculation Logic', () => {
    it('calculates expected coupon credits for normal baseline performance', () => {
      const result = service.calculateContractCoupon(
        {
          periodIndex: 1,
          periodStart: '2026-01-01',
          periodEnd: '2026-03-31',
          reportedCarbon: 100,
          targetCarbon: 100,
          totalSupply: '1000000000000', // 1,000,000 tokens
          attestationCount: 2,
        },
        '1000000', // 1.0 base rate
        'V2',
      );

      expect(result.creditsPerToken).toBe(1000000n); // 1.0 credit per token
      expect(result.edgeCases).toHaveLength(0);
    });

    it('clamps +150% spike to max increase bound (+100%) and flags PERFORMANCE_SPIKE_CLAMPED', () => {
      const result = service.calculateContractCoupon(
        {
          periodIndex: 1,
          periodStart: '2026-01-01',
          periodEnd: '2026-03-31',
          reportedCarbon: 250, // +150% above target 100
          targetCarbon: 100,
          totalSupply: '1000000000000',
          attestationCount: 2,
        },
        '1000000',
        'V2',
      );

      // Clamped to 2.0x base rate (2,000,000)
      expect(result.creditsPerToken).toBe(2000000n);
      expect(result.edgeCases).toContain('PERFORMANCE_SPIKE_CLAMPED');
    });

    it('flags PERFORMANCE_DROP_FLAGGED when performance drops > 90%', () => {
      const result = service.calculateContractCoupon(
        {
          periodIndex: 1,
          periodStart: '2026-01-01',
          periodEnd: '2026-03-31',
          reportedCarbon: 5, // -95% drop below target 100
          targetCarbon: 100,
          totalSupply: '1000000000000',
          attestationCount: 2,
        },
        '1000000',
        'V2',
      );

      expect(result.edgeCases).toContain('PERFORMANCE_DROP_FLAGGED');
    });

    it('flags ZERO_SUPPLY_DIVISION_RISK when token supply is 0', () => {
      const result = service.calculateContractCoupon(
        {
          periodIndex: 1,
          periodStart: '2026-01-01',
          periodEnd: '2026-03-31',
          reportedCarbon: 100,
          targetCarbon: 100,
          totalSupply: '0',
          attestationCount: 2,
        },
        '1000000',
        'V2',
      );

      expect(result.totalDistributed).toBe(0n);
      expect(result.edgeCases).toContain('ZERO_SUPPLY_DIVISION_RISK');
    });
  });

  describe('2. Multi-Year Dataset Importing & Synthetic Generation', () => {
    it('generates synthetic 5-year multi-period performance dataset', () => {
      const dataset = service.generateSyntheticDataset({
        years: 5,
        baseCarbon: 1000,
        includeSpike: true,
        includeDrop: true,
      });

      expect(dataset.dataPoints).toHaveLength(20); // 5 years * 4 quarters
      expect(dataset.dataPoints.some((p) => p.reportedCarbon > 2000)).toBe(true); // Spike included
    });
  });

  describe('3. Backtest Report & Formula Version Comparison', () => {
    it('runs backtest over 3-year dataset and produces formula comparison report (V1 vs V2)', () => {
      const dataset: PerformanceDataset = {
        datasetId: 'TEST-HISTORICAL-3Y',
        projectName: 'Mangrove Reforestation Project #1',
        creditType: 'BLUE-CARBON',
        baseCouponRate: '1000000',
        dataPoints: [
          { periodIndex: 1, periodStart: '2023-Q1', periodEnd: '2023-Q1-END', reportedCarbon: 100, targetCarbon: 100, totalSupply: '1000000000000', attestationCount: 2 },
          { periodIndex: 2, periodStart: '2023-Q2', periodEnd: '2023-Q2-END', reportedCarbon: 110, targetCarbon: 100, totalSupply: '1000000000000', attestationCount: 2 },
          // Sudden 300% spike: V1 overpays, V2 clamps at +100% cap
          { periodIndex: 3, periodStart: '2023-Q3', periodEnd: '2023-Q3-END', reportedCarbon: 300, targetCarbon: 100, totalSupply: '1000000000000', attestationCount: 2 },
          // Sudden 95% drop: V2 flags drop
          { periodIndex: 4, periodStart: '2023-Q4', periodEnd: '2023-Q4-END', reportedCarbon: 5, targetCarbon: 100, totalSupply: '1000000000000', attestationCount: 2 },
        ],
      };

      const report = service.runBacktest(dataset, 'COMPARE');

      expect(report.totalPeriodsEvaluated).toBe(4);
      expect(report.edgeCasesSummary.totalSpikesFlagged).toBe(1);
      expect(report.edgeCasesSummary.totalDropsFlagged).toBe(1);
      expect(report.comparison).toBeDefined();
      expect(BigInt(report.comparison!.v2CapPreventedOverpayment)).toBeGreaterThan(0n);
    });
  });
});
