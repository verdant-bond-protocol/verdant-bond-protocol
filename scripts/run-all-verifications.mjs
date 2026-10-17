#!/usr/bin/env node
/**
 * Master Verification Suite across all 4 GitHub Issues:
 * - Issue #367: Resource Budget Tests (user, ledger, search)
 * - Issue #368: Cross-Service Contract Map (producers, consumers, boundaries)
 * - Issue #370: Safe Public-Status Model (degraded, paused, maintenance)
 * - Issue #354: Schema Evolution Guardrails (stored records, public APIs)
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const suites = [
  { name: 'Issue #367 (Resource Budget Tests)', script: 'verify-resource-budgets.mjs' },
  { name: 'Issue #368 (Cross-Service Contract Map)', script: 'verify-contract-map.mjs' },
  { name: 'Issue #370 (Safe Public-Status Model)', script: 'verify-status-model.mjs' },
  { name: 'Issue #354 (Schema Evolution Guardrails)', script: 'verify-schema-evolution.mjs' },
];

console.log('========================================================================');
console.log('   RUNNING MASTER VERIFICATION SUITE FOR ISSUES 367, 368, 370, 354      ');
console.log('========================================================================\n');

let allPassed = true;

for (const suite of suites) {
  const scriptPath = join(__dirname, suite.script);
  console.log(`>>> Executing ${suite.name} [${suite.script}]...`);
  try {
    const output = execFileSync(process.execPath, ['--experimental-strip-types', scriptPath], {
      encoding: 'utf-8',
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    console.log(output);
    console.log(`[PASS] ${suite.name} completed successfully.\n`);
  } catch (err) {
    allPassed = false;
    console.error(`[FAIL] ${suite.name} failed with exit code ${err.status}:`);
    if (err.stdout) console.log(err.stdout);
    if (err.stderr) console.error(err.stderr);
    break;
  }
}

console.log('========================================================================');
if (allPassed) {
  console.log('🎉 ALL 4 ISSUE IMPLEMENTATION SUITES PASSED FLAWLESSLY! 🎉');
} else {
  console.log('❌ SOME SUITES FAILED. SEE LOGS ABOVE. ❌');
  process.exit(1);
}
console.log('========================================================================');
