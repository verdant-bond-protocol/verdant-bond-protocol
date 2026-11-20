import { createHash } from 'crypto';
import { CandidateDuplicate } from './deduplication.types';

/**
 * Normalizes input text into a canonical form for deterministic comparison:
 * - Unicode NFKD normalization
 * - Lowercase
 * - Strips leading/trailing punctuation and non-alphanumeric except standard word delimiters
 * - Collapses consecutive whitespace
 */
export function canonicalNormalize(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .replace(/[\s_-]+/g, ' ')
    .trim();
}

/**
 * Computes Levenshtein edit distance between two strings.
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const m = a.length;
  const n = b.length;
  let prevRow = new Array<number>(n + 1);
  let currRow = new Array<number>(n + 1);

  for (let j = 0; j <= n; j++) {
    prevRow[j] = j;
  }

  for (let i = 1; i <= m; i++) {
    currRow[0] = i;
    const charA = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = charA === b.charCodeAt(j - 1) ? 0 : 1;
      currRow[j] = Math.min(
        currRow[j - 1] + 1,      // insertion
        prevRow[j] + 1,          // deletion
        prevRow[j - 1] + cost,   // substitution
      );
    }
    const temp = prevRow;
    prevRow = currRow;
    currRow = temp;
  }

  return prevRow[n];
}

/**
 * Computes Levenshtein similarity ratio: 1 - (distance / max(len(a), len(b))).
 * Result is rounded to 4 decimal places for exact deterministic comparisons.
 */
export function levenshteinSimilarity(a: string, b: string): number {
  const normA = canonicalNormalize(a);
  const normB = canonicalNormalize(b);
  if (normA === normB) return 1.0;
  const maxLen = Math.max(normA.length, normB.length);
  if (maxLen === 0) return 1.0;

  const dist = levenshteinDistance(normA, normB);
  const score = Math.max(0, 1 - dist / maxLen);
  return Number(score.toFixed(4));
}

/**
 * Computes Jaccard similarity over character trigrams.
 * Highly effective for fuzzy text matching with transposed words or abbreviations.
 * Result rounded to 4 decimal places.
 */
export function jaccardTrigramSimilarity(a: string, b: string): number {
  const normA = canonicalNormalize(a);
  const normB = canonicalNormalize(b);
  if (normA === normB) return 1.0;
  if (normA.length < 3 || normB.length < 3) {
    return levenshteinSimilarity(normA, normB);
  }

  const trigramsA = new Set<string>();
  for (let i = 0; i <= normA.length - 3; i++) {
    trigramsA.add(normA.substring(i, i + 3));
  }

  const trigramsB = new Set<string>();
  for (let j = 0; j <= normB.length - 3; j++) {
    trigramsB.add(normB.substring(j, j + 3));
  }

  let intersectionCount = 0;
  for (const tri of trigramsA) {
    if (trigramsB.has(tri)) {
      intersectionCount++;
    }
  }

  const unionSize = trigramsA.size + trigramsB.size - intersectionCount;
  if (unionSize === 0) return 1.0;
  return Number((intersectionCount / unionSize).toFixed(4));
}

/**
 * Computes great-circle distance between two GPS coordinates using Haversine formula (km).
 */
export function haversineDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371; // Earth radius in km

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Number((R * c).toFixed(4));
}

/**
 * Computes a proximity score [0.0 - 1.0] given distance and max radius in km.
 */
export function geoProximityScore(distKm: number, maxRadiusKm = 100): number {
  if (distKm <= 0) return 1.0;
  if (distKm >= maxRadiusKm) return 0.0;
  return Number((1 - distKm / maxRadiusKm).toFixed(4));
}

/**
 * Code-point comparison of two identifiers, independent of the process locale
 * and ICU version. `String.prototype.localeCompare` can order non-ASCII IDs
 * differently across hosts, which would change candidate IDs and scan order;
 * this comparator is byte-for-byte reproducible everywhere.
 */
export function compareIds(a: string, b: string): number {
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Computes an order-independent deterministic candidate ID.
 * Regardless of whether (idA, idB) or (idB, idA) is passed, returns the identical hash.
 */
export function deterministicCandidateId(entityType: string, idA: string, idB: string): string {
  const sorted = [String(idA), String(idB)].sort(compareIds);
  return createHash('sha256')
    .update(`${entityType}:${sorted[0]}:${sorted[1]}`)
    .digest('hex');
}

/**
 * Computes a canonical SHA-256 fingerprint of an arbitrary object using stable JSON serialization.
 */
export function computeCanonicalDigest(data: any): string {
  if (data === null || data === undefined) return 'null';
  const canonicalString = stableJsonStringify(data);
  return createHash('sha256').update(canonicalString).digest('hex');
}

/**
 * Recursively serializes an object with sorted keys for deterministic serialization.
 */
export function stableJsonStringify(obj: any): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(stableJsonStringify).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  const entries = keys.map((key) => JSON.stringify(key) + ':' + stableJsonStringify(obj[key]));
  return '{' + entries.join(',') + '}';
}

/**
 * Deterministically sorts candidate duplicate pairs with unambiguous tie-breaking:
 * 1. Confidence score descending
 * 2. Primary ID ascending
 * 3. Secondary ID ascending
 */
export function stableSortCandidates<T>(candidates: CandidateDuplicate<T>[]): CandidateDuplicate<T>[] {
  return [...candidates].sort((a, b) => {
    if (b.confidenceScore !== a.confidenceScore) {
      return b.confidenceScore - a.confidenceScore;
    }
    const cmpPrimary = compareIds(a.primaryId, b.primaryId);
    if (cmpPrimary !== 0) return cmpPrimary;
    return compareIds(a.secondaryId, b.secondaryId);
  });
}

/** Canonical inputs to the content-bearing scan fingerprint (see below). */
export interface ScanFingerprintV2Input {
  entityType: string;
  minConfidence: number;
  totalScanned: number;
  candidates: Array<{
    id: string;
    primaryId: string;
    secondaryId: string;
    confidenceScore: number;
    primaryDigest: string;
    secondaryDigest: string;
    status: string;
  }>;
}

/**
 * Additive, content-bearing fingerprint for a scan.
 *
 * The legacy `scanFingerprint` hashes candidate IDs only, so two scans whose
 * scores or review states drift but whose pairs do not change produce the same
 * value. This v2 also covers scores, state digests, review status and the
 * confidence threshold. It is emitted alongside (never in place of) the
 * legacy field so existing clients keep working.
 */
export function computeScanFingerprintV2(input: ScanFingerprintV2Input): string {
  return createHash('sha256')
    .update(stableJsonStringify(input))
    .digest('hex');
}
