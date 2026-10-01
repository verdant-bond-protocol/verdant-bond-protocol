#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { Client } from 'pg';
import { createClient } from '@redis/client';

console.log('Verdant Bond Protocol Diagnostics\n');

let allPassed = true;

function logResult(check: string, passed: boolean, message: string) {
  if (passed) {
    console.log(`✅ [PASS] ${check}`);
  } else {
    console.log(`❌ [FAIL] ${check}`);
    console.log(`   Remediation: ${message}`);
    allPassed = false;
  }
}

async function checkNodeVersion() {
  try {
    const version = process.version;
    const match = version.match(/^v(\d+)/);
    if (match && parseInt(match[1], 10) >= 18) {
      logResult('Node.js Version', true, '');
    } else {
      logResult('Node.js Version', false, `Current version is ${version}. Please upgrade to Node.js v18 or newer.`);
    }
  } catch (error) {
    logResult('Node.js Version', false, 'Could not determine Node.js version.');
  }
}

function checkDependencies() {
  const nodeModulesPath = path.join(__dirname, '..', 'node_modules');
  if (fs.existsSync(nodeModulesPath)) {
    logResult('Dependencies', true, '');
  } else {
    logResult('Dependencies', false, 'Run `npm install` in the api directory.');
  }
}

function checkEnvVars() {
  const envPath = path.join(__dirname, '..', '.env');
  const envExamplePath = path.join(__dirname, '..', '.env.example');
  
  if (fs.existsSync(envPath)) {
    logResult('Environment File', true, '');
  } else {
    logResult('Environment File', false, 'Missing .env file. Copy .env.example to .env and configure it.');
    return;
  }

  // Load basic env vars
  const envContent = fs.readFileSync(envPath, 'utf-8');
  if (!envContent.includes('REDIS_URL')) {
    logResult('Environment Variable REDIS_URL', false, 'Add REDIS_URL to your .env file.');
  }
}

async function checkRedis() {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  const client = createClient({ url, socket: { connectTimeout: 2000 } });
  try {
    await client.connect();
    await client.ping();
    await client.disconnect();
    logResult('Redis Connectivity', true, '');
  } catch (error) {
    logResult('Redis Connectivity', false, `Could not connect to Redis at ${url}. Ensure Redis is running.`);
  }
}

async function checkPostgres() {
  const url = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/verdant';
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
    await client.end();
    logResult('PostgreSQL Connectivity', true, '');
  } catch (error) {
    logResult('PostgreSQL Connectivity', false, `Could not connect to PostgreSQL at ${url}. Ensure it is running and DATABASE_URL is set.`);
  }
}

async function run() {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  
  await checkNodeVersion();
  checkDependencies();
  checkEnvVars();
  await checkRedis();
  await checkPostgres();

  console.log('\n--------------------------------');
  if (allPassed) {
    console.log('🎉 All checks passed! You are ready to start working.');
  } else {
    console.log('⚠️ Some checks failed. Please address the remediation steps above.');
    process.exit(1);
  }
}

run();
