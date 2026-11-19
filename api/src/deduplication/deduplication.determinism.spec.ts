import { BadRequestException, ConflictException } from '@nestjs/common';
import { DeduplicationService } from './deduplication.service';
import { DeduplicationAdapter } from './adapters/deduplication-adapter.interface';
import {
  CandidateStatus,
  EntityType,
  FieldResolutionStrategy,
} from './deduplication.types';
import {
  compareIds,
  computeCanonicalDigest,
  computeScanFingerprintV2,
  deterministicCandidateId,
} from './similarity-scoring';

/**
 * Focused vertical slice: deterministic duplicate detection and merge review.
 *
 * Pins the reproducibility guarantees (candidate IDs, ordering, content-bearing
 * fingerprint) and the four required paths: normal, failure, retry and the
 * authorization boundary expressed by the review/merge state machine.
 */
describe('Deterministic duplicate detection and merge review', () => {
  interface TestEntity {
    id: string;
    name: string;
    /** Not part of similarity scoring, but part of the canonical state digest. */
    note?: string;
  }

  const FIXED_NOW = new Date('2026-01-01T00:00:00.000Z');

  function buildService(entities: TestEntity[]) {
    const store = new Map<string, TestEntity>(entities.map((e) => [e.id, { ...e }]));
    const adapter: DeduplicationAdapter<TestEntity> = {
      entityType: EntityType.PROJECT,
      fetchEntities: async () => Array.from(store.values()),
      getEntity: async (id) => store.get(id) ?? null,
      idOf: (e) => e.id,
      evaluateCandidate: (a, b) => ({
        confidence: a.name === b.name ? 0.9 : 0.2,
        evaluations: [],
      }),
      computeDiffs: () => [],
      computeMergedState: (primary) => ({
        mergedPrimary: { ...primary },
        mergedSecondary: { ...primary },
      }),
      applyMerge: async () => undefined,
      applyReversal: async () => undefined,
      computeStateDigest: (e) => computeCanonicalDigest(e),
    };

    // The constructor registers the two built-in adapters; a bare object is
    // enough for them here because the fake adapter below overwrites the
    // registration for the entity type under test.
    const service = new DeduplicationService({} as any, {} as any);
    service.registerAdapter(adapter);
    service.now = () => new Date(FIXED_NOW);
    return { service, adapter, store };
  }

  const scan = (service: DeduplicationService) =>
    service.scan({ entityType: EntityType.PROJECT });

  describe('determinism', () => {
    it('uses a locale-independent code-point comparator for IDs', () => {
      // 'ä' (U+00E4) sorts after 'z' (U+007A) by code point, whereas
      // localeCompare may place it next to 'a' depending on ICU data.
      expect(compareIds('ä', 'z')).toBeGreaterThan(0);
      expect(compareIds('z', 'ä')).toBeLessThan(0);
      expect(compareIds('id-1', 'id-1')).toBe(0);
    });

    it('returns identical IDs and order regardless of input iteration order', async () => {
      const entities: TestEntity[] = [
        { id: 'a', name: 'same' },
        { id: 'b', name: 'same' },
        { id: 'c', name: 'other' },
        { id: 'd', name: 'same' },
      ];
      const first = await buildService(entities).service.scan({ entityType: EntityType.PROJECT });
      const reversed = await buildService([...entities].reverse()).service.scan({
        entityType: EntityType.PROJECT,
      });

      expect(first.candidates.map((c) => c.id)).toEqual(reversed.candidates.map((c) => c.id));
      expect(first.candidates.map((c) => [c.primaryId, c.secondaryId])).toEqual(
        reversed.candidates.map((c) => [c.primaryId, c.secondaryId]),
      );
      expect(first.scanFingerprint).toBe(reversed.scanFingerprint);
      expect(first.scanFingerprintV2).toBe(reversed.scanFingerprintV2);
      expect(first.scannedAt).toBe(FIXED_NOW.toISOString());
    });

    it('changes fingerprintV2 — but not the legacy fingerprint — when scores drift', async () => {
      const stable = await buildService([
        { id: 'a', name: 'same', note: 'v1' },
        { id: 'b', name: 'same', note: 'v1' },
      ]).service.scan({ entityType: EntityType.PROJECT });
      const drifted = await buildService([
        { id: 'a', name: 'same', note: 'v1' },
        { id: 'b', name: 'same', note: 'v2' },
      ]).service.scan({ entityType: EntityType.PROJECT });

      // Same pairs and count => legacy fingerprint unchanged (backwards compatible).
      expect(drifted.scanFingerprint).toBe(stable.scanFingerprint);
      // Content-bearing fingerprint observes the changed canonical digest.
      expect(drifted.scanFingerprintV2).not.toBe(stable.scanFingerprintV2);
      expect(drifted.candidatesFound).toBe(1);
    });

    it('is stable for equivalent object key orderings and symmetric IDs', () => {
      const a = { z: 1, a: { y: 2, b: 3 } };
      const b = { a: { b: 3, y: 2 }, z: 1 };
      expect(computeScanFingerprintV2({
        entityType: 'project',
        minConfidence: 0.65,
        totalScanned: 2,
        candidates: [a as any],
      })).toBe(computeScanFingerprintV2({
        entityType: 'project',
        minConfidence: 0.65,
        totalScanned: 2,
        candidates: [b as any],
      }));

      expect(deterministicCandidateId('project', 'b', 'a')).toBe(
        deterministicCandidateId('project', 'a', 'b'),
      );
    });
  });

  describe('normal path', () => {
    it('detects, approves, merges and journals a duplicate pair', async () => {
      const { service } = buildService([
        { id: 'a', name: 'same' },
        { id: 'b', name: 'same' },
      ]);
      const result = await scan(service);
      expect(result.candidatesFound).toBe(1);
      const candidate = result.candidates[0];

      expect(candidate.status).toBe(CandidateStatus.PENDING_REVIEW);
      const reviewed = await service.reviewCandidate(candidate.id, {
        reviewer: 'reviewer-1',
        decision: 'approved',
        reason: 'verified duplicate',
        fieldStrategies: { name: { strategy: FieldResolutionStrategy.PRIMARY_WINS } },
      });
      expect(reviewed.status).toBe(CandidateStatus.APPROVED);

      const journal = await service.executeMerge(candidate.id, 'merger-1', 'cleanup');
      expect(journal.status).toBe('merged');
      expect(journal.executedBy).toBe('merger-1');
      expect((await service.getCandidate(candidate.id)).status).toBe(CandidateStatus.MERGED);
    });
  });

  describe('failure path', () => {
    it('rejects merging before approval', async () => {
      const { service } = buildService([
        { id: 'a', name: 'same' },
        { id: 'b', name: 'same' },
      ]);
      const candidate = (await scan(service)).candidates[0];
      await expect(service.executeMerge(candidate.id, 'merger-1')).rejects.toThrow(BadRequestException);
    });

    it('rejects a scan for an unregistered entity type', async () => {
      const { service } = buildService([]);
      await expect(service.scan({ entityType: 'unknown' as EntityType })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('blocks a merge when live state drifted since review', async () => {
      const { service, store } = buildService([
        { id: 'a', name: 'same' },
        { id: 'b', name: 'same' },
      ]);
      const candidate = (await scan(service)).candidates[0];
      await service.reviewCandidate(candidate.id, {
        reviewer: 'reviewer-1',
        decision: 'approved',
        reason: 'ok',
      });
      store.set('b', { id: 'b', name: 'mutated-after-review' });

      await expect(service.executeMerge(candidate.id, 'merger-1')).rejects.toThrow(
        /STATE_DRIFT/,
      );
    });
  });

  describe('retry / recovery path', () => {
    it('can re-scan, re-review and merge after state drift is acknowledged', async () => {
      const { service, store } = buildService([
        { id: 'a', name: 'same' },
        { id: 'b', name: 'same' },
      ]);
      const first = (await scan(service)).candidates[0];
      await service.reviewCandidate(first.id, {
        reviewer: 'reviewer-1',
        decision: 'approved',
        reason: 'ok',
      });
      // Drift in a field that does not change the similarity score, so the
      // pair is still a candidate after re-scan but its digest is stale.
      store.set('b', { id: 'b', name: 'same', note: 'mutated-after-review' });

      await expect(service.executeMerge(first.id, 'merger-1')).rejects.toThrow(ConflictException);

      // Recovery: re-scan refreshes digests, review again, then merge succeeds.
      const second = (await scan(service)).candidates[0];
      expect(second.id).toBe(first.id);
      expect(second.status).toBe(CandidateStatus.PENDING_REVIEW);
      await service.reviewCandidate(second.id, {
        reviewer: 'reviewer-2',
        decision: 'approved',
        reason: 're-reviewed after drift',
      });
      const journal = await service.executeMerge(second.id, 'merger-1', 'retry');
      expect(journal.status).toBe('merged');
    });

    it('can reverse a merge and re-approve the candidate for a new merge', async () => {
      const { service } = buildService([
        { id: 'a', name: 'same' },
        { id: 'b', name: 'same' },
      ]);
      const candidate = (await scan(service)).candidates[0];
      await service.reviewCandidate(candidate.id, {
        reviewer: 'reviewer-1',
        decision: 'approved',
        reason: 'ok',
      });
      const journal = await service.executeMerge(candidate.id, 'merger-1', 'initial');

      const reversal = await service.reverseMerge(journal.id, 'reviewer-2', 'bad merge');
      expect(reversal.status).toBe('reversed');
      expect((await service.getCandidate(candidate.id)).status).toBe(CandidateStatus.REVERSED);

      await service.reviewCandidate(candidate.id, {
        reviewer: 'reviewer-3',
        decision: 'approved',
        reason: 're-approved after reversal',
      });
      const retry = await service.executeMerge(candidate.id, 'merger-2', 'retry');
      expect(retry.status).toBe('merged');
    });
  });

  describe('authorization boundary (review state machine)', () => {
    it('does not allow reviewing a candidate that is already merged', async () => {
      const { service } = buildService([
        { id: 'a', name: 'same' },
        { id: 'b', name: 'same' },
      ]);
      const candidate = (await scan(service)).candidates[0];
      await service.reviewCandidate(candidate.id, {
        reviewer: 'reviewer-1',
        decision: 'approved',
        reason: 'ok',
      });
      await service.executeMerge(candidate.id, 'merger-1');

      await expect(
        service.reviewCandidate(candidate.id, {
          reviewer: 'reviewer-2',
          decision: 'rejected',
          reason: 'too late',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('does not grant merge authority to a rejection or dismissal', async () => {
      for (const decision of ['rejected', 'dismissed'] as const) {
        const { service } = buildService([
          { id: 'a', name: 'same' },
          { id: 'b', name: 'same' },
        ]);
        const candidate = (await scan(service)).candidates[0];
        await service.reviewCandidate(candidate.id, {
          reviewer: 'reviewer-1',
          decision,
          reason: 'not a duplicate',
        });
        await expect(service.executeMerge(candidate.id, 'merger-1')).rejects.toThrow(
          BadRequestException,
        );
      }
    });
  });
});
