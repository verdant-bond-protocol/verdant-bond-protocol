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

function createMockFetch(baseUrl: string): typeof fetch {
  let bondStatus = 'Active';
  const TX_HASH = 'e'.repeat(64);

  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof input === 'string' ? input : input.toString();
    const pathname = urlStr.replace(baseUrl, '');
    const method = init?.method ?? 'GET';
    const key = `${method} ${pathname}`;

    let status = 200;
    let body: any = {};

    if (key === 'GET /api/health/ready') {
      body = { status: 'ready', sorobanRpc: 'healthy' };
    } else if (key === 'POST /api/bonds') {
      const authHeader = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (!authHeader || authHeader.includes('mock-investor') || authHeader.includes('mock-unauth') || authHeader.includes('unauthorized')) {
        status = 403;
        body = { message: 'Forbidden: admin only' };
      } else {
        const payload = JSON.parse((init?.body as string) || '{}');
        if (payload.faceValue <= 0 || payload.totalSupply <= 0) {
          status = 400;
          body = { message: 'Validation failed: faceValue and totalSupply must be positive' };
        } else {
          bondStatus = 'Active';
          status = 201;
          body = { id: 101, bondId: 101, status: 'Active', faceValue: payload.faceValue, totalSupply: payload.totalSupply };
        }
      }
    } else if (key === 'GET /api/bonds/101') {
      body = { id: 101, status: bondStatus, faceValue: 100, totalSupply: 10000 };
    } else if (key === 'POST /api/bonds/101/subscribe') {
      const headers = (init?.headers as Record<string, string> | undefined) || {};
      if (!headers.Authorization) {
        status = 401;
        body = { message: 'Unauthorized' };
      } else {
        const payload = JSON.parse((init?.body as string) || '{}');
        if (payload.amount > 10000) {
          status = 400;
          body = { message: 'Subscription amount exceeds total supply' };
        } else {
          status = 200;
          body = { bondId: 101, investorAddress: payload.investorAddress, amount: String(payload.amount), transactionHash: TX_HASH };
        }
      }
    } else if (key === 'POST /api/bonds/101/coupon') {
      const authHeader = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (!authHeader || authHeader.includes('mock-investor')) {
        status = 403;
        body = { message: 'Admin permissions required' };
      } else {
        const payload = JSON.parse((init?.body as string) || '{}');
        if (payload.periodIndex < 0) {
          status = 400;
          body = { message: 'Period index cannot be negative' };
        } else {
          status = 200;
          body = { bondId: 101, periodIndex: payload.periodIndex, holderCount: 1 };
        }
      }
    } else if (key === 'POST /api/bonds/101/claim') {
      status = 200;
      body = { bondId: 101, credits: '50' };
    } else if (key === 'POST /api/bonds/101/mature') {
      const authHeader = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (!authHeader || authHeader.includes('mock-investor')) {
        status = 403;
        body = { message: 'Admin permissions required' };
      } else {
        bondStatus = 'Matured';
        status = 200;
        body = { id: 101, status: 'Matured' };
      }
    } else if (key === 'POST /api/bonds/101/redeem') {
      if (bondStatus !== 'Matured') {
        status = 400;
        body = { message: 'Bond is not matured yet' };
      } else {
        const payload = JSON.parse((init?.body as string) || '{}');
        if (payload.amount > 1000) {
          status = 400;
          body = { message: 'Redeem amount exceeds balance' };
        } else {
          status = 200;
          body = { bondId: 101, redeemedAmount: payload.amount, principalPaid: payload.amount * 100 };
        }
      }
    } else if (key === 'GET /api/bonds/101/holders') {
      status = 200;
      body = { holders: [{ address: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', balance: '0' }] };
    } else {
      status = 404;
      body = { message: `Route not found: ${key}` };
    }

    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

async function main(): Promise<number> {
  const config = parseConfig();

  const fetchImpl = config.network === 'mock' ? createMockFetch(config.baseUrl) : fetch;

  const runtime: TestnetSmokeRuntime = {
    fetch: fetchImpl,
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
