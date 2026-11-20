import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { DomainInvariantsService } from '../reconciliation/services/domain-invariants.service';

/**
 * Snapshot restore verification (#379).
 *
 * A snapshot carries the critical read-model data (bonds, projects, orders,
 * KYC records, holder balances, settlement references) plus a manifest of
 * per-section record counts and SHA-256 digests taken at capture time.
 * Verifying a restore proves three things, and fails loudly with a repair
 * step for every mismatch:
 *
 *  1. integrity  — every section is present, complete and byte-identical to
 *                  what was captured;
 *  2. invariants — the restored records satisfy the domain invariants
 *                  (DomainInvariantsService, docs/disaster-recovery-validation.md);
 *  3. derived    — the durable holder index (`HOLDER_INDEX_PATH`, the
 *                  FileHolderStore file) matches the index rebuilt from the
 *                  restored holder balances.
 *
 * Verification is read-only. The rebuilt index is returned so a repair can
 * write it in place of the restored one.
 */

export const SNAPSHOT_FORMAT_VERSION = 1;

export interface HolderBalance {
  address: string;
  /** Integer string in bond token units. */
  balance: string;
}

export interface CriticalDataSections {
  bonds: any[];
  projects: any[];
  orders: any[];
  kycRecords: any[];
  /** Keyed by bond id. */
  holdersByBond: Record<string, HolderBalance[]>;
  settlementTransactions: Array<{ txHash: string; entityType: string; entityId: string }>;
}

export type SectionName = keyof CriticalDataSections;

const SECTION_NAMES: SectionName[] = [
  'bonds',
  'projects',
  'orders',
  'kycRecords',
  'holdersByBond',
  'settlementTransactions',
];

export interface SectionDigest {
  count: number;
  sha256: string;
}

export interface CriticalDataSnapshot {
  version: number;
  capturedAt: string;
  sections: CriticalDataSections;
  manifest: Record<SectionName, SectionDigest>;
}

/** The durable holder index as FileHolderStore persists it (api/src/bonds/holder-store.ts). */
export interface HolderIndexData {
  holders: Record<string, string[]>;
  knownAddresses: string[];
  lastReconciled: Record<string, number>;
}

export type RestoreCheck = 'SNAPSHOT_INTEGRITY' | 'DOMAIN_INVARIANT' | 'DERIVED_INDEX';
export type RestoreSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface RestoreMismatch {
  check: RestoreCheck;
  severity: RestoreSeverity;
  entity: string;
  description: string;
  repair: string;
}

export interface RestoreVerificationReport {
  status: 'VERIFIED' | 'FAILED';
  snapshotCapturedAt: string;
  verifiedAt: string;
  /** Mismatches that block putting the restore into service (every non-LOW finding). */
  mismatches: RestoreMismatch[];
  /**
   * LOW findings: time-dependent drifts (e.g. an order that expired after capture). They
   * are expected for a point-in-time snapshot, are cleared by the normal
   * expiry jobs, and do not fail the restore.
   */
  warnings: RestoreMismatch[];
  /** The holder index rebuilt from the restored balances. */
  rebuiltHolderIndex: HolderIndexData;
}

export class RestoreVerificationError extends Error {
  constructor(readonly report: RestoreVerificationReport) {
    super(
      `Snapshot restore verification failed with ${report.mismatches.length} mismatch(es): ` +
        report.mismatches.map((m) => `[${m.check}] ${m.entity}: ${m.description}`).join('; '),
    );
    this.name = 'RestoreVerificationError';
  }
}

const REINDEX_BOND = (bondId: string) => `npm run reindex-holders -- --bond=${bondId}`;
const RESTORE_AGAIN = 'Discard this restore and restore the snapshot again from the backup copy';

function digestOf(section: unknown): SectionDigest {
  const count = Array.isArray(section)
    ? section.length
    : section && typeof section === 'object'
      ? Object.keys(section).length
      : 0;
  return { count, sha256: createHash('sha256').update(JSON.stringify(section) ?? '').digest('hex') };
}

/** The balance, or null when the stored value is not an integer string. */
function parseBalance(raw: string): bigint | null {
  return /^-?\d+$/.test(String(raw)) ? BigInt(raw) : null;
}

