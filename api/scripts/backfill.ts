#!/usr/bin/env node
/**
 * Operator-safe backfill tool. Dry-run by default; `apply` writes in
 * checkpointed batches and journals before-images for rollback.
 *
 * Usage:
 *   npm run backfill -- list
 *   npm run backfill -- plan  --job kyc-record-normalize
 *   npm run backfill -- apply --job kyc-record-normalize --confirm-plan <digest>
 *   npm run backfill -- apply --job kyc-record-normalize --resume
 *   npm run backfill -- status --job kyc-record-normalize
 *   npm run backfill -- rollback --job kyc-record-normalize --run <runId>
 *
 * See docs/BACKFILL.md for the runbook.
 */
import { runCli } from '../src/backfill/backfill-cli';

let stopRequested = false;
process.on('SIGINT', () => {
  if (stopRequested) process.exit(130);
  stopRequested = true;
  console.error('Stopping after the current batch commits (Ctrl-C again to force; then run `status`).');
});
process.on('SIGTERM', () => {
  stopRequested = true;
});

runCli(process.argv.slice(2), {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  shouldStop: () => stopRequested,
}).then((code) => process.exit(code));
