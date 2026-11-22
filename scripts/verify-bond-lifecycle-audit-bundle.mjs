#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  BOND_LIFECYCLE_PATHS,
  BOND_LIFECYCLE_STAGES,
  buildBondLifecycleBundle,
  verifyBondLifecycleBundle,
} from '../api/src/audit/bond-lifecycle-bundle-core.ts';

const DIGEST = 'a'.repeat(64);
const AS_OF = '2026-11-22T00:00:00.000Z';

const makeEvent = (stage, path, action, overrides = {}) => ({
  stage,
  path,
  action,
  outcome: path === 'failure' ? 'rejected' : 'applied',
  dedupeKey: action,
  actorDigest: DIGEST,
  ...overrides,
});

const fixture = () => ({
  bondId: 640,
  caseId: 'AUD-640',
  asOf: AS_OF,
  generatedByDigest: DIGEST,
  events: [
    makeEvent('issue', 'normal', 'issued'),
    makeEvent('subscribe', 'normal', 'subscribed'),
    makeEvent('coupon', 'normal', 'coupon-distributed'),
    makeEvent('redeem', 'normal', 'redeemed'),
    makeEvent('redeem', 'failure', 'underfunded'),
    makeEvent('redeem', 'retry', 'reconciled'),
    makeEvent('issue', 'authorization', 'admin-only'),
  ],
  financialState: {
    totalSupplyMinor: '1000000',
    totalSubscribedMinor: '1000000',
    holderBalancesMinor: ['600000', '400000'],
    redemptionAmountsMinor: ['1000000'],
    faceValueMinor: '100',
  },
  sourceChain: {
    entityType: 'bond',
    entityId: '640',
    chainHead: DIGEST,
    verification: { ok: true, checkedEntries: 7, failures: [] },
  },
  rawExport: {
    checksum: DIGEST,
    counts: { lifecycleEvents: 2, holders: 2, couponDistributions: 1, retirements: 1 },
  },
  redactions: [
    { path: 'generatedByDigest', rule: 'actor' },
    { path: 'events[*].actorDigest', rule: 'actor' },
  ],
});

function verifyAndExpectProblem(bundle, expected) {
  const result = verifyBondLifecycleBundle(bundle);
  assert.equal(result.ok, false, `expected verification to fail with: ${expected}`);
  assert.ok(result.problems.some((problem) => problem.includes(expected)), result.problems.join('\n'));
}

console.log('========================================================================');
console.log(' VERDANT BOND PROTOCOL: BOND LIFECYCLE AUDIT BUNDLE VERIFICATION (#640)');
console.log('========================================================================');

const first = buildBondLifecycleBundle(fixture());
const reordered = fixture();
reordered.events = [...reordered.events].reverse();
const second = buildBondLifecycleBundle(reordered);

console.log('\n[1] Reproducibility');
assert.deepEqual(second, first, 'event order must not affect the bundle');
assert.match(first.bundleId, /^blb-[0-9a-f]{64}$/);
assert.match(first.digest, /^[0-9a-f]{64}$/);
console.log(`  OK deterministic bundle ${first.bundleId}`);
console.log(`  OK digest ${first.digest}`);

console.log('\n[2] Lifecycle stage and operational path coverage');
for (const stage of BOND_LIFECYCLE_STAGES) {
  assert.ok(first.stages[stage].count > 0, `missing stage ${stage}`);
}
for (const path of BOND_LIFECYCLE_PATHS) {
  assert.ok(first.paths[path].count > 0, `missing path ${path}`);
}
assert.deepEqual(verifyBondLifecycleBundle(first), { ok: true, problems: [] });
console.log(`  OK ${BOND_LIFECYCLE_STAGES.length} stages and ${BOND_LIFECYCLE_PATHS.length} paths`);

console.log('\n[3] Financial invariants');
for (const invariant of first.financialInvariants) {
  assert.equal(invariant.ok, true, `${invariant.id}: ${invariant.detail}`);
}
console.log(`  OK ${first.financialInvariants.length} invariants with bigint arithmetic`);

console.log('\n[4] Tamper and integrity detection');
const edited = structuredClone(first);
edited.lifecycle.events[0].detail = 'edited-after-export';
verifyAndExpectProblem(edited, 'bundle digest mismatch');
console.log('  OK post-export edit detected');

const brokenChain = buildBondLifecycleBundle(fixture());
brokenChain.lifecycle.events[2].previousEventId = 'f'.repeat(64);
verifyAndExpectProblem(brokenChain, 'does not link');
console.log('  OK broken event chain detected');

const badSource = fixture();
badSource.sourceChain.verification.ok = false;
verifyAndExpectProblem(buildBondLifecycleBundle(badSource), 'source chain failed verification');
console.log('  OK failed source verification detected');

const incomplete = fixture();
incomplete.events = incomplete.events.filter((item) => item.path !== 'authorization');
verifyAndExpectProblem(buildBondLifecycleBundle(incomplete), 'missing lifecycle path: authorization');
console.log('  OK incomplete path coverage detected');

const brokenMoney = fixture();
brokenMoney.financialState.holderBalancesMinor = ['999999'];
verifyAndExpectProblem(buildBondLifecycleBundle(brokenMoney), 'INV-02');
console.log('  OK holder conservation violation detected');

const failedApply = fixture();
failedApply.events = failedApply.events.map((item) =>
  item.path === 'failure' ? { ...item, outcome: 'applied' } : item,
);
verifyAndExpectProblem(buildBondLifecycleBundle(failedApply), 'INV-05');
console.log('  OK applied failure-path event detected');

const leaked = fixture();
leaked.events = leaked.events.map((item) =>
  item.action === 'issued' ? { ...item, detail: 'alice@example.com' } : item,
);
verifyAndExpectProblem(buildBondLifecycleBundle(leaked), 'possible unredacted value');
console.log('  OK unredacted PII detected');

assert.throws(() => buildBondLifecycleBundle({ ...fixture(), asOf: 'not-a-date' }), /ISO-8601/);
assert.throws(() => buildBondLifecycleBundle({ ...fixture(), caseId: '' }), /caseId/);
console.log('  OK malformed inputs rejected');

console.log('\n========================================================================');
console.log(' ALL BOND LIFECYCLE AUDIT BUNDLE CHECKS PASSED (#640)');
console.log('========================================================================\n');
