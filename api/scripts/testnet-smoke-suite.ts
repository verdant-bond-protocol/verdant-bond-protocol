#!/usr/bin/env node
/**
 * Testnet Smoke Suite Runner
 *
 * Exercises the 4 core stages of the Verdant Bond Protocol lifecycle on Testnet:
 * 1. Issue: tokenized bond tranche creation & configuration
 * 2. Subscribe: investor participation & balance allocation
 * 3. Coupon: performance tracking & coupon credit claiming
 * 4. Redeem: maturity transition & principal redemption
 *
 * Verifies normal, failure, retry, and authorization paths.
 * Refuses execution on Mainnet.
 *
 * Usage:
 *   npm run smoke:testnet -- --base-url=http://localhost:3000
 *   npm run smoke:testnet -- --base-url=https://api.testnet.verdantbond.org --json
 *
 * Environment:
 *   TESTNET_API_URL            Default API URL (http://localhost:3000)
 *   SMOKE_ADMIN_TOKEN          Bearer JWT for Admin role
 *   SMOKE_ADMIN_ADDRESS        Stellar public key for Admin
 *   SMOKE_INVESTOR_TOKEN       Bearer JWT for KYC-verified Investor
 *   SMOKE_INVESTOR_ADDRESS     Stellar public key for Investor
 *   STELLAR_NETWORK            Network identifier ('testnet', 'local', or 'mock')
 */

import { randomUUID } from 'crypto';
import {
  TestnetSmokeSuite,
  TestnetSmokeConfig,
  TestnetSmokeRuntime,
  TestnetSmokeReport,
} from '../src/ops/testnet-smoke-suite';

function arg(name: string): string | undefined {
  return process.argv
    .slice(2)
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=');
}

function parseConfig(): TestnetSmokeConfig {
  const network = (arg('network') ?? process.env.STELLAR_NETWORK ?? 'testnet') as 'testnet' | 'local' | 'mock';
  if (network === ('mainnet' as any)) {
    console.error('FATAL: Testnet smoke suite cannot be run against mainnet!');
    process.exit(2);
  }

  const baseUrl = (arg('base-url') ?? process.env.TESTNET_API_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
  const adminToken = arg('admin-token') ?? process.env.SMOKE_ADMIN_TOKEN ?? 'mock-admin-jwt';
  const adminAddress = arg('admin-address') ?? process.env.SMOKE_ADMIN_ADDRESS ?? 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
  const investorToken = arg('investor-token') ?? process.env.SMOKE_INVESTOR_TOKEN ?? 'mock-investor-jwt';
  const investorAddress = arg('investor-address') ?? process.env.SMOKE_INVESTOR_ADDRESS ?? 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

  return {
    baseUrl,
    network,
    adminToken,
    adminAddress,
    investorToken,
    investorAddress,
    stepTimeoutMs: 15_000,
    pollTimeoutMs: 60_000,
    pollIntervalMs: 5_000,
  };
}

function renderReport(report: TestnetSmokeReport): void {
  console.log('\n======================================================');
  console.log(` VERDANT BOND PROTOCOL - TESTNET SMOKE SUITE`);
  console.log('======================================================');
  console.log(`Network:   ${report.network}`);
  console.log(`Started:   ${report.startedAt}`);
  console.log(`Duration:  ${report.totalDurationMs} ms`);
  console.log(`Result:    ${report.ok ? '✓ PASS' : '✗ FAILED'}`);
  if (report.bondId) console.log(`Bond ID:   ${report.bondId}`);
  console.log('------------------------------------------------------');
  console.log('STAGES & PATHS COVERED:');
  console.log(`  Stages:  Issue [${report.stagesCovered.issue ? '✓' : '✗'}] | Subscribe [${report.stagesCovered.subscribe ? '✓' : '✗'}] | Coupon [${report.stagesCovered.coupon ? '✓' : '✗'}] | Redeem [${report.stagesCovered.redeem ? '✓' : '✗'}]`);
  console.log(`  Paths:   Normal [${report.pathsCovered.normal ? '✓' : '✗'}] | Failure [${report.pathsCovered.failure ? '✓' : '✗'}] | Retry [${report.pathsCovered.retry ? '✓' : '✗'}] | Auth [${report.pathsCovered.authorization ? '✓' : '✗'}]`);
  console.log('------------------------------------------------------');
  console.log('EXECUTION STEPS:');

  for (const s of report.steps) {
    const outcome = s.ok ? 'PASS ' : 'FAIL ';
    const stage = `[${s.stage.toUpperCase()}]`.padEnd(12);
    const path = `(${s.path})`.padEnd(16);
    const latency = `${s.latencyMs}ms`.padStart(8);
    const errText = s.error ? ` -> ${s.blame}: ${s.error}` : '';
    console.log(`  ${outcome} ${stage} ${s.name.padEnd(35)} ${path} ${latency}${errText}`);
  }

  console.log('------------------------------------------------------');
  console.log(`Summary: ${report.summary}`);
  console.log('======================================================\n');
}

async function main(): Promise<number> {
  const config = parseConfig();

  const runtime: TestnetSmokeRuntime = {
    fetch,
    now: Date.now,
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    idempotencyKey: () => `smoke-${randomUUID()}`,
  };

  const suite = new TestnetSmokeSuite(config, runtime);
  const report = await suite.run();

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    renderReport(report);
  }

  return report.ok ? 0 : 1;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('Fatal smoke suite failure:', err);
      process.exit(1);
    });
}
