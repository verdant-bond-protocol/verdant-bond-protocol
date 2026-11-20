#!/usr/bin/env node
/**
 * Offline verification of an event-ledger export (docs/event-ledger.md).
 * Needs no database, network, or running API: only the export.
 *
 * Usage:
 *   npm run ledger:verify-export -- --file=export.json              # body of GET /api/v1/ledger/export
 *   npm run ledger:verify-export -- --manifest=m.json --body=events.ndjson
 *   npm run ledger:verify-export -- --file=export.json --expected-head=<hash>
 *
 * Checkpoint MACs are verified when LEDGER_CHECKPOINT_KEY (and optionally
 * LEDGER_CHECKPOINT_KEY_ID, LEDGER_CHECKPOINT_RETIRED_KEYS,
 * LEDGER_CHECKPOINT_LOST_KEY_IDS) are set, with the same meaning as in the API.
 * `--expected-head` compares against a head you obtained independently
 * (a previous export, a published anchor) to detect a truncated export.
 *
 * Exits 0 when the export verifies, 1 on any failure, 2 on usage errors.
 */
import { readFileSync } from 'fs';
import { MIN_CHECKPOINT_KEY_LENGTH, verifyLedgerExport } from '../src/ledger/ledger.chain';
import { LedgerExport } from '../src/ledger/ledger.types';

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

let exp: LedgerExport;
try {
  const file = arg('file');
  if (file) {
    exp = JSON.parse(readFileSync(file, 'utf8'));
  } else if (arg('manifest') && arg('body')) {
    exp = { manifest: JSON.parse(readFileSync(arg('manifest')!, 'utf8')), ndjson: readFileSync(arg('body')!, 'utf8') };
  } else {
    console.error('pass --file=<export.json> or --manifest=<manifest.json> --body=<events.ndjson>');
    process.exit(2);
  }
} catch (error) {
  console.error(`cannot read export: ${(error as Error).message}`);
  process.exit(2);
}

const keys: Record<string, string> = {};
for (const pair of (process.env.LEDGER_CHECKPOINT_RETIRED_KEYS ?? '').split(',')) {
  const idx = pair.indexOf(':');
  if (idx > 0) keys[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
}
const current = process.env.LEDGER_CHECKPOINT_KEY ?? '';
if (current.length >= MIN_CHECKPOINT_KEY_LENGTH) keys[process.env.LEDGER_CHECKPOINT_KEY_ID || 'v1'] = current;
const haveKeys = Object.keys(keys).length > 0;

const lostKeyIds = (process.env.LEDGER_CHECKPOINT_LOST_KEY_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean);
const report = verifyLedgerExport(exp.manifest, exp.ndjson, haveKeys ? keys : undefined, lostKeyIds);
const expectedHead = arg('expected-head');
if (expectedHead && expectedHead !== exp.manifest.headHash) {
  report.ok = false;
  report.failures.push({ sequence: null, reason: 'head mismatch', expected: expectedHead, actual: exp.manifest.headHash });
}

for (const f of report.failures) {
  console.error(`✗ seq ${f.sequence ?? '-'}: ${f.reason} (expected ${f.expected ?? '-'}, got ${f.actual ?? '-'})`);
}
if (!haveKeys && exp.manifest.checkpoints.length) {
  console.warn(`! ${exp.manifest.checkpoints.length} checkpoint(s) not MAC-verified: LEDGER_CHECKPOINT_KEY not set`);
}
console.log(
  report.ok
    ? `✓ ${report.checkedEvents} event(s) ${exp.manifest.fromSequence}..${exp.manifest.toSequence} verify; head ${report.headHash}`
    : `${report.failures.length} failure(s); export does NOT verify`,
);
process.exit(report.ok ? 0 : 1);
