import { SetMetadata } from '@nestjs/common';

export interface RateLimitOptions {
  type: 'auth' | 'mutation' | 'oracle' | 'default';
  ttl?: number; // Time to live in seconds
  limit?: number; // Maximum number of requests
}

export const RATE_LIMIT_METADATA_KEY = 'rate_limit_options';

export const RateLimit = (options: RateLimitOptions) => SetMetadata(RATE_LIMIT_METADATA_KEY, options);