@Injectable()
export class SnapshotRestoreVerificationService {
  private readonly logger = new Logger(SnapshotRestoreVerificationService.name);

  constructor(private readonly invariants: DomainInvariantsService) {}

  /** Seal critical data into a snapshot with its integrity manifest. O(n) in snapshot size. */
  capture(sections: CriticalDataSections, capturedAt: Date = new Date()): CriticalDataSnapshot {
    const manifest = Object.fromEntries(
      SECTION_NAMES.map((name) => [name, digestOf(sections[name])]),
    ) as Record<SectionName, SectionDigest>;
    return { version: SNAPSHOT_FORMAT_VERSION, capturedAt: capturedAt.toISOString(), sections, manifest };
  }

  /**
   * Rebuild the durable holder index from restored balances: a bond's holders
   * are the addresses with a positive balance, sorted so the result is
   * deterministic. Known addresses from the restored index are kept (they are
   * discovery candidates for out-of-band transfers). Every bond is marked
   * never-reconciled, so HolderIndexService reconciles it against the chain
   * before the next coupon distribution. O(h log h) for h holder entries.
   */
  rebuildHolderIndex(sections: CriticalDataSections, restored?: HolderIndexData): HolderIndexData {
    const holders: Record<string, string[]> = {};
    const known = new Set(restored?.knownAddresses ?? []);
    const lastReconciled: Record<string, number> = {};

    for (const [bondId, balances] of Object.entries(sections.holdersByBond ?? {})) {
      const positive = new Set<string>();
      for (const { address, balance } of balances) {
        known.add(address);
        const parsed = parseBalance(balance);
        if (parsed !== null && parsed > 0n) positive.add(address);
      }
      holders[bondId] = [...positive].sort();
      lastReconciled[bondId] = 0;
    }

    return { holders, knownAddresses: [...known].sort(), lastReconciled };
  }

  async verify(snapshot: CriticalDataSnapshot, restoredIndex: HolderIndexData): Promise<RestoreVerificationReport> {
    const findings = [
      ...this.checkIntegrity(snapshot),
      ...(await this.checkInvariants(snapshot.sections ?? ({} as CriticalDataSections))),
    ];
    const rebuiltHolderIndex = this.rebuildHolderIndex(snapshot.sections ?? ({} as CriticalDataSections), restoredIndex);
    findings.push(...this.checkDerivedIndex(snapshot.sections?.holdersByBond ?? {}, restoredIndex, rebuiltHolderIndex));

    const mismatches = findings.filter((f) => f.severity !== 'LOW');
    const warnings = findings.filter((f) => f.severity === 'LOW');
    const report: RestoreVerificationReport = {
      status: mismatches.length === 0 ? 'VERIFIED' : 'FAILED',
      snapshotCapturedAt: snapshot.capturedAt,
      verifiedAt: new Date().toISOString(),
      mismatches,
      warnings,
      rebuiltHolderIndex,
    };

    if (report.status === 'FAILED') {
      this.logger.error(`Snapshot restore verification FAILED: ${mismatches.length} mismatch(es)`);
    } else {
      this.logger.log(`Snapshot restore verified (${warnings.length} time-dependent warning(s))`);
    }
    return report;
  }

  /** As `verify`, but throws RestoreVerificationError instead of returning a failed report. */
  async verifyOrThrow(snapshot: CriticalDataSnapshot, restoredIndex: HolderIndexData): Promise<RestoreVerificationReport> {
    const report = await this.verify(snapshot, restoredIndex);
    if (report.status === 'FAILED') throw new RestoreVerificationError(report);
    return report;
  }

