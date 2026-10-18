#!/usr/bin/env node
/**
 * Storage schema migration compatibility check (#392).
 *
 * Compares contracts/tests/fixtures/storage_keys.json against the frozen
 * baseline of the current schema version and the next version's migration
 * plan. Exit 0 when compatible, 1 on any violation, 2 when inputs are missing.
 *
 * Usage:
 *   npm run migration:storage-compat
 *   npm run migration:storage-compat -- --json
 */
import {
  checkStorageMigrationCompatibility,
  loadStorageCompatInputs,
} from '../src/migrations/storage-schema-compat';

function main(): void {
  const json = process.argv.includes('--json');
  let inputs;
  try {
    inputs = loadStorageCompatInputs();
  } catch (error) {
    console.error(`[ERROR] ${(error as Error).message}`);
    process.exit(2);
  }

  const report = checkStorageMigrationCompatibility(inputs);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Storage schema v${report.baselineVersion} -> v${report.nextVersion}`);
    for (const [contract, cls] of Object.entries(report.classification)) {
      console.log(`  ${contract.padEnd(18)} ${cls}`);
    }
    for (const c of report.changes) console.log(`  ${c.kind.padEnd(8)} ${c.contract}::${c.key}`);
    for (const w of report.warnings) console.log(`[WARN] ${w.code}: ${w.message}`);
    for (const v of report.violations) console.log(`[FAIL] ${v.code}: ${v.message}`);
    console.log(report.compatible ? 'COMPATIBLE' : 'INCOMPATIBLE');
  }
  process.exit(report.compatible ? 0 : 1);
}

main();
