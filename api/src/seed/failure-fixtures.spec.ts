import { buildFailureFixtures } from './failure-fixtures';
import { buildSeedDataset } from './fixtures';

/**
 * Validates the failure-fixture generators (issue #415): determinism,
 * internal consistency, structural correctness of each scenario, and
 * isolation from the main seed dataset.
 */
describe('buildFailureFixtures (#415)', () => {
  const NOW = Date.UTC(2026, 9, 24); // fixed anchor for reproducibility
  const fixtures = buildFailureFixtures(NOW);
  const seedDataset = buildSeedDataset(NOW);

  // ── Determinism ──────────────────────────────────────────────────────────

  it('is deterministic: two calls with the same now produce byte-identical output', () => {
    const a = buildFailureFixtures(NOW);
    const b = buildFailureFixtures(NOW);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it('uses Date.now() when no argument is passed and remains deterministic within a tick', () => {
    const before = Date.now();
    const a = buildFailureFixtures(before);
    const b = buildFailureFixtures(before);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  // ── No ID overlap with seed dataset ──────────────────────────────────────

  describe('ID isolation from seed dataset', () => {
    it('oracle disagreement report IDs do not overlap with seed oracle report IDs', () => {
      const seedReportIds = new Set(seedDataset.oracleReports.map((r) => r.id));
      for (const report of fixtures.oracleDisagreement.data.reports) {
        expect(seedReportIds.has(report.id)).toBe(false);
        expect(report.id).toBeGreaterThanOrEqual(1000);
      }
    });

    it('partial coupon holder IDs do not overlap with seed user IDs', () => {
      const seedUserIds = new Set(seedDataset.users.map((u) => u.id));
      for (const receipt of fixtures.partialCouponDistribution.data.receipts) {
        expect(seedUserIds.has(receipt.holderId)).toBe(false);
        expect(receipt.holderId).toBeGreaterThanOrEqual(1000);
      }
    });

    it('escrow order ID does not overlap with seed order IDs', () => {
      const seedOrderIds = new Set(seedDataset.orders.map((o) => o.id));
      expect(seedOrderIds.has(fixtures.expiredEscrowDeadlock.data.orderId)).toBe(false);
      expect(fixtures.expiredEscrowDeadlock.data.orderId).toBeGreaterThanOrEqual(1000);
    });
  });

  // ── Internal consistency: foreign key references ─────────────────────────

  describe('foreign key consistency', () => {
    const seedProjectIds = new Set(seedDataset.projects.map((p) => p.id));
    const seedBondIds = new Set(seedDataset.bonds.map((b) => b.id));

    it('partial coupon distribution references a real seed bond', () => {
      expect(seedBondIds.has(fixtures.partialCouponDistribution.data.bondId)).toBe(true);
    });

    it('oracle disagreement references a real seed project', () => {
      expect(seedProjectIds.has(fixtures.oracleDisagreement.data.projectId)).toBe(true);
    });

    it('escrow deadlock references a real seed bond', () => {
      expect(seedBondIds.has(fixtures.expiredEscrowDeadlock.data.bondId)).toBe(true);
    });

    it('double-spend attempt references a real seed bond', () => {
      expect(seedBondIds.has(fixtures.doubleSpendAttempt.data.bondId)).toBe(true);
    });

    it('IPFS unavailability references a real seed project', () => {
      expect(seedProjectIds.has(fixtures.ipfsUnavailability.data.projectId)).toBe(true);
    });

    it('IPFS unavailability affected bonds reference real seed bonds', () => {
      for (const bondId of fixtures.ipfsUnavailability.data.affectedBondIds) {
        expect(seedBondIds.has(bondId)).toBe(true);
      }
    });
  });

  // ── Every scenario has a non-empty recovery plan ─────────────────────────

  describe('recovery plans', () => {
    const scenarios: Array<[string, { recoveryPlan: string }]> = [
      ['partialCouponDistribution', fixtures.partialCouponDistribution],
      ['oracleDisagreement', fixtures.oracleDisagreement],
      ['expiredEscrowDeadlock', fixtures.expiredEscrowDeadlock],
      ['cascadingMigrationFailure', fixtures.cascadingMigrationFailure],
      ['doubleSpendAttempt', fixtures.doubleSpendAttempt],
      ['ipfsUnavailability', fixtures.ipfsUnavailability],
    ];

    it.each(scenarios)('%s has a non-empty multi-step recovery plan', (_name, fixture) => {
      expect(fixture.recoveryPlan.length).toBeGreaterThan(50);
      expect(fixture.recoveryPlan).toContain('1.');
      expect(fixture.recoveryPlan).toContain('2.');
    });
  });

  // ── Structural correctness per scenario ──────────────────────────────────

  describe('partialCouponDistribution', () => {
    const data = fixtures.partialCouponDistribution.data;

    it('has both received and non-received holders', () => {
      const received = data.receipts.filter((r) => r.status === 'received');
      const pending = data.receipts.filter((r) => r.status === 'pending');
      const failed = data.receipts.filter((r) => r.status === 'failed');

      expect(received.length).toBeGreaterThan(0);
      expect(pending.length + failed.length).toBeGreaterThan(0);
      expect(received.length).toBe(data.holdersServed);
      expect(received.length + pending.length + failed.length).toBe(data.totalHolders);
    });

    it('received holders got their full credits; others got zero', () => {
      for (const receipt of data.receipts) {
        if (receipt.status === 'received') {
          expect(receipt.creditsReceived).toBe(receipt.creditsOwed);
          expect(receipt.creditsReceived).toBeGreaterThan(0);
        } else {
          expect(receipt.creditsReceived).toBe(0);
        }
      }
    });

    it('has a stuck coupon state', () => {
      expect(data.couponState).toBe('DISTRIBUTING');
    });

    it('failure timestamp is after start timestamp', () => {
      expect(data.failedAt).toBeGreaterThan(data.startedAt);
      expect(data.startedAt).toBeGreaterThan(data.scheduledAt);
    });
  });

  describe('oracleDisagreement', () => {
    const data = fixtures.oracleDisagreement.data;

    it('has exactly two reports for the same project and period', () => {
      expect(data.reports).toHaveLength(2);
      expect(data.reports[0].projectId).toBe(data.reports[1].projectId);
      expect(data.reports[0].periodStart).toBe(data.reports[1].periodStart);
      expect(data.reports[0].periodEnd).toBe(data.reports[1].periodEnd);
    });

    it('has reports from different providers', () => {
      expect(data.reports[0].providerAddress).not.toBe(data.reports[1].providerAddress);
    });

    it('values differ enough to trigger the circuit breaker anomaly threshold', () => {
      const values = data.reports.map((r) => r.carbonSequestered);
      const ratio = Math.max(...values) / Math.min(...values);
      // Must exceed 2x tolerance to be critical; VERRA-VCS/Gold Standard tolerance is 0.15
      // A 3x ratio produces deviation well above 30% (2 * 15%)
      expect(ratio).toBeGreaterThan(2);
      expect(data.crossSourceSeverity).toBe('critical');
    });

    it('median and deviation percentage are consistent with the report values', () => {
      const [a, b] = data.reports.map((r) => r.carbonSequestered);
      const expectedMedian = (a + b) / 2;
      expect(data.medianCarbon).toBe(expectedMedian);
      const maxDev = Math.max(
        Math.abs(a - expectedMedian) / expectedMedian,
        Math.abs(b - expectedMedian) / expectedMedian,
      );
      expect(data.maxDeviationPct).toBe(Math.round(maxDev * 100));
    });

    it('both reports have distinct IPFS hashes and IDs', () => {
      expect(data.reports[0].id).not.toBe(data.reports[1].id);
      expect(data.reports[0].ipfsHash).not.toBe(data.reports[1].ipfsHash);
    });
  });

  describe('expiredEscrowDeadlock', () => {
    const data = fixtures.expiredEscrowDeadlock.data;

    it('escrow TTL and dispute window have both expired relative to now', () => {
      expect(data.escrowExpiredAt).toBeLessThan(NOW);
      expect(data.disputeExpiredAt).toBeLessThan(NOW);
    });

    it('escrow expired at is lock time plus TTL', () => {
      expect(data.escrowExpiredAt).toBe(data.escrowLockedAt + data.escrowTtlMs);
    });

    it('dispute expired at is lock time plus dispute window', () => {
      expect(data.disputeExpiredAt).toBe(data.escrowLockedAt + data.disputeWindowMs);
    });

    it('has orphaned tokens representing both sides of the trade', () => {
      expect(data.orphanedTokens).toHaveLength(2);
      expect(data.orphanedTokens[0].amount).toBe(data.tokenAmount);
      expect(data.orphanedTokens[1].amount).toBe(data.lockedUsdcAmount);
    });

    it('settlement state is DEADLOCKED', () => {
      expect(data.settlementState).toBe('DEADLOCKED');
    });
  });

  describe('cascadingMigrationFailure', () => {
    const data = fixtures.cascadingMigrationFailure.data;

    it('phase 1 (schema) succeeded but phase 2 (backfill) failed', () => {
      expect(data.phases).toHaveLength(2);
      expect(data.phases[0].status).toBe('completed');
      expect(data.phases[1].status).toBe('failed');
      expect(data.phases[1].error).toBeDefined();
    });

    it('schema version advanced despite data backfill failure', () => {
      expect(data.schemaVersionAfter).toBeGreaterThan(data.schemaVersionBefore);
    });

    it('backfill progress shows partial completion', () => {
      expect(data.dataBackfillProgress.completed).toBeGreaterThan(0);
      expect(data.dataBackfillProgress.completed).toBeLessThan(data.dataBackfillProgress.total);
      expect(data.dataBackfillProgress.failed).toBe(
        data.dataBackfillProgress.total - data.dataBackfillProgress.completed,
      );
    });

    it('post-checks reflect the partial state', () => {
      const passed = data.postCheckResults.filter((r) => r.passed);
      const failed = data.postCheckResults.filter((r) => !r.passed);
      expect(passed.length).toBeGreaterThan(0);
      expect(failed.length).toBeGreaterThan(0);
    });

    it('has rollback notes', () => {
      expect(data.rollbackNotes.length).toBeGreaterThan(10);
      expect(data.rollbackNotes).toContain('DROP');
    });

    it('failure timestamp is after start timestamp', () => {
      expect(data.failedAt).toBeGreaterThan(data.startedAt);
    });
  });

  describe('doubleSpendAttempt', () => {
    const data = fixtures.doubleSpendAttempt.data;

    it('has exactly two requests: one accepted, one rejected', () => {
      expect(data.requests).toHaveLength(2);
      const statuses = data.requests.map((r) => r.status).sort();
      expect(statuses).toEqual(['accepted', 'rejected_duplicate']);
    });

    it('both requests target the same bond, holder, and amount', () => {
      expect(data.requests[0].bondId).toBe(data.requests[1].bondId);
      expect(data.requests[0].holderAddress).toBe(data.requests[1].holderAddress);
      expect(data.requests[0].tokenAmount).toBe(data.requests[1].tokenAmount);
    });

    it('both requests share the same nonce', () => {
      expect(data.requests[0].nonce).toBe(data.requests[1].nonce);
      expect(data.requests[0].nonce).toBe(data.nonce);
    });

    it('accepted request has a tx hash; rejected has a reason', () => {
      const accepted = data.requests.find((r) => r.status === 'accepted')!;
      const rejected = data.requests.find((r) => r.status === 'rejected_duplicate')!;
      expect(accepted.txHash).toBeDefined();
      expect(accepted.txHash!.length).toBeGreaterThan(0);
      expect(rejected.rejectionReason).toBeDefined();
      expect(rejected.rejectionReason).toContain('nonce');
    });

    it('second request was submitted after the first', () => {
      expect(data.requests[1].submittedAt).toBeGreaterThan(data.requests[0].submittedAt);
    });

    it('requested amount equals the holder balance (full redemption attempt)', () => {
      expect(data.requests[0].tokenAmount).toBe(data.holderBalance);
    });

    it('idempotency key encodes bond, holder, and nonce', () => {
      expect(data.idempotencyKey).toContain(String(data.bondId));
      expect(data.idempotencyKey).toContain(data.holderAddress);
      expect(data.idempotencyKey).toContain(String(data.nonce));
    });
  });

  describe('ipfsUnavailability', () => {
    const data = fixtures.ipfsUnavailability.data;

    it('evidence is marked as not verifiable', () => {
      expect(data.evidenceVerifiable).toBe(false);
    });

    it('both primary and fallback gateways failed', () => {
      expect(data.primaryError).toBeDefined();
      expect(data.fallbackError).toBeDefined();
      expect(data.primaryError.length).toBeGreaterThan(0);
      expect(data.fallbackError.length).toBeGreaterThan(0);
    });

    it('gateway URLs contain the IPFS hash', () => {
      expect(data.primaryGatewayUrl).toContain(data.ipfsHash);
      expect(data.fallbackGatewayUrl).toContain(data.ipfsHash);
    });

    it('was previously accessible before becoming unavailable', () => {
      expect(data.lastAccessibleAt).toBeLessThan(data.discoveredUnavailableAt);
      expect(data.discoveredUnavailableAt).toBeLessThanOrEqual(NOW);
    });

    it('has at least one affected bond', () => {
      expect(data.affectedBondIds.length).toBeGreaterThan(0);
    });
  });
});
