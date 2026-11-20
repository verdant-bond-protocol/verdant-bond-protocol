import { BackfillJob } from '../backfill.interface';
import { KycRecordNormalizeJob } from './kyc-record-normalize.job';

/** Every job the CLI can run. Register new backfills here. */
export const BACKFILL_JOBS: Record<string, () => BackfillJob<any>> = {
  'kyc-record-normalize': () => new KycRecordNormalizeJob(),
};
