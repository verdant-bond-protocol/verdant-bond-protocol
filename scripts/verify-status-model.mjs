#!/usr/bin/env node
/**
 * Executable verification script for Issue #370:
 * Safe Public-Status Model for degraded, paused, or maintenance states.
 */

import {
  StatusSafeguardsManager,
  redactSecretsFromText,
  redactSecretsDeep,
} from '../api/src/status/status-safeguards.ts';
import { StatusError } from '../api/src/status/status.interface.ts';

import assert from 'node:assert/strict';

function makeMockReport(manager, now, opts = {}) {
  const baseComponents = opts.baseComponents || [
    { name: 'cache', status: 'operational', description: 'Shared cache backing list and detail reads.' },
  ];
  const incidents = opts.incidents || [];
  const maintenanceWindows = opts.maintenanceWindows || [];
  return manager.buildPublicReport({ now, baseComponents, incidents, maintenanceWindows });
}

function main() {
  console.log('===============================================================');
  console.log('VERDANT BOND PROTOCOL: SAFE PUBLIC-STATUS MODEL VERIFICATION');
  console.log('===============================================================');

  const manager = new StatusSafeguardsManager();
  const now = Date.parse('2026-01-01T00:00:00.000Z');

  // Test 1: Baseline Healthy State
  console.log('\n[1/6] Verifying baseline healthy state...');
  const healthyReport = makeMockReport(manager, now);
  assert.equal(healthyReport.schemaVersion, 1);
  assert.equal(healthyReport.overallStatus, 'healthy');
  assert.equal(healthyReport.isMutationAllowed, true);
  assert.equal(healthyReport.components[0].status, 'operational');
  console.log('  ✓ Baseline report is healthy with mutations allowed');

  // Test 2: Degraded Component State
  console.log('\n[2/6] Verifying component degradation...');
  manager.setComponentStatus('oracle-monitoring', 'degraded', 'Telemetry provider reporting intermittent packet latency');
  const degradedReport = makeMockReport(manager, now);
  assert.equal(degradedReport.overallStatus, 'degraded');
  const oracleComp = degradedReport.components.find(c => c.name === 'oracle-monitoring');
  assert.ok(oracleComp);
  assert.equal(oracleComp.status, 'degraded');
  console.log('  ✓ System transitioned to degraded without halting healthy components');

  // Test 3: Emergency Protocol Pause State
  console.log('\n[3/6] Verifying emergency protocol pause state...');
  manager.pauseProtocol('Emergency circuit breaker tripped for smart contract audit check', 'GADMIN_EMERGENCY');
  const pausedReport = makeMockReport(manager, now);
  assert.equal(pausedReport.overallStatus, 'paused');
  assert.equal(pausedReport.isMutationAllowed, false);
  console.log('  ✓ Overall status updated to "paused" and mutations flagged false');

  // Test 4: Operational Mutation Safeguard Enforcement
  console.log('\n[4/6] Verifying mutation safeguards (assertMutationAllowed)...');
  assert.throws(
    () => manager.assertMutationAllowed('bond-issuance'),
    (err) => err instanceof StatusError && err.code === 'protocol_paused',
    'Must block mutations when protocol is paused',
  );
  console.log('  ✓ Successfully blocked mutation with "protocol_paused" code');

  // Resume protocol and verify component-specific pause
  manager.resumeProtocol('GADMIN_EMERGENCY');
  assert.equal(manager.isProtocolPaused(), false);
  manager.setComponentStatus('bond-issuance', 'paused', 'New bond series validation in progress');

  assert.throws(
    () => manager.assertMutationAllowed('bond-issuance'),
    (err) => err instanceof StatusError && err.code === 'protocol_paused',
    'Must block mutations for specifically paused component',
  );
  // Independent component remains unblocked
  manager.assertMutationAllowed('dex-settlement');
  console.log('  ✓ Granular per-component mutation gate functioning properly');

  // Test 5: Scheduled Maintenance State
  console.log('\n[5/6] Verifying maintenance state transition...');
  manager.clearComponentOverride('bond-issuance');
  manager.clearComponentOverride('oracle-monitoring');

  const maintReport = makeMockReport(manager, now, {
    maintenanceWindows: [
      {
        id: 'window-1',
        title: 'Core Database Index Optimization',
        status: 'in_progress',
        startsAt: new Date(now - 1000).toISOString(),
        endsAt: new Date(now + 3600000).toISOString(),
      },
    ],
  });
  assert.equal(maintReport.overallStatus, 'maintenance');
  assert.equal(maintReport.maintenanceWindows[0].status, 'in_progress');
  console.log('  ✓ Maintenance window correctly drove overall status to "maintenance"');

  // Test 6: Deep Secret Redaction Guarantees
  console.log('\n[6/6] Verifying zero-leak secret redaction...');
  const textWithSecrets =
    'Incident reported on node 10.0.4.12:5432 using postgres://admin:SuperSecretPass123!@192.168.1.50:5432/verdantdb. ' +
    'Signer seed: SA2B3C4D5E6F7G8H9I0J1K2L3M4N5O6P7Q8R9S0T1U2V3W4X5Y6Z7A8B. ' +
    'Auth token: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-IDNbuFcO0LCGenFAMjwtB42KOehSFi54ajBXjuqkc. ' +
    'Local path: /var/verdant/api/secrets/private_key.pem';

  const redacted = redactSecretsFromText(textWithSecrets);
  assert.ok(!redacted.includes('SuperSecretPass123!'), 'Database password must not leak');
  assert.ok(!redacted.includes('10.0.4.12'), 'Internal IP address must not leak');
  assert.ok(!redacted.includes('192.168.1.50'), 'Database IP address must not leak');
  assert.ok(!redacted.includes('SA2B3C4D5E6F7G8H9I0J1K2L3M4N5O6P7Q8R9S0T1U2V3W4X5Y6Z7A8B'), 'Stellar seed must not leak');
  assert.ok(!redacted.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'), 'JWT token must not leak');
  assert.ok(!redacted.includes('private_key.pem'), 'File path must not leak');

  // Also verify that setting an operator notice with secrets gets sanitized
  manager.setComponentStatus(
    'dex-settlement',
    'degraded',
    'Settlement connection refused at 10.10.1.20:5432 with secret postgres://user:secretpw@10.10.1.20/db',
  );
  const safeReport = makeMockReport(manager, now);
  const serialized = JSON.stringify(safeReport);
  assert.ok(!serialized.includes('secretpw'));
  assert.ok(!serialized.includes('10.10.1.20'));
  console.log('  ✓ Redaction engine successfully eliminated all credentials, IPs, seeds, and paths');

  console.log('\n===============================================================');
  console.log('ALL SAFE PUBLIC-STATUS TESTS PASSED! (Issue #370)');
  console.log('===============================================================');
}

try {
  main();
} catch (err) {
  console.error('Public-status model verification failed:', err);
  process.exit(1);
}
