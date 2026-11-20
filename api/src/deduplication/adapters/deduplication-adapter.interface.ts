import {
  EntityType,
  FieldDiff,
  FieldResolutionStrategy,
  RuleEvaluation,
} from '../deduplication.types';

export interface DeduplicationAdapter<T = Record<string, any>> {
  readonly entityType: EntityType;

  /** Fetch all active entities eligible for duplicate scanning */
  fetchEntities(): Promise<T[]>;

  /** Fetch a single entity by ID */
  getEntity(id: string): Promise<T | null>;

  /** Extract natural ID */
  idOf(entity: T): string;

  /** Compare two entities and compute deterministic similarity score and rule breakdowns */
  evaluateCandidate(a: T, b: T): { confidence: number; evaluations: RuleEvaluation[] };

  /** Compute field diffs between primary and secondary */
  computeDiffs(primary: T, secondary: T): FieldDiff[];

  /** Compute the projected merged state for primary and secondary */
  computeMergedState(
    primary: T,
    secondary: T,
    strategies?: Record<string, { strategy: FieldResolutionStrategy; manualValue?: any }>,
  ): { mergedPrimary: T; mergedSecondary: T };

  /** Atomically apply the merge changes to underlying persistence */
  applyMerge(
    primary: T,
    secondary: T,
    mergedPrimary: T,
    mergedSecondary: T,
    context: { actor: string; reason: string },
  ): Promise<void>;

  /** Atomically revert the merge changes and restore pre-merge state */
  applyReversal(
    primaryId: string,
    secondaryId: string,
    preMergePrimary: T,
    preMergeSecondary: T,
    context: { actor: string; reason: string },
  ): Promise<void>;

  /** Compute canonical state digest for drift detection */
  computeStateDigest(entity: T): string;
}
