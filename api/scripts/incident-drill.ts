#!/usr/bin/env node
/**
 * Incident Drill Verification Runner (Issue #356)
 *
 * Automated verification runner for incident response, proving that
 * emergency recovery, rollback, data validation, and user-impact reporting
 * mechanisms work reliably across:
 *   1. Green Bond Issuance Rollback
 *   2. Carbon Credit Coupon Oracle Recovery
 *   3. Secondary-Market Settlement Deadlock Rollback
 *
 * Usage:
 *   npx ts-node scripts/incident-drill.ts
 *   npm run incident:drill
 *   npm run incident:drill -- --json
 *   npm run incident:drill -- --drill=issuance
 *   npm run incident:drill -- --drill=coupon
 *   npm run incident:drill -- --drill=settlement
 */
import 'reflect-metadata';
import { IncidentDrillService, DrillExecutionReport } from '../src/recovery/incident-drill.service';

function renderDrillReport(drill: DrillExecutionReport): void {
  console.log('\n--------------------------------------------------------------------------------');
  console.log(`DRILL: [ ${drill.drillType} ] | STATUS: [ ${drill.status} ] | DURATION: ${drill.durationMs}ms`);
  console.log('--------------------------------------------------------------------------------');
  console.log('EXECUTED VERIFICATION STEPS:');
  drill.steps.forEach((step, idx) => {
    console.log(`  ${idx + 1}. [${step.status}] ${step.stepName} (${step.durationMs}ms) - ${step.details}`);
  });
  console.log('\nDATA INTEGRITY & RECOVERY INVARIANTS:');
  console.log(`  - Rollback Succeeded:       ${drill.rollbackSucceeded ? '✓ YES' : 'N/A'}`);
  console.log(`  - Recovery Succeeded:       ${drill.recoverySucceeded ? '✓ YES' : 'N/A'}`);
  console.log(`  - Data Validation Invariants: ${drill.dataValidationPassed ? '✓ PASSED' : '✗ FAILED'}`);

  console.log('\nUSER IMPACT ASSESSMENT & COMMUNICATION:');
  console.log(`  - Severity Level:           [ ${drill.userImpact.impactSeverity} ]`);
  console.log(`  - Affected Users:           ${drill.userImpact.affectedUsersCount}`);
  console.log(`  - Financial Exposure (USD): $${drill.userImpact.totalFinancialExposureUSD.toLocaleString()}`);
  console.log(`  - SLA Breach Risk:          ${drill.userImpact.slaBreachRisk ? 'YES' : 'NO'}`);
  console.log(`  - User Facing Notice:       "${drill.userImpact.userFacingMessage}"`);
  console.log(`  - Remediation Action:       ${drill.userImpact.remediationSummary}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isJson = args.includes('--json');
  const drillArg = args.find((a) => a.startsWith('--drill='));
  const drillFilter = drillArg ? drillArg.split('=')[1].toLowerCase() : 'all';

  const service = new IncidentDrillService();

  if (!isJson) {
    console.log('================================================================================');
    console.log('       VERDANT BOND PROTOCOL - INCIDENT DRILL VERIFICATION RUNNER (#356)       ');
    console.log('================================================================================');
  }

  let hasFailure = false;
  const reports: DrillExecutionReport[] = [];

  if (drillFilter === 'issuance' || drillFilter === 'all') {
    const report = await service.runBondIssuanceRollbackDrill();
    reports.push(report);
    if (report.status === 'FAILED') hasFailure = true;
    if (!isJson) renderDrillReport(report);
  }

  if (drillFilter === 'coupon' || drillFilter === 'all') {
    const report = await service.runCouponOracleRecoveryDrill();
    reports.push(report);
    if (report.status === 'FAILED') hasFailure = true;
    if (!isJson) renderDrillReport(report);
  }

  if (drillFilter === 'settlement' || drillFilter === 'all') {
    const report = await service.runSettlementDeadlockRollbackDrill();
    reports.push(report);
    if (report.status === 'FAILED') hasFailure = true;
    if (!isJson) renderDrillReport(report);
  }

  if (isJson) {
    console.log(JSON.stringify(reports, null, 2));
  } else {
    console.log('\n================================================================================');
    console.log(`OVERALL INCIDENT DRILL OUTCOME: [ ${hasFailure ? 'FAILED' : 'ALL DRILLS PASSED'} ]`);
    console.log('================================================================================\n');
  }

  process.exit(hasFailure ? 1 : 0);
}

main().catch((err) => {
  console.error('Drill execution encountered fatal error:', err);
  process.exit(2);
});
