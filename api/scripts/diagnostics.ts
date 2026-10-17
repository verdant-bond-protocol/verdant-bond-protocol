#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'pg';
import { createClient } from '@redis/client';
import {
  buildSummary,
  checkConnectivity,
  checkDependencies,
  checkEnvironment,
  checkNodeVersion,
  DiagnosticResult,
  formatSummary,
  parseEnvFile,
} from '../src/ops/developer-diagnostics';

/**
 * Contributor diagnostics (#374).
 *
 * `npm run diagnostics` — one command that validates the local setup and the
 * external-service assumptions the API depends on, then prints exactly what to
 * fix. All decision/remediation logic lives in
 * `src/ops/developer-diagnostics.ts` and is unit tested; this script only
 * gathers the real environment facts.
 */

const apiRoot = path.join(__dirname, '..');
const envPath = path.join(apiRoot, '.env');
const envExamplePath = path.join(apiRoot, '.env.example');

function loadEnvFile(): boolean {
  if (!fs.existsSync(envPath)) return false;
  const values = parseEnvFile(fs.readFileSync(envPath, 'utf-8'));
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

async function checkRedis(url: string): Promise<DiagnosticResult> {
  const client = createClient({ url, socket: { connectTimeout: 2000 } });
  let ok = false;
  try {
    await client.connect();
    await client.ping();
    ok = true;
  } catch {
    ok = false;
  } finally {
    try {
      await client.disconnect();
    } catch {
      /* already closed */
    }
  }
  return checkConnectivity('Redis connectivity', ok, url, 'start Redis (docker compose up redis) or fix REDIS_URL.');
}

async function checkPostgres(url: string): Promise<DiagnosticResult> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  let ok = false;
  try {
    await client.connect();
    await client.query('SELECT 1');
    ok = true;
  } catch {
    ok = false;
  } finally {
    try {
      await client.end();
    } catch {
      /* already closed */
    }
  }
  return checkConnectivity(
    'PostgreSQL connectivity',
    ok,
    url,
    'start PostgreSQL (docker compose up postgres) or fix DATABASE_URL.',
  );
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
  console.log('Verdant Bond Protocol — contributor diagnostics\n');
  console.log(formatSummary(summary));

  if (!summary.passed) process.exit(1);
}

run().catch((error) => {
  console.error('Diagnostics failed to run:', error);
  process.exit(1);
});