  private checkIntegrity(snapshot: CriticalDataSnapshot): RestoreMismatch[] {
    const mismatch = (entity: string, description: string): RestoreMismatch => ({
      check: 'SNAPSHOT_INTEGRITY',
      severity: 'CRITICAL',
      entity,
      description,
      repair: RESTORE_AGAIN,
    });

    if (snapshot.version !== SNAPSHOT_FORMAT_VERSION) {
      return [mismatch('snapshot', `Unsupported snapshot format version ${snapshot.version} (expected ${SNAPSHOT_FORMAT_VERSION})`)];
    }

    const out: RestoreMismatch[] = [];
    for (const name of SECTION_NAMES) {
      const expected = snapshot.manifest?.[name];
      const section = snapshot.sections?.[name];
      if (!expected) {
        out.push(mismatch(name, 'Section is missing from the manifest; its contents cannot be trusted'));
      } else if (section === undefined) {
        out.push(mismatch(name, `Section is missing from the restore (manifest expects ${expected.count} record(s))`));
      } else {
        const actual = digestOf(section);
        if (actual.count !== expected.count) {
          out.push(mismatch(name, `Restored ${actual.count} record(s), manifest expects ${expected.count}`));
        } else if (actual.sha256 !== expected.sha256) {
          out.push(mismatch(name, 'Contents differ from the captured snapshot (SHA-256 mismatch)'));
        }
      }
    }
    return out;
  }

  private async checkInvariants(sections: CriticalDataSections): Promise<RestoreMismatch[]> {
    const report = await this.invariants.validateDomainInvariants({
      bonds: sections.bonds ?? [],
      projects: sections.projects ?? [],
      orders: sections.orders ?? [],
      kycRecords: sections.kycRecords ?? [],
      holdersByBond: sections.holdersByBond ?? {},
      settlementTransactions: sections.settlementTransactions ?? [],
    });
    return report.driftsFound.map((drift) => ({
      check: 'DOMAIN_INVARIANT' as const,
      // Stale drifts depend on wall-clock time since capture, not on the restore.
      severity: drift.type === 'stale' ? 'LOW' : (drift.severity ?? 'HIGH'),
      entity: `${drift.entityType}:${drift.entityId}`,
      description: drift.description,
      repair: drift.repairSuggestion ?? 'See docs/disaster-recovery-validation.md section 6',
    }));
  }

  /** O(h) set comparison of restored vs rebuilt membership, h = holder entries. */
  private checkDerivedIndex(
    holdersByBond: Record<string, HolderBalance[]>,
    restored: HolderIndexData,
    rebuilt: HolderIndexData,
  ): RestoreMismatch[] {
    const out: RestoreMismatch[] = [];
    const derived = (severity: RestoreSeverity, entity: string, description: string, repair: string): void => {
      out.push({ check: 'DERIVED_INDEX', severity, entity, description, repair });
    };

    for (const [bondId, balances] of Object.entries(holdersByBond)) {
      for (const { address, balance } of balances) {
        if (parseBalance(balance) === null) {
          derived('CRITICAL', `holder:${bondId}:${address}`, `Balance "${balance}" is not an integer`, RESTORE_AGAIN);
        }
      }
    }

    const restoredKnown = new Set(restored.knownAddresses ?? []);
    for (const [bondId, expectedHolders] of Object.entries(rebuilt.holders)) {
      const actual = new Set(restored.holders?.[bondId] ?? []);
      const expected = new Set(expectedHolders);
      const repair = `Rewrite the holder index from the snapshot (--repair), then ${REINDEX_BOND(bondId)}`;

      for (const address of expected) {
        if (!actual.has(address)) {
          derived('HIGH', `holder-index:${bondId}:${address}`, `Holder with a positive balance is missing from the index; coupon distribution would skip it`, repair);
        }
        if (!restoredKnown.has(address)) {
          derived('MEDIUM', `known-address:${address}`, `Holder of bond ${bondId} is missing from the known-address list used to rediscover out-of-band transfers`, repair);
          restoredKnown.add(address); // report each address once
        }
      }
      for (const address of actual) {
        if (!expected.has(address)) {
          derived('HIGH', `holder-index:${bondId}:${address}`, `Index lists an address with no positive balance in the restored data`, repair);
        }
      }
    }

    for (const bondId of Object.keys(restored.holders ?? {})) {
      if (!(bondId in rebuilt.holders) && (restored.holders[bondId]?.length ?? 0) > 0) {
        derived('HIGH', `holder-index:${bondId}`, `Index has holders for bond ${bondId}, which has no balances in the restored data`, `Restore that bond's balances or rewrite the holder index (--repair), then ${REINDEX_BOND(bondId)}`);
      }
    }
    return out;
  }
}
