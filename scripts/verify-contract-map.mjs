#!/usr/bin/env node
/**
 * Executable verification script for Issue #368:
 * Cross-Service Contract Map for Domain Events and Integration Boundaries.
 */

import {
  CROSS_SERVICE_CONTRACT_MAP,
  validateCrossServiceEvent,
  getContractsByProducer,
  getContractsByConsumer,
} from '../api/src/common/contracts/cross-service-contract-map.ts';

import assert from 'node:assert/strict';

function main() {
  console.log('===============================================================');
  console.log('VERDANT BOND PROTOCOL: CROSS-SERVICE CONTRACT MAP VERIFICATION');
  console.log('===============================================================');

  const contractKeys = Object.keys(CROSS_SERVICE_CONTRACT_MAP);
  console.log(`\n[1/5] Verifying contract map registry completeness (${contractKeys.length} contracts)...`);
  assert.ok(contractKeys.length >= 6, 'Must define all core cross-service contracts');

  for (const [name, contract] of Object.entries(CROSS_SERVICE_CONTRACT_MAP)) {
    assert.equal(contract.eventName, name);
    assert.ok(contract.producer, `Contract ${name} missing producer`);
    assert.ok(contract.consumers.length > 0, `Contract ${name} must have at least one consumer`);
    assert.ok(['fail-closed', 'dead-letter-retry', 'circuit-breaker-pause'].includes(contract.allowedFailureBehavior));
    assert.ok(['additive-only', 'immutable-strict', 'deprecate-with-fallback'].includes(contract.semverRule));
    assert.ok(contract.payloadSchema.length > 0, `Contract ${name} must define payload schema`);
    console.log(`  ✓ ${name} [${contract.producer} -> ${contract.consumers.map(c => c.consumer).join(', ')}] [${contract.allowedFailureBehavior}]`);
  }

  console.log('\n[2/5] Validating valid event payloads across integration boundaries...');
  const validBondIssued = {
    eventName: 'bond.issued',
    schemaVersion: '1.0.0',
    producer: 'contract:BondIssuer',
    timestamp: '2026-01-01T00:00:00.000Z',
    payload: {
      bondId: 101,
      projectId: 'a'.repeat(64),
      issuer: 'GBJ7V4JHYC52O2ZNDH6WGB7E6R3YGY6YAM7G7R2EQ6V32J4K47U65C5G',
      faceValue: '1000000000',
      maturityTimestamp: 1767225600,
    },
  };
  const valResult1 = validateCrossServiceEvent(validBondIssued);
  assert.equal(valResult1.valid, true, `Validation failed unexpectedly: ${valResult1.errors.join(', ')}`);
  console.log('  ✓ bond.issued valid payload passed');

  const validOracleReport = {
    eventName: 'oracle.report_submitted',
    schemaVersion: '1.1.0',
    producer: 'oracle:DataFeeder',
    timestamp: '2026-01-01T00:00:00.000Z',
    payload: {
      reportId: 5001,
      provider: 'GBJ7V4JHYC52O2ZNDH6WGB7E6R3YGY6YAM7G7R2EQ6V32J4K47U65C5G',
      projectId: 'b'.repeat(64),
      satelliteDataHash: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
      carbonTonsCalculated: 1250.75,
    },
  };
  const valResult2 = validateCrossServiceEvent(validOracleReport);
  assert.equal(valResult2.valid, true, `Oracle report validation failed: ${valResult2.errors.join(', ')}`);
  console.log('  ✓ oracle.report_submitted valid payload passed');

  console.log('\n[3/5] Testing negative validation guards (missing fields, wrong types, version mismatch)...');
  // Missing required field
  const missingFieldEvent = {
    ...validBondIssued,
    payload: { bondId: 101 }, // Missing projectId, issuer, faceValue, maturityTimestamp
  };
  const missingVal = validateCrossServiceEvent(missingFieldEvent);
  assert.equal(missingVal.valid, false);
  assert.ok(missingVal.errors.some(e => e.includes('Missing required field "projectId"')));
  console.log(`  ✓ Caught missing required fields (${missingVal.errors.length} errors flagged)`);

  // Producer mismatch
  const wrongProducerEvent = {
    ...validBondIssued,
    producer: 'api:SettlementService', // invalid producer for bond.issued
  };
  const producerVal = validateCrossServiceEvent(wrongProducerEvent);
  assert.equal(producerVal.valid, false);
  assert.ok(producerVal.errors.some(e => e.includes('Producer mismatch')));
  console.log('  ✓ Caught producer mismatch violation');

  // Incompatible major version
  const badVersionEvent = {
    ...validBondIssued,
    schemaVersion: '2.0.0', // requires 1.x
  };
  const versionVal = validateCrossServiceEvent(badVersionEvent);
  assert.equal(versionVal.valid, false);
  assert.ok(versionVal.errors.some(e => e.includes('Incompatible schema version')));
  console.log('  ✓ Caught incompatible major schema version bump');

  // Malformed Stellar address
  const badAddressEvent = {
    ...validBondIssued,
    payload: {
      ...validBondIssued.payload,
      issuer: 'INVALID_STELLAR_ADDRESS',
    },
  };
  const addrVal = validateCrossServiceEvent(badAddressEvent);
  assert.equal(addrVal.valid, false);
  assert.ok(addrVal.errors.some(e => e.includes('Stellar public address')));
  console.log('  ✓ Caught malformed Stellar public key');

  console.log('\n[4/5] Testing producer and consumer query indexes...');
  const bondIssuerContracts = getContractsByProducer('contract:BondIssuer');
  assert.ok(bondIssuerContracts.length >= 2);
  console.log(`  ✓ getContractsByProducer('contract:BondIssuer') found ${bondIssuerContracts.length} contracts`);

  const ledgerConsumedContracts = getContractsByConsumer('api:EventLedger');
  assert.ok(ledgerConsumedContracts.length >= 4);
  console.log(`  ✓ getContractsByConsumer('api:EventLedger') found ${ledgerConsumedContracts.length} subscribed contracts`);

  console.log('\n[5/5] Checking allowed failure behaviors on critical financial vs telemetry contracts...');
  assert.equal(CROSS_SERVICE_CONTRACT_MAP['order.filled'].allowedFailureBehavior, 'fail-closed');
  assert.equal(CROSS_SERVICE_CONTRACT_MAP['oracle.provider_slashed'].allowedFailureBehavior, 'fail-closed');
  assert.equal(CROSS_SERVICE_CONTRACT_MAP['coupon.distributed'].allowedFailureBehavior, 'dead-letter-retry');
  assert.equal(CROSS_SERVICE_CONTRACT_MAP['oracle.report_submitted'].allowedFailureBehavior, 'circuit-breaker-pause');
  console.log('  ✓ Failure behavior invariants verified');

  console.log('\n===============================================================');
  console.log('ALL CROSS-SERVICE CONTRACT MAP TESTS PASSED! (Issue #368)');
  console.log('===============================================================');
}

try {
  main();
} catch (err) {
  console.error('Cross-service contract verification failed:', err);
  process.exit(1);
}
