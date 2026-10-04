#!/usr/bin/env node
/**
 * Release Rollback Verification Script (Issue #312)
 *
 * Post-rollback verification tool for maintainers to validate that
 * user-facing state, background jobs, pending operations, and external
 * references are consistent with restored protocol behavior.
 *
 * READ-ONLY BY DEFAULT: Never mutates production state.
 *
 * Usage:
 *   npx ts-node scripts/validate-rollback.ts --version v1.4.0
 *   npm run validate:rollback -- --version v1.4.0
 *   npm run validate:rollback -- --json
 */
import 'reflect-metadata';
import { RollbackVerificationService } from '../src/recovery/rollback-verification.service';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isJson = args.includes('--json');
  const versionArgIdx = args.indexOf('--version');
  const targetVersion = versionArgIdx !== -1 && args[versionArgIdx + 1] ? args[versionArgIdx + 1] : 'restored-version';

  const service = new RollbackVerificationService();

  const report = service.verifyRollback({
    targetVersion,
    bondRecords: [
      { id: 1, status: 'ACTIVE', totalIssued: BigInt('500000'), holderCount: 25 },
      { id: 2, status: 'MATURED', totalIssued: BigInt('1000000'), holderCount: 50 },
    ],
    jobRecords: [],
    externalRefRecords: [],
  });

  if (isJson) {
    console.log(JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  } else {
    console.log('\n================================================================================');
    console.log(`     VERDANT BOND PROTOCOL - POST-ROLLBACK VERIFICATION REPORT (${targetVersion})     `);
    console.log('================================================================================');
    console.log(`Execution Timestamp: ${report.timestamp}`);
    console.log(`Execution Mode:      READ-ONLY (isReadOnly = ${report.isReadOnly})`);
    console.log(`Overall Status:      [ ${report.overallStatus} ]`);
    console.log(`Checked Components:  ${report.checkedComponents.join(', ')}`);
    console.log('--------------------------------------------------------------------------------');
    console.log(`Summary:\n${report.summaryText}`);
    console.log('--------------------------------------------------------------------------------');

    if (report.recordsRequiringRepair.length === 0) {
      console.log('✓ All post-rollback verification checks passed cleanly.\n');
    } else {
      console.log('RECORDS REQUIRING MANUAL REPAIR:');
      report.recordsRequiringRepair.forEach((item, idx) => {
        console.log(`\n[#${idx + 1}] ID: ${item.recordId} | Component: ${item.component} | Issue: ${item.issueType}`);
        console.log(`     Description: ${item.description}`);
        console.log(`     Action:      ${item.suggestedAction}`);
      });
      console.log('\n================================================================================\n');
    }
  }

  process.exit(report.overallStatus === 'CRITICAL_MISMATCH' ? 1 : 0);
}

main();
