import {
  canonicalNormalize,
  computeCanonicalDigest,
  deterministicCandidateId,
  geoProximityScore,
  haversineDistanceKm,
  jaccardTrigramSimilarity,
  levenshteinDistance,
  levenshteinSimilarity,
  stableJsonStringify,
  stableSortCandidates,
} from './similarity-scoring';
import { CandidateDuplicate, CandidateStatus, EntityType } from './deduplication.types';

describe('Similarity Scoring & Deterministic Utilities', () => {
  describe('canonicalNormalize', () => {
    it('normalizes diacritics and unicode NFKD', () => {
      expect(canonicalNormalize('Café')).toBe('cafe');
      expect(canonicalNormalize('NAÏVE')).toBe('naive');
    });

    it('collapses whitespace and normalizes punctuation', () => {
      expect(canonicalNormalize('  Green   Bond   #123--A  ')).toBe('green bond 123 a');
    });

    it('handles empty, null, or undefined gracefully', () => {
      expect(canonicalNormalize('')).toBe('');
      expect(canonicalNormalize(null)).toBe('');
      expect(canonicalNormalize(undefined)).toBe('');
    });
  });

  describe('levenshteinDistance & levenshteinSimilarity', () => {
    it('returns 0 distance and 1.0 similarity for identical strings', () => {
      expect(levenshteinDistance('Verdant', 'Verdant')).toBe(0);
      expect(levenshteinSimilarity('Verdant', 'Verdant')).toBe(1.0);
    });

    it('is symmetric: sim(A, B) === sim(B, A)', () => {
      const a = 'Verdant Blue Carbon Project';
      const b = 'Verdant Blue Carbon Proj';
      expect(levenshteinSimilarity(a, b)).toBe(levenshteinSimilarity(b, a));
      expect(levenshteinDistance(a, b)).toBe(levenshteinDistance(b, a));
    });

    it('accurately computes distance for single insertion/deletion/substitution', () => {
      expect(levenshteinDistance('kitten', 'sitting')).toBe(3);
    });

    it('is bounded within [0, 1]', () => {
      const sim = levenshteinSimilarity('abcdef', 'ghijkl');
      expect(sim).toBeGreaterThanOrEqual(0.0);
      expect(sim).toBeLessThanOrEqual(1.0);
    });
  });

  describe('jaccardTrigramSimilarity', () => {
    it('returns 1.0 for identical strings', () => {
      expect(jaccardTrigramSimilarity('Mangrove Restoration', 'Mangrove Restoration')).toBe(1.0);
    });

    it('is symmetric: J(A, B) === J(B, A)', () => {
      const a = 'Delta Mangrove Forest Phase 1';
      const b = 'Delta Mangrove Forest Phase 2';
      expect(jaccardTrigramSimilarity(a, b)).toBe(jaccardTrigramSimilarity(b, a));
    });

    it('detects strong similarity despite word ordering changes', () => {
      const a = 'Amazon Agroforestry Carbon Project';
      const b = 'Carbon Project Amazon Agroforestry';
      expect(jaccardTrigramSimilarity(a, b)).toBeGreaterThan(0.7);
    });

    it('falls back to levenshtein for strings shorter than 3 characters', () => {
      expect(jaccardTrigramSimilarity('ab', 'ab')).toBe(1.0);
      expect(jaccardTrigramSimilarity('ab', 'ac')).toBe(0.5);
    });
  });

  describe('haversineDistanceKm & geoProximityScore', () => {
    it('returns 0 km for identical coordinates', () => {
      expect(haversineDistanceKm(-3.4653, -62.2159, -3.4653, -62.2159)).toBe(0);
      expect(geoProximityScore(0, 50)).toBe(1.0);
    });

    it('calculates expected distance and decays linearly within radius', () => {
      // Points ~11.1 km apart (0.1 degree latitude)
      const dist = haversineDistanceKm(0, 0, 0.1, 0);
      expect(dist).toBeGreaterThan(11.0);
      expect(dist).toBeLessThan(11.2);

      const score = geoProximityScore(dist, 100);
      expect(score).toBeGreaterThan(0.8);
      expect(score).toBeLessThan(0.9);
    });

    it('clamps to 0.0 beyond max radius', () => {
      expect(geoProximityScore(150, 100)).toBe(0.0);
    });
  });

  describe('deterministicCandidateId', () => {
    it('is strictly order-independent: id(A, B) === id(B, A)', () => {
      const id1 = deterministicCandidateId(EntityType.KYC_RECORD, 'addr_AAA', 'addr_BBB');
      const id2 = deterministicCandidateId(EntityType.KYC_RECORD, 'addr_BBB', 'addr_AAA');
      expect(id1).toBe(id2);
      expect(id1).toMatch(/^[a-f0-9]{64}$/);
    });

    it('produces distinct IDs for different entity types', () => {
      const idKyc = deterministicCandidateId(EntityType.KYC_RECORD, '100', '200');
      const idProject = deterministicCandidateId(EntityType.PROJECT, '100', '200');
      expect(idKyc).not.toBe(idProject);
    });
  });

  describe('stableJsonStringify & computeCanonicalDigest', () => {
    it('produces identical digest regardless of object key insertion order', () => {
      const obj1 = { name: 'Verdant', status: 'verified', rank: 5 };
      const obj2 = { rank: 5, name: 'Verdant', status: 'verified' };

      expect(stableJsonStringify(obj1)).toBe(stableJsonStringify(obj2));
      expect(computeCanonicalDigest(obj1)).toBe(computeCanonicalDigest(obj2));
    });
  });

  describe('stableSortCandidates', () => {
    it('deterministically sorts by confidence desc, primaryId asc, secondaryId asc', () => {
      const mockCandidate = (
        id: string,
        score: number,
        primaryId: string,
        secondaryId: string,
      ): CandidateDuplicate => ({
        id,
        entityType: EntityType.KYC_RECORD,
        primaryId,
        secondaryId,
        confidenceScore: score,
        evaluations: [],
        status: CandidateStatus.PENDING_REVIEW,
        detectedAt: new Date().toISOString(),
        primarySnapshot: {},
        secondarySnapshot: {},
        primaryDigest: 'dig1',
        secondaryDigest: 'dig2',
        diffs: [],
      });

      const input = [
        mockCandidate('c1', 0.85, 'addr_Z', 'addr_Y'),
        mockCandidate('c2', 0.95, 'addr_B', 'addr_A'),
        mockCandidate('c3', 0.85, 'addr_A', 'addr_B'),
        mockCandidate('c4', 0.85, 'addr_A', 'addr_C'),
      ];

      const sorted = stableSortCandidates(input);
      expect(sorted.map((c) => c.id)).toEqual(['c2', 'c3', 'c4', 'c1']);
    });
  });
});
