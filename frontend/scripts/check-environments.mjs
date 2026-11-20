#!/usr/bin/env node
/**
 * Build-time guard for the environment files (issue #167).
 *
 * `adminAddress` used to ship as the literal 'G...', which is not a valid
 * Stellar account. Every admin comparison against it silently failed. This
 * check runs as `prebuild`, so a placeholder or malformed address can never
 * reach a production bundle.
 *
 * Exit codes: 0 = ok (warnings allowed), 1 = a value that must not ship.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StrKey } from '@stellar/stellar-sdk';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLACEHOLDER = 'G...';

const FILES = [
  { path: join(ROOT, 'src/environments/environment.ts'), production: false },
  { path: join(ROOT, 'src/environments/environment.prod.ts'), production: true },
];

/**
 * Read a string literal assigned to `key` in an environment file. The files are
 * flat object literals by convention, so a regex avoids pulling a TS parser in.
 */
function readStringField(source, key) {
  const match = source.match(new RegExp(`\\b${key}\\s*:\\s*(['"\`])([\\s\\S]*?)\\1`));
  return match ? match[2] : undefined;
}

const errors = [];
const warnings = [];

for (const { path, production } of FILES) {
  const label = relative(ROOT, path);
  let source;
  try {
    source = readFileSync(path, 'utf8');
  } catch {
    errors.push(`${label}: environment file is missing.`);
    continue;
  }

  const adminAddress = readStringField(source, 'adminAddress');

  if (adminAddress === undefined) {
    // Removing the field entirely is a valid resolution of #167.
    continue;
  }

  if (adminAddress === PLACEHOLDER) {
    errors.push(
      `${label}: adminAddress is still the '${PLACEHOLDER}' placeholder. ` +
        'Set the deployment\'s admin Stellar public key (the API\'s STELLAR_PUBLIC_KEY), or leave it empty to disable admin features.',
    );
    continue;
  }

  if (adminAddress === '') {
    warnings.push(
      `${label}: adminAddress is empty — admin-only UI (issue bond, sweep undistributed) will be hidden in this build.`,
    );
    continue;
  }

  if (!StrKey.isValidEd25519PublicKey(adminAddress)) {
    errors.push(
      `${label}: adminAddress '${adminAddress}' is not a valid Stellar ed25519 public key.`,
    );
  }
}

for (const warning of warnings) {
  console.warn(`⚠ ${warning}`);
}

if (errors.length > 0) {
  console.error('✖ Environment check failed:');
  for (const error of errors) {
    console.error(`  - ${error}`);
  }
  process.exit(1);
}

console.log('✓ Environment check passed.');
