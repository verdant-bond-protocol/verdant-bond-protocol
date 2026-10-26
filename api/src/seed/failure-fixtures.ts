/**
 * Deterministic failure & recovery fixture generators (issue #415).
 *
 * Companion to `fixtures.ts`: where the seed dataset covers the normal
 * lifecycle, these fixtures model the rare failure modes that incident
 * drills, chaos tests, and recovery runbooks need to exercise.
 *
 * Same contract as the seed fixtures:
 *   - Pure function, no NestJS or I/O dependencies.
 *   - Deterministic: same `now` → byte-identical output.
 *   - IDs start at 1000 to avoid collisions with the seed dataset.
 *   - Timestamps derive from `now` so relative ordering is always valid.
 */

const DAY = 86_400_000;
const HOUR = 3_600_000;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function wallet(i: number): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ234567';
  let x = (i + 1) * 2654435761;
  let out = 'G';
  for (let k = 0; k < 55; k++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out += chars[(x >>> 0) % chars.length];
  }
  return out;
}

// ── Generic wrapper ────────────────────────────────────────────────────────

export interface FailureFixture<T> {
  scenario: string;
  data: T;
  recoveryPlan: string;
  createdAt: number;
}

// ── 1. Partial coupon distribution ─────────────────────────────────────────

export interface CouponReceipt {
  holderId: number;
  holderAddress: string;
  bondId: number;
  creditsOwed: number;
  creditsReceived: number;
  status: 'received' | 'pending' | 'failed';
}

export interface PartialCouponDistributionData {
  bondId: number;
  couponCycleId: string;
  scheduledAt: number;
  startedAt: number;
  failedAt: number;
  totalHolders: number;
  holdersServed: number;
  holdersPending: number;
  receipts: CouponReceipt[];
  errorMessage: string;
  couponState: 'DISTRIBUTING';
}

// ── 2. Oracle disagreement ─────────────────────────────────────────────────

export interface DisagreeingOracleReport {
  id: number;
  projectId: number;
  periodStart: number;
  periodEnd: number;
  carbonSequestered: number;
  methodology: string;
  ipfsHash: string;
  providerAddress: number;
  status: 'Verified';
  createdAt: number;
  verifiedAt: number;
}

export interface OracleDisagreementData {
  projectId: number;
  periodStart: number;
  periodEnd: number;
  reports: [DisagreeingOracleReport, DisagreeingOracleReport];
  crossSourceSeverity: 'critical';
  medianCarbon: number;
  maxDeviationPct: number;
}

// ── 3. Expired escrow deadlock ─────────────────────────────────────────────

export interface ExpiredEscrowDeadlockData {
  orderId: number;
  sellerId: number;
  buyerId: number;
  bondId: number;
  tokenAmount: number;
  lockedUsdcAmount: number;
  escrowLockedAt: number;
  escrowTtlMs: number;
  escrowExpiredAt: number;
  disputeWindowMs: number;
  disputeExpiredAt: number;
  settlementState: 'DEADLOCKED';
  orphanedTokens: { holder: string; amount: number }[];
}

// ── 4. Cascading migration failure ─────────────────────────────────────────

export interface MigrationPhaseResult {
  phase: string;
  status: 'completed' | 'failed';
  affectedRows?: number;
  error?: string;
}

export interface CascadingMigrationFailureData {
  migrationId: string;
  description: string;
  startedAt: number;
  failedAt: number;
  phases: MigrationPhaseResult[];
  postCheckResults: Array<{ name: string; passed: boolean; detail?: string }>;
  rollbackNotes: string;
  schemaVersionBefore: number;
  schemaVersionAfter: number;
  dataBackfillProgress: { total: number; completed: number; failed: number };
}

// ── 5. Double-spend attempt ────────────────────────────────────────────────

export interface RedemptionRequest {
  requestId: string;
  bondId: number;
  holderAddress: string;
  tokenAmount: number;
  nonce: number;
  submittedAt: number;
  status: 'accepted' | 'rejected_duplicate';
  txHash?: string;
  rejectionReason?: string;
}

export interface DoubleSpendAttemptData {
  bondId: number;
  holderAddress: string;
  holderBalance: number;
  requests: [RedemptionRequest, RedemptionRequest];
  idempotencyKey: string;
  nonce: number;
}

// ── 6. IPFS unavailability ─────────────────────────────────────────────────

