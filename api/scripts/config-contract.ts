#!/usr/bin/env node
/**
 * Configuration contract check (#352). Run before every deploy.
 *
 * Usage:
 *   npm run config:contract -- --target=production                  # checks process.env
 *   npm run config:contract -- --target=production --file=.env.prod
 *   npm run config:contract -- --target=production --file=.env.prod --compare=.env.staging
 *
 * Exits 1 on any violation. Prints variable names and codes, never values.
 */
import { readFileSync } from 'fs';
import { parseEnv } from 'util';
import { checkConfigContract, compareEnvironments, DeployTarget, EnvMap } from '../src/common/config/config-contract';

const TARGETS: DeployTarget[] = ['development', 'staging', 'production'];
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const load = (path: string): EnvMap => parseEnv(readFileSync(path, 'utf8')) as EnvMap;

const target = arg('target') as DeployTarget;
if (!TARGETS.includes(target)) {
  console.error(`--target must be one of ${TARGETS.join(', ')}`);
  process.exit(2);
}

const file = arg('file');
const env = file ? load(file) : (process.env as EnvMap);
const violations = checkConfigContract(env, target);
const compare = arg('compare');
if (compare) violations.push(...compareEnvironments(env, file ?? 'process.env', load(compare), compare));

for (const v of violations) console.error(`✗ [${v.code}] ${v.field}: ${v.message}`);
console.log(violations.length ? `${violations.length} violation(s) for ${target}` : `✓ ${target} configuration satisfies the contract`);
process.exit(violations.length ? 1 : 0);
