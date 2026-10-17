#!/usr/bin/env node
/**
 * Executable verification script for Issue #367:
 * Resource Budget Tests for worst-case user, ledger, and search workloads.
 */

import {
  executeWorstCaseUserWorkload,
  executeWorstCaseLedgerWorkload,
  executeWorstCaseSearchWorkload,
  ResourceBudgetEnforcer,
  DEFAULT_RESOURCE_BUDGETS,
  runAllResourceBudgetTests,
} from '../api/src/monitoring/resource-budgets.ts';

import assert from 'node:assert/strict';

async function main() {
  console.log('===============================================================');
  console.log('VERDANT BOND PROTOCOL: RESOURCE BUDGET ENFORCEMENT VERIFICATION');
  console.log('===============================================================');

  // Test 1: User Workload
  console.log('\n[1/4] Measuring worst-case user profile workload (10,000 txs)...');
  const userResult = await ResourceBudgetEnforcer.measureWorkload(
    'worst_case_user_workload',
    () => executeWorstCaseUserWorkload(10000),
    DEFAULT_RESOURCE_BUDGETS.worst_case_user_workload,
  );
  console.log(`  - Duration: ${userResult.metrics.durationMs}ms (Limit: ${DEFAULT_RESOURCE_BUDGETS.worst_case_user_workload.maxCpuMs}ms)`);
  console.log(`  - Heap Delta: ${userResult.metrics.heapAllocDeltaKb}KB (Limit: ${DEFAULT_RESOURCE_BUDGETS.worst_case_user_workload.maxHeapAllocDeltaKb}KB)`);
  console.log(`  - Payload: ${userResult.metrics.payloadBytes} bytes`);
  assert.equal(userResult.violations.length, 0, 'User workload violated resource budget');
  assert.equal(userResult.result.totalTransactions, 10000);
  assert.equal(userResult.result.recentTransactions.length, 50);

  // Test 2: Ledger Workload
  console.log('\n[2/4] Measuring worst-case cryptographic ledger workload (10,000 events)...');
  const ledgerResult = await ResourceBudgetEnforcer.measureWorkload(
    'worst_case_ledger_workload',
    () => executeWorstCaseLedgerWorkload(10000),
    DEFAULT_RESOURCE_BUDGETS.worst_case_ledger_workload,
  );
  console.log(`  - Duration: ${ledgerResult.metrics.durationMs}ms (Limit: ${DEFAULT_RESOURCE_BUDGETS.worst_case_ledger_workload.maxCpuMs}ms)`);
  console.log(`  - Heap Delta: ${ledgerResult.metrics.heapAllocDeltaKb}KB (Limit: ${DEFAULT_RESOURCE_BUDGETS.worst_case_ledger_workload.maxHeapAllocDeltaKb}KB)`);
  console.log(`  - Payload: ${ledgerResult.metrics.payloadBytes} bytes`);
  assert.equal(ledgerResult.violations.length, 0, 'Ledger workload violated resource budget');
  assert.equal(ledgerResult.result.totalEvents, 10000);
  assert.equal(ledgerResult.result.isTamperFree, true);

  // Test 3: Search Workload
  console.log('\n[3/4] Measuring worst-case faceted search workload (10,000 docs)...');
  const searchResult = await ResourceBudgetEnforcer.measureWorkload(
    'worst_case_search_workload',
    () => executeWorstCaseSearchWorkload(10000),
    DEFAULT_RESOURCE_BUDGETS.worst_case_search_workload,
  );
  console.log(`  - Duration: ${searchResult.metrics.durationMs}ms (Limit: ${DEFAULT_RESOURCE_BUDGETS.worst_case_search_workload.maxCpuMs}ms)`);
  console.log(`  - Heap Delta: ${searchResult.metrics.heapAllocDeltaKb}KB (Limit: ${DEFAULT_RESOURCE_BUDGETS.worst_case_search_workload.maxHeapAllocDeltaKb}KB)`);
  console.log(`  - Payload: ${searchResult.metrics.payloadBytes} bytes`);
  assert.equal(searchResult.violations.length, 0, 'Search workload violated resource budget');
  assert.ok(searchResult.result.matchedCount > 0);
  assert.equal(searchResult.result.results.length, 25);

  // Test 4: Artificial Budget Ceiling Violation Detection
  console.log('\n[4/4] Verifying ceiling violation detection under constrained limits...');
  const tightBudget = {
    maxCpuMs: 0.001, // Impossibly tight
    maxHeapAllocDeltaKb: 10,
    maxQueryComplexityScans: 5,
    maxPayloadBytes: 10,
  };
  const tightRun = await ResourceBudgetEnforcer.measureWorkload(
    'stress_test_tight',
    () => executeWorstCaseUserWorkload(1000),
    tightBudget,
  );
  assert.ok(tightRun.violations.length > 0, 'Should detect violations under artificially tight budget');
  console.log(`  - Correctly flagged ${tightRun.violations.length} violations when ceilings were breached.`);

  // Test 5: End-to-End Suite
  console.log('\nRunning full test suite via runAllResourceBudgetTests()...');
  const fullReport = await runAllResourceBudgetTests();
  if (!fullReport.passed) {
    for (const wl of fullReport.workloads) {
      if (!wl.passed) {
        console.error(`Workload ${wl.workload} failed:`, wl.violations);
      }
    }
  }
  assert.equal(fullReport.passed, true, 'Full suite should pass with default budgets');

  console.log('\n===============================================================');
  console.log('ALL RESOURCE BUDGET TESTS PASSED SUCCESSFULLY! (Issue #367)');
  console.log('===============================================================');
}

main().catch((err) => {
  console.error('Resource budget verification failed:', err);
  process.exit(1);
});
