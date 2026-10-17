#!/usr/bin/env node
/**
 * Executable verification script for Issue #354:
 * Schema Evolution Guardrails for stored records and public API responses.
 */

import {
  BOND_ENTITY_SCHEMA,
  SchemaEvolutionGuardrails,
  SchemaEvolutionError,
} from '../api/src/common/versioning/schema-evolution-guardrails.ts';
import { SchemaVersion } from '../api/src/common/versioning/schema-versioning.ts';

import assert from 'node:assert/strict';

function main() {
  console.log('===============================================================');
  console.log('VERDANT BOND PROTOCOL: SCHEMA EVOLUTION GUARDRAILS VERIFICATION');
  console.log('===============================================================');

  // Test 1: Ingress Valid V2 Record
  console.log('\n[1/6] Processing valid canonical V2.0.0 bond record...');
  const validV2 = {
    id: 'bond-2026-001',
    symbol: 'VBD-AMAZON-01',
    faceValue: '5000000',
    interestRate: 0.055,
    creditType: 'Carbon',
    projectRegistryId: 'PROJ-REG-AMAZON-01',
    status: 'Active',
  };
  const res1 = SchemaEvolutionGuardrails.processIngress(validV2, BOND_ENTITY_SCHEMA);
  assert.equal(res1.version, SchemaVersion.V2_0_0);
  assert.equal(res1.processedData.projectRegistryId, 'PROJ-REG-AMAZON-01');
  assert.equal(res1.processedData.totalSubscribed, '0'); // default applied
  assert.equal(res1.strippedFields.length, 0);
  console.log('  ✓ Canonical V2 record validated with default field values applied');

  // Test 2: Deprecated Field Transformation
  console.log('\n[2/6] Verifying deprecated field fallback transformation...');
  const legacyRecord = {
    id: 'bond-legacy-002',
    symbol: 'VBD-LEGACY',
    faceValue: '1000000',
    legacyCouponRate: 550, // 550 bps -> 5.5%
    projectId: 'PROJ-LEGACY-42', // should map to projectRegistryId
    status: 'Active',
  };
  const res2 = SchemaEvolutionGuardrails.processIngress(legacyRecord, BOND_ENTITY_SCHEMA);
  assert.equal(res2.processedData.projectRegistryId, 'PROJ-LEGACY-42');
  assert.equal(res2.processedData.interestRate, 5.5);
  assert.equal(res2.processedData.projectId, undefined, 'Deprecated field should be removed in stored V2 shape');
  assert.equal(res2.deprecationWarnings.length, 2);
  console.log(`  ✓ Successfully transformed deprecated fields with ${res2.deprecationWarnings.length} warnings`);

  // Test 3: Strict Mode Rejection of Unknown Fields
  console.log('\n[3/6] Verifying strict unknown field rejection policy (REJECT)...');
  const recordWithUnknown = {
    ...validV2,
    arbitraryInjectedField: 'malicious_or_accidental_payload',
  };
  assert.throws(
    () => SchemaEvolutionGuardrails.processIngress(recordWithUnknown, BOND_ENTITY_SCHEMA, 'REJECT'),
    (err) => err instanceof SchemaEvolutionError && err.code === 'unknown_field_rejected',
    'Must reject undeclared fields in strict mode',
  );
  console.log('  ✓ Successfully rejected unknown field under strict policy');

  // Test 4: Public API Ingress Sanitization (STRIP)
  console.log('\n[4/6] Verifying public API strip policy (STRIP)...');
  const res4 = SchemaEvolutionGuardrails.processIngress(recordWithUnknown, BOND_ENTITY_SCHEMA, 'STRIP');
  assert.equal(res4.processedData.arbitraryInjectedField, undefined);
  assert.deepEqual(res4.strippedFields, ['arbitraryInjectedField']);
  console.log(`  ✓ Successfully sanitized ingress payload; stripped: ${res4.strippedFields.join(', ')}`);

  // Test 5: Extension Namespace Isolation (PRESERVE_EXTENSION)
  console.log('\n[5/6] Verifying extension namespace policy (PRESERVE_EXTENSION)...');
  const res5 = SchemaEvolutionGuardrails.processIngress(recordWithUnknown, BOND_ENTITY_SCHEMA, 'PRESERVE_EXTENSION');
  assert.ok(res5.processedData.extensions);
  assert.equal(res5.processedData.extensions.arbitraryInjectedField, 'malicious_or_accidental_payload');
  console.log('  ✓ Unknown field safely isolated into extensions bag');

  // Test 6: Forward & Backward Compatibility Pipeline
  console.log('\n[6/6] Verifying forward and backward compatibility pipeline...');
  const compat = SchemaEvolutionGuardrails.verifyCompatibility(
    legacyRecord,
    SchemaVersion.V1_0_0,
    BOND_ENTITY_SCHEMA,
  );
  assert.equal(compat.backwardCompatible, true, 'Must read legacy record seamlessly');
  assert.equal(compat.forwardCompatible, true, 'Must project legacy shape for older client');
  console.log('  ✓ Legacy V1.0.0 record is bi-directionally compatible with V2.0.0 pipeline');

  console.log('\n===============================================================');
  console.log('ALL SCHEMA EVOLUTION GUARDRAIL TESTS PASSED! (Issue #354)');
  console.log('===============================================================');
}

try {
  main();
} catch (err) {
  console.error('Schema evolution guardrail verification failed:', err);
  process.exit(1);
}
