import {
  executeWorstCaseUserWorkload,
  executeWorstCaseLedgerWorkload,
  executeWorstCaseSearchWorkload,
  executeWorstCaseCouponDistributionWorkload,
  executeWorstCaseHolderEnumerationWorkload,
  ResourceBudgetEnforcer,
  DEFAULT_RESOURCE_BUDGETS,
  runAllResourceBudgetTests,
} from '../monitoring/resource-budgets';

describe('Resource Budget Workload Enforcement (#367)', () => {
  it('enforces resource budget ceilings for worst-case user workload (10k txs)', async () => {
    const limits = DEFAULT_RESOURCE_BUDGETS.worst_case_user_workload;
    const { result, metrics, violations } = await ResourceBudgetEnforcer.measureWorkload(
      'worst_case_user_workload',
      () => executeWorstCaseUserWorkload(10000),
      limits,
    );

    expect(violations).toHaveLength(0);
    expect(metrics.durationMs).toBeLessThanOrEqual(limits.maxCpuMs);
    expect(metrics.heapAllocDeltaKb).toBeLessThanOrEqual(limits.maxHeapAllocDeltaKb);
    expect(metrics.payloadBytes).toBeLessThanOrEqual(limits.maxPayloadBytes);
    expect(result.totalTransactions).toBe(10000);
    expect(result.recentTransactions).toHaveLength(50);
  });

  it('enforces resource budget ceilings for worst-case ledger cryptographic chain (10k events)', async () => {
    const limits = DEFAULT_RESOURCE_BUDGETS.worst_case_ledger_workload;
    const { result, metrics, violations } = await ResourceBudgetEnforcer.measureWorkload(
      'worst_case_ledger_workload',
      () => executeWorstCaseLedgerWorkload(10000),
      limits,
    );

    expect(violations).toHaveLength(0);
    expect(metrics.durationMs).toBeLessThanOrEqual(limits.maxCpuMs);
    expect(metrics.heapAllocDeltaKb).toBeLessThanOrEqual(limits.maxHeapAllocDeltaKb);
    expect(metrics.payloadBytes).toBeLessThanOrEqual(limits.maxPayloadBytes);
    expect(result.totalEvents).toBe(10000);
    expect(result.isTamperFree).toBe(true);
  });

  it('enforces resource budget ceilings for worst-case faceted search workload (10k docs)', async () => {
    const limits = DEFAULT_RESOURCE_BUDGETS.worst_case_search_workload;
    const { result, metrics, violations } = await ResourceBudgetEnforcer.measureWorkload(
      'worst_case_search_workload',
      () => executeWorstCaseSearchWorkload(10000),
      limits,
    );

    expect(violations).toHaveLength(0);
    expect(metrics.durationMs).toBeLessThanOrEqual(limits.maxCpuMs);
    expect(metrics.heapAllocDeltaKb).toBeLessThanOrEqual(limits.maxHeapAllocDeltaKb);
    expect(metrics.payloadBytes).toBeLessThanOrEqual(limits.maxPayloadBytes);
    expect(result.matchedCount).toBeGreaterThan(0);
    expect(result.results.length).toBeLessThanOrEqual(25);
  });

  it('detects violations when ceilings are breached under stress limits', async () => {
    const tightBudget = {
      maxCpuMs: 0.0001,
      maxHeapAllocDeltaKb: 1,
      maxQueryComplexityScans: 1,
      maxPayloadBytes: 10,
    };

    const { violations } = await ResourceBudgetEnforcer.measureWorkload(
      'stress_tight',
      () => executeWorstCaseUserWorkload(1000),
      tightBudget,
    );

    expect(violations.length).toBeGreaterThan(0);
  });

  it('enforces resource budget ceilings for worst-case coupon distribution (100k holders) #466', async () => {
    const limits = DEFAULT_RESOURCE_BUDGETS.worst_case_coupon_distribution_workload;
    const { result, metrics, violations } = await ResourceBudgetEnforcer.measureWorkload(
      'worst_case_coupon_distribution_workload',
      () => executeWorstCaseCouponDistributionWorkload(100000),
      limits,
    );

    expect(violations).toHaveLength(0);
    expect(metrics.durationMs).toBeLessThanOrEqual(limits.maxCpuMs);
    expect(metrics.heapAllocDeltaKb).toBeLessThanOrEqual(limits.maxHeapAllocDeltaKb);
    expect(metrics.payloadBytes).toBeLessThanOrEqual(limits.maxPayloadBytes);
    expect(result.totalHolders).toBe(100000);
    expect(result.successCount + result.failureCount).toBe(100000);
  });

  it('enforces resource budget ceilings for worst-case holder enumeration (10k holders) #466', async () => {
    const limits = DEFAULT_RESOURCE_BUDGETS.worst_case_holder_enumeration_workload;
    const { result, metrics, violations } = await ResourceBudgetEnforcer.measureWorkload(
      'worst_case_holder_enumeration_workload',
      () => executeWorstCaseHolderEnumerationWorkload(10000),
      limits,
    );

    expect(violations).toHaveLength(0);
    expect(metrics.durationMs).toBeLessThanOrEqual(limits.maxCpuMs);
    expect(metrics.heapAllocDeltaKb).toBeLessThanOrEqual(limits.maxHeapAllocDeltaKb);
    expect(metrics.payloadBytes).toBeLessThanOrEqual(limits.maxPayloadBytes);
    expect(result.totalHolders).toBe(10000);
    expect(result.holdersWithBalance).toBeGreaterThan(0);
  });

  it('runs end-to-end suite with clean report generation', async () => {
    const report = await runAllResourceBudgetTests();
    expect(report.passed).toBe(true);
    expect(report.workloads).toHaveLength(5);
  });
});
