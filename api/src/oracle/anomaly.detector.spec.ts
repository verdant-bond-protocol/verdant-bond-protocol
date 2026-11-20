import { computeCrossSourceAnomalies } from './anomaly.detector';
import { ReportStatus } from './interfaces/oracle.interface';

const base = {
  id: 1,
  projectId: 'P1',
  periodStart: 100,
  periodEnd: 200,
  carbonSequestered: '1000',
  methodology: 'VERRA-VCS',
  ipfsHash: 'aa',
  providerAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
  status: ReportStatus.Verified,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const report = (overrides: Partial<typeof base> = {}) => ({ ...base, ...overrides });

describe('computeCrossSourceAnomalies (#158)', () => {
  it('returns an empty list for no reports', () => {
    expect(computeCrossSourceAnomalies([])).toEqual([]);
  });

  it('returns missing_source for a project-period with a single verified source', () => {
    const results = computeCrossSourceAnomalies([
      report({ carbonSequestered: '1000' }),
    ]);
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe('missing_source');
    expect(results[0].severity).toBe('info');
  });

  it('returns normal when two sources agree within tolerance', () => {
    const results = computeCrossSourceAnomalies([
      report({ carbonSequestered: '1000', providerAddress: 'GAAA' }),
      report({ carbonSequestered: '1080', providerAddress: 'GBBB' }),
    ]);
    expect(results[0].kind).toBe('normal');
    expect(results[0].severity).toBe('info');
    expect(results[0].median).toBe(1040);
  });

  it('returns outlier when a second source deviates beyond tolerance', () => {
    const results = computeCrossSourceAnomalies([
      report({ carbonSequestered: '1000', providerAddress: 'GAAA' }),
      report({ carbonSequestered: '1000', providerAddress: 'GBBB' }),
      report({ carbonSequestered: '3000', providerAddress: 'GCCC' }),
    ]);
    const flagged = results[0];
    expect(flagged.kind).toBe('outlier');
    expect(flagged.severity).toBe('critical');
    expect(flagged.reason).toContain('GCCC');
  });

  it('clusters reports by project-period so independent periods are separate', () => {
    const results = computeCrossSourceAnomalies([
      report({ carbonSequestered: '1000', providerAddress: 'GAAA', periodStart: 100, periodEnd: 200 }),
      report({ carbonSequestered: '1000', providerAddress: 'GBBB', periodStart: 100, periodEnd: 200 }),
      report({ carbonSequestered: '900', providerAddress: 'GAAA', periodStart: 300, periodEnd: 400 }),
    ]);
    expect(results).toHaveLength(2);
    const first = results.find((r) => r.periodKey === '100-200');
    const second = results.find((r) => r.periodKey === '300-400');
    expect(first!.kind).toBe('normal');
    expect(second!.kind).toBe('missing_source');
  });

  it('ignores unverified and rejected reports as untrustworthy cross-checks', () => {
    const results = computeCrossSourceAnomalies([
      report({ carbonSequestered: '1000', providerAddress: 'GAAA', status: ReportStatus.Verified }),
      report({ carbonSequestered: '5000', providerAddress: 'GBBB', status: ReportStatus.Challenged }),
    ]);
    // Only the verified report remains, so no cross-check is possible.
    expect(results[0].kind).toBe('missing_source');
  });
});
