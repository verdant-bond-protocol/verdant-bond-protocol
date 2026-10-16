#!/usr/bin/env node
/**
 * Synthetic journey monitor runner (#380): exercises the investor subscription
 * journey against a running API and reports latency, failures and the
 * dependency to blame. See docs/synthetic-journey-monitor.md.
 *
 * Usage:
 *   npm run monitor:journey -- --base-url=https://api.example.org
 *   npm run monitor:journey -- --base-url=http://localhost:3000 --bond=3 --amount=1 --json
 *   npm run monitor:journey -- --interval=300            # run every 5 minutes, one JSON line per run
 *   npm run monitor:journey -- --write                   # also subscribe + confirm (never on mainnet)
 *
 * Environment:
 *   SYNTHETIC_BASE_URL            default API origin (http://localhost:3000)
 *   SYNTHETIC_STEP_TIMEOUT_MS     per-request timeout (10000)
 *   SYNTHETIC_INVESTOR_TOKEN      bearer token of a KYC-verified synthetic investor (--write)
 *   SYNTHETIC_INVESTOR_ADDRESS    that investor's Stellar address (--write)
 *   STELLAR_NETWORK               --write is refused when this is "mainnet"
 *
 * Exit codes (single run): 0 journey passed, 1 journey failed, 2 misuse.
 */
import { randomUUID } from 'crypto';
import { JourneyReport, SyntheticJourneyConfig, SyntheticJourneyMonitor } from '../src/ops/synthetic-journey.monitor';

/** Ledgers close roughly every 5-6 seconds; poll once per ledger. */
const CONFIRM_POLL_MS = 5_000;
/** The API builds transactions with a 30s validity window; allow twice that to settle. */
const CONFIRM_TIMEOUT_MS = 60_000;

function arg(name: string): string | undefined {
  return process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
}

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`--${name} must be a positive integer`);
  return value;
}

function buildConfig(): SyntheticJourneyConfig {
  const write = process.argv.includes('--write');
  const config: SyntheticJourneyConfig = {
    baseUrl: (arg('base-url') ?? process.env.SYNTHETIC_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
    bondId: arg('bond') === undefined ? undefined : positiveInt(arg('bond'), 0, 'bond'),
    amount: positiveInt(arg('amount'), 1, 'amount'),
    stepTimeoutMs: positiveInt(process.env.SYNTHETIC_STEP_TIMEOUT_MS, 10_000, 'SYNTHETIC_STEP_TIMEOUT_MS'),
    confirmTimeoutMs: CONFIRM_TIMEOUT_MS,
    confirmPollMs: CONFIRM_POLL_MS,
  };
  if (!write) return config;

  if (process.env.STELLAR_NETWORK === 'mainnet') {
    throw new Error('--write submits real subscriptions and is refused on mainnet; run read-only there');
  }
  const token = process.env.SYNTHETIC_INVESTOR_TOKEN;
  const investorAddress = process.env.SYNTHETIC_INVESTOR_ADDRESS;
  if (!token || !investorAddress) {
    throw new Error('--write needs SYNTHETIC_INVESTOR_TOKEN and SYNTHETIC_INVESTOR_ADDRESS');
  }
  return { ...config, write: { token, investorAddress } };
}

function render(report: JourneyReport): void {
  console.log(`\nSynthetic journey: ${report.journey} @ ${report.startedAt}`);
  console.log(`Result: ${report.ok ? 'PASS' : 'FAIL'} in ${report.totalLatencyMs}ms${report.bondId ? ` (bond ${report.bondId})` : ''}`);
  for (const step of report.steps) {
    const outcome = step.ok ? 'ok  ' : 'FAIL';
    console.log(`  [${outcome}] ${step.name.padEnd(20)} ${String(step.latencyMs).padStart(6)}ms${step.ok ? '' : `  blame=${step.dependency}  ${step.error}`}`);
  }
  if (report.blame) console.log(`Blame: ${report.blame}`);
  if (report.degradedDependencies.length) console.log(`Readiness reports degraded: ${report.degradedDependencies.join(', ')}`);
}

async function main(): Promise<number> {
  const config = buildConfig();
  const monitor = new SyntheticJourneyMonitor(config, {
    fetch,
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    idempotencyKey: () => `synthetic-${randomUUID()}`,
  });

  const intervalSeconds = arg('interval');
  if (intervalSeconds === undefined) {
    const report = await monitor.run();
    if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
    else render(report);
    return report.ok ? 0 : 1;
  }

  // Scheduled mode: one JSON line per run for log-based alerting; runs never overlap.
  const intervalMs = positiveInt(intervalSeconds, 0, 'interval') * 1000;
  for (;;) {
    const started = Date.now();
    console.log(JSON.stringify(await monitor.run()));
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, intervalMs - (Date.now() - started))));
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  });
