#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'pg';
import { createClient } from '@redis/client';
import {
  buildSummary,
  checkDependencies,
  checkEnvironment,
  checkNodeVersion,
  DiagnosticResult,
  formatSummary,
  parseEnvFile,
} from '../src/ops/developer-diagnostics';
import {
  connectivityResultFromProbe,
  probeWithRetry,
  RetryOptions,
} from '../src/ops/setup-failure-diagnostics';

/**
 * Contributor diagnostics (#374).
 *
 * `npm run diagnostics` — one command that validates the local setup and the
 * external-service assumptions the API depends on, then prints exactly what to
 * fix. All decision/remediation logic lives in
 * `src/ops/developer-diagnostics.ts` and is unit tested; this script only
 * gathers the real environment facts.
 *
 * Connectivity failures are classified and retried by
 * `src/ops/setup-failure-diagnostics.ts` (#513).
 *
 * Flags: `--json` prints the machine-readable summary; `--no-retry` probes
 * each service once.
 */

const apiRoot = path.join(__dirname, '..');
const envPath = path.join(apiRoot, '.env');
const envExamplePath = path.join(apiRoot, '.env.example');

const args = process.argv.slice(2);
const jsonOutput = args.includes('--json');
// `--no-retry` gives a single fast probe, e.g. for CI where services are
// either up or not configured at all.
const retryOptions: RetryOptions = args.includes('--no-retry') ? { attempts: 1 } : {};

function loadEnvFile(): boolean {
  if (!fs.existsSync(envPath)) return false;
  const values = parseEnvFile(fs.readFileSync(envPath, 'utf-8'));
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

// Probes throw on failure so `probeWithRetry` can classify the raw error
// (refused vs. bad credentials vs. missing database, ...) and decide whether
// a retry is worthwhile (#513).
async function pingRedis(url: string): Promise<void> {
  const client = createClient({ url, socket: { connectTimeout: 2000, reconnectStrategy: false } });
  // Without a listener, node-redis re-emits socket errors as unhandled.
  client.on('error', () => undefined);
  try {
    await client.connect();
    await client.ping();
  } finally {
    try {
      await client.disconnect();
    } catch {
      /* already closed */
    }
  }
}

async function selectPostgres(url: string): Promise<void> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
  } finally {
    try {
      await client.end();
    } catch {
      /* already closed */
    }
  }
}

async function checkRedis(url: string): Promise<DiagnosticResult> {
  const outcome = await probeWithRetry('redis', () => pingRedis(url), retryOptions);
  return connectivityResultFromProbe('Redis connectivity', url, outcome);
}

async function checkPostgres(url: string): Promise<DiagnosticResult> {
  const outcome = await probeWithRetry('postgres', () => selectPostgres(url), retryOptions);
  return connectivityResultFromProbe('PostgreSQL connectivity', url, outcome);
}

function checkSeedData(): DiagnosticResult {
  const seedScript = path.join(apiRoot, 'scripts', 'seed.ts');
  const present = fs.existsSync(seedScript);
  return {
    name: 'Seed tooling available',
    passed: present,
    remediation: present ? undefined : 'Restore api/scripts/seed.ts so `npm run seed` works.',
  };
}

async function run(): Promise<void> {
  const envFilePresent = loadEnvFile();
  const envContents = envFilePresent ? fs.readFileSync(envPath, 'utf-8') : '';

  const results: DiagnosticResult[] = [
    checkNodeVersion(process.version),
    checkDependencies(fs.existsSync(path.join(apiRoot, 'node_modules'))),
    ...checkEnvironment(envFilePresent, envContents),
    checkSeedData(),
  ];

  if (!envFilePresent && fs.existsSync(envExamplePath)) {
    results.push({
      name: 'Environment template present',
      passed: true,
    });
  }

  results.push(
    await checkRedis(process.env.REDIS_URL || 'redis://localhost:6379'),
    await checkPostgres(process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/verdant'),
  );

  const summary = buildSummary(results);
  if (jsonOutput) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log('Verdant Bond Protocol — contributor diagnostics\n');
    console.log(formatSummary(summary));
  }

  if (!summary.passed) process.exit(1);
}

run().catch((error) => {
  console.error('Diagnostics failed to run:', error);
  process.exit(1);
});