export interface IpfsUnavailabilityData {
  documentId: number;
  projectId: number;
  ipfsHash: string;
  primaryGatewayUrl: string;
  fallbackGatewayUrl: string;
  primaryError: string;
  fallbackError: string;
  lastAccessibleAt: number;
  discoveredUnavailableAt: number;
  affectedBondIds: number[];
  evidenceVerifiable: false;
}

// ── Aggregate ──────────────────────────────────────────────────────────────

export interface FailureFixtureSet {
  partialCouponDistribution: FailureFixture<PartialCouponDistributionData>;
  oracleDisagreement: FailureFixture<OracleDisagreementData>;
  expiredEscrowDeadlock: FailureFixture<ExpiredEscrowDeadlockData>;
  cascadingMigrationFailure: FailureFixture<CascadingMigrationFailureData>;
  doubleSpendAttempt: FailureFixture<DoubleSpendAttemptData>;
  ipfsUnavailability: FailureFixture<IpfsUnavailabilityData>;
}

/**
 * Build the full deterministic failure-fixture set.
 *
 * Every scenario uses IDs ≥ 1000 and references existing seed-dataset
 * project/bond IDs (1-9) where cross-referencing is needed.
 */
export function buildFailureFixtures(now: number = Date.now()): FailureFixtureSet {
  const rand = mulberry32(20261024);

  // ── 1. Partial coupon distribution ───────────────────────────────────────
  const couponBondId = 1; // Amazon Reforestation Bond from seed dataset
  const totalHolders = 8;
  const holdersServed = 3;
  const receipts: CouponReceipt[] = [];
  for (let i = 0; i < totalHolders; i++) {
    const creditsOwed = Math.round(650 + rand() * 200);
    const served = i < holdersServed;
    receipts.push({
      holderId: 1000 + i,
      holderAddress: wallet(100 + i),
      bondId: couponBondId,
      creditsOwed,
      creditsReceived: served ? creditsOwed : 0,
      status: served ? 'received' : (i === holdersServed ? 'failed' : 'pending'),
    });
  }

  const partialCouponDistribution: FailureFixture<PartialCouponDistributionData> = {
    scenario: 'partial_coupon_distribution',
    createdAt: now,
    recoveryPlan:
      '1. Pause further distribution attempts for this coupon cycle.\n' +
      '2. Query on-chain coupon-engine state to confirm which holders received credits.\n' +
      '3. For each holder with status "pending" or "failed", resubmit distribute_coupon with the original cycle nonce.\n' +
      '4. Run post-distribution reconciliation: sum of all creditsReceived must equal the oracle-verified carbon pool.\n' +
      '5. If reconciliation fails, escalate to governance for manual credit adjustment.\n' +
      '6. Resume normal coupon scheduling only after all receipts show status "received".',
    data: {
      bondId: couponBondId,
      couponCycleId: 'cycle-2026-Q3-BOND-1',
      scheduledAt: now - DAY * 2,
      startedAt: now - DAY * 2 + HOUR,
      failedAt: now - DAY * 2 + HOUR * 2,
      totalHolders,
      holdersServed,
      holdersPending: totalHolders - holdersServed,
      receipts,
      errorMessage: 'Transaction submission failed: Stellar Horizon 504 gateway timeout after holder 3/8',
      couponState: 'DISTRIBUTING',
    },
  };

  // ── 2. Oracle disagreement ───────────────────────────────────────────────
  const oracleProjectId = 4; // Niger Agroforestry from seed dataset
  const periodStart = now - DAY * 60;
  const periodEnd = now - DAY * 30;
  const reportA: DisagreeingOracleReport = {
    id: 1001,
    projectId: oracleProjectId,
    periodStart,
    periodEnd,
    carbonSequestered: 2100,
    methodology: 'Gold Standard',
    ipfsHash: 'QmFailRptA1001',
    providerAddress: 4,
    status: 'Verified',
    createdAt: periodEnd + DAY,
    verifiedAt: periodEnd + DAY * 2,
  };
  const reportB: DisagreeingOracleReport = {
    id: 1002,
    projectId: oracleProjectId,
    periodStart,
    periodEnd,
    carbonSequestered: 6500, // ~3.1x the other report
    methodology: 'Gold Standard',
    ipfsHash: 'QmFailRptB1002',
    providerAddress: 5, // different provider
    status: 'Verified',
    createdAt: periodEnd + DAY,
    verifiedAt: periodEnd + DAY * 2,
  };
  const medianCarbon = (reportA.carbonSequestered + reportB.carbonSequestered) / 2;
  const maxDeviation = Math.abs(reportB.carbonSequestered - medianCarbon) / medianCarbon;

  const oracleDisagreement: FailureFixture<OracleDisagreementData> = {
    scenario: 'oracle_disagreement',
    createdAt: now,
    recoveryPlan:
      '1. Circuit breaker auto-triggers a scoped pause on project coupon distribution.\n' +
      '2. Notify both oracle providers of the discrepancy and request re-submission with raw evidence.\n' +
      '3. Retrieve IPFS-pinned satellite imagery and IoT telemetry for independent verification.\n' +
      '4. If one provider\'s evidence is invalid, reject that report and recalculate using the valid source.\n' +
      '5. Governance council reviews and issues resumeProject with multisig to lift the circuit breaker.\n' +
      '6. Log incident with the anomaly kind, both values, and resolution in the oracle incident repository.',
    data: {
      projectId: oracleProjectId,
      periodStart,
      periodEnd,
      reports: [reportA, reportB],
      crossSourceSeverity: 'critical',
      medianCarbon,
      maxDeviationPct: Math.round(maxDeviation * 100),
    },
  };

  // ── 3. Expired escrow deadlock ───────────────────────────────────────────
  const escrowTtlMs = HOUR * 4;
  const disputeWindowMs = HOUR * 24;
  const escrowLockedAt = now - DAY * 3;
  const escrowExpiredAt = escrowLockedAt + escrowTtlMs;
  const disputeExpiredAt = escrowLockedAt + disputeWindowMs;

  const expiredEscrowDeadlock: FailureFixture<ExpiredEscrowDeadlockData> = {
    scenario: 'expired_escrow_deadlock',
    createdAt: now,
    recoveryPlan:
      '1. Confirm both escrow TTL and dispute window have elapsed by checking on-chain timestamps.\n' +
      '2. Call dex-router resolve_timeout(orderId) to trigger the automatic escrow reversal path.\n' +
      '3. If resolve_timeout fails (contract state corrupted), escalate to governance for manual settlement.\n' +
      '4. Verify seller receives bond tokens back and buyer receives USDC refund via balance queries.\n' +
      '5. Mark the order as "Expired" in the API order book and emit a DeadlockResolved event.\n' +
      '6. Run the escrow leakage invariant check: sum of all locked escrow must equal zero for expired orders.',
    data: {
      orderId: 1003,
      sellerId: 3, // Sophia Investor from seed dataset
      buyerId: 1005,
      bondId: 3, // Niger Agroforestry Bond from seed dataset
      tokenAmount: 200,
      lockedUsdcAmount: 198,
      escrowLockedAt,
      escrowTtlMs,
      escrowExpiredAt,
      disputeWindowMs,
      disputeExpiredAt,
      settlementState: 'DEADLOCKED',
      orphanedTokens: [
        { holder: wallet(200), amount: 200 },
        { holder: wallet(201), amount: 198 },
      ],
    },
  };

  // ── 4. Cascading migration failure ───────────────────────────────────────
  const migrationStartedAt = now - HOUR * 6;
  const migrationFailedAt = now - HOUR * 5;

  const cascadingMigrationFailure: FailureFixture<CascadingMigrationFailureData> = {
    scenario: 'cascading_migration_failure',
    createdAt: now,
    recoveryPlan:
      '1. DO NOT re-run the migration: the schema is already at v2 but data is partially backfilled.\n' +
      '2. Query the backfill progress to determine which records were migrated (completed: 8400 / total: 12000).\n' +
      '3. Resume the backfill from the last successful offset using: npm run migrate -- --resume add_holder_index_v2.\n' +
      '4. If resume fails, rollback the schema to v1: DROP INDEX CONCURRENTLY IF EXISTS idx_holder_balance_v2; then ALTER TABLE holders DROP COLUMN IF EXISTS balance_snapshot_v2.\n' +
      '5. After successful completion or rollback, run ALL post-checks to verify invariants.\n' +
      '6. Record the incident in migration history with the partial state for future reference.',
    data: {
      migrationId: 'add_holder_index_v2',
      description: 'Adds covering index and snapshot column for holder balance queries',
      startedAt: migrationStartedAt,
      failedAt: migrationFailedAt,
      phases: [
        { phase: 'schema_update', status: 'completed', affectedRows: 1 },
        { phase: 'data_backfill', status: 'failed', affectedRows: 8400, error: 'deadlock detected after 8400 of 12000 rows' },
      ],
      postCheckResults: [
        { name: 'schema_version_matches', passed: true },
        { name: 'all_rows_backfilled', passed: false, detail: 'Expected 12000 rows with balance_snapshot_v2; found 8400' },
        { name: 'index_selectivity', passed: false, detail: 'Index idx_holder_balance_v2 covers only 70% of expected rows' },
      ],
      rollbackNotes: 'DROP INDEX CONCURRENTLY IF EXISTS idx_holder_balance_v2; ALTER TABLE holders DROP COLUMN IF EXISTS balance_snapshot_v2;',
      schemaVersionBefore: 1,
      schemaVersionAfter: 2,
      dataBackfillProgress: { total: 12000, completed: 8400, failed: 3600 },
    },
  };

  // ── 5. Double-spend attempt ──────────────────────────────────────────────
  const doubleSpendBondId = 2; // Sundarbans Blue Carbon Bond from seed dataset
  const holderAddr = wallet(300);
  const nonce = 42;
  const submittedAt = now - HOUR;

  const doubleSpendAttempt: FailureFixture<DoubleSpendAttemptData> = {
    scenario: 'double_spend_attempt',
    createdAt: now,
    recoveryPlan:
      '1. The second request is automatically rejected by the nonce/idempotency guard — no manual intervention needed.\n' +
      '2. Verify the first request completed successfully by checking the on-chain redemption tx hash.\n' +
      '3. Confirm holder balance decreased by exactly the redeemed token amount (no over-deduction).\n' +
      '4. Log both requests in the abuse detection system with the shared idempotency key.\n' +
      '5. If the first request is still pending, hold both until it settles, then reject the duplicate.\n' +
      '6. Review whether the duplicate was user error (UI retry) or a deliberate abuse attempt for escalation.',
    data: {
      bondId: doubleSpendBondId,
      holderAddress: holderAddr,
      holderBalance: 500,
      requests: [
        {
          requestId: 'redeem-1006-a',
          bondId: doubleSpendBondId,
          holderAddress: holderAddr,
          tokenAmount: 500,
          nonce,
          submittedAt,
          status: 'accepted',
          txHash: 'aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344',
        },
        {
          requestId: 'redeem-1006-b',
          bondId: doubleSpendBondId,
          holderAddress: holderAddr,
          tokenAmount: 500,
          nonce,
          submittedAt: submittedAt + 200, // 200ms later
          status: 'rejected_duplicate',
          rejectionReason: `Duplicate redemption: nonce ${nonce} already consumed by request redeem-1006-a`,
        },
      ],
      idempotencyKey: `redeem:${doubleSpendBondId}:${holderAddr}:${nonce}`,
      nonce,
    },
  };

  // ── 6. IPFS unavailability ───────────────────────────────────────────────
  const ipfsProjectId = 1; // Amazon Reforestation from seed dataset

  const ipfsUnavailability: FailureFixture<IpfsUnavailabilityData> = {
    scenario: 'ipfs_unavailability',
    createdAt: now,
    recoveryPlan:
      '1. Mark the affected audit document as "evidence_unavailable" in the project registry.\n' +
      '2. Attempt re-pin via an alternative IPFS pinning service (Pinata, Web3.Storage).\n' +
      '3. If the content is permanently lost, retrieve the original evidence from the oracle provider\'s archive.\n' +
      '4. Re-upload and update the IPFS hash reference in the oracle report and project metadata.\n' +
      '5. Suspend coupon distribution for affected bonds until evidence is re-verified.\n' +
      '6. Notify bondholders of the temporary evidence gap and expected resolution timeline.',
    data: {
      documentId: 1007,
      projectId: ipfsProjectId,
      ipfsHash: 'QmUnavail7890abcdef1234567890abcdef1234567890abc',
      primaryGatewayUrl: 'https://ipfs.io/ipfs/QmUnavail7890abcdef1234567890abcdef1234567890abc',
      fallbackGatewayUrl: 'https://gateway.pinata.cloud/ipfs/QmUnavail7890abcdef1234567890abcdef1234567890abc',
      primaryError: 'HTTP 504 Gateway Timeout after 30000ms',
      fallbackError: 'HTTP 504 Gateway Timeout after 30000ms',
      lastAccessibleAt: now - DAY * 14,
      discoveredUnavailableAt: now - DAY * 2,
      affectedBondIds: [1, 7], // Amazon Reforestation Bond and Acacia Growth Bond
      evidenceVerifiable: false,
    },
  };

  return {
    partialCouponDistribution,
    oracleDisagreement,
    expiredEscrowDeadlock,
    cascadingMigrationFailure,
    doubleSpendAttempt,
    ipfsUnavailability,
  };
}

export { wallet as failureWallet };
