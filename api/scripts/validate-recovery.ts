#!/usr/bin/env node
/**
 * Disaster Recovery & Restore Domain Invariants Validation Script (#243)
 *
 * Scoped to Verdant Bond Protocol. Proves that core domain records,
 * relationships, and settlement references remain consistent after a
 * backup restore, migration, or failover event.
 *
 * READ-ONLY BY DEFAULT: Never modifies database, cache, or ledger state.
 *
 * Usage:
 *   npx ts-node scripts/validate-recovery.ts
 *   npm run validate:recovery
 *   npm run validate:recovery -- --json
 *   npm run validate:recovery -- --strict
 *   npm run validate:recovery -- --verbose
 */
import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';

try {
  const envPath = path.resolve(__dirname, '../.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const [k, ...v] = trimmed.split('=');
        if (k && !process.env[k.trim()]) {
          process.env[k.trim()] = v.join('=').trim();
        }
      }
    }
  }
} catch {}

// Ensure contract addresses have fallback values if running in offline/restore environment
const requiredEnv = [
  'BOND_ISSUER_ADDRESS',
  'COUPON_ENGINE_ADDRESS',
  'DEX_ROUTER_ADDRESS',
  'PROJECT_REGISTRY_ADDRESS',
  'ORACLE_CONSUMER_ADDRESS',
  'CREDIT_RETIREMENT_ADDRESS',
];
for (const envKey of requiredEnv) {
  if (!process.env[envKey]) {
    process.env[envKey] = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADUMMY';
  }
}
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'f7b3a98e21c54098ad83f21b790c8e2190fca731804d9e5a1b3c5d7e9f0a2b4c';
}
process.env.REDIS_DISABLE_RETRY = 'true';

import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { StellarModule } from '../src/stellar/stellar.module';
import { CommonModule } from '../src/common/common.module';
import { ReconciliationModule } from '../src/reconciliation/reconciliation.module';
import { DomainInvariantsService } from '../src/reconciliation/services/domain-invariants.service';
import { ReconciliationReport } from '../src/reconciliation/interfaces/reconciliation.interface';

@Module({
  imports: [StellarModule, CommonModule, ReconciliationModule],
})
class ValidationContextModule {}

function renderSummaryTable(report: ReconciliationReport): void {
  console.log('\n================================================================================');
  console.log('         VERDANT BOND PROTOCOL - DISASTER RECOVERY VALIDATION REPORT           ');
  console.log('================================================================================');
  console.log(`Execution Time:     ${report.timestamp.toISOString()}`);
  console.log(`Execution Mode:     READ-ONLY (dry-run = ${report.dryRun})`);
  console.log(`Execution Duration: ${report.durationMs ?? 0} ms`);
  console.log(`Overall Status:     [ ${report.status} ]`);
  console.log('--------------------------------------------------------------------------------');
  console.log('SUMMARY BY CATEGORY:');
  console.log(`  - Missing Records:      ${report.summary.missingCount}`);
  console.log(`  - Orphaned Records:     ${report.summary.orphanedCount ?? 0}`);
  console.log(`  - Duplicated Records:   ${report.summary.duplicateCount}`);
  console.log(`  - Stale Records:        ${report.summary.staleCount}`);
  console.log(`  - Inconsistent Records: ${report.summary.inconsistentCount}`);
  console.log(`  - Total Drifts:         ${report.driftsFound.length}`);
  console.log('--------------------------------------------------------------------------------');

  if (report.driftsFound.length === 0) {
    console.log('✓ All domain invariants satisfied. Restored state is fully consistent.\n');
    return;
  }

  console.log('DETECTED INVARIANT VIOLATIONS / DRIFTS:');
  report.driftsFound.forEach((drift, idx) => {
    console.log(`\n[#${idx + 1}] Type: [${drift.type.toUpperCase()}] | Severity: [${drift.severity ?? 'MEDIUM'}] | Entity: ${drift.entityType} (${drift.entityId})`);
    console.log(`     Description:      ${drift.description}`);
    if (drift.affectedFields?.length) {
      console.log(`     Affected Fields:  ${drift.affectedFields.join(', ')}`);
    }
    if (drift.expectedValue !== undefined) {
      console.log(`     Expected Value:   ${drift.expectedValue}`);
    }
    if (drift.actualValue !== undefined) {
      console.log(`     Actual Value:     ${drift.actualValue}`);
    }
    if (drift.repairSuggestion) {
      console.log(`     Repair Plan:      ${drift.repairSuggestion}`);
    }
  });

  console.log('\n================================================================================');
  console.log('MAINTAINER ESCALATION RUNBOOK:');
  console.log('  1. Missing records: Restore missing project metadata or CIDs from IPFS/cold storage.');
  console.log('  2. Orphaned records: Quarantine orphaned listings/orders, release locked collateral.');
  console.log('  3. Duplicate records: Deduplicate ID sequences and verify replay protection nonces.');
  console.log('  4. Inconsistent balances/supply: Halt contract trading; run reindex-holders against ledger.');
  console.log('================================================================================\n');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const isJson = argv.includes('--json');
  const isStrict = argv.includes('--strict');

  const app = await NestFactory.createApplicationContext(ValidationContextModule, {
    logger: ['error', 'warn'],
  });

  try {
    const validator = app.get(DomainInvariantsService);
    const report = await validator.validateDomainInvariants();

    if (isJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      renderSummaryTable(report);
    }

    await app.close();

    const hasCritical = report.driftsFound.some((d) => d.severity === 'CRITICAL' || d.type === 'inconsistent');
    const hasAnyDrift = report.driftsFound.length > 0;

    if (isStrict && hasAnyDrift) {
      process.exit(1);
    } else if (hasCritical) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  } catch (error) {
    console.error('Validation execution failed:', error instanceof Error ? error.message : error);
    await app.close().catch(() => undefined);
    process.exit(2);
  }
}

main();
