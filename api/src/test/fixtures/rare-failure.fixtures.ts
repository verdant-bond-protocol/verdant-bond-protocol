export type RareFailureKind = 'timeout' | 'partial_write' | 'retry_exhausted';

export interface RareFailureFixture {
  id: string;
  kind: RareFailureKind;
  attempt: number;
  seed: number;
}

/** Deterministic fixtures for failure paths that are otherwise hard to reproduce. */
export function rareFailureFixtures(seed = 17): RareFailureFixture[] {
  return (['timeout', 'partial_write', 'retry_exhausted'] as const).map((kind, index) => ({
    id: `rare-${seed}-${index + 1}`,
    kind,
    attempt: index + 1,
    seed,
  }));
}
