#!/usr/bin/env node
/**
 * Snapshot restore verification (#379).
 *
 * Verifies a restored critical-data snapshot against its integrity manifest
 * and the domain invariants, rebuilds the derived holder index from the
 * restored balances and compares it with the restored index file. Hermetic:
 * it reads only the two files given, never a live store or the ledger.
 *
 * READ-ONLY unless --repair is passed. With --repair, the rebuilt holder index
 * replaces the restored one (atomically) and the restore is verified again.
 *
 * Usage:
 *   npm run verify:snapshot-restore -- --snapshot=backups/snapshot.json
 *   npm run verify:snapshot-restore -- --snapshot=backups/snapshot.json --holder-index=.data/holder-index.json
 *   npm run verify:snapshot-restore -- --snapshot=backups/snapshot.json --json
 *   npm run verify:snapshot-restore -- --snapshot=backups/snapshot.json --repair
 *
 * Exit codes: 0 verified, 1 mismatches found, 2 execution failure.
 */
import 'reflect-metadata';
import { promises as fs } from 'fs';
import * as path from 'path';
import { DomainInvariantsService } from '../src/reconciliation/services/domain-invariants.service';
import { RedisService } from '../src/common/services/redis.service';
import { KycStoreService } from '../src/common/services/kyc-store.service';
import {
  CriticalDataSnapshot,
  HolderIndexData,
  RestoreVerificationReport,
  SnapshotRestoreVerificationService,
} from '../src/recovery/snapshot-restore-verification.service';

function arg(name: string): string | undefined {
  return process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T;
}

/** Write via a temp file + rename so a crash never leaves a half-written index. */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value), 'utf8');
  await fs.rename(tmp, file);
}

function render(report: RestoreVerificationReport): void {
  console.log('\n================================================================================');
  console.log('            VERDANT BOND PROTOCOL - SNAPSHOT RESTORE VERIFICATION              ');
  console.log('================================================================================');
  console.log(`Snapshot captured: ${report.snapshotCapturedAt}`);
  console.log(`Verified at:       ${report.verifiedAt}`);
  console.log(`Status:            [ ${report.status} ]`);
  console.log(`Mismatches:        ${report.mismatches.length}`);
  console.log(`Warnings:          ${report.warnings.length}`);
  for (const [label, list] of [['MISMATCH', report.mismatches], ['WARNING', report.warnings]] as const) {
    list.forEach((m, i) => {
      console.log(`\n[${label} #${i + 1}] ${m.check} | ${m.severity} | ${m.entity}`);
      console.log(`     ${m.description}`);
      console.log(`     Repair: ${m.repair}`);
    });
  }
  console.log('================================================================================\n');
}

async function main(): Promise<number> {
  const snapshotPath = arg('snapshot');
  if (!snapshotPath) {
    console.error('Missing --snapshot=<path to snapshot JSON>');
    return 2;
  }
  const indexPath =
    arg('holder-index') || process.env.HOLDER_INDEX_PATH || path.resolve(process.cwd(), '.data', 'holder-index.json');
  const asJson = process.argv.includes('--json');
  const repair = process.argv.includes('--repair');

  const snapshot = await readJson<CriticalDataSnapshot>(snapshotPath);
  const restoredIndex = await readJson<HolderIndexData>(indexPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return { holders: {}, knownAddresses: [], lastReconciled: {} };
    throw error;
  });

  // The invariants read only what the snapshot provides; these stand-ins keep
  // the run from touching live Redis or the live KYC store.
  const invariants = new DomainInvariantsService(
    { scanKeys: async () => [], get: async () => null } as unknown as RedisService,
    { list: async () => snapshot.sections?.kycRecords ?? [], listAudit: async () => [] } as unknown as KycStoreService,
  );
  const verifier = new SnapshotRestoreVerificationService(invariants);

  let report = await verifier.verify(snapshot, restoredIndex);
  if (repair && report.status === 'FAILED') {
    await writeJsonAtomic(indexPath, report.rebuiltHolderIndex);
    if (!asJson) console.log(`Rewrote holder index ${indexPath} from the snapshot; verifying again.`);
    report = await verifier.verify(snapshot, report.rebuiltHolderIndex);
  }

  if (asJson) console.log(JSON.stringify(report, null, 2));
  else render(report);
  return report.status === 'VERIFIED' ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('Snapshot restore verification failed to run:', error instanceof Error ? error.message : error);
    process.exit(2);
  });
