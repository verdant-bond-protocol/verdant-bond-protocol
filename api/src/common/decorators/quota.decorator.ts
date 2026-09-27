import { SetMetadata } from '@nestjs/common';
import { QuotaResource } from '../services/quota.service';

export const QUOTA_METADATA_KEY = 'quota_resource';
export const RequireQuota = (resource: QuotaResource) => SetMetadata(QUOTA_METADATA_KEY, resource);
